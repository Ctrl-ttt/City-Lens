import asyncio
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.vision import READ_INSTRUCTION, SYSTEM_PROMPT, WALK_INSTRUCTION, Settings


def jpeg():
    output = io.BytesIO()
    Image.new('RGB', (32, 24), 'white').save(output, format='JPEG')
    return output.getvalue()


def analyze(client, mode='walk', **overrides):
    fields = dict(mode=mode, source='camera', session_id='test-session', frame_id='1')
    fields.update(overrides)
    return client.post('/api/analyze', data=fields, files={'image': ('frame.jpg', jpeg(), 'image/jpeg')})


def test_sample_contract_and_health():
    with TestClient(create_app(Settings(provider='sample'))) as client:
        health = client.get('/api/health').json()
        assert health['provider'] == 'sample'
        assert health['model'] == 'fixed-sample'
        assert health['camera_hfov_deg'] == 75.0
        response = analyze(client)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        result = response.json()
        assert (result['session_id'], result['frame_id']) == ('test-session', 1)
        assert result['speech'] is None
        assert result['events'] == []
        assert analyze(client, 'read').json()['speech'] is not None


@pytest.mark.parametrize('scene,mode,status,event_count,speech', [
    ('empty', 'walk', 'ok', 0, None),
    ('unclear', 'walk', 'uncertain', 0, None),
    ('empty', 'read', 'ok', 1, '标牌文字：样例牌：城市图书馆'),
    ('unclear', 'read', 'uncertain', 0, '文字看不清，请调整拍摄角度'),
])
def test_empty_and_unclear(scene, mode, status, event_count, speech):
    with TestClient(create_app(Settings(provider='sample', sample_scene=scene))) as client:
        result = analyze(client, mode).json()
        assert result['status'] == status
        assert len(result['events']) == event_count
        assert (result['speech']['text'] if result['speech'] else None) == speech


@pytest.mark.parametrize('status,body,code', [
    (401, {}, 'model_auth'), (403, {}, 'model_auth'),
    (429, {}, 'rate_limited'), (503, {}, 'model_unavailable'),
    (200, {}, 'invalid_model_output'),
    (200, {'choices': [{'message': {'content': '```'}}]}, 'invalid_model_output'),
    (200, {'choices': [{'message': {'content': '{"events": [{"label": "invented"}]}'}}]}, 'invalid_model_output'),
])
def test_provider_errors_are_controlled(status, body, code):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    with TestClient(create_app(Settings(api_key='test-secret'), transport)) as client:
        response = analyze(client)
        result = response.json()
        assert result['status'] == 'error'
        assert result['error_code'] == code
        assert result['speech'] is None
        assert 'test-secret' not in response.text + client.get('/api/health').text


def test_live_adapter_sends_image_and_uses_validated_rules():
    def handler(request):
        assert request.url.path.endswith('/chat/completions')
        payload = json.loads(request.content)
        assert payload['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,')
        content = {'events': [{'category': 'obstacle', 'label': 'obstacle', 'direction': 'front', 'text': '现在可以过马路'}]}
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(content)}}]})
    with TestClient(create_app(Settings(api_key='test-only'), httpx.MockTransport(handler))) as client:
        assert analyze(client).json()['speech']['text'] == '前方发现障碍物'


@pytest.mark.parametrize('mode', ['walk', 'read'])
@pytest.mark.parametrize('clarity', ['high', 'medium', 'low'])
def test_http_sign_contract_prompt_and_filtering(mode, clarity, caplog):
    text = '测试路 12号'

    def handler(request):
        payload = json.loads(request.content)
        assert payload['messages'][0]['content'] == SYSTEM_PROMPT
        assert payload['messages'][1]['content'][0]['text'] == (
            WALK_INSTRUCTION if mode == 'walk' else READ_INSTRUCTION)
        content = {'events': [{'category': 'text', 'label': 'sign', 'direction': 'right',
                              'text': text, 'clarity': clarity}]}
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(content)}}]})

    with TestClient(create_app(Settings(api_key='test-only'), httpx.MockTransport(handler))) as client:
        response = analyze(client, mode)
        assert response.status_code == 200
        result = response.json()
        if mode == 'walk':
            assert result['status'] == 'ok'
            assert result['events'] == []
            assert result['speech'] is None
        elif clarity == 'low':
            assert result['events'] == []
            assert (result['speech']['key'] if result['speech'] else None) == 'unclear'
        else:
            assert result['status'] == 'ok'
            assert result['events'][0]['clarity'] == clarity
            assert result['speech'] == {'key': f'sign:{text}', 'priority': 'normal', 'text': f'标牌文字：{text}'}
        assert text not in caplog.text


@pytest.mark.parametrize('mode', ['walk', 'read'])
def test_http_mixed_scene_keeps_obstacle_priority_and_read_is_text_only(mode):
    content = {'events': [
        {'category': 'facility', 'label': 'entrance', 'direction': 'front', 'text': ''},
        {'category': 'text', 'label': 'sign', 'direction': 'left', 'text': '较小标牌', 'clarity': 'medium'},
        {'category': 'text', 'label': 'sign', 'direction': 'right', 'text': '清晰标牌', 'clarity': 'high'},
        {'category': 'obstacle', 'label': 'stairs', 'direction': 'front', 'text': ''},
    ]}
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, json={'choices': [{'message': {'content': json.dumps(content)}}]}))
    with TestClient(create_app(Settings(api_key='test-only'), transport)) as client:
        result = analyze(client, mode).json()
    if mode == 'walk':
        assert [e['text'] for e in result['events']] == ['楼梯', '出入口']
        assert result['speech'] == {'key': 'stairs:front', 'priority': 'high', 'text': '前方发现楼梯'}
    else:
        assert [e['text'] for e in result['events']] == ['清晰标牌']
        assert result['speech']['text'] == '标牌文字：清晰标牌'


def test_read_mode_can_use_a_dedicated_stronger_model():
    seen = []
    def handler(request):
        seen.append(json.loads(request.content)['model'])
        return httpx.Response(200, json={'choices': [{'message': {'content': '{"events":[]}'}}]})
    config = Settings(api_key='test-only', model='fast-model', read_model='strong-model')
    with TestClient(create_app(config, httpx.MockTransport(handler))) as client:
        assert analyze(client, 'walk').status_code == 200
        assert analyze(client, 'read').status_code == 200
    assert seen == ['fast-model', 'strong-model']


def test_walk_sample_sign_is_never_read_without_read_mode():
    with TestClient(create_app(Settings(provider='sample', sample_scene='sign'))) as client:
        assert client.get('/api/health').json()['provider'] == 'sample'
        walk = analyze(client).json()
        assert walk['events'] == []
        assert walk['speech'] is None
        read = analyze(client, 'read').json()
        assert read['events'][0]['clarity'] == 'high'
        assert read['speech']['text'].startswith('标牌文字：样例牌')


def test_missing_configuration_never_falls_back_to_samples():
    with TestClient(create_app(Settings())) as client:
        assert client.get('/api/health').json()['configured'] is False
        assert analyze(client).json()['error_code'] == 'not_configured'


@pytest.mark.parametrize('kind', ['timeout', 'network'])
def test_timeout_and_network(kind):
    async def handler(request):
        if kind == 'network':
            raise httpx.ConnectError('private upstream details', request=request)
        await asyncio.sleep(.1)
        return httpx.Response(200, json={})
    with TestClient(create_app(Settings(api_key='test', timeout=.01), httpx.MockTransport(handler))) as client:
        result = analyze(client).json()
        assert result['error_code'] == ('network_error' if kind == 'network' else 'model_timeout')
        assert 'private' not in result['message']


@pytest.mark.parametrize('overrides', [{'mode': 'navigate'}, {'source': 'other'}, {'frame_id': '-1'}, {'session_id': '../bad'}])
def test_invalid_metadata(overrides):
    with TestClient(create_app(Settings(provider='sample'))) as client:
        assert analyze(client, **overrides).status_code == 422


@pytest.mark.parametrize('data,mime,status', [(b'not a jpeg', 'image/jpeg', 422), (b'x', 'image/png', 422), (b'x' * (2 * 1024 * 1024 + 1), 'image/jpeg', 413)], ids=['invalid-jpeg', 'wrong-mime', 'oversize'])
def test_invalid_upload(data, mime, status):
    with TestClient(create_app(Settings(provider='sample'))) as client:
        response = client.post('/api/analyze', data=dict(mode='walk', source='video', session_id='s', frame_id='0'), files={'image': ('x.jpg', data, mime)})
        assert response.status_code == status
        assert response.json()['speech'] is None


def test_foreign_origin_rejected():
    with TestClient(create_app(Settings(provider='sample'))) as client:
        response = client.post('/api/analyze', headers={'origin': 'https://example.com'})
        assert response.status_code == 403
        assert response.json()['error_code'] == 'forbidden_origin'


def test_busy_request_is_not_queued():
    with TestClient(create_app(Settings(provider='sample'))) as client:
        client.portal.call(client.app.state.lock.acquire)
        try:
            response = analyze(client)
            assert response.status_code == 429
            assert response.json()['error_code'] == 'busy'
        finally:
            client.portal.call(client.app.state.lock.release)


def test_repeat_speech_suppressed_within_window_but_events_still_returned():
    content = {'events': [{'category': 'obstacle', 'label': 'stairs',
                           'direction': 'front', 'text': None}]}
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, json={'choices': [{'message': {'content': json.dumps(content)}}]}))
    with TestClient(create_app(Settings(api_key='test-only'), transport)) as client:
        first = analyze(client, source='video', frame_id='1').json()
        second = analyze(client, source='video', frame_id='2').json()
        other = analyze(client, source='video', session_id='other-session', frame_id='3').json()
    assert first['speech']['text'] == '前方发现楼梯'
    assert second['speech'] is None
    assert [e['label'] for e in second['events']] == ['stairs']
    assert other['speech']['text'] == '前方发现楼梯'

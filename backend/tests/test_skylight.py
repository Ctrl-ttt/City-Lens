import io
import json

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.vision import Settings


def jpeg(width=64, height=48):
    output = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(output, format='JPEG')
    return output.getvalue()


def test_skylight_sample_is_opt_in_and_keeps_environment_contract():
    with TestClient(create_app(Settings(provider='sample'))) as client:
        health = client.get('/api/health').json()
        assert health['plugins']['skylight']['configured'] is True
        response = client.post('/api/plugins/skylight/analyze', files={
            'image': ('frame.jpg', jpeg(), 'image/jpeg')},
            data={'projection': 'rectilinear', 'source': 'camera', 'heading_deg': '0'})
        assert response.status_code == 200
        result = response.json()
        assert result['items'][0]['name'] == '样例蔬菜'
        assert result['projection'] == 'rectilinear'


def test_skylight_live_uses_separate_prompt_and_accepts_x4_air_panorama():
    def handler(request):
        payload = json.loads(request.content)
        assert payload['messages'][0]['content'].startswith('你是 Skylight 食材助手')
        assert payload['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,')
        content = {'items': [{'name': '西红柿', 'description': '红色圆形果实',
                              'confidence': 0.9, 'freshness_score': 80,
                              'freshness_label': '表面完整',
                              'selection_tip': '选择表面完整的果实。',
                              'warning': '仅凭画面无法确认气味。'}],
                   'scene_note': '画面中有一份蔬菜。'}
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(content, ensure_ascii=False)}}]})

    with TestClient(create_app(Settings(api_key='test-only'), httpx.MockTransport(handler))) as client:
        response = client.post('/api/plugins/skylight/analyze', files={
            'image': ('panorama.jpg', jpeg(1280, 640), 'image/jpeg')},
            data={'projection': 'equirectangular', 'source': 'camera', 'heading_deg': '15'})
        assert response.status_code == 200
        assert response.json()['items'][0]['name'] == '西红柿'
        assert response.json()['projection'] == 'equirectangular'


def test_skylight_rejects_foreign_origin():
    with TestClient(create_app(Settings(provider='sample'))) as client:
        response = client.post('/api/plugins/skylight/analyze', headers={'origin': 'https://example.com'},
                               files={'image': ('frame.jpg', jpeg(), 'image/jpeg')})
        assert response.status_code == 403
        assert response.json()['error_code'] == 'forbidden_origin'

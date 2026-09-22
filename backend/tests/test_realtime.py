import asyncio
import base64
import io
import json
import logging
import threading
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from starlette.websockets import WebSocketDisconnect
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosedError, InvalidHandshake, InvalidStatus
from websockets.http11 import Response

import backend.app as app_module
import backend.realtime as realtime_module
from backend.models import AnalyzeResponse
from backend.vision import Settings, VisionError, parse_result


ORIGIN = {'origin': 'http://localhost:8000'}
SECRET = 'test-only-secret-never-expose'
PRIVATE = 'private-provider-body-or-image-metadata'
DIRECT_CONNECT = realtime_module.DirectConnect
RESULT = {
    'uncertain': False,
    'events': [{'category': 'obstacle', 'label': 'bicycle',
                'direction': 'right', 'text': PRIVATE}],
}
RESULT_TEXT = json.dumps(RESULT)


def settings(**overrides):
    return Settings(**{'provider': 'realtime', 'api_key': SECRET, 'timeout': 1,
                       **overrides})


def jpeg(size=(32, 24), metadata=False, format='JPEG'):
    output = io.BytesIO()
    options = {}
    if metadata:
        exif = Image.Exif()
        exif[270] = PRIVATE
        options['exif'] = exif
    Image.new('RGB', size, 'white').save(output, format=format, **options)
    return output.getvalue()


def frame(**overrides):
    return {'type': 'frame', 'session_id': 'realtime-test', 'frame_id': 1,
            'mode': 'walk', 'source': 'camera',
            'image': base64.b64encode(jpeg()).decode('ascii'), **overrides}


def run(coroutine):
    async def bounded():
        return await asyncio.wait_for(coroutine, 3)
    return asyncio.run(bounded())


def no_http(request):
    pytest.fail('Unexpected HTTP model request; all model traffic must be mocked')


@pytest.fixture(autouse=True)
def forbid_real_model_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Unexpected real realtime connection')

    async def forbidden_http(*args, **kwargs):
        pytest.fail('Unexpected real HTTP connection')

    monkeypatch.setattr(realtime_module, 'DirectConnect', forbidden)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, 'handle_async_request', forbidden_http)


def client_for(config=None, transport=None):
    return TestClient(app_module.create_app(
        config or settings(), transport or httpx.MockTransport(no_http)))


def response_events(turn):
    response_id = f'response-{turn}'
    assistant_id = f'assistant-{turn}'
    # The output-only ID checks cleanup even when item.created wasn't emitted.
    return [
        {'type': 'response.created', 'response': {'id': response_id}},
        {'type': 'conversation.item.created',
         'item': {'id': assistant_id, 'role': 'assistant'}},
        {'type': 'response.text.delta', 'response_id': response_id,
         'delta': RESULT_TEXT[:20]},
        {'type': 'response.text.delta', 'response_id': response_id,
         'delta': RESULT_TEXT[20:]},
        {'type': 'response.text.done', 'response_id': response_id, 'text': RESULT_TEXT},
        {'type': 'response.done', 'response': {
            'id': response_id, 'status': 'completed',
            'output': [{'id': assistant_id, 'content': [{'type': 'text', 'text': RESULT_TEXT}]},
                       {'id': f'output-{turn}', 'content': []}]}},
    ]


class QueueServer:
    """An in-memory, reactive provider; no prerecorded client-side return values."""

    def __init__(self, script=response_events, initialize_events=None):
        self.queue = asyncio.Queue()
        self.script = script
        self.initialize_events = initialize_events
        self.sent = []
        self.received = []
        self.active_items = set()
        self.turn = 0
        self.stage = 0
        self.closed = False
        self.done_waiting = asyncio.Event()
        self.allow_done = asyncio.Event()
        self.allow_done.set()
        self.delete_waiting = asyncio.Event()
        self.allow_delete = asyncio.Event()
        self.allow_delete.set()

    def emit(self, event):
        self.queue.put_nowait(event)

    async def send(self, message):
        event = json.loads(message)
        self.sent.append(event)
        kind = event['type']
        if kind == 'session.update':
            session = event['session']
            assert session['modalities'] == ['text']
            assert session['turn_detection'] is None
            assert session['input_audio_format'] == 'pcm16'
            assert session['max_response_output_tokens'] == 450
            assert '最新图像' in session['instructions']
            for reply in (self.initialize_events if self.initialize_events is not None
                          else [{'type': 'session.updated'}]):
                self.emit(reply)
        elif kind == 'input_audio_buffer.append':
            assert self.stage == 0
            assert not self.active_items, 'Previous frame context was not deleted'
            assert base64.b64decode(event['audio'], validate=True) == bytes(6400)
            self.stage = 1
        elif kind == 'input_image_buffer.append':
            assert self.stage == 1, 'Image must follow synthetic audio'
            assert base64.b64decode(event['image'], validate=True)
            self.stage = 2
        elif kind == 'input_audio_buffer.commit':
            assert self.stage == 2, 'Commit must follow both audio and image'
            self.stage = 3
            self.turn += 1
            self.emit({'type': 'conversation.item.created',
                       'item': {'id': f'user-{self.turn}', 'role': 'user'}})
        elif kind == 'response.create':
            assert self.stage == 3
            assert event.get('response', {}).get('modalities', ['text']) == ['text']
            self.stage = 0
            for reply in self.script(self.turn):
                self.emit(reply)
        elif kind == 'conversation.item.delete':
            assert event['item_id'] in self.active_items
            self.emit({'type': 'conversation.item.deleted', 'item_id': event['item_id']})
        else:
            pytest.fail(f'Unexpected provider command: {kind}')

    async def recv(self):
        event = await self.queue.get()
        if isinstance(event, BaseException):
            raise event
        if isinstance(event, dict):
            kind = event.get('type')
            if kind == 'response.done':
                self.done_waiting.set()
                await self.allow_done.wait()
                response = event.get('response')
                if isinstance(response, dict):
                    for item in response.get('output', []):
                        self.active_items.add(item['id'])
            elif kind == 'conversation.item.created':
                self.active_items.add(event['item']['id'])
            elif kind == 'conversation.item.deleted':
                self.delete_waiting.set()
                await self.allow_delete.wait()
                self.active_items.remove(event['item_id'])
        self.received.append(event)
        return event if isinstance(event, str) else json.dumps(event)


def install_connection(monkeypatch, server, enter_error=None):
    connection = SimpleNamespace(calls=[], exits=0)

    @asynccontextmanager
    async def connect(url, **kwargs):
        connection.calls.append((url, kwargs))
        try:
            if enter_error is not None:
                raise enter_error
            yield server
        finally:
            server.closed = True
            connection.exits += 1

    monkeypatch.setattr(realtime_module, 'DirectConnect', connect)
    return connection


class ObserverProbe:
    def __init__(self, *, blocked=False, initializing=False, error=None):
        self.blocked = blocked
        self.initializing = initializing
        self.error = error
        self.images = []
        self.opened = threading.Event()
        self.started = threading.Event()
        self.cancelled = threading.Event()
        self.closed = threading.Event()
        self.entries = 0
        self.exits = 0

    @asynccontextmanager
    async def session(self, config):
        self.entries += 1
        self.opened.set()
        try:
            if self.initializing:
                await asyncio.Event().wait()
            yield self
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        finally:
            self.exits += 1
            self.closed.set()

    async def observe(self, image):
        self.images.append(image)
        self.started.set()
        if self.blocked:
            await asyncio.Event().wait()
        if self.error is not None:
            raise self.error
        return parse_result(RESULT_TEXT)


def install_probe(monkeypatch, **kwargs):
    probe = ObserverProbe(**kwargs)
    monkeypatch.setattr(app_module, 'realtime_session', probe.session)
    return probe


def error_and_close(socket, code):
    result = socket.receive_json()
    assert result == {'type': 'error', 'error_code': code,
                      'message': app_module.MESSAGES[code]}
    with pytest.raises(WebSocketDisconnect) as closed:
        socket.receive_json()
    assert closed.value.code == 1000
    return result


def assert_no_secrets(*values):
    text = ' '.join(str(value) for value in values)
    assert SECRET not in text
    assert PRIVATE not in text


def frame_tasks():
    return [task for task in asyncio.all_tasks()
            if task.get_coro().__qualname__.endswith(('.receive_frames', '.process_frames'))]


def assert_released(client):
    async def inspect():
        assert not client.app.state.lock.locked()
        assert not client.app.state.realtime_lock.locked()
        assert not frame_tasks()
    client.portal.call(inspect)


def disconnect_and_join(client, socket):
    async def capture():
        return frame_tasks()

    tasks = client.portal.call(capture)
    assert len(tasks) == 2
    # Explicitly deliver disconnect before TestClient's context-manager cancellation.
    socket.close()

    async def join():
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
    client.portal.call(join)
    assert all(task.done() for task in tasks)


@pytest.mark.parametrize('overrides,endpoint', [
    ({}, 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'),
    ({'base_url': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'},
     'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'),
    ({'base_url': 'https://example.test:9443/custom'},
     'wss://example.test:9443/api-ws/v1/realtime'),
    ({'realtime_url': 'wss://example.test:9443/custom'}, 'wss://example.test:9443/custom'),
    ({'base_url': 'http://example.test/v1'}, ''),
    ({'base_url': 'https://user:password@example.test/v1'}, ''),
    ({'base_url': 'https://example.test/v1?secret=value'}, ''),
    ({'realtime_url': 'https://example.test/realtime'}, ''),
    ({'realtime_url': 'wss:///no-host'}, ''),
    ({'realtime_url': 'wss://example.test/realtime#fragment'}, ''),
    ({'realtime_url': 'wss://user:password@example.test/realtime'}, ''),
    ({'realtime_url': 'wss://example.test/realtime?model=override'}, ''),
])
def test_realtime_endpoint_derivation(overrides, endpoint):
    config = settings(**overrides)
    assert config.realtime_endpoint == endpoint
    assert config.realtime_configured is bool(endpoint)
    assert config.configured is bool(endpoint)


def test_connection_options_and_redirects_never_forward_credentials(monkeypatch):
    server = QueueServer()
    connection = install_connection(monkeypatch, server)
    config = settings(realtime_model='model with+reserved&characters')

    async def scenario():
        async with realtime_module.realtime_session(config) as session:
            assert isinstance(session, realtime_module.RealtimeVision)
    run(scenario())
    url, options = connection.calls[0]
    assert parse_qs(urlsplit(url).query) == {'model': [config.realtime_model]}
    assert SECRET not in url
    assert options == {
        'additional_headers': {'Authorization': f'Bearer {SECRET}'},
        'open_timeout': config.timeout, 'close_timeout': 1,
        'max_size': realtime_module.MAX_FRAME_MESSAGE, 'max_queue': 4,
        'ping_interval': 20, 'ping_timeout': 10,
    }
    redirect = InvalidStatus(Response(302, 'Redirect', Headers({
        'Location': 'wss://untrusted.example/realtime'}), body=PRIVATE.encode()))
    assert DIRECT_CONNECT.process_redirect(None, redirect) is redirect
    assert server.closed and connection.exits == 1


def test_protocol_two_frames_wait_for_completion_and_context_deletion(monkeypatch):
    async def scenario():
        server = QueueServer()
        server.allow_done.clear()
        server.allow_delete.clear()
        parser = Mock(wraps=parse_result)
        monkeypatch.setattr(realtime_module, 'parse_result', parser)
        session = realtime_module.RealtimeVision(server, settings())
        await session.initialize()
        image = jpeg()
        task = asyncio.create_task(session.observe(image))
        try:
            await asyncio.wait_for(server.done_waiting.wait(), 1)
            assert not task.done()
            parser.assert_not_called()
            assert not any(event['type'] == 'conversation.item.delete' for event in server.sent)
            server.allow_done.set()
            await asyncio.wait_for(server.delete_waiting.wait(), 1)
            assert not task.done(), 'Do not return before deletion acknowledgements'
            parser.assert_called_once_with(RESULT_TEXT)
            server.allow_delete.set()
            first = await task
            second = await session.observe(image)
            assert first == second == parse_result(RESULT_TEXT)
            assert not server.active_items
            assert server.queue.empty()
            assert parser.call_count == 2
            assert [event['image'] for event in server.sent
                    if event['type'] == 'input_image_buffer.append'] == [
                        base64.b64encode(image).decode('ascii')] * 2
            deletes = [event['item_id'] for event in server.sent
                       if event['type'] == 'conversation.item.delete']
            assert len(deletes) == 6
            assert set(deletes) == {f'{role}-{turn}' for role in ('user', 'assistant', 'output')
                                   for turn in (1, 2)}
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    run(scenario())


def invalid_script(case):
    def script(turn):
        events = response_events(turn)
        if case == 'incomplete':
            events[-1]['response']['status'] = 'incomplete'
        elif case == 'failed':
            events[-1]['response']['status'] = 'failed'
        elif case == 'wrong-done-id':
            events[-1]['response']['id'] = 'wrong-response'
        elif case == 'wrong-delta-id':
            events[2]['response_id'] = 'wrong-response'
        elif case == 'wrong-text-done-id':
            events[-2]['response_id'] = 'wrong-response'
        elif case == 'missing-created':
            events = events[1:]
        elif case == 'long-delta':
            events[2]['delta'] = 'x' * 12001
        elif case == 'long-text-done':
            events[-2]['text'] = 'x' * 12001
        elif case == 'invalid-json':
            events[-2]['text'] = '{' + PRIVATE
        elif case == 'missing-fields':
            events[-2]['text'] = '{}'
        elif case == 'unknown-label':
            events[-2]['text'] = json.dumps({'events': [{
                'category': 'obstacle', 'label': 'invented',
                'direction': 'front', 'text': PRIVATE}]})
        elif case == 'malformed-event':
            events = ['{' + PRIVATE]
        elif case == 'non-object-event':
            events = [[]]
        elif case == 'malformed-response':
            events[-1]['response'] = []
        elif case == 'inconsistent-final-text':
            events[-1]['response']['output'][0]['content'][0]['text'] = '{}'
        if case in ('invalid-json', 'unknown-label', 'missing-fields', 'long-text-done'):
            events[-1]['response']['output'][0]['content'][0]['text'] = events[-2]['text']
        return events
    return script


@pytest.mark.parametrize('case', [
    'incomplete', 'failed', 'wrong-done-id', 'wrong-delta-id',
    'wrong-text-done-id', 'missing-created', 'long-delta', 'long-text-done',
    'invalid-json', 'missing-fields', 'unknown-label', 'malformed-event', 'non-object-event',
    'malformed-response', 'inconsistent-final-text',
])
def test_invalid_provider_output_never_returns_a_result(monkeypatch, caplog, case):
    caplog.set_level(logging.INFO, logger='citylens')
    server = QueueServer(script=invalid_script(case))
    connection = install_connection(monkeypatch, server)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            error_and_close(socket, 'invalid_model_output')
        assert_released(client)
        assert_no_secrets(client.get('/api/health').text, caplog.text)
    assert server.closed and connection.exits == 1


def test_oversized_encoded_image_is_rejected_before_sending(monkeypatch):
    async def scenario():
        server = QueueServer()
        session = realtime_module.RealtimeVision(server, settings())
        await session.initialize()
        before = list(server.sent)
        image = bytes((realtime_module.MAX_ENCODED_IMAGE // 4) * 3 + 1)
        with pytest.raises(VisionError) as error:
            await session.observe(image)
        assert error.value.code == 'realtime_image_too_large'
        assert server.sent == before
    run(scenario())


@pytest.mark.parametrize('stage', ['initialize', 'response', 'delete'])
def test_provider_deadlines_close_connection_and_release_locks(monkeypatch, stage):
    server = QueueServer(initialize_events=[] if stage == 'initialize' else None,
                         script=(lambda turn: response_events(turn)[:-1])
                         if stage == 'response' else response_events)
    if stage == 'delete':
        server.allow_delete.clear()
    connection = install_connection(monkeypatch, server)
    with client_for(settings(timeout=.01)) as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            if stage != 'initialize':
                assert socket.receive_json() == {'type': 'ready'}
                socket.send_json(frame())
            error_and_close(socket, 'model_timeout')
        assert_released(client)
    assert server.closed and connection.exits == 1


@pytest.mark.parametrize('provider_code,code', [
    ('InvalidApiKey', 'model_auth'), ('permission_denied', 'model_auth'),
    ('rate_limit_exceeded', 'rate_limited'), ('Throttling', 'rate_limited'),
    (PRIVATE, 'realtime_protocol'),
])
def test_provider_error_events_are_sanitized(monkeypatch, caplog, provider_code, code):
    event = {'type': 'error', 'error': {'code': provider_code,
                                      'message': SECRET + PRIVATE}}
    server = QueueServer(script=lambda turn: [event])
    install_connection(monkeypatch, server)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            result = error_and_close(socket, code)
        assert_released(client)
        assert_no_secrets(result, client.get('/api/health').text, caplog.text)
    assert server.closed


@pytest.mark.parametrize('failure,code', [
    (401, 'model_auth'), (403, 'model_auth'), (429, 'rate_limited'),
    (503, 'model_unavailable'), ('handshake', 'network_error'),
    ('network', 'network_error'), ('timeout', 'model_timeout'),
])
def test_connection_failures_are_sanitized(monkeypatch, caplog, failure, code):
    if isinstance(failure, int):
        error = InvalidStatus(Response(failure, PRIVATE, Headers(), body=SECRET.encode()))
    else:
        error = {'handshake': InvalidHandshake, 'network': OSError,
                 'timeout': TimeoutError}[failure](PRIVATE + SECRET)
    server = QueueServer()
    connection = install_connection(monkeypatch, server, enter_error=error)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            result = error_and_close(socket, code)
        assert_released(client)
        assert_no_secrets(result, caplog.text, client.get('/api/health').text)
    assert connection.exits == 1


def test_upstream_disconnect_during_frame_releases_resources(monkeypatch, caplog):
    server = QueueServer(script=lambda turn: [ConnectionClosedError(None, None)])
    connection = install_connection(monkeypatch, server)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            error_and_close(socket, 'network_error')
        assert_released(client)
        assert_no_secrets(caplog.text)
    assert server.closed and connection.exits == 1


@pytest.mark.parametrize('origin', [None, 'null', 'https://evil.example',
                                  'http://localhost:8000.evil.example',
                                  'http://localhost:8000@evil.example'])
def test_websocket_requires_exact_allowed_origin(origin):
    with client_for() as client:
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('/api/realtime', headers={} if origin is None
                                          else {'origin': origin}):
                pytest.fail('Untrusted origin was accepted')
        assert error.value.code == 1008
        assert_released(client)


@pytest.mark.parametrize('overrides,code', [
    ({'provider': 'sample'}, 'realtime_unavailable'),
    ({'api_key': ''}, 'not_configured'),
    ({'realtime_model': ''}, 'not_configured'),
    ({'realtime_url': 'ws://example.test/realtime'}, 'not_configured'),
])
def test_unavailable_websocket_never_connects_to_provider(overrides, code):
    with client_for(settings(**overrides)) as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            error_and_close(socket, code)
        assert_released(client)
    if code == 'not_configured':
        async def scenario():
            with pytest.raises(VisionError) as error:
                async with realtime_module.realtime_session(settings(**overrides)):
                    pytest.fail('Unconfigured session was opened')
            assert error.value.code == 'not_configured'
        run(scenario())


def test_ws_two_sources_use_in_memory_sanitized_jpegs(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger='citylens')
    clock = SimpleNamespace(now=1024.0)
    monkeypatch.setattr(app_module, 'time', SimpleNamespace(monotonic=lambda: clock.now))
    server = QueueServer()
    connection = install_connection(monkeypatch, server)
    original = jpeg(size=(1400, 40), metadata=True)
    encoded = base64.b64encode(original).decode('ascii')
    assert PRIVATE.encode() in original
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            for number, source in enumerate(('camera', 'video'), start=1):
                clock.now += 1
                socket.send_json(frame(frame_id=number, source=source, image=encoded))
                message = socket.receive_json()
                assert message.pop('type') == 'result'
                result = AnalyzeResponse.model_validate(message)
                assert (result.session_id, result.frame_id) == ('realtime-test', number)
                assert result.status == 'ok' and result.error_code is None
                assert result.events[0].text == '自行车'
                assert result.speech.text == '右前方发现自行车'
                assert result.latency_ms >= 0
                assert_no_secrets(message)
            disconnect_and_join(client, socket)
        assert_released(client)
        assert encoded not in caplog.text
        assert_no_secrets(client.get('/api/health').text, caplog.text)
    images = [base64.b64decode(event['image']) for event in server.sent
              if event['type'] == 'input_image_buffer.append']
    assert len(images) == 2
    for image in images:
        assert image != original and PRIVATE.encode() not in image
        with Image.open(io.BytesIO(image)) as decoded:
            assert decoded.format == 'JPEG'
            assert max(decoded.size) <= 960
            assert not decoded.getexif()
    assert server.closed and not server.active_items and connection.exits == 1


@pytest.mark.parametrize('case', [
    'read', 'unknown-field', 'wrong-type', 'invalid-session', 'negative-frame',
    'invalid-source', 'invalid-base64', 'non-ascii-base64', 'non-jpeg', 'png', 'invalid-json',
    'binary', 'oversized-message', 'oversized-image',
])
def test_invalid_client_frames_close_without_observation(monkeypatch, caplog, case):
    probe = install_probe(monkeypatch)
    message = frame()
    changes = {
        'read': {'mode': 'read'}, 'unknown-field': {'secret': SECRET},
        'wrong-type': {'type': 'audio'}, 'invalid-session': {'session_id': '../private'},
        'negative-frame': {'frame_id': -1}, 'invalid-source': {'source': 'microphone'},
        'invalid-base64': {'image': '!not-base64!'},
        'non-ascii-base64': {'image': '不是编码图片'},
        'non-jpeg': {'image': base64.b64encode(PRIVATE.encode()).decode('ascii')},
        'png': {'image': base64.b64encode(jpeg(format='PNG')).decode('ascii')},
        'oversized-image': {'image': 'A' * (realtime_module.MAX_ENCODED_IMAGE + 4)},
    }
    message.update(changes.get(case, {}))
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            if case == 'binary':
                socket.send_bytes(jpeg())
            elif case == 'invalid-json':
                socket.send_text('{' + PRIVATE)
            elif case == 'oversized-message':
                socket.send_text(' ' * (realtime_module.MAX_FRAME_MESSAGE + 1))
            else:
                socket.send_json(message)
            error_and_close(socket, 'invalid_input')
        assert_released(client)
        assert probe.images == [] and probe.exits == 1
        assert_no_secrets(caplog.text)


@pytest.mark.parametrize('second', [
    {'frame_id': 1}, {'frame_id': 0}, {'frame_id': 2, 'session_id': 'other-session'},
])
def test_session_and_frame_sequence_cannot_change_or_regress(monkeypatch, second):
    probe = install_probe(monkeypatch)
    clock = SimpleNamespace(now=1024.0)
    monkeypatch.setattr(app_module, 'time', SimpleNamespace(monotonic=lambda: clock.now))
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            assert socket.receive_json()['type'] == 'result'
            clock.now += 1
            socket.send_json(frame(**second))
            error_and_close(socket, 'invalid_input')
        assert len(probe.images) == 1
        assert_released(client)


@pytest.mark.parametrize('interval,accepted', [(.899, False), (.9, True)])
def test_frame_interval_boundary_without_sleep(monkeypatch, interval, accepted):
    probe = install_probe(monkeypatch)
    clock = SimpleNamespace(now=1024.0)
    # Replace app's reference, not the shared time module used by the event loop.
    monkeypatch.setattr(app_module, 'time', SimpleNamespace(monotonic=lambda: clock.now))
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            assert socket.receive_json()['type'] == 'result'
            clock.now += interval
            socket.send_json(frame(frame_id=2))
            if accepted:
                assert socket.receive_json()['frame_id'] == 2
                disconnect_and_join(client, socket)
            else:
                error_and_close(socket, 'rate_limited')
        assert len(probe.images) == (2 if accepted else 1)
        assert_released(client)


def test_only_one_websocket_slot_and_reconnect_after_disconnect(monkeypatch):
    probe = install_probe(monkeypatch)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as first:
            assert first.receive_json() == {'type': 'ready'}
            with client.websocket_connect('/api/realtime', headers=ORIGIN) as second:
                error_and_close(second, 'busy')
            assert probe.entries == 1
            first.send_json(frame())
            assert first.receive_json()['type'] == 'result'
            disconnect_and_join(client, first)
        assert_released(client)
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as replacement:
            assert replacement.receive_json() == {'type': 'ready'}
            disconnect_and_join(client, replacement)
        assert probe.entries == probe.exits == 2
        assert_released(client)


def test_inflight_frame_is_cancelled_not_queued_on_second_frame(monkeypatch):
    probe = install_probe(monkeypatch, blocked=True)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            assert probe.started.wait(2)
            socket.send_json(frame(frame_id=2))
            error_and_close(socket, 'busy')
        assert len(probe.images) == 1
        assert probe.cancelled.is_set() and probe.exits == 1
        assert_released(client)


@pytest.mark.parametrize('stage', ['initializing', 'idle', 'inflight'])
def test_client_disconnect_cancels_background_tasks_and_releases_slot(monkeypatch, stage):
    probe = install_probe(monkeypatch, initializing=stage == 'initializing',
                          blocked=stage == 'inflight')
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert probe.opened.wait(2)
            if stage != 'initializing':
                assert socket.receive_json() == {'type': 'ready'}
            if stage == 'inflight':
                socket.send_json(frame())
                assert probe.started.wait(2)
            disconnect_and_join(client, socket)
        assert probe.cancelled.is_set() and probe.closed.is_set()
        assert probe.entries == probe.exits == 1
        assert_released(client)
        # A fresh connection must not inherit a frame ID or occupied permit.
        replacement = install_probe(monkeypatch)
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame(frame_id=0, session_id='fresh'))
            assert socket.receive_json()['frame_id'] == 0
            disconnect_and_join(client, socket)
        assert replacement.exits == 1
        assert_released(client)


def test_frame_before_ready_cancels_initialization(monkeypatch):
    probe = install_probe(monkeypatch, initializing=True)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert probe.opened.wait(2)
            socket.send_json(frame())
            error_and_close(socket, 'busy')
        assert probe.cancelled.is_set() and probe.images == []
        assert_released(client)


def test_idle_timeout_closes_provider_and_releases_session(monkeypatch):
    probe = install_probe(monkeypatch)
    monkeypatch.setattr(app_module, 'REALTIME_IDLE_TIMEOUT', .01)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            error_and_close(socket, 'realtime_idle')
        assert probe.exits == 1 and probe.images == []
        assert_released(client)


def test_unexpected_exception_has_no_secret_or_traceback_in_logs(monkeypatch, caplog):
    probe = install_probe(monkeypatch, error=RuntimeError(SECRET + PRIVATE))
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            result = error_and_close(socket, 'internal_error')
        assert probe.exits == 1
        assert_released(client)
        assert_no_secrets(result, caplog.text, client.get('/api/health').text)
        assert not any(record.exc_info for record in caplog.records)


def http_frame(client, mode='walk'):
    return client.post('/api/analyze', headers=ORIGIN,
                       data={'session_id': 'http-test', 'frame_id': '1',
                             'mode': mode, 'source': 'video'},
                       files={'image': ('frame.jpg', jpeg(), 'image/jpeg')})


def test_http_and_realtime_share_single_inflight_lock(monkeypatch):
    probe = install_probe(monkeypatch, blocked=True)
    with client_for() as client:
        with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
            assert socket.receive_json() == {'type': 'ready'}
            socket.send_json(frame())
            assert probe.started.wait(2)
            response = http_frame(client)
            assert response.status_code == 429
            assert response.json()['error_code'] == 'busy'
            disconnect_and_join(client, socket)
        assert_released(client)
        probe = install_probe(monkeypatch)
        client.portal.call(client.app.state.lock.acquire)
        try:
            with client.websocket_connect('/api/realtime', headers=ORIGIN) as socket:
                assert socket.receive_json() == {'type': 'ready'}
                socket.send_json(frame())
                error_and_close(socket, 'busy')
            assert probe.images == [] and probe.exits == 1
        finally:
            client.portal.call(client.app.state.lock.release)
        assert_released(client)


@pytest.mark.parametrize('provider', ['realtime', 'sample'])
def test_http_walk_and_read_remain_available_with_original_model(provider, caplog):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url == 'https://example.test/compatible-mode/v1/chat/completions'
        assert request.headers['authorization'] == f'Bearer {SECRET}'
        payload = json.loads(request.content)
        assert payload['model'] == 'original-http-model'
        assert payload['stream'] is False
        content = payload['messages'][1]['content']
        assert content[1]['image_url']['url'].startswith('data:image/jpeg;base64,')
        assert base64.b64decode(content[1]['image_url']['url'].split(',', 1)[1]).startswith(b'\xff\xd8')
        result = RESULT
        if len(requests) == 2:
            assert '看牌模式' in content[0]['text']
            result = {'events': [{'category': 'text', 'label': 'sign',
                                  'direction': 'front', 'text': '城市图书馆'}]}
        else:
            assert '环境模式' in content[0]['text']
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})

    config = settings(provider=provider, model='original-http-model',
                      base_url='https://example.test/compatible-mode/v1')
    with client_for(config, httpx.MockTransport(handler)) as client:
        health = client.get('/api/health').json()
        assert health['http_model'] == 'original-http-model'
        assert health['model'] == ('fixed-sample' if provider == 'sample' else config.realtime_model)
        assert health['configured'] and health['http_configured']
        assert health['realtime_configured'] is (provider == 'realtime')
        for mode in ('walk', 'read'):
            response = http_frame(client, mode)
            assert response.status_code == 200
            assert response.headers['cache-control'] == 'no-store'
            result = AnalyzeResponse.model_validate(response.json())
            assert result.status == 'ok'
            assert result.events[0].label == ('bicycle' if mode == 'walk' else 'sign')
            assert result.speech is not None
            assert_no_secrets(response.text, caplog.text, health)
        assert len(requests) == (2 if provider == 'realtime' else 0)
        assert_released(client)

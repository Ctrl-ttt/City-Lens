import asyncio
import json
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import link2


URL = '/api/camera/link2'
DEVICE = '00ab12ff'
ORIGINS = {'http://localhost:8000', 'http://127.0.0.1:8000',
           'http://localhost:5173', 'http://127.0.0.1:5173'}
HEADERS = {'X-CityLens-Camera': '1', 'origin': 'http://localhost:8000'}
PRIVATE = 'private native diagnostic; never return this to the browser'
VALID_COMMANDS = [
    pytest.param({'action': 'status'}, ['status', DEVICE], id='status'),
    pytest.param({'action': 'ptz', 'pan': -145, 'tilt': -45},
                 ['ptz', DEVICE, '-145', '-45'], id='ptz-minimum'),
    pytest.param({'action': 'ptz', 'pan': 145, 'tilt': 90},
                 ['ptz', DEVICE, '145', '90'], id='ptz-maximum'),
    pytest.param({'action': 'ptz', 'pan': 0, 'tilt': 0},
                 ['ptz', DEVICE, '0', '0'], id='ptz-zero'),
    pytest.param({'action': 'zoom', 'zoom': 0}, ['zoom', DEVICE, '0'], id='zoom-minimum'),
    pytest.param({'action': 'zoom', 'zoom': 65535},
                 ['zoom', DEVICE, '65535'], id='zoom-maximum'),
    pytest.param({'action': 'autofocus', 'enabled': True},
                 ['autofocus', DEVICE, '1'], id='autofocus-on'),
    pytest.param({'action': 'autofocus', 'enabled': False},
                 ['autofocus', DEVICE, '0'], id='autofocus-off'),
]


def command(**overrides):
    return {'device_id': DEVICE, 'action': 'status', **overrides}


def framed(data):
    return b'CITYLENS_JSON=' + json.dumps(data, ensure_ascii=False).encode('utf-8') + b'\n'


def completed(data=None, *, stdout=None, returncode=0):
    return subprocess.CompletedProcess(
        ['mock-bridge'], returncode,
        stdout=framed({} if data is None else data) if stdout is None else stdout,
        stderr=PRIVATE.encode())


def assert_camera_error(error, code, status):
    assert error.code == code
    assert error.status == status


def assert_error_response(response, code, status):
    assert response.status_code == status
    assert response.headers['cache-control'] == 'no-store'
    assert response.json() == {'status': 'error', 'code': code,
                               'message': link2.MESSAGES[code]}
    assert PRIVATE not in response.text


def app_for(adapter):
    # Isolate the router: no model clients, app lifespan, or websockets dependency.
    app = FastAPI()
    app.include_router(link2.camera_router(ORIGINS, bridge=adapter))
    return app


def run(coroutine):
    async def bounded():
        return await asyncio.wait_for(coroutine, 10)
    return asyncio.run(bounded())


@pytest.fixture(autouse=True)
def no_real_subprocess(monkeypatch):
    native = Mock(side_effect=AssertionError('Unexpected native subprocess'))
    monkeypatch.setattr(link2.subprocess, 'run', native)
    monkeypatch.setattr(link2.subprocess, 'Popen',
                        Mock(side_effect=AssertionError('Unexpected real hardware process')))
    return native


@pytest.fixture
def bridge(no_real_subprocess):
    # A mocked Path ensures no installed SDK or filesystem layout is required.
    path = MagicMock(spec=Path)
    path.parent = Path(__file__).resolve().parent / 'mock SDK 空格 & tools'
    path.__str__.return_value = str(path.parent / 'citylens-link2.exe')
    path.is_file.return_value = True
    no_real_subprocess.side_effect = None
    no_real_subprocess.return_value = completed({'devices': []})
    return link2.Link2Bridge(path=path)


@pytest.fixture
def adapter():
    return SimpleNamespace(run=AsyncMock(return_value={}))


@pytest.fixture
def client(adapter):
    with TestClient(app_for(adapter)) as test_client:
        yield test_client


@pytest.mark.parametrize('payload,arguments', VALID_COMMANDS)
def test_command_and_control_arguments(client, adapter, payload, arguments):
    payload = command(**payload)
    assert link2.Command.model_validate(payload).arguments() == arguments
    adapter.run.return_value = {'device_id': DEVICE, 'applied': True}
    response = client.post(URL, headers=HEADERS, json=payload)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json() == {'status': 'ok', 'device_id': DEVICE, 'applied': True}
    adapter.run.assert_awaited_once_with(arguments)


@pytest.mark.parametrize('device_id', ['00', 'ff' * 2048], ids=['minimum', 'maximum'])
def test_device_id_length_boundaries(client, adapter, device_id):
    payload = command(device_id=device_id)
    assert link2.Command.model_validate(payload).arguments() == ['status', device_id]
    assert client.post(URL, headers=HEADERS, json=payload).status_code == 200
    adapter.run.assert_awaited_once_with(['status', device_id])


@pytest.mark.parametrize('device_id', [
    '', '0', 'abc', 'AB', '0g', '0x00', ' aa', 'aa ', 'aa\n', 'aa\x00',
    '../aa', 'aa;whoami', 'aa && whoami', '--help', '相机', 'ff' * 2049,
    None, 12, True, [], {},
], ids=[
    'empty', 'one-character', 'odd-length', 'uppercase', 'non-hex', 'hex-prefix',
    'leading-space', 'trailing-space', 'newline', 'nul', 'path', 'semicolon',
    'shell-operator', 'option', 'unicode', 'too-long', 'null', 'number', 'boolean',
    'array', 'object',
])
def test_invalid_device_ids_never_reach_adapter(client, adapter, device_id):
    payload = command(device_id=device_id)
    with pytest.raises(ValidationError):
        link2.Command.model_validate(payload)
    assert_error_response(client.post(URL, headers=HEADERS, json=payload), 'invalid_input', 422)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('payload', [
    pytest.param({}, id='missing-all'),
    pytest.param({'action': 'status'}, id='missing-device'),
    pytest.param({'device_id': DEVICE}, id='missing-action'),
    pytest.param(command(action='list'), id='list-is-get-only'),
    pytest.param(command(action='reboot'), id='unknown-action'),
    pytest.param(command(action=None), id='null-action'),
    pytest.param(command(action=1), id='numeric-action'),
    pytest.param(command(extra='ignored?'), id='unknown-field'),
    pytest.param(command(pan=0), id='status-pan'),
    pytest.param(command(tilt=0), id='status-tilt'),
    pytest.param(command(zoom=0), id='status-zoom'),
    pytest.param(command(enabled=False), id='status-enabled'),
    pytest.param(command(pan=None), id='explicit-unused-null'),
    pytest.param(command(action='ptz'), id='ptz-missing-both'),
    pytest.param(command(action='ptz', pan=0), id='ptz-missing-tilt'),
    pytest.param(command(action='ptz', tilt=0), id='ptz-missing-pan'),
    pytest.param(command(action='ptz', pan=None, tilt=0), id='ptz-null-pan'),
    pytest.param(command(action='ptz', pan=0, tilt=None), id='ptz-null-tilt'),
    pytest.param(command(action='ptz', pan=0, tilt=0, zoom=1), id='ptz-extra-control'),
    pytest.param(command(action='zoom'), id='zoom-missing'),
    pytest.param(command(action='zoom', zoom=None), id='zoom-null'),
    pytest.param(command(action='zoom', zoom=1, enabled=False), id='zoom-extra-control'),
    pytest.param(command(action='autofocus'), id='autofocus-missing'),
    pytest.param(command(action='autofocus', enabled=None), id='autofocus-null'),
    pytest.param(command(action='autofocus', enabled=True, pan=None), id='autofocus-extra-null'),
])
def test_action_fields_are_exact_and_required(client, adapter, payload):
    with pytest.raises((ValidationError, link2.CameraError)) as error:
        link2.Command.model_validate(payload).arguments()
    if isinstance(error.value, link2.CameraError):
        assert_camera_error(error.value, 'invalid_input', 422)
    assert_error_response(client.post(URL, headers=HEADERS, json=payload), 'invalid_input', 422)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('field,action,values', [
    ('pan', 'ptz', [-146, 146, '0', 0.0, True, False, [], {}]),
    ('tilt', 'ptz', [-46, 91, '0', 0.0, True, False, [], {}]),
    ('zoom', 'zoom', [-1, 65536, '1', 1.0, True, False, [], {}]),
    ('enabled', 'autofocus', [0, 1, 'true', 'false', '1', 1.0, [], {}]),
])
def test_numeric_ranges_and_strict_types(client, adapter, field, action, values):
    for value in values:
        payload = command(action=action)
        if action == 'ptz':
            payload.update(pan=0, tilt=0)
        payload[field] = value
        with pytest.raises(ValidationError):
            link2.Command.model_validate(payload)
        response = client.post(URL, headers=HEADERS, json=payload)
        assert_error_response(response, 'invalid_input', 422)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('devices', [[], [{'id': DEVICE, 'name': 'Insta360 Link 2'}]])
def test_discovery_calls_list_and_preserves_devices(client, adapter, devices):
    adapter.run.return_value = {'devices': devices}
    response = client.get(URL, headers=HEADERS)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json() == {'status': 'ready', 'devices': devices}
    adapter.run.assert_awaited_once_with(['list'])


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('origin', [None, *sorted(ORIGINS)])
def test_allowed_and_absent_origins(client, adapter, method, origin):
    headers = {'x-citylens-camera': '1'}
    if origin is not None:
        headers['origin'] = origin
    response = client.request(method, URL, headers=headers, json=command())
    assert response.status_code == 200
    assert 'access-control-allow-origin' not in response.headers
    adapter.run.assert_awaited_once_with(['list'] if method == 'GET' else ['status', DEVICE])


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('changes', [
    pytest.param({'X-CityLens-Camera': None}, id='missing-header'),
    pytest.param({'X-CityLens-Camera': ''}, id='empty-header'),
    pytest.param({'X-CityLens-Camera': '0'}, id='wrong-header'),
    pytest.param({'X-CityLens-Camera': 'true'}, id='boolean-header'),
    pytest.param({'X-CityLens-Camera': '01'}, id='nonexact-header'),
    pytest.param({'origin': 'https://evil.example'}, id='foreign-origin'),
    pytest.param({'origin': 'null'}, id='opaque-origin'),
    pytest.param({'origin': ''}, id='empty-origin'),
    pytest.param({'origin': 'http://localhost:8000.evil.example'}, id='hostname-suffix'),
    pytest.param({'origin': 'http://localhost:8000@evil.example'}, id='userinfo'),
    pytest.param({'origin': 'http://localhost:8000/'}, id='trailing-slash'),
    pytest.param({'origin': 'https://localhost:8000'}, id='different-scheme'),
    pytest.param({'origin': 'http://localhost:9999'}, id='different-port'),
    pytest.param({'sec-fetch-site': 'cross-site'}, id='cross-site-allowed-origin'),
    pytest.param({'sec-fetch-site': 'cross-site', 'origin': None}, id='cross-site-no-origin'),
])
def test_forbidden_requests_never_call_adapter(client, adapter, method, changes):
    headers = {key: value for key, value in {**HEADERS, **changes}.items() if value is not None}
    # A malformed POST also verifies origin/header checks precede body validation.
    response = client.request(method, URL, headers=headers, content=b'not-json')
    assert_error_response(response, 'forbidden_origin', 403)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('site', ['same-origin', 'same-site', 'none'])
def test_non_cross_site_fetch_metadata_is_allowed(client, adapter, site):
    response = client.post(URL, headers={**HEADERS, 'sec-fetch-site': site}, json=command())
    assert response.status_code == 200
    adapter.run.assert_awaited_once_with(['status', DEVICE])


@pytest.mark.parametrize('content_type', [None, '', 'text/plain', 'text/json',
                                         'application/x-www-form-urlencoded',
                                         'multipart/form-data; boundary=test',
                                         'application/json-patch+json'])
def test_control_requires_json_content_type(client, adapter, content_type):
    headers = dict(HEADERS)
    if content_type is not None:
        headers['content-type'] = content_type
    response = client.post(URL, headers=headers, content=json.dumps(command()).encode())
    assert_error_response(response, 'invalid_input', 422)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('content_type', ['application/json', 'application/json; charset=utf-8'])
def test_json_content_type_accepts_parameters(client, adapter, content_type):
    response = client.post(URL, headers={**HEADERS, 'content-type': content_type},
                           content=json.dumps(command()).encode())
    assert response.status_code == 200
    adapter.run.assert_awaited_once_with(['status', DEVICE])


@pytest.mark.parametrize('body', [b'', b'{', b'{} garbage', b'[]', b'null', b'1',
                                 b'"status"', b'true', b'\xff', b'{"action": NaN}'])
def test_malformed_json_and_nonobjects_are_controlled(client, adapter, body):
    response = client.post(URL, headers={**HEADERS, 'content-type': 'application/json'}, content=body)
    assert_error_response(response, 'invalid_input', 422)
    adapter.run.assert_not_awaited()


@pytest.mark.parametrize('size', [8192, 8193])
def test_control_body_size_boundary(client, adapter, size):
    body = json.dumps(command()).encode().ljust(size, b' ')
    response = client.post(URL, headers={**HEADERS, 'content-type': 'application/json'}, content=body)
    if size == 8192:
        assert response.status_code == 200
        adapter.run.assert_awaited_once_with(['status', DEVICE])
    else:
        assert_error_response(response, 'invalid_input', 422)
        adapter.run.assert_not_awaited()


@pytest.mark.parametrize('size', [8192, 8193])
@pytest.mark.parametrize('claimed_length', [None, '1'])
def test_chunked_body_limit_counts_bytes_not_content_length(adapter, size, claimed_length):
    async def scenario():
        body = json.dumps(command()).encode().ljust(size, b' ')
        consumed = []

        async def chunks():
            for part in (body[:4096], body[4096:8192], body[8192:]):
                if part:
                    consumed.append(len(part))
                    yield part
            if size > 8192:
                pytest.fail('Oversized request must stop consuming the stream immediately')

        headers = {**HEADERS, 'content-type': 'application/json'}
        if claimed_length is not None:
            headers['content-length'] = claimed_length
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_for(adapter)),
                                     base_url='http://testserver') as client:
            response = await client.post(URL, headers=headers, content=chunks())
        assert sum(consumed) == size
        if size == 8192:
            assert response.status_code == 200
            adapter.run.assert_awaited_once_with(['status', DEVICE])
        else:
            assert_error_response(response, 'invalid_input', 422)
            adapter.run.assert_not_awaited()
    run(scenario())


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('code,status', [
    ('sdk_missing', 503), ('sdk_timeout', 503), ('sdk_failed', 503),
    ('device_not_found', 404), ('invalid_input', 422), ('busy', 409),
])
def test_router_reports_adapter_errors(client, adapter, method, code, status):
    adapter.run.side_effect = link2.CameraError(code, status)
    response = client.request(method, URL, headers=HEADERS, json=command())
    assert_error_response(response, code, status)
    adapter.run.assert_awaited_once_with(['list'] if method == 'GET' else ['status', DEVICE])


@pytest.mark.parametrize('arguments', [
    ['list'], ['status', DEVICE], ['ptz', DEVICE, '-145', '90'],
    ['zoom', DEVICE, '65535'], ['autofocus', DEVICE, '0'],
])
@pytest.mark.parametrize('windows_flag', [None, 0x08000000], ids=['portable', 'windows'])
def test_subprocess_argv_working_directory_and_timeout_are_safe(
        bridge, no_real_subprocess, monkeypatch, arguments, windows_flag):
    if windows_flag is None:
        monkeypatch.delattr(link2.subprocess, 'CREATE_NO_WINDOW', raising=False)
    else:
        monkeypatch.setattr(link2.subprocess, 'CREATE_NO_WINDOW', windows_flag, raising=False)
    original = list(arguments)
    assert bridge._execute(arguments) == {'devices': []}
    bridge.path.is_file.assert_called_once_with()
    no_real_subprocess.assert_called_once_with(
        [str(bridge.path), *arguments], cwd=bridge.path.parent,
        capture_output=True, timeout=8, creationflags=windows_flag or 0)
    assert arguments == original
    # Exact kwargs also rule out shell=True, text decoding, or inherited stdout/stderr.


def test_missing_bridge_does_not_spawn(bridge, no_real_subprocess):
    bridge.path.is_file.return_value = False
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['list'])
    assert_camera_error(error.value, 'sdk_missing', 503)
    no_real_subprocess.assert_not_called()


@pytest.mark.parametrize('failure,code', [
    (subprocess.TimeoutExpired('mock-bridge', 8, output=PRIVATE.encode()), 'sdk_timeout'),
    (FileNotFoundError(PRIVATE), 'sdk_failed'),
    (PermissionError(PRIVATE), 'sdk_failed'),
    (OSError(PRIVATE), 'sdk_failed'),
])
def test_subprocess_failures_are_translated(bridge, no_real_subprocess, failure, code):
    no_real_subprocess.side_effect = failure
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['list'])
    assert_camera_error(error.value, code, 503)
    assert error.value.__suppress_context__
    no_real_subprocess.assert_called_once()


@pytest.mark.parametrize('returncode', [1, -1, 3221225477])
def test_crash_with_valid_json_is_not_success(bridge, no_real_subprocess, returncode):
    no_real_subprocess.return_value = completed({'devices': []}, returncode=returncode)
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['list'])
    assert_camera_error(error.value, 'sdk_failed', 503)


@pytest.mark.parametrize('stdout', [
    framed({'devices': []}),
    framed({'devices': []}).rstrip(b'\n'),
    b'SDK log\r\n' + framed({'devices': []}).replace(b'\n', b'\r\n') + b'cleanup log\r\n',
    b'{"error":"sdk_failed"}\nlog: CITYLENS_JSON={}\n' + framed({'devices': []}),
    '日志输出\n'.encode() + framed({'devices': []}),
], ids=['frame', 'no-final-newline', 'crlf-and-logs', 'unframed-json-ignored', 'utf8-logs'])
def test_exact_framing_ignores_native_diagnostics(bridge, no_real_subprocess, stdout):
    no_real_subprocess.return_value = completed(stdout=stdout)
    assert bridge._execute(['list']) == {'devices': []}


@pytest.mark.parametrize('stdout', [
    b'', b'only diagnostics', b'{"devices": []}\n', b' CITYLENS_JSON={}\n',
    b'citylens_json={}\n', framed({}) + framed({}),
    b'CITYLENS_JSON={\n}\n', b'CITYLENS_JSON=\n', b'CITYLENS_JSON={} trailing\n',
    b'CITYLENS_JSON={bad}\n', framed([]), framed(None), framed('text'), framed(1),
    framed(True), b'CITYLENS_JSON=\xff\n', b'\xff\n' + framed({}),
], ids=['empty', 'logs-only', 'unframed', 'indented-prefix', 'wrong-prefix-case',
        'duplicate-records', 'multiline-record', 'empty-record', 'trailing-garbage',
        'invalid-json', 'array', 'null', 'string', 'number', 'boolean',
        'invalid-utf8-frame', 'invalid-utf8-log'])
def test_malformed_stdout_is_controlled(bridge, no_real_subprocess, stdout):
    no_real_subprocess.return_value = completed(stdout=stdout)
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['list'])
    assert_camera_error(error.value, 'sdk_failed', 503)


@pytest.mark.parametrize('size', [1024 * 1024, 1024 * 1024 + 1])
def test_stdout_size_boundary(bridge, no_real_subprocess, size):
    record = framed({'devices': []})
    stdout = b'x' * (size - len(record) - 1) + b'\n' + record
    assert len(stdout) == size
    no_real_subprocess.return_value = completed(stdout=stdout)
    if size == 1024 * 1024:
        assert bridge._execute(['list']) == {'devices': []}
    else:
        with pytest.raises(link2.CameraError) as error:
            bridge._execute(['list'])
        assert_camera_error(error.value, 'sdk_failed', 503)


@pytest.mark.parametrize('returncode', [0, 1])
@pytest.mark.parametrize('native_error,code,status', [
    ('device_not_found', 'device_not_found', 404),
    ('invalid_input', 'invalid_input', 422),
    ('sdk_missing', 'sdk_missing', 503),
    ('sdk_timeout', 'sdk_timeout', 503),
    ('sdk_failed', 'sdk_failed', 503),
    ('forbidden_origin', 'forbidden_origin', 503),
    ('busy', 'busy', 503),
    (PRIVATE, 'sdk_failed', 503),
    (None, 'sdk_failed', 503),
    (False, 'sdk_failed', 503),
    (42, 'sdk_failed', 503),
    (1.5, 'sdk_failed', 503),
])
def test_native_error_codes_and_unknown_scalars(
        bridge, no_real_subprocess, returncode, native_error, code, status):
    no_real_subprocess.return_value = completed(
        {'error': native_error, 'message': PRIVATE}, returncode=returncode)
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['status', DEVICE])
    assert_camera_error(error.value, code, status)


@pytest.mark.parametrize('native_error', [[], {}], ids=['array', 'object'])
def test_malformed_error_payload_is_a_controlled_camera_error(bridge, no_real_subprocess, native_error):
    no_real_subprocess.return_value = completed({'error': native_error})
    with pytest.raises(link2.CameraError) as error:
        bridge._execute(['list'])
    assert_camera_error(error.value, 'sdk_failed', 503)


@pytest.mark.parametrize('failure,code,status', [
    ('missing', 'sdk_missing', 503), ('timeout', 'sdk_timeout', 503),
    ('crash', 'sdk_failed', 503), ('malformed', 'sdk_failed', 503),
    ('malformed-error', 'sdk_failed', 503), ('disconnected', 'device_not_found', 404),
])
def test_router_with_real_bridge_and_mocked_subprocess(bridge, no_real_subprocess, failure, code, status):
    if failure == 'missing':
        bridge.path.is_file.return_value = False
    elif failure == 'timeout':
        no_real_subprocess.side_effect = subprocess.TimeoutExpired('mock-bridge', 8)
    elif failure == 'crash':
        no_real_subprocess.return_value = completed(returncode=1)
    elif failure == 'malformed':
        no_real_subprocess.return_value = completed(stdout=PRIVATE.encode())
    elif failure == 'malformed-error':
        no_real_subprocess.return_value = completed({'error': {'message': PRIVATE}})
    else:
        no_real_subprocess.return_value = completed({'error': 'device_not_found'})
    with TestClient(app_for(bridge), raise_server_exceptions=False) as client:
        response = client.get(URL, headers=HEADERS)
    assert_error_response(response, code, status)
    assert not bridge.lock.locked()


@pytest.mark.parametrize('failure', [link2.CameraError('sdk_timeout'), RuntimeError(PRIVATE)])
def test_run_releases_lock_after_worker_failure(bridge, no_real_subprocess, failure):
    async def scenario():
        no_real_subprocess.side_effect = failure
        with pytest.raises(type(failure)) as error:
            await bridge.run(['list'])
        assert error.value is failure
        assert not bridge.lock.locked()
        no_real_subprocess.side_effect = None
        assert await bridge.run(['status', DEVICE]) == {'devices': []}
        assert not bridge.lock.locked()
    run(scenario())


class BlockedSubprocess:
    """Event-driven worker probe; timeouts are deadlock guards, never synchronization."""

    def __init__(self, result, failure=None):
        self.loop = asyncio.get_running_loop()
        self.started = asyncio.Event()
        self.finished = asyncio.Event()
        self.release = threading.Event()
        self.result = result
        self.failure = failure
        self.worker_thread = None

    def __call__(self, *args, **kwargs):
        self.worker_thread = threading.get_ident()
        self.loop.call_soon_threadsafe(self.started.set)
        try:
            assert self.release.wait(5), 'Test did not release the mocked subprocess'
            if self.failure is not None:
                raise self.failure
            return self.result
        finally:
            self.loop.call_soon_threadsafe(self.finished.set)


async def checkpoint():
    # Let already-scheduled cancellation callbacks run without a timing-based sleep.
    loop = asyncio.get_running_loop()
    ready = loop.create_future()
    loop.call_soon(ready.set_result, None)
    await ready


def test_busy_calls_are_rejected_not_queued_and_worker_is_off_loop(bridge, no_real_subprocess):
    async def scenario():
        worker = BlockedSubprocess(completed({'devices': []}))
        no_real_subprocess.side_effect = worker
        first = asyncio.create_task(bridge.run(['list']))
        try:
            await asyncio.wait_for(worker.started.wait(), 2)
            assert worker.worker_thread != threading.get_ident()
            assert bridge.lock.locked()
            for arguments in (['list'], ['status', DEVICE], ['zoom', DEVICE, '1']):
                with pytest.raises(link2.CameraError) as error:
                    await bridge.run(arguments)
                assert_camera_error(error.value, 'busy', 409)
            no_real_subprocess.assert_called_once()
        finally:
            worker.release.set()
            results = await asyncio.gather(first, return_exceptions=True)
            await asyncio.wait_for(worker.finished.wait(), 2)
        assert results == [{'devices': []}]
        assert not bridge.lock.locked()
        no_real_subprocess.side_effect = None
        assert await bridge.run(['status', DEVICE]) == {'devices': []}
        assert no_real_subprocess.call_count == 2
        assert not bridge.lock.locked()
    run(scenario())


@pytest.mark.parametrize('cancellations', [1, 2], ids=['single-cancel', 'repeated-cancel'])
def test_cancellation_holds_lock_until_native_process_finishes(bridge, no_real_subprocess, cancellations):
    async def scenario():
        worker = BlockedSubprocess(completed({'devices': []}))
        no_real_subprocess.side_effect = worker
        first = asyncio.create_task(bridge.run(['list']))
        try:
            await asyncio.wait_for(worker.started.wait(), 2)
            for _ in range(cancellations):
                first.cancel()
                await checkpoint()
            assert not worker.finished.is_set()
            assert bridge.lock.locked(), 'Cancellation released the lock while native code was running'
            assert not first.done(), 'Cancellation must drain the native worker before completing'
            with pytest.raises(link2.CameraError) as error:
                await bridge.run(['status', DEVICE])
            assert_camera_error(error.value, 'busy', 409)
            no_real_subprocess.assert_called_once()
        finally:
            worker.release.set()
            results = await asyncio.gather(first, return_exceptions=True)
            await asyncio.wait_for(worker.finished.wait(), 2)
        assert isinstance(results[0], asyncio.CancelledError)
        assert not bridge.lock.locked()
        no_real_subprocess.side_effect = None
        assert await bridge.run(['status', DEVICE]) == {'devices': []}
        assert no_real_subprocess.call_count == 2
        assert not bridge.lock.locked()
    run(scenario())


def test_worker_failure_during_cancellation_preserves_cancelled_result(bridge, no_real_subprocess):
    async def scenario():
        worker = BlockedSubprocess(completed(), failure=OSError(PRIVATE))
        no_real_subprocess.side_effect = worker
        first = asyncio.create_task(bridge.run(['list']))
        try:
            await asyncio.wait_for(worker.started.wait(), 2)
            first.cancel()
            await checkpoint()
            assert bridge.lock.locked()
            assert not first.done()
        finally:
            worker.release.set()
            results = await asyncio.gather(first, return_exceptions=True)
            await asyncio.wait_for(worker.finished.wait(), 2)
        assert not bridge.lock.locked()
        assert isinstance(results[0], asyncio.CancelledError), 'Worker failure replaced request cancellation'
    run(scenario())

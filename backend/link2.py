"""Local Link 2 control via the official SDK's small Windows x64 bridge."""
import asyncio
import json
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

BRIDGE = Path(__file__).resolve().parents[1] / 'native/link2/build/Release/citylens-link2.exe'
MESSAGES = {
    'sdk_missing': 'Link 2 控制组件尚未安装，请运行 scripts/setup-link2.ps1。USB 画面仍可使用。',
    'sdk_failed': '相机控制失败，请检查 USB 连接，并关闭可能占用设备的 Link Controller。',
    'sdk_timeout': '相机响应超时，请检查连接后刷新。',
    'device_not_found': '所选 Link 2 已断开，请刷新设备列表。',
    'invalid_input': '相机参数不在支持范围内。',
    'forbidden_origin': '相机控制仅供本地 CityLens 页面使用。',
    'busy': '相机正在处理上一条指令，请稍后再试。',
}


class CameraError(Exception):
    def __init__(self, code, status=503):
        self.code, self.status = code, status


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    device_id: str = Field(min_length=2, max_length=4096, pattern=r'^(?:[0-9a-f]{2})+$')
    action: Literal['status', 'ptz', 'zoom', 'autofocus']
    pan: int | None = Field(default=None, ge=-145, le=145)
    tilt: int | None = Field(default=None, ge=-45, le=90)
    zoom: int | None = Field(default=None, ge=0, le=65535)
    enabled: bool | None = None

    def arguments(self):
        expected = {'status': set(), 'ptz': {'pan', 'tilt'}, 'zoom': {'zoom'}, 'autofocus': {'enabled'}}[self.action]
        if self.model_fields_set - {'device_id', 'action'} != expected or any(getattr(self, k) is None for k in expected):
            raise CameraError('invalid_input', 422)
        values = {'status': [], 'ptz': [self.pan, self.tilt], 'zoom': [self.zoom],
                  'autofocus': [int(self.enabled) if self.enabled is not None else None]}[self.action]
        return [self.action, self.device_id, *map(str, values)]


class Link2Bridge:
    def __init__(self, path=BRIDGE):
        self.path = path
        self.lock = asyncio.Lock()

    def _execute(self, arguments):
        if not self.path.is_file():
            raise CameraError('sdk_missing')
        try:
            result = subprocess.run([str(self.path), *arguments], cwd=self.path.parent, capture_output=True,
                                    timeout=8, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except subprocess.TimeoutExpired:
            raise CameraError('sdk_timeout') from None
        except OSError:
            raise CameraError('sdk_failed') from None
        try:
            if len(result.stdout) > 1024 * 1024:
                raise ValueError()
            lines = result.stdout.decode('utf-8').splitlines()
            records = [line.removeprefix('CITYLENS_JSON=') for line in lines if line.startswith('CITYLENS_JSON=')]
            if len(records) != 1:
                raise ValueError()
            data = json.loads(records[0])
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise CameraError('sdk_failed') from None
        if 'error' in data:
            code = data['error'] if isinstance(data['error'], str) and data['error'] in MESSAGES else 'sdk_failed'
            raise CameraError(code, 404 if code == 'device_not_found' else 422 if code == 'invalid_input' else 503)
        if result.returncode != 0:
            raise CameraError('sdk_failed')
        return data

    async def run(self, arguments):
        if self.lock.locked():
            raise CameraError('busy', 409)
        async with self.lock:
            # Cancelling HTTP must not release the lock while a native command still runs.
            task = asyncio.create_task(asyncio.to_thread(self._execute, arguments))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                while not task.done():
                    try:
                        await asyncio.shield(task)
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        break
                if not task.cancelled():
                    task.exception()
                raise


def camera_router(allowed_origins, bridge=None):
    router = APIRouter(prefix='/api/camera/link2')
    adapter = bridge or Link2Bridge()

    def check_request(request):
        # Non-simple header blocks drive-by forms/fetches; CORS is not enabled.
        if (request.headers.get('x-citylens-camera') != '1'
                or request.headers.get('origin') not in (None, *allowed_origins)
                or request.headers.get('sec-fetch-site') == 'cross-site'):
            raise CameraError('forbidden_origin', 403)

    def error_response(error):
        return JSONResponse({'status': 'error', 'code': error.code, 'message': MESSAGES[error.code]},
                            status_code=error.status, headers={'Cache-Control': 'no-store'})

    @router.get('')
    async def discover(request: Request):
        try:
            check_request(request)
            data = await adapter.run(['list'])
            return JSONResponse({'status': 'ready', **data}, headers={'Cache-Control': 'no-store'})
        except CameraError as error:
            return error_response(error)

    @router.post('')
    async def control(request: Request):
        try:
            check_request(request)
            if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                raise CameraError('invalid_input', 422)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 8192:
                    raise CameraError('invalid_input', 422)
            try:
                command = Command.model_validate_json(body)
            except ValidationError:
                raise CameraError('invalid_input', 422) from None
            data = await adapter.run(command.arguments())
            return JSONResponse({'status': 'ok', **data}, headers={'Cache-Control': 'no-store'})
        except CameraError as error:
            return error_response(error)

    return router

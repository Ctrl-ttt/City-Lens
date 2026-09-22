import asyncio
import base64
import binascii
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketState

from .models import AnalyzeInput, AnalyzeResponse, RealtimeFrame
from .realtime import MAX_FRAME_MESSAGE, realtime_session
from .rules import summarize
from .vision import Settings, VisionError, observe

ROOT = Path(__file__).resolve().parents[1]
MAX_IMAGE = 2 * 1024 * 1024
MAX_BODY = MAX_IMAGE + 65536
ALLOWED_ORIGINS = {'http://localhost:8000', 'http://127.0.0.1:8000', 'http://localhost:5173', 'http://127.0.0.1:5173'}
REALTIME_IDLE_TIMEOUT = 30
logger = logging.getLogger('citylens')
MESSAGES = {
    'not_configured': '尚未配置模型 API，请先完成后端配置。',
    'model_auth': '模型权限或密钥不可用，请检查后端配置。',
    'rate_limited': '模型请求过于频繁，请稍后恢复。',
    'model_unavailable': '模型服务暂不可用。',
    'model_timeout': '识别超时，请重新观察当前画面。',
    'network_error': '无法连接模型服务，请检查网络。',
    'invalid_model_output': '本次识别结果无法确认，请重新观察。',
    'invalid_input': '请输入有效的 JPEG 图片和请求参数。',
    'image_too_large': '图片不能超过 2 MB。',
    'busy': '上一帧仍在识别，请稍后再试。',
    'forbidden_origin': '此服务仅供本地页面使用。',
    'internal_error': '识别服务发生错误，请稍后重试。',
    'realtime_unavailable': '当前模式不提供实时连接，请使用 HTTP 抽帧。',
    'realtime_protocol': '实时模型未接受请求，请检查配置或切换 HTTP 抽帧。',
    'realtime_image_too_large': '实时帧过大，请降低画面分辨率后重试。',
    'realtime_expired': '实时会话已到期，需要重新连接。',
    'realtime_idle': '实时连接空闲，已停止云端会话。',
}


class MemoryParser(MultiPartParser):
    # Larger than the TOTAL accepted body: uploaded images never spool to disk.
    spool_max_size = MAX_BODY + 1


def load_settings():
    load_dotenv(ROOT / '.env', override=False)
    provider = os.getenv('CITYLENS_PROVIDER', 'live')
    if provider not in ('live', 'sample', 'realtime'):
        raise ValueError('CITYLENS_PROVIDER must be live, sample or realtime')
    return Settings(provider=provider, api_key=os.getenv('DASHSCOPE_API_KEY', '').strip(),
                    base_url=os.getenv('DASHSCOPE_BASE_URL', Settings.base_url).strip(),
                    model=os.getenv('DASHSCOPE_MODEL', Settings.model).strip(),
                    realtime_model=os.getenv('DASHSCOPE_REALTIME_MODEL', Settings.realtime_model).strip(),
                    realtime_url=os.getenv('DASHSCOPE_REALTIME_URL', '').strip(),
                    sample_scene=os.getenv('CITYLENS_SAMPLE_SCENE', 'bicycle'))


def clean_jpeg(data: bytes, max_side=2048, quality=85) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format != 'JPEG' or im.width * im.height > 12_000_000:
                raise ValueError('invalid image')
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            im.thumbnail((max_side, max_side))
            output = io.BytesIO()
            im.save(output, format='JPEG', quality=quality)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise VisionError('invalid_input') from None


def create_app(settings: Settings | None = None, transport=None):
    config = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=8, transport=transport, follow_redirects=False) as client:
            app.state.client = client
            app.state.lock = asyncio.Lock()
            app.state.realtime_lock = asyncio.Lock()
            yield

    app = FastAPI(title='CityLens', version='0.1.0', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', '[::1]', 'testserver'])
    app.state.settings = config

    @app.get('/api/health')
    async def health():
        return {'status': 'ok', 'provider': config.provider, 'configured': config.configured,
                'model': 'fixed-sample' if config.provider == 'sample' else config.realtime_model if config.provider == 'realtime' else config.model,
                'http_model': config.model, 'http_configured': config.http_configured,
                'realtime_model': config.realtime_model, 'realtime_configured': config.realtime_configured,
                'sample_scene': config.sample_scene if config.provider == 'sample' else None,
                'version': '0.1.0'}

    @app.websocket('/api/realtime')
    async def realtime(socket: WebSocket):
        if socket.headers.get('origin') not in ALLOWED_ORIGINS:
            await socket.close(code=1008)
            return
        await socket.accept()
        tasks = []
        try:
            if config.provider == 'sample':
                raise VisionError('realtime_unavailable')
            if not config.realtime_configured:
                raise VisionError('not_configured')
            if app.state.realtime_lock.locked():
                raise VisionError('busy')
            async with app.state.realtime_lock:
                frames = asyncio.Queue(maxsize=1)
                ready = False
                busy = False
                session_id = None
                frame_id = -1
                last_frame_at = 0.0

                async def receive_frames():
                    nonlocal busy, session_id, frame_id, last_frame_at
                    while True:
                        message = await socket.receive()
                        if message['type'] == 'websocket.disconnect':
                            raise WebSocketDisconnect()
                        text = message.get('text')
                        if text is None or len(text) > MAX_FRAME_MESSAGE:
                            raise VisionError('invalid_input')
                        frame = RealtimeFrame.model_validate_json(text)
                        if not ready or busy:
                            raise VisionError('busy')
                        if (session_id is not None and frame.session_id != session_id) or frame.frame_id <= frame_id:
                            raise VisionError('invalid_input')
                        now = time.monotonic()
                        if now - last_frame_at < 0.9:
                            raise VisionError('rate_limited')
                        session_id, frame_id, last_frame_at = frame.session_id, frame.frame_id, now
                        busy = True
                        frames.put_nowait(frame)

                async def process_frames():
                    nonlocal ready, busy
                    async with realtime_session(config) as session:
                        opened = time.monotonic()
                        ready = True
                        await socket.send_json({'type': 'ready'})
                        while True:
                            if time.monotonic() - opened > 110 * 60:
                                raise VisionError('realtime_expired')
                            try:
                                frame = await asyncio.wait_for(frames.get(), timeout=REALTIME_IDLE_TIMEOUT)
                            except TimeoutError:
                                raise VisionError('realtime_idle') from None
                            started = time.monotonic()
                            try:
                                image = clean_jpeg(base64.b64decode(frame.image, validate=True), max_side=960, quality=65)
                            except (binascii.Error, ValueError):
                                raise VisionError('invalid_input') from None
                            if app.state.lock.locked():
                                raise VisionError('busy')
                            async with app.state.lock:
                                result = await session.observe(image)
                            response = summarize(frame, result)
                            response.latency_ms = int((time.monotonic() - started) * 1000)
                            busy = False
                            await socket.send_json({'type': 'result', **response.model_dump()})
                            logger.info('realtime status=%s events=%s latency_ms=%s', response.status, len(response.events), response.latency_ms)

                tasks = [asyncio.create_task(receive_frames()), asyncio.create_task(process_frames())]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except WebSocketDisconnect:
            pass
        except (VisionError, ValidationError) as error:
            code = error.code if isinstance(error, VisionError) else 'invalid_input'
            if socket.client_state == WebSocketState.CONNECTED:
                await socket.send_json({'type': 'error', 'error_code': code, 'message': MESSAGES[code]})
        except Exception:
            logger.error('realtime error_code=internal_error')
            if socket.client_state == WebSocketState.CONNECTED:
                await socket.send_json({'type': 'error', 'error_code': 'internal_error', 'message': MESSAGES['internal_error']})
        finally:
            if socket.client_state == WebSocketState.CONNECTED and socket.application_state == WebSocketState.CONNECTED:
                await socket.close()

    @app.post('/api/analyze', response_model=AnalyzeResponse)
    async def analyze(request: Request):
        started = time.monotonic()
        meta = None
        def fail(code: str, http_status=200):
            response = AnalyzeResponse(session_id=meta.session_id if meta else '',
                frame_id=meta.frame_id if meta else 0, status='error', error_code=code,
                message=MESSAGES[code], latency_ms=int((time.monotonic()-started)*1000))
            return JSONResponse(response.model_dump(), status_code=http_status, headers={'Cache-Control':'no-store'})
        origin = request.headers.get('origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return fail('forbidden_origin', 403)
        total = 0
        async def bounded_stream():
            nonlocal total
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BODY:
                    raise MultiPartException('body too large')
                yield chunk
        form = None
        try:
            parser = MemoryParser(request.headers, bounded_stream(), max_files=1, max_fields=5, max_part_size=1024)
            form = await parser.parse()
            if set(form.keys()) != {'image', 'mode', 'source', 'session_id', 'frame_id'} or len(form.multi_items()) != 5:
                raise VisionError('invalid_input')
            meta = AnalyzeInput.model_validate({k: form[k] for k in ('mode','source','session_id','frame_id')})
            upload = form['image']
            if not isinstance(upload, UploadFile) or upload.content_type != 'image/jpeg':
                raise VisionError('invalid_input')
            data = await upload.read(MAX_IMAGE + 1)
            if len(data) > MAX_IMAGE:
                return fail('image_too_large', 413)
            image = clean_jpeg(data)
        except MultiPartException:
            return fail('image_too_large' if total > MAX_BODY else 'invalid_input', 413 if total > MAX_BODY else 422)
        except (ValidationError, VisionError, ValueError, KeyError):
            return fail('invalid_input', 422)
        finally:
            if form is not None:
                await form.close()
        if app.state.lock.locked():
            return fail('busy', 429)
        try:
            async with app.state.lock:
                result = await observe(image, meta.mode, config, app.state.client)
            response = summarize(meta, result)
            response.latency_ms = int((time.monotonic()-started)*1000)
            logger.info('analyze status=%s events=%s latency_ms=%s', response.status, len(response.events), response.latency_ms)
            return JSONResponse(response.model_dump(), headers={'Cache-Control':'no-store'})
        except VisionError as error:
            logger.warning('analyze error_code=%s', error.code)
            return fail(error.code)
        except Exception:
            # Never log provider bodies, frame bytes, OCR text, or credentials.
            logger.error('analyze error_code=internal_error')
            return fail('internal_error', 500)

    dist = ROOT / 'frontend' / 'dist'
    if dist.exists():
        app.mount('/assets', StaticFiles(directory=dist/'assets'), name='assets')

    @app.get('/', include_in_schema=False)
    async def index():
        if (dist/'index.html').exists():
            return FileResponse(dist/'index.html', headers={'Cache-Control':'no-store'})
        return JSONResponse({'message':'请先构建前端：pnpm --dir frontend build'}, status_code=503)
    return app


app = create_app()


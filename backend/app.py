import asyncio
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .models import AnalyzeInput, AnalyzeResponse
from .rules import summarize
from .vision import Settings, VisionError, observe

ROOT = Path(__file__).resolve().parents[1]
MAX_IMAGE = 2 * 1024 * 1024
MAX_BODY = MAX_IMAGE + 65536
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
}


class MemoryParser(MultiPartParser):
    # Larger than the TOTAL accepted body: uploaded images never spool to disk.
    spool_max_size = MAX_BODY + 1


def load_settings():
    load_dotenv(ROOT / '.env', override=False)
    provider = os.getenv('CITYLENS_PROVIDER', 'live')
    if provider not in ('live', 'sample'):
        raise ValueError('CITYLENS_PROVIDER must be live or sample')
    return Settings(provider=provider, api_key=os.getenv('DASHSCOPE_API_KEY', '').strip(),
                    base_url=os.getenv('DASHSCOPE_BASE_URL', Settings.base_url).strip(),
                    model=os.getenv('DASHSCOPE_MODEL', Settings.model).strip(),
                    sample_scene=os.getenv('CITYLENS_SAMPLE_SCENE', 'bicycle'))


def clean_jpeg(data: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format != 'JPEG' or im.width * im.height > 12_000_000:
                raise ValueError('invalid image')
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            im.thumbnail((2048, 2048))
            output = io.BytesIO()
            im.save(output, format='JPEG', quality=85)
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
            yield

    app = FastAPI(title='CityLens', version='0.1.0', lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', '[::1]', 'testserver'])
    app.state.settings = config

    @app.get('/api/health')
    async def health():
        return {'status': 'ok', 'provider': config.provider, 'configured': config.configured,
                'model': config.model if config.provider == 'live' else 'fixed-sample',
                'sample_scene': config.sample_scene if config.provider == 'sample' else None,
                'version': '0.1.0'}

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
        if origin and origin not in {'http://localhost:8000', 'http://127.0.0.1:8000', 'http://localhost:5173', 'http://127.0.0.1:5173'}:
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


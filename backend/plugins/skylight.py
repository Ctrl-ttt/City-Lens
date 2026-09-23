"""Skylight food recognition plugin.

The plugin is deliberately separate from the environment observation contract:
it is user-triggered, returns its own schema, and never adds food items to
CityLens navigation events or the realtime stream.
"""
import asyncio
import base64
import io
import json
import time
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from ..models import AnalyzeInput
from ..panorama import prepare_panorama
from ..vision import Settings, VisionError

MAX_IMAGE = 2 * 1024 * 1024
MAX_BODY = MAX_IMAGE + 65536
ALLOWED_ORIGINS = {
    'http://localhost:8000', 'http://127.0.0.1:8000',
    'http://localhost:5173', 'http://127.0.0.1:5173',
}

MESSAGES = {
    'disabled': 'Skylight 食材识别插件未启用。',
    'not_configured': '尚未配置食材识别模型 API，请先完成后端配置。',
    'model_auth': '食材识别模型权限或密钥不可用，请检查后端配置。',
    'rate_limited': '食材识别请求过于频繁，请稍后重试。',
    'model_unavailable': '食材识别模型暂不可用。',
    'model_timeout': '食材识别超时，请重新观察当前画面。',
    'network_error': '无法连接食材识别模型服务，请检查网络。',
    'invalid_model_output': '本次食材识别结果无法确认，请重新观察。',
    'invalid_input': '请输入有效的 JPEG 图片和请求参数。',
    'invalid_panorama': '全景输入需要已拼接的 2:1 全景图。',
    'image_too_large': '图片不能超过 2 MB。',
    'busy': '环境识别或上一轮食材识别仍在进行，请暂停后再试。',
    'forbidden_origin': '此服务仅供本地页面使用。',
    'internal_error': '食材识别服务发生错误，请稍后重试。',
}

PROMPT = '''你是 Skylight 食材助手，只识别画面中清晰可见的散装蔬菜、水果、鱼、肉或其他食材。
不要识别人物、包装文字、餐具或环境物体；不确定时宁可少报。不要把视觉推断写成食品安全结论，freshness 只能描述可见外观线索。
如果输入是带 FRONT 等顶栏的全景透视图，忽略顶栏文字。最多返回 6 种不同食材，不要重复同一种食材个体。
只输出严格 JSON，不要 Markdown：
{"items":[{"name":"中文名称","description":"一句话说明可见特征","confidence":0.0,"freshness_score":0,"freshness_label":"基于可见线索的新鲜度描述","selection_tip":"两到三条可执行的挑选建议，用中文句号分隔","warning":"需要用户进一步确认的风险或限制"}],"scene_note":"对画面整体的简短说明"}
confidence 为 0 到 1，freshness_score 为 0 到 100；无法判断时使用 0，并在 warning 说明。'''


class MemoryParser(MultiPartParser):
    # Larger than the accepted total body, so camera frames never spool to disk.
    spool_max_size = MAX_BODY + 1


class FoodItem(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(default='', max_length=180)
    confidence: float = Field(default=0, ge=0, le=1)
    freshness_score: int = Field(default=0, ge=0, le=100)
    freshness_label: str = Field(default='无法仅凭画面确认', max_length=80)
    selection_tip: str = Field(default='请靠近观察并结合气味、触感确认。', max_length=240)
    warning: str = Field(default='仅供视觉参考，不构成食品安全结论。', max_length=180)


class FoodResult(BaseModel):
    items: list[FoodItem] = Field(default_factory=list, max_length=6)
    scene_note: str = Field(default='', max_length=180)
    projection: str = 'rectilinear'
    latency_ms: int = 0


def _clean_jpeg(data: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'JPEG' or image.width * image.height > 12_000_000:
                raise ValueError
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((2048, 2048))
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=85)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise VisionError('invalid_input') from None


def _parse(content: str, projection: str, latency_ms: int) -> FoodResult:
    if not isinstance(content, str) or len(content) > 16000:
        raise VisionError('invalid_model_output')
    cleaned = content.strip()
    if cleaned.startswith('```') and cleaned.endswith('```'):
        cleaned = cleaned.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    try:
        value = json.loads(cleaned)
        if not isinstance(value, dict):
            raise ValueError
        items = value.get('items', [])
        if not isinstance(items, list):
            raise ValueError
        return FoodResult.model_validate({
            'items': items[:6],
            'scene_note': value.get('scene_note', ''),
            'projection': projection,
            'latency_ms': latency_ms,
        })
    except (ValueError, TypeError, ValidationError, json.JSONDecodeError):
        raise VisionError('invalid_model_output') from None


async def _observe(image: bytes, settings: Settings, client: httpx.AsyncClient,
                   projection: str, latency_ms: int) -> FoodResult:
    if settings.provider == 'sample':
        return FoodResult(items=[FoodItem(
            name='样例蔬菜', description='样例联调结果，不分析输入画面。', confidence=1,
            freshness_score=0, freshness_label='样例模式',
            selection_tip='切换到 live 模式后再依据真实画面挑选。',
            warning='当前为固定样例，不能作为真实识别结果。')],
            scene_note='Skylight 插件样例模式。', projection=projection, latency_ms=latency_ms)
    if not settings.skylight_configured:
        raise VisionError('not_configured')
    payload = {
        'model': settings.skylight_model or settings.model,
        'messages': [
            {'role': 'system', 'content': PROMPT},
            {'role': 'user', 'content': [
                {'type': 'text', 'text': '请识别这张画面中的食材，并按要求返回 JSON。'},
                {'type': 'image_url', 'image_url': {
                    'url': 'data:image/jpeg;base64,' + base64.b64encode(image).decode('ascii')}}
            ]},
        ],
        'stream': False,
        'max_tokens': 1600,
    }
    started = time.monotonic()
    try:
        async with asyncio.timeout(settings.skylight_timeout):
            response = await client.post(
                settings.base_url.rstrip('/') + '/chat/completions',
                headers={'Authorization': f'Bearer {settings.api_key}'}, json=payload,
                timeout=settings.skylight_timeout)
        if response.status_code in (401, 403):
            raise VisionError('model_auth')
        if response.status_code == 429:
            raise VisionError('rate_limited')
        if response.is_error:
            raise VisionError('model_unavailable')
        content = response.json()['choices'][0]['message']['content']
        return _parse(content, projection, int((time.monotonic() - started) * 1000))
    except (TimeoutError, httpx.TimeoutException):
        raise VisionError('model_timeout') from None
    except httpx.RequestError:
        raise VisionError('network_error') from None
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        raise VisionError('invalid_model_output') from None


router = APIRouter(prefix='/api/plugins/skylight', tags=['plugins'])


@router.post('/analyze')
async def analyze_skylight(request: Request):
    origin = request.headers.get('origin')
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({'error_code': 'forbidden_origin', 'message': MESSAGES['forbidden_origin']}, status_code=403)
    started = time.monotonic()
    form = None
    try:
        settings: Settings = request.app.state.settings
        if not settings.skylight_enabled:
            raise VisionError('disabled')
        total = 0
        async def bounded_stream():
            nonlocal total
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BODY:
                    raise MultiPartException('body too large')
                yield chunk
        parser = MemoryParser(request.headers, bounded_stream(), max_files=1, max_fields=4, max_part_size=1024)
        form = await parser.parse()
        allowed = {'image', 'projection', 'heading_deg', 'source'}
        if 'image' not in form or not set(form.keys()) <= allowed or len(form.multi_items()) != len(form.keys()):
            raise VisionError('invalid_input')
        image = form['image']
        if not isinstance(image, UploadFile) or image.content_type != 'image/jpeg':
            raise VisionError('invalid_input')
        projection = str(form.get('projection', 'rectilinear'))
        source = str(form.get('source', 'camera'))
        try:
            heading_deg = int(str(form.get('heading_deg', '0')))
        except ValueError:
            raise VisionError('invalid_input') from None
        if projection not in ('rectilinear', 'equirectangular') or source not in ('camera', 'video'):
            raise VisionError('invalid_input')
        if not -180 <= heading_deg <= 180:
            raise VisionError('invalid_input')
        data = await image.read(MAX_IMAGE + 1)
        if len(data) > MAX_IMAGE:
            raise VisionError('image_too_large')
        data = _clean_jpeg(data)
        if request.app.state.lock.locked():
            raise VisionError('busy')
        async with request.app.state.lock:
            if projection == 'equirectangular':
                meta = AnalyzeInput(session_id='skylight', frame_id=0, mode='walk', source=source,
                                    projection='equirectangular', heading_deg=heading_deg)
                data = await asyncio.to_thread(prepare_panorama, data, meta)
            result = await _observe(data, settings, request.app.state.client, projection,
                                    int((time.monotonic() - started) * 1000))
        return JSONResponse(result.model_dump(), headers={'Cache-Control': 'no-store'})
    except MultiPartException:
        code = 'image_too_large' if 'total' in locals() and total > MAX_BODY else 'invalid_input'
        return JSONResponse({'error_code': code, 'message': MESSAGES[code]},
                            status_code=413 if code == 'image_too_large' else 422,
                            headers={'Cache-Control': 'no-store'})
    except VisionError as error:
        code = error.code if error.code in MESSAGES else 'internal_error'
        status = 413 if code == 'image_too_large' else 422 if code in ('invalid_input', 'invalid_panorama') else 200
        return JSONResponse({'error_code': code, 'message': MESSAGES[code], 'latency_ms': int((time.monotonic() - started) * 1000)},
                            status_code=status, headers={'Cache-Control': 'no-store'})
    except Exception:
        return JSONResponse({'error_code': 'internal_error', 'message': MESSAGES['internal_error']}, status_code=500,
                            headers={'Cache-Control': 'no-store'})
    finally:
        if form is not None:
            await form.close()

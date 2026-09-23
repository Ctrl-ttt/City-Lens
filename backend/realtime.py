import asyncio
import base64
import json
from contextlib import asynccontextmanager
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .vision import SYSTEM_PROMPT, WALK_INSTRUCTION, Settings, VisionError, parse_result

MAX_ENCODED_IMAGE = 256 * 1024
MAX_FRAME_MESSAGE = MAX_ENCODED_IMAGE + 2048
SILENCE = base64.b64encode(bytes(6400)).decode('ascii')
FRAME_AUDIO = base64.b64encode(bytes(32000)).decode('ascii')
INSTRUCTIONS = SYSTEM_PROMPT + '\n' + WALK_INSTRUCTION + '仅报告本轮最新图像中仍可确认的事实，不沿用更早图像或历史回复中的标牌和障碍。输入音频为合成静音，不是用户说话。'


class DirectConnect(connect):
    def process_redirect(self, exc):
        # Never forward the Authorization header to a redirected host.
        return exc


def provider_error(code):
    normalized = str(code).lower()
    if normalized in ('invalid_api_key', 'invalidapikey', 'unauthorized', 'permission_denied', 'access_denied'):
        return 'model_auth'
    if normalized in ('rate_limit_exceeded', 'rate_limit', 'throttling', 'too_many_requests'):
        return 'rate_limited'
    return 'realtime_protocol'


class RealtimeVision:
    def __init__(self, socket, settings: Settings):
        self.socket = socket
        self.settings = settings

    async def send(self, kind, **fields):
        await self.socket.send(json.dumps({'type': kind, **fields}))

    async def receive(self):
        try:
            event = json.loads(await self.socket.recv())
            if not isinstance(event, dict) or not isinstance(event.get('type'), str):
                raise ValueError()
            if event['type'] == 'error':
                raise VisionError(provider_error(event.get('error', {}).get('code')))
            return event
        except (ValueError, TypeError, AttributeError):
            raise VisionError('invalid_model_output') from None

    async def initialize(self):
        async with asyncio.timeout(self.settings.timeout):
            await self.send('session.update', session={
                # VAD discards silent PCM; manual input must stop during generation.
                'modalities': ['text'], 'turn_detection': None,
                'instructions': INSTRUCTIONS, 'input_audio_format': 'pcm16',
                'max_response_output_tokens': 1200,
            })
            while (await self.receive())['type'] != 'session.updated':
                pass

    async def observe(self, image: bytes):
        encoded = base64.b64encode(image).decode('ascii')
        if len(encoded) > MAX_ENCODED_IMAGE:
            raise VisionError('realtime_image_too_large')
        async with asyncio.timeout(self.settings.timeout):
            await self.send('input_audio_buffer.append', audio=SILENCE)
            await self.send('input_image_buffer.append', image=encoded)
            await self.send('input_audio_buffer.append', audio=FRAME_AUDIO)
            await self.send('input_audio_buffer.commit')
            await self.send('response.create')
            text = ''
            response_id = None
            items = set()
            while True:
                event = await self.receive()
                kind = event['type']
                if kind == 'conversation.item.created':
                    items.add(event['item']['id'])
                elif kind == 'response.created':
                    response_id = event['response']['id']
                elif kind in ('response.text.delta', 'response.text.done'):
                    if response_id is None or event.get('response_id') != response_id:
                        raise VisionError('invalid_model_output')
                    text = text + event['delta'] if kind.endswith('.delta') else event['text']
                    if not isinstance(text, str) or len(text) > 12000:
                        raise VisionError('invalid_model_output')
                elif kind == 'response.done':
                    response = event['response']
                    if response_id is None or response.get('id') != response_id or response.get('status') != 'completed':
                        raise VisionError('invalid_model_output')
                    final_text = ''
                    for item in response['output']:
                        items.add(item['id'])
                        for part in item['content']:
                            if part['type'] != 'text':
                                raise VisionError('invalid_model_output')
                            final_text += part['text']
                    if final_text != text:
                        raise VisionError('invalid_model_output')
                    result = parse_result(final_text)
                    if result.model_fields_set != {'uncertain', 'events'}:
                        raise VisionError('invalid_model_output')
                    break
            for item_id in items:
                await self.send('conversation.item.delete', item_id=item_id)
            while items:
                event = await self.receive()
                if event['type'] == 'conversation.item.deleted':
                    items.discard(event['item_id'])
            return result


@asynccontextmanager
async def realtime_session(settings: Settings):
    if not settings.realtime_configured:
        raise VisionError('not_configured')
    try:
        async with DirectConnect(
            settings.realtime_endpoint + '?' + urlencode({'model': settings.realtime_model}),
            additional_headers={'Authorization': f'Bearer {settings.api_key}'},
            open_timeout=settings.timeout, close_timeout=1, max_size=MAX_FRAME_MESSAGE,
            max_queue=4, ping_interval=20, ping_timeout=10,
        ) as socket:
            session = RealtimeVision(socket, settings)
            await session.initialize()
            yield session
    except InvalidStatus as error:
        status = error.response.status_code
        raise VisionError('model_auth' if status in (401, 403) else 'rate_limited' if status == 429 else 'model_unavailable') from None
    except TimeoutError:
        raise VisionError('model_timeout') from None
    except (ConnectionClosed, InvalidHandshake, OSError):
        raise VisionError('network_error') from None
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        raise VisionError('invalid_model_output') from None

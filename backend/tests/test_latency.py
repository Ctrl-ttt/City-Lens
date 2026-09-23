import asyncio
import io
import json

import httpx
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.vision import Settings, observe


def test_stage_metrics_attribute_provider_delay_and_do_not_expose_input():
    async def provider(request):
        await asyncio.sleep(.08)
        return httpx.Response(200, json={'choices': [{'message': {'content': '{"events":[]}'}}]})
    image = io.BytesIO()
    Image.new('RGB', (32, 24)).save(image, 'JPEG')
    with TestClient(create_app(Settings(api_key='secret-test'), httpx.MockTransport(provider))) as client:
        response = client.post('/api/analyze', files={'image': ('frame.jpg', image.getvalue(), 'image/jpeg')},
            data={'session_id': 'test', 'frame_id': '1', 'source': 'camera', 'mode': 'walk'})
        data = response.json()
        assert data['status'] == 'ok'
        assert data['timing']['model_ms'] >= 65
        assert 0 <= data['timing']['prepare_ms'] <= data['latency_ms']
        assert abs(sum(data['timing'].values()) - data['latency_ms']) <= 4
        assert 'secret-test' not in response.text and 'base64' not in response.text


def test_qwen_non_thinking_is_scoped_to_supported_models_and_read_budget_is_preserved():
    async def run():
        payloads = []
        def provider(request):
            payloads.append(json.loads(request.content))
            return httpx.Response(200, json={'choices': [{'message': {'content': '{"events":[]}'}}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            config = Settings(api_key='test', model='qwen3-vl-plus', read_model='custom-reader')
            await observe(b'test', 'walk', config, client)
            await observe(b'test', 'read', config, client)
        assert payloads[0]['enable_thinking'] is False
        assert 'enable_thinking' not in payloads[1]
        assert payloads[1]['model'] == 'custom-reader'
        assert payloads[1]['max_tokens'] == 1200
        assert payloads[0]['max_tokens'] == 1200
    asyncio.run(run())

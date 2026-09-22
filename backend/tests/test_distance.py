import io
import json
import math

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.distance import estimate_distance_m, filter_near_events
from backend.models import Observation
from backend.vision import Settings

IMG_W, IMG_H = 1280, 720
HFOV = 75.0
# focal = 1280 / (2 * tan(37.5°)) ≈ 833.9 px
SETTINGS = Settings(max_distance_m=5.0, camera_hfov_deg=HFOV)


def observe(label, box, category='obstacle', direction='front', text='', clarity=None):
    data = {'category': category, 'label': label, 'direction': direction, 'text': text, 'box': box}
    if clarity is not None:
        data['clarity'] = clarity
    return Observation.model_validate(data)


def box_for_distance(label, distance_m, img_w=IMG_W, img_h=IMG_H, y1=100):
    # 由期望距离反推归一化框高，验证过滤行为本身而不是重复公式。
    height_m = {'bicycle': 1.0, 'stairs': 1.2, 'sign': 0.6}[label]
    focal_px = img_w / (2 * math.tan(math.radians(HFOV) / 2))
    norm_h = round(height_m * focal_px / distance_m / img_h * 1000)
    return [100, y1, 300, y1 + norm_h]


def test_estimate_distance_matches_pinhole_model():
    event = observe('bicycle', box_for_distance('bicycle', 4.0))
    assert estimate_distance_m(event, IMG_W, IMG_H, HFOV) == pytest.approx(4.0, rel=0.01)


def test_near_event_kept_far_event_dropped():
    near = observe('bicycle', box_for_distance('bicycle', 4.0))
    far = observe('stairs', box_for_distance('stairs', 11.0))
    kept, dropped = filter_near_events([near, far], IMG_W, IMG_H, SETTINGS)
    assert kept == [near]
    assert dropped == 1


def test_all_far_events_leave_empty_list():
    far1 = observe('bicycle', box_for_distance('bicycle', 20.0))
    far2 = observe('stairs', box_for_distance('stairs', 30.0))
    kept, dropped = filter_near_events([far1, far2], IMG_W, IMG_H, SETTINGS)
    assert kept == []
    assert dropped == 2


def test_boxless_event_is_kept_because_distance_cannot_be_judged():
    event = observe('obstacle', None)
    kept, dropped = filter_near_events([event], IMG_W, IMG_H, SETTINGS)
    assert kept == [event]
    assert dropped == 0


def test_crosswalk_is_ground_plane_and_always_kept():
    tiny_box = [100, 100, 300, 110]  # 若套用高度公式会被判为极远
    event = observe('crosswalk', tiny_box, category='facility')
    kept, dropped = filter_near_events([event], IMG_W, IMG_H, SETTINGS)
    assert kept == [event]
    assert dropped == 0


def test_degenerate_box_is_kept_because_distance_cannot_be_judged():
    event = observe('bicycle', [100, 200, 300, 200])
    assert estimate_distance_m(event, IMG_W, IMG_H, HFOV) is None
    kept, _ = filter_near_events([event], IMG_W, IMG_H, SETTINGS)
    assert kept == [event]


def test_sign_text_events_are_filtered_like_obstacles():
    near = observe('sign', box_for_distance('sign', 3.0), category='text', text='近处路牌', clarity='high')
    far = observe('sign', box_for_distance('sign', 15.0), category='text', text='远处路牌', clarity='high')
    kept, dropped = filter_near_events([near, far], IMG_W, IMG_H, SETTINGS)
    assert kept == [near]
    assert dropped == 1


def test_filter_disabled_when_max_distance_not_positive():
    far = observe('bicycle', box_for_distance('bicycle', 30.0))
    kept, dropped = filter_near_events([far], IMG_W, IMG_H, Settings(max_distance_m=0.0))
    assert kept == [far]
    assert dropped == 0


def test_normalized_box_is_resolution_invariant():
    # 归一化坐标下同一框在不同分辨率图像中应得到相同距离。
    box = box_for_distance('bicycle', 4.0)
    event = observe('bicycle', box)
    low = estimate_distance_m(event, IMG_W, IMG_H, HFOV)
    high = estimate_distance_m(event, IMG_W * 2, IMG_H * 2, HFOV)
    assert low == pytest.approx(4.0, rel=0.01)
    assert high == pytest.approx(low, rel=0.01)


def test_invalid_fov_yields_no_estimate_and_keeps_event():
    event = observe('bicycle', [100, 100, 300, 400])
    assert estimate_distance_m(event, IMG_W, IMG_H, 0) is None
    assert estimate_distance_m(event, IMG_W, IMG_H, 180) is None


def test_http_channel_drops_far_events_before_rules():
    content = {'events': [
        {'category': 'obstacle', 'label': 'bicycle', 'direction': 'left', 'text': '',
         'box': box_for_distance('bicycle', 30.0)},   # 小图下必然超 5m
        {'category': 'obstacle', 'label': 'stairs', 'direction': 'front', 'text': '',
         'box': [0, 0, 20, 220]},                      # 小图下约 4.7m，保留
    ]}
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, json={'choices': [{'message': {'content': json.dumps(content)}}]}))
    with TestClient(create_app(Settings(api_key='test-only'), transport)) as client:
        output = io.BytesIO()
        Image.new('RGB', (32, 24), 'white').save(output, format='JPEG')
        response = client.post('/api/analyze', data=dict(mode='walk', source='video',
                                    session_id='s', frame_id='1'), files={'image': ('f.jpg', output.getvalue(), 'image/jpeg')})
    result = response.json()
    assert [e['label'] for e in result['events']] == ['stairs']
    assert result['speech']['text'] == '前方发现楼梯'

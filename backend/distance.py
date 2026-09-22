import math

from .models import Observation
from .vision import Settings

# 各类别主体的粗略标称实际高度（米），用于针孔模型的视尺寸距离估算。
# 估算误差可达数倍：真实尺寸分布宽、框本身有误差、变焦会改变等效焦距。
TYPICAL_HEIGHT_M = {
    'person': 1.65,
    'car': 1.5,
    'motorcycle': 1.1,
    'step': 0.15,
    'stairs': 1.2,
    'bicycle': 1.0,
    'barrier': 1.5,
    'bollard': 0.9,
    'obstacle': 0.8,
    'elevator': 2.2,
    'escalator': 1.6,
    'entrance': 2.2,
    'bus_stop': 2.6,
    'sign': 0.6,
}
# 斑马线在地面，框高对应透视纵深而非物理高度，视尺寸公式不适用，一律保留。


def estimate_distance_m(event: Observation, img_w: int, img_h: int, hfov_deg: float) -> float | None:
    """由归一化框高按针孔模型反推距离；无法判断时返回 None。"""
    if event.box is None or event.label not in TYPICAL_HEIGHT_M:
        return None
    _x1, y1, _x2, y2 = event.box
    box_h_px = (y2 - y1) / 1000 * img_h
    if box_h_px <= 0 or img_w <= 0 or img_h <= 0 or hfov_deg <= 0 or hfov_deg >= 170:
        return None
    focal_px = img_w / (2 * math.tan(math.radians(hfov_deg) / 2))
    return TYPICAL_HEIGHT_M[event.label] * focal_px / box_h_px


def estimate_person_width_m(event: Observation, hfov_deg: float) -> float | None:
    """Fallback for vertically clipped people with fully visible horizontal extent.

    0.5 m is a nominal body-width assumption, not measured anthropometry or depth.
    Pose and clothing can make it wrong; use only coarse ranking, never spoken metres.
    """
    if event.label != 'person' or not event.box or not 0 < hfov_deg < 170:
        return None
    x1, _y1, x2, _y2 = event.box
    if x1 <= 5 or x2 >= 995 or x2 <= x1:
        return None
    return 0.5 / (2 * math.tan(math.radians(hfov_deg)/2) * ((x2-x1)/1000))


def filter_near_events(events: list[Observation], img_w: int, img_h: int, settings: Settings):
    """丢弃估算距离超过阈值的事件；返回 (保留列表, 丢弃数)。max_distance_m<=0 时不过滤。"""
    if settings.max_distance_m <= 0:
        return list(events), 0
    kept: list[Observation] = []
    dropped = 0
    for event in events:
        distance = estimate_distance_m(event, img_w, img_h, settings.camera_hfov_deg)
        if distance is None or distance <= settings.max_distance_m:
            kept.append(event)
        else:
            dropped += 1
    return kept, dropped

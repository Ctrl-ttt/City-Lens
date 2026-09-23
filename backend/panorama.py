"""Explicit ERP input -> six perspective faces, one cloud request.

Uses py360convert (MIT); no raw fisheye stitching or camera calibration is implied.
The heading is relative to the panorama, not a measured user heading.
"""
import io
import math

import numpy as np
import py360convert
from PIL import Image, ImageDraw

from .models import AnalyzeInput, Observation
from .vision import VisionError

FACE_SIZE = 384
HEADER = 24
FACES = {'front': (0, 0), 'left': (-90, 0), 'right': (90, 0),
         'back': (180, 0), 'up': (0, 90), 'down': (0, -90)}
PANORAMA_INSTRUCTION = '''输入是程序生成的六宫格透视图，不是普通照片。上排依次 front,left,right；下排 back,up,down。
每个格子顶部英文是程序标签，不是场景标牌。只输出label和box；标牌另有text和clarity。不要输出direction、view或category，方向由代码计算。
box必须相对整张输入图归一化到0-1000，不能相对单格；框住一个格子内的目标主体，不可跨格子。无法准确给框的目标不要输出。
同一物体跨格子只保留主体最完整的一项；不要把摄像机支架、拍摄者手臂身体当作路上障碍。
全景展开图左右下角或 DOWN 面中固定随镜头出现的人体是拍摄者本人，必须忽略，不输出 person；前后左右面中的独立路人才正常输出。
观察前、侧、后和上方实际物体，不把天空、普通天花板或远处屋顶误认为悬空障碍。
不推测运动、接近或距离，后端根据连续帧计算。最多6项，其中标牌最多1项。'''


def normalize_atlas_events(events: list, mode: str) -> list:
    """Model grounds in the whole atlas; code alone assigns the face and local box."""
    names = ['front'] if mode == 'read' else list(FACES)
    size = 768 if mode == 'read' else FACE_SIZE
    width = size if mode == 'read' else size*3
    height = size+HEADER if mode == 'read' else (size+HEADER)*2
    grounded = []
    for event in events:
        if not isinstance(event, dict):
            raise VisionError('invalid_model_output')
        box = event.get('box')
        if not isinstance(box,list) or len(box)!=4 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in box):
            continue
        if not (0 <= box[0] < box[2] <= 1000 and 0 <= box[1] < box[3] <= 1000):
            continue
        x1,y1,x2,y2 = box[0]*width/1000,box[1]*height/1000,box[2]*width/1000,box[3]*height/1000
        col = min(2,int((x1+x2)/2/size)) if mode=='walk' else 0
        row = min(1,int((y1+y2)/2/(size+HEADER))) if mode=='walk' else 0
        left,top = col*size,row*(size+HEADER)+HEADER
        clipped = [max(x1,left),max(y1,top),min(x2,left+size),min(y2,top+size)]
        if ((clipped[2]-clipped[0])*(clipped[3]-clipped[1]) < (x2-x1)*(y2-y1)*0.85
                or not top <= (y1+y2)/2 <= top+size):
            continue
        event['view'] = names[row*3+col]
        event['direction'] = 'unknown'
        event['box'] = [round((clipped[0]-left)/size*1000),round((clipped[1]-top)/size*1000),
                        round((clipped[2]-left)/size*1000),round((clipped[3]-top)/size*1000)]
        grounded.append(event)
    return grounded


def prepare_panorama(data: bytes, meta: AnalyzeInput) -> bytes:
    with Image.open(io.BytesIO(data)) as image:
        if abs(image.width / image.height - 2) > 0.04 or image.width < 640:
            raise VisionError('invalid_panorama')
        pixels = np.asarray(image.convert('RGB'))
    faces = ['front'] if meta.mode == 'read' else list(FACES)
    size = 768 if meta.mode == 'read' else FACE_SIZE
    atlas = Image.new('RGB', (size * (1 if len(faces) == 1 else 3),
                             (size + HEADER) * (1 if len(faces) == 1 else 2)))
    draw = ImageDraw.Draw(atlas)
    for i, name in enumerate(faces):
        yaw, pitch = FACES[name]
        yaw = (yaw + meta.heading_deg + 180) % 360 - 180
        # The library caches the sampling grid; subsequent frames only resample.
        face = py360convert.e2p(pixels, 90, yaw, pitch, (size, size), mode='bilinear')
        x, y = (i % 3) * size, (i // 3) * (size + HEADER)
        atlas.paste(Image.fromarray(face), (x, y + HEADER))
        draw.text((x + 8, y + 5), name.upper(), fill='white')
    out = io.BytesIO()
    atlas.save(out, format='JPEG', quality=80)
    return out.getvalue()


def face_ray(view: str, x: float, y: float) -> np.ndarray:
    """Unit ray for a 90-degree face; x/y use local 0..1000 coordinates."""
    yaw, pitch = map(math.radians, FACES[view])
    # Forward/right/up basis: positive yaw is to the right; positive pitch is up.
    forward = np.array([math.sin(yaw)*math.cos(pitch), math.sin(pitch), math.cos(yaw)*math.cos(pitch)])
    right = np.array([math.cos(yaw), 0, -math.sin(yaw)])
    up = np.cross(forward, right)
    ray = forward + (x / 500 - 1) * right + (1 - y / 500) * up
    return ray / np.linalg.norm(ray)


def angular_span(event: Observation, axis: int) -> float | None:
    """Angular box extent, comparable across horizontal faces (not metric size)."""
    if event.view not in FACES or not event.box:
        return None
    x1, y1, x2, y2 = event.box
    if axis == 0:
        a = face_ray(event.view, x1, (y1 + y2) / 2)
        b = face_ray(event.view, x2, (y1 + y2) / 2)
    else:
        a = face_ray(event.view, (x1 + x2) / 2, y1)
        b = face_ray(event.view, (x1 + x2) / 2, y2)
    return math.acos(float(np.clip(np.dot(a, b), -1, 1)))


def bearing(event: Observation) -> tuple[float, float] | None:
    """Map a perspective face's local center to panorama-relative yaw/pitch."""
    if event.view not in FACES:
        return None
    x, y = ((event.box[0] + event.box[2]) / 2, (event.box[1] + event.box[3]) / 2) if event.box else (500, 500)
    ray = face_ray(event.view, x, y)
    return (math.degrees(math.atan2(ray[0], ray[2])),
            math.degrees(math.atan2(ray[1], math.hypot(ray[0], ray[2]))))


def direction_from_bearing(yaw: float, pitch: float) -> str:
    if pitch > 40:
        return 'above'
    if abs(yaw) >= 135:
        return 'back'
    if yaw < -45:
        return 'left'
    if yaw > 45:
        return 'right'
    return 'front'

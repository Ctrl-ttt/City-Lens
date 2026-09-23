"""Local manual-box A/B replay through the real SpatialSessions backend."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
from typing import TYPE_CHECKING

import av
import numpy as np

from backend.models import LABELS, Observation, VisionResult, WalkInput
from backend.rules import score
from backend.spatial import SpatialSessions
from backend.vision import Settings
from tools.x4_imu_compare import fingerprint, quaternion_at

if TYPE_CHECKING:
    from backend.imu import ImuPose

MAX_JSON_BYTES = 10 * 1024 * 1024
MAX_FRAMES = 10000
MAX_GAP_S = 0.05
FACES = {'front', 'left', 'right', 'back', 'up', 'down'}
LIMITATIONS = [
    '输入仅为本地人工少量框，不调用云模型；结果不是识别准确率评估。',
    '人工框只标可见范围，遮挡、裁切和视角变化也会改变框大小；表观增长不能单独证实真实接近。',
    '仅报告连续历史数，不报告关联正确/错误次数或跟踪准确率；人工 target_id 不传入预测器，历史长度不代表关联正确。',
    '没有距离或运动真值；speed 是后端表观尺度变化率（每秒），不是米/秒，也不表示持有者运动或碰撞预测精度。',
    'IMU 只提供已标定的旋转姿态；不重复施加侧车 mapping/offset，不外推，不跨超过 50ms 的缺口插值。跨帧区间有缺口时该帧不给 pose。',
    '框是 prepare_panorama 对应 heading 的六个 90 度透视 face 本地 0..1000 坐标，按 Observation 规则取整；heading 是全景相对朝向，不是真实持有者航向。',
    '后端可能过滤或合并观察；输出分别保留两组实际事件，不将人工 ID 强行配到预测事件。不修改在线 API 或语音。',
]


class PredictError(ValueError):
    pass


def number(value, name):
    if type(value) not in (int, float):
        raise PredictError(f'{name} 必须是有限数值（不能是 bool 或字符串）')
    try:
        result = float(value)
    except (ValueError, OverflowError):
        raise PredictError(f'{name} 必须是有限数值') from None
    if not math.isfinite(result):
        raise PredictError(f'{name} 必须是有限数值')
    return result


def object_fields(value, required, optional=(), name='JSON'):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise PredictError(f'{name} 字段缺失、未知或不是对象')
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PredictError(f'JSON 重复字段：{key}')
        result[key] = value
    return result


def _reject_constant(value):
    raise PredictError(f'JSON 不允许非有限值：{value}')


def read_json(path):
    path = Path(path).absolute()
    if not path.is_file():
        raise PredictError(f'输入不是本地普通文件：{path}')
    if path.stat().st_size > MAX_JSON_BYTES:
        raise PredictError('JSON 文件超过 10MiB 上限')
    with path.open('rb') as source:
        data = source.read(MAX_JSON_BYTES + 1)
    if len(data) > MAX_JSON_BYTES:
        raise PredictError('JSON 文件超过 10MiB 上限')
    try:
        parsed = json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                            parse_constant=_reject_constant,
                            parse_float=lambda text: number(float(text), 'JSON 数值'))
    except (UnicodeError, RecursionError, ValueError) as error:
        raise PredictError(f'无效 JSON：{error}') from None
    if not isinstance(parsed, dict):
        raise PredictError('JSON 根必须是对象')
    return parsed


def version_one(data):
    if type(data['version']) is not int or data['version'] != 1:
        raise PredictError('只接受整数 version: 1')


def video_identity(data, expected, *, sidecar=False):
    object_fields(data, ('size', 'fingerprint'), ('name', 'duration') if sidecar else (), 'video')
    size, digest = data['size'], data['fingerprint']
    if type(size) is not int or size <= 0:
        raise PredictError('video.size 必须是正整数')
    if not isinstance(digest, str) or re.fullmatch(r'[0-9a-fA-F]{64}', digest) is None:
        raise PredictError('video.fingerprint 必须是 64hex')
    if size != expected['size'] or digest.lower() != expected['fingerprint']:
        raise PredictError('video size/fingerprint 与输入视频不匹配')
    if 'name' in data and not isinstance(data['name'], str):
        raise PredictError('video.name 必须是字符串')
    if 'duration' in data and number(data['duration'], 'video.duration') <= 0:
        raise PredictError('video.duration 必须为正数')


@dataclass(frozen=True)
class VideoMetadata:
    width: int
    height: int
    start_s: float
    end_s: float


def video_metadata(video):
    # Metadata only; deny network protocols even if a local file is a playlist.
    with av.open(str(Path(video).absolute()), options={'protocol_whitelist': 'file'}) as container:
        if not container.streams.video:
            raise PredictError('输入没有视频轨')
        stream = container.streams.video[0]
        width, height = stream.width, stream.height
        if width <= 0 or height <= 0 or abs(width / height - 2) > 0.04:
            raise PredictError('输入必须是未裁剪的 ERP 2:1 视频')
        if stream.start_time is not None and stream.time_base is not None:
            start = float(stream.start_time * stream.time_base)
        else:
            start = float(container.start_time or 0) / av.time_base
        if stream.duration is not None and stream.time_base is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = float(container.duration) / av.time_base
        else:
            raise PredictError('无法从视频 metadata 确认时间域')
        end = number(start + duration, '视频结束时间')
        if not math.isfinite(start) or duration <= 0 or end <= start:
            raise PredictError('无效的视频时间域')
        return VideoMetadata(width, height, start, end)


@dataclass(frozen=True)
class Sidecar:
    recording_id: str
    times: np.ndarray
    quaternions: np.ndarray
    gap_starts: np.ndarray
    gap_ends: np.ndarray

    def pose_at(self, time_s: float, previous_time_s: float | None = None) -> tuple[ImuPose | None, str]:
        if not self.times[0] <= time_s <= self.times[-1]:
            return None, 'outside_imu_range'
        index = int(np.searchsorted(self.times, time_s))
        # Exact samples remain usable even beside a gap; interpolation does not.
        if self.times[index] != time_s and self.times[index] - self.times[index - 1] > MAX_GAP_S + 1e-12:
            return None, 'interpolation_gap'
        if previous_time_s is not None:
            gap = int(np.searchsorted(self.gap_ends, previous_time_s, side='right'))
            if gap < len(self.gap_starts) and self.gap_starts[gap] < time_s:
                return None, 'frame_interval_gap'
        from backend.imu import ImuPose
        quaternion = tuple(float(v) for v in quaternion_at(self.times, self.quaternions, time_s).as_quat())
        return ImuPose(recording_id=self.recording_id, time_s=time_s, quaternion=quaternion), 'valid'


def load_sidecar(path, identity):
    data = object_fields(read_json(path), ('version', 'camera', 'video', 'calibration', 'samples'),
                         ('evaluation', 'limitations'), 'IMU 侧车')
    version_one(data)
    video_identity(data['video'], identity, sidecar=True)
    camera = data['camera']
    if not isinstance(camera, str) or not camera.strip() or len(camera) > 256 or not camera.isprintable():
        raise PredictError('camera 必须是非空可打印字符串')
    calibration = object_fields(data['calibration'], ('accepted', 'mapping', 'offset_s'),
                                ('axis_separation', 'baseline_error', 'compensated_error', 'improvement',
                                 'pairs', 'calibration_pairs'), 'calibration')
    if calibration['accepted'] is not True:
        raise PredictError('侧车标定未通过：calibration.accepted 必须为 true')
    mapping = calibration['mapping']
    if (not isinstance(mapping, list) or len(mapping) != 3 or any(type(v) is not int for v in mapping)
            or sorted(abs(v) for v in mapping) != [1, 2, 3]):
        raise PredictError('calibration.mapping 必须是有符号轴排列')
    for key, value in calibration.items():
        if key not in ('mapping', 'accepted'):
            number(value, f'calibration.{key}')
    for key in ('pairs', 'calibration_pairs'):
        if key in calibration and (type(calibration[key]) is not int or calibration[key] < 0):
            raise PredictError(f'calibration.{key} 必须是非负整数')
    if 'evaluation' in data and not isinstance(data['evaluation'], list):
        raise PredictError('evaluation 必须是数组')
    if 'limitations' in data and not isinstance(data['limitations'], str):
        raise PredictError('limitations 必须是字符串')
    samples = data['samples']
    if not isinstance(samples, list) or len(samples) < 2:
        raise PredictError('至少需要两个 samples')
    rows = []
    previous = -math.inf
    for row in samples:
        if not isinstance(row, list) or len(row) != 7:
            raise PredictError('samples 每行必须为 [time_s,x,y,z,w,angular_speed_deg_s,acceleration_g]')
        values = [number(value, 'samples') for value in row]
        if values[0] <= previous:
            raise PredictError('samples 时间必须严格递增')
        if not math.isclose(math.hypot(*values[1:5]), 1.0, rel_tol=0, abs_tol=1e-6):
            raise PredictError('samples 四元数必须已归一化')
        if values[5] < 0 or values[6] < 0:
            raise PredictError('samples 角速度/加速度模长不能为负')
        rows.append(values)
        previous = values[0]
    array = np.asarray(rows, dtype=float)
    times = array[:, 0]
    gaps = np.flatnonzero(np.diff(times) > MAX_GAP_S + 1e-12)
    return Sidecar(identity['fingerprint'], times, array[:, 1:5], times[gaps], times[gaps + 1])


def load_observations(path, identity, metadata):
    data = object_fields(read_json(path), ('version', 'video', 'heading_deg', 'provenance', 'sequences'), name='注释')
    version_one(data)
    video_identity(data['video'], identity)
    if data['provenance'] != 'local_manual_boxes':
        raise PredictError('provenance 必须为 local_manual_boxes')
    heading = number(data['heading_deg'], 'heading_deg')
    if not -180 <= heading <= 180 or not heading.is_integer():
        raise PredictError('heading_deg 必须为 -180..180 的整数，与 WalkInput 一致')
    data['heading_deg'] = int(heading)
    sequences = data['sequences']
    if not isinstance(sequences, list) or not sequences or len(sequences) > MAX_FRAMES:
        raise PredictError('sequences 必须为非空数组，最多 10000 组')
    names, count = set(), 0
    for sequence in sequences:
        object_fields(sequence, ('name', 'frames'), name='sequence')
        name = sequence['name']
        if not isinstance(name, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', name) is None or name in names:
            raise PredictError('sequence.name 必须是唯一的 ASCII slug（最多 80 字符）')
        names.add(name)
        frames = sequence['frames']
        if not isinstance(frames, list) or not frames:
            raise PredictError('frames 必须为非空数组')
        count += len(frames)
        if count > MAX_FRAMES:
            raise PredictError('所有 sequence 合计最多 10000 帧')
        previous = -math.inf
        for frame in frames:
            object_fields(frame, ('time_s', 'events'), name='frame')
            time_s = number(frame['time_s'], 'frame.time_s')
            if time_s <= previous:
                raise PredictError('每个 sequence 的观测时间必须严格递增')
            if not max(0, metadata.start_s) <= time_s < metadata.end_s:
                raise PredictError('观测 actual media time 超出视频时间域')
            previous = frame['time_s'] = time_s
            events = frame['events']
            if not isinstance(events, list) or len(events) > 12:
                raise PredictError('每帧 events 必须是数组且最多 12 个目标')
            ids = set()
            for event in events:
                object_fields(event, ('target_id', 'label', 'view', 'box'), name='event')
                target = event['target_id']
                if not isinstance(target, str) or not target.strip() or len(target) > 256 or not target.isprintable() or target in ids:
                    raise PredictError('每帧 target_id 必须是唯一的非空可打印字符串（最多 256 字符）')
                ids.add(target)
                label, view, box = event['label'], event['view'], event['box']
                if not isinstance(label, str) or label not in LABELS or LABELS[label][0] == 'text':
                    raise PredictError('不支持的 label 或禁止的 text 类别')
                if not isinstance(view, str) or view not in FACES:
                    raise PredictError('view 必须是六个透视 face 之一')
                if not isinstance(box, list) or len(box) != 4:
                    raise PredictError('box 必须有四个本地 0..1000 坐标')
                coords = [number(v, 'box') for v in box]
                if not (0 <= coords[0] < coords[2] <= 1000 and 0 <= coords[1] < coords[3] <= 1000):
                    raise PredictError('box 越界、倒置或面积为零')
                rounded = [round(v) for v in coords]
                if rounded[0] >= rounded[2] or rounded[1] >= rounded[3]:
                    raise PredictError('box 取整后面积为零，拒绝静默丢弃')
                event['box'] = rounded
    return data


def _statistics():
    return dict(observation_count=0, speed_available_count=0, continuous_history_count=0,
                three_frame_history_count=0, approaching_count=0)


def _events(sessions, meta, result, metadata, settings, time_s, statistics, *, imu_pose=None):
    events, _ = sessions.process(meta, result, metadata.width, metadata.height, settings, time_s, imu_pose=imu_pose)
    # Private state is inspected only for the CURRENT event's window length.
    # Neither timestamp equality nor >=2 samples proves cross-frame target identity.
    tracks = sessions.sessions[meta.session_id].tracks
    rows = []
    for event in events:
        matches = [track for track in tracks if track.event is event]
        if len(matches) != 1:
            raise PredictError('无法通过当前 event identity 唯一读取 track.scales；拒绝猜测历史')
        history = len(matches[0].scales)
        rows.append(dict(label=event.label, view=event.view, box=event.box, speed=event.speed,
                         approaching=event.approaching, risk_score=score(event, settings.min_confidence),
                         history_length=history))
        statistics['observation_count'] += 1
        statistics['speed_available_count'] += event.speed is not None
        statistics['continuous_history_count'] += history >= 2
        statistics['three_frame_history_count'] += history == 3
        statistics['approaching_count'] += bool(event.approaching)
    return rows


def predict(video, imu, observations):
    video = Path(video).absolute()
    if not video.is_file():
        raise PredictError('VIDEO 必须是本地普通文件')
    identity = {'size': video.stat().st_size, 'fingerprint': fingerprint(video)}
    metadata = video_metadata(video)
    sidecar = load_sidecar(imu, identity)
    annotations = load_observations(observations, identity, metadata)
    settings = Settings()  # Deliberately not load_settings(), backend.app, or .env.
    summary = dict(frame_count=0, observation_count=0, imu_valid_frame_count=0,
                   vision=_statistics(), vision_imu=_statistics())
    sequences = []
    for sequence in annotations['sequences']:
        vision, vision_imu = SpatialSessions(), SpatialSessions()
        frames, previous_time = [], None
        for index, frame in enumerate(sequence['frames']):
            time_s = frame['time_s']
            meta = WalkInput(session_id=sequence['name'], frame_id=index, source='video',
                             projection='equirectangular', heading_deg=annotations['heading_deg'])
            result = VisionResult(events=[Observation(category=LABELS[event['label']][0], label=event['label'],
                                                       direction='unknown', view=event['view'], box=event['box'])
                                          for event in frame['events']])
            pose, reason = sidecar.pose_at(time_s, previous_time)
            baseline = _events(vision, meta, result, metadata, settings, time_s, summary['vision'])
            compensated = _events(vision_imu, meta, result, metadata, settings, time_s,
                                  summary['vision_imu'], imu_pose=pose)
            frames.append(dict(time_s=time_s, annotations=frame['events'],
                               imu_valid=pose is not None, imu_status=reason,
                               vision=baseline, vision_imu=compensated))
            summary['frame_count'] += 1
            summary['observation_count'] += len(frame['events'])
            summary['imu_valid_frame_count'] += pose is not None
            previous_time = time_s
        sequences.append(dict(name=sequence['name'], frames=frames))
    return dict(version=1, video=identity, heading_deg=annotations['heading_deg'],
                provenance=annotations['provenance'], summary=summary, sequences=sequences,
                association_evaluation='not_evaluated', limitations=LIMITATIONS)


def main(argv=None):
    parser = argparse.ArgumentParser(description='本地人工框 + 已标定 IMU，调用真实 SpatialSessions 离线 A/B；不联网。')
    parser.add_argument('video', type=Path, metavar='VIDEO')
    parser.add_argument('--imu', type=Path, required=True, metavar='SIDECAR', help='version 1 侧车，最多 10MiB')
    parser.add_argument('--observations', type=Path, required=True, metavar='ANNOTATIONS', help='本地人工框 JSON，最多 10MiB/10000 帧')
    parser.add_argument('-o', '--output', type=Path, required=True, metavar='OUTPUT')
    args = parser.parse_args(argv)
    # Normalize every file path, without creating directories or following output symlinks.
    video, imu, observations, output = (path.absolute() for path in (args.video, args.imu, args.observations, args.output))
    if output.exists() or output.is_symlink():
        parser.error('输出已经存在，不会覆盖')
    if not output.parent.is_dir():
        parser.error('输出父目录必须存在，不创建目录')
    try:
        report = predict(video, imu, observations)
        encoded = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        with output.open('x', encoding='utf-8') as target:
            target.write(encoded)
        print(json.dumps({'output': str(output), 'summary': report['summary']}, ensure_ascii=False, allow_nan=False))
    except (OSError, ValueError, av.error.FFmpegError) as error:
        parser.exit(1, f'IMU 预测对照未完成：{error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

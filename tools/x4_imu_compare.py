import argparse
import hashlib
import itertools
import json
from pathlib import Path

import av
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.spatial.transform import Rotation

from tools.x4_imu import ImuError, read_insv_imu

WIDTH, HEIGHT = 320, 160


def fingerprint(path):
    path = Path(path)
    size = path.stat().st_size
    digest = hashlib.sha256(str(size).encode('ascii'))
    with path.open('rb') as source:
        digest.update(source.read(65536))
        source.seek(max(0, size - 65536))
        digest.update(source.read(65536))
    return digest.hexdigest()


def sample_grid():
    x, y = np.meshgrid(np.arange(8, WIDTH, 8), np.arange(32, 120, 4))
    lon = (x.ravel() / WIDTH - 0.5) * 2 * np.pi
    lat = (0.5 - y.ravel() / HEIGHT) * np.pi
    rays = np.column_stack((np.sin(lon) * np.cos(lat), np.sin(lat), np.cos(lon) * np.cos(lat)))
    return x.ravel(), y.ravel(), rays


GRID_X, GRID_Y, RAYS = sample_grid()


def photometric_error(before, after, rotation):
    rays = rotation.inv().apply(RAYS)
    x = ((0.5 + np.arctan2(rays[:, 0], rays[:, 2]) / (2 * np.pi)) * WIDTH) % WIDTH
    y = (0.5 - np.arctan2(rays[:, 1], np.hypot(rays[:, 0], rays[:, 2])) / np.pi) * HEIGHT
    extended = np.concatenate((before, before[:, :1]), axis=1)
    predicted = map_coordinates(extended.astype(float), [y, x], order=1, mode='nearest')
    errors = np.abs(predicted - after[GRID_Y, GRID_X].astype(float))
    # Trimming limits moving foreground influence, but does not identify a static scene.
    return float(np.mean(np.sort(errors)[:int(len(errors) * 0.8)]))


def extract_pair(container, stream, seconds, interval=0.167):
    container.seek(int(seconds / stream.time_base), stream=stream)
    first = None
    for frame in container.decode(stream):
        if frame.time is None or frame.time < seconds:
            continue
        if first is None:
            first = (float(frame.time), frame.reformat(width=WIDTH, height=HEIGHT, format='gray').to_ndarray())
        elif frame.time >= first[0] + interval:
            return first, (float(frame.time), frame.reformat(width=WIDTH, height=HEIGHT, format='gray').to_ndarray())
    raise ImuError('视频时长不足，无法抽取成对画面。')


def integrated_velocity(imu):
    delta = np.diff(imu.times)
    if np.any(delta > 0.02):
        raise ImuError('IMU 存在超过20毫秒的数据缺口，不能生成连续旋转补偿。')
    cumulative = np.zeros_like(imu.angular_velocity)
    cumulative[1:] = np.cumsum((imu.angular_velocity[1:] + imu.angular_velocity[:-1]) * delta[:, None] * 0.5, axis=0)
    return cumulative


def rotation_vector(times, cumulative, start, end):
    if not times[0] <= start < end <= times[-1]:
        raise ImuError('画面时间超出 IMU 覆盖范围。')
    return np.array([np.interp(end, times, cumulative[:, i]) - np.interp(start, times, cumulative[:, i]) for i in range(3)])


def axis_maps():
    for order in itertools.permutations(range(3)):
        for signs in itertools.product((-1, 1), repeat=3):
            yield [sign * (axis + 1) for axis, sign in zip(order, signs)]


def map_axes(values, mapping):
    mapping = np.asarray(mapping)
    return values[..., np.abs(mapping) - 1] * np.sign(mapping)


def fit_mapping(imu, pairs):
    cumulative = integrated_velocity(imu)
    training = [pair for i, pair in enumerate(pairs) if i % 3 != 0]
    candidates = []
    for offset in (-0.08, -0.04, 0.0, 0.04, 0.08):
        vectors = [rotation_vector(imu.times, cumulative, a[0] + offset, b[0] + offset) for a, b in training]
        for mapping in axis_maps():
            errors = [photometric_error(a[1], b[1], Rotation.from_rotvec(map_axes(vector, mapping)))
                      for (a, b), vector in zip(training, vectors)]
            candidates.append((float(np.mean(errors)), mapping, offset))
    candidates.sort(key=lambda item: item[0])
    best = candidates[0]
    different = next(item for item in candidates if item[1] != best[1])
    separation = (different[0] - best[0]) / max(different[0], 0.01)
    return best[1], best[2], separation


def integrate_quaternions(times, velocity):
    delta = np.diff(times)
    increments = Rotation.from_rotvec((velocity[1:] + velocity[:-1]) * delta[:, None] * 0.5).as_quat()
    result = np.zeros((len(times), 4))
    result[0, 3] = 1
    for i, (x, y, z, w) in enumerate(increments, 1):
        a, b, c, d = result[i - 1]
        q = np.array([w*a + x*d + y*c - z*b, w*b - x*c + y*d + z*a,
                      w*c + x*b - y*a + z*d, w*d - x*a - y*b - z*c])
        result[i] = q / np.linalg.norm(q)
    return result


def quaternion_at(times, quaternions, at):
    if not times[0] <= at <= times[-1]:
        raise ImuError('画面时间超出姿态数据覆盖范围。')
    index = min(len(times) - 2, max(0, int(np.searchsorted(times, at)) - 1))
    fraction = (at - times[index]) / (times[index + 1] - times[index])
    a, b = quaternions[index:index + 2]
    if np.dot(a, b) < 0:
        b = -b
    q = a * (1 - fraction) + b * fraction
    return Rotation.from_quat(q / np.linalg.norm(q))


def compare(source, video, count=36):
    imu = read_insv_imu(source)
    if len(imu.times) < 2:
        raise ImuError('至少需要两个 IMU 样本。')
    with av.open(str(video)) as container:
        if not container.streams.video:
            raise ImuError('所选文件没有视频轨。')
        stream = container.streams.video[0]
        if abs(stream.width / stream.height - 2) > 0.04:
            raise ImuError('需要对应原片、未裁剪且未增稳的2:1全景 MP4。')
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else container.duration / av.time_base
        start, end = max(1.0, float(imu.times[0]) + 0.2), min(duration - 1, float(imu.times[-1]) - 0.5)
        if end - start < 5:
            raise ImuError('视频和 IMU 的共同时间范围不足。')
        pairs = [extract_pair(container, stream, float(t)) for t in np.linspace(start, end, count)]
    mapping, offset, separation = fit_mapping(imu, pairs)
    quaternions = integrate_quaternions(imu.times, map_axes(imu.angular_velocity, mapping))
    rows = []
    for i, (before, after) in enumerate(pairs):
        qa = quaternion_at(imu.times, quaternions, before[0] + offset)
        qb = quaternion_at(imu.times, quaternions, after[0] + offset)
        baseline = photometric_error(before[1], after[1], Rotation.identity())
        compensated = photometric_error(before[1], after[1], qb * qa.inv())
        rows.append({'time_s': round(before[0], 4), 'split': 'holdout' if i % 3 == 0 else 'calibration',
                     'baseline': round(baseline, 4), 'compensated': round(compensated, 4),
                     'rotation_deg': round(float(np.linalg.norm((qb * qa.inv()).as_rotvec()) * 180 / np.pi), 4)})
    holdout = [row for row in rows if row['split'] == 'holdout']
    baseline = float(np.mean([row['baseline'] for row in holdout]))
    compensated = float(np.mean([row['compensated'] for row in holdout]))
    improvement = (baseline - compensated) / max(baseline, 0.01)
    moving = sum(row['rotation_deg'] >= 0.3 for row in rows if row['split'] == 'calibration')
    accepted = bool(improvement > 0.1 and separation > 0.005 and moving >= 6 and baseline >= 1)
    calibration = {'accepted': accepted, 'mapping': mapping, 'offset_s': offset,
                   'axis_separation': round(separation, 6), 'baseline_error': round(baseline, 4),
                   'compensated_error': round(compensated, 4), 'improvement': round(improvement, 6),
                   'pairs': len(holdout), 'calibration_pairs': len(rows) - len(holdout)}
    indexes = np.unique(np.r_[np.searchsorted(imu.times, np.arange(imu.times[0], imu.times[-1], 0.01)), len(imu.times) - 1])
    samples = np.column_stack((imu.times[indexes] - offset, quaternions[indexes],
                               np.linalg.norm(imu.angular_velocity[indexes], axis=1) * 180 / np.pi,
                               np.linalg.norm(imu.acceleration[indexes], axis=1)))
    return {'version': 1, 'camera': imu.camera_type,
            'video': {'name': Path(video).name, 'size': Path(video).stat().st_size,
                      'fingerprint': fingerprint(video), 'duration': round(duration, 6)},
            'calibration': calibration, 'samples': np.round(samples, 7).tolist(), 'evaluation': rows,
            'limitations': '仅验证旋转光度补偿，不是目标跟踪正确率或持有者位移预测；加速度模长包含重力。'}, imu.summary()


def main(argv=None):
    parser = argparse.ArgumentParser(description='本地 INSV IMU + 未增稳全景 MP4：轴映射标定、保留帧对照及浏览器侧车数据，不联网。')
    parser.add_argument('source', type=Path)
    parser.add_argument('video', type=Path)
    parser.add_argument('-o', '--output', type=Path, required=True)
    parser.add_argument('--pairs', type=int, default=36)
    args = parser.parse_args(argv)
    if not 18 <= args.pairs <= 120:
        parser.error('--pairs 需要在18到120之间')
    if args.output.exists():
        parser.error('输出已经存在，不会覆盖')
    if not args.output.parent.is_dir():
        parser.error('输出目录不存在')
    try:
        recording, summary = compare(args.source, args.video, args.pairs)
        encoded = json.dumps(recording, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        with args.output.open('x', encoding='utf-8') as target:
            target.write(encoded)
        print(json.dumps({'imu': summary, 'calibration': recording['calibration'], 'output': str(args.output)}, ensure_ascii=False))
    except (ImuError, OSError, ValueError, av.error.FFmpegError) as error:
        parser.exit(1, f'IMU 对照未完成：{error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

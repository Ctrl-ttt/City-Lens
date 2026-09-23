"""Read verified raw X4 Air IMU records locally, without decoding video."""

import argparse
import csv
from dataclasses import dataclass
import json
import math
from pathlib import Path
import struct
import sys
from typing import BinaryIO

import numpy as np


MAGIC = b'8db42d694ccc418790edff439fe026bf'
FOOTER = struct.Struct('<32xII32s')
BLOCK_HEADER = struct.Struct('<BBI')
TABLE_ENTRY = struct.Struct('<BBII')
RAW_DTYPE = np.dtype([('timestamp', '<u8'), ('values', '<u2', (6,))])
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_TABLE_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 4096
MAX_GYRO_MEMORY_BYTES = 256 * 1024 * 1024
CHUNK_RECORDS = 4096
# Final arrays (56 bytes/sample), summary workspace and conservative chunk reserve.
WORKING_BYTES_PER_SAMPLE = 72
CHUNK_RESERVE_BYTES = 2 * 1024 * 1024
CSV_HEADER = ('t_s', 'ax_g', 'ay_g', 'az_g', 'gx_rad_s', 'gy_rad_s', 'gz_rad_s')


class ImuError(ValueError):
    """Missing, unsupported or malformed INSV IMU data."""


@dataclass
class ImuData:
    """Video-relative seconds and native sensor axes; no orientation calibration."""

    camera_type: str
    times: np.ndarray
    acceleration: np.ndarray  # Nx3, g
    angular_velocity: np.ndarray  # Nx3, rad/s

    def summary(self) -> dict:
        """Non-sensitive sample coverage; rate is the inverse median interval."""
        gaps = np.diff(self.times)
        max_gap = float(gaps.max()) if gaps.size else 0.0
        rate = float(1.0 / np.median(gaps, overwrite_input=True)) if gaps.size else None
        return {
            'camera_type': self.camera_type,
            'sample_count': int(self.times.size),
            'start_s': float(self.times[0]),
            'end_s': float(self.times[-1]),
            'duration_s': float(self.times[-1] - self.times[0]),
            'sample_rate_hz': rate,
            'max_gap_s': max_gap,
        }


def _read_exact(stream: BinaryIO, offset: int, size: int, limit: int) -> bytes:
    if offset < 0 or size < 0 or offset > limit or size > limit - offset:
        raise ImuError('INSV 数据越界或被截断。')
    stream.seek(offset)
    data = stream.read(size)
    if len(data) != size:
        raise ImuError('INSV 数据被截断。')
    return data


def _blocks(stream: BinaryIO, file_size: int) -> dict:
    footer_start = file_size - FOOTER.size
    extra_size, _version, magic = FOOTER.unpack(_read_exact(stream, footer_start, FOOTER.size, file_size))
    if magic != MAGIC:
        raise ImuError('不是受支持的 INSV 尾部，或文件被截断。')
    if not FOOTER.size + BLOCK_HEADER.size <= extra_size <= file_size:
        raise ImuError('INSV extra_size 越界。')
    extra_start = file_size - extra_size
    table_header = footer_start - BLOCK_HEADER.size
    table_format, table_id, table_size = BLOCK_HEADER.unpack(
        _read_exact(stream, table_header, BLOCK_HEADER.size, footer_start)
    )
    if table_id != 0 or table_size % TABLE_ENTRY.size or table_size > MAX_TABLE_BYTES:
        raise ImuError('INSV 偏移表无效或过大。')
    table_start = table_header - table_size
    if table_start < extra_start:
        raise ImuError('INSV 偏移表越界。')
    table = _read_exact(stream, table_start, table_size, table_header)
    blocks = {}
    spans = []
    for block_id, block_format, size, relative_offset in TABLE_ENTRY.iter_unpack(table):
        if (block_id, block_format, size, relative_offset) == (0, 0, 0, 0):
            continue
        start = extra_start + relative_offset
        end = start + size + BLOCK_HEADER.size
        if block_id in blocks:
            raise ImuError('INSV 偏移表包含重复块。')
        # Some tables may describe themselves; they must match the actual table exactly.
        if block_id == 0:
            if (start, size, block_format) != (table_start, table_size, table_format):
                raise ImuError('INSV 偏移表自引用不匹配。')
        elif start < extra_start or end > table_start:
            raise ImuError('INSV 数据块越界或被截断。')
        else:
            spans.append((start, end))
        actual = BLOCK_HEADER.unpack(_read_exact(stream, start + size, BLOCK_HEADER.size, footer_start))
        if actual != (block_format, block_id, size):
            raise ImuError('INSV 数据块头与偏移表不匹配。')
        blocks[block_id] = (start, size)
    spans.sort()
    if any(right[0] < left[1] for left, right in zip(spans, spans[1:])):
        raise ImuError('INSV 数据块重叠。')
    return blocks


def _varint(data: memoryview, position: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(data):
            raise ImuError('metadata protobuf varint 被截断。')
        byte = data[position]
        position += 1
        if shift == 63 and byte > 1:
            raise ImuError('metadata protobuf varint 溢出。')
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ImuError('metadata protobuf varint 无效。')


def _fields(payload: bytes | memoryview):
    """Skip unknown fields without decoding or retaining serial numbers/GPS."""
    data = memoryview(payload)
    position = 0
    while position < len(data):
        key, position = _varint(data, position)
        tag, wire = key >> 3, key & 7
        if not 0 < tag < (1 << 29):
            raise ImuError('metadata protobuf tag 无效。')
        if wire == 0:
            value, position = _varint(data, position)
        else:
            if wire == 1:
                size = 8
            elif wire == 2:
                size, position = _varint(data, position)
            elif wire == 5:
                size = 4
            else:
                raise ImuError('metadata protobuf wire type 不受支持。')
            if size > len(data) - position:
                raise ImuError('metadata protobuf 字段长度越界或被截断。')
            value = data[position:position + size]
            position += size
        yield tag, wire, value


def _select_fields(payload: bytes | memoryview, expected: dict) -> dict:
    selected = {}
    for tag, wire, value in _fields(payload):
        if tag not in expected:
            continue
        if wire != expected[tag] or tag in selected:
            raise ImuError(f'metadata tag {tag} 类型错误或重复。')
        selected[tag] = value
    return selected


def _metadata(payload: bytes) -> tuple[str, int, float, int, int]:
    fields = _select_fields(payload, {2: 2, 24: 0, 28: 1, 29: 0, 62: 0, 65: 2})
    if not {2, 24, 29, 62}.issubset(fields):
        raise ImuError('metadata 缺少 camera_type、时间基准或 raw 标志。')
    if fields[29] not in (0, 1) or fields[62] not in (0, 1):
        raise ImuError('metadata bool 标志无效。')
    if not fields[62]:
        raise ImuError('不支持非 raw gyro：其单位和时间基准尚未验证，拒绝猜测。')
    if not 0 < len(fields[2]) <= 256:
        raise ImuError('metadata camera_type 长度无效。')
    try:
        camera = bytes(fields[2]).decode('utf-8')
    except UnicodeDecodeError:
        raise ImuError('metadata camera_type 不是有效 UTF-8。') from None
    if not camera.strip() or any(ord(char) < 32 or ord(char) == 127 for char in camera):
        raise ImuError('metadata camera_type 无效。')
    first_frame = fields[24]
    if first_frame >= (1 << 63):
        first_frame -= 1 << 64  # protobuf int64, not zigzag/sint64
    if fields[29] and 28 not in fields:
        raise ImuError('metadata 缺少 gyro_timestamp。')
    gyro_ms = struct.unpack('<d', fields[28])[0] if 28 in fields else 0.0
    if not math.isfinite(gyro_ms):
        raise ImuError('metadata gyro_timestamp 必须是有限值。')
    if 65 not in fields:
        raise ImuError('metadata 缺少 gyro config 量程。')
    if len(fields[65]) > MAX_CONFIG_BYTES:
        raise ImuError('metadata gyro config 长度过大。')
    config = _select_fields(fields[65], {1: 0, 2: 0})
    if not {1, 2}.issubset(config):
        raise ImuError('metadata 缺少 acc_range 或 gyro_range 量程。')
    acc_range, gyro_range = config[1], config[2]
    if not 1 <= acc_range <= 256 or not 1 <= gyro_range <= 16000:
        raise ImuError('metadata 量程不合理（acc 1..256 g，gyro 1..16000 deg/s）。')
    return camera, first_frame, gyro_ms / 1000 if fields[29] else 0.0, acc_range, gyro_range


def _read_gyro(stream: BinaryIO, start: int, size: int, metadata: tuple) -> ImuData:
    if size == 0 or size % RAW_DTYPE.itemsize:
        raise ImuError('gyro 为空或不是完整的 20-byte raw 记录。')
    count = size // RAW_DTYPE.itemsize
    if count * WORKING_BYTES_PER_SAMPLE + CHUNK_RESERVE_BYTES > MAX_GYRO_MEMORY_BYTES:
        raise ImuError('gyro 读取超过 256 MiB 内存预算。')
    camera, first_frame, gyro_offset, acc_range, gyro_range = metadata
    times = np.empty(count, dtype=np.float64)
    acceleration = np.empty((count, 3), dtype=np.float64)
    angular_velocity = np.empty((count, 3), dtype=np.float64)
    previous = None
    origin = None
    for begin in range(0, count, CHUNK_RECORDS):
        end = min(begin + CHUNK_RECORDS, count)
        payload = _read_exact(stream, start + begin * RAW_DTYPE.itemsize,
                              (end - begin) * RAW_DTYPE.itemsize, start + size)
        records = np.frombuffer(payload, dtype=RAW_DTYPE)
        stamps = records['timestamp']
        if (previous is not None and int(stamps[0]) <= previous) or np.any(stamps[1:] <= stamps[:-1]):
            raise ImuError('gyro timestamp 必须严格递增。')
        previous = int(stamps[-1])
        if origin is None:
            origin = int(stamps[0])
        # Subtract integer timestamps first, preserving microseconds even above 2**53.
        times[begin:end] = (stamps - np.uint64(origin)).astype(np.float64) / 1_000_000
        times[begin:end] += (origin - first_frame) / 1_000_000 - gyro_offset
        values = records['values'].astype(np.float64)
        values -= 32768
        acceleration[begin:end] = values[:, :3] * (acc_range / 32768)
        angular_velocity[begin:end] = values[:, 3:] * (gyro_range / 32768 * math.pi / 180)
        for array in (times[begin:end], acceleration[begin:end], angular_velocity[begin:end]):
            if not np.isfinite(array).all():
                raise ImuError('gyro 换算结果必须是有限值。')
        local_times = times[max(0, begin - 1):end]
        if np.any(local_times[1:] <= local_times[:-1]):
            raise ImuError('gyro 时间基准超出浮点精度，无法保持严格递增。')
    return ImuData(camera, times, acceleration, angular_velocity)


def read_insv_imu(path: str | Path) -> ImuData:
    """Read only indexed raw IMU; reject missing/ambiguous units and malformed data."""
    try:
        with Path(path).open('rb') as stream:
            stream.seek(0, 2)
            size = stream.tell()
            blocks = _blocks(stream, size)
            if 3 not in blocks:
                raise ImuError('INSV 没有 gyro 数据块。')
            if 1 not in blocks:
                raise ImuError('INSV 缺少 metadata 数据块。')
            offset, length = blocks[1]
            if not 0 < length <= MAX_METADATA_BYTES:
                raise ImuError('metadata 长度无效或超过内存限制。')
            metadata = _metadata(_read_exact(stream, offset, length, size))
            return _read_gyro(stream, *blocks[3], metadata)
    except OSError as error:
        raise ImuError('无法只读打开或读取 INSV 文件。') from error
    except MemoryError as error:
        raise ImuError('可用内存不足，无法读取 gyro。') from error


def _write_csv(path: Path, imu: ImuData) -> None:
    created = False
    try:
        with path.open('x', encoding='utf-8', newline='') as output:
            created = True
            writer = csv.writer(output)
            writer.writerow(CSV_HEADER)
            for time, acceleration, velocity in zip(imu.times, imu.acceleration, imu.angular_velocity):
                writer.writerow((float(time), *map(float, acceleration), *map(float, velocity)))
    except BaseException:
        if created:
            path.unlink(missing_ok=True)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description='只读诊断 X4 Air raw IMU：秒 / g / rad/s；不读取序列号或 GPS 字段。')
    result.add_argument('input', metavar='INPUT', type=Path, help='原始 INSV 文件')
    result.add_argument('-o', '--output', metavar='OUTPUT.csv', type=Path,
                        help='可选 CSV（独占创建，不覆盖已有文件）；省略时只显示摘要')
    return result


def main(argv=None) -> int:
    options = parser().parse_args(argv)
    try:
        imu = read_insv_imu(options.input)
        summary = imu.summary()
        if options.output is not None:
            _write_csv(options.output, imu)
        print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    except FileExistsError:
        print('IMU 诊断失败：输出已存在，不会覆盖。', file=sys.stderr)
        return 1
    except (ImuError, OSError, MemoryError) as error:
        print(f'IMU 诊断失败：{error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('IMU 诊断已取消。', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

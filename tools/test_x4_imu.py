import csv
from dataclasses import fields
import json
import math
from pathlib import Path
import struct
import subprocess
import sys

import numpy as np
import pytest

from tools import x4_imu as tool


MAGIC = b'8db42d694ccc418790edff439fe026bf'
TIMESTAMPS = (999_000, 1_000_000, 1_001_000, 1_005_000)
VALUES = (33792, 16384, 0, 49152, 0, 65535)


def varint(value):
    value &= (1 << 64) - 1
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def integer(tag, value):
    return varint(tag << 3) + varint(value)


def blob(tag, value):
    return varint((tag << 3) | 2) + varint(len(value)) + value


def double(tag, value):
    return varint((tag << 3) | 1) + struct.pack('<d', value)


def metadata(overrides=None, omit=()):
    known = {
        2: blob(2, b'Insta360 X4 Air'),
        24: integer(24, 1_000_000),
        28: double(28, 0.5),
        29: integer(29, 1),
        62: integer(62, 1),
        65: blob(65, integer(1, 32) + integer(2, 2000)),
    }
    known.update(overrides or {})
    # Unknown fields must be skipped, including opaque invalid nested protobuf bytes.
    private = blob(100, b'PRIVATE-SERIAL-GPS\xff\x80')
    private += integer(101, 123) + double(102, math.nan)
    private += varint((103 << 3) | 5) + b'abcd'
    return b''.join(value for tag, value in known.items() if tag not in omit) + private


def gyro(timestamps=TIMESTAMPS, values=VALUES):
    return b''.join(struct.pack('<Q6H', stamp, *values) for stamp in timestamps)


def synthetic_container(meta=metadata(), raw=gyro(), self_reference=False):
    """Tiny indexed INSV tail with non-adjacent blocks and out-of-order entries."""
    prefix = struct.pack('>I4s', 16, b'ftyp') + b'isom\0\0\0\0'
    extra = bytearray(b'initial padding, not a block')
    entries = []
    blocks = [(9, 7, b'opaque block')]
    if meta is not None:
        blocks.append((1, 2, meta))
    if raw is not None:
        blocks.append((3, 1, raw))
    for block_id, block_format, data in blocks:
        entries.append((block_id, block_format, len(data), len(extra)))
        extra += data + struct.pack('<BBI', block_format, block_id, len(data))
        extra += b'\xfe padding between blocks \x03\0\xff'
    if self_reference:
        entries.append((0, 4, (len(entries) + 1) * 10, len(extra)))
    table = b''.join(struct.pack('<BBII', *entry) for entry in reversed(entries))
    extra += table + struct.pack('<BBI', 4, 0, len(table))
    extra += struct.pack('<32xII32s', len(extra) + 72, 1, MAGIC)
    return prefix + extra


def table_info(payload):
    extra_size = struct.unpack_from('<I', payload, len(payload) - 40)[0]
    table_size = struct.unpack_from('<I', payload, len(payload) - 76)[0]
    return len(payload) - extra_size, len(payload) - 78 - table_size, table_size


def entry_location(payload, block_id):
    _, table_start, table_size = table_info(payload)
    for position in range(table_start, table_start + table_size, 10):
        if payload[position] == block_id:
            return position
    raise AssertionError('missing synthetic block')


def change_entry(payload, block_id, **changes):
    result = bytearray(payload)
    position = entry_location(payload, block_id)
    names = ('block_id', 'block_format', 'size', 'offset')
    original = dict(zip(names, struct.unpack_from('<BBII', result, position)))
    original.update(changes)
    struct.pack_into('<BBII', result, position, *(original[name] for name in names))
    return bytes(result)


@pytest.fixture
def source(tmp_path):
    path = tmp_path / '原始 IMU.insv'
    path.write_bytes(synthetic_container())
    return path


def read_payload(tmp_path, payload):
    path = tmp_path / 'synthetic.insv'
    path.write_bytes(payload)
    return tool.read_insv_imu(path)


@pytest.mark.parametrize('self_reference', [False, True])
def test_padding_offsets_units_and_summary(tmp_path, self_reference):
    imu = read_payload(tmp_path, synthetic_container(self_reference=self_reference))
    assert isinstance(imu, tool.ImuData)
    assert issubclass(tool.ImuError, ValueError)
    assert imu.camera_type == 'Insta360 X4 Air'
    assert [field.name for field in fields(imu)] == ['camera_type', 'times', 'acceleration', 'angular_velocity']
    np.testing.assert_allclose(imu.times, [-0.0015, -0.0005, 0.0005, 0.0045], atol=1e-15, rtol=0)
    np.testing.assert_array_equal(imu.acceleration, np.tile([1, -16, -32], (4, 1)))
    expected = np.array([1000, -2000, 2000 * 32767 / 32768]) * math.pi / 180
    np.testing.assert_allclose(imu.angular_velocity, np.tile(expected, (4, 1)), atol=1e-14)
    for array, shape in [(imu.times, (4,)), (imu.acceleration, (4, 3)), (imu.angular_velocity, (4, 3))]:
        assert array.dtype == np.float64 and array.shape == shape
        assert np.isfinite(array).all()
    before = imu.times.copy()
    summary = imu.summary()
    assert summary == {
        'camera_type': 'Insta360 X4 Air', 'sample_count': 4,
        'start_s': pytest.approx(-0.0015), 'end_s': pytest.approx(0.0045),
        'duration_s': pytest.approx(0.006), 'sample_rate_hz': pytest.approx(1000),
        'max_gap_s': pytest.approx(0.004),
    }
    assert 'PRIVATE' not in json.dumps(summary) and 'PRIVATE' not in repr(imu)
    np.testing.assert_array_equal(imu.times, before)


def test_zero_filled_unused_index_slots(tmp_path):
    payload = synthetic_container()
    _, table_start, table_size = table_info(payload)
    zeros = bytes(20)
    footer = bytearray(payload[-72:])
    old_size = struct.unpack_from('<I', footer, 32)[0]
    struct.pack_into('<I', footer, 32, old_size + len(zeros))
    adjusted = payload[:table_start] + zeros + payload[table_start:-78]
    adjusted += struct.pack('<BBI', 4, 0, table_size + len(zeros)) + footer
    imu = read_payload(tmp_path, adjusted)
    assert imu.times.size == len(TIMESTAMPS)


@pytest.mark.parametrize('omit_timestamp', [False, True])
def test_false_gyro_offset_flag(tmp_path, omit_timestamp):
    meta = metadata({29: integer(29, 0), 28: double(28, 5000)}, omit=(28,) if omit_timestamp else ())
    imu = read_payload(tmp_path, synthetic_container(meta=meta))
    np.testing.assert_allclose(imu.times, [-0.001, 0, 0.001, 0.005], atol=1e-15)


@pytest.mark.parametrize('acc_range,gyro_range', [(2, 250), (16, 1000), (32, 2000), (256, 16000)])
def test_ranges_are_from_metadata(tmp_path, acc_range, gyro_range):
    meta = metadata({65: blob(65, integer(1, acc_range) + integer(2, gyro_range))})
    imu = read_payload(tmp_path, synthetic_container(meta=meta, raw=gyro((1_000_000,), (0, 32768, 65535) * 2)))
    np.testing.assert_allclose(imu.acceleration[0], np.array([-1, 0, 32767 / 32768]) * acc_range)
    np.testing.assert_allclose(imu.angular_velocity[0], np.array([-1, 0, 32767 / 32768]) * gyro_range * math.pi / 180)
    assert imu.summary()['sample_rate_hz'] is None
    assert imu.summary()['max_gap_s'] == imu.summary()['duration_s'] == 0.0


@pytest.mark.parametrize('first_frame', [0, -1000, 1 << 60, (1 << 63) - 1])
def test_signed_int64_baseline_and_large_timestamp_precision(tmp_path, first_frame):
    origin = max(0, first_frame - 1000)
    meta = metadata({24: integer(24, first_frame), 29: integer(29, 0)})
    imu = read_payload(tmp_path, synthetic_container(meta, gyro((origin, origin + 1, origin + 1000))))
    expected = np.array([origin - first_frame, origin + 1 - first_frame, origin + 1000 - first_frame]) / 1e6
    np.testing.assert_allclose(imu.times, expected, atol=1e-15, rtol=0)


@pytest.mark.parametrize('removed', [1, 10, 71, 72, 73, 90])
def test_truncated_tail_rejected(tmp_path, removed):
    with pytest.raises(tool.ImuError):
        read_payload(tmp_path, synthetic_container()[:-removed])


@pytest.mark.parametrize('payload', [b'', b'not insv', bytes(78), MAGIC, bytes(72)])
def test_malformed_file_rejected(tmp_path, payload):
    with pytest.raises(tool.ImuError):
        read_payload(tmp_path, payload)


@pytest.mark.parametrize('extra_size', [0, 71, 77, 78, 0xffffffff])
def test_extra_size_boundaries(tmp_path, extra_size):
    payload = bytearray(synthetic_container())
    struct.pack_into('<I', payload, len(payload) - 40, extra_size)
    with pytest.raises(tool.ImuError):
        read_payload(tmp_path, payload)


@pytest.mark.parametrize('table_id,table_size', [(1, 30), (0, 29), (0, 0xffffffff), (0, 60000)])
def test_invalid_offset_table(tmp_path, table_id, table_size):
    payload = bytearray(synthetic_container())
    struct.pack_into('<BBI', payload, len(payload) - 78, 4, table_id, table_size)
    with pytest.raises(tool.ImuError, match='偏移表'):
        read_payload(tmp_path, payload)


@pytest.mark.parametrize('change', [dict(offset=0xffffffff), dict(size=0xffffffff),
                                    dict(offset=0), dict(size=1), dict(block_format=99)])
def test_block_boundary_and_header_validation(tmp_path, change):
    payload = change_entry(synthetic_container(), 3, **change)
    with pytest.raises(tool.ImuError):
        read_payload(tmp_path, payload)


@pytest.mark.parametrize('part,value', [(0, 99), (1, 9), (2, 81)])
def test_physical_block_header_must_match(tmp_path, part, value):
    payload = bytearray(synthetic_container())
    extra_start, _, _ = table_info(payload)
    entry = struct.unpack_from('<BBII', payload, entry_location(payload, 3))
    position = extra_start + entry[3] + entry[2]
    header = list(struct.unpack_from('<BBI', payload, position))
    header[part] = value
    struct.pack_into('<BBI', payload, position, *header)
    with pytest.raises(tool.ImuError, match='不匹配'):
        read_payload(tmp_path, payload)


def test_duplicate_table_entry(tmp_path):
    payload = bytearray(synthetic_container())
    gyro_position = entry_location(payload, 3)
    metadata_position = entry_location(payload, 1)
    payload[metadata_position:metadata_position + 10] = payload[gyro_position:gyro_position + 10]
    with pytest.raises(tool.ImuError, match='重复'):
        read_payload(tmp_path, payload)


def test_overlapping_blocks_rejected(tmp_path):
    payload = synthetic_container()
    extra_start, _, _ = table_info(payload)
    _, _, gyro_size, gyro_offset = struct.unpack_from('<BBII', payload, entry_location(payload, 3))
    payload = bytearray(change_entry(payload, 9, block_format=7, size=4, offset=gyro_offset))
    struct.pack_into('<BBI', payload, extra_start + gyro_offset + 4, 7, 9, 4)
    with pytest.raises(tool.ImuError, match='重叠'):
        read_payload(tmp_path, payload)


@pytest.mark.parametrize('meta,raw,message', [(None, gyro(), 'metadata'), (metadata(), None, 'gyro'),
                                            (b'', gyro(), 'metadata'), (metadata(), b'', 'gyro')])
def test_missing_or_empty_required_blocks(tmp_path, meta, raw, message):
    with pytest.raises(tool.ImuError, match=message):
        read_payload(tmp_path, synthetic_container(meta, raw))


@pytest.mark.parametrize('tag', [2, 24, 28, 29, 62, 65])
def test_missing_metadata_fields(tmp_path, tag):
    with pytest.raises(tool.ImuError, match='缺少'):
        read_payload(tmp_path, synthetic_container(metadata(omit=(tag,))))


@pytest.mark.parametrize('config', [b'', integer(1, 32), integer(2, 2000)])
def test_missing_range_fields(tmp_path, config):
    with pytest.raises(tool.ImuError, match='量程'):
        read_payload(tmp_path, synthetic_container(metadata({65: blob(65, config)})))


@pytest.mark.parametrize('acc_range,gyro_range', [(0, 2000), (257, 2000), (32, 0), (32, 16001),
                                                (1 << 32, 2000), (32, 1 << 32)])
def test_unreasonable_ranges(tmp_path, acc_range, gyro_range):
    config = integer(1, acc_range) + integer(2, gyro_range)
    with pytest.raises(tool.ImuError, match='量程'):
        read_payload(tmp_path, synthetic_container(metadata({65: blob(65, config)})))


@pytest.mark.parametrize('value', [math.nan, math.inf, -math.inf])
@pytest.mark.parametrize('has_offset', [0, 1])
def test_nonfinite_timestamp_metadata(tmp_path, value, has_offset):
    meta = metadata({28: double(28, value), 29: integer(29, has_offset)})
    with pytest.raises(tool.ImuError, match='有限值'):
        read_payload(tmp_path, synthetic_container(meta))


@pytest.mark.parametrize('tag', [29, 62])
def test_invalid_boolean(tmp_path, tag):
    with pytest.raises(tool.ImuError, match='bool'):
        read_payload(tmp_path, synthetic_container(metadata({tag: integer(tag, 2)})))


@pytest.mark.parametrize('value', [b'', b' ', b'\xff', b'camera\nprivate', b'x' * 257])
def test_invalid_camera_type(tmp_path, value):
    with pytest.raises(tool.ImuError, match='camera_type'):
        read_payload(tmp_path, synthetic_container(metadata({2: blob(2, value)})))


@pytest.mark.parametrize('suffix', [b'\x80', b'\x00', b'\x0f', b'\x0b', b'\x08' + b'\x80' * 10,
                                    b'\x08' + b'\xff' * 9 + b'\x02',
                                    b'\x0a\xff\xff\x7f', b'\x09\x01', b'\x0d\x01',
                                    varint((1 << 29) << 3) + b'\x00'])
def test_malformed_protobuf(tmp_path, suffix):
    with pytest.raises(tool.ImuError, match='protobuf'):
        read_payload(tmp_path, synthetic_container(metadata() + suffix))


@pytest.mark.parametrize('meta', [metadata({24: double(24, 1)}), metadata() + integer(24, 2),
                                 metadata({65: blob(65, integer(1, 32) * 2 + integer(2, 2000))}),
                                 metadata({65: blob(65, double(1, 32) + integer(2, 2000))})])
def test_wrong_wire_type_and_duplicate_required_fields(tmp_path, meta):
    with pytest.raises(tool.ImuError, match='类型错误或重复'):
        read_payload(tmp_path, synthetic_container(meta))


@pytest.mark.parametrize('constant', ['MAX_METADATA_BYTES', 'MAX_CONFIG_BYTES', 'MAX_TABLE_BYTES'])
def test_metadata_lengths_are_bounded(tmp_path, monkeypatch, constant):
    monkeypatch.setattr(tool, constant, 1)
    with pytest.raises(tool.ImuError):
        read_payload(tmp_path, synthetic_container())


def test_nonraw_explicitly_refused(tmp_path):
    nonraw = struct.pack('<Q6d', 1_000_000, 1, 2, 3, 4, 5, 6)
    with pytest.raises(tool.ImuError, match='非 raw.*单位和时间基准'):
        read_payload(tmp_path, synthetic_container(metadata({62: integer(62, 0)}), nonraw))


@pytest.mark.parametrize('raw', [gyro()[:-1], gyro() + b'\0', bytes(19), bytes(21)])
def test_incomplete_raw_records(tmp_path, raw):
    with pytest.raises(tool.ImuError, match='完整'):
        read_payload(tmp_path, synthetic_container(raw=raw))


@pytest.mark.parametrize('timestamps', [(1000, 1000), (2000, 1000), (1000, 2000, 2000),
                                       (1000, 2000, 1500), ((1 << 64) - 1, 0)])
def test_timestamps_strictly_increasing_across_chunks(tmp_path, monkeypatch, timestamps):
    monkeypatch.setattr(tool, 'CHUNK_RECORDS', 2)
    with pytest.raises(tool.ImuError, match='严格递增'):
        read_payload(tmp_path, synthetic_container(raw=gyro(timestamps)))


def test_chunked_result_matches_single_chunk(source, monkeypatch):
    expected = tool.read_insv_imu(source)
    monkeypatch.setattr(tool, 'CHUNK_RECORDS', 1)
    actual = tool.read_insv_imu(source)
    for name in ('times', 'acceleration', 'angular_velocity'):
        np.testing.assert_array_equal(getattr(actual, name), getattr(expected, name))


def test_memory_budget_checked_before_allocating(source, monkeypatch):
    assert tool.MAX_GYRO_MEMORY_BYTES <= 256 * 1024 * 1024
    budget = len(TIMESTAMPS) * tool.WORKING_BYTES_PER_SAMPLE + tool.CHUNK_RESERVE_BYTES - 1
    monkeypatch.setattr(tool, 'MAX_GYRO_MEMORY_BYTES', budget)
    def forbidden(*args, **kwargs):
        pytest.fail('oversized gyro must be rejected before allocating arrays')
    monkeypatch.setattr(tool.np, 'empty', forbidden)
    with pytest.raises(tool.ImuError, match='内存预算'):
        tool.read_insv_imu(source)


def test_finite_but_unrepresentable_timebase_refused(tmp_path):
    meta = metadata({28: double(28, 1e300)})
    with pytest.raises(tool.ImuError, match='浮点精度'):
        read_payload(tmp_path, synthetic_container(meta))


@pytest.mark.parametrize('directory', [False, True])
def test_unreadable_path_uses_imu_error(tmp_path, directory):
    path = tmp_path if directory else tmp_path / 'missing.insv'
    with pytest.raises(tool.ImuError, match='只读'):
        tool.read_insv_imu(path)


def test_only_input_is_opened_readonly(source, monkeypatch):
    before = source.read_bytes()
    original = Path.open
    def guarded(path, mode='r', *args, **kwargs):
        assert path == source and mode == 'rb'
        return original(path, mode, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', guarded)
        assert tool.read_insv_imu(source).times.size == 4
    assert source.read_bytes() == before


def test_cli_summary_does_not_write(source, capsys):
    before = source.read_bytes()
    existing = set(source.parent.iterdir())
    assert tool.main([str(source)]) == 0
    output = capsys.readouterr()
    assert json.loads(output.out)['sample_count'] == 4
    assert not output.err and 'PRIVATE' not in output.out
    assert set(source.parent.iterdir()) == existing
    assert source.read_bytes() == before


def test_cli_csv_units_and_header(source, capsys):
    destination = source.parent / 'IMU 输出.csv'
    assert tool.main([str(source), '-o', str(destination)]) == 0
    with destination.open(encoding='utf-8', newline='') as stream:
        rows = list(csv.reader(stream))
    assert rows[0] == ['t_s', 'ax_g', 'ay_g', 'az_g', 'gx_rad_s', 'gy_rad_s', 'gz_rad_s']
    imu = tool.read_insv_imu(source)
    expected = np.column_stack((imu.times, imu.acceleration, imu.angular_velocity))
    np.testing.assert_allclose(np.array(rows[1:], dtype=float), expected)
    assert json.loads(capsys.readouterr().out)['sample_rate_hz'] == pytest.approx(1000)


@pytest.mark.parametrize('source_as_output', [False, True])
def test_existing_output_never_overwritten(source, source_as_output, capsys):
    destination = source if source_as_output else source.parent / 'exists.csv'
    if not source_as_output:
        destination.write_bytes(b'keep me')
    before = destination.read_bytes()
    assert tool.main([str(source), '-o', str(destination)]) == 1
    assert destination.read_bytes() == before
    assert '不会覆盖' in capsys.readouterr().err


@pytest.mark.parametrize('failure', [OSError('write failed'), KeyboardInterrupt()])
def test_failed_csv_write_removes_only_new_partial_output(source, monkeypatch, failure, capsys):
    destination = source.parent / 'partial.csv'
    original_writer = tool.csv.writer
    class BrokenWriter:
        def __init__(self, output):
            self.writer = original_writer(output)
            self.rows = 0

        def writerow(self, row):
            self.writer.writerow(row)
            self.rows += 1
            if self.rows == 2:
                raise failure
    monkeypatch.setattr(tool.csv, 'writer', BrokenWriter)
    assert tool.main([str(source), '-o', str(destination)]) == (130 if isinstance(failure, KeyboardInterrupt) else 1)
    assert not destination.exists()
    assert source.read_bytes() == synthetic_container()
    assert capsys.readouterr().err


def test_invalid_input_does_not_create_csv(source, capsys):
    source.write_bytes(b'broken')
    destination = source.parent / 'not-created.csv'
    assert tool.main([str(source), '-o', str(destination)]) == 1
    assert not destination.exists()
    assert capsys.readouterr().err


def test_real_module_cli_help():
    result = subprocess.run([sys.executable, '-m', 'tools.x4_imu', '--help'],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, check=False)
    assert result.returncode == 0
    assert b'INPUT' in result.stdout and b'OUTPUT.csv' in result.stdout
    assert not result.stderr

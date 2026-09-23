import copy
from fractions import Fraction
import json
import math
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from tools import x4_imu_predict as tool


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, allow_nan=True), encoding='utf-8')
    return path


def sample(time_s, yaw=0):
    return [time_s, *Rotation.from_euler('y', yaw, degrees=True).as_quat().tolist(), 25.0, 1.0]


def event(target='person-a', box=None, label='person', view='back'):
    return dict(target_id=target, label=label, view=view, box=box or [400, 250, 600, 750])


@pytest.fixture
def local(tmp_path, monkeypatch):
    video = tmp_path / '本地 视频.mp4'
    video.write_bytes(b'local synthetic video identity; metadata is patched, not decoded')
    identity = dict(size=video.stat().st_size, fingerprint=tool.fingerprint(video))
    metadata = tool.VideoMetadata(3840, 1920, 0.0, 8.0)
    monkeypatch.setattr(tool, 'video_metadata', lambda path: metadata)
    sidecar = dict(version=1, camera='Insta360 X4', video={**identity, 'name': video.name, 'duration': 8},
                   calibration=dict(accepted=True, mapping=[2, -3, 1], offset_s=0.08,
                                    axis_separation=0.2, baseline_error=10.0, compensated_error=5.0,
                                    improvement=0.5, pairs=12, calibration_pairs=24),
                   samples=[sample(i / 40) for i in range(161)])
    annotations = dict(version=1, video=identity.copy(), heading_deg=0, provenance='local_manual_boxes',
                       sequences=[dict(name='manual-rear', frames=[
                           dict(time_s=1.0, events=[event()]),
                           dict(time_s=2.0, events=[event(box=[400, 175, 600, 825])]),
                           dict(time_s=3.0, events=[event(box=[400, 90, 600, 910])]),
                       ])])
    return SimpleNamespace(video=video, identity=identity, metadata=metadata, sidecar=sidecar,
                           annotations=annotations, imu=tmp_path / 'imu.json',
                           boxes=tmp_path / 'boxes.json', output=tmp_path / 'output.json')


def save(local):
    write_json(local.imu, local.sidecar)
    write_json(local.boxes, local.annotations)


def replay(local):
    save(local)
    return tool.predict(local.video, local.imu, local.boxes)


def cli(local):
    return [str(local.video), '--imu', str(local.imu), '--observations', str(local.boxes), '-o', str(local.output)]


def moving_rear(local, sign=1):
    # A reference ray starts at -155 degrees. A -25 deg/s camera yaw carries it
    # through the back face. Visual-only association exceeds the 20 degree gate.
    local.sidecar['samples'] = [sample(i / 40, sign * -25 * (i / 40 - 1)) for i in range(161)]
    for index, height in enumerate((500, 650, 820)):
        x = round(500 + 500 * math.tan(math.radians(25 - 25 * index)))
        local.annotations['sequences'][0]['frames'][index]['events'][0]['box'] = [
            x - 100, 500 - height // 2, x + 100, 500 + height // 2]


def test_real_backend_imu_changes_history_speed_approaching_and_score(local):
    moving_rear(local)
    report = replay(local)
    frames = report['sequences'][0]['frames']
    assert [f['vision'][0]['history_length'] for f in frames] == [1, 1, 1]
    assert [f['vision_imu'][0]['history_length'] for f in frames] == [1, 2, 3]
    assert all(f['vision'][0]['speed'] is None for f in frames)
    assert frames[-1]['vision_imu'][0]['speed'] > 0
    assert not frames[-1]['vision'][0]['approaching']
    assert frames[-1]['vision_imu'][0]['approaching']
    assert frames[-1]['vision_imu'][0]['risk_score'] == 160
    assert frames[-1]['vision_imu'][0]['risk_score'] > frames[-1]['vision'][0]['risk_score']
    assert report['summary']['observation_count'] == 3
    assert report['summary']['frame_count'] == report['summary']['imu_valid_frame_count'] == 3
    assert report['summary']['vision']['three_frame_history_count'] == 0
    assert report['summary']['vision_imu'] == dict(observation_count=3, speed_available_count=2,
                                                continuous_history_count=2, three_frame_history_count=1,
                                                approaching_count=1)
    assert set(frames[-1]['vision_imu'][0]) == {
        'label', 'view', 'box', 'speed', 'approaching', 'risk_score', 'history_length'}


def test_wrong_pose_does_not_manufacture_improved_association(local):
    moving_rear(local, sign=-1)
    report = replay(local)
    assert report['summary']['vision_imu']['three_frame_history_count'] == 0
    assert report['summary']['vision_imu']['approaching_count'] == 0
    assert report['association_evaluation'] == 'not_evaluated'


def test_manual_id_switch_is_not_reported_as_correct_tracking(local):
    # Deliberately misassociated same-position people can have three scale samples.
    # A timestamp/window-length heuristic must not count this as correct tracking.
    for i, frame in enumerate(local.annotations['sequences'][0]['frames']):
        frame['events'][0]['target_id'] = f'different-person-{i}'
    report = replay(local)
    assert report['summary']['vision']['three_frame_history_count'] == 1
    assert report['association_evaluation'] == 'not_evaluated'
    encoded = json.dumps(report, ensure_ascii=False)
    assert 'accuracy' not in encoded and 'correct_count' not in encoded and 'incorrect_count' not in encoded
    assert '历史长度不代表关联正确' in encoded
    assert '持有者运动' in encoded and '碰撞预测精度' in encoded and '距离或运动真值' in encoded
    assert [f['annotations'][0]['target_id'] for f in report['sequences'][0]['frames']] == [
        'different-person-0', 'different-person-1', 'different-person-2']


@pytest.mark.parametrize('heading', [-180, -90, 0, 90, 180])
def test_identical_results_actual_media_time_heading_and_no_target_ids_reach_backend(local, monkeypatch, heading):
    local.annotations['heading_deg'] = heading
    captured, instances = [], []
    real = tool.SpatialSessions

    class TracedSessions(real):
        def __init__(self):
            super().__init__()
            instances.append(self)

        def process(self, meta, result, width, height, settings, now, *, imu_pose=None):
            assert 'target_id' not in result.model_dump_json()
            assert all(e.direction == 'unknown' and e.category == tool.LABELS[e.label][0] for e in result.events)
            assert settings == tool.Settings() and (width, height) == (3840, 1920)
            captured.append((self, meta, result, now, imu_pose))
            return super().process(meta, result, width, height, settings, now, imu_pose=imu_pose)

    monkeypatch.setattr(tool, 'SpatialSessions', TracedSessions)
    local.sidecar['samples'] = [sample(i / 40, 11) for i in range(161)]
    replay(local)
    assert len(instances) == 2 and instances[0] is not instances[1]
    for i in range(3):
        a, b = captured[2 * i:2 * i + 2]
        assert a[0] is not b[0] and a[2] is b[2]
        assert a[1].heading_deg == b[1].heading_deg == heading
        assert a[3] == b[3] == b[4].time_s == i + 1.0
        assert a[4] is None and b[4].recording_id == local.identity['fingerprint']
        # mapping [2,-3,1] / offset 0.08 are metadata, already applied to samples.
        np.testing.assert_allclose(b[4].quaternion, sample(0, 11)[1:5], atol=1e-12)


def test_each_sequence_uses_fresh_sessions_and_does_not_join_time_ranges(local):
    second = copy.deepcopy(local.annotations['sequences'][0])
    second['name'] = 'second-sequence'
    local.annotations['sequences'].append(second)
    report = replay(local)
    assert report['summary']['frame_count'] == 6
    assert report['summary']['vision']['three_frame_history_count'] == 2
    for sequence in report['sequences']:
        assert sequence['frames'][0]['vision'][0]['history_length'] == 1
        assert sequence['frames'][0]['vision_imu'][0]['history_length'] == 1


def test_current_event_identity_not_event_order_selects_history(local):
    for i, frame in enumerate(local.annotations['sequences'][0]['frames']):
        frame['events'].append(event(target='bollard-a', label='bollard', view='front',
                                     box=[0 if i == 0 else 1, 100, 100, 350]))
    report = replay(local)
    for mode in ('vision', 'vision_imu'):
        for frame in report['sequences'][0]['frames']:
            assert {e['label'] for e in frame[mode]} == {'person', 'bollard'}
        last = {e['label']: e for e in report['sequences'][0]['frames'][-1][mode]}
        assert last['person']['history_length'] == last['bollard']['history_length'] == 3


def test_filtered_events_are_visible_as_count_difference_not_fake_predictions(local):
    local.annotations['sequences'][0]['frames'][0]['events'].append(event(target='carrier', view='down'))
    report = replay(local)
    frame = report['sequences'][0]['frames'][0]
    assert len(frame['annotations']) == 2
    assert len(frame['vision']) == len(frame['vision_imu']) == 1
    assert report['summary']['observation_count'] == 4
    assert report['summary']['vision']['observation_count'] == 3


def test_pose_interpolation_bounds_gap_boundaries_and_no_reapplied_offset(local):
    local.sidecar['samples'] = [sample(1.0, 0), sample(1.05, 10), sample(1.2, 20), sample(1.225, 30)]
    save(local)
    sidecar = tool.load_sidecar(local.imu, local.identity)
    pose, reason = sidecar.pose_at(1.025)
    assert reason == 'valid' and pose.time_s == 1.025
    np.testing.assert_allclose(pose.quaternion, sample(0, 5)[1:5], atol=1e-12)
    for t in (0.99, 1.226):
        assert sidecar.pose_at(t) == (None, 'outside_imu_range')
    assert sidecar.pose_at(1.1) == (None, 'interpolation_gap')
    assert sidecar.pose_at(1.05)[1] == 'valid'
    assert sidecar.pose_at(1.2)[1] == 'valid'
    assert sidecar.pose_at(1.2, 1.05) == (None, 'frame_interval_gap')
    assert sidecar.pose_at(1.225, 1.2)[1] == 'valid'


def test_gap_hidden_between_valid_endpoints_disables_pose_for_whole_frame_interval(local):
    # Both frame endpoints have dense neighboring samples, but the middle is missing.
    local.sidecar['samples'] = [row for row in local.sidecar['samples'] if not 1.3 < row[0] < 1.6]
    report = replay(local)
    frames = report['sequences'][0]['frames']
    assert [frame['imu_status'] for frame in frames] == ['valid', 'frame_interval_gap', 'valid']
    assert report['summary']['imu_valid_frame_count'] == 2
    assert frames[1]['imu_valid'] is False
    assert report['summary']['vision_imu']['three_frame_history_count'] == 0


def test_outside_imu_range_keeps_visual_replay_and_empty_frames_count(local):
    local.sidecar['samples'] = [row for row in local.sidecar['samples'] if 1.5 <= row[0] <= 2.5]
    local.annotations['sequences'][0]['frames'][0]['events'] = []
    report = replay(local)
    frames = report['sequences'][0]['frames']
    assert [frame['imu_status'] for frame in frames] == ['outside_imu_range', 'valid', 'outside_imu_range']
    assert report['summary']['frame_count'] == 3 and report['summary']['observation_count'] == 2
    assert report['summary']['imu_valid_frame_count'] == 1


@pytest.mark.parametrize('accepted', [False, None, 0, 1, 'true', [], {}])
def test_reject_unaccepted_calibration(local, accepted):
    local.sidecar['calibration']['accepted'] = accepted
    save(local)
    with pytest.raises(tool.PredictError, match='标定未通过'):
        tool.load_sidecar(local.imu, local.identity)


@pytest.mark.parametrize('source', ['sidecar', 'annotations'])
@pytest.mark.parametrize('field,value', [('size', 999), ('size', True), ('size', 1.5), ('size', 0),
                                        ('fingerprint', '0' * 64), ('fingerprint', 'z' * 64),
                                        ('fingerprint', 'a' * 63), ('fingerprint', None)])
def test_video_identity_mismatch_is_rejected(local, source, field, value):
    getattr(local, source)['video'][field] = value
    save(local)
    with pytest.raises(tool.PredictError, match='video'):
        if source == 'sidecar':
            tool.load_sidecar(local.imu, local.identity)
        else:
            tool.load_observations(local.boxes, local.identity, local.metadata)


@pytest.mark.parametrize('samples', [[], [sample(0)], [[0, 0, 0, 0, 1]],
                                     [sample(0), sample(0)], [sample(1), sample(0)],
                                     [[0, 0, 0, 0, 2, 0, 1], sample(0.025)],
                                     [[0, 0, 0, 0, 0, 0, 1], sample(0.025)],
                                     [[0, True, 0, 0, 1, 0, 1], sample(0.025)],
                                     [[0, 0, 0, 0, 1, -1, 1], sample(0.025)]])
def test_invalid_samples_are_rejected(local, samples):
    local.sidecar['samples'] = samples
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_sidecar(local.imu, local.identity)


@pytest.mark.parametrize('mapping', [[1, 1, 3], [0, 2, 3], [True, 2, 3], [1, 2], 'xyz', [1.0, 2, 3]])
def test_invalid_axis_mapping_rejected(local, mapping):
    local.sidecar['calibration']['mapping'] = mapping
    save(local)
    with pytest.raises(tool.PredictError, match='mapping'):
        tool.load_sidecar(local.imu, local.identity)


@pytest.mark.parametrize('source', ['sidecar', 'annotations'])
@pytest.mark.parametrize('version', [0, 2, True, '1', 1.0])
def test_strict_version(local, source, version):
    getattr(local, source)['version'] = version
    save(local)
    with pytest.raises(tool.PredictError, match='version'):
        if source == 'sidecar':
            tool.load_sidecar(local.imu, local.identity)
        else:
            tool.load_observations(local.boxes, local.identity, local.metadata)


@pytest.mark.parametrize('heading', [-181, 181, 2.5, True, '0', None, math.nan, math.inf])
def test_invalid_heading_rejected(local, heading):
    local.annotations['heading_deg'] = heading
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_observations(local.boxes, local.identity, local.metadata)


@pytest.mark.parametrize('times', [[1, 1, 2], [1, 0.5, 2], [-0.1, 1, 2], [1, 2, 8],
                                   [1, 2, 9], [True, 1, 2], ['0', 1, 2], [0, 1, math.nan]])
def test_invalid_annotation_time_domain(local, times):
    for frame, t in zip(local.annotations['sequences'][0]['frames'], times):
        frame['time_s'] = t
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_observations(local.boxes, local.identity, local.metadata)


def test_nonzero_media_start_is_not_rebased(local):
    save(local)
    with pytest.raises(tool.PredictError, match='时间域'):
        tool.load_observations(local.boxes, local.identity, tool.VideoMetadata(3840, 1920, 2, 8))


@pytest.mark.parametrize('box', [None, [], [0, 0, 1], [0, 0, 1001, 1000], [-1, 0, 10, 10],
                                 [10, 0, 10, 50], [50, 0, 10, 50], [0, 50, 50, 10],
                                 [0, 0, True, 50], [0, 0, '50', 50], [0, 0, math.inf, 50],
                                 [10.1, 20, 10.2, 30]])
def test_bad_boxes_are_errors_not_silent_drops(local, box):
    local.annotations['sequences'][0]['frames'][0]['events'][0]['box'] = box
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_observations(local.boxes, local.identity, local.metadata)


@pytest.mark.parametrize('field,value', [('label', 'sign'), ('label', 'text'), ('label', 'unknown'),
                                        ('label', []), ('view', 'erp'), ('view', None),
                                        ('target_id', ''), ('target_id', 123), ('target_id', 'a\nb'),
                                        ('category', 'obstacle'), ('confidence', 0.8)])
def test_bad_events_and_extra_model_fields_rejected(local, field, value):
    local.annotations['sequences'][0]['frames'][0]['events'][0][field] = value
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_observations(local.boxes, local.identity, local.metadata)


@pytest.mark.parametrize('mutation', ['duplicate_id', 'too_many_events', 'too_many_frames', 'total_frames',
                                     'duplicate_name', 'bad_name', 'empty_frames', 'empty_sequences',
                                     'provenance', 'extra_root'])
def test_annotation_structure_limits(local, mutation):
    sequence = local.annotations['sequences'][0]
    frame = sequence['frames'][0]
    if mutation == 'duplicate_id':
        frame['events'] *= 2
    elif mutation == 'too_many_events':
        frame['events'] = [event(target=str(i)) for i in range(13)]
    elif mutation == 'too_many_frames':
        sequence['frames'] = [frame] * 10001
    elif mutation == 'total_frames':
        sequence['frames'] = [dict(time_s=i / 1000, events=[]) for i in range(6000)]
        local.annotations['sequences'].append(dict(name='second', frames=sequence['frames']))
    elif mutation == 'duplicate_name':
        local.annotations['sequences'].append(copy.deepcopy(sequence))
    elif mutation == 'bad_name':
        sequence['name'] = 'not/ascii 中文'
    elif mutation == 'empty_frames':
        sequence['frames'] = []
    elif mutation == 'empty_sequences':
        local.annotations['sequences'] = []
    elif mutation == 'provenance':
        local.annotations['provenance'] = 'cloud_model'
    else:
        local.annotations['api_key'] = 'not-accepted'
    save(local)
    with pytest.raises(tool.PredictError):
        tool.load_observations(local.boxes, local.identity, local.metadata)


def test_exact_frame_event_and_box_boundaries(local):
    frames = [dict(time_s=i / 2000, events=[]) for i in range(10000)]
    frames[0]['events'] = [event(target=str(i), label='bollard', box=[0, 0, 1000, 1000]) for i in range(12)]
    local.annotations['sequences'][0]['frames'] = frames
    save(local)
    validated = tool.load_observations(local.boxes, local.identity, local.metadata)
    assert len(validated['sequences'][0]['frames']) == 10000
    assert len(validated['sequences'][0]['frames'][0]['events']) == 12


@pytest.mark.parametrize('payload', [b'', b'[] trailing', b'{"x":1,"x":2}', b'{"x":NaN}',
                                     b'{"x":Infinity}', b'{"x":-Infinity}', b'{"x":1e999}',
                                     b'\xff', b'[' * 2000 + b']' * 2000],
                         ids=['empty', 'trailing', 'duplicate', 'nan', 'inf', 'negative-inf',
                              'overflow', 'encoding', 'nested-nonobject'])
def test_json_syntax_finite_duplicate_and_encoding_boundaries(tmp_path, payload):
    path = tmp_path / 'input.json'
    path.write_bytes(payload)
    with pytest.raises(tool.PredictError):
        tool.read_json(path)


def test_json_10mib_boundary_and_bounded_read(tmp_path, monkeypatch):
    path = tmp_path / 'input.json'
    path.write_bytes(b'{}' + b' ' * (tool.MAX_JSON_BYTES - 2))
    assert tool.read_json(path) == {}
    with path.open('ab') as stream:
        stream.write(b' ')
    with pytest.raises(tool.PredictError, match='10MiB'):
        tool.read_json(path)
    # Even if stat races with a growing input, read at most limit+1 bytes.
    original = Path.stat

    def smaller_stat(self, *args, **kwargs):
        stat = original(self, *args, **kwargs)
        return SimpleNamespace(st_size=2, st_mode=stat.st_mode) if self == path else stat

    monkeypatch.setattr(Path, 'stat', smaller_stat)
    with pytest.raises(tool.PredictError, match='10MiB'):
        tool.read_json(path)


def test_cli_writes_real_report_exclusively_without_cloud_env_or_speech(local, monkeypatch, capsys):
    import backend.rules
    import backend.vision
    import dotenv

    def forbidden(*args, **kwargs):
        pytest.fail('offline replay must not use cloud, environment loading, or speech')

    monkeypatch.setattr(backend.vision, 'observe_walk', forbidden)
    monkeypatch.setattr(backend.rules, 'summarize_walk', forbidden)
    monkeypatch.setattr(dotenv, 'load_dotenv', forbidden)
    original = Path.open
    writes = []

    def guarded(self, mode='r', *args, **kwargs):
        assert self.name != '.env'
        if self == local.output:
            writes.append(mode)
            assert mode == 'x'
        return original(self, mode, *args, **kwargs)

    save(local)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', guarded)
        assert tool.main(cli(local)) == 0
    assert writes == ['x']
    report = json.loads(local.output.read_text(encoding='utf-8'))
    assert json.loads(capsys.readouterr().out)['summary'] == report['summary']
    assert report['summary']['vision_imu']['three_frame_history_count'] == 1
    assert 'speech' not in report


def test_existing_output_rejected_before_reading_inputs(local):
    local.output.write_bytes(b'keep')
    with pytest.raises(SystemExit):
        tool.main(cli(local))
    assert local.output.read_bytes() == b'keep'


def test_output_parent_is_not_created(local):
    local.output = local.output.parent / 'missing' / 'out.json'
    with pytest.raises(SystemExit):
        tool.main(cli(local))
    assert not local.output.parent.exists()


def test_exclusive_output_closes_check_write_race(local, monkeypatch):
    real = tool.predict

    def racing(*args, **kwargs):
        report = real(*args, **kwargs)
        local.output.write_bytes(b'other writer won')
        return report

    save(local)
    monkeypatch.setattr(tool, 'predict', racing)
    with pytest.raises(SystemExit) as error:
        tool.main(cli(local))
    assert error.value.code == 1
    assert local.output.read_bytes() == b'other writer won'


def test_invalid_input_does_not_create_output(local):
    local.sidecar['calibration']['accepted'] = False
    save(local)
    with pytest.raises(SystemExit):
        tool.main(cli(local))
    assert not local.output.exists()


@pytest.mark.parametrize('width,height,duration,start,valid', [(64, 32, 100, 20, True),
                                                            (64, 64, 100, 0, False),
                                                            (64, 0, 100, 0, False),
                                                            (64, 32, 0, 0, False)])
def test_video_metadata_erp_and_actual_pts_without_decode(monkeypatch, tmp_path, width, height, duration, start, valid):
    stream = SimpleNamespace(width=width, height=height, duration=duration, start_time=start, time_base=Fraction(1, 10))

    class Container:
        streams = SimpleNamespace(video=[stream])
        duration = None
        start_time = None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def decode(self, *args):
            pytest.fail('metadata inspection must not decode')

    def open_local(path, *, options):
        assert Path(path).is_absolute()
        assert options['protocol_whitelist'] == 'file'
        return Container()

    monkeypatch.setattr(tool.av, 'open', open_local)
    if valid:
        assert tool.video_metadata(tmp_path / 'metadata-only.mp4') == tool.VideoMetadata(64, 32, 2, 12)
    else:
        with pytest.raises(tool.PredictError):
            tool.video_metadata(tmp_path / 'metadata-only.mp4')


def test_module_help_does_not_import_app_read_env_or_connect():
    # A fresh interpreter catches imports hidden by the pytest process's module cache.
    script = '''
import sys

def audit(name, args):
    if name == 'import' and args[0] == 'backend.app':
        raise AssertionError('backend.app forbidden')
    if name == 'open' and str(args[0]).replace('\\\\', '/').split('/')[-1] == '.env':
        raise AssertionError('.env forbidden')
    if name == 'socket.connect':
        raise AssertionError('network forbidden')

sys.addaudithook(audit)
from tools.x4_imu_predict import main
main(['--help'])
'''
    result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1],
                            capture_output=True, check=False)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    assert b'--imu' in result.stdout and b'--observations' in result.stdout

import hashlib
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from tools import x4_imu_compare as tool
from tools.x4_imu import ImuError


def image(shift=0):
    x, y = np.meshgrid(np.arange(320), np.arange(160))
    return np.rint(128 + 50 * np.sin(((x - shift) % 320) * np.pi / 20) + 30 * np.cos(y * np.pi / 16)).astype(np.uint8)


def test_spherical_rotation_cancels_known_camera_yaw():
    angle = 16 / 320 * 2 * np.pi
    before, after = image(), image(16)
    assert tool.photometric_error(before, after, Rotation.identity()) > 10
    assert tool.photometric_error(before, after, Rotation.from_rotvec([0, angle, 0])) < 1e-10
    assert tool.photometric_error(before, after, Rotation.from_rotvec([0, -angle, 0])) > 1


def test_quaternion_integration_and_video_time_interpolation():
    times = np.arange(0, 1.001, 0.001)
    velocity = np.tile([0, np.pi / 2, 0], (len(times), 1))
    poses = tool.integrate_quaternions(times, velocity)
    np.testing.assert_allclose(np.linalg.norm(poses, axis=1), 1, atol=1e-12)
    expected = Rotation.from_rotvec([0, np.pi / 4, 0]).as_matrix()
    np.testing.assert_allclose(tool.quaternion_at(times, poses, 0.5).as_matrix(), expected, atol=1e-12)
    with pytest.raises(ImuError):
        tool.quaternion_at(times, poses, 2)


def test_noncommuting_camera_rotations_use_body_increment_on_left():
    times = np.array([0, 1, 2])
    velocity = np.array([[0, 0, 0], [1, 0, 0], [-1, 1, 0]])
    poses = tool.integrate_quaternions(times, velocity)
    expected = Rotation.from_rotvec([0, 0.5, 0]) * Rotation.from_rotvec([0.5, 0, 0])
    np.testing.assert_allclose(Rotation.from_quat(poses[-1]).as_matrix(), expected.as_matrix(), atol=1e-12)


def test_signed_axis_candidates_and_integrated_velocity():
    mappings = list(tool.axis_maps())
    assert len(mappings) == 48
    assert len(set(tuple(m) for m in mappings)) == 48
    np.testing.assert_array_equal(tool.map_axes(np.array([1, 2, 3]), [2, -3, 1]), [2, -3, 1])
    imu = SimpleNamespace(times=np.array([0, 0.01, 0.02]), angular_velocity=np.ones((3, 3)))
    cumulative = tool.integrated_velocity(imu)
    np.testing.assert_allclose(tool.rotation_vector(imu.times, cumulative, 0.005, 0.015), [0.01] * 3)
    with pytest.raises(ImuError):
        tool.rotation_vector(imu.times, cumulative, -0.1, 0.01)
    imu.times[-1] = 0.1
    with pytest.raises(ImuError, match='缺口'):
        tool.integrated_velocity(imu)


def test_video_fingerprint_matches_browser_scheme(tmp_path):
    video = tmp_path / 'video.mp4'
    video.write_bytes(b'local-video')
    expected = hashlib.sha256(b'11local-videolocal-video').hexdigest()
    assert tool.fingerprint(video) == expected
    video.write_bytes(b'other-video')
    assert tool.fingerprint(video) != expected


def test_cli_refuses_existing_output_before_reading_inputs(tmp_path):
    target = tmp_path / 'imu.json'
    target.write_text('keep', encoding='utf-8')
    with pytest.raises(SystemExit):
        tool.main(['absent.insv', 'absent.mp4', '-o', str(target)])
    assert target.read_text(encoding='utf-8') == 'keep'

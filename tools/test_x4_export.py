from pathlib import Path
import signal
import struct
import subprocess
import sys
from types import SimpleNamespace

import pytest

from tools import x4_export as tool


def box(kind, payload=b'data'):
    return struct.pack('>I4s', len(payload) + 8, kind) + payload


def synthetic_container(width=3840, height=1920, handler=b'vide', duration=1000, count=1, version=0):
    tkhd = box(b'tkhd', bytes(12) + struct.pack('>I', 1) + bytes(60) + struct.pack('>II', width << 16, height << 16))
    if version == 0:
        mdhd = box(b'mdhd', bytes(12) + struct.pack('>II', 1000, duration) + bytes(4))
    else:
        mdhd = box(b'mdhd', b'\1' + bytes(19) + struct.pack('>IQ', 1000, duration) + bytes(4))
    hdlr = box(b'hdlr', bytes(8) + handler + bytes(12))
    stsz = box(b'stsz', bytes(4) + struct.pack('>II', 4, count))
    mdia = box(b'mdia', mdhd + hdlr + box(b'minf', box(b'stbl', stsz)))
    return box(b'ftyp', b'isom\0\0\0\0isom') + box(b'mdat') + box(b'moov', box(b'trak', tkhd + mdia))


MP4 = synthetic_container()
SDK_HELP = b'-inputs -output -output_size -stitch_type -bitrate -enable_flowstate -enable_h265_encoder'


@pytest.fixture
def sdk(tmp_path):
    directory = tmp_path / '官方 SDK' / 'bin'
    directory.mkdir(parents=True)
    executable = directory / 'MediaSDKTest.exe'
    executable.touch()
    (directory / 'MediaSDK.dll').touch()
    (directory / 'models').mkdir()
    return executable


@pytest.fixture
def source(tmp_path):
    path = tmp_path / '原始 录像.insv'
    path.write_bytes(b'original footage')
    return path


@pytest.fixture
def options():
    return SimpleNamespace(size='4k', codec='h264', bitrate=0, no_flowstate=False)


@pytest.mark.parametrize('location', ['root', 'bin', 'exe'])
def test_find_sdk_layout(sdk, location):
    path = {'root': sdk.parent.parent, 'bin': sdk.parent, 'exe': sdk}[location]
    assert tool.find_sdk(path) == sdk


def test_find_sdk_environment(sdk, monkeypatch):
    monkeypatch.setenv('INSTA360_MEDIA_SDK', str(sdk.parent.parent))
    assert tool.find_sdk() == sdk


def test_find_sdk_path(sdk, monkeypatch):
    monkeypatch.delenv('INSTA360_MEDIA_SDK', raising=False)
    monkeypatch.setattr(tool.shutil, 'which', lambda name: str(sdk))
    assert tool.find_sdk() == sdk


def test_missing_sdk(monkeypatch):
    monkeypatch.delenv('INSTA360_MEDIA_SDK', raising=False)
    monkeypatch.setattr(tool.shutil, 'which', lambda name: None)
    with pytest.raises(tool.ExportError, match='未找到 MediaSDKTest'):
        tool.find_sdk()


@pytest.mark.parametrize('missing', ['MediaSDK.dll', 'models'])
def test_incomplete_sdk(sdk, missing):
    path = sdk.parent / missing
    path.rmdir() if path.is_dir() else path.unlink()
    with pytest.raises(tool.ExportError, match='缺少'):
        tool.find_sdk(sdk)


def test_explicit_sdk_does_not_fall_back(sdk, tmp_path, monkeypatch):
    monkeypatch.setenv('INSTA360_MEDIA_SDK', str(sdk))
    with pytest.raises(tool.ExportError, match='未找到'):
        tool.find_sdk(tmp_path / 'wrong sdk')


def test_sdk_help_uses_own_directory(sdk, monkeypatch):
    def run(command, **kwargs):
        assert command == [str(sdk), '-help']
        assert kwargs == dict(cwd=sdk.parent, capture_output=True, timeout=30, check=False)
        return subprocess.CompletedProcess(command, 0, SDK_HELP, b'')
    monkeypatch.setattr(tool.subprocess, 'run', run)
    tool.check_sdk(sdk)


@pytest.mark.parametrize('returncode,output', [(1, SDK_HELP), (0, b'old SDK'), (3221225781, b'')])
def test_sdk_preflight_failure(sdk, monkeypatch, returncode, output):
    monkeypatch.setattr(tool.subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(a[0], returncode, output, b''))
    with pytest.raises(tool.ExportError, match='SDK 自检失败'):
        tool.check_sdk(sdk)


def test_sdk_help_timeout(sdk, monkeypatch):
    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 30)
    monkeypatch.setattr(tool.subprocess, 'run', run)
    with pytest.raises(tool.ExportError, match='自检超时'):
        tool.check_sdk(sdk)


def test_single_job_preserves_source(source, tmp_path):
    destination = tmp_path / '全景.mp4'
    assert tool.export_jobs(source, destination) == [(source, destination)]
    assert source.read_bytes() == b'original footage'


def test_batch_one_job_per_x4_air_file(tmp_path):
    directory = tmp_path / 'clips'
    directory.mkdir()
    for name in ['VID_02.insv', 'VID_01.INSV', 'preview.lrv', 'export.mp4']:
        (directory / name).write_bytes(b'clip')
    (directory / 'nested').mkdir()
    (directory / 'nested' / 'other.insv').write_bytes(b'clip')
    output = tmp_path / 'exports'
    jobs = tool.export_jobs(directory, output)
    assert [p.name for p, _ in jobs] == ['VID_01.INSV', 'VID_02.insv']
    assert [p.name for _, p in jobs] == ['VID_01_360.mp4', 'VID_02_360.mp4']
    assert not output.exists()


def test_existing_output_is_not_overwritten(source, tmp_path):
    output = tmp_path / 'exists.mp4'
    output.write_bytes(b'keep me')
    with pytest.raises(tool.ExportError, match='不会覆盖'):
        tool.export_jobs(source, output)
    assert output.read_bytes() == b'keep me'


def test_batch_checks_all_collisions_before_export(tmp_path):
    source = tmp_path / 'clips'
    source.mkdir()
    (source / 'a.insv').write_bytes(b'first')
    (source / 'b.insv').write_bytes(b'second')
    output = tmp_path / 'output'
    output.mkdir()
    (output / 'b_360.mp4').write_bytes(b'existing')
    with pytest.raises(tool.ExportError, match='不会覆盖'):
        tool.export_jobs(source, output)
    assert not (output / 'a_360.mp4').exists()


@pytest.mark.parametrize('suffix', ['.mp4', '.lrv', '.insp'])
def test_reject_non_insv(tmp_path, suffix):
    source = tmp_path / ('input' + suffix)
    source.write_bytes(b'clip')
    with pytest.raises(tool.ExportError, match='原始 .insv'):
        tool.export_jobs(source, tmp_path / 'out.mp4')


def test_empty_source(source, tmp_path):
    source.write_bytes(b'')
    with pytest.raises(tool.ExportError, match='输入文件为空'):
        tool.export_jobs(source, tmp_path / 'out.mp4')


def test_missing_source(tmp_path):
    with pytest.raises(tool.ExportError, match='输入路径不存在'):
        tool.export_jobs(tmp_path / 'missing.insv', tmp_path / 'out.mp4')


def test_empty_directory(tmp_path):
    with pytest.raises(tool.ExportError, match='没有 .insv'):
        tool.export_jobs(tmp_path, tmp_path / 'output')


def test_single_output_requires_mp4(source, tmp_path):
    with pytest.raises(tool.ExportError, match='以 .mp4 结尾'):
        tool.export_jobs(source, tmp_path / 'output')


def test_batch_output_requires_directory(source, tmp_path):
    with pytest.raises(tool.ExportError, match='输出路径必须是目录'):
        tool.export_jobs(source.parent, tmp_path / 'output.mp4')


def test_parent_file_rejected(source, tmp_path):
    parent = tmp_path / 'file'
    parent.write_bytes(b'keep')
    with pytest.raises(tool.ExportError, match='父路径不是目录'):
        tool.export_jobs(source, parent / 'out.mp4')


def test_sdk_command_keeps_unicode_spaces_and_single_input(sdk, source, tmp_path):
    destination = tmp_path / '全景 & 视频.mp4'
    command = tool.sdk_command(sdk, source, destination, '4k', 'h264', 0, True)
    assert command == [str(sdk), '-inputs', str(source), '-output', str(destination),
                       '-stitch_type', 'optflow', '-output_size', '3840x1920', '-bitrate', '0', '-enable_flowstate']
    assert '-enable_h265_encoder' not in command


def test_8k_h265_without_flowstate(sdk, source, tmp_path):
    command = tool.sdk_command(sdk, source, tmp_path / 'out.mp4', '8k', 'h265', 142000000, False)
    assert command[command.index('-output_size') + 1] == '7680x3840'
    assert command[command.index('-bitrate') + 1] == '142000000'
    assert '-enable_h265_encoder' in command
    assert '-enable_flowstate' not in command


def test_all_sizes_are_equirectangular():
    for size in tool.SIZES.values():
        width, height = map(int, size.split('x'))
        assert width == 2 * height


@pytest.mark.parametrize('payload', [MP4, synthetic_container(version=1),
                                    MP4 + struct.pack('>I4sQ', 1, b'free', 20) + b'data',
                                    MP4 + struct.pack('>I4s', 0, b'free') + b'data'])
def test_complete_container(tmp_path, payload):
    output = tmp_path / 'test.mp4'
    output.write_bytes(payload)
    tool.validate_mp4(output, (3840, 1920))


@pytest.mark.parametrize('payload', [b'', b'not an mp4', MP4[:-1], MP4 + b'xx',
                                    box(b'ftyp') + box(b'mdat'), struct.pack('>I4s', 4, b'ftyp'),
                                    struct.pack('>I4s', 1, b'ftyp'), box(b'ftyp') + box(b'moov') + box(b'mdat', b'')])
def test_incomplete_container_rejected(tmp_path, payload):
    output = tmp_path / 'test.mp4'
    output.write_bytes(payload)
    with pytest.raises(tool.ExportError):
        tool.validate_mp4(output, (3840, 1920))


@pytest.mark.parametrize('payload', [synthetic_container(width=1920), synthetic_container(handler=b'soun'),
                                    synthetic_container(duration=0), synthetic_container(count=0),
                                    box(b'ftyp') + box(b'mdat') + box(b'moov', box(b'udta'))])
def test_missing_or_wrong_video_track_rejected(tmp_path, payload):
    output = tmp_path / 'test.mp4'
    output.write_bytes(payload)
    with pytest.raises(tool.ExportError, match='视频轨'):
        tool.validate_mp4(output, (3840, 1920))


@pytest.mark.parametrize('track_id,count,flags,valid', [(1, 1, 0, True), (2, 1, 0, False),
                                                        (1, 0, 0, False), (1, 1, 0x100, False)])
def test_fragmented_sample_table(tmp_path, track_id, count, flags, valid):
    tfhd = box(b'tfhd', struct.pack('>II', 0, track_id))
    trun = box(b'trun', struct.pack('>II', flags, count))
    payload = synthetic_container(count=0) + box(b'moof', box(b'traf', tfhd + trun))
    output = tmp_path / 'fragmented.mp4'
    output.write_bytes(payload)
    if valid:
        tool.validate_mp4(output, (3840, 1920))
    else:
        with pytest.raises(tool.ExportError):
            tool.validate_mp4(output, (3840, 1920))


def test_missing_output_rejected(tmp_path):
    with pytest.raises(tool.ExportError, match='没有生成'):
        tool.validate_mp4(tmp_path / 'missing.mp4', (3840, 1920))


def test_export_stages_then_publishes(sdk, source, tmp_path, options, monkeypatch):
    destination = tmp_path / 'output folder' / '全景.mp4'
    def run(command, directory):
        assert directory == sdk.parent
        output = Path(command[command.index('-output') + 1])
        assert output.parent.parent == destination.parent
        assert output != destination
        assert not destination.exists()
        output.write_bytes(MP4)
        return 0
    monkeypatch.setattr(tool, 'run_sdk', run)
    tool.export_one(sdk, source, destination, options)
    assert destination.read_bytes() == MP4
    assert list(destination.parent.iterdir()) == [destination]
    assert source.read_bytes() == b'original footage'


@pytest.mark.parametrize('failure', ['sdk', 'invalid', 'missing', 'cancel'])
def test_failed_export_never_publishes(sdk, source, tmp_path, options, monkeypatch, failure):
    destination = tmp_path / 'output' / 'panorama.mp4'
    def run(command, directory):
        output = Path(command[command.index('-output') + 1])
        if failure != 'missing':
            output.write_bytes(b'partial')
        if failure == 'sdk':
            raise tool.ExportError('SDK failed')
        if failure == 'cancel':
            raise KeyboardInterrupt
    monkeypatch.setattr(tool, 'run_sdk', run)
    with pytest.raises((tool.ExportError, KeyboardInterrupt)):
        tool.export_one(sdk, source, destination, options)
    assert not destination.exists()
    assert list(destination.parent.iterdir()) == []
    assert source.read_bytes() == b'original footage'


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows no-replace rename semantics')
def test_destination_race_does_not_replace_existing(sdk, source, tmp_path, options, monkeypatch):
    destination = tmp_path / 'panorama.mp4'
    def run(command, directory):
        Path(command[command.index('-output') + 1]).write_bytes(MP4)
        destination.write_bytes(b'created by another process')
    monkeypatch.setattr(tool, 'run_sdk', run)
    with pytest.raises(FileExistsError):
        tool.export_one(sdk, source, destination, options)
    assert destination.read_bytes() == b'created by another process'
    assert not list(tmp_path.glob('.x4-export-*'))


def test_real_subprocess_success_and_failure(tmp_path):
    tool.run_sdk([sys.executable, '-c', 'pass'], tmp_path)
    with pytest.raises(tool.ExportError, match='退出码 7'):
        tool.run_sdk([sys.executable, '-c', 'raise SystemExit(7)'], tmp_path)


def test_interrupt_stops_child_before_return(tmp_path, monkeypatch):
    events = []
    class Process:
        def wait(self):
            events.append('wait')
            if len(events) == 1:
                raise KeyboardInterrupt
            return 1

        def poll(self):
            return None

        def terminate(self):
            events.append('terminate')

    def popen(command, **kwargs):
        assert kwargs == dict(cwd=tmp_path, stdin=subprocess.DEVNULL)
        return Process()
    monkeypatch.setattr(tool.subprocess, 'Popen', popen)
    with pytest.raises(KeyboardInterrupt):
        tool.run_sdk(['SDK.exe'], tmp_path)
    assert events == ['wait', 'terminate', 'wait']


def test_interrupt_during_spawn_stops_real_child(tmp_path, monkeypatch):
    popen = subprocess.Popen
    children = []
    previous_handler = signal.getsignal(signal.SIGINT)
    def start(command, **kwargs):
        child = popen(command, **kwargs)
        children.append(child)
        signal.raise_signal(signal.SIGINT)
        return child
    monkeypatch.setattr(tool.subprocess, 'Popen', start)
    try:
        with pytest.raises(KeyboardInterrupt):
            tool.run_sdk([sys.executable, '-c', 'import threading; threading.Event().wait(30)'], tmp_path)
        assert children[0].poll() is not None
        assert signal.getsignal(signal.SIGINT) == previous_handler
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.wait()


def test_repeated_interrupt_during_cleanup_is_ignored(tmp_path, monkeypatch):
    previous_handler = signal.getsignal(signal.SIGINT)
    class Process:
        stopped = False

        def wait(self):
            if not self.stopped:
                raise KeyboardInterrupt
            signal.raise_signal(signal.SIGINT)
            return 1

        def poll(self):
            return None

        def terminate(self):
            self.stopped = True
    monkeypatch.setattr(tool.subprocess, 'Popen', lambda *args, **kwargs: Process())
    with pytest.raises(KeyboardInterrupt):
        tool.run_sdk(['SDK.exe'], tmp_path)
    assert signal.getsignal(signal.SIGINT) == previous_handler


def test_batch_failure_preserves_completed_output(sdk, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    monkeypatch.setattr(tool, 'check_sdk', lambda executable: None)
    source = tmp_path / 'clips'
    source.mkdir()
    for name in ('a', 'b', 'c'):
        (source / f'{name}.insv').write_bytes(b'original')
    def run(command, directory):
        output = Path(command[command.index('-output') + 1])
        if Path(command[command.index('-inputs') + 1]).stem == 'b':
            output.write_bytes(b'partial')
            raise tool.ExportError('second clip failed')
        output.write_bytes(MP4)
    monkeypatch.setattr(tool, 'run_sdk', run)
    output = tmp_path / 'output'
    assert tool.main(['export', str(source), '-o', str(output), '--sdk', str(sdk)]) == 1
    assert [p.name for p in output.iterdir()] == ['a_360.mp4']
    assert all(p.read_bytes() == b'original' for p in source.iterdir())
    assert 'second clip failed' in capsys.readouterr().err


def test_dry_run_does_not_execute_or_write(sdk, source, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    def forbidden(*args, **kwargs):
        pytest.fail('dry-run must not execute the SDK')
    monkeypatch.setattr(tool, 'check_sdk', forbidden)
    monkeypatch.setattr(tool, 'run_sdk', forbidden)
    destination = tmp_path / 'new folder' / '全景.mp4'
    assert tool.main(['export', str(source), '-o', str(destination), '--sdk', str(sdk), '--dry-run']) == 0
    assert not destination.parent.exists()
    assert '未运行 SDK' in capsys.readouterr().out


def test_doctor_reports_verification_boundary(sdk, monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    monkeypatch.setattr(tool, 'check_sdk', lambda executable: None)
    assert tool.main(['doctor', '--sdk', str(sdk)]) == 0
    assert '不证明' in capsys.readouterr().out


def test_batch_main(sdk, source, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    monkeypatch.setattr(tool, 'check_sdk', lambda executable: None)
    def run(command, directory):
        Path(command[command.index('-output') + 1]).write_bytes(MP4)
    monkeypatch.setattr(tool, 'run_sdk', run)
    output = tmp_path / 'batch'
    assert tool.main(['export', str(source.parent), '-o', str(output), '--sdk', str(sdk)]) == 0
    assert (output / (source.stem + '_360.mp4')).read_bytes() == MP4
    assert '导出完成' in capsys.readouterr().out


def test_main_missing_sdk_returns_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    assert tool.main(['doctor', '--sdk', str(tmp_path)]) == 1
    assert '未找到' in capsys.readouterr().err


def test_main_cancel_exit_code(sdk, source, tmp_path, monkeypatch):
    monkeypatch.setattr(tool.sys, 'platform', 'win32')
    monkeypatch.setattr(tool, 'check_sdk', lambda executable: None)
    def cancel(*args):
        raise KeyboardInterrupt
    monkeypatch.setattr(tool, 'export_one', cancel)
    assert tool.main(['export', str(source), '-o', str(tmp_path / 'out.mp4'), '--sdk', str(sdk)]) == 130


def test_reject_wsl(monkeypatch, capsys):
    monkeypatch.setattr(tool.sys, 'platform', 'linux')
    assert tool.main(['doctor']) == 1
    assert '不支持 WSL' in capsys.readouterr().err


@pytest.mark.parametrize('value', ['-1', '200000001', 'nan', '1.5'])
def test_invalid_bitrate_rejected(value):
    with pytest.raises(SystemExit) as error:
        tool.parser().parse_args(['export', 'input.insv', '-o', 'out.mp4', '--bitrate', value])
    assert error.value.code == 2

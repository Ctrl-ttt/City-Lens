import argparse
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tempfile


SDK_DOC = 'https://github.com/Insta360Develop/Insta360-Developer_Docs/blob/main/docs/en/sdk/x-ace-go/desktop/media.md'
SDK_APPLY = 'https://www.insta360.com/sdk/apply'
SDK_REQUIREMENT = '需要支持 X4 Air 的 Windows Media SDK 3.1.0 或更新版本，建议使用最新版；Link SDK 不适用。'
SIZES = {'4k': '3840x1920', '5.7k': '5760x2880', '8k': '7680x3840'}


class ExportError(Exception):
    pass


def find_sdk(location=None):
    location = location or os.environ.get('INSTA360_MEDIA_SDK')
    if location:
        root = Path(location).expanduser().resolve()
        candidates = [root] if root.is_file() else [root / 'MediaSDKTest.exe', root / 'bin' / 'MediaSDKTest.exe']
    else:
        executable = shutil.which('MediaSDKTest.exe')
        candidates = [Path(executable).resolve()] if executable else []
    for candidate in candidates:
        if candidate.is_file() and candidate.name.lower() == 'mediasdktest.exe':
            if not (candidate.parent / 'MediaSDK.dll').is_file():
                raise ExportError('缺少 MediaSDK.dll，请保留官方 SDK 的完整 bin 目录，不要只复制 EXE。')
            if not (candidate.parent / 'models').is_dir():
                raise ExportError('缺少 SDK models 目录，请完整解压官方 Media SDK。')
            return candidate
    raise ExportError(f'未找到 MediaSDKTest.exe。{SDK_REQUIREMENT}\n'
                      f'使用 --sdk 指定 SDK 根目录、bin 目录或 EXE，或设置 INSTA360_MEDIA_SDK。\n申请：{SDK_APPLY}')


def check_sdk(executable):
    try:
        result = subprocess.run([str(executable), '-help'], cwd=executable.parent,
                                capture_output=True, timeout=30, check=False)
    except subprocess.TimeoutExpired:
        raise ExportError('SDK 自检超时，请检查显卡驱动和 SDK 运行库。') from None
    except OSError as error:
        raise ExportError(f'无法启动 SDK：{error}') from error
    output = result.stdout + result.stderr
    required = [b'-inputs', b'-output', b'-output_size', b'-stitch_type', b'-bitrate',
                b'-enable_flowstate', b'-enable_h265_encoder']
    if result.returncode != 0 or any(flag not in output for flag in required):
        details = output.decode('utf-8', errors='replace')[-2000:]
        raise ExportError(f'SDK 自检失败（退出码 {result.returncode}），命令行接口不匹配或依赖不可用。\n'
                          f'{SDK_REQUIREMENT}\n{details}')


def export_jobs(source, destination):
    source = Path(source).expanduser().resolve()
    destination = Path(destination).expanduser().resolve()
    if source.is_file():
        if source.suffix.lower() != '.insv':
            raise ExportError('输入必须是 X4 Air 的原始 .insv 文件，不接受 .lrv 或已导出的 MP4。')
        if destination.suffix.lower() != '.mp4':
            raise ExportError('单文件导出的输出路径必须以 .mp4 结尾。')
        jobs = [(source, destination)]
    elif source.is_dir():
        if destination.is_file() or destination.suffix.lower() == '.mp4':
            raise ExportError('批量导出时，输出路径必须是目录，不是 MP4 文件。')
        files = sorted((p for p in source.iterdir() if p.is_file() and p.suffix.lower() == '.insv'),
                       key=lambda p: p.name.casefold())
        if not files:
            raise ExportError('输入目录内没有 .insv 文件；仅扫描当前层，不递归扫描子目录。')
        jobs = [(p, destination / (p.stem + '_360.mp4')) for p in files]
    else:
        raise ExportError(f'输入路径不存在：{source}')
    names = set()
    for input_path, output_path in jobs:
        if input_path.stat().st_size == 0:
            raise ExportError(f'输入文件为空：{input_path}')
        if output_path.exists() or output_path.is_symlink():
            raise ExportError(f'输出已存在，不会覆盖：{output_path}')
        name = str(output_path).casefold()
        if name in names:
            raise ExportError(f'多个输入对应同一个输出：{output_path}')
        names.add(name)
        for parent in output_path.parents:
            if parent.exists() and not parent.is_dir():
                raise ExportError(f'输出父路径不是目录：{parent}')
    return jobs


def sdk_command(executable, source, destination, size, codec, bitrate, flowstate):
    command = [str(executable), '-inputs', str(source), '-output', str(destination),
               '-stitch_type', 'optflow', '-output_size', SIZES[size], '-bitrate', str(bitrate)]
    if flowstate:
        command.append('-enable_flowstate')
    if codec == 'h265':
        command.append('-enable_h265_encoder')
    return command


def mp4_boxes(stream, start, end):
    offset = start
    while offset < end:
        stream.seek(offset)
        header = stream.read(min(8, end - offset))
        if len(header) != 8:
            raise ExportError('SDK 输出的 MP4 不完整。')
        size, kind = struct.unpack('>I4s', header)
        header_size = 8
        if size == 1:
            extended = stream.read(min(8, end - offset - 8))
            if len(extended) != 8:
                raise ExportError('SDK 输出的 MP4 扩展头不完整。')
            size = struct.unpack('>Q', extended)[0]
            header_size = 16
        elif size == 0:
            size = end - offset
        if size < header_size or offset + size > end:
            raise ExportError('SDK 输出的 MP4 数据截断或容器无效。')
        yield kind, offset + header_size, offset + size
        offset += size


def video_track(stream, start, end, expected_size, fragment_tracks):
    dimensions = None
    handler = None
    track_id = None
    timed = False
    samples = False
    containers = [(start, end)]
    while containers:
        for kind, begin, finish in mp4_boxes(stream, *containers.pop()):
            if kind in (b'mdia', b'minf', b'stbl'):
                containers.append((begin, finish))
            elif kind == b'tkhd' and finish - begin >= 84:
                stream.seek(begin)
                version = stream.read(1)
                stream.seek(begin + (20 if version == b'\1' else 12))
                track_id = struct.unpack('>I', stream.read(4))[0]
                stream.seek(finish - 8)
                dimensions = tuple(value >> 16 for value in struct.unpack('>II', stream.read(8)))
            elif kind == b'hdlr' and finish - begin >= 12:
                stream.seek(begin + 8)
                handler = stream.read(4)
            elif kind == b'mdhd' and finish - begin >= 24:
                stream.seek(begin)
                version = stream.read(1)
                if version == b'\0':
                    stream.seek(begin + 12)
                    timescale, duration = struct.unpack('>II', stream.read(8))
                    timed = timescale > 0 and 0 < duration < 0xffffffff
                elif version == b'\1' and finish - begin >= 36:
                    stream.seek(begin + 20)
                    timescale, duration = struct.unpack('>IQ', stream.read(12))
                    timed = timescale > 0 and 0 < duration < 0xffffffffffffffff
            elif kind == b'stsz' and finish - begin >= 12:
                stream.seek(begin + 4)
                sample_size, count = struct.unpack('>II', stream.read(8))
                samples = count > 0 and (sample_size > 0 or finish - begin >= 12 + count * 4)
    return handler == b'vide' and dimensions == expected_size and timed and (samples or track_id in fragment_tracks)


def fragment_video_tracks(stream, start, end):
    tracks = set()
    for kind, begin, finish in mp4_boxes(stream, start, end):
        if kind != b'traf':
            continue
        track_id = None
        samples = False
        for field, first, last in mp4_boxes(stream, begin, finish):
            if field == b'tfhd' and last - first >= 8:
                stream.seek(first + 4)
                track_id = struct.unpack('>I', stream.read(4))[0]
            elif field == b'trun' and last - first >= 8:
                stream.seek(first)
                flags, count = struct.unpack('>II', stream.read(8))
                header = 8 + 4 * bool(flags & 1) + 4 * bool(flags & 4)
                entry = 4 * sum(bool(flags & bit) for bit in (0x100, 0x200, 0x400, 0x800))
                if last - first < header + count * entry:
                    raise ExportError('SDK 输出的 MP4 分片样本表不完整。')
                samples = samples or count > 0
        if track_id is not None and samples:
            tracks.add(track_id)
    return tracks


def validate_mp4(path, expected_size):
    if not path.is_file():
        raise ExportError('SDK 没有生成 MP4，不能视为导出成功。')
    video = False
    with path.open('rb') as stream:
        top_level = list(mp4_boxes(stream, 0, path.stat().st_size))
        boxes = {kind for kind, begin, end in top_level if end > begin}
        fragment_tracks = set()
        for kind, begin, end in top_level:
            if kind == b'moof':
                fragment_tracks.update(fragment_video_tracks(stream, begin, end))
        for kind, begin, end in top_level:
            if kind == b'moov':
                for child, track_start, track_end in mp4_boxes(stream, begin, end):
                    if child == b'trak':
                        video = video_track(stream, track_start, track_end, expected_size, fragment_tracks) or video
    if not {b'ftyp', b'moov', b'mdat'}.issubset(boxes):
        raise ExportError('SDK 输出缺少 MP4 容器信息或媒体数据。')
    if not video:
        raise ExportError('SDK 输出缺少符合目标分辨率、具有时长和样本的视频轨。')


def run_sdk(command, directory):
    process = None
    interrupted = False
    previous_handler = signal.getsignal(signal.SIGINT)

    def defer_interrupt(signum, frame):
        nonlocal interrupted
        interrupted = True

    try:
        # Defer Ctrl+C until the new child handle is owned by this process.
        signal.signal(signal.SIGINT, defer_interrupt)
        process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL)
        signal.signal(signal.SIGINT, previous_handler)
        if interrupted:
            raise KeyboardInterrupt
        returncode = process.wait()
    except KeyboardInterrupt:
        # Ignore repeated Ctrl+C until our child has stopped writing the output.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if process is not None:
            if process.poll() is None:
                process.terminate()
            process.wait()
        raise
    finally:
        signal.signal(signal.SIGINT, previous_handler)
    if returncode:
        raise ExportError(f'SDK 导出失败（退出码 {returncode}），请查看上方 SDK 日志；'
                          '检查 SDK 版本、原片完整性、显卡驱动和可用磁盘空间。')


def export_one(executable, source, destination, args):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.x4-export-', dir=destination.parent) as work:
        temporary = Path(work) / 'panorama.mp4'
        command = sdk_command(executable, source, temporary, args.size, args.codec,
                              args.bitrate, not args.no_flowstate)
        run_sdk(command, executable.parent)
        validate_mp4(temporary, tuple(map(int, SIZES[args.size].split('x'))))
        # Windows rename fails if a competing export created the destination.
        os.rename(temporary, destination)


def bitrate_value(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('码率必须是整数，单位为 bps。') from None
    if not 0 <= number <= 200_000_000:
        raise argparse.ArgumentTypeError('码率需为 0（沿用原片）或 1–200000000 bps。')
    return number


def parser():
    result = argparse.ArgumentParser(
        description='X4 Air 原始 INSV → 完整 360°、2:1 全景 MP4（Windows，本地处理，不上传录像）。',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f'''依赖：{SDK_REQUIREMENT}
保留官方 SDK 的 DLL、models 与运行库；需要满足 SDK 的显卡/驱动要求。
本工具调用官方光流拼接，不以改后缀、转封装或并排鱼眼代替拼接。
普通播放器会平铺全景画面；交互式环视请使用支持 360° 的播放器。

示例（在仓库根目录执行）：
  py tools/x4_export.py doctor --sdk "D:/MediaSDK"
  py tools/x4_export.py export "D:/素材/VID.insv" -o "D:/导出/全景.mp4" --sdk "D:/MediaSDK"
  py tools/x4_export.py export "D:/素材" -o "D:/导出" --size 8k --codec h265 --sdk "D:/MediaSDK"

SDK 申请：{SDK_APPLY}
官方参数：{SDK_DOC}''')
    commands = result.add_subparsers(dest='action', required=True)
    doctor = commands.add_parser('doctor', help='检查 SDK 文件和命令行接口，不处理视频')
    export = commands.add_parser('export', help='导出一个 INSV 或批量导出目录第一层的 INSV')
    for command in (doctor, export):
        command.add_argument('--sdk', help='SDK 根目录、bin 目录或 MediaSDKTest.exe；也可用 INSTA360_MEDIA_SDK')
    export.add_argument('input', help='原始 INSV 文件或包含 INSV 的目录；X4 Air 每个 INSV 独立处理')
    export.add_argument('-o', '--output', required=True, help='单文件时为 .mp4 路径，批量时为输出目录；永不覆盖')
    export.add_argument('--size', choices=SIZES, default='4k', help='2:1 分辨率，默认 4k=3840×1920；不会自动保持原片分辨率')
    export.add_argument('--codec', choices=['h264', 'h265'], default='h264', help='默认 h264；超过 4K 推荐 h265 以使用硬件编码')
    export.add_argument('--bitrate', type=bitrate_value, default=0, help='视频码率 bps；默认 0 沿用原片，8K 推荐 80000000–142000000')
    export.add_argument('--no-flowstate', action='store_true', help='关闭默认启用的 FlowState 防抖')
    export.add_argument('--dry-run', action='store_true', help='只显示任务和 SDK 命令；不运行 SDK，不创建目录或 MP4')
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if sys.platform != 'win32':
            raise ExportError('此工具封装 Windows MediaSDKTest.exe，请在 Windows 下运行（不支持 WSL）。')
        jobs = export_jobs(args.input, args.output) if args.action == 'export' else []
        executable = find_sdk(args.sdk)
        print(f'SDK：{executable}', flush=True)
        print(SDK_REQUIREMENT, flush=True)
        if args.action == 'export' and args.dry_run:
            for source, destination in jobs:
                command = sdk_command(executable, source, destination, args.size, args.codec,
                                      args.bitrate, not args.no_flowstate)
                print(subprocess.list2cmdline(command))
            print('预览完成；未运行 SDK。实际导出会先写入临时文件，通过容器检查后再保存到目标路径。')
            return 0
        check_sdk(executable)
        if args.action == 'doctor':
            print('SDK 文件与命令行接口检查通过；这不证明 SDK 版本兼容、GPU 拼接或真实素材导出已通过验收。')
            return 0
        print(f'导出 {len(jobs)} 段，分辨率 {SIZES[args.size]}，编码 {args.codec}；按 Ctrl+C 取消。', flush=True)
        if args.size != '4k' and args.codec == 'h264':
            print('提示：超过 4K 的 H.264 会使 SDK 使用软件编码，建议 --codec h265。', flush=True)
        for index, (source, destination) in enumerate(jobs, 1):
            print(f'[{index}/{len(jobs)}] {source.name} → {destination}', flush=True)
            export_one(executable, source, destination, args)
            print(f'已保存：{destination}', flush=True)
        print('导出完成；请用全景播放器检查接缝、方向、防抖及音画同步。')
        return 0
    except KeyboardInterrupt:
        print('\n已取消；原片与已完成的 MP4 保留，当前任务的临时文件已清理。', file=sys.stderr)
        return 130
    except (ExportError, OSError) as error:
        print(f'错误：{error}\n本次未完成的输出不会发布；批量任务中已成功的文件会保留。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    raise SystemExit(main())

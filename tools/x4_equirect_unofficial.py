"""Unofficial dual-fisheye to equirectangular export using FFmpeg's v360 filter.

This is deliberately NOT an Insta360 stitch. It reprojects the two fisheye
tracks of an X4 Air INSV with nominal geometry only:

* no per-unit lens calibration, so the lens-join meridians show a faint seam;
* no lens shading / vignetting correction;
* no gyro or FlowState stabilization, because the INSV gyro payload is never read;
* no lens-FOV autodetection; ``--in-fov`` is an assumed value, not calibrated data;
* no spherical-video metadata: without the ST3D/SV3D boxes, players that insist on
  them show a flat 2:1 video instead of a sphere (YouTube still autodetects it).

The two fisheye tracks are stacked so that the track selected by ``--front-track``
faces the equirect centre. Swapping the tracks rotates the whole panorama 180 deg
about the vertical, which exchanges front and back while the lens joins keep their
positions in the frame.

A single side-by-side dual-fisheye track (such as an Insta360 ``.lrv`` proxy) is also
accepted: it is fed straight through v360, and ``--front-track 1`` then rotates the
panorama 180 deg in yaw to exchange front and back. Proxies are low resolution, so
use them for previews only, not as a master.

Use it for previews, review, and scene-level analysis. When a stitched master is
required, use the official Media SDK path (tools/x4_export.py) or Insta360 Studio.

The source INSV is opened read-only and never modified; existing outputs are
never overwritten.
"""

import argparse
import os
import re
import signal
import sys
import tempfile
import time
from collections import deque
from fractions import Fraction

import av
import numpy as np

DEFAULT_SIZE = "3840x1920"
# Fitted on X4 Air clips by minimising the discontinuity at both lens joins: on one
# clip 190 deg scored a blur-normalised 2.4/2.6 against 7.0/9.9 at 210 deg, and a second
# clip put its own optimum at 185-190 deg. Per-unit calibration is still missing, so
# treat it as an empirical starting point, not as measured lens data.
DEFAULT_IN_FOV = 190.0
# Which fisheye track is turned to face the equirect centre. Checked against one
# VID_20260922 clip: with the second track in the centre slot the panorama showed the
# rear lens straight ahead, so track 0 is the front eye on that unit. Units may differ;
# if the horizon comes out mirrored front-to-back, pass --front-track 1.
DEFAULT_FRONT_TRACK = 0
DEFAULT_BITRATE = "60M"
ENCODERS = {
    ("hevc", "auto"): ("hevc_nvenc", "libx265"),
    ("h264", "auto"): ("h264_nvenc", "libx264"),
}
NVENC_OPTIONS = {"preset": "p5", "rc": "vbr", "cq": "23"}
X265_OPTIONS = {"preset": "medium", "crf": "23"}
X264_OPTIONS = {"preset": "medium", "crf": "20"}
BITRATE_RE = re.compile(r"^(\d+)([MmKk]?)$")


class ExportError(Exception):
    """Raised when the export cannot produce a valid file."""


def parse_size(text):
    match = re.match(r"^(\d+)\s*[xX×]\s*(\d+)$", text.strip())
    if not match:
        raise ExportError(f"尺寸应写成 宽x高，例如 {DEFAULT_SIZE}：{text!r}")
    width, height = int(match.group(1)), int(match.group(2))
    if width % 2 or height % 2:
        raise ExportError("全景观看要求宽高均为偶数。")
    if width != 2 * height:
        raise ExportError(f"360° 全景必须是 2:1（例如 {DEFAULT_SIZE}），当前为 {width}x{height}。")
    if width < 640:
        raise ExportError(f"输出宽度过小，至少 640：{width}")
    return width, height


def parse_bitrate(text):
    match = BITRATE_RE.match(text.strip())
    if not match:
        raise ExportError(f"码率应形如 60M 或 20000K：{text!r}")
    value, suffix = int(match.group(1)), match.group(2).lower()
    if suffix == "m":
        value *= 1_000_000
    elif suffix == "k":
        value *= 1_000
    if value < 1_000_000:
        raise ExportError(f"码率过低，至少 1M：{text!r}")
    return value


def opened_lenses(container):
    streams = container.streams.video
    if len(streams) < 2:
        raise ExportError(
            f"该文件只有 {len(streams)} 条视频轨；X4 Air 的 INSV 应包含前后两条鱼眼视频轨。"
        )
    first, second = streams[0], streams[1]
    for stream in (first, second):
        if stream.codec_context.name != "hevc" or stream.codec_context.width != stream.codec_context.height:
            raise ExportError(
                f"视频轨 {stream.index} 不是方形 HEVC 鱼眼画面"
                f"（{stream.codec_context.name} {stream.codec_context.width}x{stream.codec_context.height}）。"
            )
    if first.codec_context.width != second.codec_context.width:
        raise ExportError("两条鱼眼轨分辨率不一致，无法直接并排拼接。")
    return first, second


def packed_lens(container):
    """单条把前后鱼眼并排编码的视频轨，常见于 Insta360 的 .lrv 代理。"""
    streams = container.streams.video
    if not streams:
        raise ExportError("文件没有视频轨。")
    stream = streams[0]
    context = stream.codec_context
    if context.width % 2 or context.height % 2:
        raise ExportError("单轨并排双鱼眼的宽高需为偶数。")
    if context.width != 2 * context.height:
        raise ExportError(
            f"单轨输入需是并排的 2:1 双鱼眼（每颗鱼眼为方形），当前 {context.width}x{context.height}。"
        )
    return stream


def open_geometry(container):
    """挑选源布局：双轨方形鱼眼（.insv）或单轨并排双鱼眼（.lrv 代理）。"""
    videos = container.streams.video
    if len(videos) >= 2:
        return "dual", opened_lenses(container)
    return "packed", (packed_lens(container),)


def pick_encoder(codec, requested, available):
    candidates = (requested,) if requested != "auto" else ENCODERS[(codec, "auto")]
    for name in candidates:
        if name in available:
            return name
    raise ExportError(f"当前 FFmpeg 构建没有可用的 {codec} 编码器：{', '.join(candidates)}")


def encoder_options(name, bitrate):
    options = {"b": str(bitrate)}
    if name.endswith("_nvenc"):
        options.update(NVENC_OPTIONS)
    elif name == "libx265":
        options.update(X265_OPTIONS)
    elif name == "libx264":
        options.update(X264_OPTIONS)
    return options


def rotate_180(packed, height):
    chroma_height = height // 4
    planes = (
        packed[:height],
        packed[height:height + chroma_height],
        packed[height + chroma_height:],
    )
    return np.ascontiguousarray(np.vstack([plane[::-1, ::-1] for plane in planes]))


def stack_lenses(first, second, front_track=DEFAULT_FRONT_TRACK):
    # yuv420p packs planes as [Y; U; V]; a combined frame is a per-row horizontal join.
    # v360 places the right half of the pair at the equirect centre, so the track that
    # should look forward has to be stacked there.
    if front_track not in (0, 1):
        raise ExportError(f"front_track 只能是 0 或 1，收到 {front_track!r}。")
    forward, backward = (first, second) if front_track == 0 else (second, first)
    left = backward.to_ndarray(format="yuv420p")
    right = forward.to_ndarray(format="yuv420p")
    if first.width != second.width or first.height != second.height:
        raise ExportError("两条鱼眼轨画面尺寸不一致。")
    return np.ascontiguousarray(np.hstack([left, right]))


class Reprojjector:
    """Feeds stacked dual-fisheye frames through v360 and returns equirect frames."""

    def __init__(self, lens_width, lens_height, out_width, out_height, in_fov, interp, time_base, yaw=0.0):
        self.source_size = (2 * lens_width, lens_height)
        self.time_base = time_base
        graph = av.filter.Graph()
        self.source = graph.add_buffer(
            width=self.source_size[0],
            height=self.source_size[1],
            format="yuv420p",
            time_base=time_base,
        )
        arguments = (
            f"dfisheye:e:w={out_width}:h={out_height}"
            f":ih_fov={in_fov:g}:iv_fov={in_fov:g}:interp={interp}"
        )
        if yaw:
            arguments += f":yaw={yaw:g}"
        reproject = graph.add("v360", arguments)
        self.sink = graph.add("buffersink")
        self.source.link_to(reproject)
        reproject.link_to(self.sink)
        graph.configure()
        self.graph = graph

    def convert(self, stacked, index):
        frame = av.VideoFrame.from_ndarray(stacked, format="yuv420p")
        frame.pts = index
        frame.time_base = self.time_base
        self.source.push(frame)
        return self.sink.pull()


def probe_duration(container):
    if container.duration is not None:
        return container.duration / av.time_base
    durations = [stream.duration * stream.time_base for stream in container.streams if stream.duration]
    return max(durations) if durations else None


def transcode(source_path, destination, width, height, in_fov, interp, codec, encoder, bitrate,
              preview_seconds=None, front_track=DEFAULT_FRONT_TRACK):
    with av.open(source_path) as container:
        mode, lenses = open_geometry(container)
        audio = container.streams.audio[0] if container.streams.audio else None
        if mode == "dual":
            first, second = lenses
            video_streams = (first, second)
            primary = first
            lens_width = first.codec_context.width
            lens_height = first.codec_context.height
            yaw = 0.0

            def combine():
                return stack_lenses(
                    queues[first.index].popleft(), queues[second.index].popleft(), front_track
                )

            def ready():
                return bool(queues[first.index]) and bool(queues[second.index])
        else:
            (packed,) = lenses
            video_streams = (packed,)
            primary = packed
            lens_width = packed.codec_context.width // 2
            lens_height = packed.codec_context.height
            # A single packed track has a fixed left/right layout, so front/back is
            # swapped by rotating the equirect 180 deg in yaw instead of restacking.
            yaw = 180.0 if front_track == 1 else 0.0

            def combine():
                return np.ascontiguousarray(
                    queues[packed.index].popleft().to_ndarray(format="yuv420p")
                )

            def ready():
                return bool(queues[packed.index])

        rate = primary.average_rate or Fraction(30000, 1001)
        total_seconds = probe_duration(container)
        total_frames = int(total_seconds * rate) if total_seconds else None
        video_time_base = Fraction(rate.denominator, rate.numerator)
        limit_frames = int(preview_seconds * rate) if preview_seconds else None
        audio_horizon = preview_seconds if preview_seconds else float("inf")
        layout = "双轨方形鱼眼" if mode == "dual" else "单轨并排双鱼眼"
        print(f"源：{os.path.basename(source_path)}")
        print(
            f"  {layout} 每眼 {lens_width}x{lens_height} @ {float(rate):.3f} fps"
            + (f"  时长 {total_seconds:.1f}s  约 {total_frames} 帧" if total_seconds else "")
        )
        print(
            f"输出：{width}x{height}  {codec}（{encoder}）  {bitrate / 1_000_000:.0f} Mbps"
            f"  视场角假设 {in_fov:g}°  前方轨 {front_track}"
            + (f"  仅转换前 {preview_seconds:g}s" if preview_seconds else ""),
            flush=True,
        )

        reprojector = Reprojjector(
            lens_width, lens_height, width, height, in_fov, interp, video_time_base, yaw=yaw
        )

        with av.open(destination, "w", format="mp4", options={"movflags": "+faststart"}) as output:
            video_out = output.add_stream(encoder, rate=rate, options=encoder_options(encoder, bitrate))
            video_out.width = width
            video_out.height = height
            video_out.pix_fmt = "yuv420p"
            video_out.time_base = video_time_base
            audio_out = output.add_stream_from_template(audio) if audio is not None else None

            queues = {stream.index: deque() for stream in video_streams}
            pending_audio = deque()
            state = {"frames": 0, "started": time.monotonic()}

            def drain_audio(upto_seconds):
                while pending_audio and pending_audio[0][0] <= upto_seconds:
                    _, packet = pending_audio.popleft()
                    output.mux(packet)

            def emit():
                stacked = combine()
                index = state["frames"]
                equirect = reprojector.convert(stacked, index)
                for packet in video_out.encode(equirect):
                    drain_audio(packet.pts * video_time_base)
                    output.mux(packet)
                state["frames"] = index + 1
                if index % 120 == 0:
                    elapsed = time.monotonic() - state["started"]
                    done_seconds = index / float(rate)
                    speed = index / elapsed if elapsed else 0.0
                    progress = f"{index}" + (f"/{total_frames}" if total_frames else "")
                    tail = ""
                    if speed and total_frames:
                        remaining = (total_frames - index) / speed
                        tail = f"  预计剩余 {remaining / 60:.1f} 分钟"
                    print(f"  已转 {progress} 帧  {done_seconds:.1f}s  {speed:.2f} fps{tail}", flush=True)

            wanted = video_streams + ((audio,) if audio is not None else ())
            for packet in container.demux(*wanted):
                if packet.stream is audio:
                    if audio_out is not None and packet.dts is not None:
                        seconds = packet.pts * packet.time_base if packet.pts is not None else 0.0
                        pending_audio.append((float(seconds), packet))
                        packet.stream = audio_out
                    continue
                for frame in packet.decode():
                    queues[packet.stream.index].append(frame)
                while ready():
                    emit()
                    if limit_frames is not None and state["frames"] >= limit_frames:
                        break
                if limit_frames is not None and state["frames"] >= limit_frames:
                    break

            for packet in video_out.encode():
                drain_audio(audio_horizon)
                output.mux(packet)
            if audio_out is not None:
                drain_audio(audio_horizon)

    return state["frames"]


def validate(path, width, height, expected_seconds, tolerance_seconds=None):
    with av.open(path) as container:
        video = container.streams.video[0] if container.streams.video else None
        if video is None:
            raise ExportError("输出文件没有视频轨。")
        if (video.codec_context.width, video.codec_context.height) != (width, height):
            raise ExportError(
                f"输出尺寸为 {video.codec_context.width}x{video.codec_context.height}，期望 {width}x{height}。"
            )
        if video.codec_context.pix_fmt != "yuv420p":
            print(f"提示：输出像素格式为 {video.codec_context.pix_fmt}", flush=True)
        seconds = probe_duration(container)
        if not seconds:
            raise ExportError("输出文件读不到时长。")
        slack = tolerance_seconds if tolerance_seconds is not None else max(2.0, expected_seconds * 0.02)
        if expected_seconds and abs(seconds - expected_seconds) > slack:
            raise ExportError(f"输出时长 {seconds:.1f}s 与期望 {expected_seconds:.1f}s 相差过大。")
        return seconds, bool(container.streams.audio)


def run(source_path, destination, size, in_fov, interp, codec, encoder, bitrate,
        preview_seconds=None, front_track=DEFAULT_FRONT_TRACK):
    if os.path.abspath(source_path) == os.path.abspath(destination):
        raise ExportError("输出路径与源文件相同，已拒绝。")
    if not os.path.isfile(source_path):
        raise ExportError(f"找不到源文件：{source_path}")
    if os.path.getsize(source_path) == 0:
        raise ExportError(f"源文件为空：{source_path}")
    if os.path.exists(destination):
        raise ExportError(f"输出已存在，不会覆盖：{destination}")

    parent = os.path.dirname(os.path.abspath(destination))
    if not os.path.isdir(parent):
        raise ExportError(f"输出目录不存在：{parent}")

    width, height = parse_size(size)
    bitrate_value = parse_bitrate(bitrate)
    chosen = pick_encoder(codec, encoder, set(av.codecs_available))

    source_size = os.path.getsize(source_path)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=".x4-equirect-", dir=parent) as staging:
        staged = os.path.join(staging, os.path.basename(destination))
        try:
            frames = transcode(
                source_path, staged, width, height, in_fov, interp, codec, chosen, bitrate_value,
                preview_seconds=preview_seconds, front_track=front_track,
            )
        except KeyboardInterrupt:
            print("\n已取消，未生成输出文件。", flush=True)
            return 130
        if frames == 0:
            raise ExportError("没有解出任何画面，源文件可能已损坏。")
        if preview_seconds:
            expected, slack = preview_seconds, max(1.0, preview_seconds * 0.1)
        else:
            with av.open(source_path) as container:
                expected, slack = probe_duration(container), None
        seconds, has_audio = validate(staged, width, height, expected, slack)
        os.rename(staged, destination)

    elapsed = time.monotonic() - started
    print(
        f"完成：{destination}\n"
        f"  {width}x{height}  {seconds:.1f}s  {frames} 帧  音轨 {'有' if has_audio else '无'}"
        f"  源文件 {source_size / 1_048_576:.0f} MB  用时 {elapsed / 60:.1f} 分钟",
        flush=True,
    )
    return 0


def parser():
    text = __doc__.strip().splitlines()[0]
    result = argparse.ArgumentParser(prog="x4_equirect_unofficial.py", description=text, epilog=(
        "注意：本工具用 FFmpeg v360 做名义几何重投影，不是官方拼接，也没有 FlowState 增稳；"
        "镜头交界处会有可见的不连续，输出也不带球面（ST3D/SV3D）元数据。"
        "需要官方品质的成片时，请走 tools/x4_export.py 的 Media SDK 路线。"
    ))
    result.add_argument("source", help="X4 Air 的 .insv（双轨方形鱼眼）或并排双鱼眼的 .lrv 代理")
    result.add_argument("-o", "--output", help="输出 MP4 路径（默认与源文件同目录，文件名加 _360_unofficial）")
    result.add_argument("--size", default=DEFAULT_SIZE, help=f"输出尺寸，必须 2:1（默认 {DEFAULT_SIZE}）")
    result.add_argument("--in-fov", type=float, default=DEFAULT_IN_FOV,
                        help=f"假设的单镜头视场角，单位为度（默认 {DEFAULT_IN_FOV:g}，非标定值）")
    result.add_argument("--front-track", type=int, choices=(0, 1), default=DEFAULT_FRONT_TRACK,
                        help="哪条鱼眼轨朝输出正前方（equirect 中心）：0=第一条（默认），1=第二条；"
                             "前后颠倒时改用另一条")
    result.add_argument("--interp", default="cubic", choices=("linear", "cubic", "lanczos", "nearest"),
                        help="重投影插值方式（默认 cubic）")
    result.add_argument("--codec", default="hevc", choices=("hevc", "h264"), help="视频编码（默认 hevc）")
    result.add_argument("--encoder", default="auto", help="强制指定编码器，例如 libx265 或 hevc_nvenc")
    result.add_argument("--bitrate", default=DEFAULT_BITRATE, help=f"目标码率（默认 {DEFAULT_BITRATE}）")
    result.add_argument("--preview", type=float, metavar="SECONDS",
                        help="只转换开头的若干秒，用于试跑速度与画质")
    return result


def main(argv=None):
    arguments = parser().parse_args(argv)
    if not sys.platform.startswith("win"):
        print("当前仅支持在 Windows 下运行。", file=sys.stderr)
        return 1
    source = os.path.abspath(arguments.source)
    if not arguments.output:
        stem = os.path.splitext(source)[0]
        suffix = "_360_unofficial_preview.mp4" if arguments.preview else "_360_unofficial.mp4"
        destination = f"{stem}{suffix}"
    else:
        destination = os.path.abspath(arguments.output)
    if arguments.in_fov <= 0 or arguments.in_fov > 360:
        print("--in-fov 应在 0 到 360 之间。", file=sys.stderr)
        return 1
    if arguments.preview is not None and arguments.preview <= 0:
        print("--preview 应为正数秒数。", file=sys.stderr)
        return 1
    try:
        return run(
            source, destination, arguments.size, arguments.in_fov, arguments.interp,
            arguments.codec, arguments.encoder, arguments.bitrate,
            preview_seconds=arguments.preview, front_track=arguments.front_track,
        )
    except ExportError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.exit(main())

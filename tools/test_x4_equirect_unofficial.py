from fractions import Fraction
from types import SimpleNamespace

import numpy as np
import pytest

av = pytest.importorskip("av", reason="名义几何拼接依赖项目 .venv 里的 PyAV/FFmpeg")

from tools import x4_equirect_unofficial as tool

LENS = 160
RATE = Fraction(30, 1)
FRAMES = 6

needs_ffmpeg = pytest.mark.skipif(
    "libx265" not in av.codecs_available or "aac" not in av.codecs_available,
    reason="需要自带 libx265 与 aac 的 FFmpeg 构建",
)


def fast_options(name, bitrate):
    return {
        "b": str(bitrate),
        "preset": "ultrafast",
        "crf": "30",
        "x265-params": "log-level=none",
    }


@pytest.fixture(scope="module")
def insv(tmp_path_factory):
    """两路方形 HEVC 鱼眼轨加一条音轨，复刻 X4 Air 单文件双轨的结构。"""
    path = tmp_path_factory.mktemp("footage") / "VID_合成.insv"
    with av.open(str(path), "w", format="mp4") as output:
        videos = []
        for _ in range(2):
            stream = output.add_stream("libx265", rate=RATE, options=fast_options("libx265", 1))
            stream.width = stream.height = LENS
            stream.pix_fmt = "yuv420p"
            videos.append(stream)
        audio = output.add_stream("aac", rate=48000)
        audio.layout = "mono"
        audio.sample_rate = 48000
        for index in range(FRAMES):
            for order, stream in enumerate(videos):
                plane = np.full((LENS * 3 // 2, LENS), (index * 30 + order * 40) % 256, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(plane, format="yuv420p")
                frame.pts = index
                for packet in stream.encode(frame):
                    output.mux(packet)
            sound = av.AudioFrame(format="fltp", layout="mono", samples=1600)
            sound.sample_rate = 48000
            sound.pts = index * 1600
            sound.planes[0].update(np.zeros((1, 1600), dtype=np.float32))
            for packet in audio.encode(sound):
                output.mux(packet)
        for stream in videos:
            for packet in stream.encode():
                output.mux(packet)
        for packet in audio.encode():
            output.mux(packet)
    return path


@pytest.fixture
def equirect(insv, tmp_path, monkeypatch):
    """跑一次真实转码，返回 (输出路径, 帧数)。"""
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    destination = tmp_path / "全景.mp4"
    frames = tool.transcode(
        str(insv), str(destination), 640, 320, 210.0, "cubic", "hevc", "libx265", 2_000_000
    )
    return destination, frames


def plane(base, rows, columns):
    return (base + np.add.outer(np.arange(rows), np.arange(columns))).astype(np.uint8)


def packed_frame(base, size):
    chroma = size // 4
    return np.vstack([plane(base, size, size), plane(base + 100, chroma, size), plane(base + 200, chroma, size)])


@pytest.mark.parametrize(
    "text,expected",
    [("3840x1920", (3840, 1920)), ("640x320", (640, 320)), ("7680 × 3840", (7680, 3840))],
)
def test_parse_size_accepts_2_to_1(text, expected):
    assert tool.parse_size(text) == expected


@pytest.mark.parametrize(
    "text,message",
    [("3840x1080", "2:1"), ("641x320", "偶数"), ("630x315", "偶数"), ("320x160", "至少 640"), ("3840", "宽x高")],
)
def test_parse_size_rejects(text, message):
    with pytest.raises(tool.ExportError, match=message):
        tool.parse_size(text)


@pytest.mark.parametrize(
    "text,expected",
    [("60M", 60_000_000), ("20000K", 20_000_000), ("5000000", 5_000_000), ("1m", 1_000_000)],
)
def test_parse_bitrate_accepts(text, expected):
    assert tool.parse_bitrate(text) == expected


@pytest.mark.parametrize("text", ["", "60", "999K", "60MB", "-5M"])
def test_parse_bitrate_rejects(text):
    with pytest.raises(tool.ExportError, match="码率"):
        tool.parse_bitrate(text)


def test_pick_encoder_prefers_hardware_then_software():
    assert tool.pick_encoder("hevc", "auto", {"hevc_nvenc", "libx265"}) == "hevc_nvenc"
    assert tool.pick_encoder("hevc", "auto", {"libx265"}) == "libx265"
    assert tool.pick_encoder("h264", "auto", {"libx264"}) == "libx264"


def test_pick_encoder_honours_explicit_choice():
    assert tool.pick_encoder("hevc", "libx265", {"hevc_nvenc", "libx265"}) == "libx265"


def test_pick_encoder_without_candidates():
    with pytest.raises(tool.ExportError, match="没有可用的"):
        tool.pick_encoder("hevc", "auto", {"libx264"})


def test_encoder_options_track_bitrate():
    for name in ("hevc_nvenc", "libx265", "libx264"):
        assert tool.encoder_options(name, 60_000_000)["b"] == "60000000"


def test_encoder_options_nvenc_uses_constant_quality():
    options = tool.encoder_options("hevc_nvenc", 1)
    assert (options["preset"], options["rc"]) == ("p5", "vbr")
    assert "cq" in options


def test_encoder_options_software_uses_crf():
    assert tool.encoder_options("libx265", 1)["crf"] == "23"
    assert tool.encoder_options("libx264", 1)["crf"] == "20"


def test_rotate_180_keeps_planes_in_order():
    size = 8
    source = packed_frame(0, size)
    rotated = tool.rotate_180(source, size)
    assert rotated.shape == source.shape
    chroma = size // 4
    blocks = (rotated[:size], rotated[size:size + chroma], rotated[size + chroma:])
    origins = (source[:size], source[size:size + chroma], source[size + chroma:])
    for block, origin in zip(blocks, origins):
        assert np.array_equal(block, origin[::-1, ::-1])
    assert int(blocks[0].max()) < 100 and 100 <= int(blocks[1].min()) < 200 <= int(blocks[2].min())


def lens_pair(size=8):
    first = av.VideoFrame.from_ndarray(np.full((size * 3 // 2, size), 10, dtype=np.uint8), format="yuv420p")
    second = av.VideoFrame.from_ndarray(np.full((size * 3 // 2, size), 200, dtype=np.uint8), format="yuv420p")
    return first, second


def test_stack_lenses_puts_the_first_track_in_the_centre_slot():
    first, second = lens_pair()
    stacked = tool.stack_lenses(first, second)
    assert stacked.shape == (12, 16)
    assert (stacked[:, :8] == 200).all()
    assert (stacked[:, 8:] == 10).all()


def test_stack_lenses_front_track_moves_the_centre_eye():
    first, second = lens_pair()
    swapped = tool.stack_lenses(first, second, front_track=1)
    assert (swapped[:, :8] == 10).all()
    assert (swapped[:, 8:] == 200).all()


def test_stack_lenses_rejects_unknown_front_track():
    first, second = lens_pair()
    with pytest.raises(tool.ExportError, match="front_track"):
        tool.stack_lenses(first, second, front_track=2)


def test_stack_lenses_rejects_mismatched_frames():
    left = av.VideoFrame.from_ndarray(np.zeros((24, 4), dtype=np.uint8), format="yuv420p")
    right = av.VideoFrame.from_ndarray(np.zeros((24, 8), dtype=np.uint8), format="yuv420p")
    with pytest.raises(tool.ExportError, match="尺寸不一致"):
        tool.stack_lenses(left, right)


def lens_stream(index, name="hevc", width=LENS, height=LENS):
    return SimpleNamespace(index=index, codec_context=SimpleNamespace(name=name, width=width, height=height))


def lens_container(streams):
    return SimpleNamespace(streams=SimpleNamespace(video=list(streams), audio=[]))


def test_opened_lenses_accepts_two_square_hevc_tracks():
    first, second = tool.opened_lenses(lens_container([lens_stream(0), lens_stream(1)]))
    assert (first.index, second.index) == (0, 1)


def test_opened_lenses_needs_two_tracks():
    with pytest.raises(tool.ExportError, match="只有 1 条视频轨"):
        tool.opened_lenses(lens_container([lens_stream(0)]))


@pytest.mark.parametrize("stream", [lens_stream(0, name="h264"), lens_stream(0, height=1920), lens_stream(0, width=1920)])
def test_opened_lenses_needs_square_hevc(stream):
    with pytest.raises(tool.ExportError, match="方形 HEVC"):
        tool.opened_lenses(lens_container([stream, lens_stream(1)]))


def test_opened_lenses_needs_matching_sizes():
    with pytest.raises(tool.ExportError, match="分辨率不一致"):
        tool.opened_lenses(lens_container([lens_stream(0), lens_stream(1, width=1920, height=1920)]))


@needs_ffmpeg
def test_transcode_writes_2_to_1_equirect(equirect):
    destination, frames = equirect
    assert frames == FRAMES
    seconds, has_audio = tool.validate(str(destination), 640, 320, 0.2)
    assert seconds == pytest.approx(FRAMES / 30, abs=0.1)
    assert has_audio
    with av.open(str(destination)) as container:
        video = container.streams.video[0]
        assert video.codec_context.name == "hevc"
        assert (video.codec_context.width, video.codec_context.height) == (640, 320)
        assert video.codec_context.pix_fmt == "yuv420p"


@needs_ffmpeg
def test_preview_stops_after_requested_seconds(insv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    frames = tool.transcode(
        str(insv), str(tmp_path / "预览.mp4"), 640, 320, 210.0, "cubic", "hevc", "libx265",
        2_000_000, preview_seconds=0.1,
    )
    assert frames == 3


@needs_ffmpeg
def test_front_track_steers_which_lens_faces_the_centre(insv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    centre_minus_edge = []
    for front in (0, 1):
        destination = tmp_path / f"前方{front}.mp4"
        tool.transcode(
            str(insv), str(destination), 640, 320, 210.0, "cubic", "hevc", "libx265",
            2_000_000, preview_seconds=0.1, front_track=front,
        )
        with av.open(str(destination)) as container:
            luma = next(container.decode(video=0)).to_ndarray(format="yuv420p")[:320]
        centre = luma[:, 300:340].mean()
        edge = np.concatenate([luma[:, 20:60], luma[:, 580:620]], axis=1).mean()
        centre_minus_edge.append(centre - edge)
    assert centre_minus_edge[0] < -10
    assert centre_minus_edge[1] > 10


@needs_ffmpeg
def test_validate_rejects_wrong_geometry(equirect):
    destination, _ = equirect
    with pytest.raises(tool.ExportError, match="输出尺寸"):
        tool.validate(str(destination), 320, 160, 0.2)


@needs_ffmpeg
def test_validate_rejects_wrong_duration(equirect):
    destination, _ = equirect
    with pytest.raises(tool.ExportError, match="相差过大"):
        tool.validate(str(destination), 640, 320, 30.0)


def test_run_refuses_source_as_destination(insv):
    with pytest.raises(tool.ExportError, match="相同"):
        tool.run(str(insv), str(insv), "640x320", 210.0, "cubic", "hevc", "libx265", "2M")


def test_run_rejects_missing_source(tmp_path):
    with pytest.raises(tool.ExportError, match="找不到源文件"):
        tool.run(str(tmp_path / "missing.insv"), str(tmp_path / "out.mp4"), "640x320", 210.0, "cubic", "hevc", "libx265", "2M")


def test_run_rejects_empty_source(tmp_path):
    source = tmp_path / "empty.insv"
    source.write_bytes(b"")
    with pytest.raises(tool.ExportError, match="源文件为空"):
        tool.run(str(source), str(tmp_path / "out.mp4"), "640x320", 210.0, "cubic", "hevc", "libx265", "2M")


def test_run_rejects_missing_directory(insv, tmp_path):
    with pytest.raises(tool.ExportError, match="输出目录不存在"):
        tool.run(str(insv), str(tmp_path / "nope" / "out.mp4"), "640x320", 210.0, "cubic", "hevc", "libx265", "2M")


def test_run_never_overwrites_output(insv, tmp_path):
    destination = tmp_path / "已有的.mp4"
    destination.write_bytes(b"keep me")
    with pytest.raises(tool.ExportError, match="不会覆盖"):
        tool.run(str(insv), str(destination), "640x320", 210.0, "cubic", "hevc", "libx265", "2M")
    assert destination.read_bytes() == b"keep me"


@needs_ffmpeg
def test_run_keeps_source_untouched(insv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    before = insv.read_bytes()
    destination = tmp_path / "整片.mp4"
    assert tool.run(str(insv), str(destination), "640x320", 210.0, "cubic", "hevc", "libx265", "2M") == 0
    assert destination.is_file()
    assert insv.read_bytes() == before


@needs_ffmpeg
def test_run_leaves_no_staging_directory(insv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    destination = tmp_path / "整片.mp4"
    assert tool.run(str(insv), str(destination), "640x320", 210.0, "cubic", "hevc", "libx265", "2M") == 0
    assert [path.name for path in tmp_path.iterdir()] == ["整片.mp4"]


@needs_ffmpeg
@pytest.mark.skipif(not tool.sys.platform.startswith("win"), reason="导出工具只在 Windows 上运行")
def test_preview_gets_its_own_default_name(insv, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    assert tool.main([str(insv), "--preview", "0.1", "--encoder", "libx265", "--bitrate", "2M", "--size", "640x320"]) == 0
    assert (insv.parent / f"{insv.stem}_360_unofficial_preview.mp4").is_file()
    assert not (insv.parent / f"{insv.stem}_360_unofficial.mp4").exists()


@pytest.mark.parametrize("arguments", [["--preview", "0"], ["--in-fov", "400"], ["--in-fov", "0"]])
def test_main_rejects_bad_numbers(insv, arguments):
    assert tool.main([str(insv), *arguments]) == 1


@pytest.fixture(scope="module")
def lrv(tmp_path_factory):
    """单条并排双鱼眼视频轨加一条音轨，复刻 Insta360 .lrv 代理的结构。"""
    path = tmp_path_factory.mktemp("proxy") / "LRV_合成.lrv"
    width, height = LENS * 2, LENS
    with av.open(str(path), "w", format="mp4") as output:
        video = output.add_stream("libx265", rate=RATE, options=fast_options("libx265", 1))
        video.width = width
        video.height = height
        video.pix_fmt = "yuv420p"
        audio = output.add_stream("aac", rate=48000)
        audio.layout = "mono"
        audio.sample_rate = 48000
        for index in range(FRAMES):
            plane = np.full((height * 3 // 2, width), (index * 30) % 256, dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(plane, format="yuv420p")
            frame.pts = index
            for packet in video.encode(frame):
                output.mux(packet)
            sound = av.AudioFrame(format="fltp", layout="mono", samples=1600)
            sound.sample_rate = 48000
            sound.pts = index * 1600
            sound.planes[0].update(np.zeros((1, 1600), dtype=np.float32))
            for packet in audio.encode(sound):
                output.mux(packet)
        for packet in video.encode():
            output.mux(packet)
        for packet in audio.encode():
            output.mux(packet)
    return path


def test_open_geometry_dual_for_two_tracks():
    mode, lenses = tool.open_geometry(lens_container([lens_stream(0), lens_stream(1)]))
    assert mode == "dual"
    assert tuple(stream.index for stream in lenses) == (0, 1)


def test_open_geometry_packed_for_single_2_to_1_track():
    mode, lenses = tool.open_geometry(lens_container([lens_stream(0, name="h264", width=1664, height=832)]))
    assert mode == "packed"
    assert lenses[0].index == 0


def test_packed_lens_accepts_single_2_to_1_track():
    stream = tool.packed_lens(lens_container([lens_stream(0, name="h264", width=1664, height=832)]))
    assert stream.index == 0


@pytest.mark.parametrize(
    "stream,message",
    [
        (lens_stream(0, name="h264", width=1600, height=832), "2:1"),
        (lens_stream(0, name="h264", width=1665, height=832), "偶数"),
    ],
)
def test_packed_lens_rejects_bad_geometry(stream, message):
    with pytest.raises(tool.ExportError, match=message):
        tool.packed_lens(lens_container([stream]))


def test_packed_lens_needs_a_video_track():
    with pytest.raises(tool.ExportError, match="没有视频轨"):
        tool.packed_lens(lens_container([]))


@needs_ffmpeg
def test_transcode_handles_single_track_lrv(lrv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    destination = tmp_path / "代理全景.mp4"
    frames = tool.transcode(
        str(lrv), str(destination), 640, 320, 190.0, "cubic", "hevc", "libx265", 2_000_000
    )
    assert frames == FRAMES
    seconds, has_audio = tool.validate(str(destination), 640, 320, 0.2)
    assert has_audio
    with av.open(str(destination)) as container:
        video = container.streams.video[0]
        assert (video.codec_context.width, video.codec_context.height) == (640, 320)


@needs_ffmpeg
def test_preview_stops_after_requested_seconds_for_lrv(lrv, tmp_path, monkeypatch):
    monkeypatch.setattr(tool, "encoder_options", fast_options)
    frames = tool.transcode(
        str(lrv), str(tmp_path / "代理预览.mp4"), 640, 320, 190.0, "cubic", "hevc", "libx265",
        2_000_000, preview_seconds=0.1,
    )
    assert frames == 3

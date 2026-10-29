#!/usr/bin/env python3
"""Generate original, redistributable native playback fixtures (requires ffmpeg).

Only the supplied system font is third-party; its license must accompany any
redistribution. Fixtures stay in ignored outputs and are not release assets.
"""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess


def run(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args], check=True)


def segment(kind, data, seconds=0):
    return b"PG" + struct.pack(">IIBH", int(seconds * 90000), 0, kind, len(data)) + data


def pgs():
    # Original white rectangle on a transparent palette, then clear at 3.5 s.
    def composition(count, number, state):
        data = struct.pack(">HHBHB BBB", 320, 180, 0x10, number, state, 0, 0, count)
        return data + (struct.pack(">HBBHH", 0, 0, 0, 24, 140) if count else b"")
    rle = (b"\x01" * 96 + b"\x00\x00") * 16
    obj = struct.pack(">HBB", 0, 0, 0xC0) + (len(rle) + 4).to_bytes(3, "big") + struct.pack(">HH", 96, 16) + rle
    return b"".join([
        segment(0x16, composition(1, 0, 0x80), .5),
        segment(0x17, struct.pack(">BBHHHH", 1, 0, 0, 0, 320, 180), .5),
        segment(0x14, bytes([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255]), .5),
        segment(0x15, obj, .5), segment(0x80, b"", .5),
        segment(0x16, composition(0, 1, 0), 3.5), segment(0x80, b"", 3.5),
    ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--font", type=Path, default=Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if not args.font.is_file():
        parser.error("Pass an installed DejaVuSans.ttf using --font")
    (root / "fixture.sup").write_bytes(pgs())
    (root / "fixture.ass").write_text("""[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,22,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,12,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:03.50,Default,,0,0,0,,WatchPair ASS fixture
""", encoding="utf-8")
    (root / "chapters.txt").write_text(""";FFMETADATA1
[CHAPTER]
TIMEBASE=1/1000
START=0
END=2000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=2000
END=6000
title=Episode
""", encoding="utf-8")
    video = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6"]
    run(*video, "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart", str(root / "h264.mp4"))
    run(*video, "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=2:log-level=error",
        "-pix_fmt", "yuv420p10le", str(root / "hevc10.mkv"))
    run(*video, "-c:v", "libaom-av1", "-cpu-used", "8", "-row-mt", "1", "-threads", "2", "-crf", "40",
        str(root / "av1.mkv"))
    run(*video, "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
        "pools=2:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
        "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", str(root / "hdr-pq.mkv"))
    run("-i", str(root / "h264.mp4"), "-f", "lavfi", "-i",
        "aevalsrc=0.04*sin(2*PI*220*t)|0.04*sin(2*PI*330*t)|0.04*sin(2*PI*440*t)|0.04*sin(2*PI*110*t)|0.04*sin(2*PI*550*t)|0.04*sin(2*PI*660*t):s=48000:d=6:c=5.1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
        "-i", str(root / "fixture.ass"), "-i", str(root / "fixture.sup"), "-i", str(root / "chapters.txt"),
        "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s",
        "-map_metadata", "5", "-map_chapters", "5", "-c:v", "copy", "-c:a:0", "flac", "-c:a:1", "aac",
        "-c:s", "copy", "-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=eng",
        "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=jpn",
        "-attach", str(args.font), "-metadata:s:t", "mimetype=application/x-truetype-font", str(root / "tracks.mkv"))
    checks = {}
    for name in ["h264.mp4", "hevc10.mkv", "av1.mkv", "hdr-pq.mkv", "tracks.mkv"]:
        data = subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_chapters", "-of", "json", str(root / name)])
        checks[name] = json.loads(data)
    (root / "fixture-manifest.json").write_text(json.dumps(checks, indent=2), encoding="utf-8")
    shutil.copyfile(args.font, root / "fixture-font.ttf")
    print(root)


if __name__ == "__main__":
    main()

import assert from "node:assert/strict";
import test from "node:test";
import { mediaToolArguments, mediaToolPath } from "../agent/media-tool-paths.mjs";
import {
  chapterProbeArguments,
  mediaDurationFromProbe,
  normalizeMediaChapters,
} from "../agent/media-chapters.mjs";

test("native media tools receive extended Windows paths without changing URLs or filters", () => {
  const drive = "C:\\Downloads\\Season 2\\Episode 1.mkv";
  const network = "\\\\server\\media\\Episode 1.mkv";
  assert.equal(mediaToolPath(drive, "win32"), "\\\\?\\" + drive);
  assert.equal(mediaToolPath(network, "win32"), "\\\\?\\UNC\\server\\media\\Episode 1.mkv");
  assert.equal(mediaToolPath(mediaToolPath(drive, "win32"), "win32"), mediaToolPath(drive, "win32"));
  const unchanged = ["-i", "https://example.test/input.mkv", "pipe:1", "video/index.m3u8", "format=yuv420p", "/media/input.mkv"];
  assert.deepEqual(mediaToolArguments(unchanged, "win32"), unchanged);
  assert.deepEqual(mediaToolArguments([drive, network], "linux"), [drive, network]);
});

test("chapter probe asks ffprobe for streams and chapters", () => {
  assert.deepEqual(chapterProbeArguments("/videos/movie.mkv"), [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_chapters",
    "-show_format",
    "/videos/movie.mkv",
  ]);
});

test("normalizes, sorts, and labels media chapters", () => {
  assert.deepEqual(
    normalizeMediaChapters([
      {
        id: 7,
        start_time: "60.5",
        end_time: "120.0",
        tags: { title: "Act two", language: "ENG" },
      },
      {
        id: 2,
        start_time: "0.0",
        end_time: "60.5",
        tags: {},
      },
      {
        id: 9,
        start_time: "not-a-time",
        end_time: "180",
      },
    ]),
    [
      {
        id: "2",
        index: 0,
        title: "Chapter 2",
        start: 0,
        end: 60.5,
        language: "und",
      },
      {
        id: "7",
        index: 1,
        title: "Act two",
        start: 60.5,
        end: 120,
        language: "eng",
      },
    ]
  );
});

test("uses stream duration and removes positive timestamp offsets from format fallback", () => {
  assert.equal(mediaDurationFromProbe({
    streams: [{ codec_type: "video", duration: "600.25", start_time: "5" }],
    format: { duration: "605.25", start_time: "5" },
  }), 600.25);
  assert.equal(mediaDurationFromProbe({
    streams: [{ codec_type: "video", start_time: "5" }],
    format: { duration: "605.25", start_time: "5" },
  }), 600.25);
  assert.equal(mediaDurationFromProbe({
    streams: [{ codec_type: "video", start_time: "-0.25" }],
    format: { duration: "600" },
  }), 600);
  assert.equal(mediaDurationFromProbe({ streams: [], format: {} }), null);
});

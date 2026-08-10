import assert from "node:assert/strict";
import test from "node:test";
import {
  chapterProbeArguments,
  mediaDurationFromProbe,
  normalizeMediaChapters,
} from "../agent/media-chapters.mjs";

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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import {
  batchFontExtractionArgs,
  batchSubtitleExtractionArgs,
  fontAssetMetadata,
  fontAttachmentMetadata,
  fontExtractionArgs,
  fontExtractionPlan,
  isFontAttachment,
  safeFontExtension,
  subtitleAssetMetadata,
  subtitleExtractionArgs,
  subtitleExtractionPlan,
  textSubtitleStreams,
} from "../agent/subtitle-assets.mjs";

const runFile = promisify(execFile);

test("identifies supported MKV font attachments and creates cache-safe metadata", () => {
  const streams = [
    { codec_type: "attachment", index: 4, tags: { filename: "Fansub.otf", mimetype: "application/vnd.ms-opentype" } },
    { codec_type: "attachment", index: 5, tags: { filename: "cover.jpg", mimetype: "image/jpeg" } },
    { codec_type: "attachment", index: 6, tags: { filename: "Fallback.ttf", mimetype: "bad\\r\nheader" } },
  ];

  assert.equal(isFontAttachment(streams[0]), true);
  assert.equal(isFontAttachment(streams[1]), false);
  assert.deepEqual(fontAttachmentMetadata(streams, (stream) => `/fonts/${stream.index}`), [
    {
      id: "4",
      streamIndex: 4,
      name: "Fansub.otf",
      mimeType: "application/vnd.ms-opentype",
      url: "/fonts/4",
    },
    {
      id: "6",
      streamIndex: 6,
      name: "Fallback.ttf",
      mimeType: "application/octet-stream",
      url: "/fonts/6",
    },
  ]);

  const fontAssets = fontAssetMetadata(streams, (stream) => `/fonts/${stream.index}`, { mediaKey: "media-sha" });
  assert.deepEqual(fontAssets.map((asset) => asset.ordinal), [0, 2]);
  assert.equal(fontAssets[0].cacheKey, fontAssetMetadata([...streams].reverse(), (stream) => `/fonts/${stream.index}`, { mediaKey: "media-sha" })[0].cacheKey);
  assert.match(fontAssets[0].cacheKey, /^font-[a-f0-9]{24}$/);
  assert.equal(safeFontExtension("Fansub.OTF"), ".otf");
  assert.equal(safeFontExtension("../../unsafe.exe"), ".font");
});

test("plans all text subtitle tracks in one invocation without video or audio outputs", () => {
  const streams = [
    { codec_type: "video", codec_name: "hevc", index: 0 },
    { codec_type: "subtitle", codec_name: "subrip", index: 4, tags: { language: "eng" } },
    { codec_type: "subtitle", codec_name: "ass", index: 2, tags: { language: "jpn" } },
    { codec_type: "audio", codec_name: "aac", index: 1 },
    { codec_type: "subtitle", codec_name: "dvd_subtitle", index: 8 },
  ];
  const plan = subtitleExtractionPlan("/media/movie.mkv", streams, "/cache/subtitles", { mediaKey: "sha256" });

  assert.deepEqual(textSubtitleStreams(streams).map((stream) => stream.index), [2, 4]);
  assert.equal(plan.assets.length, 2);
  assert.equal(plan.args.filter((argument) => argument === "-i").length, 1);
  assert.equal(plan.args.filter((argument) => argument === "-map").length, 2);
  assert.ok(plan.args.includes("0:2"));
  assert.ok(plan.args.includes("0:4"));
  assert.equal(plan.args.some((argument) => argument.includes("0:v") || argument.includes("0:a")), false);
  assert.equal(plan.args.includes("-f") && plan.args.includes("null"), false);
  assert.equal(plan.decodesVideo, false);
  assert.equal(plan.decodesAudio, false);
  assert.equal(plan.outputsFrames, false);
  assert.equal(plan.assets[0].format, "ass");
  assert.equal(plan.assets[0].outputPath, path.join("/cache/subtitles", "subtitle-2.ass"));
  assert.equal(plan.assets[1].format, "webvtt");
  assert.equal(plan.assets[1].outputPath, path.join("/cache/subtitles", "subtitle-4.vtt"));
  assert.match(plan.assets[0].cacheKey, /^subtitle-[a-f0-9]{24}$/);
  assert.deepEqual(
    subtitleAssetMetadata(streams, (stream) => `/subtitles/${stream.index}`, { mediaKey: "sha256" }),
    [
      {
        id: "2",
        streamIndex: 2,
        codec: "ass",
        format: "ass",
        language: "jpn",
        title: "",
        default: false,
        forced: false,
        styled: true,
        cacheKey: plan.assets[0].cacheKey,
        url: "/subtitles/2",
      },
      {
        id: "4",
        streamIndex: 4,
        codec: "subrip",
        format: "webvtt",
        language: "eng",
        title: "",
        default: false,
        forced: false,
        styled: false,
        cacheKey: plan.assets[1].cacheKey,
        url: "/subtitles/4",
      },
    ],
  );

  const fallbackPlan = subtitleExtractionPlan("/media/movie.mkv", streams, "/cache/subtitles", {
    includeVttFallback: true,
  });
  assert.deepEqual(fallbackPlan.assets.map((asset) => asset.format), ["ass", "webvtt", "webvtt"]);
  assert.equal(fallbackPlan.args.filter((argument) => argument === "-i").length, 1);
  const compatibilityArgs = batchSubtitleExtractionArgs("/media/movie.mkv", streams, "/cache/subtitles", { mediaKey: "sha256" });
  assert.deepEqual(compatibilityArgs, plan.args);
});

test("plans every embedded font in one header-oriented invocation", () => {
  const streams = [
    { codec_type: "attachment", index: 10, tags: { filename: "z.ttf", mimetype: "font/ttf" } },
    { codec_type: "attachment", index: 3, tags: { filename: "a.otf", mimetype: "font/otf" } },
    { codec_type: "attachment", index: 9, tags: { filename: "cover.jpg", mimetype: "image/jpeg" } },
  ];
  const plan = fontExtractionPlan("/media/movie.mkv", streams, "/cache/fonts", { mediaKey: "sha256" });
  const inputIndex = plan.args.indexOf("-i");

  assert.deepEqual(plan.assets.map((asset) => asset.streamIndex), [3, 10]);
  assert.equal(plan.args.filter((argument) => argument.startsWith("-dump_attachment")).length, 2);
  assert.ok(plan.args.indexOf("-dump_attachment:t:0") < inputIndex);
  assert.ok(plan.args.indexOf("-dump_attachment:t:2") < inputIndex);
  assert.equal(plan.args.includes("null"), false);
  assert.equal(plan.args.includes("0:v"), false);
  assert.equal(plan.args.includes("0:a"), false);
  assert.equal(plan.args.includes("pipe:1"), true);
  assert.equal(plan.args.includes("0:t?"), true);
  assert.equal(plan.args[plan.args.indexOf("-t") + 1], "0");
  assert.ok(plan.args.indexOf("-t") > inputIndex);
  assert.equal(plan.headerOnly, true);
  assert.equal(plan.decodesVideo, false);
  assert.equal(plan.decodesAudio, false);
  assert.deepEqual(batchFontExtractionArgs("/media/movie.mkv", streams, "/cache/fonts", { mediaKey: "sha256" }), plan.args);
});

test("keeps compatibility wrappers free of frame-decode outputs", () => {
  const subtitleArgs = subtitleExtractionArgs("/media/movie.mkv", 7, "ass", "/cache/subtitle.ass");
  const fontArgs = fontExtractionArgs("/media/movie.mkv", 8, "/cache/font.ttf", process.platform === "win32" ? "NUL" : "/dev/null");

  assert.ok(subtitleArgs.includes("-map"));
  assert.equal(subtitleArgs.includes("0:7"), true);
  assert.equal(fontArgs.includes("-dump_attachment:t:0"), true);
  assert.ok(fontArgs.indexOf("-dump_attachment:t:0") < fontArgs.indexOf("-i"));
  assert.equal(fontArgs.includes("null"), false);
  assert.equal(fontArgs.includes("pipe:1"), true);
  assert.equal(fontArgs.includes("NUL"), false);
  assert.equal(fontArgs.includes("/dev/null"), false);
});

test("extracts multiple positioned ASS tracks and embedded fonts from MKV", async (t) => {
  if (!ffmpegPath) return t.skip("ffmpeg-static is unavailable");
  const directory = path.join(tmpdir(), `watchpair-ass-${process.pid}-${Date.now()}`);
  const firstAssPath = path.join(directory, "first.ass");
  const secondAssPath = path.join(directory, "second.ass");
  const mkvPath = path.join(directory, "input.mkv");
  const fontPath = path.resolve("node_modules/jassub/dist/default.woff2");
  const ass = (text, position) => [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 640",
    "PlayResY: 360",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Liberation Sans,24,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\pos(${position},80)}${text}`,
  ].join("\n");

  await mkdir(directory, { recursive: true });
  await writeFile(firstAssPath, ass("First", 120));
  await writeFile(secondAssPath, ass("Second", 240));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await runFile(ffmpegPath, [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:d=2",
    "-i", firstAssPath,
    "-i", secondAssPath,
    "-map", "0:v", "-map", "1:s", "-map", "2:s",
    "-c:v", "mpeg4", "-t", "2", "-c:s", "ass",
    "-attach", fontPath,
    "-metadata:s:t", "mimetype=font/woff2",
    "-metadata:s:t", "filename=default.woff2",
    mkvPath,
  ]);

  const streamMetadata = [
    { codec_type: "subtitle", codec_name: "ass", index: 1 },
    { codec_type: "subtitle", codec_name: "ass", index: 2 },
  ];
  const subtitlePlan = subtitleExtractionPlan(mkvPath, streamMetadata, directory);
  await runFile(ffmpegPath, subtitlePlan.args);
  const firstOutput = await readFile(subtitlePlan.assets[0].outputPath, "utf8");
  const secondOutput = await readFile(subtitlePlan.assets[1].outputPath, "utf8");
  assert.match(firstOutput, /pos\(120,80\)/);
  assert.match(secondOutput, /pos\(240,80\)/);

  const fontPlan = fontExtractionPlan(mkvPath, [
    { codec_type: "attachment", index: 3, tags: { filename: "default.woff2", mimetype: "font/woff2" } },
  ], directory);
  await runFile(ffmpegPath, fontPlan.args);
  assert.deepEqual(await readFile(fontPlan.assets[0].outputPath), await readFile(fontPath));
});

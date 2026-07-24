import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ffmpegPath from "ffmpeg-static";
import {
  fontAttachmentMetadata,
  fontExtractionArgs,
  isFontAttachment,
  safeFontExtension,
  subtitleExtractionArgs,
} from "../agent/subtitle-assets.mjs";

const runFile = promisify(execFile);

test("identifies supported MKV font attachments and creates cache-safe metadata", () => {
  const streams = [
    { codec_type: "attachment", index: 4, tags: { filename: "Fansub.otf", mimetype: "application/vnd.ms-opentype" } },
    { codec_type: "attachment", index: 5, tags: { filename: "cover.jpg", mimetype: "image/jpeg" } },
    { codec_type: "attachment", index: 6, tags: { filename: "Fallback.ttf", mimetype: "bad\r\nheader" } },
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
  assert.equal(safeFontExtension("Fansub.OTF"), ".otf");
  assert.equal(safeFontExtension("../../unsafe.exe"), ".font");
});

test("extracts overlapping positioned ASS dialogue and embedded fonts from MKV", async (t) => {
  if (!ffmpegPath) return t.skip("ffmpeg-static is unavailable");
  const directory = path.join(tmpdir(), `watchpair-ass-${process.pid}-${Date.now()}`);
  const assPath = path.join(directory, "input.ass");
  const mkvPath = path.join(directory, "input.mkv");
  const extractedAss = path.join(directory, "output.ass");
  const extractedFont = path.join(directory, "font.woff2");
  const fontPath = path.resolve("node_modules/jassub/dist/default.woff2");
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const ass = [
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
    "Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\pos(120,80)}First",
    "Dialogue: 1,0:00:00.50,0:00:02.00,Default,,0,0,0,,Second",
  ].join("\n");

  await mkdir(directory, { recursive: true });
  await writeFile(assPath, ass);
  t.after(() => rm(directory, { recursive: true, force: true }));

  await runFile(ffmpegPath, [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:d=2",
    "-i", assPath,
    "-map", "0:v", "-map", "1:s",
    "-c:v", "mpeg4", "-t", "2", "-c:s", "ass",
    "-attach", fontPath,
    "-metadata:s:t", "mimetype=font/woff2",
    "-metadata:s:t", "filename=default.woff2",
    mkvPath,
  ]);
  await runFile(ffmpegPath, subtitleExtractionArgs(mkvPath, 1, "ass", extractedAss));
  await runFile(ffmpegPath, fontExtractionArgs(mkvPath, 2, extractedFont, nullDevice));

  const output = await readFile(extractedAss, "utf8");
  assert.match(output, /pos\(120,80\)/);
  assert.equal((output.match(/^Dialogue:/gm) || []).length, 2);
  assert.deepEqual(await readFile(extractedFont), await readFile(fontPath));
});

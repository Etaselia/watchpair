import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSubtitleAssetPipeline } from "../agent/subtitle-pipeline.mjs";

test("subtitle pipeline batches fonts and text once per content identity", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-subtitle-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const runScheduledFfmpeg = async (task) => {
    calls.push(task);
    const args = task.arguments;
    for (let index = 0; index < args.length; index += 1) {
      if (String(args[index]).startsWith("-dump_attachment:t:")) {
        await writeFile(args[index + 1], `font-${args[index]}`);
      }
      if (args[index] === "-f" && ["ass", "webvtt"].includes(args[index + 1])) {
        await writeFile(args[index + 2], `subtitle-${args[index + 1]}`);
      }
    }
  };
  const pipeline = createSubtitleAssetPipeline({ cacheRoot: directory, runScheduledFfmpeg });
  const descriptor = {
    mediaPath: "/media/one.mkv",
    mediaKey: "aaaaaaaaaaaaaaaa",
    fileSize: 12345,
    streams: [
      { codec_type: "subtitle", codec_name: "ass", index: 2 },
      { codec_type: "subtitle", codec_name: "subrip", index: 4 },
      { codec_type: "attachment", index: 5, tags: { filename: "first.ttf", mimetype: "font/ttf" } },
      { codec_type: "attachment", index: 6, tags: { filename: "cover.jpg", mimetype: "image/jpeg" } },
      { codec_type: "attachment", index: 7, tags: { filename: "second.otf", mimetype: "font/otf" } },
    ],
  };

  const first = await pipeline.prepare(descriptor);
  const second = await pipeline.prepare({ ...descriptor, mediaPath: "/media/equivalent-copy.mkv" });

  assert.equal(first, second);
  assert.equal(first.fonts.size, 2);
  assert.equal(first.subtitles.size, 3);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.priority), [30, 20]);
  assert.equal(calls[0].captureProgress, false);
  assert.ok(calls[0].arguments.includes("-dump_attachment:t:0"));
  assert.ok(calls[0].arguments.includes("-dump_attachment:t:2"));
  assert.equal(calls[1].arguments.filter((argument) => argument === "-i").length, 1);
  assert.equal(calls[1].arguments.some((argument) => /0:[va]/.test(argument)), false);

  await rm(first.subtitles.values().next().value);
  const repaired = await pipeline.prepare(descriptor);
  assert.notEqual(repaired, first);
  assert.equal(calls.length, 3);
});

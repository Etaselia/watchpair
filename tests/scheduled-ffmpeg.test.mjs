import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createMediaTaskScheduler } from "../agent/media-governor.mjs";
import { createProcessRegistry } from "../agent/process-registry.mjs";
import { createScheduledFfmpegRunner } from "../agent/scheduled-ffmpeg.mjs";

test("scheduled FFmpeg work reports progress without exposing media paths", async () => {
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({ monitor });
  const registry = createProcessRegistry();
  let spawnedArguments;
  const spawnProcess = (_command, args) => {
    spawnedArguments = args;
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.write("frame=12\nspeed=2.5x\nout_time_ms=1000000\nprogress=end\n");
      child.emit("close", 0, null);
    });
    return child;
  };
  const run = createScheduledFfmpegRunner({
    ffmpegPath: "ffmpeg",
    scheduler,
    processRegistry: registry,
    spawnProcess,
  });

  await run({
    jobId: "job-one",
    taskId: "subtitle:all",
    stage: "subtitles",
    inputPath: "/secret/input.mkv",
    arguments: ["-i", "/secret/input.mkv", "out.vtt"],
  });

  assert.deepEqual(spawnedArguments.slice(0, 3), ["-progress", "pipe:1", "-nostats"]);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.active.length, 0);
  assert.equal(snapshot.recent[0].status, "completed");
  assert.equal(snapshot.recent[0].progress.frame, 12);
  assert.ok(snapshot.recent[0].arguments.includes("<media>"));
  assert.ok(!JSON.stringify(snapshot).includes("/secret/input.mkv"));
  scheduler.shutdown();
});

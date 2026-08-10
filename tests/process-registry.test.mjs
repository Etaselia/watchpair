import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createProcessRegistry } from "../agent/process-registry.mjs";

test("process registry reports active work without exposing media paths", () => {
  const child = new EventEmitter();
  child.pid = 42;
  const events = [];
  const registry = createProcessRegistry({
    onEvent: (event, data) => events.push({ event, data }),
  });
  const tracker = registry.track(child, {
    jobId: "job", stage: "video", command: "C:\\tools\\ffmpeg.exe",
    arguments: ["-i", "C:\\private\\episode.mkv", "C:\\private\\cache\\output.m3u8"],
    privatePaths: ["C:\\private\\episode.mkv"], hardware: true,
  });
  tracker.update({ frame: "120", speed: "2.4x", progress: "continue" });
  const active = registry.snapshot().active[0];
  assert.equal(active.command, "ffmpeg.exe");
  assert.equal(active.arguments.at(-2), "<media>");
  assert.equal(active.arguments.at(-1), "<path>");
  assert.equal(active.progress.frame, 120);
  assert.equal(active.hardware, true);
  child.emit("close", 0, null);
  assert.equal(registry.snapshot().active.length, 0);
  assert.equal(registry.snapshot().recent[0].status, "completed");
  assert.deepEqual(events.map((entry) => entry.event), [
    "media_process_started",
    "media_process_finished",
  ]);
  assert.equal(events[0].data.arguments.at(-2), "<media>");
  assert.ok(events[1].data.durationMs >= 0);
});


test("process registry terminates children and force-kills stragglers before shutdown completes", async () => {
  const events = [];
  const registry = createProcessRegistry({
    onEvent: (event, data) => events.push({ event, data }),
  });

  const graceful = new EventEmitter();
  graceful.pid = 101;
  graceful.kill = (signal) => {
    queueMicrotask(() => graceful.emit("close", null, signal));
    return true;
  };
  registry.track(graceful, { stage: "video", command: "ffmpeg" });

  const stubborn = new EventEmitter();
  stubborn.pid = 102;
  const stubbornSignals = [];
  stubborn.kill = (signal) => {
    stubbornSignals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => stubborn.emit("close", null, signal));
    return true;
  };
  registry.track(stubborn, { stage: "audio", command: "ffmpeg" });

  const result = await registry.terminateAll({ graceMs: 5, forceMs: 100 });
  assert.equal(result.started, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.empty, true);
  assert.deepEqual(stubbornSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(registry.snapshot().closing, true);
  assert.equal(registry.snapshot().active.length, 0);
  assert.ok(events.some(({ event }) => event === "media_process_shutdown_started"));
  assert.ok(events.some(({ event }) => event === "media_process_shutdown_finished"));

  const late = new EventEmitter();
  late.pid = 103;
  late.kill = (signal) => {
    queueMicrotask(() => late.emit("close", null, signal));
    return true;
  };
  registry.track(late, { stage: "late", command: "ffmpeg" });
  assert.equal(await registry.waitForEmpty(100), true);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createProcessRegistry } from "../agent/process-registry.mjs";

test("process registry reports active work without exposing media paths", () => {
  const child = new EventEmitter();
  child.pid = 42;
  const registry = createProcessRegistry();
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
});

import assert from "node:assert/strict";
import test from "node:test";
import { createMediaTaskScheduler, mediaResourceProfile, normalizeResourceMode } from "../agent/media-governor.mjs";

test("resource modes reserve control-plane capacity", () => {
  assert.equal(normalizeResourceMode("unknown"), "balanced");
  const eco = mediaResourceProfile("foreground", { mode: "eco", logicalCores: 8 });
  const balanced = mediaResourceProfile("foreground", { mode: "balanced", logicalCores: 8 });
  const fast = mediaResourceProfile("foreground", { mode: "fast", logicalCores: 8 });
  assert.equal(eco.threads, 4);
  assert.equal(balanced.threads, 6);
  assert.equal(fast.threads, 7);
  assert.ok(eco.inputRate < balanced.inputRate);
  assert.ok(balanced.inputRate < fast.inputRate);
  assert.equal(mediaResourceProfile("background", { mode: "fast", logicalCores: 2 }).threads, 1);
});

test("media scheduler runs one heavy task and prioritizes selected work", async () => {
  const order = [];
  let release;
  const monitor = { snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }), shouldDeferBackground: () => false, stop() {} };
  const scheduler = createMediaTaskScheduler({ monitor });
  const first = scheduler.enqueue({
    taskId: "one", jobId: "background", stage: "video",
    run: async () => ({ value: "one", completion: new Promise((resolve) => { release = () => { order.push("one"); resolve(); }; }) }),
  });
  await first;
  const second = scheduler.enqueue({ taskId: "two", jobId: "later", stage: "video", run: async () => ({ value: "two", completion: Promise.resolve().then(() => order.push("two")) }) });
  const selected = scheduler.enqueue({ taskId: "selected", jobId: "selected", stage: "video", run: async () => ({ value: "selected", completion: Promise.resolve().then(() => order.push("selected")) }) });
  scheduler.prioritize("selected");
  release();
  await Promise.all([second, selected]);
  assert.deepEqual(order, ["one", "selected", "two"]);
  scheduler.shutdown();
});

test("media scheduler defers background work under pressure but admits selected work", async () => {
  let started = false;
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 125, systemCpuPercent: 92 }),
    shouldDeferBackground: () => true,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({ monitor, retryDelayMs: 1 });
  const work = scheduler.enqueue({
    taskId: "deferred",
    jobId: "selected",
    stage: "video",
    run: async (profile) => {
      started = true;
      return { value: profile.kind, completion: Promise.resolve() };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, false);
  scheduler.prioritize("selected");
  assert.equal(await work, "foreground");
  assert.equal(scheduler.snapshot().responsiveness.systemCpuPercent, 92);
  scheduler.shutdown();
});

test("selected playback preempts lower-priority subtitle work for the same content", async () => {
  const events = [];
  let releaseSubtitles;
  const subtitleCompletion = new Promise((resolve) => { releaseSubtitles = resolve; });
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({ monitor });
  scheduler.prioritize("content-one");
  const subtitles = scheduler.enqueue({
    taskId: "subtitles",
    jobId: "content-one",
    stage: "subtitles",
    priority: 20,
    run: async () => ({
      value: "subtitles",
      completion: subtitleCompletion.then(() => events.push("subtitles:stopped")),
      interrupt: () => { events.push("subtitles:interrupt"); releaseSubtitles(); },
    }),
  });
  assert.equal(await subtitles, "subtitles");

  const playback = scheduler.enqueue({
    taskId: "hls",
    jobId: "content-one",
    stage: "browser-playback",
    priority: 50,
    run: async () => ({ value: "hls", completion: Promise.resolve().then(() => events.push("hls")) }),
  });
  assert.equal(await playback, "hls");
  assert.deepEqual(events, ["subtitles:interrupt", "subtitles:stopped", "hls"]);
  scheduler.shutdown();
});

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
  assert.equal(eco.inputRate, null);
  assert.equal(balanced.inputRate, null);
  assert.equal(fast.inputRate, null);
  const ecoBackground = mediaResourceProfile("background", { mode: "eco", logicalCores: 8 });
  const balancedBackground = mediaResourceProfile("background", { mode: "balanced", logicalCores: 8 });
  const fastBackground = mediaResourceProfile("background", { mode: "fast", logicalCores: 8 });
  assert.equal(ecoBackground.inputRate, null);
  assert.equal(balancedBackground.inputRate, null);
  assert.equal(fastBackground.inputRate, null);
  assert.equal(mediaResourceProfile("background", { mode: "balanced", logicalCores: 16 }).inputRate, null);
  assert.equal(mediaResourceProfile("background", { mode: "fast", logicalCores: 2 }).threads, 1);
  const highEndForeground = mediaResourceProfile("foreground", { mode: "balanced", logicalCores: 16 });
  const highEndBackground = mediaResourceProfile("background", { mode: "balanced", logicalCores: 16 });
  assert.equal(highEndForeground.systemTier, "high");
  assert.equal(highEndForeground.threads, 15);
  assert.equal(highEndForeground.gpuSurfaces, 20);
  assert.equal(highEndBackground.threads, 7);
  assert.equal(highEndBackground.gpuSurfaces, 12);
});

test("promoting an active background render restarts it with foreground resources", async () => {
  const events = [];
  let release;
  let interrupted = false;
  const completion = new Promise((resolve) => {
    release = resolve;
  });
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({
    monitor,
    onEvent: (event, data) => events.push({ event, data }),
  });
  const task = scheduler.enqueue({
    taskId: "episode-render",
    jobId: "episode",
    stage: "browser-playback",
    restartOnPromotion: true,
    run: async (profile) => ({
      value: profile,
      completion,
      interrupt: () => {
        interrupted = true;
        release();
      },
    }),
  });

  assert.equal((await task).kind, "background");
  scheduler.prioritize("episode");
  for (let attempt = 0; attempt < 20 && !interrupted; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(interrupted, true);
  assert.ok(events.some(({ event, data }) =>
    event === "media_task_preempted" && data.reason === "foreground-profile"
  ));
  scheduler.shutdown();
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

test("media scheduler follows explicit watch order instead of task arrival order", async () => {
  const order = [];
  let releaseCurrent;
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({ monitor });
  const current = scheduler.enqueue({
    taskId: "current",
    jobId: "episode-one",
    stage: "browser-playback",
    run: async () => ({
      value: "current",
      completion: new Promise((resolve) => {
        releaseCurrent = () => {
          order.push("episode-one");
          resolve();
        };
      }),
    }),
  });
  await current;

  scheduler.setJobOrder(["episode-two", "episode-three", "episode-eight"]);
  const enqueueEpisode = (jobId) => scheduler.enqueue({
    taskId: jobId,
    jobId,
    stage: "browser-playback",
    run: async () => ({
      value: jobId,
      completion: Promise.resolve().then(() => order.push(jobId)),
    }),
  });
  const episodeEight = enqueueEpisode("episode-eight");
  const episodeThree = enqueueEpisode("episode-three");
  const episodeTwo = enqueueEpisode("episode-two");
  releaseCurrent();
  await Promise.all([episodeEight, episodeThree, episodeTwo]);

  assert.deepEqual(order, [
    "episode-one",
    "episode-two",
    "episode-three",
    "episode-eight",
  ]);
  scheduler.shutdown();
});

test("selected work waits for a non-preemptible HLS render instead of discarding it", async () => {
  const events = [];
  let releaseActive;
  let interrupted = false;
  let selectedStarted = false;
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({
    monitor,
    onEvent: (event, data) => events.push({ event, data }),
  });
  const active = scheduler.enqueue({
    taskId: "active-hls",
    jobId: "episode-one",
    stage: "browser-playback",
    preemptible: false,
    run: async () => ({
      value: "active",
      completion: new Promise((resolve) => { releaseActive = resolve; }),
      interrupt: () => { interrupted = true; releaseActive(); },
    }),
  });
  await active;
  const selected = scheduler.enqueue({
    taskId: "selected-hls",
    jobId: "episode-two",
    stage: "browser-playback",
    run: async () => {
      selectedStarted = true;
      return { value: "selected", completion: Promise.resolve() };
    },
  });
  scheduler.prioritize("episode-two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupted, false);
  assert.equal(selectedStarted, false);
  assert.ok(events.some(({ event }) => event === "media_task_preemption_deferred"));
  releaseActive();
  assert.equal(await selected, "selected");
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


test("selected subtitle extraction preempts HLS and the queued HLS resume follows it", async () => {
  const events = [];
  let releaseHls;
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({ monitor });
  scheduler.prioritize("content-one");
  const active = scheduler.enqueue({
    taskId: "hls-active",
    jobId: "content-one",
    stage: "browser-playback",
    priority: 50,
    run: async () => ({
      value: "hls-active",
      completion: new Promise((resolve) => { releaseHls = () => { events.push("hls:stopped"); resolve(); }; }),
      interrupt: () => { events.push("hls:interrupt"); releaseHls(); },
    }),
  });
  assert.equal(await active, "hls-active");

  const resumed = scheduler.enqueue({
    taskId: "hls-resume",
    jobId: "content-one",
    stage: "browser-playback",
    priority: 50,
    run: async () => ({
      value: "hls-resumed",
      completion: Promise.resolve().then(() => events.push("hls:resumed")),
    }),
  });
  const subtitles = scheduler.enqueue({
    taskId: "subtitles-urgent",
    jobId: "content-one",
    stage: "subtitles",
    priority: 80,
    run: async () => ({
      value: "subtitles",
      completion: Promise.resolve().then(() => events.push("subtitles:ready")),
    }),
  });

  assert.equal(await subtitles, "subtitles");
  assert.equal(await resumed, "hls-resumed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["hls:interrupt", "hls:stopped", "subtitles:ready", "hls:resumed"]);
  scheduler.shutdown();
});

test("media scheduler emits queue lifecycle diagnostics", async () => {
  const events = [];
  const monitor = {
    snapshot: () => ({ eventLoopDelayP95Ms: 0, systemCpuPercent: 0 }),
    shouldDeferBackground: () => false,
    stop() {},
  };
  const scheduler = createMediaTaskScheduler({
    monitor,
    onEvent: (event, data) => events.push({ event, data }),
  });
  const result = await scheduler.enqueue({
    taskId: "diagnostic-task",
    jobId: "diagnostic-job",
    stage: "video",
    run: async () => ({ value: "ready", completion: Promise.resolve() }),
  });
  assert.equal(result, "ready");
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.shutdown();

  assert.deepEqual(events.map((entry) => entry.event), [
    "media_task_queued",
    "media_task_started",
    "media_task_finished",
    "media_scheduler_stopping",
  ]);
  assert.ok(events[1].data.queuedMs >= 0);
  assert.ok(events[2].data.durationMs >= 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSerialRenderQueue,
  renderEncoderArguments,
  renderInputArguments,
  renderResourceProfile,
} from "../agent/render-queue.mjs";

test("render profiles reserve foreground capacity and constrain background work", () => {
  const foreground = renderResourceProfile("foreground", 16);
  const background = renderResourceProfile("background", 16);
  assert.equal(foreground.threads, 14);
  assert.equal(background.threads, 4);
  assert.equal(foreground.share, 0.85);
  assert.equal(background.share, 0.25);
  assert.deepEqual(renderInputArguments(background), ["-readrate", "1.5"]);
  assert.deepEqual(renderEncoderArguments({ id: "nvenc" }, background), [
    "-threads", "4", "-surfaces", "2",
  ]);
});

test("render queue runs one file at a time and promotes the selected file", async () => {
  const queue = createSerialRenderQueue();
  const events = [];
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  const run = (name, completion = Promise.resolve()) => async (profile) => {
    events.push(`${name}:start:${profile}`);
    return { value: name, completion: completion.then(() => events.push(`${name}:end`)) };
  };

  const first = queue.enqueue("first", run("first", firstDone));
  const second = queue.enqueue("second", run("second"));
  const selected = queue.enqueue("selected", run("selected"));
  queue.prioritize("selected");

  assert.equal(await first, "first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start:background"]);
  releaseFirst();
  assert.equal(await selected, "selected");
  assert.equal(await second, "second");
  assert.deepEqual(events, [
    "first:start:background", "first:end",
    "selected:start:foreground", "selected:end",
    "second:start:background", "second:end",
  ]);
});

test("selected work preempts and follows an active background render", async () => {
  const queue = createSerialRenderQueue();
  const events = [];
  let releaseBackground;
  const backgroundCompletion = new Promise((resolve) => { releaseBackground = resolve; });

  const background = queue.enqueue("background", async (profile) => ({
    value: profile,
    completion: backgroundCompletion.then(() => events.push("background:stopped")),
    interrupt: () => {
      events.push("background:interrupt");
      releaseBackground();
    },
  }));
  assert.equal(await background, "background");

  const selected = queue.enqueue("selected", async (profile) => {
    events.push("selected:start");
    return { value: profile, completion: Promise.resolve() };
  });
  queue.prioritize("selected");

  assert.equal(await selected, "foreground");
  assert.deepEqual(events, [
    "background:interrupt",
    "background:stopped",
    "selected:start",
  ]);
});

test("changing selection preempts the previous foreground file", async () => {
  const queue = createSerialRenderQueue();
  let releaseFirst;
  const firstCompletion = new Promise((resolve) => { releaseFirst = resolve; });
  let interrupted = false;
  queue.prioritize("first");
  const first = queue.enqueue("first", async (profile) => ({
    value: profile,
    completion: firstCompletion,
    interrupt: () => { interrupted = true; releaseFirst(); },
  }));
  assert.equal(await first, "foreground");

  const second = queue.enqueue("second", async (profile) => ({
    value: profile,
    completion: Promise.resolve(),
  }));
  queue.prioritize("second");
  assert.equal(await second, "foreground");
  assert.equal(interrupted, true);
});

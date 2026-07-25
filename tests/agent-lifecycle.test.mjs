import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskQueue, ownsAgentProcess } from "../desktop/agent-lifecycle.mjs";

test("agent transitions execute serially", async () => {
  const run = createSerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = run(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = run(async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a failed transition does not block the next transition", async () => {
  const run = createSerialTaskQueue();
  await assert.rejects(run(async () => { throw new Error("expected"); }), /expected/);
  assert.equal(await run(async () => "recovered"), "recovered");
});

test("stale utility-process exits cannot own the active agent", () => {
  const oldAgent = {};
  const activeAgent = {};
  assert.equal(ownsAgentProcess(activeAgent, oldAgent), false);
  assert.equal(ownsAgentProcess(activeAgent, activeAgent), true);
});

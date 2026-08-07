import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPreparedAgentAsset,
  mapWithConcurrency,
} from "../lib/agent-subtitle-fetch.mjs";

test("subtitle asset fetches release each preparing response before retrying", async () => {
  const responses = [
    new Response(JSON.stringify({ status: "preparing", retryAfterMs: 320 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
    new Response("WEBVTT\n\n", { status: 200 }),
  ];
  const waits = [];
  const observed = [];

  const response = await fetchPreparedAgentAsset("http://127.0.0.1/subtitle.vtt", {
    fetchImpl: async () => responses.shift(),
    wait: async (delayMs) => waits.push(delayMs),
    onResponse: (value) => observed.push(value.status),
  });

  assert.equal(await response.text(), "WEBVTT\n\n");
  assert.deepEqual(observed, [202, 200]);
  assert.deepEqual(waits, [320]);
});

test("subtitle asset retries stop immediately when their selection is cancelled", async () => {
  const controller = new AbortController();
  const pending = fetchPreparedAgentAsset("http://127.0.0.1/subtitle.ass", {
    signal: controller.signal,
    fetchImpl: async () => new Response(JSON.stringify({ retryAfterMs: 10_000 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  });

  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("font asset mapping obeys its connection limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

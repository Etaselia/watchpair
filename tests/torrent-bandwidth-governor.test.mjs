import assert from "node:assert/strict";
import test from "node:test";
import { createTorrentBandwidthGovernor } from "../agent/torrent-bandwidth-governor.mjs";

function target(key, downloaded, { peers = 4, productivePeers = 2 } = {}) {
  return { key, downloaded, peers, productivePeers, done: false };
}

function sample(governor, state, {
  foregroundBytes,
  backgroundBytes,
  totalDownloadSpeed,
  productivePeers = 2,
  resourceMode = "balanced",
}) {
  state.now += 1_000;
  state.foreground += foregroundBytes;
  state.background += backgroundBytes;
  return governor.update({
    sampledAt: state.now,
    totalDownloadSpeed,
    resourceMode,
    targets: [
      target("foreground:0", state.foreground, { productivePeers }),
      target("background:0", state.background),
      target("later:0", 0),
      target("last:0", 0),
    ],
  });
}

test("starts the foreground plus one background while measuring capacity", () => {
  const governor = createTorrentBandwidthGovernor();
  const result = governor.update({
    sampledAt: 1_000,
    targets: [target("foreground:0", 0), target("background:0", 0)],
  });

  assert.equal(result.mode, "warming");
  assert.equal(result.foregroundKey, "foreground:0");
  assert.deepEqual(result.backgroundKeys, ["background:0"]);
});

test("duty cycles rather than permanently stopping background work under contention", () => {
  const governor = createTorrentBandwidthGovernor({
    evaluationWindowMs: 2_000,
    contentionHoldMs: 8_000,
    backgroundCycleMs: 4_000,
    backgroundDuty: 0.25,
  });
  const state = { now: 0, foreground: 0, background: 0 };
  governor.update({
    sampledAt: state.now,
    targets: [target("foreground:0", 0), target("background:0", 0)],
  });

  sample(governor, state, {
    foregroundBytes: 200_000,
    backgroundBytes: 800_000,
    totalDownloadSpeed: 1_000_000,
  });
  const contended = sample(governor, state, {
    foregroundBytes: 200_000,
    backgroundBytes: 800_000,
    totalDownloadSpeed: 1_000_000,
  });
  assert.equal(contended.mode, "contended");
  assert.deepEqual(contended.backgroundKeys, ["background:0"]);

  const quiet = sample(governor, state, {
    foregroundBytes: 900_000,
    backgroundBytes: 0,
    totalDownloadSpeed: 900_000,
  });
  assert.equal(quiet.mode, "contended");
  assert.deepEqual(quiet.backgroundKeys, []);

  state.now += 3_000;
  const pulse = governor.update({
    sampledAt: state.now,
    totalDownloadSpeed: 900_000,
    targets: [
      target("foreground:0", state.foreground + 2_700_000),
      target("background:0", state.background),
    ],
  });
  assert.equal(pulse.mode, "contended");
  assert.deepEqual(pulse.backgroundKeys, ["background:0"]);
  assert.equal(pulse.backgroundDuty, 0.25);
});

test("protects a one-peer foreground until an isolated probe proves it is peer limited", () => {
  const governor = createTorrentBandwidthGovernor({
    evaluationWindowMs: 2_000,
    contentionHoldMs: 4_000,
    backgroundCycleMs: 4_000,
  });
  const state = { now: 0, foreground: 0, background: 0 };
  governor.update({
    sampledAt: 0,
    targets: [target("foreground:0", 0), target("background:0", 0), target("later:0", 0)],
  });

  sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 1,
  });
  const protectedForeground = sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 1,
  });
  assert.equal(protectedForeground.mode, "contended");

  for (let index = 0; index < 4; index += 1) {
    sample(governor, state, {
      foregroundBytes: 20_000,
      backgroundBytes: 0,
      totalDownloadSpeed: 20_000,
      productivePeers: 1,
    });
  }
  assert.equal(governor.snapshot().mode, "probing");

  sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 1,
  });
  const peerLimited = sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 1,
  });
  assert.equal(peerLimited.mode, "peer-limited");
  assert.deepEqual(peerLimited.backgroundKeys, ["background:0", "later:0"]);
});

test("expands background lanes when foreground share remains healthy", () => {
  const governor = createTorrentBandwidthGovernor({ evaluationWindowMs: 2_000 });
  const state = { now: 0, foreground: 0, background: 0 };
  governor.update({
    sampledAt: 0,
    targets: [
      target("foreground:0", 0),
      target("background:0", 0),
      target("later:0", 0),
    ],
  });

  sample(governor, state, {
    foregroundBytes: 800_000,
    backgroundBytes: 200_000,
    totalDownloadSpeed: 1_000_000,
  });
  const result = sample(governor, state, {
    foregroundBytes: 800_000,
    backgroundBytes: 200_000,
    totalDownloadSpeed: 1_000_000,
  });

  assert.equal(result.mode, "headroom");
  assert.deepEqual(result.backgroundKeys, ["background:0", "later:0"]);
});

test("uses spare capacity when the foreground is peer limited", () => {
  const governor = createTorrentBandwidthGovernor({ evaluationWindowMs: 2_000 });
  const state = { now: 0, foreground: 0, background: 0 };
  governor.update({
    sampledAt: 0,
    targets: [
      target("foreground:0", 0, { productivePeers: 0 }),
      target("background:0", 0),
      target("later:0", 0),
    ],
  });

  sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 0,
  });
  const result = sample(governor, state, {
    foregroundBytes: 20_000,
    backgroundBytes: 980_000,
    totalDownloadSpeed: 1_000_000,
    productivePeers: 0,
  });

  assert.equal(result.mode, "peer-limited");
  assert.deepEqual(result.backgroundKeys, ["background:0", "later:0"]);
});

test("resets measurement when a different episode becomes foreground", () => {
  const governor = createTorrentBandwidthGovernor({ evaluationWindowMs: 2_000 });
  governor.update({
    sampledAt: 0,
    targets: [target("one:0", 0), target("two:0", 0)],
  });
  governor.update({
    sampledAt: 1_000,
    totalDownloadSpeed: 500_000,
    targets: [target("one:0", 500_000), target("two:0", 0)],
  });

  const result = governor.update({
    sampledAt: 2_000,
    targets: [target("two:0", 0), target("one:0", 500_000)],
  });

  assert.equal(result.mode, "warming");
  assert.equal(result.foregroundKey, "two:0");
  assert.equal(result.sampleCount, 0);
  assert.deepEqual(result.backgroundKeys, ["one:0"]);
});

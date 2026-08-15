import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceAutoJoinState,
  reconcileVoiceAutoJoin,
  suppressVoiceAutoJoin,
  voiceAutoJoinFailureMessage,
} from "../lib/voice-auto-join.mjs";
import {
  createPendingVoiceCaptureRegistry,
  createVoiceCaptureGenerationGuard,
  updateVoicePeersUntilQuiescent,
} from "../lib/voice-capture-generation.mjs";

const reconcile = (state, values = {}) =>
  reconcileVoiceAutoJoin(state, {
    remoteCount: 1,
    localEnabled: false,
    localStarting: false,
    ...values,
  });

test("starts once when the first remote participant joins voice", () => {
  const first = reconcile(createVoiceAutoJoinState());
  assert.equal(first.shouldStart, true);

  const repeatedSnapshot = reconcile(first.state);
  assert.equal(repeatedSnapshot.shouldStart, false);
  assert.deepEqual(repeatedSnapshot.state, {
    remoteActive: true,
    suppressed: true,
  });
});

test("does not auto-start over a simultaneous local join", () => {
  const update = reconcile(createVoiceAutoJoinState(), { localStarting: true });
  assert.equal(update.shouldStart, false);

  const afterLocalStart = reconcile(update.state, {
    localEnabled: true,
    localStarting: false,
  });
  assert.equal(afterLocalStart.shouldStart, false);
});

test("permission failure or explicit leave suppresses repeated auto-join", () => {
  const attempted = reconcile(createVoiceAutoJoinState());
  assert.equal(attempted.shouldStart, true);
  assert.equal(reconcile(attempted.state).shouldStart, false);

  const alreadyJoined = reconcile(createVoiceAutoJoinState(), { localEnabled: true });
  assert.equal(alreadyJoined.state.suppressed, false);
  const left = suppressVoiceAutoJoin(1);
  assert.equal(reconcile(left, { remoteCount: 2 }).shouldStart, false);
});

test("a fresh remote call can auto-start after everyone leaves voice", () => {
  const attempted = reconcile(createVoiceAutoJoinState());
  const noRemoteVoice = reconcile(attempted.state, { remoteCount: 0 });
  assert.deepEqual(noRemoteVoice.state, createVoiceAutoJoinState());
  assert.equal(noRemoteVoice.shouldStart, false);

  const nextCall = reconcile(noRemoteVoice.state);
  assert.equal(nextCall.shouldStart, true);
});

test("permission denial gives an actionable auto-join fallback", () => {
  assert.equal(
    voiceAutoJoinFailureMessage("Alice", { name: "NotAllowedError" }),
    "Alice joined voice, but microphone permission was not granted. Select Join voice to try again."
  );
});

test("voice capture leases are invalidated by stop and newer capture attempts", () => {
  const guard = createVoiceCaptureGenerationGuard();
  const first = guard.begin("room-a");
  assert.equal(guard.isCurrent(first, "room-a"), true);

  guard.cancel();
  assert.equal(guard.isCurrent(first, "room-a"), false);

  const second = guard.begin("room-a");
  const third = guard.begin("room-a");
  assert.equal(guard.isCurrent(second, "room-a"), false);
  assert.equal(guard.isCurrent(third, "room-a"), true);
});

test("voice capture leases cannot cross rooms or survive unmount", () => {
  const guard = createVoiceCaptureGenerationGuard();
  const oldRoom = guard.begin("room-a");
  assert.equal(guard.isCurrent(oldRoom, "room-b"), false);

  guard.unmount();
  assert.equal(guard.owns(oldRoom), false);
  assert.equal(guard.isCurrent(oldRoom, "room-a"), false);

  guard.mount();
  assert.equal(guard.isCurrent(oldRoom, "room-a"), false);
  const remounted = guard.begin("room-a");
  assert.equal(guard.isCurrent(remounted, "room-a"), true);
});

test("pending capture controls stay current and ownership clears safely", () => {
  const registry = createPendingVoiceCaptureRegistry();
  const rawTrack = { stops: 0, stop() { this.stops += 1; } };
  const rawStream = { getTracks: () => [rawTrack] };
  const outboundTrack = { enabled: true, stops: 0, stop() { this.stops += 1; } };
  const context = { closes: 0, close() { this.closes += 1; return Promise.resolve(); } };
  const gainNode = { gain: { value: 1 } };
  const first = registry.begin();

  assert.equal(registry.attachRawStream(first, rawStream), true);
  assert.equal(registry.attachContext(first, context), true);
  assert.equal(registry.attachGainNode(first, gainNode, 0.8), true);
  assert.equal(registry.attachOutboundTrack(first, outboundTrack, false), true);
  registry.setMuted(true);
  registry.setGain(1.6);
  assert.equal(outboundTrack.enabled, false);
  assert.equal(gainNode.gain.value, 1.6);

  const second = registry.begin();
  assert.equal(rawTrack.stops, 1);
  assert.equal(outboundTrack.stops, 1);
  assert.equal(context.closes, 1);
  const secondTrack = { enabled: false, stops: 0, stop() { this.stops += 1; } };
  assert.equal(registry.attachOutboundTrack(second, secondTrack, true), true);
  assert.equal(registry.dispose(first), false);
  assert.equal(registry.commit(first), false);
  registry.setMuted(false);
  assert.equal(secondTrack.enabled, true);
  assert.equal(registry.commit(second), true);
  assert.equal(registry.disposeCurrent(), false);
  assert.equal(secondTrack.stops, 0);
});

test("late capture resources are stopped after synchronous cancellation", () => {
  const registry = createPendingVoiceCaptureRegistry();
  const pending = registry.begin();
  assert.equal(registry.disposeCurrent(), true);

  const lateTrack = { stops: 0, stop() { this.stops += 1; } };
  const lateStream = { getTracks: () => [lateTrack] };
  const lateContext = { closes: 0, close() { this.closes += 1; return Promise.resolve(); } };
  const lateOutbound = { enabled: true, stops: 0, stop() { this.stops += 1; } };
  assert.equal(registry.attachRawStream(pending, lateStream), false);
  assert.equal(registry.attachContext(pending, lateContext), false);
  assert.equal(registry.attachOutboundTrack(pending, lateOutbound, false), false);
  assert.equal(lateTrack.stops, 1);
  assert.equal(lateContext.closes, 1);
  assert.equal(lateOutbound.stops, 1);
});

test("voice capture replacement reaches joining peers and ignores departed snapshots", async () => {
  const original = { label: "original" };
  const replacement = { label: "replacement" };
  const departed = { label: "departed" };
  const joined = { label: "joined" };
  const peers = new Map([
    ["same-id", original],
    ["departed", departed],
  ]);
  const updated = [];
  let committedPeers = [];

  await updateVoicePeersUntilQuiescent({
    snapshotPeers: () => Array.from(peers.entries()),
    isPeerCurrent: (remoteId, peer) => peers.get(remoteId) === peer,
    requireCurrent: () => {},
    updatePeer: async (remoteId, peer) => {
      updated.push(peer.label);
      if (remoteId === "same-id" && peer === original) {
        peers.set("same-id", replacement);
        peers.set("joined", joined);
      }
      if (remoteId === "departed") {
        peers.delete("departed");
        throw new Error("closed during replacement");
      }
    },
    commit: () => {
      committedPeers = Array.from(peers.values(), (peer) => peer.label);
    },
  });

  assert.deepEqual(updated, ["original", "departed", "replacement", "joined"]);
  assert.deepEqual(committedPeers, ["replacement", "joined"]);
});

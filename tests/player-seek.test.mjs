import assert from "node:assert/strict";
import test from "node:test";

import {
  clampSeekTarget,
  isPlaybackAcknowledgement,
  isSeekAcknowledgement,
  PLAYBACK_TRANSACTION_TIMEOUT_MS,
  SEEK_TRANSACTION_TIMEOUT_MS,
  shouldHoldLocalPlayback,
  shouldHoldLocalSeek,
} from "../lib/player-seek.mjs";

const transaction = (values = {}) => ({
  target: 300,
  startedAt: 1_000,
  committed: true,
  source: "timeline",
  suppressionReported: false,
  ...values,
});

const playbackTransaction = (values = {}) => ({
  paused: false,
  startedAt: 1_000,
  suppressionReported: false,
  ...values,
});

const player = (values = {}) => ({
  paused: false,
  position: 120,
  playbackRate: 1,
  audioLanguage: "original",
  subtitleLanguage: "off",
  subtitleOffset: 0,
  changedAt: 1_000,
  actorId: "remote-device",
  ...values,
});

test("clamps seek targets to finite media bounds", () => {
  assert.equal(clampSeekTarget(42, 100), 42);
  assert.equal(clampSeekTarget(142, 100), 100);
  assert.equal(clampSeekTarget(-5, 100), 0);
  assert.equal(clampSeekTarget(Number.NaN, 100), 0);
});

test("holds a local seek while scrubbing and while its acknowledgement is pending", () => {
  assert.equal(
    shouldHoldLocalSeek(transaction({ committed: false }), player(), "local-device", 50_000),
    true
  );
  assert.equal(
    shouldHoldLocalSeek(transaction(), player(), "local-device", 1_500),
    true
  );
});

test("recognizes only the local matching player update as a seek acknowledgement", () => {
  const pending = transaction();
  assert.equal(
    isSeekAcknowledgement(
      pending,
      player({ actorId: "local-device", position: 300.2 }),
      "local-device"
    ),
    true
  );
  assert.equal(
    isSeekAcknowledgement(
      pending,
      player({ actorId: "remote-device", position: 300 }),
      "local-device"
    ),
    false
  );
});

test("releases a seek after acknowledgement or timeout", () => {
  const pending = transaction();
  assert.equal(
    shouldHoldLocalSeek(
      pending,
      player({ actorId: "local-device", position: 300 }),
      "local-device",
      1_500
    ),
    false
  );
  assert.equal(
    shouldHoldLocalSeek(
      pending,
      player(),
      "local-device",
      pending.startedAt + SEEK_TRANSACTION_TIMEOUT_MS
    ),
    false
  );
});

test("holds local playback intent until the room acknowledges the same state", () => {
  const pending = playbackTransaction();
  assert.equal(
    shouldHoldLocalPlayback(pending, player({ paused: true }), "local-device", 1_500),
    true
  );
  assert.equal(
    isPlaybackAcknowledgement(
      pending,
      player({ actorId: "local-device", paused: false }),
      "local-device"
    ),
    true
  );
  assert.equal(
    shouldHoldLocalPlayback(
      pending,
      player({ actorId: "local-device", paused: false }),
      "local-device",
      1_500
    ),
    false
  );
});

test("releases unacknowledged playback intent after its timeout", () => {
  const pending = playbackTransaction({ paused: true });
  assert.equal(
    shouldHoldLocalPlayback(
      pending,
      player({ paused: false }),
      "local-device",
      pending.startedAt + PLAYBACK_TRANSACTION_TIMEOUT_MS
    ),
    false
  );
});

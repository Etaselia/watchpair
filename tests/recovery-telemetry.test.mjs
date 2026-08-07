import assert from "node:assert/strict";
import test from "node:test";
import { createTorrentRecoveryTelemetry } from "../agent/recovery-telemetry.mjs";

test("torrent recovery telemetry emits one bounded summary per interval", () => {
  const summaries = [];
  let scheduled = null;
  const telemetry = createTorrentRecoveryTelemetry({
    onFlush: (summary) => summaries.push(summary),
    setTimer: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  telemetry.record("job-a", {
    index: 12,
    reason: "disk-verification",
    disconnected: 0,
  });
  telemetry.record("job-a", {
    index: 15,
    reason: "disk-verification",
    disconnected: 0,
  });
  telemetry.record("job-a", {
    index: 18,
    reason: "peer-verification",
    disconnected: 2,
  });

  assert.equal(summaries.length, 0);
  scheduled();
  assert.deepEqual(summaries, [{
    jobId: "job-a",
    events: 3,
    diskInvalidations: 2,
    peerFailures: 1,
    peersRejected: 2,
    firstPiece: 12,
    lastPiece: 18,
  }]);
});

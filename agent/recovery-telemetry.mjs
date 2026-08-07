export function createTorrentRecoveryTelemetry({
  onFlush,
  intervalMs = 2_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const buckets = new Map();
  let timer = null;

  function flush() {
    if (timer) clearTimer(timer);
    timer = null;
    for (const [jobId, summary] of buckets) {
      onFlush?.({ jobId, ...summary });
    }
    buckets.clear();
  }

  function record(jobId, event) {
    const summary = buckets.get(jobId) || {
      events: 0,
      diskInvalidations: 0,
      peerFailures: 0,
      peersRejected: 0,
      firstPiece: event.index,
      lastPiece: event.index,
    };
    summary.events += 1;
    summary.lastPiece = event.index;
    if (event.reason === "disk-verification") summary.diskInvalidations += 1;
    if (event.reason === "peer-verification") summary.peerFailures += 1;
    summary.peersRejected += Number(event.disconnected) || 0;
    buckets.set(jobId, summary);

    if (!timer) {
      timer = setTimer(flush, intervalMs);
      timer.unref?.();
    }
  }

  return {
    record,
    flush,
    close: flush,
  };
}

const KIBIBYTE = 1024;

const DEFAULT_BACKGROUND_LIMITS = Object.freeze({
  eco: 1,
  balanced: 2,
  fast: 3,
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothed(previous, sample, alpha) {
  return previous === null ? sample : previous + alpha * (sample - previous);
}

function normalizedMode(value) {
  return value in DEFAULT_BACKGROUND_LIMITS ? value : "balanced";
}

function normalizedTarget(target) {
  return {
    ...target,
    key: String(target?.key || ""),
    downloaded: Math.max(0, finiteNumber(target?.downloaded)),
    done: Boolean(target?.done),
    peers: Math.max(0, Math.floor(finiteNumber(target?.peers))),
    productivePeers: Math.max(0, Math.floor(finiteNumber(target?.productivePeers))),
  };
}

function publicRate(value) {
  return Math.max(0, Math.round(finiteNumber(value)));
}

export function createTorrentBandwidthGovernor({
  targetShare = 0.78,
  evaluationWindowMs = 8_000,
  contentionHoldMs = 30_000,
  backgroundCycleMs = 12_000,
  backgroundDuty = 0.25,
  backgroundLimits = DEFAULT_BACKGROUND_LIMITS,
} = {}) {
  const foregroundTargetShare = bounded(finiteNumber(targetShare, 0.78), 0.55, 0.95);
  const evaluateEveryMs = bounded(finiteNumber(evaluationWindowMs, 8_000), 2_000, 60_000);
  const holdContentionMs = bounded(finiteNumber(contentionHoldMs, 30_000), evaluateEveryMs, 120_000);
  const cycleMs = bounded(finiteNumber(backgroundCycleMs, 12_000), 4_000, 60_000);
  const duty = bounded(finiteNumber(backgroundDuty, 0.25), 0.1, 0.5);

  let foregroundKey = null;
  let mode = "idle";
  let reason = "No pending torrent media.";
  let modeChangedAt = 0;
  let nextEvaluationAt = 0;
  let contentionHoldUntil = 0;
  let previousSampleAt = null;
  let previousDownloaded = new Map();
  let foregroundRate = null;
  let totalRate = null;
  let foregroundPeak = 0;
  let capacityEstimate = 0;
  let backgroundSlots = 0;
  let sampleCount = 0;
  let latest = null;

  function changeMode(nextMode, nextReason, sampledAt, slots, evaluateAt) {
    if (mode !== nextMode) modeChangedAt = sampledAt;
    mode = nextMode;
    reason = nextReason;
    backgroundSlots = Math.max(0, Math.floor(slots));
    nextEvaluationAt = evaluateAt;
  }

  function resetForForeground(targets, sampledAt) {
    foregroundKey = targets[0]?.key || null;
    previousSampleAt = sampledAt;
    previousDownloaded = new Map(targets.map((target) => [target.key, target.downloaded]));
    foregroundRate = null;
    totalRate = null;
    foregroundPeak = 0;
    capacityEstimate = 0;
    sampleCount = 0;
    contentionHoldUntil = 0;
    modeChangedAt = sampledAt;
    if (foregroundKey) {
      mode = targets.length > 1 ? "warming" : "foreground-only";
      reason = targets.length > 1
        ? "Measuring foreground and aggregate download throughput."
        : "Only the foreground episode is pending.";
      backgroundSlots = targets.length > 1 ? 1 : 0;
      nextEvaluationAt = sampledAt + evaluateEveryMs;
    } else {
      mode = "idle";
      reason = "No pending torrent media.";
      backgroundSlots = 0;
      nextEvaluationAt = sampledAt + evaluateEveryMs;
    }
  }

  function maxBackgrounds(resourceMode, candidates) {
    const configured = finiteNumber(
      backgroundLimits[normalizedMode(resourceMode)],
      DEFAULT_BACKGROUND_LIMITS.balanced
    );
    return Math.min(candidates, Math.max(1, Math.floor(configured)));
  }

  function evaluate(targets, resourceMode, sampledAt) {
    const foreground = targets[0];
    const candidates = Math.max(0, targets.length - 1);
    if (!candidates) {
      changeMode(
        "foreground-only",
        "Only the foreground episode is pending.",
        sampledAt,
        0,
        sampledAt + evaluateEveryMs
      );
      return;
    }

    if (mode === "contended" && sampledAt < contentionHoldUntil) {
      nextEvaluationAt = contentionHoldUntil;
      return;
    }
    if (mode === "contended") {
      changeMode(
        "probing",
        "Rechecking whether background downloads can use spare capacity.",
        sampledAt,
        1,
        sampledAt + evaluateEveryMs
      );
      return;
    }

    const aggregate = Math.max(0, totalRate || 0);
    const foregroundDownload = Math.max(0, foregroundRate || 0);
    const share = aggregate > 0 ? foregroundDownload / aggregate : 1;
    const productivePeers = Math.max(foreground.productivePeers, 0);
    const measuredCapacity = Math.max(aggregate, capacityEstimate);
    const isolatedCapacityShare = measuredCapacity > 0
      ? foregroundPeak / measuredCapacity
      : 1;
    const peerLimited = productivePeers === 0 || (
      mode === "probing" &&
      aggregate >= 128 * KIBIBYTE &&
      foregroundDownload < aggregate * 0.45 &&
      isolatedCapacityShare < 0.55
    );
    const contended = !peerLimited &&
      aggregate >= 128 * KIBIBYTE &&
      productivePeers > 0 &&
      share < foregroundTargetShare - 0.08;
    const limit = maxBackgrounds(resourceMode, candidates);

    if (peerLimited) {
      changeMode(
        "peer-limited",
        "The foreground torrent cannot currently use the available bandwidth; expanding background work.",
        sampledAt,
        limit,
        sampledAt + evaluateEveryMs
      );
      return;
    }
    if (contended) {
      contentionHoldUntil = sampledAt + holdContentionMs;
      changeMode(
        "contended",
        "Background traffic reduced because it lowered the foreground share.",
        sampledAt,
        1,
        contentionHoldUntil
      );
      return;
    }
    if (aggregate >= 128 * KIBIBYTE && share >= foregroundTargetShare - 0.04) {
      changeMode(
        "headroom",
        "Foreground throughput is healthy; using more spare bandwidth in watch order.",
        sampledAt,
        Math.min(limit, Math.max(1, backgroundSlots + 1)),
        sampledAt + evaluateEveryMs
      );
      return;
    }
    changeMode(
      "balanced",
      "Keeping one background episode active while foreground capacity stabilizes.",
      sampledAt,
      1,
      sampledAt + evaluateEveryMs
    );
  }

  function update({ targets = [], totalDownloadSpeed = 0, resourceMode = "balanced", sampledAt = Date.now() } = {}) {
    const now = finiteNumber(sampledAt, Date.now());
    const pending = targets
      .map(normalizedTarget)
      .filter((target) => target.key && !target.done);

    if (pending[0]?.key !== foregroundKey) resetForForeground(pending, now);
    if (!pending.length) {
      if (foregroundKey !== null) resetForForeground([], now);
      latest = {
        mode,
        reason,
        foregroundKey: null,
        backgroundKeys: [],
        backgroundSlots: 0,
        backgroundDuty: 0,
        targetShare: foregroundTargetShare,
        foregroundShare: 1,
        foregroundSpeed: 0,
        foregroundPeak: 0,
        sampleCount: 0,
        totalSpeed: publicRate(totalDownloadSpeed),
        capacityEstimate: publicRate(capacityEstimate),
        nextEvaluationAt,
      };
      return latest;
    }

    const elapsedMs = previousSampleAt === null ? 0 : now - previousSampleAt;
    if (elapsedMs >= 250) {
      const elapsedSeconds = elapsedMs / 1_000;
      let measuredTargetSpeed = 0;
      let foregroundSample = 0;
      const nextDownloaded = new Map();
      for (const target of pending) {
        const previous = previousDownloaded.get(target.key);
        const bytes = previous === undefined ? 0 : Math.max(0, target.downloaded - previous);
        const rate = bytes / elapsedSeconds;
        nextDownloaded.set(target.key, target.downloaded);
        measuredTargetSpeed += rate;
        if (target.key === foregroundKey) foregroundSample = rate;
      }
      previousDownloaded = nextDownloaded;
      previousSampleAt = now;
      foregroundRate = smoothed(foregroundRate, foregroundSample, 0.35);
      totalRate = smoothed(
        totalRate,
        Math.max(measuredTargetSpeed, Math.max(0, finiteNumber(totalDownloadSpeed))),
        0.3
      );
      const foregroundDecay = Math.pow(0.5, elapsedSeconds / 90);
      const capacityDecay = Math.pow(0.5, elapsedSeconds / 120);
      foregroundPeak = Math.max(foregroundRate, foregroundPeak * foregroundDecay);
      capacityEstimate = Math.max(totalRate, capacityEstimate * capacityDecay);
      sampleCount += 1;
    }

    if (now >= nextEvaluationAt && sampleCount > 0) evaluate(pending, resourceMode, now);

    const candidates = Math.max(0, pending.length - 1);
    const limit = maxBackgrounds(resourceMode, candidates);
    const slots = Math.min(limit, backgroundSlots);
    const cyclePhase = mode === "contended"
      ? ((now - modeChangedAt) % cycleMs + cycleMs) % cycleMs
      : 0;
    const backgroundEnabled = mode !== "contended" || cyclePhase < cycleMs * duty;
    const backgroundKeys = backgroundEnabled
      ? pending.slice(1, 1 + slots).map((target) => target.key)
      : [];
    const aggregate = Math.max(0, totalRate || finiteNumber(totalDownloadSpeed));
    const foregroundDownload = Math.max(0, foregroundRate || 0);

    latest = {
      mode,
      reason,
      foregroundKey,
      backgroundKeys,
      backgroundSlots: slots,
      backgroundDuty: mode === "contended" ? duty : candidates ? 1 : 0,
      targetShare: foregroundTargetShare,
      foregroundShare: aggregate > 0 ? bounded(foregroundDownload / aggregate, 0, 1) : 1,
      foregroundSpeed: publicRate(foregroundDownload),
      foregroundPeak: publicRate(foregroundPeak),
      totalSpeed: publicRate(aggregate),
      capacityEstimate: publicRate(capacityEstimate),
      sampleCount,
      nextEvaluationAt,
    };
    return latest;
  }

  function snapshot() {
    return latest || {
      mode: "idle",
      reason: "No pending torrent media.",
      foregroundKey: null,
      backgroundKeys: [],
      backgroundSlots: 0,
      backgroundDuty: 0,
      targetShare: foregroundTargetShare,
      foregroundShare: 1,
      foregroundSpeed: 0,
      foregroundPeak: 0,
      totalSpeed: 0,
      capacityEstimate: 0,
      sampleCount: 0,
      nextEvaluationAt: 0,
    };
  }

  return { update, snapshot };
}

import { URL } from "node:url";

export const DEFAULT_TRACKER_STALE_MS = 30 * 60 * 1_000;

const TRACKER_PROTOCOLS = new Set(["http:", "https:", "udp:", "ws:", "wss:"]);
const TRACKER_URL_PATTERN = /(?:https?|udp|wss?):\/\/[^\s<>"'`]+/giu;

function removeListener(emitter, event, listener) {
  if (!emitter) return;
  if (typeof emitter.off === "function") emitter.off(event, listener);
  else emitter.removeListener?.(event, listener);
}

function normalizedTrackerCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/**
 * Return only the non-secret portion of a tracker address. Tracker paths commonly
 * contain private passkeys, so paths, credentials, queries, and fragments never
 * cross the agent API boundary.
 */
export function sanitizeTrackerEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!TRACKER_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null;
    const port = parsed.port ? Number(parsed.port) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) return null;
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return null;
  }
}

export function classifyTrackerError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (/timed?\s*out|timeout|etimedout/u.test(message)) return "timeout";
  if (/unsupported|not supported/u.test(message)) return "unsupported";
  if (/reject|failure reason|unauthori[sz]ed|forbidden|denied|\b40[13]\b/u.test(message)) return "rejected";
  if (/invalid|malformed|decod/u.test(message)) return "invalid-response";
  if (/unreach|enotfound|econnrefused|econnreset|network|socket|\bdns\b|offline/u.test(message)) {
    return "unreachable";
  }
  return "unavailable";
}

function endpointFromError(error) {
  const message = String(error?.message || error || "");
  for (const match of message.matchAll(TRACKER_URL_PATTERN)) {
    const endpoint = sanitizeTrackerEndpoint(match[0]);
    if (endpoint) return endpoint;
  }
  return null;
}

function peerCounts(torrent) {
  const connected = Array.isArray(torrent?.wires)
    ? torrent.wires.filter((wire) => wire && !wire.destroyed)
    : [];
  return {
    connectedPeers: connected.length,
    connectedSeeds: connected.filter((wire) => wire.isSeeder === true).length,
  };
}

function trackerReport(endpoint) {
  return {
    endpoint,
    seeders: null,
    leechers: null,
    updatedAt: null,
    errorCategory: null,
    errorAt: null,
  };
}

/**
 * Collect passive WebTorrent telemetry. This object never announces or scrapes;
 * it only observes the tracker client WebTorrent already owns.
 */
export function createTorrentTelemetry(torrent, {
  now = Date.now,
  staleAfterMs = DEFAULT_TRACKER_STALE_MS,
} = {}) {
  if (!torrent || typeof torrent.on !== "function") {
    throw new TypeError("A torrent event emitter is required.");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError("staleAfterMs must be positive.");
  }

  const reports = new Map();
  let trackerClient = null;
  let disposed = false;
  let trackerAnnounces = 0;
  let lastTrackerAnnounceAt = null;
  let lastDhtAnnounceAt = null;
  let latestTrackerError = null;

  function ensureReport(endpoint) {
    if (!endpoint) return null;
    let report = reports.get(endpoint);
    if (!report) {
      report = trackerReport(endpoint);
      reports.set(endpoint, report);
    }
    return report;
  }

  function syncConfiguredTrackers() {
    const configured = Array.isArray(torrent.announce) ? torrent.announce : [];
    for (const value of configured) ensureReport(sanitizeTrackerEndpoint(String(value)));
    const activeTrackers = Array.isArray(trackerClient?._trackers) ? trackerClient._trackers : [];
    for (const active of activeTrackers) ensureReport(sanitizeTrackerEndpoint(active?.announceUrl));
  }

  function onTrackerUpdate(data) {
    const endpoint = sanitizeTrackerEndpoint(data?.announce);
    const report = ensureReport(endpoint);
    if (!report) return;
    report.seeders = normalizedTrackerCount(data?.complete);
    report.leechers = normalizedTrackerCount(data?.incomplete);
    report.updatedAt = now();
    report.errorCategory = null;
    report.errorAt = null;
  }

  function onTrackerProblem(error) {
    const at = now();
    const category = classifyTrackerError(error);
    const endpoint = endpointFromError(error);
    latestTrackerError = { category, at, ...(endpoint ? { endpoint } : {}) };
    const report = ensureReport(endpoint);
    if (report) {
      report.errorCategory = category;
      report.errorAt = at;
    }
  }

  function unbindTrackerClient() {
    if (!trackerClient) return;
    removeListener(trackerClient, "update", onTrackerUpdate);
    removeListener(trackerClient, "warning", onTrackerProblem);
    removeListener(trackerClient, "error", onTrackerProblem);
    trackerClient = null;
  }

  function rebind() {
    if (disposed) return false;
    const nextClient = torrent.discovery?.tracker || null;
    if (nextClient === trackerClient) {
      syncConfiguredTrackers();
      return false;
    }
    unbindTrackerClient();
    trackerClient = nextClient;
    if (trackerClient) {
      trackerClient.on("update", onTrackerUpdate);
      trackerClient.on("warning", onTrackerProblem);
      trackerClient.on("error", onTrackerProblem);
    }
    syncConfiguredTrackers();
    return true;
  }

  function onTrackerAnnounce() {
    trackerAnnounces += 1;
    lastTrackerAnnounceAt = now();
    rebind();
  }

  function onDhtAnnounce() {
    lastDhtAnnounceAt = now();
    rebind();
  }

  const rebindEvents = ["metadata", "ready", "wire"];
  for (const event of rebindEvents) torrent.on(event, rebind);
  torrent.on("trackerAnnounce", onTrackerAnnounce);
  torrent.on("dhtAnnounce", onDhtAnnounce);
  rebind();
  queueMicrotask(rebind);

  function reportState(report, sampledAt) {
    const hasResponse = Number.isFinite(report.updatedAt);
    const fresh = hasResponse && sampledAt - report.updatedAt <= staleAfterMs;
    if (fresh) return "responding";
    if (report.errorCategory && (!hasResponse || report.errorAt >= report.updatedAt)) return "error";
    if (hasResponse) return "stale";
    return "unknown";
  }

  function summary(sampledAt = now()) {
    rebind();
    const freshReports = [...reports.values()].filter((report) =>
      reportState(report, sampledAt) === "responding"
    );
    const seederReports = freshReports.filter((report) => report.seeders !== null);
    const leecherReports = freshReports.filter((report) => report.leechers !== null);
    const responseTimes = [...reports.values()]
      .map((report) => report.updatedAt)
      .filter(Number.isFinite);
    const { connectedPeers, connectedSeeds } = peerCounts(torrent);
    const trackerReportedSeeders = seederReports.length
      ? Math.max(...seederReports.map((report) => report.seeders))
      : null;
    const trackerReportedLeechers = leecherReports.length
      ? Math.max(...leecherReports.map((report) => report.leechers))
      : null;

    return {
      connectedPeers,
      connectedSeeds,
      downloadSpeed: Number.isFinite(torrent.downloadSpeed) ? torrent.downloadSpeed : 0,
      uploadSpeed: Number.isFinite(torrent.uploadSpeed) ? torrent.uploadSpeed : 0,
      downloaded: Number.isFinite(torrent.downloaded) ? torrent.downloaded : 0,
      uploaded: Number.isFinite(torrent.uploaded) ? torrent.uploaded : 0,
      trackerReportedSeeders,
      trackerReportedLeechers,
      trackerAvailability: trackerReportedSeeders === null ? "unknown" : "known",
      configuredTrackers: reports.size,
      respondingTrackers: freshReports.length,
      lastTrackerResponseAt: responseTimes.length ? Math.max(...responseTimes) : null,
      trackerAnnounces,
      lastTrackerAnnounceAt,
      discovery: {
        trackerEnabled: Boolean(torrent.discovery?.tracker),
        dhtEnabled: Boolean(torrent.discovery?.dht),
        lsdEnabled: Boolean(torrent.discovery?.lsd),
        peerExchangeEnabled: Boolean(torrent.client?.utPex),
        lastDhtAnnounceAt,
      },
    };
  }

  function snapshot(sampledAt = now()) {
    const value = summary(sampledAt);
    return {
      ...value,
      sampledAt,
      staleAfterMs,
      latestTrackerError: latestTrackerError ? { ...latestTrackerError } : null,
      trackers: [...reports.values()]
        .map((report) => ({
          endpoint: report.endpoint,
          state: reportState(report, sampledAt),
          fresh: reportState(report, sampledAt) === "responding",
          seeders: report.seeders,
          leechers: report.leechers,
          updatedAt: report.updatedAt,
          errorCategory: report.errorCategory,
          errorAt: report.errorAt,
        }))
        .sort((left, right) => left.endpoint.localeCompare(right.endpoint)),
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unbindTrackerClient();
    for (const event of rebindEvents) removeListener(torrent, event, rebind);
    removeListener(torrent, "trackerAnnounce", onTrackerAnnounce);
    removeListener(torrent, "dhtAnnounce", onDhtAnnounce);
  }

  return {
    summary,
    snapshot,
    rebind,
    dispose,
  };
}

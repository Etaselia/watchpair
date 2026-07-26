import path from "node:path";

const TRANSCODERS = new Set(["auto", "nvenc", "qsv", "vaapi", "amf", "videotoolbox", "cpu"]);
const RESOURCE_MODES = new Set(["eco", "balanced", "fast"]);

export const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  downloadDirectory: "",
  startAtLogin: true,
  transcoder: "auto",
  resourceMode: "balanced",
  cleanup: Object.freeze({
    enabled: true,
    downloadRetentionDays: 30,
    cacheRetentionDays: 7,
    partialRetentionHours: 24,
    maxStorageGb: 0,
    minFreeSpaceGb: 5,
  }),
  updates: Object.freeze({
    automaticChecks: true,
    automaticDownloads: true,
  }),
});

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function normalizeDesktopSettings(value = {}, { defaultDownloadDirectory = "" } = {}) {
  const cleanup = value.cleanup || {};
  const updates = value.updates || {};
  const requestedDirectory = String(value.downloadDirectory || defaultDownloadDirectory).trim();
  const requestedResourceMode = String(value.resourceMode ?? "").trim().toLowerCase();
  return {
    downloadDirectory: requestedDirectory ? path.resolve(requestedDirectory) : "",
    startAtLogin: value.startAtLogin !== false,
    transcoder: TRANSCODERS.has(value.transcoder) ? value.transcoder : "auto",
    resourceMode: RESOURCE_MODES.has(requestedResourceMode) ? requestedResourceMode : "balanced",
    cleanup: {
      enabled: cleanup.enabled !== false,
      downloadRetentionDays: boundedNumber(cleanup.downloadRetentionDays, 30, 1, 3650),
      cacheRetentionDays: boundedNumber(cleanup.cacheRetentionDays, 7, 1, 365),
      partialRetentionHours: boundedNumber(cleanup.partialRetentionHours, 24, 1, 720),
      maxStorageGb: boundedNumber(cleanup.maxStorageGb, 0, 0, 100000),
      minFreeSpaceGb: boundedNumber(cleanup.minFreeSpaceGb, 5, 0, 100000),
    },
    updates: {
      automaticChecks: updates.automaticChecks !== false,
      automaticDownloads: updates.automaticDownloads !== false,
    },
  };
}

export function settingsEnvironment(settings) {
  return {
    WATCHPAIR_DOWNLOAD_DIR: settings.downloadDirectory,
    WATCHPAIR_TRANSCODER: settings.transcoder,
    WATCHPAIR_RESOURCE_MODE: settings.resourceMode,
    WATCHPAIR_CLEANUP_ENABLED: settings.cleanup.enabled ? "1" : "0",
    WATCHPAIR_DOWNLOAD_RETENTION_DAYS: String(settings.cleanup.downloadRetentionDays),
    WATCHPAIR_CACHE_RETENTION_DAYS: String(settings.cleanup.cacheRetentionDays),
    WATCHPAIR_PARTIAL_RETENTION_HOURS: String(settings.cleanup.partialRetentionHours),
    WATCHPAIR_MAX_STORAGE_GB: String(settings.cleanup.maxStorageGb),
    WATCHPAIR_MIN_FREE_GB: String(settings.cleanup.minFreeSpaceGb),
  };
}

export function deepLinkOrigin(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "watchpair:" || url.hostname !== "connect") {
    throw new Error("Unsupported WatchPair link.");
  }
  const origin = new URL(url.searchParams.get("origin") || "");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) {
    throw new Error("WatchPair only connects HTTPS websites and local development sites.");
  }
  return origin.origin;
}

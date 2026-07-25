const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_CLEANUP_SETTINGS = Object.freeze({
  enabled: true,
  downloadRetentionDays: 30,
  cacheRetentionDays: 7,
  partialRetentionHours: 24,
  maxStorageGb: 0,
  minFreeSpaceGb: 5,
});

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function normalizeCleanupSettings(value = {}) {
  return {
    enabled: value.enabled !== false && value.enabled !== "0",
    downloadRetentionDays: boundedNumber(
      value.downloadRetentionDays,
      DEFAULT_CLEANUP_SETTINGS.downloadRetentionDays,
      1,
      3650
    ),
    cacheRetentionDays: boundedNumber(
      value.cacheRetentionDays,
      DEFAULT_CLEANUP_SETTINGS.cacheRetentionDays,
      1,
      365
    ),
    partialRetentionHours: boundedNumber(
      value.partialRetentionHours,
      DEFAULT_CLEANUP_SETTINGS.partialRetentionHours,
      1,
      720
    ),
    maxStorageGb: boundedNumber(
      value.maxStorageGb,
      DEFAULT_CLEANUP_SETTINGS.maxStorageGb,
      0,
      100000
    ),
    minFreeSpaceGb: boundedNumber(
      value.minFreeSpaceGb,
      DEFAULT_CLEANUP_SETTINGS.minFreeSpaceGb,
      0,
      100000
    ),
  };
}

export function cleanupSettingsFromEnvironment(environment = process.env) {
  return normalizeCleanupSettings({
    enabled: environment.WATCHPAIR_CLEANUP_ENABLED,
    downloadRetentionDays: environment.WATCHPAIR_DOWNLOAD_RETENTION_DAYS,
    cacheRetentionDays: environment.WATCHPAIR_CACHE_RETENTION_DAYS,
    partialRetentionHours: environment.WATCHPAIR_PARTIAL_RETENTION_HOURS,
    maxStorageGb: environment.WATCHPAIR_MAX_STORAGE_GB,
    minFreeSpaceGb: environment.WATCHPAIR_MIN_FREE_GB,
  });
}

export function jobCanBeCleaned(job, settings) {
  if (!settings.enabled || !job?.managed || job.pinned) return false;
  if (!["ready", "error"].includes(job.status)) return false;
  if (job.preparation?.status === "preparing") return false;
  if (job.torrent && !job.torrent.destroyed && job.torrent.numPeers > 0) return false;
  return true;
}

export function jobCleanupReason(job, settings, now = Date.now()) {
  if (!jobCanBeCleaned(job, settings)) return null;

  const lastUsed = Number(job.lastAccessedAt || job.completedAt || job.updatedAt || job.createdAt || now);
  const retentionMs = settings.downloadRetentionDays * DAY_MS;
  return now - lastUsed >= retentionMs ? "retention" : null;
}

export function cacheExpired(lastUsed, settings, now = Date.now()) {
  const timestamp = Number(lastUsed);
  return settings.enabled && Number.isFinite(timestamp) &&
    now - timestamp >= settings.cacheRetentionDays * DAY_MS;
}

export function partialExpired(lastModified, settings, now = Date.now()) {
  const timestamp = Number(lastModified);
  return settings.enabled && Number.isFinite(timestamp) &&
    now - timestamp >= settings.partialRetentionHours * HOUR_MS;
}

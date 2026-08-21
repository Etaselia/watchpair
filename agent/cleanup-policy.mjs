const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const RECENT_PLAYBACK_PROTECTION_MS = 5 * 60 * 1000;

export const RETENTION_METADATA_VERSION = 1;

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

export function jobCanBeCleaned(job, settings, {
  active = false,
  now = Date.now(),
  recentAccessMs = RECENT_PLAYBACK_PROTECTION_MS,
} = {}) {
  if (!settings.enabled || !job?.managed || job.pinned || !retentionMetadataReliable(job)) return false;
  if (active) return false;
  const lastAccessedAt = Number(job.lastAccessedAt);
  if (recentAccessMs > 0 && Number.isFinite(lastAccessedAt) &&
    now - lastAccessedAt < recentAccessMs) return false;
  if (job.seedLeases?.size > 0) return false;
  if (!["ready", "error"].includes(job.status)) return false;
  if (job.preparation?.status === "preparing") return false;
  if (job.torrent && !job.torrent.destroyed && job.torrent.numPeers > 0) return false;
  return true;
}

export function retentionMetadataReliable(job) {
  return Number(job?.retentionMetadataVersion) === RETENTION_METADATA_VERSION;
}

export function jobRetentionTimestamp(job, now = Date.now()) {
  const lastAccessedAt = Number(job?.lastAccessedAt);
  const completedAt = Number(job?.completedAt);
  const meaningful = [lastAccessedAt, completedAt]
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  if (meaningful.length) return Math.max(...meaningful);

  const updatedAt = Number(job?.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  const createdAt = Number(job?.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now;
}

export function jobCleanupReason(job, settings, now = Date.now()) {
  if (!settings.enabled || !job?.managed || job.pinned || !retentionMetadataReliable(job)) return null;
  if (job.seedLeases?.size > 0) return null;

  // A restored torrent temporarily returns to metadata/downloading state and
  // may reconnect to passive swarm peers before its on-disk files are
  // verified. A persisted completion timestamp is the durable indication that
  // retention applies; recent playback remains protected by lastAccessedAt.
  const completedAt = Number(job.completedAt);
  const completed = Number.isFinite(completedAt) && completedAt > 0;
  if (!completed && job.status !== "error") return null;

  const lastUsed = jobRetentionTimestamp(job, now);
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

export async function prepareAutomaticJobDeletion(job, {
  isCurrent,
  destroy,
  restore,
}) {
  if (!job || typeof isCurrent !== "function" || typeof destroy !== "function" ||
    typeof restore !== "function") {
    throw new TypeError("Automatic deletion requires current, destroy, and restore callbacks.");
  }
  if (!isCurrent() || job.pinned) return false;
  await destroy();
  if (isCurrent() && !job.pinned) return true;
  await restore();
  return false;
}

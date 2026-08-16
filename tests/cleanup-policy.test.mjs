import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLEANUP_SETTINGS,
  RETENTION_METADATA_VERSION,
  cacheExpired,
  cleanupSettingsFromEnvironment,
  jobCanBeCleaned,
  jobCleanupReason,
  jobRetentionTimestamp,
  normalizeCleanupSettings,
  partialExpired,
  retentionMetadataReliable,
} from "../agent/cleanup-policy.mjs";

const DAY = 24 * 60 * 60 * 1000;

test("cleanup settings have conservative bounded defaults", () => {
  assert.deepEqual(normalizeCleanupSettings(), DEFAULT_CLEANUP_SETTINGS);
  assert.deepEqual(
    cleanupSettingsFromEnvironment({
      WATCHPAIR_CLEANUP_ENABLED: "0",
      WATCHPAIR_DOWNLOAD_RETENTION_DAYS: "99999",
      WATCHPAIR_CACHE_RETENTION_DAYS: "0",
      WATCHPAIR_PARTIAL_RETENTION_HOURS: "48",
      WATCHPAIR_MAX_STORAGE_GB: "50",
      WATCHPAIR_MIN_FREE_GB: "2",
    }),
    {
      enabled: false,
      downloadRetentionDays: 3650,
      cacheRetentionDays: 1,
      partialRetentionHours: 48,
      maxStorageGb: 50,
      minFreeSpaceGb: 2,
    }
  );
});

test("cleanup separates retention expiry from storage-pressure safety", () => {
  const now = 50 * DAY;
  const settings = normalizeCleanupSettings({ downloadRetentionDays: 30 });
  const old = {
    retentionMetadataVersion: RETENTION_METADATA_VERSION,
    managed: true,
    pinned: false,
    status: "ready",
    lastAccessedAt: 10 * DAY,
    completedAt: 12 * DAY,
    preparation: { status: "ready" },
    torrent: null,
  };

  assert.equal(jobCleanupReason(old, settings, now), "retention");
  assert.equal(jobCanBeCleaned(old, settings), true);
  assert.equal(jobCleanupReason({ ...old, managed: false }, settings, now), null);
  assert.equal(jobCleanupReason({ ...old, pinned: true }, settings, now), null);
  assert.equal(jobCanBeCleaned({ ...old, pinned: true }, settings), false);
  assert.equal(jobCanBeCleaned({ ...old, status: "downloading" }, settings), false);
  assert.equal(jobCleanupReason({ ...old, status: "downloading" }, settings, now), "retention");
  assert.equal(jobCanBeCleaned({ ...old, preparation: { status: "preparing" } }, settings), false);
  assert.equal(jobCleanupReason({ ...old, preparation: { status: "preparing" } }, settings, now), "retention");
  assert.equal(
    jobCleanupReason({ ...old, torrent: { destroyed: false, numPeers: 1 } }, settings, now),
    "retention"
  );
  assert.equal(
    jobCanBeCleaned({ ...old, torrent: { destroyed: false, numPeers: 1 } }, settings),
    false
  );
});

test("retention uses the latest completion or playback time", () => {
  const now = 50 * DAY;
  const settings = normalizeCleanupSettings({ downloadRetentionDays: 30 });
  const restored = {
    retentionMetadataVersion: RETENTION_METADATA_VERSION,
    managed: true,
    pinned: false,
    status: "downloading",
    createdAt: 1 * DAY,
    completedAt: 10 * DAY,
    lastAccessedAt: 12 * DAY,
    updatedAt: now,
    preparation: { status: "preparing" },
    torrent: { destroyed: false, numPeers: 3 },
  };

  assert.equal(jobRetentionTimestamp(restored, now), 12 * DAY);
  assert.equal(jobCleanupReason(restored, settings, now), "retention");
  assert.equal(
    jobCleanupReason({ ...restored, lastAccessedAt: 49 * DAY }, settings, now),
    null,
    "recent playback protects a completed job during transient restore work"
  );
  assert.equal(
    jobCleanupReason({ ...restored, lastAccessedAt: 10 * DAY, completedAt: 49 * DAY }, settings, now),
    null,
    "retention cannot begin before the download completed"
  );
  assert.equal(
    jobCleanupReason({ ...restored, completedAt: null }, settings, now),
    null,
    "an unfinished download is not eligible solely because it is old"
  );
});

test("pre-schema retention metadata is never trusted for automatic cleanup", () => {
  const now = 50 * DAY;
  const settings = normalizeCleanupSettings({ downloadRetentionDays: 30 });
  const legacy = {
    retentionMetadataVersion: 0,
    managed: true,
    pinned: false,
    status: "ready",
    completedAt: 10 * DAY,
    lastAccessedAt: 10 * DAY,
    preparation: { status: "ready" },
    torrent: null,
  };

  assert.equal(retentionMetadataReliable(legacy), false);
  assert.equal(retentionMetadataReliable({
    ...legacy,
    retentionMetadataVersion: RETENTION_METADATA_VERSION,
  }), true);
  assert.equal(jobCleanupReason(legacy, settings, now), null);
  assert.equal(jobCanBeCleaned(legacy, settings), false);
});

test("cache and partial retention use separate clocks", () => {
  const now = 40 * DAY;
  const settings = normalizeCleanupSettings({ cacheRetentionDays: 7, partialRetentionHours: 24 });
  assert.equal(cacheExpired(32 * DAY, settings, now), true);
  assert.equal(cacheExpired(34 * DAY, settings, now), false);
  assert.equal(partialExpired(now - 25 * 60 * 60 * 1000, settings, now), true);
  assert.equal(partialExpired(now - 23 * 60 * 60 * 1000, settings, now), false);
});

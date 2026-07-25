import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLEANUP_SETTINGS,
  cacheExpired,
  cleanupSettingsFromEnvironment,
  jobCanBeCleaned,
  jobCleanupReason,
  normalizeCleanupSettings,
  partialExpired,
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

test("cleanup selects only old, managed, idle jobs", () => {
  const now = 50 * DAY;
  const settings = normalizeCleanupSettings({ downloadRetentionDays: 30 });
  const old = {
    managed: true,
    pinned: false,
    status: "ready",
    lastAccessedAt: 10 * DAY,
    preparation: { status: "ready" },
    torrent: null,
  };

  assert.equal(jobCleanupReason(old, settings, now), "retention");
  assert.equal(jobCanBeCleaned(old, settings), true);
  assert.equal(jobCleanupReason({ ...old, managed: false }, settings, now), null);
  assert.equal(jobCleanupReason({ ...old, pinned: true }, settings, now), null);
  assert.equal(jobCanBeCleaned({ ...old, pinned: true }, settings), false);
  assert.equal(jobCleanupReason({ ...old, status: "downloading" }, settings, now), null);
  assert.equal(jobCleanupReason({ ...old, preparation: { status: "preparing" } }, settings, now), null);
  assert.equal(
    jobCleanupReason({ ...old, torrent: { destroyed: false, numPeers: 1 } }, settings, now),
    null
  );
});

test("cache and partial retention use separate clocks", () => {
  const now = 40 * DAY;
  const settings = normalizeCleanupSettings({ cacheRetentionDays: 7, partialRetentionHours: 24 });
  assert.equal(cacheExpired(32 * DAY, settings, now), true);
  assert.equal(cacheExpired(34 * DAY, settings, now), false);
  assert.equal(partialExpired(now - 25 * 60 * 60 * 1000, settings, now), true);
  assert.equal(partialExpired(now - 23 * 60 * 60 * 1000, settings, now), false);
});

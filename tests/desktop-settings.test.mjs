import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  deepLinkOrigin,
  normalizeDesktopSettings,
  settingsEnvironment,
} from "../desktop/settings.mjs";

test("desktop settings apply safe retention and update defaults", () => {
  const settings = normalizeDesktopSettings({}, { defaultDownloadDirectory: "downloads" });
  assert.equal(settings.downloadDirectory, path.resolve("downloads"));
  assert.equal(settings.startAtLogin, true);
  assert.equal(settings.transcoder, "auto");
  assert.deepEqual(settings.cleanup, {
    enabled: true,
    downloadRetentionDays: 30,
    cacheRetentionDays: 7,
    partialRetentionHours: 24,
    maxStorageGb: 0,
    minFreeSpaceGb: 5,
  });
  assert.deepEqual(settings.updates, {
    automaticChecks: true,
    automaticDownloads: true,
  });
});

test("desktop settings clamp invalid values and expose agent environment", () => {
  const settings = normalizeDesktopSettings({
    transcoder: "not-real",
    cleanup: {
      enabled: false,
      downloadRetentionDays: -2,
      cacheRetentionDays: 500,
      partialRetentionHours: "48",
      maxStorageGb: 20,
      minFreeSpaceGb: 2,
    },
  });
  assert.equal(settings.transcoder, "auto");
  assert.equal(settings.cleanup.downloadRetentionDays, 1);
  assert.equal(settings.cleanup.cacheRetentionDays, 365);
  assert.equal(settings.cleanup.partialRetentionHours, 48);
  assert.deepEqual(settingsEnvironment(settings), {
    WATCHPAIR_DOWNLOAD_DIR: "",
    WATCHPAIR_TRANSCODER: "auto",
    WATCHPAIR_CLEANUP_ENABLED: "0",
    WATCHPAIR_DOWNLOAD_RETENTION_DAYS: "1",
    WATCHPAIR_CACHE_RETENTION_DAYS: "365",
    WATCHPAIR_PARTIAL_RETENTION_HOURS: "48",
    WATCHPAIR_MAX_STORAGE_GB: "20",
    WATCHPAIR_MIN_FREE_GB: "2",
  });
});

test("deep links accept HTTPS and loopback origins only", () => {
  assert.equal(
    deepLinkOrigin("watchpair://connect?origin=https%3A%2F%2Fwatch.example"),
    "https://watch.example"
  );
  assert.equal(
    deepLinkOrigin("watchpair://connect?origin=http%3A%2F%2Flocalhost%3A3000"),
    "http://localhost:3000"
  );
  assert.throws(
    () => deepLinkOrigin("watchpair://connect?origin=http%3A%2F%2Fwatch.example"),
    /only connects HTTPS/
  );
  assert.throws(() => deepLinkOrigin("https://watch.example"), /Unsupported/);
});

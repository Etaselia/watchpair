import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  deepLinkOrigin,
  isFilesystemRoot,
  normalizeDesktopSettings,
  settingsEnvironment,
  settingsRequireAgentRestart,
} from "../desktop/settings.mjs";

test("desktop settings apply safe retention and update defaults", () => {
  const settings = normalizeDesktopSettings({}, { defaultDownloadDirectory: "downloads" });
  assert.equal(settings.downloadDirectory, path.resolve("downloads"));
  assert.deepEqual(settings.libraryDirectories, []);
  assert.equal(settings.startAtLogin, true);
  assert.equal(settings.transcoder, "auto");
  assert.equal(settings.resourceMode, "balanced");
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
    libraryDirectories: ["library", "library", "", path.parse(path.resolve("library")).root, "other-library"],
    transcoder: "not-real",
    resourceMode: "not-real",
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
  assert.deepEqual(settings.libraryDirectories, [
    path.resolve("library"),
    path.resolve("other-library"),
  ]);
  assert.deepEqual(settingsEnvironment(settings), {
    WATCHPAIR_DOWNLOAD_DIR: "",
    WATCHPAIR_LIBRARY_DIRS: [path.resolve("library"), path.resolve("other-library")].join(path.delimiter),
    WATCHPAIR_TRANSCODER: "auto",
    WATCHPAIR_RESOURCE_MODE: "balanced",
    WATCHPAIR_CLEANUP_ENABLED: "0",
    WATCHPAIR_DOWNLOAD_RETENTION_DAYS: "1",
    WATCHPAIR_CACHE_RETENTION_DAYS: "365",
    WATCHPAIR_PARTIAL_RETENTION_HOURS: "48",
    WATCHPAIR_MAX_STORAGE_GB: "20",
    WATCHPAIR_MIN_FREE_GB: "2",
  });
});

test("desktop settings preserve supported resource modes", () => {
  for (const resourceMode of ["eco", "balanced", "fast"]) {
    const settings = normalizeDesktopSettings({ resourceMode });
    assert.equal(settings.resourceMode, resourceMode);
    assert.equal(settingsEnvironment(settings).WATCHPAIR_RESOURCE_MODE, resourceMode);
  }
  assert.equal(normalizeDesktopSettings({ resourceMode: " FAST " }).resourceMode, "fast");
});

test("desktop-only settings do not restart the companion agent", () => {
  const current = normalizeDesktopSettings({ downloadDirectory: "downloads" });
  const desktopOnly = {
    ...current,
    startAtLogin: false,
    updates: { automaticChecks: false, automaticDownloads: false },
  };

  assert.equal(settingsRequireAgentRestart(current, desktopOnly), false);
  assert.equal(
    settingsRequireAgentRestart(current, { ...current, resourceMode: "eco" }),
    true
  );
  assert.equal(
    settingsRequireAgentRestart(current, {
      ...current,
      cleanup: { ...current.cleanup, cacheRetentionDays: 9 },
    }),
    true
  );
  assert.equal(
    settingsRequireAgentRestart(current, {
      ...current,
      libraryDirectories: [path.resolve("library")],
    }),
    true
  );
});

test("desktop settings reject filesystem-root library scans", () => {
  const filesystemRoot = path.parse(path.resolve("library")).root;
  assert.equal(isFilesystemRoot(filesystemRoot), true);
  assert.deepEqual(normalizeDesktopSettings({ libraryDirectories: [filesystemRoot] }).libraryDirectories, []);
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

test("desktop library gates partial previews and refreshes after settings restart", async () => {
  const [renderer, main] = await Promise.all([
    readFile(new URL("../desktop/renderer/renderer.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(renderer, /file\.usable === false/);
  assert.match(renderer, /Still downloading or verifying/);
  assert.match(renderer, /local copies/);
  assert.match(renderer, /video\.addEventListener\("error"/);
  assert.match(renderer, /queueLibraryRefresh\(\)/);
  assert.match(renderer, /requestGeneration !== libraryRequestGeneration/);
  assert.match(renderer, /requestedQuery !== elements\["library-search"\]\.value/);
  assert.match(renderer, /requestedOffset !== libraryOffset/);
  assert.match(renderer, /External source files are always left untouched/);
  assert.match(renderer, /selectedTransferId !== requestedTransferId/);
  assert.match(renderer, /selectedLibraryCollectionId !== requestedCollectionId/);
  assert.match(renderer, /setAttribute\("role", "progressbar"\)/);
  assert.match(main, /function assertMainRenderer\(event\)/);
  assert.match(main, /event\.sender !== mainWindow\.webContents/);
});

test("desktop library previews keep agent credentials private and release transient HLS jobs", async () => {
  const [main, preload, renderer, html, builder] = await Promise.all([
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/renderer/renderer.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"),
  ]);

  assert.match(main, /scheme: "watchpair-media"[\s\S]*corsEnabled: true/);
  assert.match(main, /RAW_PREVIEW_EXTENSIONS = new Set\(\["\.m4v", "\.mov", "\.mp4", "\.webm"\]\)/);
  assert.match(main, /requestedRange = range \? request\.headers\.get\("range"\) : null/);
  assert.match(main, /HLS_ASSET_PATTERN/);
  assert.match(main, /libraryPreviewsBySource\.get\(sourceId\)/);
  assert.match(main, /const record = \{ senderId, fileId, sourceId, mode: "raw" \}/);
  assert.match(main, /if \(!record\.sourceId \|\| record\.mode !== "hls"\) return/);
  assert.match(main, /if \(record\.sourceId !== sourceId\)/);
  assert.match(main, /result\.jobs\.filter\(\(job\) => !PREVIEW_JOB_ID_PATTERN\.test/);
  assert.match(main, /\/library\/\$\{encodeURIComponent\(fileId\)\}\/attach/);
  assert.match(main, /"x-watchpair-control": CONTROL_TOKEN/);
  assert.match(main, /\?deleteFiles=0/);
  assert.match(main, /releaseLibraryPreviewForSender\(rendererId\)/);
  assert.match(main, /releaseAllLibraryPreviews\(\)/);
  assert.match(main, /"access-control-allow-origin": "\*"/);

  assert.match(preload, /companion:start-library-preview/);
  assert.match(preload, /companion:stop-library-preview/);
  assert.doesNotMatch(preload, /CONTROL_TOKEN|127\.0\.0\.1|WATCHPAIR_CONTROL_TOKEN/);
  assert.match(renderer, /import\("\.\.\/\.\.\/node_modules\/hls\.js\/dist\/hls\.light\.min\.mjs"\)/);
  assert.match(renderer, /nativeHlsSupported\(record\.video\)/);
  assert.match(renderer, /enableWorker: false/);
  assert.match(renderer, /previewLibraryFile\(file, parent, \{ forceHls: true \}\)/);
  assert.match(renderer, /stopLibraryPreview\(preview\.sourceId\)\.catch/);
  assert.match(renderer, /record\.hls\?\.destroy\(\)/);
  assert.match(renderer, /window\.addEventListener\("pagehide"/);
  assert.doesNotMatch(renderer, /CONTROL_TOKEN|127\.0\.0\.1|WATCHPAIR_CONTROL_TOKEN/);
  assert.match(html, /connect-src watchpair-media:/);
  assert.match(builder, /node_modules\/hls\.js\/dist\/hls\.light\.min\.mjs/);
});

test("a delayed raw-preview completion cannot stop a newer preview", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("function runLibraryPreviewTransition(task)");
  const end = main.indexOf("function registerIpc()", start);
  assert.ok(start >= 0 && end > start, "preview lifecycle functions remain discoverable");
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const context = vm.createContext({
    path,
    randomUUID: () => ids.shift(),
    agentFetch: async () => { throw new Error("raw previews must not attach"); },
    electronLog: { warn() {} },
    assertMainRenderer() {},
    LIBRARY_FILE_ID_PATTERN: /^[a-f0-9]{24}$/,
    PREVIEW_JOB_ID_PATTERN: /^preview-[a-f0-9-]{36}$/,
    RAW_PREVIEW_EXTENSIONS: new Set([".m4v", ".mov", ".mp4", ".webm"]),
    libraryPreviewsBySender: new Map(),
    libraryPreviewsBySource: new Map(),
    libraryPreviewTransition: Promise.resolve(),
  });
  new vm.Script(`${main.slice(start, end)}
    globalThis.previewLifecycle = {
      start: startLibraryPreview,
      stop: stopLibraryPreview,
      current: libraryPreviewsBySender,
    };`).runInContext(context);

  const event = { sender: { id: 7 } };
  const first = await context.previewLifecycle.start(event, {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "first.mp4",
  });
  const secondPending = context.previewLifecycle.start(event, {
    id: "bbbbbbbbbbbbbbbbbbbbbbbb",
    name: "second.mp4",
  });
  const staleStop = context.previewLifecycle.stop(event, first.sourceId);
  const second = await secondPending;

  await assert.rejects(staleStop, /does not belong to this window/);
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(context.previewLifecycle.current.get(7).sourceId, second.sourceId);
});

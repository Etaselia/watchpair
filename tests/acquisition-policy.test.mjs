import assert from "node:assert/strict";
import test from "node:test";

import {
  acquisitionStatus,
  cachedLibraryBindingIsLive,
  isVerifiedLibraryMatch,
  libraryShareIntentKey,
  normalizeAcquisitionPolicy,
  pausableJobIds,
  shouldRetryLibraryMatch,
  shouldAcquireSource,
  transferRefreshIsCurrent,
} from "../lib/acquisition-policy.mjs";

test("migrates legacy Manual and External download settings", () => {
  assert.equal(normalizeAcquisitionPolicy(null, "manual"), "ask");
  assert.equal(normalizeAcquisitionPolicy(null, "external"), "never");
  assert.equal(normalizeAcquisitionPolicy("never", "automatic"), "never");
  assert.equal(normalizeAcquisitionPolicy("unexpected", "manual"), "automatic");
});

test("an initial library miss is retried after a short scan grace period", () => {
  assert.equal(shouldRetryLibraryMatch(undefined, 10_000), true);
  assert.equal(shouldRetryLibraryMatch(10_000, 14_999), false);
  assert.equal(shouldRetryLibraryMatch(10_000, 15_000), true);
});

test("deferred transfer refreshes cannot mutate after policy cleanup or a room change", () => {
  assert.equal(transferRefreshIsCurrent(true, 4, 4), true);
  assert.equal(transferRefreshIsCurrent(false, 4, 4), false, "policy effect was cleaned up");
  assert.equal(transferRefreshIsCurrent(true, 4, 5), false, "room generation changed");
});

test("cached local attachments are invalidated after a companion restart", () => {
  assert.equal(cachedLibraryBindingIsLive(true, "local-new", []), true);
  assert.equal(cachedLibraryBindingIsLive(false, "local-old", ["local-old"]), true);
  assert.equal(cachedLibraryBindingIsLive(false, "local-old", []), false);
});

test("Never cannot start a source even after it was previously approved", () => {
  assert.equal(shouldAcquireSource("automatic", "episode-1"), true);
  assert.equal(shouldAcquireSource("ask", "episode-1", ["episode-1"]), true);
  assert.equal(shouldAcquireSource("ask", "episode-1", []), false);
  assert.equal(shouldAcquireSource("never", "episode-1", ["episode-1"]), false);
  assert.equal(acquisitionStatus("never"), "Downloads disabled on this device");
});

test("switching to Never pauses only active incoming transfers", () => {
  const jobs = {
    queued: { id: "queued", status: "queued", seed: false },
    metadata: { id: "metadata", status: "metadata", seed: false },
    downloading: { id: "downloading", status: "downloading", seed: false },
    alreadyPaused: { id: "already-paused", status: "downloading", seed: false, paused: true },
    ready: { id: "ready", status: "ready", seed: false },
    readySeasonPartial: {
      id: "ready-season-partial",
      status: "ready",
      seed: false,
      files: [{ ready: true }, { ready: false }],
    },
    readySeasonComplete: {
      id: "ready-season-complete",
      status: "ready",
      seed: false,
      files: [{ ready: true }, { ready: true }],
    },
    seed: { id: "seed", status: "ready", seed: true },
  };
  assert.deepEqual(
    pausableJobIds(jobs),
    ["queued", "metadata", "downloading", "ready-season-partial"]
  );
  assert.deepEqual(
    pausableJobIds(jobs, ["downloading", "another-room-job"]),
    ["downloading"],
    "Never must not pause transfers belonging to another room"
  );
});

test("local replacement requires matching strong identity and size", () => {
  const selected = { fingerprint: "abc123", size: 4096 };
  assert.equal(isVerifiedLibraryMatch(selected, "abc123", 4096), true);
  assert.equal(isVerifiedLibraryMatch(selected, "abc123", 8192), false);
  assert.equal(isVerifiedLibraryMatch(selected, "different", 4096), false);
  assert.equal(isVerifiedLibraryMatch({ size: 4096 }, "abc123", 4096), false);
});

test("same-torrent file identity works before a room fingerprint is available", () => {
  const selected = { size: 4096 };
  const torrent = {
    selectedInfoHash: "AABBCC",
    libraryInfoHash: "aabbcc",
    selectedFileIndex: 3,
    libraryFileIndex: 3,
    selectedPath: "Season 1\\Episode 03.mkv",
    libraryPath: "Season 1/Episode 03.mkv",
  };
  assert.equal(isVerifiedLibraryMatch(selected, null, 4096, torrent), true);
  assert.equal(
    isVerifiedLibraryMatch(selected, null, 4096, { ...torrent, libraryFileIndex: 4 }),
    false
  );
  assert.equal(
    isVerifiedLibraryMatch(selected, null, 4096, { ...torrent, libraryInfoHash: "different" }),
    false
  );
  assert.equal(isVerifiedLibraryMatch(selected, null, 4096), false);
});

test("share intents prefer torrent or content identity over a scan id", () => {
  assert.equal(
    libraryShareIntentKey({ id: "scan-a", size: 1, infoHash: "AABB", torrentFileIndex: 3 }),
    "torrent:aabb:index:3:size:1"
  );
  assert.equal(
    libraryShareIntentKey({ id: "scan-a", size: 5, fingerprint: "content" }),
    "content:content:5"
  );
  assert.equal(libraryShareIntentKey({ id: "scan-a", size: 5 }), "library:scan-a");
});

test("share intents distinguish episodes in one torrent but dedupe aliases of one file", () => {
  const episodeOne = { id: "scan-a", size: 4096, infoHash: "AABB", torrentFileIndex: 1 };
  const episodeTwo = { id: "scan-b", size: 4096, infoHash: "AABB", torrentFileIndex: 2 };
  const episodeOneAlias = { ...episodeOne, id: "another-scan-id", relativePath: "Season 1/Episode 1.mkv" };
  assert.notEqual(libraryShareIntentKey(episodeOne), libraryShareIntentKey(episodeTwo));
  assert.equal(libraryShareIntentKey(episodeOne), libraryShareIntentKey(episodeOneAlias));
  assert.equal(
    libraryShareIntentKey({ id: "path-a", size: 10, infoHash: "CCDD", relativePath: "Season 1\\Episode.mkv" }),
    libraryShareIntentKey({ id: "path-b", size: 10, infoHash: "ccdd", relativePath: "Season 1/Episode.mkv" })
  );
});

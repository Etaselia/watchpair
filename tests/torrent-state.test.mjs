import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRestoredTorrentState,
  fileIdentityKey,
  persistedTorrentState,
  shouldSkipTorrentVerification,
  torrentVerifiedKeysOf,
} from "../agent/torrent-state.mjs";

// Mirrors the server's `mediaAsset(job, index)` lazy-creation contract.
function fakeMediaAsset(job, index) {
  if (!(job.assets instanceof Map)) job.assets = new Map();
  let asset = job.assets.get(index);
  if (!asset) {
    asset = { torrentVerifiedKey: null };
    job.assets.set(index, asset);
  }
  return asset;
}

test("fileIdentityKey embeds index, name, and size", () => {
  assert.equal(fileIdentityKey(0, { name: "movie.mp4", size: 100 }), "0:movie.mp4:100");
  assert.equal(fileIdentityKey(2, { name: "S01E01.mkv", size: 500 }), "2:S01E01.mkv:500");
  // The key is sensitive to every part of the identity.
  assert.notEqual(fileIdentityKey(0, { name: "movie.mp4", size: 100 }), fileIdentityKey(1, { name: "movie.mp4", size: 100 }));
  assert.notEqual(fileIdentityKey(0, { name: "movie.mkv", size: 100 }), fileIdentityKey(0, { name: "movie.mp4", size: 100 }));
  assert.notEqual(fileIdentityKey(0, { name: "movie.mp4", size: 101 }), fileIdentityKey(0, { name: "movie.mp4", size: 100 }));
});

test("shouldSkipTorrentVerification trusts persisted key only when identity and data match", () => {
  const verifiedKey = fileIdentityKey(0, { name: "movie.mp4", size: 100 });
  const current = fileIdentityKey(0, { name: "movie.mp4", size: 100 });
  // The safe fast path: same identity AND WebTorrent re-verified the data.
  assert.equal(shouldSkipTorrentVerification(verifiedKey, current, true), true);
  // Same identity but the store is no longer fully verified -> re-verify.
  assert.equal(shouldSkipTorrentVerification(verifiedKey, current, false), false);
  // Identity changed (name) -> re-verify.
  assert.equal(shouldSkipTorrentVerification(
    verifiedKey, fileIdentityKey(0, { name: "movie.mkv", size: 100 }), true), false);
  // Identity changed (size) -> re-verify.
  assert.equal(shouldSkipTorrentVerification(
    verifiedKey, fileIdentityKey(0, { name: "movie.mp4", size: 101 }), true), false);
  // No persisted key at all -> re-verify (new or never-verified file).
  assert.equal(shouldSkipTorrentVerification(null, current, true), false);
  assert.equal(shouldSkipTorrentVerification("", current, true), false);
});

test("torrentVerifiedKeysOf collects only verified per-file keys", () => {
  const job = {
    assets: new Map([
      [0, { torrentVerifiedKey: "0:a.mp4:10" }],
      [1, { torrentVerifiedKey: "1:b.mp4:20" }],
      [2, { torrentVerifiedKey: "" }], // never verified
      [3, { torrentVerifiedKey: null }],
      [4, {}],
    ]),
  };
  assert.deepEqual(torrentVerifiedKeysOf(job), { "0": "0:a.mp4:10", "1": "1:b.mp4:20" });
  assert.equal(torrentVerifiedKeysOf({ assets: new Map() }), undefined);
  assert.equal(torrentVerifiedKeysOf({}), undefined);
  assert.equal(torrentVerifiedKeysOf(null), undefined);
});

test("verification state survives a persisted -> restored round trip", () => {
  const liveJob = {
    torrentSilenced: true,
    assets: new Map([
      [0, { torrentVerifiedKey: fileIdentityKey(0, { name: "movie.mp4", size: 123 }) }],
    ]),
  };
  const persisted = persistedTorrentState(liveJob);
  assert.equal(persisted.torrentSilenced, true);
  assert.deepEqual(persisted.torrentVerifiedKeys, { "0": "0:movie.mp4:123" });

  // A fresh job object behaves like an agent restart: the record is the only
  // thing that survives.
  const restored = { torrentSilenced: false, assets: new Map() };
  applyRestoredTorrentState(restored, persisted, fakeMediaAsset);
  assert.equal(restored.torrentSilenced, true, "silenced flag is restored");
  assert.equal(restored.assets.get(0).torrentVerifiedKey, "0:movie.mp4:123");

  // Unchanged file identity + WebTorrent-verified data -> skip re-verification.
  assert.equal(shouldSkipTorrentVerification(
    restored.assets.get(0).torrentVerifiedKey,
    fileIdentityKey(0, { name: "movie.mp4", size: 123 }),
    true,
  ), true, "unchanged file skips the full piece re-hash");

  // The same restored key must NOT skip verification when the file changed.
  assert.equal(shouldSkipTorrentVerification(
    restored.assets.get(0).torrentVerifiedKey,
    fileIdentityKey(0, { name: "movie.mp4", size: 999 }),
    true,
  ), false, "a changed file is still fully verified");
  assert.equal(shouldSkipTorrentVerification(
    restored.assets.get(0).torrentVerifiedKey,
    fileIdentityKey(1, { name: "movie.mp4", size: 123 }),
    true,
  ), false, "a different file index is still fully verified");
});

test("applyRestoredTorrentState is defensive about malformed records", () => {
  const restored = { torrentSilenced: false, assets: new Map() };
  applyRestoredTorrentState(restored, null, fakeMediaAsset);
  assert.equal(restored.torrentSilenced, false);

  applyRestoredTorrentState(restored, {
    torrentSilenced: true,
    torrentVerifiedKeys: {
      "0": "0:ok.mp4:1",
      "-1": "bad-negative.mp4:1",
      "abc": "bad-index.mp4:1",
      "2": 42, // not a string
      "3": "", // empty
    },
  }, fakeMediaAsset);
  assert.equal(restored.torrentSilenced, true);
  assert.equal(restored.assets.get(0).torrentVerifiedKey, "0:ok.mp4:1");
  assert.equal(restored.assets.has(-1), false);
  assert.equal(restored.assets.has("abc"), false);
  assert.equal(restored.assets.has(2), false);
  assert.equal(restored.assets.has(3), false);
});

test("silenced state round trips through persistedTorrentState", () => {
  const silenced = persistedTorrentState({ torrentSilenced: true });
  assert.equal(silenced.torrentSilenced, true);
  const live = persistedTorrentState({ torrentSilenced: false });
  assert.equal(live.torrentSilenced, false);
  assert.equal(persistedTorrentState({}).torrentSilenced, false);
  assert.equal(persistedTorrentState(null).torrentSilenced, false);

  const target = { torrentSilenced: false, assets: new Map() };
  applyRestoredTorrentState(target, silenced, fakeMediaAsset);
  assert.equal(target.torrentSilenced, true);
});

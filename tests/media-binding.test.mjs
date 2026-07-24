import assert from "node:assert/strict";
import test from "node:test";

import { findLocalAgentMedia } from "../lib/media-binding.mjs";

function job(id, fingerprint, { selected = true, ready = true } = {}) {
  return {
    id,
    identityFingerprint: fingerprint,
    files: [{
      index: 0,
      name: `${id}.mkv`,
      size: 4096,
      selected,
      ready,
      fingerprint,
    }],
  };
}

test("binds identical media through a participant-specific source id", () => {
  const selectedMedia = {
    sourceId: "room-torrent",
    fileIndex: 0,
    name: "downloaded-name.mkv",
    size: 4096,
    fingerprint: "same-content",
  };
  const jobs = {
    "local-seed": job("local-seed", "same-content"),
  };

  const match = findLocalAgentMedia(jobs, selectedMedia);
  assert.equal(match.sourceId, "local-seed");
  assert.equal(match.file.name, "local-seed.mkv");
});

test("honors each participant's preferred matching copy", () => {
  const selectedMedia = {
    sourceId: "room-torrent",
    fileIndex: 0,
    name: "episode.mkv",
    size: 4096,
    fingerprint: "same-content",
  };
  const jobs = {
    "room-torrent": job("room-torrent", "same-content"),
    "local-seed": job("local-seed", "same-content"),
  };

  const match = findLocalAgentMedia(jobs, selectedMedia, {
    sourceId: "local-seed",
    fileIndex: 0,
    fingerprint: "same-content",
  });
  assert.equal(match.sourceId, "local-seed");
});

test("does not alias different content merely because its size matches", () => {
  const selectedMedia = {
    sourceId: "room-torrent",
    fileIndex: 0,
    name: "episode.mkv",
    size: 4096,
    fingerprint: "expected-content",
  };
  const jobs = {
    "local-seed": job("local-seed", "different-content"),
  };

  assert.equal(findLocalAgentMedia(jobs, selectedMedia), null);
});

test("does not bind a fingerprint to a differently sized local file", () => {
  const selectedMedia = {
    sourceId: "room-torrent",
    fileIndex: 0,
    name: "episode.mkv",
    size: 8192,
    fingerprint: "same-sampled-content",
  };
  const jobs = {
    "partial-local-copy": job("partial-local-copy", "same-sampled-content"),
  };

  assert.equal(findLocalAgentMedia(jobs, selectedMedia), null);
});

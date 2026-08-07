import assert from "node:assert/strict";
import test from "node:test";
import {
  compareMediaPaths,
  mediaItemId,
  mediaManifest,
  orderedMediaQueue,
  sameMediaManifest,
} from "../lib/media-queue.mjs";

test("naturally orders nested seasons and episode numbers", () => {
  const files = [
    { index: 4, path: "Season 2/Show S02E10.mkv", size: 10 },
    { index: 2, path: "Season 1/Show S01E02.mkv", size: 10 },
    { index: 3, path: "Season 2/Show S02E02.mkv", size: 10 },
    { index: 1, path: "Season 1/Show S01E01.mkv", size: 10 },
    { index: 0, path: "Season 1/readme.txt", size: 1 },
  ];
  assert.deepEqual(
    mediaManifest(files, "source-episode-pack").map((item) => item.fileIndex),
    [1, 2, 3, 4]
  );
  assert.ok(compareMediaPaths("Episode 2.mkv", "Episode 10.mkv") < 0);
});

test("builds deterministic media ids and preserves relative paths", () => {
  const [item] = mediaManifest([
    { index: 7, path: "Show\\\\Season 1\\\\Episode 1.mkv", size: 42 },
  ], "source-episode-pack");
  assert.equal(item.id, mediaItemId("source-episode-pack", 7));
  assert.equal(item.path, "Show/Season 1/Episode 1.mkv");
  assert.equal(item.name, "Episode 1.mkv");
});

test("orders selected media first, then manual priorities, then watch order", () => {
  const source = {
    id: "source-episode-pack",
    mediaItems: [
      { id: "one", fileIndex: 0, path: "1.mkv", name: "1.mkv", size: 1, included: true, priority: false },
      { id: "two", fileIndex: 1, path: "2.mkv", name: "2.mkv", size: 1, included: true, priority: false },
      { id: "three", fileIndex: 2, path: "3.mkv", name: "3.mkv", size: 1, included: true, priority: true },
      { id: "four", fileIndex: 3, path: "4.mkv", name: "4.mkv", size: 1, included: true, priority: false },
    ],
  };
  assert.deepEqual(orderedMediaQueue([source], "two").map((item) => item.id), ["two", "three", "four", "one"]);
});

test("compares manifests using synchronized file identity", () => {
  const manifest = mediaManifest([
    { index: 0, path: "S01/E01.mkv", size: 100 },
    { index: 1, path: "S01/E02.mkv", size: 100 },
  ], "source-episode-pack");
  assert.equal(sameMediaManifest(manifest, structuredClone(manifest)), true);
  const changed = structuredClone(manifest);
  assert.equal(sameMediaManifest(manifest, [...manifest].reverse()), true);
  changed[1].size += 1;
  assert.equal(sameMediaManifest(manifest, changed), false);
});

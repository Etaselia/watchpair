import assert from "node:assert/strict";
import test from "node:test";
import {
  firstPendingMediaTarget,
  mediaTargetKey,
  normalizeMediaTargets,
  preparationMediaTargets,
  replaceTorrentSelections,
} from "../agent/media-priority.mjs";

function mockFile(done = false) {
  const calls = [];
  return {
    done,
    calls,
    deselect: () => calls.push("deselect"),
    select: (priority) => calls.push(`select:${priority}`),
  };
}

test("normalizes a unique ordered per-file priority plan", () => {
  assert.deepEqual(normalizeMediaTargets([
    { jobId: "source-pack-one", fileIndex: 2, itemId: "episode-two" },
    { jobId: "source-pack-one", fileIndex: 7, itemId: "episode-seven" },
  ]), [
    { jobId: "source-pack-one", fileIndex: 2, itemId: "episode-two" },
    { jobId: "source-pack-one", fileIndex: 7, itemId: "episode-seven" },
  ]);
  assert.equal(mediaTargetKey("source-pack-one", 2), "source-pack-one:2");
  assert.throws(() => normalizeMediaTargets([
    { jobId: "source-pack-one", fileIndex: 2 },
    { jobId: "source-pack-one", fileIndex: 2 },
  ]), /duplicate/i);
});

test("chooses the first unfinished file in watch order", () => {
  const targets = normalizeMediaTargets([
    { jobId: "source-pack-one", fileIndex: 0 },
    { jobId: "source-pack-two", fileIndex: 4 },
    { jobId: "source-pack-one", fileIndex: 8 },
  ]);
  const files = new Map([
    ["source-pack-one:0", { done: true }],
    ["source-pack-two:4", { done: false }],
    ["source-pack-one:8", { done: false }],
  ]);
  assert.deepEqual(
    firstPendingMediaTarget(targets, (target) => files.get(mediaTargetKey(target.jobId, target.fileIndex))),
    targets[1]
  );
});

test("clears stale WebTorrent priorities before selecting the next episode", () => {
  const files = [mockFile(), mockFile(), mockFile(true)];
  replaceTorrentSelections({ files }, [{ fileIndex: 1, priority: 100 }]);
  assert.deepEqual(files[0].calls, ["deselect"]);
  assert.deepEqual(files[1].calls, ["deselect", "select:100"]);
  assert.deepEqual(files[2].calls, ["deselect"]);
});

test("a watched current video retains preparation priority without reopening its download selection", () => {
  const selected = { jobId: "source-pack-one", fileIndex: 0 };
  const next = { jobId: "source-pack-one", fileIndex: 1 };
  const skipped = { jobId: "source-pack-one", fileIndex: 2 };
  const targets = preparationMediaTargets(selected, [selected, next, skipped], (target) => target.fileIndex === 1);
  assert.deepEqual(targets.map((target) => target.fileIndex), [0, 1]);
  assert.deepEqual(preparationMediaTargets(selected, [], () => false).map((target) => target.fileIndex), [0]);
  assert.deepEqual(preparationMediaTargets(null, [selected, skipped], () => false), []);
  const files = [mockFile(true), mockFile(), mockFile()];
  // Only download-eligible files are forwarded to the torrent selection code.
  replaceTorrentSelections({ files }, targets.filter((target) => target.fileIndex === 1));
  assert.deepEqual(files[0].calls, ["deselect"]);
  assert.deepEqual(files[1].calls, ["deselect", "select:100"]);
  assert.deepEqual(files[2].calls, ["deselect"]);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWatchCoverageTracker, downloadFileIndexes, mediaWatchKey, mergeWatchedRanges, relativeWatchTime, unreportedWatchedRanges, watchedFraction } from "../lib/watch-history.mjs";
import { mediaFolderTree, mediaManifest, mediaQueue } from "../lib/media-queue.mjs";
import { FileSessionStore, handleSessionApi } from "../worker/session-api.ts";

const source = {
  id: "season-pack-001", kind: "magnet", label: "Show collection", addedAt: 1, addedBy: "host",
  value: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
};
const items = mediaManifest([
  { index: 0, path: "Show/Season 1/Episode 1.mkv", size: 100 },
  { index: 1, path: "Show/Season 2/Episode 1.mkv", size: 100 },
  { index: 2, path: "Show/Bonus/Interview.mkv", size: 100 },
], source.id).sort((a, b) => a.fileIndex - b.fileIndex);

test("coverage unions repeated scenes and leaves skipped footage unwatched", () => {
  let ranges = mergeWatchedRanges([], 0, 40, 100);
  ranges = mergeWatchedRanges(ranges, 20, 50, 100);
  ranges = mergeWatchedRanges(ranges, 95, 100, 100);
  assert.deepEqual(ranges, [[0, 50], [95, 100]]);
  assert.equal(watchedFraction(ranges, 100), 0.55);
  assert.deepEqual(mergeWatchedRanges(ranges, 50, 95, 100), [[0, 100]]);
});

test("playback reports only new played ranges in bounded intervals, including after seeks", () => {
  assert.deepEqual(unreportedWatchedRanges([[0, 95]], [[0, 30], [50, 60]], 100), [[30, 50], [60, 80], [80, 95]]);
  assert.deepEqual(unreportedWatchedRanges([[0, 10], [90, 95]], [[0, 10]], 100), [[90, 95]]);
  assert.deepEqual(unreportedWatchedRanges([[0, 90]], [[0, 90]], 100), []);
  assert.deepEqual(unreportedWatchedRanges([[0, 110]], [], 100), [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]]);
});

test("a new viewing counts replayed footage even when the same video remains loaded", () => {
  const observe = (tracker, position, time, playing = true) => tracker.observe({ position, time, playing });
  const first = createWatchCoverageTracker();
  observe(first, 0, 0);
  observe(first, 100, 100_000, false);
  assert.equal(watchedFraction(first.ranges(), 100), 1);

  // Mark unwatched creates a tracker for a new generation without replacing video.
  const replay = createWatchCoverageTracker();
  observe(replay, 100, 101_000);
  replay.discontinuity();
  observe(replay, 0, 102_000);
  observe(replay, 90, 192_000, false);
  assert.deepEqual(replay.ranges(), [[0, 90]]);
  assert.equal(watchedFraction(replay.ranges(), 100), 0.9);
  assert.equal(unreportedWatchedRanges(replay.ranges(), [], 100).length, 5);
});

test("viewing coverage excludes seek gaps, buffering, paused time, and repeated scenes", () => {
  const tracker = createWatchCoverageTracker();
  const observe = (position, time, playing = true, seeking = false) => tracker.observe({ position, time, playing, seeking });
  observe(0, 0);
  observe(10, 10_000);
  observe(90, 11_000, true, true);
  observe(90, 12_000);
  observe(95, 17_000, false);
  observe(95, 80_000); // Resume after a pause or buffer stall.
  observe(100, 85_000, false);
  tracker.discontinuity();
  observe(0, 86_000);
  observe(10, 96_000, false);
  assert.deepEqual(tracker.ranges(), [[0, 10], [90, 100]]);
  assert.equal(watchedFraction(tracker.ranges(), 100), 0.2);
});

test("coverage handles playback rates and rejects unannounced position jumps", () => {
  const tracker = createWatchCoverageTracker();
  tracker.observe({ position: 0, time: 0, rate: 2, playing: true });
  tracker.observe({ position: 20, time: 10_000, rate: 2, playing: true });
  tracker.observe({ position: 90, time: 11_000, rate: 2, playing: true });
  tracker.observe({ position: 91, time: 12_000, rate: 1, playing: false });
  assert.deepEqual(tracker.ranges(), [[0, 20], [90, 91]]);
});

test("folder tree retains duplicate episode names and arbitrary nesting", () => {
  const tree = mediaFolderTree(items);
  assert.deepEqual(tree.children[0].children.map((folder) => folder.name), ["Bonus", "Season 1", "Season 2"]);
  assert.equal(tree.children[0].children[1].items[0].fileIndex, 0);
  assert.equal(tree.children[0].children[2].items[0].fileIndex, 1);
});

test("selection distinguishes metadata-only, empty, legacy, skipped, and watched files", () => {
  const pack = { ...source, mediaItems: items };
  assert.equal(downloadFileIndexes(source), null);
  assert.deepEqual(downloadFileIndexes({ ...pack, selectionConfirmed: false }), []);
  assert.deepEqual(downloadFileIndexes({ ...pack, mediaItems: items.map((item) => ({ ...item, included: false })) }), []);
  const key = mediaWatchKey(pack, items[0]);
  const records = { [key]: { watchedAt: 123 } };
  assert.deepEqual(downloadFileIndexes(pack, records), [1, 2]);
  assert.deepEqual(mediaQueue([pack], records).map((item) => item.fileIndex), [1, 2]);
  assert.deepEqual(mediaQueue([{ ...pack, selectionConfirmed: false }]), []);
  assert.equal(mediaWatchKey(pack, items[0]), mediaWatchKey({ ...pack, id: "readded-source" }, items[0]));
});

test("relative watched timestamps handle minute, hour, day, and future clock skew", () => {
  assert.equal(relativeWatchTime(1000, 0), "just now");
  assert.equal(relativeWatchTime(0, 60_000), "1 minute ago");
  assert.equal(relativeWatchTime(0, 7_200_000), "2 hours ago");
  assert.equal(relativeWatchTime(0, 3 * 86_400_000), "3 days ago");
});

test("90 percent completion is idempotent, persists, and survives source removal", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sessions.json");
  const now = Date.now();
  const store = new FileSessionStore({ iceServers: [] }, file);
  await store.initialize();
  await store.create("ABCD-EFGH", "host", now);
  await store.setSource("ABCD-EFGH", { ...source, mediaItems: items }, now);
  const target = { source, media: { ...items[0], sourceId: source.id, itemId: items[0].id } };
  const key = mediaWatchKey(source, target.media);
  for (let start = 0; start < 80; start += 10) await store.updateWatch("ABCD-EFGH", [target], "progress", now,
    { start, end: start + 10, duration: 100, generation: 0 });
  assert.equal((await store.get("ABCD-EFGH")).watchRecords[key].watchedAt, null);
  await store.updateWatch("ABCD-EFGH", [target], "progress", now + 10,
    { start: 80, end: 90, duration: 100, generation: 0 });
  await store.updateWatch("ABCD-EFGH", [target], "progress", now + 20,
    { start: 80, end: 90, duration: 100, generation: 0 });
  await store.setSources("ABCD-EFGH", [], now + 20);
  await store.flush();
  const restored = new FileSessionStore({ iceServers: [] }, file);
  await restored.initialize();
  let entry = (await restored.get("ABCD-EFGH")).watchRecords[key];
  assert.equal(entry.watchedAt, now + 10);
  assert.equal(entry.completions.length, 1);
  assert.equal(entry.media.path, items[0].path);
  await restored.updateWatch("ABCD-EFGH", [entry], "again", now + 30);
  let session = await restored.get("ABCD-EFGH");
  assert.equal(session.watchRecords[key].watchedAt, null);
  assert.deepEqual(session.watchRecords[key].ranges, []);
  assert.deepEqual(session.sources[0].selectedFileIndexes, [0]);
  // Delayed reports from the old viewing cannot mark the rewatch complete.
  await restored.updateWatch("ABCD-EFGH", [target], "progress", now + 40,
    { start: 0, end: 90, duration: 100, generation: 0 });
  assert.deepEqual((await restored.get("ABCD-EFGH")).watchRecords[key].ranges, []);
  await restored.updateWatch("ABCD-EFGH", [target], "watched", now + 50);
  session = await restored.get("ABCD-EFGH");
  entry = session.watchRecords[key];
  assert.equal(entry.completions.length, 2);
  await restored.flush();
});

async function apiRoom() {
  const create = await handleSessionApi(new Request("http://localhost/api/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", deviceId: "host", name: "Host" }),
  }));
  const { session } = await create.json();
  return async (action, fields = {}, actor = "host") => {
    const response = await handleSessionApi(new Request("http://localhost/api/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, token: session.token, deviceId: actor, name: actor, ...fields }),
    }));
    return { status: response.status, ...await response.json() };
  };
}

test("Watch again resets the selected video's position while preserving playback preferences", async () => {
  const request = await apiRoom();
  await request("source", { source: { ...source, selectionConfirmed: true } });
  await request("source-manifest", { sourceId: source.id, mediaItems: items });
  await request("select-media", { media: { ...items[0], sourceId: source.id, itemId: items[0].id } });
  await request("player", { player: { paused: true, position: 100, playbackRate: 1.25,
    audioLanguage: "embedded:1", subtitleLanguage: "embedded:2", subtitleOffset: 250 } });
  await request("watch-state", { state: "watched" });
  const key = mediaWatchKey(source, items[0]);
  let result = await request("watch-state", { state: "again", key });
  assert.equal(result.status, 200);
  assert.equal(result.session.player.position, 0);
  assert.equal(result.session.player.paused, true);
  assert.equal(result.session.player.playbackRate, 1.25);
  assert.equal(result.session.player.audioLanguage, "embedded:1");
  assert.equal(result.session.player.subtitleLanguage, "embedded:2");
  assert.equal(result.session.player.subtitleOffset, 250);
  assert.equal(result.session.watchRecords[key].generation, 1);
  // Requeueing another episode must not interrupt the one currently playing.
  await request("select-media", { media: { ...items[1], sourceId: source.id, itemId: items[1].id } });
  await request("player", { player: { paused: false, position: 55, playbackRate: 1 } });
  result = await request("watch-state", { state: "again", key });
  assert.equal(result.session.player.position, 55);
  assert.equal(result.session.player.paused, false);
});

test("direct videos support source and canonical row watch actions without a torrent manifest", async () => {
  const request = await apiRoom();
  const direct = { id: "review-direct-source", kind: "direct", value: "https://media.example/video.mp4", label: "Movie" };
  await request("source", { source: direct });
  const media = { sourceId: direct.id, fileIndex: 0, itemId: `${direct.id}-f0`, name: "movie.mp4", size: 100 };
  await request("select-media", { media });
  let result = await request("watch-state", { state: "watched", sourceId: direct.id, itemIds: [media.itemId] });
  assert.equal(result.status, 200);
  const key = mediaWatchKey(direct, media);
  assert.equal(result.session.watchRecords[key].media.name, media.name);
  assert.equal(result.session.watchRecords[key].media.size, media.size);
  await request("watch-state", { state: "unwatched", key });
  result = await request("watch-state", { state: "watched", sourceId: direct.id });
  assert.equal(result.status, 200);
  assert.equal(result.session.watchRecords[key].completions.length, 2);
  assert.equal((await request("watch-state", { state: "watched", sourceId: direct.id, itemIds: [`${direct.id}-f1`] })).status, 400);
});

test("room API applies folder selection atomically and preserves it on metadata republish", async () => {
  const request = await apiRoom();
  await request("source", { source });
  let result = await request("source-manifest", { sourceId: source.id, mediaItems: items });
  assert.equal(result.session.sources[0].selectionConfirmed, false);
  result = await request("select-files", { sourceId: source.id, itemIds: [items[1].id] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.session.sources[0].mediaItems.filter((item) => item.included).map((item) => item.fileIndex), [1]);
  result = await request("source-manifest", { sourceId: source.id, mediaItems: items });
  assert.deepEqual(result.session.sources[0].mediaItems.filter((item) => item.included).map((item) => item.fileIndex), [1]);
  assert.equal((await request("select-media", { media: { ...items[0], sourceId: source.id, itemId: items[0].id } })).status, 409);
  assert.equal((await request("select-files", { sourceId: source.id, itemIds: ["missing"] })).status, 400);
  result = await request("select-files", { sourceId: source.id, itemIds: [] });
  assert.deepEqual(downloadFileIndexes(result.session.sources[0]), []);
});

test("room API restricts progress to the host and selected file, rejects seeks, and supports bulk watched actions", async () => {
  const request = await apiRoom();
  await request("source", { source: { ...source, selectionConfirmed: true } });
  await request("source-manifest", { sourceId: source.id, mediaItems: items });
  await request("select-media", { media: { ...items[0], sourceId: source.id, itemId: items[0].id } });
  const progress = { key: mediaWatchKey(source, items[0]), start: 0, end: 10, duration: 100, generation: 0 };
  assert.equal((await request("watch-progress", progress, "guest")).status, 409);
  assert.equal((await request("watch-progress", { ...progress, key: "wrong-video" })).status, 409);
  assert.equal((await request("watch-progress", { ...progress, end: 95 })).status, 400);
  assert.equal((await request("watch-progress", { ...progress, duration: null })).status, 400);
  assert.equal((await request("watch-progress", progress)).status, 200);
  let result = await request("watch-state", { state: "watched", sourceId: source.id, itemIds: items.map((item) => item.id) });
  assert.equal(Object.values(result.session.watchRecords).filter((item) => item.watchedAt).length, 3);
  assert.deepEqual(mediaQueue(result.session.sources, result.session.watchRecords), []);
  result = await request("watch-state", { state: "unwatched", key: progress.key });
  assert.equal(result.session.watchRecords[progress.key].watchedAt, null);
  assert.equal(result.session.watchRecords[progress.key].generation, 1);
  assert.equal((await request("watch-state", { state: "watched", key: "missing" })).status, 400);
});

test("rewatching restores multiple removed episodes and reuses a re-added torrent's identity", async () => {
  const request = await apiRoom();
  await request("source", { source: { ...source, selectionConfirmed: true } });
  await request("source-manifest", { sourceId: source.id, mediaItems: items });
  await request("watch-state", { state: "watched", sourceId: source.id, itemIds: items.map((item) => item.id) });
  await request("remove-source", { sourceId: source.id });
  await request("watch-state", { state: "again", key: mediaWatchKey(source, items[0]) });
  let result = await request("watch-state", { state: "again", key: mediaWatchKey(source, items[1]) });
  assert.deepEqual(result.session.sources[0].selectedFileIndexes, [0, 1]);
  result = await request("source-manifest", { sourceId: source.id, mediaItems: items });
  assert.deepEqual(downloadFileIndexes(result.session.sources[0], result.session.watchRecords), [0, 1]);
  await request("watch-state", { state: "watched", key: mediaWatchKey(source, items[0]) });
  await request("remove-source", { sourceId: source.id });
  const readded = { ...source, id: "same-torrent-new-id", selectionConfirmed: true };
  await request("source", { source: readded });
  await request("source-manifest", { sourceId: readded.id, mediaItems: items });
  result = await request("watch-state", { state: "again", key: mediaWatchKey(source, items[0]) });
  assert.equal(result.session.sources.length, 1);
  assert.equal(result.session.sources[0].id, readded.id);
  assert.equal(result.session.watchRecords[mediaWatchKey(source, items[0])].media.sourceId, readded.id);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSingleFlightCache,
  MANAGED_JOB_DIRECTORY,
  pathSize,
  pruneExpiredChildren,
  removePathAndMeasure,
} from "../agent/storage-cleanup.mjs";

const DAY = 24 * 60 * 60 * 1000;

test("measures and removes owned directory trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "watchpair-storage-"));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "first.bin"), Buffer.alloc(7));
  await writeFile(path.join(root, "nested", "second.bin"), Buffer.alloc(11));
  assert.equal(await pathSize(root), 18);
  assert.equal(await removePathAndMeasure(root), 18);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("prunes only expired, unprotected, matching children", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "watchpair-prune-"));
  const oldId = "source-old-1234";
  const currentId = "source-current-1";
  const unrelated = "My Videos";
  for (const name of [oldId, currentId, unrelated]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "file.bin"), Buffer.alloc(5));
  }
  const old = new Date(Date.now() - 40 * DAY);
  await utimes(path.join(root, oldId), old, old);
  await utimes(path.join(root, unrelated), old, old);

  const removed = await pruneExpiredChildren(root, {
    maxAgeMs: 30 * DAY,
    include: (entry) => entry.isDirectory() && MANAGED_JOB_DIRECTORY.test(entry.name),
    protectedNames: new Set([currentId]),
  });

  assert.deepEqual(removed, [{ name: oldId, bytes: 5 }]);
  assert.equal((await stat(path.join(root, unrelated))).isDirectory(), true);
});

test("coalesces storage scans and reuses the cached measurement", async () => {
  let clock = 1_000;
  let loads = 0;
  let finishLoad = () => {};
  const cache = createSingleFlightCache({
    ttlMs: 100,
    retryDelayMs: 100,
    now: () => clock,
    load() {
      loads += 1;
      return new Promise((resolve) => {
        finishLoad = resolve;
      });
    },
  });

  const first = cache.get();
  const second = cache.get();
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(loads, 1);
  finishLoad({ bytes: 7 });
  assert.deepEqual(await Promise.all([first, second]), [{ bytes: 7 }, { bytes: 7 }]);
  assert.deepEqual(await cache.get(), { bytes: 7 });
  assert.equal(loads, 1);

  clock += 101;
  const refreshed = cache.get();
  await Promise.resolve();
  assert.equal(loads, 2);
  finishLoad({ bytes: 9 });
  assert.deepEqual(await refreshed, { bytes: 9 });
});

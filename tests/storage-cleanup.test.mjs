import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSingleFlightOperation,
  createSingleFlightCache,
  MANAGED_JOB_DIRECTORY,
  pathSize,
  pruneExpiredChildren,
  removePathAndMeasure,
} from "../agent/storage-cleanup.mjs";
import {
  estimateStorageAfterCleanup,
  waitForCleanupOperation,
} from "../desktop/cleanup-operation.mjs";

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

test("runs cleanup as an observable single-flight background operation", async () => {
  let clock = 1_000;
  let runs = 0;
  let finish = () => {};
  const operations = createSingleFlightOperation({
    now: () => clock,
    createId: () => `cleanup-${runs + 1}`,
    run() {
      runs += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  });

  const first = operations.start({ force: true });
  const joined = operations.start({ force: true });
  assert.equal(first.started, true);
  assert.equal(joined.started, false);
  assert.equal(joined.operation.id, first.operation.id);
  assert.strictEqual(joined.completion, first.completion);
  assert.equal(operations.get(first.operation.id).status, "running");

  await Promise.resolve();
  assert.equal(runs, 1);
  clock += 6_000;
  assert.equal(operations.get(first.operation.id).status, "running");
  finish({ removedJobs: [], removedEntries: [], bytes: 0 });
  const completed = await first.completion;
  assert.equal(completed.status, "complete");
  assert.equal(completed.finishedAt, 7_000);
  assert.deepEqual(operations.get(first.operation.id).result, {
    removedJobs: [], removedEntries: [], bytes: 0,
  });

  const next = operations.start({ force: true });
  assert.equal(next.started, true);
  assert.notEqual(next.operation.id, first.operation.id);
  await Promise.resolve();
  finish({ removedJobs: [], removedEntries: [], bytes: 0 });
  await next.completion;
});

test("desktop cleanup polling tolerates operations longer than the request timeout", async () => {
  let elapsed = 0;
  let reads = 0;
  const result = { removedJobs: ["source-old-1234"], removedEntries: [], bytes: 25 };
  const completed = await waitForCleanupOperation(
    {
      id: "cleanup-long",
      status: "running",
      startedAt: 0,
      finishedAt: null,
      result: null,
      error: null,
    },
    {
      pollIntervalMs: 1_000,
      delay(milliseconds) {
        elapsed += milliseconds;
      },
      async read(id) {
        assert.equal(id, "cleanup-long");
        reads += 1;
        return elapsed > 5_000
          ? {
              id,
              status: "complete",
              startedAt: 0,
              finishedAt: elapsed,
              result,
              error: null,
            }
          : {
              id,
              status: "running",
              startedAt: 0,
              finishedAt: null,
              result: null,
              error: null,
            };
      },
    }
  );

  assert.equal(elapsed, 6_000);
  assert.equal(reads, 6);
  assert.deepEqual(completed, result);
  assert.strictEqual(await waitForCleanupOperation(result), result);
});

test("desktop cleanup polling surfaces background operation failures", async () => {
  const operations = createSingleFlightOperation({
    createId: () => "cleanup-failed",
    run() {
      throw new Error("Could not scan storage.");
    },
  });
  const started = operations.start();
  const failed = await started.completion;
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "Could not scan storage.");
  assert.ok(Number.isFinite(failed.finishedAt));

  await assert.rejects(
    waitForCleanupOperation(failed),
    /Could not scan storage/
  );
});

test("desktop cleanup estimates only the storage snapshot captured at start", () => {
  const captured = {
    directory: "downloads",
    usage: {
      bytes: 100,
      availableBytes: 900,
      totalBytes: 1_000,
      managedJobs: 3,
      pinnedJobs: 1,
    },
  };
  const result = {
    removedJobs: ["source-old-1234"],
    removedEntries: [],
    bytes: 20,
  };

  const estimated = estimateStorageAfterCleanup(captured, result, {
    currentRevision: 4,
    startedRevision: 4,
  });
  assert.notStrictEqual(estimated, captured);
  assert.deepEqual(estimated.usage, {
    bytes: 80,
    availableBytes: 920,
    totalBytes: 1_000,
    managedJobs: 2,
    pinnedJobs: 1,
  });
  assert.equal(captured.usage.bytes, 100, "the captured state remains immutable");

  const refreshed = {
    ...captured,
    usage: { ...captured.usage, bytes: 80, availableBytes: 920, managedJobs: 2 },
  };
  assert.strictEqual(
    estimateStorageAfterCleanup(refreshed, result, {
      currentRevision: 5,
      startedRevision: 4,
    }),
    refreshed,
    "cleanup bytes must not be subtracted again from a newer refresh"
  );
});

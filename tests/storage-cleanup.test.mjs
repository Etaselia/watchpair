import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSingleFlightOperation,
  createSingleFlightCache,
  MANAGED_JOB_DIRECTORY,
  pathLatestMtime,
  pathSize,
  pruneExpiredChildren,
  removePathAndMeasure,
} from "../agent/storage-cleanup.mjs";
import {
  estimateStorageAfterCleanup,
  legacyCleanupConfirmationOptions,
  legacyCleanupDownloads,
  legacyCleanupJobs,
  mergeCleanupResults,
  runCleanupWithLegacyConfirmation,
  shouldRefreshStorage,
  summarizeCleanupResult,
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

test("finds the latest mtime anywhere in an owned directory tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "watchpair-storage-mtime-"));
  const nested = path.join(root, "nested");
  const first = path.join(root, "first.bin");
  const second = path.join(nested, "second.bin");
  await mkdir(nested);
  await writeFile(first, Buffer.alloc(1));
  await writeFile(second, Buffer.alloc(1));
  const old = new Date(Date.now() - 4 * DAY);
  const recent = new Date(Date.now() - 2 * DAY);
  await utimes(first, old, old);
  await utimes(second, recent, recent);
  await utimes(nested, old, old);
  await utimes(root, old, old);

  assert.equal(await pathLatestMtime(root), (await stat(second)).mtimeMs);
  await rm(root, { recursive: true, force: true });
});

test("measures symlinks without following external targets or cycles", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "watchpair-storage-links-"));
  const owned = path.join(root, "owned");
  const external = path.join(root, "external");
  const externalLink = path.join(owned, "external-link");
  const cycleLink = path.join(owned, "cycle-link");
  await mkdir(owned);
  await mkdir(external);
  await writeFile(path.join(owned, "owned.bin"), Buffer.alloc(5));
  await writeFile(path.join(external, "external.bin"), Buffer.alloc(23));

  try {
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(external, externalLink, directoryLinkType);
    await symlink(owned, cycleLink, directoryLinkType);
  } catch (error) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      context.skip(`directory symlinks are unavailable: ${error.code}`);
      await rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    const future = new Date(Date.now() + 3 * DAY);
    await utimes(path.join(external, "external.bin"), future, future);
    const expectedBytes = 5 + (await lstat(externalLink)).size + (await lstat(cycleLink)).size;
    assert.equal(await pathSize(owned), expectedBytes);
    assert.ok(
      await pathLatestMtime(owned) < (await stat(path.join(external, "external.bin"))).mtimeMs,
      "latest-mtime traversal must not follow links outside the owned tree",
    );
    assert.equal(await removePathAndMeasure(owned), expectedBytes);
    assert.equal((await stat(path.join(external, "external.bin"))).size, 23);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("orphan pruning ignores disappearance but surfaces inspection failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "watchpair-prune-errors-"));
  const candidate = "source-old-1234";
  await mkdir(path.join(root, candidate));

  const missing = new Error("gone");
  missing.code = "ENOENT";
  assert.deepEqual(await pruneExpiredChildren(root, {
    maxAgeMs: 1,
    include: () => true,
    inspect: async () => { throw missing; },
  }), []);

  const denied = new Error("permission denied");
  denied.code = "EACCES";
  await assert.rejects(
    pruneExpiredChildren(root, {
      maxAgeMs: 1,
      include: () => true,
      inspect: async () => { throw denied; },
    }),
    { code: "EACCES" },
  );
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

test("desktop legacy cleanup prompt is explicit and safe by default", () => {
  assert.deepEqual(legacyCleanupJobs({}), []);
  assert.deepEqual(
    legacyCleanupJobs({ legacyJobs: ["source-old-1234", "", 17, "source-old-1234"] }),
    ["source-old-1234"]
  );
  assert.equal(legacyCleanupConfirmationOptions({ removedJobs: [] }), null);
  const candidates = {
    legacyJobs: ["source-old-1234", "source-old-5678"],
    legacyDownloads: [
      { id: "source-old-1234", label: "  Movie\nNight\u202e  " },
      { id: "source-old-5678", label: "" },
      { id: "source-not-approved", label: "Must not appear" },
    ],
  };
  assert.deepEqual(legacyCleanupDownloads(candidates), [
    { id: "source-old-1234", label: "Movie Night" },
    { id: "source-old-5678", label: "source-old-5678" },
  ]);
  assert.deepEqual(
    legacyCleanupConfirmationOptions(
      candidates,
      { retentionDays: 30 }
    ),
    {
      type: "warning",
      title: "Review old downloads",
      message: "Found 2 old downloads with unreliable activity dates.",
      detail: "An older WatchPair version lost the last-used dates for these downloads. Their files on disk are older than your 30-day retention limit, but WatchPair cannot tell whether they were played recently. Keep them unless you explicitly want to remove them now.\n\nDownloads to review:\n• Movie Night\n• source-old-5678",
      buttons: ["Keep downloads", "Remove 2 old downloads"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
  );
  const manyCandidates = {
    legacyJobs: Array.from({ length: 10 }, (_, index) => `source-old-${index + 1}`),
    legacyDownloads: Array.from({ length: 10 }, (_, index) => ({
      id: `source-old-${index + 1}`,
      label: `Download ${index + 1}`,
    })),
  };
  const manyOptions = legacyCleanupConfirmationOptions(manyCandidates);
  assert.equal(manyOptions.message, "Found 10 old downloads with unreliable activity dates.");
  assert.equal(manyOptions.detail.match(/\n• /gu)?.length, 8);
  assert.match(manyOptions.detail, /… and 2 more$/u);
  assert.doesNotMatch(manyOptions.detail, /Download 9/u);
  assert.equal(
    summarizeCleanupResult({
      removedJobs: [],
      removedEntries: [],
      bytes: 0,
      legacyJobs: ["source-old-1234", "source-old-5678"],
    }).message,
    "Cleanup complete — kept 2 older downloads"
  );
  assert.equal(
    summarizeCleanupResult({
      removedJobs: ["source-expired-1"],
      removedEntries: [],
      bytes: 10,
      legacyJobs: ["source-old-1234"],
    }).message,
    "Cleanup complete — removed 1 download; freed 10 B; kept 1 older download"
  );
});

test("desktop keeps legacy downloads unless confirmation is explicitly true", async () => {
  const legacyResult = {
    removedJobs: [],
    removedEntries: [],
    bytes: 0,
    legacyJobs: ["source-old-1234"],
  };

  for (const decision of [false, undefined, 1]) {
    const starts = [];
    const result = await runCleanupWithLegacyConfirmation({
      start(request) {
        starts.push(request);
        return legacyResult;
      },
      confirmLegacy: async () => decision,
    });
    assert.strictEqual(result, legacyResult);
    assert.deepEqual(starts, [{ includeLegacy: false, legacyJobs: [] }]);
  }

  let prompted = false;
  const oldAgentResult = { removedJobs: [], removedEntries: [], bytes: 0 };
  const result = await runCleanupWithLegacyConfirmation({
    start: async () => oldAgentResult,
    confirmLegacy: async () => {
      prompted = true;
      return true;
    },
  });
  assert.strictEqual(result, oldAgentResult);
  assert.equal(prompted, false, "old agents without legacyJobs remain compatible");
});

test("desktop confirms legacy cleanup once and merges both operation results", async () => {
  const initial = {
    removedJobs: ["source-expired-1"],
    removedEntries: ["expired-import.part"],
    bytes: 20,
    legacyJobs: ["source-legacy-1"],
  };
  const confirmed = {
    removedJobs: ["source-legacy-1"],
    removedEntries: ["hls:source-legacy-1"],
    bytes: 30,
    legacyJobs: ["source-new-1"],
    legacyDownloads: [{ id: "source-new-1", label: "New candidate" }],
  };
  const starts = [];
  const result = await runCleanupWithLegacyConfirmation({
    start(request) {
      starts.push(request);
      return request.includeLegacy ? confirmed : initial;
    },
    confirmLegacy: async (legacyJobs, discovered) => {
      assert.deepEqual(legacyJobs, ["source-legacy-1"]);
      assert.strictEqual(discovered, initial);
      legacyJobs.push("source-not-approved-1");
      return true;
    },
  });

  assert.deepEqual(starts, [
    { includeLegacy: false, legacyJobs: [] },
    { includeLegacy: true, legacyJobs: ["source-legacy-1"] },
  ]);
  assert.deepEqual(result, {
    removedJobs: ["source-expired-1", "source-legacy-1"],
    removedEntries: ["expired-import.part", "hls:source-legacy-1"],
    bytes: 50,
    legacyJobs: ["source-new-1"],
    legacyDownloads: [{ id: "source-new-1", label: "New candidate" }],
  });
  assert.deepEqual(mergeCleanupResults(initial, confirmed), result);
  assert.equal(
    summarizeCleanupResult(result).message,
    "Cleanup complete — removed 2 downloads and 2 expired items; freed 50 B; kept 1 older download"
  );
});

test("desktop cleanup reports what was actually removed", () => {
  assert.deepEqual(
    summarizeCleanupResult({
      removedJobs: ["source-old-1234"],
      removedEntries: ["cache:source-old-1234", "expired-import.part"],
      bytes: 1_572_864,
    }),
    {
      removedDownloads: 1,
      removedEntries: 2,
      removedItems: 3,
      bytes: 1_572_864,
      message: "Cleanup complete — removed 1 download and 2 expired items; freed 1.5 MB",
    }
  );
  assert.deepEqual(
    summarizeCleanupResult({ removedJobs: [], removedEntries: [], bytes: 0 }),
    {
      removedDownloads: 0,
      removedEntries: 0,
      removedItems: 0,
      bytes: 0,
      message: "Cleanup complete — nothing eligible",
    }
  );
  assert.throws(
    () => summarizeCleanupResult({ removedJobs: [], bytes: 0 }),
    /invalid cleanup result/
  );
});

test("desktop throttles failed storage scans without suppressing forced refreshes", () => {
  assert.equal(shouldRefreshStorage({ now: 1_000 }), true);
  assert.equal(shouldRefreshStorage({ now: 10_000, lastAttemptAt: 1_000 }), false);
  assert.equal(
    shouldRefreshStorage({ now: 61_000, lastAttemptAt: 1_000, hasStorage: false }),
    true
  );
  assert.equal(
    shouldRefreshStorage({
      now: 70_000,
      hasStorage: true,
      lastSuccessfulAt: 60_000,
      lastAttemptAt: 60_000,
    }),
    false
  );
  assert.equal(
    shouldRefreshStorage({
      force: true,
      now: 70_000,
      hasStorage: true,
      lastSuccessfulAt: 60_000,
      lastAttemptAt: 69_999,
    }),
    true
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

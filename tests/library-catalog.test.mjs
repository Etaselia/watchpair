import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLibraryCatalog } from "../agent/library-catalog.mjs";

async function scan(catalog) {
  const started = catalog.startScan();
  assert.equal((await started.completion).status, "complete");
}

test("catalog collapses overlapping roots and keeps stable opaque ids", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-"));
  const root = path.join(temporary, "library");
  const show = path.join(root, "Example Show");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(show, { recursive: true });
  await writeFile(path.join(show, "S01E01.mkv"), Buffer.alloc(17));

  try {
    const catalog = createLibraryCatalog({ roots: [root, show], catalogPath });
    await catalog.load();
    const firstScan = catalog.startScan();
    const joinedScan = catalog.startScan();
    assert.equal(firstScan.started, true);
    assert.equal(joinedScan.started, false);
    assert.equal(joinedScan.operation.id, firstScan.operation.id);
    assert.equal((await firstScan.completion).status, "complete");

    const first = catalog.list({ limit: 100 });
    assert.equal(first.total, 1);
    assert.equal(first.collections[0].itemCount, 1);
    assert.equal(first.collections[0].name, "Example Show",
      "the broadest overlapping root preserves the top-level show boundary");
    const detail = catalog.getCollection(first.collections[0].id);
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].name, "S01E01.mkv");
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(temporary.replaceAll("\\", "\\\\")));

    const firstCollectionId = first.collections[0].id;
    const firstFileId = detail.files[0].id;
    await scan(catalog);
    assert.equal(catalog.list().collections[0].id, firstCollectionId);
    assert.equal(catalog.getCollection(firstCollectionId).files[0].id, firstFileId);

    const reloaded = createLibraryCatalog({ roots: [root, show], catalogPath });
    await reloaded.load();
    assert.equal(reloaded.list().collections[0].id, firstCollectionId);
    assert.equal(reloaded.getCollection(firstCollectionId).files[0].id, firstFileId);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("catalog refuses a filesystem root without replacing its last-good data", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-root-"));
  const libraryRoot = path.join(temporary, "library");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(libraryRoot);
  await writeFile(path.join(libraryRoot, "movie.mp4"), Buffer.alloc(3));
  let roots = [libraryRoot];

  try {
    const catalog = createLibraryCatalog({ roots: () => roots, catalogPath });
    await catalog.load();
    await scan(catalog);
    const lastGood = catalog.listFiles();
    roots = [path.parse(path.resolve(libraryRoot)).root];
    const unsafe = catalog.startScan();
    const status = await unsafe.completion;
    assert.equal(status.status, "error");
    assert.equal(status.failedRoots, 1);
    assert.deepEqual(catalog.listFiles(), lastGood);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("catalog groups infohash aliases, persists pins, and supports safe matching", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-managed-library-"));
  const root = path.join(temporary, "downloads");
  const firstRoot = path.join(root, "source-first");
  const secondRoot = path.join(root, "source-second");
  const catalogPath = path.join(root, ".watchpair-library.json");
  const infoHash = "0123456789abcdef0123456789abcdef01234567";
  const fingerprint = "a".repeat(32);
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const firstFile = path.join(firstRoot, "Show.S01E01.mkv");
  const secondFile = path.join(secondRoot, "Show.S01E01.mkv");
  await writeFile(firstFile, Buffer.alloc(23));
  await writeFile(secondFile, Buffer.alloc(23));
  const pinCalls = [];
  const jobs = [
    {
      id: "source-first",
      label: "Show season 1",
      root: firstRoot,
      identity: infoHash,
      files: [{ path: firstFile, fingerprint, infoHash, fileIndex: 0, usable: true }],
    },
    {
      id: "source-second",
      label: "Show season 1 alias",
      root: secondRoot,
      identity: infoHash,
      files: [{ path: secondFile, infoHash, fileIndex: 0, usable: true }],
    },
  ];

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      getManagedJobs: () => jobs,
      onSetManagedPins: async (jobIds, pinned) => pinCalls.push({ jobIds, pinned }),
    });
    await catalog.load();
    await scan(catalog);
    const listed = catalog.list();
    assert.equal(listed.total, 1, "same-infohash room aliases are one managed collection");
    assert.equal(listed.collections[0].itemCount, 1, "same torrent file aliases collapse logically");
    const detail = catalog.getCollection(listed.collections[0].id);
    assert.equal(detail.files[0].copyCount, 2, "physical redundancy remains visible as a count");
    assert.equal(detail.files.every((file) => file.infoHash === infoHash), true);
    assert.equal(detail.files.every((file) => file.torrentFileIndex === 0), true);
    assert.equal(catalog.matchFile(fingerprint, 23)?.id, detail.files[0].id);
    assert.ok(catalog.matchTorrent(infoHash, { fileIndex: 0, size: 23 }));

    const pinned = await catalog.setPinned(listed.collections[0].id, true);
    assert.equal(pinned.pinned, true);
    assert.deepEqual(Array.from(catalog.pinnedContentKeys()), [`${fingerprint}-23`]);
    assert.equal(catalog.isContentKeyPinned(`${fingerprint}-23`), true);
    assert.deepEqual(pinCalls, [{ jobIds: ["source-first", "source-second"], pinned: true }]);

    const thirdRoot = path.join(root, "source-third");
    const thirdFile = path.join(thirdRoot, "Show.S01E01.mkv");
    await mkdir(thirdRoot);
    await writeFile(thirdFile, Buffer.alloc(23));
    jobs.push({
      id: "source-third",
      label: "Late alias",
      root: thirdRoot,
      identity: infoHash,
      files: [{ path: thirdFile, infoHash, fileIndex: 0, usable: true }],
    });
    await scan(catalog);
    assert.deepEqual(pinCalls.at(-1), {
      jobIds: ["source-first", "source-second", "source-third"],
      pinned: true,
    }, "a late alias is reconciled into the protected managed collection");
    assert.equal(catalog.getCollection(listed.collections[0].id).files[0].copyCount, 3);

    const reloaded = createLibraryCatalog({ roots: [root], catalogPath });
    await reloaded.load();
    assert.equal(reloaded.getCollection(listed.collections[0].id).pinned, true);
    assert.equal(reloaded.isManagedJobPinned("source-first"), true);
    assert.equal(reloaded.isManagedJobPinned("source-second"), true);
    assert.equal(reloaded.isContentKeyPinned(`${fingerprint}-23`), true);
    assert.doesNotMatch(JSON.stringify(reloaded.list()), /downloads[\\/]/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("catalog fingerprints and collapses separate physical library copies", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-copies-"));
  const firstRoot = path.join(temporary, "first");
  const secondRoot = path.join(temporary, "second");
  const firstShow = path.join(firstRoot, "Example Show");
  const secondShow = path.join(secondRoot, "Backup Show");
  const otherShow = path.join(firstRoot, "Different Show");
  const catalogPath = path.join(temporary, "catalog.json");
  const firstEpisode = Buffer.alloc(37, 0x11);
  const secondEpisode = Buffer.alloc(41, 0x22);
  await mkdir(firstShow, { recursive: true });
  await mkdir(secondShow, { recursive: true });
  await mkdir(otherShow, { recursive: true });
  for (const show of [firstShow, secondShow]) {
    await writeFile(path.join(show, "S01E01.mkv"), firstEpisode);
    await writeFile(path.join(show, "S01E02.mkv"), secondEpisode);
  }
  await writeFile(path.join(otherShow, "Movie.mp4"), Buffer.alloc(43, 0x33));
  await new Promise((resolve) => setTimeout(resolve, 10));

  try {
    const catalog = createLibraryCatalog({ roots: [firstRoot, secondRoot], catalogPath });
    await catalog.load();
    await scan(catalog);
    const listed = catalog.list({ limit: 100 });
    assert.equal(listed.total, 2, "the backup folder is an alias, not another show");
    const copied = listed.collections.find((collection) => collection.itemCount === 2);
    assert.ok(copied);
    const detail = catalog.getCollection(copied.id);
    assert.deepEqual(detail.files.map((file) => file.copyCount), [2, 2]);
    assert.equal(detail.files.every((file) => /^[a-f0-9]{32}$/.test(file.fingerprint)), true);
    assert.equal(listed.collections.find((collection) => collection.itemCount === 1).name,
      "Different Show", "different content remains a separate collection");
    assert.doesNotMatch(JSON.stringify(detail), /first|second|watchpair-library-copies/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a previously merged collection can split without reusing collection or file ids", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-split-"));
  const root = path.join(temporary, "library");
  const first = path.join(root, "First Copy");
  const second = path.join(root, "Second Copy");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  for (const directory of [first, second]) {
    await writeFile(path.join(directory, "E1.mp4"), Buffer.alloc(11, 0x11));
    await writeFile(path.join(directory, "E2.mp4"), Buffer.alloc(13, 0x22));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    const catalog = createLibraryCatalog({ roots: [root], catalogPath });
    await catalog.load();
    await scan(catalog);
    assert.equal(catalog.list().total, 1);

    const thirdEpisode = path.join(second, "E3.mp4");
    await writeFile(thirdEpisode, Buffer.alloc(17, 0x33));
    await rm(path.join(second, "E2.mp4"));
    await stat(thirdEpisode);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await scan(catalog);
    const collections = catalog.list({ limit: 100 }).collections;
    assert.equal(collections.length, 2);
    assert.equal(new Set(collections.map((collection) => collection.id)).size, 2);
    const files = collections.flatMap((collection) => catalog.getCollection(collection.id).files);
    assert.equal(files.length, 4, "both divergent copies retain their complete logical contents");
    assert.equal(new Set(files.map((file) => file.id)).size, 4,
      "overlapping episodes never alias a preview id across split collections");
    assert.deepEqual(files.map((file) => file.name).sort(), ["E1.mp4", "E1.mp4", "E2.mp4", "E3.mp4"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cleanup readiness waits for a complete first scan and exposes incremental progress", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-readiness-"));
  const root = path.join(temporary, "library");
  const catalogPath = path.join(temporary, "catalog.json");
  let releaseSecond;
  let secondStartedResolve;
  const secondStarted = new Promise((resolve) => { secondStartedResolve = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  let fingerprints = 0;
  await mkdir(root);
  await writeFile(path.join(root, "first.mp4"), Buffer.alloc(3, 0x11));
  await writeFile(path.join(root, "second.mp4"), Buffer.alloc(5, 0x22));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      async fingerprintFile() {
        fingerprints += 1;
        if (fingerprints === 2) {
          secondStartedResolve();
          await secondGate;
        }
        return String(fingerprints).padStart(32, "0");
      },
    });
    await catalog.load();
    assert.equal(catalog.readyForCleanup(), false);
    const scanning = catalog.startScan();
    await secondStarted;
    assert.equal(catalog.readyForCleanup(), false,
      "cleanup must not trust a partially built first catalog");
    assert.equal(catalog.scanStatus().scannedFiles, 1);
    releaseSecond();
    assert.equal((await scanning.completion).status, "complete");
    assert.equal(catalog.readyForCleanup(), true);
    assert.equal(catalog.scanStatus().scannedFiles, 2);
  } finally {
    releaseSecond?.();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("failed root refresh retains the last-good catalog", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-last-good-"));
  const root = path.join(temporary, "library");
  const missing = path.join(temporary, "missing");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(root);
  await writeFile(path.join(root, "movie.mp4"), Buffer.alloc(9));
  let roots = [root];

  try {
    const catalog = createLibraryCatalog({ roots: () => roots, catalogPath });
    await catalog.load();
    await scan(catalog);
    const lastGood = catalog.list().collections;
    roots = [root, missing];
    const failed = catalog.startScan();
    const status = await failed.completion;
    assert.equal(status.status, "error");
    assert.equal(status.failedRoots, 1);
    assert.deepEqual(catalog.list().collections, lastGood);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("replacing a file at the same path invalidates its cached strong identity", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-replace-"));
  const root = path.join(temporary, "library");
  const filePath = path.join(root, "movie.mp4");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(root);
  await writeFile(filePath, Buffer.alloc(20, 0x11));

  try {
    const catalog = createLibraryCatalog({ roots: [root], catalogPath });
    await catalog.load();
    await scan(catalog);
    const file = catalog.listFiles()[0];
    assert.equal(await catalog.setFileFingerprint(file.id, "b".repeat(32), 20), true);
    assert.ok(catalog.matchFile("b".repeat(32), 20));

    await writeFile(filePath, Buffer.alloc(20, 0x22));
    const changed = new Date(Date.now() + 2_000);
    await utimes(filePath, changed, changed);
    await scan(catalog);
    assert.notEqual(catalog.listFiles()[0].fingerprint, "b".repeat(32));
    assert.equal(catalog.matchFile("b".repeat(32), 20), null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("managed partial files are catalogued but never advertised as usable matches", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-partial-"));
  const root = path.join(temporary, "downloads");
  const jobRoot = path.join(root, "partial-source");
  const filePath = path.join(jobRoot, "Episode.mkv");
  const catalogPath = path.join(root, ".watchpair-library.json");
  const infoHash = "1234567890abcdef1234567890abcdef12345678";
  await mkdir(jobRoot, { recursive: true });
  await writeFile(filePath, Buffer.alloc(100));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      getManagedJobs: () => [{
        id: "partial-source",
        label: "Partial show",
        root: jobRoot,
        identity: infoHash,
        files: [{ path: filePath, infoHash, fileIndex: 0, usable: false }],
      }],
    });
    await catalog.load();
    await scan(catalog);
    const file = catalog.listFiles()[0];
    assert.equal(file.managed, true);
    assert.equal(file.usable, false);
    assert.equal(file.infoHash, null);
    assert.equal(catalog.matchTorrent(infoHash, { fileIndex: 0, size: 100 }), null);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("unreadable nested directories and scan limits preserve the last-good catalog", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-partial-scan-"));
  const root = path.join(temporary, "library");
  const blocked = path.join(root, "blocked");
  const catalogPath = path.join(temporary, "catalog.json");
  let failBlocked = false;
  await mkdir(blocked, { recursive: true });
  await writeFile(path.join(root, "first.mp4"), Buffer.alloc(1));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      maxFiles: 1,
      readDirectory: (directory, options) => {
        if (failBlocked && path.resolve(directory) === path.resolve(blocked)) {
          const error = new Error("permission denied");
          error.code = "EACCES";
          return Promise.reject(error);
        }
        return readdir(directory, options);
      },
    });
    await catalog.load();
    await scan(catalog);
    const lastGood = catalog.listFiles();

    failBlocked = true;
    let failed = catalog.startScan();
    assert.equal((await failed.completion).status, "error");
    assert.deepEqual(catalog.listFiles(), lastGood);

    failBlocked = false;
    await writeFile(path.join(root, "second.mp4"), Buffer.alloc(1));
    failed = catalog.startScan();
    const limited = await failed.completion;
    assert.equal(limited.status, "error");
    assert.equal(limited.truncated, true);
    assert.deepEqual(catalog.listFiles(), lastGood);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("depth-limited scans report truncation and preserve the persisted catalog", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-depth-"));
  const root = path.join(temporary, "library");
  const deep = path.join(root, "Show", "Season 1");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, "Episode.mp4"), Buffer.alloc(2));

  try {
    const completeCatalog = createLibraryCatalog({ roots: [root], catalogPath, maxDepth: 4 });
    await completeCatalog.load();
    await scan(completeCatalog);
    const lastGood = completeCatalog.listFiles();

    const limitedCatalog = createLibraryCatalog({ roots: [root], catalogPath, maxDepth: 1 });
    await limitedCatalog.load();
    const limited = limitedCatalog.startScan();
    const status = await limited.completion;
    assert.equal(status.status, "error");
    assert.equal(status.truncated, true);
    assert.deepEqual(limitedCatalog.listFiles(), lastGood);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("file inspection failures make a scan incomplete instead of dropping known files", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-file-error-"));
  const root = path.join(temporary, "library");
  const filePath = path.join(root, "movie.mp4");
  const catalogPath = path.join(temporary, "catalog.json");
  let inspectionFails = false;
  await mkdir(root);
  await writeFile(filePath, Buffer.alloc(6));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      inspectPath: async (target) => {
        if (inspectionFails && path.resolve(target) === path.resolve(filePath)) {
          const error = new Error("disk unavailable");
          error.code = "EIO";
          throw error;
        }
        return stat(target);
      },
    });
    await catalog.load();
    await scan(catalog);
    const lastGood = catalog.listFiles();
    inspectionFails = true;
    const failed = catalog.startScan();
    const status = await failed.completion;
    assert.equal(status.status, "error");
    assert.equal(status.failedRoots, 1);
    assert.deepEqual(catalog.listFiles(), lastGood);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("pin persistence is serialized with an in-flight catalog scan", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-pin-scan-"));
  const root = path.join(temporary, "library");
  const catalogPath = path.join(temporary, "catalog.json");
  let gate = null;
  await mkdir(root);
  await writeFile(path.join(root, "movie.mp4"), Buffer.alloc(4));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      async readDirectory(directory, options) {
        if (gate && path.resolve(directory) === path.resolve(root)) await gate.promise;
        return readdir(directory, options);
      },
    });
    await catalog.load();
    await scan(catalog);
    const collectionId = catalog.list().collections[0].id;
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const refreshing = catalog.startScan();
    await new Promise((resolve) => setImmediate(resolve));
    const pinning = catalog.setPinned(collectionId, true);
    release();
    await Promise.all([refreshing.completion, pinning]);
    assert.equal(catalog.getCollection(collectionId).pinned, true);

    const reloaded = createLibraryCatalog({ roots: [root], catalogPath });
    await reloaded.load();
    assert.equal(reloaded.getCollection(collectionId).pinned, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a pin completing after a scan updates the current collection instance", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-pin-replace-"));
  const root = path.join(temporary, "library");
  const catalogPath = path.join(temporary, "catalog.json");
  let callbackGate = null;
  await mkdir(root);
  await writeFile(path.join(root, "movie.mp4"), Buffer.alloc(4));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      onSetManagedPins: async () => {
        if (callbackGate) await callbackGate.promise;
      },
    });
    await catalog.load();
    await scan(catalog);
    const collectionId = catalog.list().collections[0].id;
    let release;
    callbackGate = { promise: new Promise((resolve) => { release = resolve; }) };
    const pinning = catalog.setPinned(collectionId, true);
    await new Promise((resolve) => setImmediate(resolve));
    const refreshing = catalog.startScan();
    release();
    await Promise.all([pinning, refreshing.completion]);
    assert.equal(catalog.getCollection(collectionId).pinned, true);
    assert.equal(catalog.pinnedContentKeys().size, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an unpin queued behind scan reconciliation wins after the scan commits", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-unpin-race-"));
  const root = path.join(temporary, "downloads");
  const jobRoot = path.join(root, "managed-source");
  const filePath = path.join(jobRoot, "movie.mp4");
  const catalogPath = path.join(root, ".watchpair-library.json");
  const job = {
    id: "managed-source",
    label: "Managed movie",
    root: jobRoot,
    identity: "9".repeat(40),
    pinned: true,
    files: [{
      path: filePath,
      fingerprint: "8".repeat(32),
      infoHash: "9".repeat(40),
      fileIndex: 0,
      usable: true,
    }],
  };
  let callbackGate = null;
  let callbackStartedResolve;
  await mkdir(jobRoot, { recursive: true });
  await writeFile(filePath, Buffer.alloc(7));

  try {
    const catalog = createLibraryCatalog({
      roots: [root],
      catalogPath,
      getManagedJobs: () => [job],
      async onSetManagedPins(jobIds, pinned) {
        if (jobIds.includes(job.id)) job.pinned = pinned;
        if (callbackGate && pinned) {
          callbackStartedResolve();
          await callbackGate;
        }
      },
    });
    await catalog.load();
    await scan(catalog);
    const collectionId = catalog.list().collections[0].id;
    let release;
    callbackGate = new Promise((resolve) => { release = resolve; });
    const callbackStarted = new Promise((resolve) => { callbackStartedResolve = resolve; });
    const refreshing = catalog.startScan();
    await callbackStarted;
    const unpinning = catalog.setPinned(collectionId, false);
    release();
    await Promise.all([refreshing.completion, unpinning]);
    assert.equal(job.pinned, false);
    assert.equal(catalog.getCollection(collectionId).pinned, false);
    assert.equal(catalog.pinnedContentKeys().size, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("catalog does not follow directory symlinks outside a library root", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "watchpair-library-link-"));
  const root = path.join(temporary, "library");
  const external = path.join(temporary, "external");
  const catalogPath = path.join(temporary, "catalog.json");
  await mkdir(root);
  await mkdir(external);
  await writeFile(path.join(root, "inside.mp4"), Buffer.alloc(5));
  await writeFile(path.join(external, "outside.mp4"), Buffer.alloc(7));
  try {
    await symlink(external, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(error?.code)) {
      context.skip(`directory links unavailable: ${error.code}`);
      await rm(temporary, { recursive: true, force: true });
      return;
    }
    throw error;
  }

  try {
    const catalog = createLibraryCatalog({ roots: [root], catalogPath });
    await catalog.load();
    await scan(catalog);
    assert.deepEqual(catalog.listFiles().map((file) => file.name), ["inside.mp4"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

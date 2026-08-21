import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fingerprintPath } from "./media-fingerprint.mjs";

export const LIBRARY_CATALOG_VERSION = 1;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_FINGERPRINT_CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function opaqueId(salt, kind, value) {
  return createHash("sha256")
    .update(String(salt))
    .update("\0")
    .update(kind)
    .update("\0")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function publicFile(file) {
  return {
    id: file.id,
    collectionId: file.collectionId,
    name: file.name,
    relativePath: file.relativePath,
    size: file.size,
    modifiedAt: file.modifiedAt,
    managed: file.managed,
    fingerprint: file.fingerprint || null,
    infoHash: file.infoHash || null,
    torrentFileIndex: Number.isInteger(file.torrentFileIndex) ? file.torrentFileIndex : null,
    usable: file.usable !== false,
    copyCount: Math.max(1, Number(file.copyCount) || file.copies?.length || 1),
  };
}

function publicCollection(collection, { includeFiles = false } = {}) {
  const result = {
    id: collection.id,
    name: collection.name,
    pinned: collection.pinned,
    managed: collection.managed,
    itemCount: collection.files.length,
    size: collection.size,
    updatedAt: collection.updatedAt,
    previewFileId: collection.files[0]?.id || null,
  };
  if (includeFiles) result.files = collection.files.map(publicFile);
  return result;
}

function safePersistedFile(value) {
  if (!value || typeof value !== "object" || typeof value.path !== "string") return null;
  if (!/^[a-f0-9]{24}$/.test(String(value.id || ""))) return null;
  if (!/^[a-f0-9]{24}$/.test(String(value.collectionId || ""))) return null;
  const primaryPath = path.resolve(value.path);
  const copies = (Array.isArray(value.copies) ? value.copies : [])
    .filter((copy) => copy && typeof copy.path === "string")
    .map((copy) => ({
      path: path.resolve(copy.path),
      physicalKey: String(copy.physicalKey || normalizedPath(copy.path)),
      size: Math.max(0, Number(copy.size) || 0),
      modifiedAt: Math.max(0, Number(copy.modifiedAt) || 0),
    }));
  if (!copies.some((copy) => normalizedPath(copy.path) === normalizedPath(primaryPath))) {
    copies.unshift({
      path: primaryPath,
      physicalKey: String(value.physicalKey || normalizedPath(primaryPath)),
      size: Math.max(0, Number(value.size) || 0),
      modifiedAt: Math.max(0, Number(value.modifiedAt) || 0),
    });
  }
  return {
    id: value.id,
    collectionId: value.collectionId,
    name: String(value.name || path.basename(value.path)).slice(0, 300),
    relativePath: String(value.relativePath || value.name || path.basename(value.path)).slice(0, 1_000),
    size: Math.max(0, Number(value.size) || 0),
    modifiedAt: Math.max(0, Number(value.modifiedAt) || 0),
    managed: Boolean(value.managed),
    fingerprint: /^[a-f0-9]{16,128}$/i.test(String(value.fingerprint || ""))
      ? String(value.fingerprint).toLowerCase()
      : null,
    infoHash: /^[a-f0-9]{40}$/i.test(String(value.infoHash || ""))
      ? String(value.infoHash).toLowerCase()
      : null,
    torrentFileIndex: Number.isInteger(value.torrentFileIndex) && value.torrentFileIndex >= 0
      ? value.torrentFileIndex
      : null,
    usable: value.managed ? value.usable === true : value.usable !== false,
    path: primaryPath,
    physicalKey: String(value.physicalKey || normalizedPath(value.path)),
    copies,
    copyCount: Math.max(1, copies.length),
  };
}

function safePersistedCollection(value, filesById, pins) {
  if (!value || typeof value !== "object" || !/^[a-f0-9]{24}$/.test(String(value.id || ""))) {
    return null;
  }
  const files = Array.isArray(value.fileIds)
    ? value.fileIds.map((id) => filesById.get(String(id))).filter(Boolean)
    : [];
  if (!files.length) return null;
  return {
    id: value.id,
    name: String(value.name || "Library item").slice(0, 300),
    pinned: pins.has(value.id),
    managed: Boolean(value.managed),
    managedJobIds: Array.isArray(value.managedJobIds)
      ? value.managedJobIds.map(String).filter((id) => /^[a-zA-Z0-9-]{8,80}$/.test(id))
      : [],
    size: files.reduce((total, file) => total + file.size, 0),
    updatedAt: files.reduce((latest, file) => Math.max(latest, file.modifiedAt), 0),
    files,
  };
}

async function writeCatalog(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, filePath);
}

async function inspectFilesystemPath(target) {
  const info = await stat(target, { bigint: true });
  return {
    dev: info.dev,
    ino: info.ino,
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    isFile: () => info.isFile(),
  };
}

function physicalFileKey(info, resolved) {
  if (
    typeof info?.dev === "bigint" &&
    typeof info?.ino === "bigint" &&
    info.ino !== 0n
  ) {
    return `${info.dev}:${info.ino}`;
  }
  if (Number.isSafeInteger(info?.dev) && Number.isSafeInteger(info?.ino) && info.ino !== 0) {
    return `${info.dev}:${info.ino}`;
  }
  return normalizedPath(resolved);
}

export function createLibraryCatalog({
  roots,
  catalogPath,
  videoPattern = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i,
  getManagedJobs = () => [],
  onSetManagedPins = async () => {},
  maxDepth = DEFAULT_MAX_DEPTH,
  maxFiles = DEFAULT_MAX_FILES,
  fingerprintConcurrency = DEFAULT_FINGERPRINT_CONCURRENCY,
  readDirectory = readdir,
  resolvePath = realpath,
  inspectPath = inspectFilesystemPath,
  fingerprintFile = fingerprintPath,
  now = Date.now,
} = {}) {
  if (!catalogPath) throw new TypeError("A library catalog path is required.");
  let salt = randomUUID();
  let pins = new Set();
  let filesById = new Map();
  let collectionsById = new Map();
  let managedCollectionByJobId = new Map();
  let activeScan = null;
  let latestScan = null;
  let lastSuccessfulScanAt = null;
  let persistChain = Promise.resolve();
  let mutationChain = Promise.resolve();
  const scans = new Map();

  async function withCatalogMutation(operation) {
    const previous = mutationChain;
    let release;
    mutationChain = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  const managedCollectionId = (identity) => opaqueId(salt, "collection", `managed:${identity}`);

  function scanSnapshot(record = latestScan) {
    return record
      ? {
          id: record.id,
          status: record.status,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          scannedFiles: record.scannedFiles,
          failedRoots: record.failedRoots,
          truncated: Boolean(record.truncated),
          error: record.error,
        }
      : {
          id: null,
          status: "idle",
          startedAt: null,
          finishedAt: null,
          scannedFiles: filesById.size,
          failedRoots: 0,
          truncated: false,
          error: null,
        };
  }

  function persistedValue() {
    return {
      version: LIBRARY_CATALOG_VERSION,
      salt,
      pins: Array.from(pins).sort(),
      files: Array.from(filesById.values()).map((file) => ({ ...file })),
      collections: Array.from(collectionsById.values()).map((collection) => ({
        id: collection.id,
        name: collection.name,
        managed: collection.managed,
        managedJobIds: collection.managedJobIds,
        fileIds: collection.files.map((file) => file.id),
      })),
      scannedAt: latestScan?.finishedAt || null,
    };
  }

  async function persist() {
    const value = persistedValue();
    persistChain = persistChain
      .catch(() => {})
      .then(() => writeCatalog(catalogPath, value));
    await persistChain;
  }

  async function load() {
    let value;
    try {
      value = JSON.parse(await readFile(catalogPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await persist();
      return;
    }
    if (!value || Number(value.version) !== LIBRARY_CATALOG_VERSION) return;
    if (typeof value.salt === "string" && value.salt.length >= 16) salt = value.salt;
    pins = new Set(Array.isArray(value.pins)
      ? value.pins.map(String).filter((id) => /^[a-f0-9]{24}$/.test(id))
      : []);
    const loadedFiles = new Map();
    for (const valueFile of Array.isArray(value.files) ? value.files : []) {
      const file = safePersistedFile(valueFile);
      if (file) loadedFiles.set(file.id, file);
    }
    const loadedCollections = new Map();
    for (const valueCollection of Array.isArray(value.collections) ? value.collections : []) {
      const collection = safePersistedCollection(valueCollection, loadedFiles, pins);
      if (collection) loadedCollections.set(collection.id, collection);
    }
    filesById = loadedFiles;
    collectionsById = loadedCollections;
    managedCollectionByJobId = new Map(Array.from(loadedCollections.values())
      .flatMap((collection) => collection.managedJobIds.map((jobId) => [jobId, collection.id])));
    if (Number.isFinite(Number(value.scannedAt))) {
      lastSuccessfulScanAt = Number(value.scannedAt);
      latestScan = {
        id: null,
        status: "complete",
        startedAt: Number(value.scannedAt),
        finishedAt: Number(value.scannedAt),
        scannedFiles: filesById.size,
        failedRoots: 0,
        truncated: false,
        error: null,
      };
    }
  }

  async function canonicalRoots() {
    const unique = new Map();
    let failedRoots = 0;
    for (const configured of typeof roots === "function" ? roots() : roots || []) {
      const root = await resolvePath(path.resolve(configured)).catch(() => null);
      if (!root) {
        failedRoots += 1;
        continue;
      }
      if (normalizedPath(root) === normalizedPath(path.parse(root).root)) {
        failedRoots += 1;
        continue;
      }
      unique.set(normalizedPath(root), root);
    }
    const broadest = [];
    for (const root of Array.from(unique.values()).sort((left, right) =>
      left.length - right.length || normalizedPath(left).localeCompare(normalizedPath(right)))) {
      if (broadest.some((parent) => isWithin(normalizedPath(parent), normalizedPath(root)))) continue;
      broadest.push(root);
    }
    if (!broadest.length && failedRoots === 0) failedRoots = 1;
    return {
      failedRoots,
      roots: broadest,
    };
  }

  async function performScan(record) {
    const managedJobs = (await Promise.resolve(getManagedJobs()))
      .filter((job) => job && /^[a-zA-Z0-9-]{8,80}$/.test(String(job.id || "")))
      .map((job) => ({
        id: String(job.id),
        label: String(job.label || "Managed download").slice(0, 300),
        pinned: Boolean(job.pinned),
        identity: String(job.identity || job.id).toLowerCase(),
        root: normalizedPath(job.root),
        knownFiles: new Map((Array.isArray(job.files) ? job.files : [])
          .filter((file) => file?.path)
          .map((file) => [normalizedPath(file.path), {
            fingerprint: /^[a-f0-9]{16,128}$/i.test(String(file.fingerprint || ""))
              ? String(file.fingerprint).toLowerCase()
              : null,
            infoHash: /^[a-f0-9]{40}$/i.test(String(file.infoHash || ""))
              ? String(file.infoHash).toLowerCase()
              : null,
            fileIndex: Number.isInteger(file.fileIndex) && file.fileIndex >= 0
              ? file.fileIndex
              : null,
            usable: file.usable === true,
          }])),
      }))
      .sort((left, right) => right.root.length - left.root.length);
    const scanPins = new Set(pins);
    const managedCollectionIds = new Map();
    for (const job of managedJobs) {
      const existingId = managedCollectionByJobId.get(job.id);
      if (existingId && !managedCollectionIds.has(job.identity)) {
        managedCollectionIds.set(job.identity, existingId);
      }
    }
    for (const job of managedJobs) {
      const id = managedCollectionIds.get(job.identity) || managedCollectionId(job.identity);
      managedCollectionIds.set(job.identity, id);
    }

    const rootResult = await canonicalRoots();
    record.failedRoots = rootResult.failedRoots;
    if (record.failedRoots) {
      throw new Error(`${record.failedRoots} library folder${record.failedRoots === 1 ? "" : "s"} could not be scanned; the previous catalog was kept.`);
    }
    const nextFilesByPhysicalKey = new Map();
    record.scannedFiles = 0;
    const collectionSeeds = new Map();
    const previousByPath = new Map();
    for (const previousFile of filesById.values()) {
      for (const copy of previousFile.copies || [{
        path: previousFile.path,
        physicalKey: previousFile.physicalKey,
        size: previousFile.size,
        modifiedAt: previousFile.modifiedAt,
      }]) {
        previousByPath.set(normalizedPath(copy.path), { file: previousFile, copy });
      }
    }
    const maxDepthValue = clampInteger(maxDepth, DEFAULT_MAX_DEPTH, 1, 64);
    const maxFilesValue = clampInteger(maxFiles, DEFAULT_MAX_FILES, 1, 1_000_000);
    const fingerprintConcurrencyValue = clampInteger(
      fingerprintConcurrency, DEFAULT_FINGERPRINT_CONCURRENCY, 1, 16);

    // External files whose cached identity is stale are fingerprinted by a small
    // worker pool after the directory walk, so a large first scan or a batch of
    // new files does not serialize one multi-hundred-megabyte read after another.
    const fingerprintTasks = [];
    const deferredPhysicalKeys = new Set();
    let collectedCount = 0;

    const buildFile = (pending) => {
      const known = pending.known;
      const managed = pending.managed;
      const mayReusePreviousIdentity = pending.mayReusePreviousIdentity;
      const previous = pending.previous;
      return {
        id: pending.fileId,
        priorLogicalId: previous?.id || null,
        collectionId: pending.collectionId,
        name: pending.name,
        relativePath: pending.relativePath,
        size: pending.info.size,
        modifiedAt: pending.modifiedAt,
        managed: Boolean(managed),
        fingerprint: known?.usable
          ? known.fingerprint
          : managed ? (mayReusePreviousIdentity ? previous.fingerprint : null) : pending.externalFingerprint,
        infoHash: known?.usable
          ? known.infoHash
          : mayReusePreviousIdentity ? previous.infoHash : null,
        torrentFileIndex: known?.usable
          ? known.fileIndex
          : mayReusePreviousIdentity ? previous.torrentFileIndex : null,
        usable: managed
          ? Boolean(known?.usable === true ||
              (mayReusePreviousIdentity && previous.usable === true))
          : true,
        path: pending.resolved,
        physicalKey: pending.physicalKey,
        copies: [{ path: pending.resolved, physicalKey: pending.physicalKey, size: pending.info.size, modifiedAt: pending.modifiedAt }],
        copyCount: 1,
      };
    };

    const registerFile = (file, pending) => {
      nextFilesByPhysicalKey.set(file.physicalKey, file);
      record.scannedFiles = nextFilesByPhysicalKey.size;
      const managed = pending.managed;
      let seed = collectionSeeds.get(pending.collectionId);
      if (!seed) {
        seed = {
          id: pending.collectionId,
          name: pending.collectionName,
          managed: Boolean(managed),
          managedJobIds: managed ? [managed.id] : [],
          files: [],
        };
        collectionSeeds.set(pending.collectionId, seed);
      } else if (managed && !seed.managedJobIds.includes(managed.id)) {
        seed.managedJobIds.push(managed.id);
      }
      seed.files.push(file);
    };

    rootLoop: for (const root of rootResult.roots) {
      const queue = [{ directory: root, depth: 0 }];
      let cursor = 0;
      while (cursor < queue.length) {
        const current = queue[cursor++];
        const entries = await readDirectory(current.directory, { withFileTypes: true }).catch(() => {
          record.failedRoots += 1;
          return [];
        });
        entries.sort((left, right) => left.name.localeCompare(right.name, "en", {
          numeric: true,
          sensitivity: "base",
        }));
        for (const entry of entries) {
          if (entry.name.startsWith(".watchpair")) continue;
          const candidate = path.join(current.directory, entry.name);
          if (entry.isDirectory()) {
            if (current.depth < maxDepthValue) {
              queue.push({ directory: candidate, depth: current.depth + 1 });
            } else {
              record.truncated = true;
              break rootLoop;
            }
            continue;
          }
          if (!entry.isFile() || !videoPattern.test(entry.name)) continue;
          const resolved = await resolvePath(candidate).catch((error) => {
            if (error?.code !== "ENOENT") record.failedRoots += 1;
            return null;
          });
          if (!resolved || !isWithin(root, resolved)) continue;
          const info = await inspectPath(resolved).catch((error) => {
            if (error?.code !== "ENOENT") record.failedRoots += 1;
            return null;
          });
          if (!info?.isFile()) continue;
          const physicalKey = physicalFileKey(info, resolved);
          if (nextFilesByPhysicalKey.has(physicalKey) || deferredPhysicalKeys.has(physicalKey)) continue;
          if (collectedCount >= maxFilesValue) {
            record.truncated = true;
            break rootLoop;
          }
          collectedCount += 1;

          const normalizedResolved = normalizedPath(resolved);
          const managed = managedJobs.find((job) => isWithin(job.root, normalizedResolved));
          const relativeToRoot = path.relative(root, resolved);
          const relativeParts = relativeToRoot.split(path.sep).filter(Boolean);
          const collectionBoundary = relativeParts.length > 1
            ? path.join(root, relativeParts[0])
            : resolved;
          const collectionKey = managed
            ? `managed:${managed.identity}`
            : `external:${normalizedPath(root)}:${normalizedPath(collectionBoundary)}`;
          const collectionId = managed
            ? managedCollectionIds.get(managed.identity)
            : opaqueId(salt, "collection", collectionKey);
          const collectionName = managed?.label || (relativeParts.length > 1
            ? relativeParts[0]
            : path.parse(entry.name).name);
          const known = managed?.knownFiles.get(normalizedResolved);
          const fileId = opaqueId(salt, "file", normalizedResolved);
          const previousMatch = previousByPath.get(normalizedResolved);
          const previous = previousMatch?.file;
          const previousCopy = previousMatch?.copy;
          const modifiedAt = Number(info.mtimeMs) || 0;
          const previousIdentityIsCurrent = previous &&
            previousCopy?.physicalKey === physicalKey &&
            previousCopy?.size === info.size &&
            previousCopy?.modifiedAt === modifiedAt;
          const mayReusePreviousIdentity = previousIdentityIsCurrent && known === undefined;
          const pending = {
            resolved,
            info,
            physicalKey,
            modifiedAt,
            managed,
            collectionId,
            collectionName,
            known,
            fileId,
            previous,
            mayReusePreviousIdentity,
            externalFingerprint: mayReusePreviousIdentity ? previous.fingerprint : null,
            name: entry.name,
            relativePath: managed
              ? path.relative(managed.root, resolved) || entry.name
              : relativeParts.join(path.sep) || entry.name,
          };
          if (!managed && !pending.externalFingerprint) {
            // Identity must be computed; defer to the bounded fingerprint pool.
            deferredPhysicalKeys.add(physicalKey);
            fingerprintTasks.push(pending);
            continue;
          }
          const file = buildFile(pending);
          registerFile(file, pending);
        }
      }
    }

    if (!record.truncated && fingerprintTasks.length) {
      let nextTask = 0;
      let fingerprintResolved = 0;
      const workers = Array.from({
        length: Math.min(fingerprintConcurrencyValue, fingerprintTasks.length),
      }, async () => {
        while (nextTask < fingerprintTasks.length) {
          const taskIndex = nextTask;
          nextTask += 1;
          const pending = fingerprintTasks[taskIndex];
          const fingerprintPromise = fingerprintFile(pending.resolved);
          // Surface fingerprint progress as soon as each hash settles, without
          // waiting for the post-hash verification stat, so scanStatus() is
          // monotonic while a scan is still running.
          fingerprintPromise.then(() => {
            fingerprintResolved += 1;
            record.scannedFiles = Math.max(record.scannedFiles, fingerprintResolved);
          }).catch(() => {});
          const fingerprint = await fingerprintPromise.catch((error) => {
            if (error?.code !== "ENOENT") record.failedRoots += 1;
            return null;
          });
          if (!fingerprint) {
            deferredPhysicalKeys.delete(pending.physicalKey);
            continue;
          }
          const checked = await inspectPath(pending.resolved).catch((error) => {
            if (error?.code !== "ENOENT") record.failedRoots += 1;
            return null;
          });
          const checkedPhysicalKey = physicalFileKey(checked, pending.resolved);
          if (
            !checked?.isFile() ||
            checkedPhysicalKey !== pending.physicalKey ||
            checked.size !== pending.info.size ||
            Number(checked.mtimeMs) !== pending.modifiedAt
          ) {
            record.failedRoots += 1;
            deferredPhysicalKeys.delete(pending.physicalKey);
            continue;
          }
          const file = buildFile({ ...pending, externalFingerprint: fingerprint });
          registerFile(file, pending);
        }
      });
      await Promise.all(workers);
    }

    if (record.failedRoots) {
      throw new Error(`${record.failedRoots} library folder${record.failedRoots === 1 ? "" : "s"} could not be scanned; the previous catalog was kept.`);
    }
    if (record.truncated) {
      throw new Error(`Library scan exceeded the ${maxFilesValue}-file safety limit; the previous catalog was kept.`);
    }

    const logicalFileKey = (file) => file.infoHash && Number.isInteger(file.torrentFileIndex)
      ? `torrent:${file.infoHash}:${file.torrentFileIndex}:${file.size}`
      : file.fingerprint
        ? `fingerprint:${file.fingerprint}:${file.size}`
        : `physical:${file.physicalKey}`;
    const collapseFiles = (files, collectionId, reservedIds = null) => {
      const grouped = new Map();
      for (const file of files) {
        const key = logicalFileKey(file);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(file);
      }
      return Array.from(grouped.values()).map((copies) => {
        const priorIds = copies.map((copy) => copy.priorLogicalId)
          .filter((id) => id && filesById.has(id))
          .sort();
        const candidates = [...priorIds, ...copies.map((copy) => copy.id).sort()];
        let selectedId = candidates.find((id) => !reservedIds?.has(id));
        if (!selectedId) {
          const baseKey = `${collectionId}\0${logicalFileKey(copies[0])}\0${copies
            .map((copy) => copy.physicalKey).sort().join("\0")}`;
          let suffix = 0;
          do {
            selectedId = opaqueId(salt, "file", `${baseKey}\0${suffix++}`);
          } while (reservedIds?.has(selectedId));
        }
        reservedIds?.add(selectedId);
        const primary = copies.find((copy) => copy.priorLogicalId === selectedId) ||
          copies.slice().sort((left, right) =>
            normalizedPath(left.path).localeCompare(normalizedPath(right.path)))[0];
        const physicalCopies = new Map();
        for (const copy of copies.flatMap((file) => file.copies || [])) {
          if (!physicalCopies.has(copy.physicalKey)) physicalCopies.set(copy.physicalKey, copy);
        }
        return {
          ...primary,
          id: selectedId,
          collectionId,
          copies: Array.from(physicalCopies.values()),
          copyCount: Math.max(1, physicalCopies.size),
        };
      });
    };

    const finalSeeds = [];
    const reservedCollectionIds = new Set();
    const externalGroups = new Map();
    for (const seed of collectionSeeds.values()) {
      if (seed.managed) {
        finalSeeds.push(seed);
        reservedCollectionIds.add(seed.id);
        continue;
      }
      const signature = collapseFiles(seed.files, seed.id)
        .map(logicalFileKey)
        .sort()
        .join("\0");
      if (!externalGroups.has(signature)) externalGroups.set(signature, []);
      externalGroups.get(signature).push(seed);
    }
    for (const [signature, seeds] of externalGroups) {
      const candidateIds = new Set(seeds.map((seed) => seed.id));
      for (const file of seeds.flatMap((seed) => seed.files)) {
        const priorCollectionId = filesById.get(file.priorLogicalId)?.collectionId;
        if (priorCollectionId) candidateIds.add(priorCollectionId);
      }
      const rankedIds = Array.from(candidateIds).sort((left, right) =>
        Number(scanPins.has(right)) - Number(scanPins.has(left)) ||
        Number(collectionsById.has(right)) - Number(collectionsById.has(left)) ||
        left.localeCompare(right));
      let id = rankedIds.find((candidateId) => !reservedCollectionIds.has(candidateId));
      if (!id) {
        let suffix = 0;
        do {
          id = opaqueId(salt, "collection", `split:${signature}\0${suffix++}`);
        } while (reservedCollectionIds.has(id));
      }
      reservedCollectionIds.add(id);
      finalSeeds.push({
        id,
        name: collectionsById.get(id)?.name || seeds
          .map((seed) => seed.name)
          .sort((left, right) => left.localeCompare(right, "en", {
            numeric: true,
            sensitivity: "base",
          }))[0],
        managed: false,
        managedJobIds: [],
        pinAliases: rankedIds,
        files: seeds.flatMap((seed) => seed.files),
      });
    }

    const nextFiles = new Map();
    const nextCollections = new Map();
    const reservedFileIds = new Set();
    for (const seed of finalSeeds) {
      const logicalFiles = collapseFiles(seed.files, seed.id, reservedFileIds);
      logicalFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en", {
        numeric: true,
        sensitivity: "base",
      }));
      const collection = {
        ...seed,
        files: logicalFiles,
        pinned: false,
        size: logicalFiles.reduce((total, file) => total + file.size, 0),
        updatedAt: logicalFiles.reduce((latest, file) => Math.max(
          latest,
          ...file.copies.map((copy) => copy.modifiedAt)
        ), 0),
      };
      nextCollections.set(collection.id, collection);
      for (const file of logicalFiles) nextFiles.set(file.id, file);
    }
    await withCatalogMutation(async () => {
      const livePinnedManagedJobs = new Set((await Promise.resolve(getManagedJobs()))
        .filter((job) => job?.pinned)
        .map((job) => String(job.id)));
      const pinsAtCommit = new Set(pins);
      const representedPinAliases = new Set();
      for (const collection of nextCollections.values()) {
        const pinAliases = [collection.id, ...(collection.pinAliases || [])];
        for (const id of pinAliases) representedPinAliases.add(id);
        const aliasPinned = pinAliases.some((id) => pinsAtCommit.has(id));
        const managedPinned = collection.managedJobIds
          .some((jobId) => livePinnedManagedJobs.has(jobId));
        collection.pinned = aliasPinned || managedPinned;
        delete collection.pinAliases;
      }
      for (const id of representedPinAliases) pins.delete(id);
      for (const collection of nextCollections.values()) {
        if (collection.pinned) pins.add(collection.id);
      }
      for (const collection of nextCollections.values()) {
        if (collection.managed && collection.pinned) {
          await onSetManagedPins(collection.managedJobIds, true, collection.id);
        }
      }
      filesById = nextFiles;
      collectionsById = nextCollections;
      managedCollectionByJobId = new Map(Array.from(nextCollections.values())
        .flatMap((collection) => collection.managedJobIds.map((jobId) => [jobId, collection.id])));
      record.scannedFiles = filesById.size;
      record.finishedAt = now();
      lastSuccessfulScanAt = record.finishedAt;
      await persist();
    });
  }

  function startScan() {
    if (activeScan) {
      return { started: false, operation: scanSnapshot(activeScan), completion: activeScan.completion };
    }
    const record = {
      id: randomUUID(),
      status: "running",
      startedAt: now(),
      finishedAt: null,
      scannedFiles: filesById.size,
      failedRoots: 0,
      truncated: false,
      error: null,
      completion: null,
    };
    activeScan = record;
    latestScan = record;
    scans.set(record.id, record);
    while (scans.size > 20) scans.delete(scans.keys().next().value);
    record.completion = performScan(record)
      .then(() => {
        record.status = "complete";
        record.finishedAt = now();
        return scanSnapshot(record);
      })
      .catch((error) => {
        record.status = "error";
        record.error = error instanceof Error ? error.message : "Library scan failed.";
        record.finishedAt = now();
        return scanSnapshot(record);
      })
      .finally(() => {
        if (activeScan === record) activeScan = null;
      });
    return { started: true, operation: scanSnapshot(record), completion: record.completion };
  }

  function list({ query = "", offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const normalizedOffset = clampInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const normalizedLimit = clampInteger(limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const matching = Array.from(collectionsById.values())
      .filter((collection) => !normalizedQuery ||
        collection.name.toLowerCase().includes(normalizedQuery) ||
        collection.files.some((file) =>
          file.name.toLowerCase().includes(normalizedQuery) ||
          file.relativePath.toLowerCase().includes(normalizedQuery)))
      .sort((left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }) ||
        left.id.localeCompare(right.id));
    return {
      collections: matching
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map((collection) => publicCollection(collection)),
      total: matching.length,
      offset: normalizedOffset,
      limit: normalizedLimit,
      scan: scanSnapshot(),
    };
  }

  function listFiles({ query = "", limit = 300 } = {}) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    return Array.from(filesById.values())
      .filter((file) => !normalizedQuery ||
        file.name.toLowerCase().includes(normalizedQuery) ||
        file.relativePath.toLowerCase().includes(normalizedQuery))
      .sort((left, right) =>
        left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }) ||
        left.id.localeCompare(right.id))
      .slice(0, clampInteger(limit, 300, 1, 1_000))
      .map((file) => ({
        ...publicFile(file),
        pinned: Boolean(collectionsById.get(file.collectionId)?.pinned),
      }));
  }

  async function setPinned(id, pinned) {
    const collectionId = String(id);
    return withCatalogMutation(async () => {
      const collection = collectionsById.get(collectionId);
      if (!collection) return null;
      const desired = Boolean(pinned);
      await onSetManagedPins(collection.managedJobIds, desired, collection.id);
      if (desired) pins.add(collectionId);
      else pins.delete(collectionId);
      const currentCollection = collectionsById.get(collectionId);
      if (currentCollection) currentCollection.pinned = desired;
      await persist();
      return publicCollection(currentCollection || { ...collection, pinned: desired }, {
        includeFiles: true,
      });
    });
  }

  async function setManagedJobPinned(jobId, pinned) {
    return withCatalogMutation(async () => {
      const id = managedCollectionByJobId.get(String(jobId)) || managedCollectionId(String(jobId));
      const desired = Boolean(pinned);
      const collection = collectionsById.get(id);
      await onSetManagedPins(collection?.managedJobIds || [String(jobId)], desired, id);
      if (desired) pins.add(id);
      else pins.delete(id);
      const currentCollection = collectionsById.get(id);
      if (currentCollection) currentCollection.pinned = desired;
      await persist();
    });
  }

  function pinnedContentKeys() {
    const keys = new Set();
    for (const collection of collectionsById.values()) {
      if (!collection.pinned) continue;
      for (const file of collection.files) {
        if (file.usable === false || !/^[a-f0-9]{16,128}$/.test(String(file.fingerprint || ""))) {
          continue;
        }
        keys.add(`${file.fingerprint}-${file.size}`);
      }
    }
    return keys;
  }

  return {
    load,
    startScan,
    scanStatus(id = null) {
      if (id) return scans.has(String(id)) ? scanSnapshot(scans.get(String(id))) : null;
      return scanSnapshot();
    },
    readyForCleanup() {
      return Number.isFinite(lastSuccessfulScanAt);
    },
    async rootsReachable() {
      const result = await canonicalRoots();
      return result.failedRoots === 0;
    },
    list,
    listFiles,
    getCollection(id) {
      const collection = collectionsById.get(String(id));
      return collection ? publicCollection(collection, { includeFiles: true }) : null;
    },
    getFile(id) {
      return filesById.get(String(id)) || null;
    },
    matchFile(fingerprint, size) {
      const normalizedFingerprint = String(fingerprint || "").toLowerCase();
      const normalizedSize = Number(size);
      if (!/^[a-f0-9]{16,128}$/.test(normalizedFingerprint) ||
        !Number.isSafeInteger(normalizedSize) || normalizedSize < 0) return null;
      const file = Array.from(filesById.values()).find((candidate) =>
        candidate.usable !== false && candidate.fingerprint === normalizedFingerprint &&
        candidate.size === normalizedSize);
      return file ? {
        ...publicFile(file),
        pinned: Boolean(collectionsById.get(file.collectionId)?.pinned),
      } : null;
    },
    matchTorrent(infoHash, { fileIndex = null, relativePath = "", size = null } = {}) {
      const normalizedInfoHash = String(infoHash || "").toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(normalizedInfoHash)) return null;
      const normalizedIndex = fileIndex === null || fileIndex === "" ? null : Number(fileIndex);
      const normalizedSize = size === null || size === "" ? null : Number(size);
      const normalizedRelativePath = String(relativePath || "")
        .replaceAll("\\", "/")
        .replace(/^\/+/, "")
        .toLowerCase();
      const file = Array.from(filesById.values()).find((candidate) =>
        candidate.usable !== false && candidate.infoHash === normalizedInfoHash &&
        (normalizedIndex === null || candidate.torrentFileIndex === normalizedIndex) &&
        (normalizedSize === null || candidate.size === normalizedSize) &&
        (!normalizedRelativePath || candidate.relativePath.replaceAll("\\", "/").toLowerCase() === normalizedRelativePath));
      return file ? {
        ...publicFile(file),
        pinned: Boolean(collectionsById.get(file.collectionId)?.pinned),
      } : null;
    },
    async setFileFingerprint(id, fingerprint, size) {
      const normalizedFingerprint = String(fingerprint || "").toLowerCase();
      return withCatalogMutation(async () => {
        const file = filesById.get(String(id));
        if (!file || !/^[a-f0-9]{16,128}$/.test(normalizedFingerprint) ||
          file.size !== Number(size)) return false;
        file.fingerprint = normalizedFingerprint;
        await persist();
        return true;
      });
    },
    protectedExternalTopLevelNames(root) {
      const resolvedRoot = path.resolve(root);
      const names = new Set();
      for (const file of filesById.values()) {
        if (file.managed || !isWithin(resolvedRoot, file.path)) continue;
        const first = path.relative(resolvedRoot, file.path).split(path.sep).filter(Boolean)[0];
        if (first) names.add(first);
      }
      return names;
    },
    setPinned,
    setManagedJobPinned,
    isManagedJobPinned(jobId) {
      const id = managedCollectionByJobId.get(String(jobId)) || managedCollectionId(String(jobId));
      return pins.has(id);
    },
    isCollectionPinned(id) {
      return pins.has(String(id));
    },
    pinnedContentKeys,
    isContentKeyPinned(key) {
      return pinnedContentKeys().has(String(key));
    },
  };
}

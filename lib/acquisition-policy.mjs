export const ACQUISITION_POLICIES = ["automatic", "ask", "never"];

/**
 * Read the current acquisition policy while retaining the two legacy download
 * modes written by older WatchPair clients.
 * @param {string | null | undefined} value
 * @param {string | null | undefined} legacyValue
 * @returns {"automatic" | "ask" | "never"}
 */
export function normalizeAcquisitionPolicy(value, legacyValue = null) {
  const candidate = value || legacyValue;
  if (candidate === "automatic") return "automatic";
  if (candidate === "ask" || candidate === "manual") return "ask";
  if (candidate === "never" || candidate === "external") return "never";
  return "automatic";
}

/** @param {string} policy @param {string} sourceId @param {string[]} approvedSourceIds */
export function shouldAcquireSource(policy, sourceId, approvedSourceIds = []) {
  if (policy === "never") return false;
  return policy === "automatic" || approvedSourceIds.includes(sourceId);
}

/**
 * @param {Record<string, {id: string, seed: boolean, paused?: boolean, status: string, files?: Array<{ready?: boolean}>}>} jobs
 * @param {string[] | null} [sourceIds]
 */
export function pausableJobIds(jobs, sourceIds = null) {
  const allowed = sourceIds ? new Set(sourceIds) : null;
  return Object.values(jobs)
    .filter(
      (job) =>
        (!allowed || allowed.has(job.id)) &&
        !job.seed &&
        !job.paused &&
        (job.status === "queued" ||
          job.status === "metadata" ||
          job.status === "downloading" ||
          (job.status === "ready" && job.files?.some((file) => file.ready !== true)))
    )
    .map((job) => job.id);
}

/** @param {string} policy */
export function acquisitionStatus(policy) {
  if (policy === "ask") return "Waiting for your approval";
  if (policy === "never") return "Downloads disabled on this device";
  return "Waiting for companion";
}

/**
 * Avoid hammering the catalog while it is still scanning, without turning an
 * initial miss into a permanent negative cache entry.
 * @param {number | null | undefined} lastMissAt
 * @param {number} [now]
 * @param {number} [retryAfterMs]
 */
export function shouldRetryLibraryMatch(lastMissAt, now = Date.now(), retryAfterMs = 5_000) {
  return !Number.isFinite(lastMissAt) || now - Number(lastMissAt) >= retryAfterMs;
}

/**
 * Async refresh results may only mutate local or companion state while the
 * effect that requested them still owns the current room generation.
 * @param {boolean} active
 * @param {number} startedGeneration
 * @param {number} currentGeneration
 */
export function transferRefreshIsCurrent(active, startedGeneration, currentGeneration) {
  return active && startedGeneration === currentGeneration;
}

/**
 * A newly attached local job will not be present in the snapshot that preceded
 * the attach. A cached attachment, however, must still exist in the latest
 * companion snapshot or it belongs to an earlier companion process.
 * @param {boolean} createdByCurrentRefresh
 * @param {string} sourceId
 * @param {Iterable<string>} currentJobIds
 */
export function cachedLibraryBindingIsLive(createdByCurrentRefresh, sourceId, currentJobIds) {
  return createdByCurrentRefresh || new Set(currentJobIds).has(sourceId);
}

export function libraryShareIntentKey(file) {
  if (file.infoHash) {
    const infoHash = String(file.infoHash).toLowerCase();
    const fileIndex = file.torrentFileIndex ?? file.fileIndex;
    if (Number.isInteger(fileIndex) && fileIndex >= 0) {
      return `torrent:${infoHash}:index:${fileIndex}:size:${file.size}`;
    }
    const relativePath = normalizedTorrentPath(file.relativePath);
    if (relativePath) return `torrent:${infoHash}:path:${relativePath}:size:${file.size}`;
  }
  if (file.fingerprint) return `content:${file.fingerprint}:${file.size}`;
  return `library:${file.id}`;
}

function normalizedTorrentPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * A library copy can replace room media after a strong content fingerprint,
 * or through the same torrent plus a stable file index/path. Names and sizes
 * alone are deliberately insufficient.
 * @param {{fingerprint?: string, size?: number} | null | undefined} selectedMedia
 * @param {string | null | undefined} fingerprint
 * @param {number} size
 * @param {{selectedInfoHash?: string | null, libraryInfoHash?: string | null, selectedFileIndex?: number, libraryFileIndex?: number, selectedPath?: string | null, libraryPath?: string | null}} [torrent]
 */
export function isVerifiedLibraryMatch(selectedMedia, fingerprint, size, torrent = {}) {
  const sameFingerprint = Boolean(
    selectedMedia?.fingerprint &&
    fingerprint &&
    selectedMedia.fingerprint === fingerprint &&
    selectedMedia.size === size
  );
  if (sameFingerprint) return true;
  if (selectedMedia?.size !== size) return false;

  const selectedInfoHash = String(torrent.selectedInfoHash || "").toLowerCase();
  const libraryInfoHash = String(torrent.libraryInfoHash || "").toLowerCase();
  if (!selectedInfoHash || selectedInfoHash !== libraryInfoHash) return false;

  const identityChecks = [];
  if (Number.isInteger(torrent.selectedFileIndex) && Number.isInteger(torrent.libraryFileIndex)) {
    identityChecks.push(torrent.selectedFileIndex === torrent.libraryFileIndex);
  }
  const selectedPath = normalizedTorrentPath(torrent.selectedPath);
  const libraryPath = normalizedTorrentPath(torrent.libraryPath);
  if (selectedPath && libraryPath) identityChecks.push(selectedPath === libraryPath);
  return identityChecks.length > 0 && identityChecks.every(Boolean);
}

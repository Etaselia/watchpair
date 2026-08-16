function legacyCleanupResult(value) {
  return value && Array.isArray(value.removedJobs) &&
    Array.isArray(value.removedEntries) && Number.isFinite(value.bytes);
}

export function legacyCleanupJobs(result) {
  if (!Array.isArray(result?.legacyJobs)) return [];
  return [...new Set(result.legacyJobs.filter((jobId) => typeof jobId === "string" && jobId))];
}

function sanitizedLegacyDownloadLabel(value) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...normalized];
  return characters.length > 96
    ? `${characters.slice(0, 95).join("")}…`
    : normalized;
}

export function legacyCleanupDownloads(result) {
  const jobIds = legacyCleanupJobs(result);
  const candidateIds = new Set(jobIds);
  const labels = new Map();
  if (Array.isArray(result?.legacyDownloads)) {
    for (const download of result.legacyDownloads) {
      if (!download || !candidateIds.has(download.id) || labels.has(download.id)) continue;
      const label = sanitizedLegacyDownloadLabel(download.label);
      if (label) labels.set(download.id, label);
    }
  }
  return jobIds.map((id) => ({
    id,
    label: labels.get(id) || sanitizedLegacyDownloadLabel(id) || "Unknown download",
  }));
}

export function legacyCleanupConfirmationOptions(result, { retentionDays } = {}) {
  const candidates = legacyCleanupDownloads(result);
  const count = candidates.length;
  if (!count) return null;
  const downloads = count === 1 ? "download" : "downloads";
  const retention = Number.isFinite(retentionDays) && retentionDays > 0
    ? `your ${retentionDays}-day retention limit`
    : "your retention limit";
  const displayLimit = 8;
  const displayed = candidates.slice(0, displayLimit).map(({ label }) => `• ${label}`);
  if (count > displayLimit) displayed.push(`… and ${count - displayLimit} more`);
  return {
    type: "warning",
    title: "Review old downloads",
    message: `Found ${count} old ${downloads} with unreliable activity dates.`,
    detail: `An older WatchPair version lost the last-used dates for these ${downloads}. Their files on disk are older than ${retention}, but WatchPair cannot tell whether they were played recently. Keep them unless you explicitly want to remove them now.\n\nDownloads to review:\n${displayed.join("\n")}`,
    buttons: ["Keep downloads", count === 1 ? "Remove old download" : `Remove ${count} old downloads`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function mergeCleanupResults(...results) {
  if (!results.length || results.some((result) => !legacyCleanupResult(result))) {
    throw new Error("The companion returned an invalid cleanup result.");
  }
  const latest = results.at(-1);
  const legacyJobs = legacyCleanupJobs(latest);
  const legacyDownloads = legacyCleanupDownloads(latest);
  return {
    removedJobs: [...new Set(results.flatMap((result) => result.removedJobs))],
    removedEntries: [...new Set(results.flatMap((result) => result.removedEntries))],
    bytes: results.reduce((total, result) => total + Math.max(0, result.bytes), 0),
    legacyJobs,
    ...(legacyDownloads.length ? { legacyDownloads } : {}),
  };
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export function summarizeCleanupResult(result) {
  if (!legacyCleanupResult(result)) {
    throw new Error("The companion returned an invalid cleanup result.");
  }

  const removedDownloads = result.removedJobs.length;
  const removedEntries = result.removedEntries.length;
  const removedItems = removedDownloads + removedEntries;
  const bytes = Math.max(0, result.bytes);
  const keptLegacyDownloads = legacyCleanupJobs(result).length;
  let message = "Cleanup complete — nothing eligible";

  if (removedItems > 0 || bytes > 0) {
    const parts = [];
    if (removedDownloads) parts.push(plural(removedDownloads, "download"));
    if (removedEntries) parts.push(plural(removedEntries, "expired item"));
    const removal = parts.length ? `removed ${parts.join(" and ")}; ` : "";
    message = `Cleanup complete — ${removal}freed ${formatBytes(bytes)}`;
  }
  if (keptLegacyDownloads) {
    const kept = `kept ${plural(keptLegacyDownloads, "older download")}`;
    message = removedItems > 0 || bytes > 0
      ? `${message}; ${kept}`
      : `Cleanup complete — ${kept}`;
  }

  return {
    removedDownloads,
    removedEntries,
    removedItems,
    bytes,
    message,
  };
}

export function shouldRefreshStorage({
  force = false,
  hasStorage = false,
  lastSuccessfulAt = 0,
  lastAttemptAt = 0,
  now = Date.now(),
  intervalMs = 60_000,
} = {}) {
  if (force) return true;
  const interval = Math.max(0, Number(intervalMs) || 0);
  const attemptDue = !Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0 ||
    now - lastAttemptAt >= interval;
  if (!attemptDue) return false;
  return !hasStorage || !Number.isFinite(lastSuccessfulAt) || lastSuccessfulAt <= 0 ||
    now - lastSuccessfulAt >= interval;
}

export function estimateStorageAfterCleanup(
  storage,
  result,
  { currentRevision, startedRevision } = {}
) {
  if (currentRevision !== startedRevision) return storage;
  const usage = storage?.usage;
  if (!usage || !Number.isFinite(usage.bytes) || !Number.isFinite(result?.bytes)) return storage;

  const removedBytes = Math.max(0, result.bytes);
  const removedJobs = Array.isArray(result.removedJobs) ? result.removedJobs.length : 0;
  return {
    ...storage,
    usage: {
      ...usage,
      bytes: Math.max(0, usage.bytes - removedBytes),
      availableBytes: usage.availableBytes === null
        ? null
        : Number.isFinite(usage.availableBytes)
          ? usage.availableBytes + removedBytes
          : usage.availableBytes,
      managedJobs: Number.isFinite(usage.managedJobs)
        ? Math.max(0, usage.managedJobs - removedJobs)
        : usage.managedJobs,
    },
  };
}

export async function waitForCleanupOperation(
  started,
  {
    read,
    pollIntervalMs = 500,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}
) {
  if (legacyCleanupResult(started)) return started;
  if (!started || typeof started !== "object") {
    throw new Error("The companion returned an invalid cleanup operation.");
  }

  let operation = started;
  while (operation.status === "running") {
    if (!operation.id || typeof read !== "function") {
      throw new Error("The companion returned an invalid cleanup operation.");
    }
    await delay(pollIntervalMs);
    operation = await read(operation.id);
  }

  if (operation.status === "complete" && legacyCleanupResult(operation.result)) {
    return operation.result;
  }
  if (operation.status === "error") {
    throw new Error(operation.error || "Cleanup failed.");
  }
  throw new Error("The companion returned an invalid cleanup operation.");
}

export async function runCleanupWithLegacyConfirmation({
  start,
  read,
  confirmLegacy,
  pollIntervalMs = 500,
  delay,
} = {}) {
  if (typeof start !== "function") {
    throw new TypeError("A cleanup starter is required.");
  }
  const run = async (request) => waitForCleanupOperation(await start(request), {
    read,
    pollIntervalMs,
    ...(delay ? { delay } : {}),
  });
  const initial = await run({ includeLegacy: false, legacyJobs: [] });
  const legacyJobs = legacyCleanupJobs(initial);
  if (!legacyJobs.length || typeof confirmLegacy !== "function") return initial;
  const confirmed = await confirmLegacy([...legacyJobs], initial);
  if (confirmed !== true) return initial;
  return mergeCleanupResults(initial, await run({
    includeLegacy: true,
    legacyJobs: [...legacyJobs],
  }));
}

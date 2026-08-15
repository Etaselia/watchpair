function legacyCleanupResult(value) {
  return value && Array.isArray(value.removedJobs) &&
    Array.isArray(value.removedEntries) && Number.isFinite(value.bytes);
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

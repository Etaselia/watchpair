import { lstat, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const MANAGED_JOB_DIRECTORY = /^[a-zA-Z0-9-]{8,80}$/;
const DEFAULT_SIZE_CONCURRENCY = 8;

export function createSingleFlightOperation({
  run,
  createId,
  now = Date.now,
  historyLimit = 20,
}) {
  if (typeof run !== "function") throw new TypeError("A background operation requires a run function.");
  let sequence = 0;
  let active = null;
  let latest = null;
  const records = new Map();

  const operationId = typeof createId === "function"
    ? createId
    : () => `${now()}-${++sequence}`;
  const snapshot = (record) => record
    ? {
        id: record.id,
        status: record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        result: record.result,
        error: record.error,
      }
    : {
        id: null,
        status: "idle",
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      };
  const trimHistory = () => {
    const limit = Math.max(1, Math.floor(Number(historyLimit) || 20));
    for (const [id, record] of records) {
      if (records.size <= limit) break;
      if (record === active) continue;
      records.delete(id);
    }
  };

  const start = (input) => {
    if (active) {
      return {
        started: false,
        operation: snapshot(active),
        completion: active.completion,
      };
    }

    const record = {
      id: String(operationId()),
      status: "running",
      startedAt: now(),
      finishedAt: null,
      result: null,
      error: null,
      completion: null,
    };
    active = record;
    latest = record;
    records.set(record.id, record);
    trimHistory();
    record.completion = Promise.resolve()
      .then(() => run(input))
      .then(
        (result) => {
          record.status = "complete";
          record.result = result;
          record.finishedAt = now();
          return snapshot(record);
        },
        (error) => {
          record.status = "error";
          record.error = error instanceof Error ? error.message : String(error || "Operation failed.");
          record.finishedAt = now();
          return snapshot(record);
        }
      )
      .finally(() => {
        if (active === record) active = null;
      });
    return { started: true, operation: snapshot(record), completion: record.completion };
  };

  return {
    start,
    get(id = null) {
      if (id !== null && id !== undefined && id !== "") {
        return records.has(String(id)) ? snapshot(records.get(String(id))) : null;
      }
      return snapshot(latest);
    },
  };
}

export function createSingleFlightCache({
  load,
  ttlMs = 60_000,
  retryDelayMs = ttlMs,
  now = Date.now,
}) {
  let cached;
  let cachedAt = 0;
  let attemptedAt = 0;
  let lastError = null;
  let inFlight = null;

  const get = ({ fresh = false } = {}) => {
    const timestamp = now();
    if (inFlight) return inFlight;
    if (!fresh && cached !== undefined && timestamp - cachedAt < ttlMs) {
      return Promise.resolve(cached);
    }
    if (!fresh && lastError && timestamp - attemptedAt < retryDelayMs) {
      return cached !== undefined ? Promise.resolve(cached) : Promise.reject(lastError);
    }

    attemptedAt = timestamp;
    inFlight = Promise.resolve()
      .then(load)
      .then((value) => {
        cached = value;
        cachedAt = now();
        lastError = null;
        return value;
      })
      .catch((error) => {
        lastError = error;
        if (cached !== undefined) return cached;
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    get,
    invalidate() {
      cachedAt = 0;
    },
    set(value) {
      cached = value;
      cachedAt = now();
      lastError = null;
    },
    details() {
      return {
        cached: cached !== undefined,
        cachedAt: cachedAt || null,
        attemptedAt: attemptedAt || null,
        refreshing: Boolean(inFlight),
        error: lastError?.message || null,
      };
    },
  };
}

export async function pathStats(target, { concurrency = DEFAULT_SIZE_CONCURRENCY } = {}) {
  const limit = Math.max(1, Math.min(32, Math.floor(Number(concurrency) || DEFAULT_SIZE_CONCURRENCY)));
  const queue = [target];
  let cursor = 0;
  let active = 0;
  let total = 0;
  let latestMtimeMs = null;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const schedule = () => {
      if (settled) return;
      while (active < limit && cursor < queue.length) {
        const current = queue[cursor];
        cursor += 1;
        active += 1;
        lstat(current)
          .catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          })
          .then(async (info) => {
            if (!info) return;
            if (Number.isFinite(info.mtimeMs)) {
              latestMtimeMs = latestMtimeMs === null
                ? info.mtimeMs
                : Math.max(latestMtimeMs, info.mtimeMs);
            }
            if (!info.isDirectory()) {
              total += info.size;
              return;
            }
            const entries = await readdir(current, { withFileTypes: true });
            for (const entry of entries) queue.push(path.join(current, entry.name));
          })
          .then(() => {
            active -= 1;
            if (active === 0 && cursor >= queue.length) {
              settled = true;
              resolve({ bytes: total, latestMtimeMs });
              return;
            }
            schedule();
          })
          .catch(finishWithError);
      }
    };

    schedule();
  });
}

export async function pathSize(target, options) {
  return (await pathStats(target, options)).bytes;
}

export async function pathLatestMtime(target, options) {
  return (await pathStats(target, options)).latestMtimeMs;
}

export async function removePathAndMeasure(target) {
  const bytes = await pathSize(target);
  await rm(target, { recursive: true, force: true });
  return bytes;
}

export async function pruneExpiredChildren(
  root,
  {
    now = Date.now(),
    maxAgeMs,
    include = () => true,
    protectedNames = new Set(),
    inspect = stat,
  }
) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];

  for (const entry of entries) {
    if (protectedNames.has(entry.name) || !include(entry)) continue;
    const target = path.join(root, entry.name);
    const info = await inspect(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    const bytes = await removePathAndMeasure(target);
    removed.push({ name: entry.name, bytes });
  }
  return removed;
}

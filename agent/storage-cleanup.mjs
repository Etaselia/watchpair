import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const MANAGED_JOB_DIRECTORY = /^[a-zA-Z0-9-]{8,80}$/;
const DEFAULT_SIZE_CONCURRENCY = 8;

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

export async function pathSize(target, { concurrency = DEFAULT_SIZE_CONCURRENCY } = {}) {
  const limit = Math.max(1, Math.min(32, Math.floor(Number(concurrency) || DEFAULT_SIZE_CONCURRENCY)));
  const queue = [target];
  let cursor = 0;
  let active = 0;
  let total = 0;

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
        stat(current)
          .catch((error) => {
            if (error?.code === "ENOENT") return null;
            throw error;
          })
          .then(async (info) => {
            if (!info) return;
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
              resolve(total);
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
    const info = await stat(target).catch(() => null);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    const bytes = await removePathAndMeasure(target);
    removed.push({ name: entry.name, bytes });
  }
  return removed;
}

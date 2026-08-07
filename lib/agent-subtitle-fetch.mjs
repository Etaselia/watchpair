const DEFAULT_RETRY_MS = 750;
const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 5_000;
/**
 * @typedef {Object} FetchPreparedAgentAssetOptions
 * @property {AbortSignal} [signal]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {(delayMs: number, signal?: AbortSignal) => Promise<unknown>} [wait]
 * @property {(response: Response) => void} [onResponse]
 */

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The subtitle request was cancelled.", "AbortError");
}

function retryDelay(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRY_MS;
  return Math.max(MIN_RETRY_MS, Math.min(MAX_RETRY_MS, parsed));
}

export function waitForAgentAsset(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);

    function finish() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }

    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(abortError(signal));
    }

    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * @param {string} url
 * @param {FetchPreparedAgentAssetOptions} [options]
 * @returns {Promise<Response>}
 */
export async function fetchPreparedAgentAsset(url, {
  signal,
  fetchImpl = fetch,
  wait = waitForAgentAsset,
  onResponse,
} = {}) {
  while (true) {
    if (signal?.aborted) throw abortError(signal);
    const response = await fetchImpl(url, { cache: "force-cache", signal });
    onResponse?.(response);

    if (response.status !== 202) return response;

    const pending = await response.json().catch(() => null);
    await wait(retryDelay(pending?.retryAfterMs), signal);
  }
}

/**
 * @template T, R
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T, index: number) => Promise<R> | R} mapper
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(values, concurrency, mapper) {
  if (!values.length) return [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(values.length, Math.floor(concurrency) || 1));

  async function work() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => work()));
  return results;
}

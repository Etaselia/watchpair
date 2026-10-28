import { magnetInfoHash } from "./magnet-identity.mjs";

export function mediaWatchKey(source, media = {}) {
  const infoHash = source?.infoHash || (source?.kind === "magnet" ? magnetInfoHash(source.value) : null);
  if (infoHash && Number.isInteger(media.fileIndex)) return `torrent:${infoHash.toLowerCase()}:${media.fileIndex}`;
  if (source?.id) return media.fileIndex !== undefined && source.kind === "magnet"
    ? `source:${source.id}:${media.fileIndex}` : `source:${source.id}`;
  return media.fingerprint ? `local:${media.fingerprint}` : `local:${media.name}:${media.size}`;
}

export function isMediaWatched(records, source, media) {
  return Boolean(records?.[mediaWatchKey(source, media)]?.watchedAt);
}

// Union intervals so seeks and repeated scenes never count as watched footage.
export function mergeWatchedRanges(ranges, start, end, duration) {
  const sorted = [...ranges, [Math.max(0, start), Math.min(duration, end)]]
    .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of sorted) {
    const previous = merged.at(-1);
    if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

export function watchedFraction(ranges, duration) {
  return duration > 0 ? ranges.reduce((total, [start, end]) => total + Math.max(0, end - start), 0) / duration : 0;
}

// Track a viewing independently of HTMLMediaElement.played, which retains the
// union of all earlier viewings while the same video element remains loaded.
export function createWatchCoverageTracker() {
  let previous = null;
  let ranges = [];
  return {
    observe({ position, time, rate = 1, playing = false, seeking = false }) {
      if (![position, time, rate].every(Number.isFinite) || position < 0 || rate <= 0 || seeking) {
        previous = null;
        return;
      }
      if (previous?.playing) {
        const elapsed = (time - previous.time) / 1000;
        const delta = position - previous.position;
        if (elapsed > 0 && delta > 0 && delta <= elapsed * Math.max(rate, previous.rate) + 0.2) {
          ranges = mergeWatchedRanges(ranges, previous.position, position, Number.MAX_SAFE_INTEGER);
        }
      }
      previous = playing ? { position, time, rate, playing } : null;
    },
    discontinuity() { previous = null; },
    ranges() { return ranges.map(([start, end]) => [start, end]); },
  };
}

export function unreportedWatchedRanges(played, reported, duration) {
  const result = [];
  for (const [start, end] of played) {
    let cursor = Math.max(0, start);
    const limit = Math.min(duration, end);
    const append = (to) => {
      while (to - cursor > 0.001) {
        const next = Math.min(to, cursor + 20);
        result.push([cursor, next]);
        cursor = next;
      }
    };
    for (const [from, to] of reported) {
      if (to <= cursor) continue;
      if (from >= limit) break;
      append(Math.min(from, limit));
      cursor = Math.max(cursor, to);
    }
    append(limit);
  }
  return result;
}

export function downloadFileIndexes(source, records = {}) {
  if (source.selectionConfirmed === false) return [];
  if (!source.mediaItems?.length) return source.selectedFileIndexes ? [...source.selectedFileIndexes].sort((a, b) => a - b) : null;
  return source.mediaItems.filter((item) => item.included !== false && !isMediaWatched(records, source, item))
    .map((item) => item.fileIndex).sort((a, b) => a - b);
}

export function relativeWatchTime(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minute${seconds < 120 ? "" : "s"} ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hour${seconds < 7200 ? "" : "s"} ago`;
  return `${Math.floor(seconds / 86400)} day${seconds < 172800 ? "" : "s"} ago`;
}

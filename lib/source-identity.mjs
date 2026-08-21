import { magnetInfoHash } from "./magnet-identity.mjs";

export function canonicalSourceValue(kind, value) {
  const normalized = String(value || "").trim();
  if (kind === "magnet") return magnetInfoHash(normalized) || normalized;
  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

/** Match the agent's privacy-safe identity without returning the source value. */
export async function sharedSourceIdentity(kind, value) {
  const canonical = canonicalSourceValue(kind, value);
  if (!canonical) return null;
  const payload = new TextEncoder().encode(`${kind}\u0000${canonical}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A companion job with the same public id is reusable only when its redacted
 * identity proves it was created from the same room source.
 */
export function agentJobMatchesSourceIdentity(job, expectedIdentity) {
  return Boolean(
    expectedIdentity &&
    job?.sourceIdentity &&
    job.sourceIdentity === expectedIdentity
  );
}

/** Return the queue id retained when the room deduplicates a published torrent. */
export function publishedMagnetRoomSourceId(sources, requestedId, magnetURI) {
  const infoHash = magnetInfoHash(magnetURI);
  if (!infoHash) return null;
  const requested = sources?.find((source) => source.id === requestedId);
  if (
    requested?.kind === "magnet" &&
    magnetInfoHash(requested.value) === infoHash
  ) return requested.id;
  return sources?.find(
    (source) => source.kind === "magnet" && magnetInfoHash(source.value) === infoHash
  )?.id || null;
}

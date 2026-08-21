/**
 * Pure helpers for persisting and restoring torrent verification and
 * networking state across agent restarts. Used by `server.mjs`; kept in a
 * standalone module so the round-trip semantics are unit-testable without
 * importing the long-lived agent server.
 */

/**
 * Identity of a torrent file for verification purposes: index + name + size.
 * The identity is embedded in the key itself, so a file whose name or size
 * changed simply produces a different key and is re-verified on restore.
 */
export function fileIdentityKey(index, file) {
  return String(index) + ":" + file.name + ":" + file.size;
}

/**
 * A torrent file may skip the agent's full piece re-hash only when it was
 * previously verified for the exact same identity AND WebTorrent re-verified
 * the store contents on restore (`file.done`). WebTorrent's own startup
 * verification (`_verifyPiecesUsingHash` on `client.add`) runs before
 * `file.done` becomes true, so `file.done` doubles as the integrity check;
 * the persisted key guards against the file identity changing. A file whose
 * identity changed, or whose data is no longer complete, is still fully
 * verified (and re-downloaded) exactly as before.
 */
export function shouldSkipTorrentVerification(assetVerifiedKey, currentVerificationKey, fileDone) {
  return Boolean(
    assetVerifiedKey &&
    assetVerifiedKey === currentVerificationKey &&
    fileDone === true
  );
}

/**
 * Collect the per-file verification keys that should survive a restart, keyed
 * by file index. Only keys that are present on an asset are kept; the identity
 * embedded in each key decides on restore whether it still matches the live
 * file. Returns `undefined` when nothing was verified, so the persisted record
 * stays small (JSON drops the field).
 */
export function torrentVerifiedKeysOf(job) {
  if (!job?.assets || !(job.assets instanceof Map)) return undefined;
  const keys = {};
  let any = false;
  for (const [indexValue, asset] of job.assets) {
    if (!asset || typeof asset.torrentVerifiedKey !== "string" || !asset.torrentVerifiedKey) {
      continue;
    }
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0) continue;
    keys[String(index)] = asset.torrentVerifiedKey;
    any = true;
  }
  return any ? keys : undefined;
}

/**
 * The slice of job state persisted across restarts and restored by
 * `applyRestoredTorrentState`. `torrentSilenced` keeps fully-downloaded,
 * non-shared torrents from re-announcing after an agent restart;
 * `torrentVerifiedKeys` prevents re-hashing unchanged, already-verified files.
 */
export function persistedTorrentState(job) {
  return {
    torrentSilenced: Boolean(job?.torrentSilenced),
    torrentVerifiedKeys: torrentVerifiedKeysOf(job),
  };
}

/**
 * Restore persisted torrent state onto a freshly recreated job.
 *
 * - `torrentSilenced` is copied back so the caller can re-apply silence once
 *   the torrent object exists again (a torrent can only be silenced after its
 *   `torrent` object exists; the persisted flag records that it should be).
 * - `torrentVerifiedKeys` are applied verbatim to the per-file assets. They
 *   are only trusted later, when `shouldSkipTorrentVerification` confirms the
 *   key still matches the live file identity and WebTorrent re-verified the
 *   data (`file.done`).
 *
 * `ensureAsset(job, index)` must return the (possibly freshly created) asset
 * for a file index; invalid entries in the persisted map are ignored.
 */
export function applyRestoredTorrentState(job, source, ensureAsset) {
  if (!job || !source) return;
  job.torrentSilenced = Boolean(source.torrentSilenced);
  const keys = source.torrentVerifiedKeys;
  if (!keys || typeof keys !== "object" || typeof ensureAsset !== "function") return;
  for (const [indexValue, key] of Object.entries(keys)) {
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0) continue;
    if (typeof key !== "string" || !key) continue;
    ensureAsset(job, index).torrentVerifiedKey = key;
  }
}

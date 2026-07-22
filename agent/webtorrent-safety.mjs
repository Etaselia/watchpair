import Torrent from "webtorrent/lib/torrent.js";

const PATCH_MARKER = Symbol.for("watchpair.webtorrent.scheduler-guard");

export function normalizedTorrentFileProgress(file) {
  return file?.done ? 1 : Number(file?.progress || 0);
}

export function installWebTorrentSafetyGuards() {
  const prototype = Torrent.prototype;
  if (prototype[PATCH_MARKER]) return;

  const request = prototype._request;
  prototype._request = function requestAvailablePiece(wire, index, hotswap) {
    // Resume verification can leave a stale selection pointing at a null piece.
    // Treat it as unavailable so the scheduler can collect it on the next tick.
    if (!this.pieces?.[index]) return false;
    return request.call(this, wire, index, hotswap);
  };

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    value: true,
  });
}

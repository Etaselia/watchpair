import Torrent from "webtorrent/lib/torrent.js";

const PATCH_MARKER = Symbol.for("watchpair.webtorrent.scheduler-guard");
const BITFIELD_MARKER = Symbol.for("watchpair.webtorrent.bitfield-guard");

export function stabilizeTorrentPieceState(torrent) {
  const bitfield = torrent?.bitfield;
  if (!bitfield || bitfield[BITFIELD_MARKER]) return;

  const get = bitfield.get.bind(bitfield);
  bitfield.get = function getConsistentPieceState(index) {
    const pieces = torrent.pieces;
    if (Number.isInteger(index) && index >= 0 && index < pieces.length && pieces[index] === null) {
      return true;
    }
    return get(index);
  };

  Object.defineProperty(bitfield, BITFIELD_MARKER, {
    configurable: false,
    value: true,
  });
}

export function normalizedTorrentFileProgress(file) {
  if (file?.done) return 1;
  const measured = Number(file?.progress || 0);
  const progress = Number.isFinite(measured) ? Math.max(0, measured) : 0;
  return Math.min(0.999, progress);
}

export function monotonicTorrentFileProgress(file, previous = 0) {
  return Math.max(normalizedTorrentFileProgress(file), Math.max(0, Math.min(1, Number(previous) || 0)));
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

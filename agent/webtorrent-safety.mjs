import Torrent from "webtorrent/lib/torrent.js";
import { NETWORK_SILENCED } from "./network-control.mjs";

const PATCH_MARKER = Symbol.for("watchpair.webtorrent.scheduler-guard");
const RECOVERY_MARKER = Symbol.for("watchpair.webtorrent.piece-recovery");
const PIECE_TRACKING_MARKER = Symbol.for("watchpair.webtorrent.piece-source-tracking");
const PIECE_SOURCES = Symbol.for("watchpair.webtorrent.piece-sources");
const PEER_STRIKES = Symbol.for("watchpair.webtorrent.peer-strikes");
const WIRE_PATCH_MARKER = Symbol.for("watchpair.webtorrent.wire-buffer-copy");

export function verifiedTorrentFileProgress(file) {
  const torrent = file?._torrent;
  if (!torrent?.bitfield || !file?.length) return file?.done ? 1 : 0;

  const fileStart = file.offset;
  const fileEnd = fileStart + file.length;
  let verified = 0;
  for (let index = file._startPiece; index <= file._endPiece; index += 1) {
    if (!torrent.bitfield.get(index)) continue;
    const pieceStart = index * torrent.pieceLength;
    const pieceLength = index === torrent.pieces.length - 1
      ? torrent.lastPieceLength
      : torrent.pieceLength;
    const pieceEnd = pieceStart + pieceLength;
    verified += Math.max(0, Math.min(fileEnd, pieceEnd) - Math.max(fileStart, pieceStart));
  }
  return Math.min(1, verified / file.length);
}

export function verifyTorrentFilePieces(file) {
  const torrent = file?._torrent;
  if (!torrent?._verifyPiecesUsingHash || !torrent?.bitfield) {
    return Promise.reject(new Error("Torrent file verification is unavailable."));
  }

  const pieces = [];
  for (let index = file._startPiece; index <= file._endPiece; index += 1) {
    pieces.push(index);
  }

  return new Promise((resolve, reject) => {
    torrent._verifyPiecesUsingHash(pieces, (error) => {
      if (error) {
        reject(error);
        return;
      }
      torrent._checkDone?.();
      const invalidPieces = pieces.filter((index) => !torrent.bitfield.get(index));
      resolve({ verified: invalidPieces.length === 0, invalidPieces });
    });
  });
}

function rewindSelectedFile(getSelectedFile) {
  const file = getSelectedFile?.();
  if (!file || file.done) return;
  file.deselect();
  file.select(10);
}

function rememberPieceSources(torrent, index, piece) {
  if (!piece || piece[PIECE_TRACKING_MARKER]) return;
  const flush = piece.flush.bind(piece);
  piece.flush = function flushWithSources() {
    const sources = Array.isArray(piece.sources) ? [...piece.sources] : [];
    const buffer = flush();
    if (buffer) {
      torrent[PIECE_SOURCES] ??= new Map();
      torrent[PIECE_SOURCES].set(index, sources);
    }
    return buffer;
  };
  Object.defineProperty(piece, PIECE_TRACKING_MARKER, { value: true });
}

function rejectFailedPieceSources(torrent, index) {
  const sourceMap = torrent[PIECE_SOURCES];
  const sources = sourceMap?.get(index) || [];
  sourceMap?.delete(index);
  torrent[PEER_STRIKES] ??= new Map();

  let disconnected = 0;
  for (const wire of sources) {
    const strikes = (torrent[PEER_STRIKES].get(wire) || 0) + 1;
    torrent[PEER_STRIKES].set(wire, strikes);
    if (sources.length === 1 || strikes >= 2) {
      wire.destroy();
      torrent[PEER_STRIKES].delete(wire);
      disconnected += 1;
    }
  }
  return { sources: sources.length, disconnected };
}

export function installTorrentPieceRecovery(torrent, getSelectedFile, onRecovery) {
  if (!torrent || torrent[RECOVERY_MARKER]) return;

  const markUnverified = torrent._markUnverified.bind(torrent);
  torrent._markUnverified = function markUnverifiedAndRewind(index) {
    const wasVerified = Boolean(torrent.bitfield?.get?.(index)) || torrent.pieces?.[index] === null;
    markUnverified(index);
    if (!wasVerified) return;
    rewindSelectedFile(getSelectedFile);
    onRecovery?.({ index, reason: "disk-verification", sources: 0, disconnected: 0 });
  };

  torrent.on("warning", (error) => {
    const match = /^Piece (\d+) failed verification$/.exec(error?.message || "");
    if (!match) return;
    const index = Number(match[1]);
    const result = rejectFailedPieceSources(torrent, index);
    rewindSelectedFile(getSelectedFile);
    onRecovery?.({ index, reason: "peer-verification", ...result });
  });

  Object.defineProperty(torrent, RECOVERY_MARKER, { value: true });
}

export function stabilizeWireBitfieldWrites(wire) {
  if (!wire || wire[WIRE_PATCH_MARKER]) return;
  const sendBitfield = wire.bitfield.bind(wire);
  wire.bitfield = function sendBitfieldCopy(bitfield) {
    const bytes = ArrayBuffer.isView(bitfield) ? bitfield : bitfield.buffer;
    return sendBitfield(new Uint8Array(bytes));
  };
  Object.defineProperty(wire, WIRE_PATCH_MARKER, { value: true });
}

export function installWebTorrentSafetyGuards() {
  const prototype = Torrent.prototype;
  if (prototype[PATCH_MARKER]) return;

  const onWire = prototype._onWire;
  prototype._onWire = function onWireWithBufferCopies(wire, ...args) {
    stabilizeWireBitfieldWrites(wire);
    return onWire.call(this, wire, ...args);
  };

  const startDiscovery = prototype._startDiscovery;
  prototype._startDiscovery = function startDiscoveryUnlessSilenced() {
    if (this[NETWORK_SILENCED]) {
      this._debug("network control: ignoring _startDiscovery while silenced");
      return;
    }
    return startDiscovery.call(this);
  };

  const request = prototype._request;
  prototype._request = function requestAvailablePiece(wire, index, hotswap) {
    // Resume verification can leave a stale selection pointing at a null piece.
    // Treat it as unavailable so the scheduler can collect it on the next tick.
    const piece = this.pieces?.[index];
    if (!piece) return false;
    rememberPieceSources(this, index, piece);
    return request.call(this, wire, index, hotswap);
  };

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    value: true,
  });
}

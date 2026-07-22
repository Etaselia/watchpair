import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebTorrent from "webtorrent";
import Torrent from "webtorrent/lib/torrent.js";
import { installTorrentPieceRecovery, installWebTorrentSafetyGuards, stabilizeWireBitfieldWrites, verifiedTorrentFileProgress } from "../agent/webtorrent-safety.mjs";

installWebTorrentSafetyGuards();

test("torrent guards preserve verified state and skip stale requests", () => {
  installWebTorrentSafetyGuards();

  const torrent = Object.create(Torrent.prototype);
  torrent.pieces = [null];
  assert.equal(torrent._request({ requests: [] }, 0, false), false);

  const sourceBitfield = { buffer: new Uint8Array([0xa5]) };
  const wire = { bitfield: (bytes) => bytes.fill(0) };
  stabilizeWireBitfieldWrites(wire);
  stabilizeWireBitfieldWrites(wire);
  wire.bitfield(sourceBitfield);
  assert.equal(sourceBitfield.buffer[0], 0xa5, "encrypted wire writes must not mutate the torrent bitfield");

  const verifiedFile = {
    _torrent: {
      bitfield: { buffer: new Uint8Array([0xa0]) },
      pieceLength: 10,
      lastPieceLength: 5,
      pieces: [null, {}, null],
    },
    _startPiece: 0,
    _endPiece: 2,
    offset: 0,
    length: 25,
    done: false,
  };
  assert.equal(verifiedTorrentFileProgress(verifiedFile), 0.6);
});

test("piece recovery rewinds the selected file", () => {
  const torrent = new EventEmitter();
  const invalidated = [];
  torrent._markUnverified = (index) => invalidated.push(index);
  const calls = [];
  const file = {
    done: false,
    deselect: () => calls.push("deselect"),
    select: (priority) => calls.push("select:" + priority),
  };
  const recoveries = [];

  installTorrentPieceRecovery(torrent, () => file, (event) => recoveries.push(event));
  torrent._markUnverified(4);
  torrent.emit("warning", new Error("Piece 8 failed verification"));

  assert.deepEqual(invalidated, [4]);
  assert.deepEqual(calls, ["deselect", "select:10", "deselect", "select:10"]);
  assert.deepEqual(recoveries.map((event) => [event.index, event.reason]), [
    [4, "disk-verification"],
    [8, "peer-verification"],
  ]);
});

test("downloads and verifies missing pieces when resuming a partial file", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-torrent-"));
  const seedDirectory = path.join(directory, "seed");
  const downloadDirectory = path.join(directory, "download");
  const fileName = "resume-test.bin";
  const sourcePath = path.join(seedDirectory, fileName);
  const downloadPath = path.join(downloadDirectory, fileName);
  const contents = randomBytes(8 * 1024 * 1024);
  const seeder = createLocalClient();
  const leecher = createLocalClient();

  try {
    await mkdir(seedDirectory);
    await mkdir(downloadDirectory);
    await writeFile(sourcePath, contents);

    const seeded = await seedFile(seeder, sourcePath);
    const partial = Buffer.from(contents);
    partial.fill(0, 2 * 1024 * 1024, 6 * 1024 * 1024);
    await writeFile(downloadPath, partial);

    const torrent = leecher.add(seeded.torrentFile, { path: downloadDirectory });
    torrent.once("metadata", () => {
      torrent.files.forEach((file) => file.deselect());
      torrent.files[0].select(10);
    });

    let downloaded = 0;
    let usedSlowPeerRanking = false;
    torrent.on("wire", (wire) => {
      wire.downloadSpeed = () => 1;
      usedSlowPeerRanking = true;
    });
    torrent.on("download", (bytes) => {
      downloaded += bytes;
    });

    await waitForEvent(torrent, "infoHash");
    const completed = waitForEvent(torrent, "done", 25_000);
    torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await completed;

    assert.ok(usedSlowPeerRanking, "Expected a connected wire to use slow-peer ranking");
    assert.ok(downloaded > 0, "Expected missing pieces to be transferred");
    assert.equal(Buffer.compare(await readFile(downloadPath), contents), 0);
  } finally {
    await Promise.all([destroyClient(leecher), destroyClient(seeder)]);
    await rm(directory, { recursive: true, force: true });
  }
});

function createLocalClient() {
  return new WebTorrent({
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    tracker: false,
    utp: false,
  });
}

function seedFile(client, filePath) {
  return new Promise((resolve, reject) => {
    const torrent = client.seed(filePath, { announce: [], pieceLength: 64 * 1024 }, resolve);
    torrent.once("error", reject);
  });
}

function waitForEvent(emitter, event, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    const onEvent = (...values) => {
      cleanup();
      resolve(values);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      emitter.removeListener("error", onError);
    };
    emitter.once(event, onEvent);
    emitter.once("error", onError);
  });
}

function destroyClient(client) {
  if (client.destroyed) return Promise.resolve();
  return new Promise((resolve) => client.destroy(resolve));
}

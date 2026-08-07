import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTorrentConnectionPlan,
  torrentConnectionPlan,
  torrentRoleConnectionLimits,
} from "../agent/torrent-pressure.mjs";

test("shares a bounded connection budget across active torrents", () => {
  assert.deepEqual(torrentConnectionPlan("fast", 8), {
    resourceMode: "fast",
    torrentCount: 8,
    totalBudget: 32,
    perTorrentLimit: 4,
  });
  assert.equal(
    torrentConnectionPlan("balanced", 2, { totalBudget: "12" }).perTorrentLimit,
    6
  );
});

test("applies the connection plan and trims the least active peers", () => {
  const torrents = Array.from({ length: 8 }, () => ({
    wires: Array.from({ length: 6 }, (_, index) => ({
      index,
      destroyed: false,
      downloadSpeed: () => index,
      uploadSpeed: () => 0,
      destroy() {
        this.destroyed = true;
      },
    })),
  }));
  const client = { maxConns: 55, torrents };

  const result = applyTorrentConnectionPlan(client, { mode: "fast" });

  assert.equal(client.maxConns, 4);
  assert.equal(result.trimmedPeers, 16);
  for (const torrent of torrents) {
    assert.deepEqual(
      torrent.wires.filter((wire) => wire.destroyed).map((wire) => wire.index),
      [0, 1]
    );
  }
});

test("reserves most connections for foreground while backgrounds and seeds retain peers", () => {
  assert.deepEqual(
    torrentRoleConnectionLimits(
      ["foreground", "background", "background", "metadata"],
      { totalBudget: 20, foregroundShare: 0.75 }
    ),
    [15, 2, 2, 1]
  );
  assert.deepEqual(
    torrentRoleConnectionLimits(
      ["foreground", "seed"],
      { totalBudget: 20, foregroundShare: 0.75 }
    ),
    [15, 5]
  );
});

test("applies per-torrent limits without dropping metadata connectivity", () => {
  const torrents = Array.from({ length: 3 }, (_, torrentIndex) => ({
    torrentIndex,
    paused: false,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    wires: Array.from({ length: 8 }, (_, index) => ({
      index,
      destroyed: false,
      downloadSpeed: () => index,
      uploadSpeed: () => 0,
      destroy() {
        this.destroyed = true;
      },
    })),
  }));
  const client = { maxConns: 55, torrents };
  const limits = [7, 2, 1];

  const result = applyTorrentConnectionPlan(client, {
    mode: "balanced",
    totalBudget: 10,
    limitForTorrent: (torrent) => limits[torrent.torrentIndex],
  });

  assert.equal(client.maxConns, 7);
  assert.deepEqual(result.torrentLimits, limits);
  assert.deepEqual(
    torrents.map((torrent) => torrent.wires.filter((wire) => !wire.destroyed).length),
    limits
  );
  assert.equal(result.pausedTorrents, 3);
  assert.equal(torrents.every((torrent) => torrent.paused), true);

  const expanded = applyTorrentConnectionPlan(client, {
    mode: "balanced",
    totalBudget: 24,
    limitForTorrent: () => 8,
  });
  assert.equal(expanded.pausedTorrents, 0);
  assert.equal(torrents.every((torrent) => !torrent.paused), true);
});

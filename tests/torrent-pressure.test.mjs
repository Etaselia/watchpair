import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTorrentConnectionPlan,
  torrentConnectionPlan,
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

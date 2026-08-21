import assert from "node:assert/strict";
import test from "node:test";
import {
  NETWORK_SILENCED,
  SILENCED_DISCOVERY,
  liveTorrentPeerCount,
  normalizeNetworkSettings,
  restoreTorrentNetworking,
  silenceTorrentNetworking,
  torrentDiscoverySilenced,
  torrentSelectedFilesComplete,
} from "../agent/network-control.mjs";

function fakeDiscovery(destroyed = false) {
  const discovery = {
    destroyed,
    tracker: destroyed ? null : { start() {}, stop() {}, update() {}, destroy() {} },
    dht: destroyed ? null : {},
    lsd: destroyed ? null : {},
    destroy() {
      this.destroyed = true;
      this.tracker = null;
      this.dht = null;
      this.lsd = null;
    },
  };
  return discovery;
}

function fakeTorrent({ destroyed = false, discovery = fakeDiscovery(false), wireCount = 0 } = {}) {
  const torrent = {
    destroyed,
    paused: false,
    discovery,
    wires: Array.from({ length: wireCount }, () => ({
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    })),
    pause() {
      torrent.paused = true;
    },
    resume() {
      torrent.paused = false;
    },
    _startDiscovery() {
      torrent.discovery = fakeDiscovery(false);
    },
  };
  return torrent;
}

test("normalizeNetworkSettings defaults to enabled and online", () => {
  assert.deepEqual(normalizeNetworkSettings(), { torrentEnabled: true, offline: false });
  assert.deepEqual(normalizeNetworkSettings(null), { torrentEnabled: true, offline: false });
  assert.deepEqual(normalizeNetworkSettings({}), { torrentEnabled: true, offline: false });
  assert.deepEqual(normalizeNetworkSettings({ torrentEnabled: false }), {
    torrentEnabled: false,
    offline: false,
  });
  assert.deepEqual(normalizeNetworkSettings({ offline: true }), {
    torrentEnabled: true,
    offline: true,
  });
  assert.deepEqual(normalizeNetworkSettings({ torrentEnabled: false, offline: true }), {
    torrentEnabled: false,
    offline: true,
  });
  assert.deepEqual(normalizeNetworkSettings({ torrentEnabled: true, offline: false }), {
    torrentEnabled: true,
    offline: false,
  });
});

test("liveTorrentPeerCount counts only live wires", () => {
  const torrent = {
    wires: [{ destroyed: false }, { destroyed: true }, null, { destroyed: false }],
  };
  assert.equal(liveTorrentPeerCount(torrent), 2);
  assert.equal(liveTorrentPeerCount(null), 0);
  assert.equal(liveTorrentPeerCount({}), 0);
});

test("silenceTorrentNetworking stops announces, pauses, and drops wires", () => {
  const discovery = fakeDiscovery(false);
  const torrent = fakeTorrent({ discovery, wireCount: 3 });
  assert.equal(silenceTorrentNetworking(torrent), true);
  assert.equal(discovery.destroyed, true);
  assert.equal(torrent.discovery, SILENCED_DISCOVERY);
  assert.equal(torrent.paused, true);
  assert.equal(torrent.wires.every((wire) => wire.destroyed), true);
  assert.equal(torrentDiscoverySilenced(torrent), true);
  assert.equal(torrent[NETWORK_SILENCED], true);
});

test("silenceTorrentNetworking tolerates missing discovery and destroyed torrents", () => {
  assert.equal(silenceTorrentNetworking(null), false);
  assert.equal(silenceTorrentNetworking({ destroyed: true }), false);
  const torrent = fakeTorrent({ discovery: null, wireCount: 2 });
  assert.equal(silenceTorrentNetworking(torrent), true);
  assert.equal(torrent.paused, true);
  assert.equal(torrent.discovery, null);
  assert.equal(torrent.wires.every((wire) => wire.destroyed), true);
  // The marker still blocks _startDiscovery even though no discovery existed.
  assert.equal(torrent[NETWORK_SILENCED], true);
});

test("silenceTorrentNetworking is idempotent", () => {
  const torrent = fakeTorrent({ wireCount: 1 });
  silenceTorrentNetworking(torrent);
  const discovery = torrent.discovery;
  assert.equal(silenceTorrentNetworking(torrent), true);
  assert.equal(torrent.discovery, discovery);
  assert.equal(torrent.paused, true);
});

test("restoreTorrentNetworking resumes and recreates discovery", () => {
  const torrent = fakeTorrent({ discovery: fakeDiscovery(true) });
  torrent.pause();
  torrent[NETWORK_SILENCED] = true;
  assert.equal(restoreTorrentNetworking(torrent), true);
  assert.equal(torrent.paused, false);
  assert.equal(torrent[NETWORK_SILENCED], undefined);
  // _startDiscovery replaced the silenced stub with a live discovery instance
  assert.notEqual(torrent.discovery, SILENCED_DISCOVERY);
  assert.equal(torrent.discovery?.destroyed, false);
  assert.equal(torrentDiscoverySilenced(torrent), false);
});

test("restoreTorrentNetworking does not recreate live discovery", () => {
  const live = fakeDiscovery(false);
  const torrent = fakeTorrent({ discovery: live });
  let startCalls = 0;
  torrent._startDiscovery = () => {
    startCalls += 1;
    torrent.discovery = fakeDiscovery(false);
  };
  restoreTorrentNetworking(torrent);
  assert.equal(startCalls, 0);
  assert.equal(torrent.discovery, live);
});

test("restoreTorrentNetworking ignores destroyed torrents", () => {
  assert.equal(restoreTorrentNetworking(null), false);
  assert.equal(restoreTorrentNetworking({ destroyed: true }), false);
});

test("torrentSelectedFilesComplete requires every index to be done", () => {
  const torrent = { files: [{ done: true }, { done: true }, { done: false }] };
  assert.equal(torrentSelectedFilesComplete(torrent, [0, 1]), true);
  assert.equal(torrentSelectedFilesComplete(torrent, [0, 1, 2]), false);
  assert.equal(torrentSelectedFilesComplete(torrent, [0, 7]), false);
  assert.equal(torrentSelectedFilesComplete(torrent, []), false);
  assert.equal(torrentSelectedFilesComplete(torrent, null), false);
  assert.equal(torrentSelectedFilesComplete(null, [0]), false);
  assert.equal(torrentSelectedFilesComplete({ files: [] }, [0]), false);
  assert.equal(torrentSelectedFilesComplete({}, [0]), false);
});

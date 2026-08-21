/**
 * Network-control primitives for the WatchPair agent.
 *
 * These helpers manipulate a WebTorrent torrent's networking surface without
 * destroying the torrent object, so on-disk file streaming keeps working:
 *
 *  - silence: stop tracker/DHT/LSD announces (destroy torrent-discovery),
 *    pause the torrent (no new peer dialing, no downloads), and drop existing
 *    peer wires.
 *  - restore: resume the torrent and recreate torrent-discovery so announces
 *    and peer discovery start again.
 *
 * A torrent's discovery is a `torrent-discovery` instance. Its `destroy(cb)`
 * stops every announce and clears the DHT re-announce timer, but the torrent
 * object keeps referencing the destroyed instance. webtorrent internals then
 * behave as follows:
 *
 *  - `torrent._checkDone()` touches `torrent.discovery.complete()` and
 *    `torrent.discovery.tracker?.start()` — both are safe no-ops against the
 *    destroyed instance (its sub-clients are nulled).
 *  - `torrent._destroy()` calls `discovery.destroy(cb)`, which returns early
 *    without invoking `cb` when already destroyed — that would hang
 *    `torrent.destroy(cb)` forever. We therefore swap the destroyed instance
 *    for a frozen stub whose `destroy(cb)` always invokes `cb`.
 *  - `torrent._startDiscovery()` refuses to run while `torrent.discovery` is
 *    truthy, so the stub also prevents announces from being resurrected
 *    accidentally while a torrent is silenced.
 *
 * Restoring sets `torrent.discovery = null` and re-invokes `_startDiscovery()`
 * (both synchronous), which recreates the discovery with the torrent's own
 * announce list and the client's shared DHT node.
 */

export const SILENCED_DISCOVERY = Object.freeze({
  destroyed: true,
  tracker: null,
  dht: null,
  lsd: null,
  complete() {},
  destroy(callback) {
    if (typeof callback === "function") callback();
  },
});

/**
 * Marker applied to a torrent object while its networking is silenced.
 * `webtorrent-safety.mjs` guards `torrent._startDiscovery()` with it, so a
 * torrent whose discovery had not been created yet (metadata/seeding setup is
 * asynchronous) can never start announcing while silenced.
 */
export const NETWORK_SILENCED = Symbol.for("watchpair.network-control.silenced");

export function normalizeNetworkSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    torrentEnabled: source.torrentEnabled === false ? false : true,
    offline: source.offline === true ? true : false,
  };
}

/**
 * Count live (non-destroyed) peer wires. `torrent.numPeers` cannot be used for
 * this: webtorrent's `wires` array is append-only in this version, so it counts
 * every wire that ever connected.
 */
export function liveTorrentPeerCount(torrent) {
  if (!torrent || !Array.isArray(torrent.wires)) return 0;
  let count = 0;
  for (const wire of torrent.wires) {
    if (wire && !wire.destroyed) count += 1;
  }
  return count;
}

export function torrentDiscoverySilenced(torrent) {
  return Boolean(torrent?.discovery?.destroyed);
}

/**
 * True when every listed file index is fully downloaded. Empty or invalid
 * index lists are never "complete" so a torrent with nothing to download is
 * never silenced.
 */
export function torrentSelectedFilesComplete(torrent, indexes) {
  if (!torrent || !Array.isArray(torrent.files) || !torrent.files.length) return false;
  if (!Array.isArray(indexes) || indexes.length === 0) return false;
  for (const index of indexes) {
    if (!torrent.files[index] || torrent.files[index].done !== true) return false;
  }
  return true;
}

export function silenceTorrentNetworking(torrent, { destroyWires = true } = {}) {
  if (!torrent || torrent.destroyed) return false;
  torrent[NETWORK_SILENCED] = true;
  const discovery = torrent.discovery;
  if (discovery && !discovery.destroyed) {
    discovery.destroy();
  }
  if (discovery) torrent.discovery = SILENCED_DISCOVERY;
  if (typeof torrent.pause === "function") torrent.pause();
  if (destroyWires && Array.isArray(torrent.wires)) {
    for (const wire of torrent.wires) {
      if (!wire) continue;
      try {
        if (!wire.destroyed) wire.destroy();
      } catch {
        // A wire can close while the silence is being applied.
      }
    }
  }
  return true;
}

export function restoreTorrentNetworking(torrent) {
  if (!torrent || torrent.destroyed) return false;
  delete torrent[NETWORK_SILENCED];
  if (typeof torrent.resume === "function") torrent.resume();
  if (!torrent.discovery || torrent.discovery.destroyed) {
    torrent.discovery = null;
    if (typeof torrent._startDiscovery === "function") torrent._startDiscovery();
  }
  return true;
}

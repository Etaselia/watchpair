const RESOURCE_LIMITS = Object.freeze({
  eco: { total: 10, perTorrent: 6 },
  balanced: { total: 20, perTorrent: 10 },
  fast: { total: 32, perTorrent: 16 },
});

function normalizedMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return RESOURCE_LIMITS[mode] ? mode : "balanced";
}

function normalizedBudget(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(4, Math.min(256, Math.floor(parsed)))
    : fallback;
}

export function torrentConnectionPlan(
  mode,
  torrentCount,
  { totalBudget } = {},
) {
  const resourceMode = normalizedMode(mode);
  const limits = RESOURCE_LIMITS[resourceMode];
  const count = Math.max(1, Math.floor(Number(torrentCount) || 0));
  const budget = normalizedBudget(totalBudget, limits.total);
  const perTorrentLimit = Math.max(2, Math.min(limits.perTorrent, Math.floor(budget / count)));
  return {
    resourceMode,
    torrentCount: Math.max(0, Math.floor(Number(torrentCount) || 0)),
    totalBudget: budget,
    perTorrentLimit,
  };
}

function wireScore(wire) {
  const speed = (typeof wire.downloadSpeed === "function" ? wire.downloadSpeed() : 0) +
    (typeof wire.uploadSpeed === "function" ? wire.uploadSpeed() : 0);
  return speed + (wire.peerInterested ? 1 : 0) + (wire.amInterested ? 1 : 0);
}

export function applyTorrentConnectionPlan(
  client,
  { mode, totalBudget, trim = true } = {},
) {
  const torrents = Array.isArray(client?.torrents) ? client.torrents : [];
  const plan = torrentConnectionPlan(mode, torrents.length, { totalBudget });
  client.maxConns = plan.perTorrentLimit;

  let trimmedPeers = 0;
  if (trim) {
    for (const torrent of torrents) {
      const wires = Array.isArray(torrent?.wires) ? [...torrent.wires] : [];
      if (wires.length <= plan.perTorrentLimit) continue;
      wires.sort((left, right) => wireScore(right) - wireScore(left));
      for (const wire of wires.slice(plan.perTorrentLimit)) {
        try {
          wire.destroy();
          trimmedPeers += 1;
        } catch {
          // A wire can close between the snapshot and pressure adjustment.
        }
      }
    }
  }

  return { ...plan, trimmedPeers };
}

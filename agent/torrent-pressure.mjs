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

export function torrentRoleConnectionLimits(
  roles,
  { totalBudget = 20, foregroundShare = 0.75 } = {},
) {
  const normalizedRoles = Array.isArray(roles) ? roles : [];
  if (!normalizedRoles.length) return [];
  const budget = Math.max(normalizedRoles.length, normalizedBudget(totalBudget, 20));
  const targetShare = Math.max(0.55, Math.min(0.9, Number(foregroundShare) || 0.75));
  const limits = normalizedRoles.map(() => 1);
  const foregroundIndex = normalizedRoles.indexOf("foreground");
  const secondaryIndexes = normalizedRoles
    .map((role, index) => (role === "background" || role === "seed") ? index : -1)
    .filter((index) => index >= 0);
  let remaining = budget - limits.length;

  if (foregroundIndex >= 0 && remaining > 0) {
    const foregroundTarget = Math.max(1, Math.floor(budget * targetShare));
    const foregroundExtra = Math.min(remaining, foregroundTarget - limits[foregroundIndex]);
    limits[foregroundIndex] += Math.max(0, foregroundExtra);
    remaining -= Math.max(0, foregroundExtra);
  }

  const activeIndexes = secondaryIndexes.length
    ? secondaryIndexes
    : foregroundIndex >= 0 ? [foregroundIndex] : normalizedRoles.map((_, index) => index);
  let cursor = 0;
  while (remaining > 0 && activeIndexes.length) {
    limits[activeIndexes[cursor % activeIndexes.length]] += 1;
    cursor += 1;
    remaining -= 1;
  }
  return limits;
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
  { mode, totalBudget, trim = true, limitForTorrent, skipTorrent } = {},
) {
  const torrents = Array.isArray(client?.torrents) ? client.torrents : [];
  const plan = torrentConnectionPlan(mode, torrents.length, { totalBudget });
  const torrentLimits = torrents.map((torrent, index) => {
    const requested = limitForTorrent?.(torrent, index, plan);
    return Number.isFinite(Number(requested))
      ? Math.max(1, Math.min(plan.totalBudget, Math.floor(Number(requested))))
      : plan.perTorrentLimit;
  });
  client.maxConns = torrentLimits.length
    ? Math.max(...torrentLimits)
    : plan.perTorrentLimit;

  let trimmedPeers = 0;
  let pausedTorrents = 0;
  if (trim) {
    for (const [torrentIndex, torrent] of torrents.entries()) {
      // Silenced torrents (network kill switch / offline mode / finished
      // non-shared downloads) must stay paused and wire-free: pausing is what
      // rejects inbound peer connections, so the pressure plan must not resume
      // them just because they have no live connections.
      if (typeof skipTorrent === "function" && skipTorrent(torrent)) continue;
      const wires = Array.isArray(torrent?.wires) ? torrent.wires.filter((wire) => !wire.destroyed) : [];
      const limit = torrentLimits[torrentIndex] ?? plan.perTorrentLimit;
      if (wires.length > limit) {
        wires.sort((left, right) => wireScore(right) - wireScore(left));
        for (const wire of wires.slice(limit)) {
          try {
            wire.destroy();
            trimmedPeers += 1;
          } catch {
            // A wire can close between the snapshot and pressure adjustment.
          }
        }
      }

      if (typeof limitForTorrent === "function") {
        const liveConnections = wires.filter((wire) => !wire.destroyed).length;
        // pause() only stops new peer dialing; selected pieces keep flowing on live wires.
        if (liveConnections >= limit && typeof torrent?.pause === "function") {
          torrent.pause();
          pausedTorrents += 1;
        } else if (torrent?.paused && typeof torrent.resume === "function") {
          torrent.resume();
        }
      }
    }
  }

  return {
    ...plan,
    maxPerTorrentLimit: client.maxConns,
    torrentLimits,
    trimmedPeers,
    pausedTorrents,
  };
}

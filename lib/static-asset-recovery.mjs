export const STATIC_ASSET_RELOAD_KEY = "watchpair:static-asset-reload-at";
export const STATIC_ASSET_REJOIN_KEY = "watchpair:static-asset-rejoin-at";
export const STATIC_ASSET_RECOVERY_WINDOW_MS = 30_000;

const staticChunkModulePattern = /^\/_next\/static\/chunks\/[^/]+\.js$/;

/** @param {string} pathname */
export function isStaticChunkModule(pathname) {
  return staticChunkModulePattern.test(pathname);
}

/** @param {number} status */
export function isMissingStaticAssetStatus(status) {
  return status === 404 || status === 410;
}

function recoveryAttemptSource() {
  return `
const now = Date.now();
let shouldReload = false;
try {
  const lastReload = Number.parseInt(sessionStorage.getItem(${JSON.stringify(STATIC_ASSET_RELOAD_KEY)}) || "0", 10);
  if (!Number.isFinite(lastReload) || lastReload > now || now - lastReload > ${STATIC_ASSET_RECOVERY_WINDOW_MS}) {
    sessionStorage.setItem(${JSON.stringify(STATIC_ASSET_RELOAD_KEY)}, String(now));
    sessionStorage.setItem(${JSON.stringify(STATIC_ASSET_REJOIN_KEY)}, String(now));
    shouldReload = sessionStorage.getItem(${JSON.stringify(STATIC_ASSET_RELOAD_KEY)}) === String(now);
  }
} catch {}
if (shouldReload) {
  location.reload();
}
`.trim();
}

/** @param {string | null | undefined} value @param {number} [now] */
export function isRecentStaticAssetRecovery(value, now = Date.now()) {
  const recoveredAt = Number.parseInt(value || "0", 10);
  return Number.isFinite(recoveredAt) && recoveredAt > 0 && recoveredAt <= now && now - recoveredAt <= STATIC_ASSET_RECOVERY_WINDOW_MS;
}

/** @param {{ participants?: Array<{ deviceId?: string }> } | null | undefined} session @param {string} deviceId */
export function activeRecoverySession(session, deviceId) {
  if (!session || !deviceId || !Array.isArray(session.participants)) return null;
  return session.participants.some((participant) => participant.deviceId === deviceId)
    ? session
    : null;
}

export function staticChunkRecoveryModule() {
  return `${recoveryAttemptSource()}
if (shouldReload) await new Promise(() => {});
throw new Error("WatchPair was updated. Refresh this tab to continue.");
export {};\n`;
}

export function staticAssetRecoveryBootstrap() {
  return `(() => {
  addEventListener("vite:preloadError", (event) => {
    ${recoveryAttemptSource()}
    if (shouldReload) event.preventDefault();
  });
})();`;
}

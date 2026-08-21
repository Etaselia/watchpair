/**
 * Derive a stable, opaque lease identifier without sending or persisting a raw
 * room token. The per-browser secret prevents the short room code from being
 * recovered by enumerating candidate codes against an observed lease id, and
 * the per-tab id keeps one tab from releasing another tab's room lease.
 */
export async function opaqueSeedLeaseId({ secret, tabId, roomToken, deviceId, sourceId }) {
  const payload = new TextEncoder().encode(
    [String(secret), String(tabId), String(roomToken), String(deviceId), String(sourceId)].join("\u0000")
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `lease-${hex}`;
}

const BTIH_PATTERN = /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

export function isSupportedMagnet(value) {
  if (typeof value !== "string") return false;

  const magnet = value.trim();
  if (!/^magnet:\?/i.test(magnet)) return false;

  try {
    const query = magnet.slice(magnet.indexOf("?") + 1);
    return new URLSearchParams(query).getAll("xt").some((topic) => BTIH_PATTERN.test(topic));
  } catch {
    return false;
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Btih(value) {
  if (!/^[A-Z2-7]{32}$/.test(value)) return null;
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== 20 || bits !== 0) return null;
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return the canonical v1 BitTorrent info hash carried by a magnet URI. */
export function magnetInfoHash(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "magnet:") return null;
  for (const exactTopic of url.searchParams.getAll("xt")) {
    const match = /^urn:btih:([a-z0-9]+)$/i.exec(exactTopic.trim());
    if (!match) continue;
    if (/^[a-f0-9]{40}$/i.test(match[1])) return match[1].toLowerCase();
    const decoded = base32Btih(match[1].toUpperCase());
    if (decoded) return decoded;
  }
  return null;
}

export function sameMagnetContent(left, right) {
  const leftHash = magnetInfoHash(left);
  return Boolean(leftHash && leftHash === magnetInfoHash(right));
}

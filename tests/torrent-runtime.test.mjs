import assert from "node:assert/strict";
import test from "node:test";
import WebTorrent from "webtorrent";
import { isSupportedMagnet } from "../agent/torrent-input.mjs";

const INFO_HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const VALID_MAGNET = `magnet:?xt=urn:btih:${INFO_HASH}&dn=Sintel`;

test("accepts valid v1 and hybrid magnets and rejects malformed inputs", () => {
  assert.equal(isSupportedMagnet(VALID_MAGNET), true);
  assert.equal(isSupportedMagnet(`  MAGNET:?xt=urn:btih:${INFO_HASH}  `), true);
  assert.equal(
    isSupportedMagnet(`magnet:?xt=urn:btmh:1220${"a".repeat(64)}&xt=urn:btih:${INFO_HASH}`),
    true,
  );
  assert.equal(isSupportedMagnet("magnet:?dn=Missing+hash"), false);
  assert.equal(isSupportedMagnet(`magnet:?xt=urn:btmh:1220${"a".repeat(64)}`), false);
});

test("WebTorrent parses a valid magnet without terminating the process", async () => {
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false });
  try {
    const torrent = client.add(VALID_MAGNET);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      torrent.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(torrent.infoHash, INFO_HASH);
  } finally {
    await new Promise((resolve) => client.destroy(resolve));
  }
});

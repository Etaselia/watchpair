import assert from "node:assert/strict";
import test from "node:test";
import { magnetInfoHash, sameMagnetContent } from "../lib/magnet-identity.mjs";

const HASH = "0123456789abcdef0123456789abcdef01234567";

test("normalizes hexadecimal magnet identities independent of display and trackers", () => {
  const first = `magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=First&tr=https%3A%2F%2Ftracker.example%2Fa`;
  const second = `magnet:?dn=Second&xt=urn%3Abtih%3A${HASH}&tr=udp%3A%2F%2Ftracker.example%3A80`;
  assert.equal(magnetInfoHash(first), HASH);
  assert.equal(sameMagnetContent(first, second), true);
});

test("normalizes base32 v1 magnets to hexadecimal", () => {
  assert.equal(
    magnetInfoHash("magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH"),
    HASH,
  );
});

test("does not equate magnets without a valid v1 identity", () => {
  assert.equal(magnetInfoHash("magnet:?dn=no-hash"), null);
  assert.equal(magnetInfoHash("https://example.test/video"), null);
  assert.equal(sameMagnetContent("magnet:?dn=one", "magnet:?dn=one"), false);
});

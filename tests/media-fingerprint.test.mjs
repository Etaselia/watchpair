import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprintPath, FINGERPRINT_SAMPLE_SIZE } from "../agent/media-fingerprint.mjs";

function browserCompatibleFingerprint(bytes) {
  const sampleLength = Math.min(bytes.length, FINGERPRINT_SAMPLE_SIZE);
  return createHash("sha256")
    .update(bytes.subarray(0, sampleLength))
    .update(bytes.subarray(bytes.length - sampleLength))
    .update(String(bytes.length))
    .digest("hex")
    .slice(0, 32);
}

test("companion fingerprint matches the browser algorithm regardless of filename", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-fingerprint-"));
  const bytes = Buffer.alloc(FINGERPRINT_SAMPLE_SIZE * 2 + 73);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

  const firstPath = path.join(directory, "torrent-release.mkv");
  const secondPath = path.join(directory, "renamed-local-copy.mkv");
  try {
    await Promise.all([writeFile(firstPath, bytes), writeFile(secondPath, bytes)]);
    const expected = browserCompatibleFingerprint(bytes);
    assert.equal(await fingerprintPath(firstPath), expected);
    assert.equal(await fingerprintPath(secondPath), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fingerprint changes when sampled media bytes change", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchpair-fingerprint-"));
  const original = Buffer.alloc(FINGERPRINT_SAMPLE_SIZE * 2 + 1, 0x41);
  const changed = Buffer.from(original);
  changed[changed.length - 1] = 0x42;
  const firstPath = path.join(directory, "first.mkv");
  const secondPath = path.join(directory, "second.mkv");
  try {
    await Promise.all([writeFile(firstPath, original), writeFile(secondPath, changed)]);
    assert.notEqual(await fingerprintPath(firstPath), await fingerprintPath(secondPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

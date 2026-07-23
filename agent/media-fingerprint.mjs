import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const FINGERPRINT_SAMPLE_SIZE = 512 * 1024;

async function readRange(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error("Media file ended while its identity was being calculated.");
    offset += bytesRead;
  }
  return buffer;
}

export async function fingerprintPath(filePath) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Media identity can only be calculated for a file.");

    const sampleLength = Math.min(info.size, FINGERPRINT_SAMPLE_SIZE);
    const first = await readRange(handle, sampleLength, 0);
    const last = await readRange(handle, sampleLength, Math.max(0, info.size - sampleLength));
    return createHash("sha256")
      .update(first)
      .update(last)
      .update(String(info.size))
      .digest("hex")
      .slice(0, 32);
  } finally {
    await handle.close();
  }
}

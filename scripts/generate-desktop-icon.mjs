import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const size = 512;
const pixels = Buffer.alloc(size * size * 4);

function insideRoundedSquare(x, y, radius) {
  const nearestX = Math.max(radius, Math.min(size - radius - 1, x));
  const nearestY = Math.max(radius, Math.min(size - radius - 1, y));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function colorAt(x, y) {
  if (!insideRoundedSquare(x, y, 72)) return [0, 0, 0, 0];
  if (x >= 104 && x < 238 && y >= 112 && y < 370) return [200, 255, 50, 255];
  if (x >= 274 && x < 408 && y >= 166 && y < 424) return [255, 111, 97, 255];
  return [16, 19, 15, 255];
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const color = colorAt(x, y);
    pixels.set(color, offset);
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header.set([8, 6, 0, 0, 0], 8);
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const target = y * (size * 4 + 1);
  scanlines[target] = 0;
  pixels.copy(scanlines, target + 1, y * size * 4, (y + 1) * size * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
await writeFile(new URL("../build/icon.png", import.meta.url), png);

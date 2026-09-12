// Original geometric frame mark; no third-party or private image assets.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const size = 256;
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, value) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, value])));
  return Buffer.concat([length, name, value, crc]);
}
const pixels = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const frame =
      x >= 52 &&
      x < 204 &&
      y >= 60 &&
      y < 196 &&
      (x < 67 || x >= 189 || y < 75 || y >= 181);
    const play = x >= 106 && x < 157 && Math.abs(y - 128) < (157 - x) * 0.65;
    const inset = x >= 32 && x < 224 && y >= 32 && y < 224;
    const color =
      frame || play
        ? [231, 238, 211, 255]
        : inset
          ? [49, 83, 56, 255]
          : [39, 67, 46, 255];
    pixels.set(color, y * (size * 4 + 1) + 1 + x * 4);
  }
const header = Buffer.alloc(13);
header.writeUInt32BE(size);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync(
  "src-tauri/icons/source.png",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

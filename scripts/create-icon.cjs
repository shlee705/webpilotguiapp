// Rasterize the existing public/favicon.svg geometry with supersampling.
// Uses only Node built-ins and emits PNG images embedded in a Windows ICO.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const outputDirectory = path.resolve(__dirname, '..', 'public');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const orange = [0xe5, 0x75, 0x50];
const points = [[9, 13], [14, 28], [20, 17], [26, 28], [31, 13]];
const samples = 4;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function insideBackground(x, y) {
  const dx = x - Math.max(12, Math.min(28, x));
  const dy = y - Math.max(12, Math.min(28, y));
  return dx * dx + dy * dy <= 144;
}

function insideStroke(x, y) {
  for (let index = 1; index < points.length; index++) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    const dx = x - ax - t * vx;
    const dy = y - ay - t * vy;
    if (dx * dx + dy * dy <= 2.25) return true;
  }
  return false;
}

function renderPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0;
      let white = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + .5) / samples) * 40 / size;
          const y = (py + (sy + .5) / samples) * 40 / size;
          if (!insideBackground(x, y)) continue;
          coverage++;
          if (insideStroke(x, y)) white++;
        }
      }
      const offset = py * stride + 1 + px * 4;
      if (coverage) {
        for (let channel = 0; channel < 3; channel++) raw[offset + channel] = Math.round((white * 255 + (coverage - white) * orange[channel]) / coverage);
        raw[offset + 3] = Math.round(coverage * 255 / (samples * samples));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function validatePng(png, expectedSize) {
  assert.equal(png.readUInt32BE(16), expectedSize);
  assert.equal(png.readUInt32BE(20), expectedSize);
  let offset = 8;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const nameAndData = png.subarray(offset + 4, offset + 8 + length);
    assert.equal(crc32(nameAndData), png.readUInt32BE(offset + 8 + length));
    if (nameAndData.subarray(0, 4).toString() === 'IDAT') compressed.push(nameAndData.subarray(4));
    offset += 12 + length;
  }
  assert.equal(zlib.inflateSync(Buffer.concat(compressed)).length, expectedSize * (expectedSize * 4 + 1));
}

const images = sizes.map(size => ({ size, png: renderPng(size) }));
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let imageOffset = directory.length;
images.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  directory[entry] = size === 256 ? 0 : size;
  directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(imageOffset, entry + 12);
  imageOffset += png.length;
  validatePng(png, size);
});
const icon = Buffer.concat([directory, ...images.map(image => image.png)]);
assert.equal(icon.length, imageOffset);
assert.equal(icon.readUInt16LE(2), 1);
assert.equal(icon.readUInt16LE(4), sizes.length);
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'app.ico'), icon);
fs.writeFileSync(path.join(outputDirectory, 'app.png'), images.at(-1).png);
console.log(`Created and validated app.ico (${sizes.join(', ')} px) and app.png (256 px).`);

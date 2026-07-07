'use strict';
// Generates PWA PNG icons with zero dependencies (pure-JS PNG encoder using
// node's built-in zlib). Draws the GasTracker fuel-drop mark on a teal
// rounded square. Run: node scripts/make-icons.js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const TEAL = [0x46, 0xb1, 0xa5, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // filter type 0 (None) prepended to each scanline
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-distance-style shape test in unit coordinates (0..1), 4x supersampled.
function drawIcon(size, { padded }) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const cornerR = 0.21;

  const inRoundedSquare = (x, y) => {
    if (!padded) return true; // maskable/apple: full-bleed background
    const m = 0.0; // square spans the full canvas; rounding at corners
    const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - cornerR), 0);
    const qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - cornerR), 0);
    return Math.hypot(qx, qy) <= cornerR;
  };

  // Fuel drop: circle + triangle tapering to a point at the top.
  const inDrop = (x, y) => {
    const cx = 0.5, cy = 0.615, r = 0.205;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
    const tipY = 0.17, halfBase = r * 0.94;
    if (y < tipY || y > cy) return false;
    const t = (y - tipY) / (cy - tipY); // 0 at tip → 1 at circle center
    return Math.abs(x - cx) <= halfBase * t;
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, dropHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inRoundedSquare(x, y)) {
            bgHits++;
            if (inDrop(x, y)) dropHits++;
          }
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      const bgA = bgHits / total, dropA = dropHits / total;
      for (let c = 0; c < 4; c++) {
        const v = CLEAR[c] * (1 - bgA) + TEAL[c] * (bgA - dropA) + WHITE[c] * dropA;
        rgba[i + c] = Math.round(v);
      }
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [size, file, padded] of [
  [192, 'icon-192.png', true],
  [512, 'icon-512.png', true],
  [180, 'icon-180.png', false], // apple-touch-icon: iOS rounds corners itself
]) {
  fs.writeFileSync(path.join(outDir, file), drawIcon(size, { padded }));
  console.log('wrote', file);
}

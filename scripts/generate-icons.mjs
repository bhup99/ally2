// scripts/generate-icons.mjs — dependency-free PWA icon generator.
// Renders a rounded-square teal icon with a white shield + check motif,
// and encodes PNGs with a minimal pure-JS (zlib) PNG writer.
// Run: node scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'client', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const TEAL = [15, 118, 110]; // #0f766e — matches the app theme
const WHITE = [255, 255, 255];

// ---- minimal PNG encoder (8-bit RGBA) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter type: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- shape math (all coordinates normalized 0..1) ----
function sdRoundBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const SHIELD = [
  [0.3, 0.26],
  [0.7, 0.26],
  [0.7, 0.54],
  [0.5, 0.76],
  [0.3, 0.54],
];
const CHECK_A = [0.395, 0.505];
const CHECK_B = [0.475, 0.585];
const CHECK_C = [0.615, 0.415];
const CHECK_HALF_WIDTH = 0.032;

function sample(u, v) {
  // returns [r, g, b, a]
  if (sdRoundBox(u, v, 0.5, 0.5, 0.5, 0.5, 0.225) > 0) return [0, 0, 0, 0];
  if (pointInPolygon(u, v, SHIELD)) {
    const dCheck = Math.min(
      distToSegment(u, v, ...CHECK_A, ...CHECK_B),
      distToSegment(u, v, ...CHECK_B, ...CHECK_C),
    );
    if (dCheck <= CHECK_HALF_WIDTH) return [...TEAL, 255];
    return [...WHITE, 255];
  }
  return [...TEAL, 255];
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const N = 2; // 2x2 supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const u = (x + (sx + 0.5) / N) / size;
          const v = (y + (sy + 0.5) / N) / size;
          const [pr, pg, pb, pa] = sample(u, v);
          r += pr; g += pg; b += pb; a += pa;
        }
      }
      const o = (y * size + x) * 4;
      const n = N * N;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const png = encodePNG(size, size, render(size));
  writeFileSync(path.join(outDir, name), png);
  console.log(`wrote ${name} (${png.length} bytes)`);
}

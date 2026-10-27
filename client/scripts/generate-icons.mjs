// Generate every raster icon from the single SVG source of truth
// (public/icons/icon.svg) at build time.
//
// Why: the deploy branch is synced through a text-only channel, so binary
// PNG/ICO files can never be pushed — the committed PNGs went stale the
// moment the logo changed (v1.3.3 shipped the new SVG while production kept
// serving the old 192/512/apple-touch PNGs). Generating them here, on every
// build, makes that class of bug impossible: change the SVG, the site and
// the home-screen icons change with it.
//
// Runs as `prebuild`, so the fresh files land in public/ before Vite copies
// public/ into dist/.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svgPath = join(publicDir, 'icons', 'icon.svg');
const svg = readFileSync(svgPath);

// The logo's own background color — used to flatten the apple-touch icon
// (iOS dislikes alpha in home-screen icons).
const BG = '#004756';

async function pngAt(size, { flatten = false } = {}) {
  let img = sharp(svg, { density: 192 }).resize(size, size);
  if (flatten) img = img.flatten({ background: BG });
  return img.png().toBuffer();
}

function buildIco(images) {
  // Minimal ICO container holding PNG-compressed entries (valid for all
  // modern browsers): ICONDIR, then one ICONDIRENTRY per size, then data.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colors
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const targets = [
  { file: 'icons/icon-192.png', size: 192 },
  { file: 'icons/icon-512.png', size: 512 },
  { file: 'icons/apple-touch-icon.png', size: 180, flatten: true },
];
for (const t of targets) {
  const buf = await pngAt(t.size, { flatten: t.flatten });
  writeFileSync(join(publicDir, t.file), buf);
  console.log(`icons: ${t.file} (${t.size}x${t.size}, ${buf.length} bytes)`);
}

const icoSizes = [16, 32, 48];
const icoImages = [];
for (const size of icoSizes) icoImages.push({ size, data: await pngAt(size) });
const ico = buildIco(icoImages);
writeFileSync(join(publicDir, 'favicon.ico'), ico);
console.log(`icons: favicon.ico (${icoSizes.join('/')}, ${ico.length} bytes)`);

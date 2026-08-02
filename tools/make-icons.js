/**
 * Generates the PWA icon set with no image dependencies.
 *
 * A build step that needs sharp/canvas is a native dependency that breaks on
 * some machine eventually, so the icons are rasterised here with a ~100 line
 * scanline filler and encoded as PNG using Node's built-in zlib. Run
 * `npm run icons` after changing the artwork; the output is committed.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/* ------------------------------ PNG encoding ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- Geometry ------------------------------- */

/** Even-odd point-in-polygon; the crown is a single non-self-intersecting ring. */
function inPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, size, radius) {
  const min = radius;
  const max = size - radius;
  const cx = Math.min(Math.max(x, min), max);
  const cy = Math.min(Math.max(y, min), max);
  if (x >= 0 && y >= 0 && x <= size && y <= size) {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  return false;
}

const CROWN_24 = [
  [3, 8.5], [6.6, 12], [12, 4.5], [17.4, 12], [21, 8.5], [19.3, 19], [4.7, 19],
];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const VIOLET = [124, 92, 255];
const MAGENTA = [201, 75, 255];
const GOLD = [255, 197, 61];

/**
 * @param size      output edge length in pixels
 * @param maskable  true = full-bleed square with the crown inside the 80% safe
 *                  zone, for Android adaptive icons
 */
function renderIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.22;

  // Crown occupies less of the canvas on maskable icons so a circular mask
  // cannot clip its points.
  const scale = maskable ? size / 24 / 1.55 : size / 24 / 1.18;
  const offsetX = size / 2 - 12 * scale;
  const offsetY = size / 2 - 11.75 * scale;

  const SS = 3; // 3x3 supersampling — enough to hide the stair-stepping
  const samples = SS * SS;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let crownHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          if (maskable || inRoundedRect(x, y, size, radius)) bgHits += 1;

          const cx = (x - offsetX) / scale;
          const cy = (y - offsetY) / scale;
          if (inPolygon(CROWN_24, cx, cy)) crownHits += 1;
        }
      }

      const i = (py * size + px) * 4;
      if (bgHits === 0) continue;

      const bgAlpha = bgHits / samples;
      const gradient = mix(VIOLET, MAGENTA, (px / size) * 0.5 + (py / size) * 0.5);
      const crownAlpha = (crownHits / samples) * bgAlpha;

      const colour = crownAlpha > 0 ? mix(gradient, GOLD, crownAlpha / Math.max(bgAlpha, 0.0001)) : gradient;

      rgba[i] = colour[0];
      rgba[i + 1] = colour[1];
      rgba[i + 2] = colour[2];
      rgba[i + 3] = Math.round(bgAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/>
      <stop offset="1" stop-color="#c94bff"/>
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="5.3" fill="url(#g)"/>
  <path d="M4.4 9.4 7.4 12.3 12 6 16.6 12.3 19.6 9.4 18.2 18.2H5.8L4.4 9.4Z" fill="#ffc53d"/>
</svg>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), SVG);

for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), renderIcon(size));
  console.log(`icon-${size}.png`);
}

fs.writeFileSync(path.join(OUT_DIR, 'icon-maskable-512.png'), renderIcon(512, { maskable: true }));
console.log('icon-maskable-512.png');
console.log('icon.svg');

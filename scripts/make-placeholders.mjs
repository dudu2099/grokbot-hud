#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const WIDTH = 1920;
const HEIGHT = 1200;

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixel) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) row.set(pixel(x, y).map(Math.round), x * 3);
    const offset = y * (stride + 1);
    raw[offset] = 2;
    for (let i = 0; i < stride; i++) raw[offset + 1 + i] = (row[i] - previous[i]) & 0xff;
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * Math.min(1, Math.max(0, t)));

function nightHarbor(x, y) {
  const horizon = HEIGHT * 0.62;
  let color = mix([10, 16, 30], [30, 46, 74], y / horizon);
  const moon = Math.hypot(x - WIDTH * 0.72, y - HEIGHT * 0.28);
  const radius = HEIGHT * 0.085;
  if (moon < radius) color = [226, 221, 204];
  else if (moon < radius * 2.4) color = mix(color, [70, 88, 122], 0.45 * (1 - (moon - radius) / (radius * 1.4)));
  if (y > horizon) {
    color = mix([24, 38, 62], [8, 13, 24], (y - horizon) / (HEIGHT - horizon));
    const band = Math.floor((y - horizon) / 26) % 2 === 1;
    const underMoon = Math.abs(x - WIDTH * 0.72) < radius * (1.2 - (y - horizon) / (HEIGHT - horizon) * 0.6);
    if (band) color = mix(color, [44, 62, 96], 0.3);
    if (band && underMoon) color = mix(color, [196, 192, 176], 0.55);
  }
  return color;
}

function paperLight(x, y) {
  let color = mix([251, 248, 241], [238, 231, 216], (x / WIDTH + y / HEIGHT) / 2);
  const sun = Math.hypot(x - WIDTH * 0.24, y - HEIGHT * 0.7);
  if (sun < HEIGHT * 0.32) color = mix(color, [240, 214, 190], 0.5);
  if (x > WIDTH * 0.58 && x < WIDTH * 0.86 && y > HEIGHT * 0.16 && y < HEIGHT * 0.52) color = mix(color, [206, 218, 200], 0.55);
  if (Math.floor((x + y) / 48) % 9 === 0) color = mix(color, [214, 204, 186], 0.25);
  return color;
}

const THUMB = { width: 320, height: 200 };
const thumbOf = (pixel) => (x, y) => pixel((x * WIDTH) / THUMB.width, (y * HEIGHT) / THUMB.height);

// paper-light ships without a thumb on purpose, so tests cover the accent-swatch fallback.
const OUTPUTS = [
  ['test/fixtures/packs/night-harbor/wallpaper.png', WIDTH, HEIGHT, nightHarbor],
  ['test/fixtures/packs/night-harbor/thumb.png', THUMB.width, THUMB.height, thumbOf(nightHarbor)],
  ['test/fixtures/packs/paper-light/wallpaper.png', WIDTH, HEIGHT, paperLight],
];

for (const [path, width, height, pixel] of OUTPUTS) {
  const png = encodePng(width, height, pixel);
  writeFileSync(new URL(`../${path}`, import.meta.url), png);
  console.log(`${path}  ${width}x${height}  ${(png.length / 1024).toFixed(0)} KB`);
}

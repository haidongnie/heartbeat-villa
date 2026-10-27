#!/usr/bin/env node
// Re-encodes the ground/water textures from assets-src/textures/*.jpg into public/textures/*.webp.
// Output names are the ones src/world/world.ts loads. Sizes are per map: colour gets the most pixels,
// roughness is stored as grayscale (the game reads .r), normal maps stay 3-channel RGB.
//
//   node tools/textures.mjs            (npm run assets:textures)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets-src/textures');
const OUT = path.join(ROOT, 'public/textures');

// name: [size, quality, kind]   kind: 'color' | 'normal' | 'gray'
const TEXTURES = {
  sand_01_diff: [1024, 80, 'color'],
  sand_01_nor_gl: [512, 85, 'normal'],
  sand_01_rough: [512, 85, 'gray'],
  wood_floor_deck_diff: [1024, 80, 'color'],
  wood_floor_deck_nor_gl: [1024, 80, 'normal'],
  wood_floor_deck_rough: [512, 85, 'gray'],
  long_white_tiles_diff: [1024, 80, 'color'],
  waternormals: [512, 85, 'normal'],
};

await fs.mkdir(OUT, { recursive: true });
let before = 0, after = 0;
for (const [name, [size, quality, kind]] of Object.entries(TEXTURES)) {
  const src = path.join(SRC, `${name}.jpg`);
  const dst = path.join(OUT, `${name}.webp`);
  const old = await fs.stat(dst).then((s) => s.size, () => 0);
  let img = sharp(src).resize(size, size);
  if (kind === 'gray') img = img.toColourspace('b-w');
  // Normal maps: never grayscale, never drop a channel (alpha-free 3-channel RGB in, 3-channel out).
  if (kind === 'normal') img = img.removeAlpha().toColourspace('srgb');
  const buf = await img.webp({ quality, effort: 6 }).toBuffer();
  if (kind === 'normal') {
    const m = await sharp(buf).metadata();
    if (m.channels !== 3) throw new Error(`${name}: expected 3 channels, got ${m.channels}`);
  }
  await fs.writeFile(dst, buf);
  before += old; after += buf.length;
  console.log(`${name.padEnd(24)} ${String(size).padStart(4)}px q${quality} ${kind.padEnd(6)} ${String(old).padStart(7)} -> ${String(buf.length).padStart(7)} B`);
}
console.log(`total ${before} -> ${after} B`);

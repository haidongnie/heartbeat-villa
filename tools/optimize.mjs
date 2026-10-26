#!/usr/bin/env node
// Turns raw Meshy downloads (assets-src/) into web-ready assets (public/):
//  - renames animation clips to the game's names (manifest order == Meshy clip order)
//  - re-centres one-shot clips on the idle pose so cross-fades do not slide the character
//  - resamples animations, WebP textures (1024px), meshopt geometry
//  - trims Meshy thumbnails into character portraits
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'tools/assets.manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const portraitsOnly = args.includes('--portraits');
const only = args.filter((x) => !x.startsWith('--'));
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const exists = (f) => fs.access(f).then(() => true, () => false);

function recentreClips(doc) {
  const anims = doc.getRoot().listAnimations();
  const hipsKeys = (a) => a.listChannels().find((c) => c.getTargetPath() === 'translation' && /hips/i.test(c.getTargetNode()?.getName() ?? ''));
  const idle = anims.find((a) => a.getName() === 'idle');
  const ref = idle && hipsKeys(idle)?.getSampler().getOutput().getArray();
  if (!ref) return;
  for (const a of anims) {
    if (a === idle || a.getName() === 'sit') continue;
    const sampler = hipsKeys(a)?.getSampler();
    const out = sampler?.getOutput();
    if (!sampler || !out) continue;
    const arr = out.getArray().slice();
    const dx = arr[0] - ref[0], dz = arr[2] - ref[2];
    for (let i = 0; i < arr.length; i += 3) { arr[i] -= dx; arr[i + 2] -= dz; }
    // Some Meshy walks carry root motion (up to ~2 m per loop); the game moves the root itself,
    // so remove the linear drift and keep only the in-place sway.
    if (a.getName() === 'walk') {
      const t = sampler.getInput().getArray();
      const n = arr.length / 3, T = t[n - 1] - t[0] || 1;
      const ex = arr[3 * n - 3] - arr[0], ez = arr[3 * n - 1] - arr[2];
      for (let i = 0; i < n; i++) { const k = (t[i] - t[0]) / T; arr[3 * i] -= ex * k; arr[3 * i + 2] -= ez * k; }
    }
    out.setArray(arr);
  }
}

for (const a of manifest.assets) {
  if (portraitsOnly || (only.length && !only.includes(a.id))) continue;
  const isChar = a.kind === 'character';
  const src = path.join(ROOT, 'assets-src', isChar ? 'characters' : 'props', `${a.id}.glb`);
  if (!(await exists(src))) { console.log('skip (missing)', a.id); continue; }
  const dst = path.join(ROOT, 'public/models', `${a.id}.glb`);
  await fs.mkdir(path.dirname(dst), { recursive: true });

  const doc = await io.read(src);
  if (isChar) {
    doc.getRoot().listAnimations().forEach((anim, i) => anim.setName(a.actions[i]?.name ?? anim.getName()));
    recentreClips(doc);
  }
  const size = isChar || a.id === 'villa' ? 2048 : 1024;
  await doc.transform(
    dedup(),
    prune(),
    ...(isChar ? [resample({ tolerance: 1e-4 })] : []),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 85 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(dst, doc);
  const kb = ((await fs.stat(dst)).size / 1024) | 0;
  console.log(`${a.id}.glb  ${kb} KB`);

}

// Head-and-shoulders portraits cut from the A-pose thumbnails (arms make the full frame too wide).
for (const a of manifest.assets) {
  if (a.kind !== 'character' || (only.length && !only.includes(a.id))) continue;
  const thumb = path.join(ROOT, 'assets-src/previews', `${a.id}.refined.png`);
  if (!(await exists(thumb))) continue;
  const out = path.join(ROOT, 'public/portraits', `${a.id}.webp`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const trimmed = await sharp(thumb).trim({ threshold: 12 }).toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = trimmed.info;
  const cw = Math.round(Math.min(w, h * 0.34)), ch = Math.round(cw * 1.25);
  await sharp(trimmed.data)
    .extract({ left: Math.round((w - cw) / 2), top: 0, width: cw, height: Math.min(h, ch) })
    .resize(320, 400, { fit: 'cover', position: 'top' })
    .webp({ quality: 88 })
    .toFile(out);
  console.log('portrait', a.id);
}

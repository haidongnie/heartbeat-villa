#!/usr/bin/env node
// Turns raw Meshy downloads (assets-src/) into web-ready assets (public/):
//  - renames animation clips to the game's names (manifest order == Meshy clip order)
//  - re-centres one-shot clips on the idle pose so cross-fades do not slide the character
//  - drops animation tracks that only hold the rest pose (three's mixer restores rest for missing tracks)
//  - WebP textures sized per material slot, meshopt geometry (level high; 12-bit quaternions for skins)
//  - trims Meshy thumbnails into character portraits
//
//   node tools/optimize.mjs                 every asset + portraits
//   node tools/optimize.mjs linye villa     only these ids (+ their portraits)
//   node tools/optimize.mjs --portraits     portraits only
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mergeMotions } from './merge-motions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'tools/assets.manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const portraitsOnly = args.includes('--portraits');
const only = args.filter((x) => !x.startsWith('--'));
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

/** MeshoptEncoder with quaternion filter output at `bits` (default 16 → 12 saves ~25% on rotation tracks). */
function quatBitsEncoder(enc, bits) {
  return new Proxy(enc, {
    get(target, prop) {
      if (prop === 'encodeFilterQuat') return (a, c, s) => target.encodeFilterQuat(a, c, s, bits);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
const makeIO = (encoder) => new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': encoder, 'meshopt.decoder': MeshoptDecoder });
const io = makeIO(MeshoptEncoder);
const charIO = makeIO(quatBitsEncoder(MeshoptEncoder, 12));

const exists = (f) => fs.access(f).then(() => true, () => false);

// Texture budgets. Each slot is encoded once, straight from the source image (never resized twice).
const BC = /baseColor/i, NM = /normal/i, MR = /metallicRoughness/i;
const SMALL_PROPS = ['rose', 'torch', 'flamingo', 'monstera'];
const TEX_EFFORT = 100; // gltf-transform scale; maps to sharp webp effort 6
function texturePlan(a) {
  // [slot regex | null (all slots), size, quality]
  if (a.kind === 'character') return [[null, 1536, 80]];
  if (a.id === 'villa') return [[BC, 1536, 80], [NM, 1024, 85], [MR, 512, 85]];
  if (SMALL_PROPS.includes(a.id)) return [[BC, 512, 80], [NM, 512, 85], [MR, 512, 85]];
  return [[BC, 1024, 80], [NM, 512, 85], [MR, 512, 85]];
}

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

/**
 * Remove channels whose every key equals the target node's rest TRS. three's PropertyMixer blends
 * missing tracks towards the node's original (rest) state, so playback is unchanged.
 * Tolerances: translation 1e-3 / scale 1e-5 in node units (the skeleton is in cm under a 0.01 Armature),
 * rotation 1e-4 rad measured as 2*|q - sign*q_rest|. Hips translation is always kept (root sway,
 * sit offset measured by the game).
 */
function dropRestTracks(doc, { tTol = 1e-3, sTol = 1e-5, rTol = 1e-4 } = {}) {
  let removed = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode(); const p = ch.getTargetPath();
      if (!node || p === 'weights') continue;
      if (p === 'translation' && /hips/i.test(node.getName())) continue;
      const out = ch.getSampler().getOutput();
      const e = out.getElementSize(); const v = [];
      const rest = p === 'translation' ? node.getTranslation() : p === 'scale' ? node.getScale() : node.getRotation();
      let ok = true;
      for (let i = 0; i < out.getCount() && ok; i++) {
        out.getElement(i, v);
        if (p === 'rotation') {
          const sgn = v[0] * rest[0] + v[1] * rest[1] + v[2] * rest[2] + v[3] * rest[3] < 0 ? -1 : 1;
          const d = Math.hypot(v[0] - sgn * rest[0], v[1] - sgn * rest[1], v[2] - sgn * rest[2], v[3] - sgn * rest[3]);
          if (2 * d > rTol) ok = false;
        } else {
          const tol = p === 'scale' ? sTol : tTol;
          for (let k = 0; k < e; k++) if (Math.abs(v[k] - rest[k]) > tol) ok = false;
        }
      }
      if (ok) {
        const s = ch.getSampler();
        ch.dispose();
        if (!s.listParents().some((x) => x.propertyType === PropertyType.ANIMATION_CHANNEL)) s.dispose();
        removed++;
      }
    }
  }
  return removed;
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
    // Text-to-Motion clips (hug_over, hug_waist, kiss) from tools/meshy-motion.mjs / tools/retarget.mjs.
    const extra = await mergeMotions(doc, io, path.join(ROOT, 'assets-src/motions'), a.id);
    if (extra.length) console.log(`${a.id}: + ${extra.join(', ')}`);
    recentreClips(doc);
  }
  await doc.transform(dedup(), prune());
  let dropped = 0;
  if (isChar) { dropped = dropRestTracks(doc); await doc.transform(prune()); }
  for (const [slots, size, quality] of texturePlan(a)) {
    await doc.transform(textureCompress({
      encoder: sharp, targetFormat: 'webp', resize: [size, size], quality, effort: TEX_EFFORT,
      ...(slots ? { slots } : {}),
    }));
  }
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const buf = await (isChar ? charIO : io).writeBinary(doc);
  await fs.writeFile(dst, buf);
  console.log(`${a.id}.glb  ${(buf.byteLength / 1024) | 0} KB${isChar ? `  (${dropped} rest tracks dropped)` : ''}`);
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

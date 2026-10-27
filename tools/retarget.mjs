#!/usr/bin/env node
// World-space retarget of one Meshy motion clip from a source rig onto a target rig with the same bone names
// but a different bind pose (Meshy fits its template skeleton to each mesh, so arm rest angles differ by up
// to ~70°). Each frame is solved in world space and converted back to the target's local rotations.
// Hips translation is scaled by the ratio of hip heights.
//
//   node tools/retarget.mjs --mode=calib --calib-src=<A.motion.glb> --calib-tgt=<B.motion.glb> <A.other.glb> <B-character.glb> <out.glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'local-right';
const [srcPath, tgtPath, outPath] = argv.filter((a) => !a.startsWith('--'));
const opt = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
if (!outPath) { console.error('usage: retarget.mjs <source-motion.glb> <target-character.glb> <out.glb>'); process.exit(1); }

// ---- quaternion helpers ([x, y, z, w]) ----
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const inv = (q) => [-q[0], -q[1], -q[2], q[3]];
const norm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b; d = Math.abs(d);
  if (d > 0.9995) return norm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => (Math.sin((1 - t) * th) * v + Math.sin(t * th) * bb[i]) / s);
}

/** Sample a channel (input times + output values) at time t, linear / slerp. */
function sample(ch, t, size) {
  const { times, values } = ch;
  let i = 0;
  while (i < times.length - 1 && times[i + 1] < t) i++;
  const at = (k) => Array.from(values.slice(k * size, k * size + size));
  if (t <= times[0]) return at(0);
  if (i >= times.length - 1) return at(times.length - 1);
  const k = (t - times[i]) / (times[i + 1] - times[i] || 1);
  const a = at(i), b = at(i + 1);
  return size === 4 ? slerp(a, b, k) : a.map((v, j) => v + (b[j] - v) * k);
}

/** Rotation of a column-major 4x4 matrix's inverse (bind pose from an inverse bind matrix), scale removed. */
function bindRotation(ibm) {
  // inverse of the upper 3x3 (rotation·scale): invert generally, then orthonormalise the columns.
  const a = [ibm[0], ibm[1], ibm[2], ibm[4], ibm[5], ibm[6], ibm[8], ibm[9], ibm[10]]; // columns
  const [a00, a10, a20, a01, a11, a21, a02, a12, a22] = a;
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  const m = [ // inverse, row-major m[r][c]
    [(a11 * a22 - a12 * a21) / det, (a02 * a21 - a01 * a22) / det, (a01 * a12 - a02 * a11) / det],
    [(a12 * a20 - a10 * a22) / det, (a00 * a22 - a02 * a20) / det, (a02 * a10 - a00 * a12) / det],
    [(a10 * a21 - a11 * a20) / det, (a01 * a20 - a00 * a21) / det, (a00 * a11 - a01 * a10) / det],
  ];
  for (let c = 0; c < 3; c++) { const l = Math.hypot(m[0][c], m[1][c], m[2][c]) || 1; for (let r = 0; r < 3; r++) m[r][c] /= l; }
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m[2][1] - m[1][2]) / S, (m[0][2] - m[2][0]) / S, (m[1][0] - m[0][1]) / S, 0.25 * S]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const S = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [0.25 * S, (m[0][1] + m[1][0]) / S, (m[0][2] + m[2][0]) / S, (m[2][1] - m[1][2]) / S]; }
  else if (m[1][1] > m[2][2]) { const S = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / S, 0.25 * S, (m[1][2] + m[2][1]) / S, (m[0][2] - m[2][0]) / S]; }
  else { const S = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / S, (m[1][2] + m[2][1]) / S, 0.25 * S, (m[1][0] - m[0][1]) / S]; }
  return norm(q);
}

function skeleton(doc) {
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  const bindWorld = new Map(joints.map((j, i) => [j.getName(), bindRotation(ibm.getElement(i, []))]));
  const byName = new Map(joints.map((j) => [j.getName(), j]));
  const parentOf = new Map();
  for (const j of joints) for (const c of j.listChildren()) parentOf.set(c.getName(), j.getName());
  // Topological order: parents first.
  const order = [], seen = new Set();
  const visit = (n) => { if (seen.has(n)) return; const p = parentOf.get(n); if (p) visit(p); seen.add(n); order.push(n); };
  for (const j of joints) visit(j.getName());
  const restLocal = new Map(joints.map((j) => [j.getName(), j.getRotation()]));
  const restWorld = new Map();
  for (const n of order) {
    const p = parentOf.get(n);
    restWorld.set(n, norm(p ? mul(restWorld.get(p), restLocal.get(n)) : restLocal.get(n)));
  }
  return { byName, parentOf, order, restLocal, restWorld, bindWorld };
}

const srcDoc = await io.read(srcPath);
const tgtDoc = await io.read(tgtPath);
const S = skeleton(srcDoc), T = skeleton(tgtDoc);
const anim = srcDoc.getRoot().listAnimations()[0];

/** World rotations (skeleton space) of every bone at each keyframe of a motion file's first clip. */
async function worldFrames(file) {
  const d = await io.read(file);
  const sk = skeleton(d);
  const chans = new Map();
  for (const c of d.getRoot().listAnimations()[0].listChannels()) {
    if (c.getTargetPath() !== 'rotation') continue;
    const sm = c.getSampler();
    chans.set(c.getTargetNode().getName(), { times: sm.getInput().getArray(), values: sm.getOutput().getArray() });
  }
  const n = chans.get('Hips').times.length, frames = [];
  for (let f = 0; f < n; f++) {
    const t = chans.get('Hips').times[f], W = new Map();
    for (const b of sk.order) {
      const l = chans.has(b) ? norm(sample(chans.get(b), t, 4)) : sk.restLocal.get(b);
      const p = sk.parentOf.get(b);
      W.set(b, norm(p ? mul(W.get(p), l) : l));
    }
    frames.push(W);
  }
  return frames;
}

// 'calib': Meshy's retarget differs from any bind-pose formula by a constant per-bone world offset C, so
// measure C from a clip Meshy produced for BOTH rigs (same motion), then apply it to the clip we lack:
//   C = inv(W_calibSrc) · W_calibTgt   (averaged over frames),   W_tgt(t) = W_src(t) · C
const calib = new Map();
if (mode === 'calib') {
  const [a, b] = await Promise.all([worldFrames(opt('calib-src')), worldFrames(opt('calib-tgt'))]);
  const n = Math.min(a.length, b.length);
  let spread = 0;
  for (const bone of S.order) {
    let acc = [0, 0, 0, 0], first = null;
    for (let f = 0; f < n; f++) {
      let c = norm(mul(inv(a[f].get(bone)), b[f].get(bone)));
      first ??= c;
      if (c[0] * first[0] + c[1] * first[1] + c[2] * first[2] + c[3] * first[3] < 0) c = c.map((v) => -v);
      acc = acc.map((v, i) => v + c[i]);
      const d = Math.abs(c[0] * first[0] + c[1] * first[1] + c[2] * first[2] + c[3] * first[3]);
      spread = Math.max(spread, (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI);
    }
    calib.set(bone, norm(acc));
  }
  console.log(`calibration spread (max deviation of C over frames): ${spread.toFixed(2)}°`);
}

const rot = new Map(), hipsT = { ch: null };
let duration = 0, step = Infinity;
for (const c of anim.listChannels()) {
  const name = c.getTargetNode().getName(), s = c.getSampler();
  const times = s.getInput().getArray(), values = s.getOutput().getArray();
  duration = Math.max(duration, times[times.length - 1]);
  for (let i = 1; i < times.length; i++) step = Math.min(step, times[i] - times[i - 1]);
  if (c.getTargetPath() === 'rotation') rot.set(name, { c, times, values });
  if (c.getTargetPath() === 'translation' && /hips/i.test(name)) hipsT.ch = { c, times, values };
}
const fps = Math.round(1 / step) || 30;
const frames = Math.round(duration * fps) + 1;

// Hips height ratio for the translation track.
const hipH = (sk) => sk.byName.get('Hips').getTranslation()[1];
const ratio = hipH(T) / hipH(S);
const srcHipRest = S.byName.get('Hips').getTranslation(), tgtHipRest = T.byName.get('Hips').getTranslation();

const outRot = new Map([...rot.keys()].map((n) => [n, new Float32Array(frames * 4)]));
const outHip = new Float32Array(frames * 3);
const times = new Float32Array(frames);
for (let f = 0; f < frames; f++) {
  const t = Math.min(duration, f / fps);
  times[f] = t;
  const srcWorld = new Map(), tgtWorld = new Map();
  for (const n of S.order) {
    const local = rot.has(n) ? norm(sample(rot.get(n), t, 4)) : S.restLocal.get(n);
    const p = S.parentOf.get(n);
    srcWorld.set(n, norm(p ? mul(srcWorld.get(p), local) : local));
  }
  for (const n of T.order) {
    if (!S.restWorld.has(n)) { // bone missing in source: keep target rest
      const p = T.parentOf.get(n);
      tgtWorld.set(n, norm(p ? mul(tgtWorld.get(p), T.restLocal.get(n)) : T.restLocal.get(n)));
      continue;
    }
    // 'world' copies each bone's world orientation (Meshy rigs share bone-axis conventions, and this matches
    // Meshy's own retargets to within a degree or two); 'offset' preserves each rig's bind-pose offset.
    const p = T.parentOf.get(n);
    const srcLocal = rot.has(n) ? norm(sample(rot.get(n), t, 4)) : S.restLocal.get(n);
    let local;
    if (mode === 'local-right') local = norm(mul(mul(srcLocal, inv(S.restLocal.get(n))), T.restLocal.get(n)));
    else if (mode === 'local-left') local = norm(mul(mul(T.restLocal.get(n), inv(S.restLocal.get(n))), srcLocal));
    else if (mode === 'calib') {
      const w = norm(mul(srcWorld.get(n), calib.get(n)));
      local = norm(p ? mul(inv(tgtWorld.get(p)), w) : w);
    } else {
      const ref = mode === 'bind' ? 'bindWorld' : 'restWorld';
      const w = norm(mul(mul(srcWorld.get(n), inv(S[ref].get(n))), T[ref].get(n)));
      local = norm(p ? mul(inv(tgtWorld.get(p)), w) : w);
    }
    tgtWorld.set(n, norm(p ? mul(tgtWorld.get(p), local) : local));
    if (outRot.has(n)) outRot.get(n).set(local, f * 4);
  }
  const h = hipsT.ch ? sample(hipsT.ch, t, 3) : srcHipRest;
  for (let k = 0; k < 3; k++) outHip[f * 3 + k] = tgtHipRest[k] + (h[k] - srcHipRest[k]) * ratio;
}

// Write the result into the source motion document (same bone names), replacing its keyframes.
const buffer = srcDoc.getRoot().listBuffers()[0];
const timeAcc = srcDoc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
for (const c of anim.listChannels()) {
  const name = c.getTargetNode().getName(), s = c.getSampler();
  if (c.getTargetPath() === 'rotation' && outRot.has(name)) {
    s.setInput(timeAcc).setOutput(srcDoc.createAccessor().setType('VEC4').setArray(outRot.get(name)).setBuffer(buffer)).setInterpolation('LINEAR');
  } else if (c === hipsT.ch?.c) {
    s.setInput(timeAcc).setOutput(srcDoc.createAccessor().setType('VEC3').setArray(outHip).setBuffer(buffer)).setInterpolation('LINEAR');
  }
}
anim.setName(`retarget:${srcPath.split('/').pop()}`);
await io.write(outPath, srcDoc);
console.log(`retargeted ${rot.size} bones, ${frames} frames @${fps}fps, hip ratio ${ratio.toFixed(3)} -> ${outPath}`);

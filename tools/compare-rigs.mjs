// Prints the largest rest-pose rotation difference (degrees) per joint between two rigged characters.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [a, b] = await Promise.all(process.argv.slice(2, 4).map((f) => io.read(f)));
const joints = (d) => new Map(d.getRoot().listSkins()[0].listJoints().map((j) => [j.getName(), j]));
const ja = joints(a), jb = joints(b);
let worst = 0;
for (const [n, x] of ja) {
  const y = jb.get(n); if (!y) { console.log('missing', n); continue; }
  const q1 = x.getRotation(), q2 = y.getRotation();
  const dot = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]);
  const deg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
  worst = Math.max(worst, deg);
  if (deg > 3) console.log(n, deg.toFixed(1) + '°');
}
console.log('worst', worst.toFixed(1) + '°');

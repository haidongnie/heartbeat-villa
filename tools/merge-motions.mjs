// Merges Meshy Text-to-Motion clips (assets-src/motions/<character>.<motion>.glb, same rig as the character)
// into a character document, matching target nodes by bone name. Used by tools/optimize.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {import('@gltf-transform/core').Document} doc character document (modified in place)
 * @param {import('@gltf-transform/core').NodeIO} io reader for the motion files
 * @param {string} dir assets-src/motions
 * @param {string} id character id
 * @returns {Promise<string[]>} names of the clips added
 */
export async function mergeMotions(doc, io, dir, id) {
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.startsWith(`${id}.`) && f.endsWith('.glb')).sort(); } catch { return []; }
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const added = [];
  for (const f of files) {
    const name = f.slice(id.length + 1, -4);
    if (root.listAnimations().some((a) => a.getName() === name)) continue;
    const src = (await io.read(path.join(dir, f))).getRoot().listAnimations()[0];
    if (!src) continue;
    const anim = doc.createAnimation(name);
    const copied = new Map();
    const copy = (acc) => {
      if (!copied.has(acc)) {
        copied.set(acc, doc.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buffer));
      }
      return copied.get(acc);
    };
    let channels = 0;
    for (const ch of src.listChannels()) {
      const target = byName.get(ch.getTargetNode()?.getName());
      const s = ch.getSampler();
      if (!target || !s) continue;
      const sampler = doc.createAnimationSampler()
        .setInput(copy(s.getInput()))
        .setOutput(copy(s.getOutput()))
        .setInterpolation(s.getInterpolation());
      anim.addSampler(sampler).addChannel(
        doc.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(sampler),
      );
      channels++;
    }
    if (!channels) { anim.dispose(); continue; }
    added.push(name);
  }
  return added;
}

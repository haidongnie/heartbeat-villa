// Prints meshes, materials, textures, skins and animation clips of a GLB.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const r = doc.getRoot();
  console.log('==', f);
  const scene = r.getDefaultScene() ?? r.listScenes()[0];
  const b = getBounds(scene); console.log('bounds', b.min.map(v=>v.toFixed(2)), b.max.map(v=>v.toFixed(2)));
  for (const m of r.listMeshes()) for (const p of m.listPrimitives()) console.log('mesh', m.getName(), 'verts', p.getAttribute('POSITION').getCount(), 'idx', p.getIndices()?.getCount()/3|0, 'mat', p.getMaterial()?.getName());
  for (const t of r.listTextures()) { const s = t.getSize(); console.log('tex', t.getName(), t.getMimeType(), s?.join('x'), (t.getImage().byteLength/1024|0)+'KB'); }
  for (const s of r.listSkins()) console.log('skin joints', s.listJoints().length, s.listJoints().slice(0,6).map(j=>j.getName()).join(','));
  for (const a of r.listAnimations()) {
    const ch = a.listChannels();
    const hip = ch.find(c => c.getTargetPath()==='translation');
    let info='';
    if (hip) { const o = hip.getSampler().getOutput().getArray(); const n=o.length/3; info = `trans ${hip.getTargetNode().getName()} first(${[o[0],o[1],o[2]].map(v=>v.toFixed(2))}) last(${[o[3*n-3],o[3*n-2],o[3*n-1]].map(v=>v.toFixed(2))})`; }
    const inp = ch[0].getSampler().getInput().getArray();
    console.log('anim', JSON.stringify(a.getName()), 'channels', ch.length, 'dur', inp[inp.length-1].toFixed(2), info);
  }
}

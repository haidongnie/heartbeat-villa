import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, dot, mix, screenUV, smoothstep, float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// SMAANode embeds a ~44 KB base64 lookup texture; load it as its own chunk, in parallel with the assets.
let smaaModule: Promise<typeof import('three/addons/tsl/display/SMAANode.js')> | undefined;
const loadSmaa = () => (smaaModule ??= import('three/addons/tsl/display/SMAANode.js'));

export type Quality = 'low' | 'high';

export function detectQuality(): Quality {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'low' || q === 'high') return q;
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch || Math.min(screen.width, screen.height) < 700 ? 'low' : 'high';
}

/**
 * WebGPU renderer (WebGL2 fallback) with AgX tone mapping, PCF shadows, and a small
 * post stack: bloom for neon/fire, a colour-grade node the show uses for dramatic beats
 * (desaturate, tint, flash, vignette), then SMAA.
 */
export async function createRenderer(canvas: HTMLCanvasElement, quality: Quality) {
  void loadSmaa().catch(() => { /* createPost() retries and reports */ });
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 2 : 1.25));
  renderer.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight), false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const backend = renderer.backend as { isWebGPUBackend?: boolean };
  console.info(`[renderer] ${backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'} · quality ${quality}`);
  return renderer;
}

export async function createPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, quality: Quality) {
  // One retry: the early prefetch may have failed on a flaky connection.
  const { smaa } = await loadSmaa().catch(() => { smaaModule = undefined; return loadSmaa(); });
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const bloomPass = bloom(color, 0.28, 0.32, 1.6);
  if (quality === 'low') bloomPass.setResolutionScale(0.5);

  const grade = {
    saturation: uniform(1.12),
    tint: uniform(new THREE.Color(1, 1, 1)),
    flash: uniform(0.0),
    vignette: uniform(0.35),
  };
  const lit = color.add(bloomPass);
  const lum = dot(lit.rgb, vec3(0.2126, 0.7152, 0.0722));
  const graded = mix(vec3(lum), lit.rgb, grade.saturation).mul(grade.tint).add(grade.flash);
  const vig = float(1).sub(grade.vignette.mul(smoothstep(0.3, 0.85, screenUV.sub(0.5).length())));
  const out = vec4(graded.mul(vig), 1);
  pipeline.outputNode = smaa(out);

  return { pipeline, scenePass, bloom: bloomPass, grade, render: () => pipeline.render() };
}

/**
 * Build node graphs + GPU pipelines for `root` exactly as the post-processing scene pass will draw it, so the
 * first frame that shows it does not stall. Relies on r186 Renderer.compileAsync doing its scene projection and
 * render-context capture synchronously before its first await (Renderer.js ~L896-1000):
 *  - the scene pass renders into its own RenderTarget (rgba16float, colorSpace NoColorSpace); compiling against
 *    the default framebuffer target (colorSpace srgb-linear) would give different pipeline cache keys;
 *  - compileAsync frustum-culls, so culling is switched off for the synchronous part to include off-screen props.
 * Shadow-map and post-process pipelines are not covered (ShadowNode skips while _isPreCompiling); one warm-up
 * post.render() behind the loading overlay takes care of those.
 */
export async function precompile(renderer: THREE.WebGPURenderer, post: Post, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) {
  const culled: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(post.scenePass.renderTarget);
  const done = renderer.compileAsync(root, camera, root === scene ? null : scene);
  renderer.setRenderTarget(prev);
  for (const o of culled) o.frustumCulled = true;
  await done;
}

export type Post = Awaited<ReturnType<typeof createPost>>;

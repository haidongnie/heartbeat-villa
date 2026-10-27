import * as THREE from 'three/webgpu';
import {
  texture, uv, time, vec2, vec3, color, normalMap, positionWorld, mix, smoothstep, uniform, float,
} from 'three/tsl';
import { PRIO, type Assets } from '../core/assets';
import { GROUND_TEX, HDR, POOL_TILES } from '../core/bootPlan';
import { Collision } from './collision';
import { Effects } from './fx';
import { BigScreen, makeNeonSign } from './screen';

export type Tod = 'sunset' | 'dusk' | 'night' | 'storm';

interface TodPreset {
  sun: number; sunI: number; env: number; bg: number; fog: number; fogFar: number; exposure: number;
  fire: number; bulbs: number; pool: number; neon: number; stars: number; rain: number;
}
const TOD: Record<Tod, TodPreset> = {
  sunset: { sun: 0xffa86e, sunI: 2.8, env: 0.7, bg: 0.62, fog: 0xc98a7e, fogFar: 300, exposure: 0.92, fire: 0.7, bulbs: 0.6, pool: 1, neon: 1.2, stars: 0, rain: 0 },
  dusk: { sun: 0xff8a9a, sunI: 0.9, env: 0.42, bg: 0.36, fog: 0x6b4a6e, fogFar: 220, exposure: 1.1, fire: 1.1, bulbs: 1.2, pool: 3, neon: 2.2, stars: 0.35, rain: 0 },
  night: { sun: 0x8ea8ff, sunI: 0.38, env: 0.13, bg: 0.07, fog: 0x10142a, fogFar: 170, exposure: 1.2, fire: 1.6, bulbs: 2.4, pool: 6, neon: 3.2, stars: 1, rain: 0 },
  storm: { sun: 0x8a97b5, sunI: 0.25, env: 0.1, bg: 0.035, fog: 0x0d1018, fogFar: 110, exposure: 1.2, fire: 1.0, bulbs: 2.0, pool: 5, neon: 3.0, stars: 0, rain: 1 },
};

// ---- Layout (metres). Characters face +Z in model space; ry = atan2(dx, dz). ----
export const POOL = { x0: -6, x1: 6, z0: -6, z1: 0 };
export const SCREEN = { x: 0, z: -16.6 };
export const HOST_SPOT = { x: 5.6, z: -14.0 };
export const BONFIRE = { x: 0, z: 14 };
const SEAT_R = 3.75;
const DECK = { x0: -10.5, x1: 10.5, z0: -17.6, z1: 3.2 };

export interface Pose { x: number; z: number; ry: number }
export const faceTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

export function seatPose(i: number): Pose & { a: number } {
  const a = (i * Math.PI) / 3 + Math.PI / 6;
  const x = BONFIRE.x + Math.cos(a) * SEAT_R, z = BONFIRE.z + Math.sin(a) * SEAT_R;
  return { x, z, ry: faceTo(x, z, BONFIRE.x, BONFIRE.z), a };
}
/** Cast standing in a row in front of the big screen, turned slightly inwards. */
export function stagePose(i: number, n: number): Pose {
  const x = (i - (n - 1) / 2) * 1.35, z = -10.6;
  return { x, z, ry: faceTo(x, z, x * 0.4, SCREEN.z) };
}
/** Opening lineup facing the pool. */
export function lineupPose(i: number, n: number): Pose {
  const x = (i - (n - 1) / 2) * 1.7, z = -9.8;
  return { x, z, ry: 0 };
}
/** Couples and singles gather around the fire in the finale. */
export function finalePose(i: number): Pose {
  const a = (i * Math.PI) / 3 + Math.PI / 6;
  const r = 6.0;
  const x = BONFIRE.x + Math.cos(a) * r, z = BONFIRE.z + Math.sin(a) * r;
  return { x, z, ry: faceTo(x, z, BONFIRE.x, BONFIRE.z) };
}

export const POIS: { name: string; x: number; z: number }[] = [
  { name: 'pool-w', x: -7.3, z: -3 }, { name: 'pool-e', x: 7.3, z: -3 }, { name: 'pool-s', x: 0, z: 1.6 },
  { name: 'pool-n', x: -2, z: -8 }, { name: 'sofa', x: -11.8, z: -4.6 }, { name: 'egg', x: -14.8, z: 0.6 },
  { name: 'bar', x: 12.3, z: -7.4 }, { name: 'surf', x: 15.8, z: -0.5 }, { name: 'arch', x: 10.6, z: 7.6 },
  { name: 'swing', x: 14.2, z: 12.3 }, { name: 'fire', x: -5.6, z: 9.4 }, { name: 'beach', x: 6, z: 21 },
  { name: 'palm', x: -16, z: 10 }, { name: 'screen', x: -3, z: -12.5 },
];

interface PropSpec { name: string; x: number; z: number; rot: number; size: number; by: 'h' | 'w'; y?: number; solid?: 'box' | 'circle' | 'none'; r?: number }

/**
 * Collision footprints (w, d after the 0.92 shrink) for the 'box' props, measured from public/models with
 * gltf-transform getBounds (scratch bounds.mjs). Hard-coding them registers collision before the GLBs arrive, so
 * every client collides identically whatever it has loaded. placeProp() warns in dev if a re-exported model drifts.
 */
const FOOTPRINT: Record<string, [number, number]> = {
  sofa: [3.588, 2.234], bar: [4.048, 1.970], lounger: [0.721, 1.932], swing: [2.392, 1.235],
};
/** Sun direction matching the sky's bright glow (azimuth measured from the source HDRI; elevation fixed at 26° for flattering shadows). */
const SUN_DIR_SUNSET_2K = new THREE.Vector3(0.7111, 0.4384, 0.5497);

const PALMS: [number, number, number][] = [
  [-22, -13, 9], [-24.5, -3, 8.2], [-23, 7, 9.5], [-18.5, 15.5, 8.6], [-10, 21, 9.2], [-3, 24.5, 8], [9.5, 22.5, 9.4],
  [20.5, 16, 8.8], [24.3, 5, 9.6], [23.5, -5.5, 8.4], [19.5, -14.5, 9], [-14.5, -16.5, 8.5], [14.2, -17.2, 8.2], [-8, 9, 7.6],
];

export class World {
  readonly scene = new THREE.Scene();
  readonly collision = new Collision();
  readonly effects = new Effects();
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly screen = new BigScreen();
  bottle!: THREE.Group;
  private sunDir = SUN_DIR_SUNSET_2K.clone().normalize();
  private fireLight = new THREE.PointLight(0xff7a2e, 0, 22, 1.6);
  private poolLight = new THREE.PointLight(0x3fe6ff, 0, 11, 1.6);
  private screenLight = new THREE.PointLight(0x9fb6ff, 0, 14, 1.8);
  private lightningLight = new THREE.DirectionalLight(0xc8d6ff, 0);
  private bulbs = uniform(1);
  private neon = uniform(1);
  private stars!: THREE.Points;
  private starsOpacity = uniform(0);
  private flamingo?: THREE.Object3D;
  private tod: TodPreset = { ...TOD.sunset };
  private target: TodPreset = TOD.sunset;
  private lightning = 0;
  exposure = 1;
  /** 0..1 lightning flash for the post grade. */
  flash = 0;

  constructor(private readonly assets: Assets, private readonly shadowSize: number) {
    this.buildStatic();
  }

  /**
   * Everything that needs no download: lights, fog, screen, stars, bottle, string lights, bonfire flames and the
   * complete collision map. Runs in the constructor, so world.bottle / world.collision / scene.fog always exist.
   */
  private buildStatic() {
    const s = this.scene;
    s.fog = new THREE.Fog(0xc98a7e, 70, 300);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    const sc = this.sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 140;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.intensity = 0.82;
    this.sun.target.position.set(0, 0, -1);
    this.sun.position.copy(this.sunDir).multiplyScalar(70).add(this.sun.target.position);
    s.add(this.sun, this.sun.target, this.lightningLight);
    this.lightningLight.position.set(10, 40, 20);

    this.fireLight.position.set(BONFIRE.x, 1.4, BONFIRE.z);
    this.poolLight.position.set(0, -0.8, -3);
    this.screenLight.position.set(SCREEN.x, 3.2, SCREEN.z + 3);
    s.add(this.fireLight, this.poolLight, this.screenLight);

    this.buildScreen();
    this.buildStars();
    this.buildBottle();
    this.buildStringLights();
    this.registerPropCollision();
    s.add(this.effects.group);
    this.effects.addFire(BONFIRE.x, 0.35, BONFIRE.z, 1.6);
    this.setTod('sunset', true);
  }

  /** (a) The title backdrop: HDR lighting, island, sea, deck, pool, villa. Downloads run in parallel. */
  async buildCore() {
    const s = this.scene;
    const [hdr] = await Promise.all([
      this.assets.env(HDR, PRIO.core),
      this.buildGround(),
      this.assets.model('villa', PRIO.core),
    ]);
    s.environment = hdr;
    s.background = hdr;
    s.backgroundBlurriness = 0.02;
    this.buildPool();
    this.placeProp('villa', (await this.assets.model('villa')).scene);
  }

  /** Every non-core prop, streamed in by priority. onPlaced runs before the group is added to the scene. */
  streamProps(names: readonly string[], prio: number, onPlaced: (group: THREE.Group, name: string) => Promise<void>) {
    return Promise.all(names.map(async (n) => {
      let src: THREE.Object3D;
      try { src = (await this.assets.model(n, prio)).scene; } catch (e) { console.warn('[world] missing prop', n, e); return; }
      const group = this.placeProp(n, src, false);
      await onPlaced(group, n);
      this.scene.add(group);
    }));
  }

  private async buildGround() {
    const A = this.assets;
    const srgb = (p: string) => p.endsWith('_diff.webp');
    const [sd, sn, sr, wd, wn, wr, waterN] = await Promise.all(GROUND_TEX.map((p) => A.texture(p, srgb(p), PRIO.core)));
    this.waterNormals = waterN;

    // Island: flat walkable plateau, irregular shoreline, sloping into the sea. Pool cells cut out.
    const SIZE = 150, SEG = 200;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const th = Math.atan2(z, x), r = Math.hypot(x, z);
      const rr = r * (1 + 0.05 * Math.sin(3 * th + 0.6) + 0.035 * Math.sin(5 * th + 2.1) + 0.02 * Math.sin(9 * th));
      let h = -smooth(29, 41, rr) * 3.4;
      h += Math.sin(x * 0.31 + z * 0.17) * Math.cos(z * 0.23 - x * 0.11) * 0.18 * smooth(25, 31, rr);
      if (x > DECK.x0 - 0.8 && x < DECK.x1 + 0.8 && z > DECK.z0 - 0.8 && z < DECK.z1 + 0.8) h = Math.min(h, -0.06);
      pos.setY(i, h);
    }
    const idx = geo.getIndex()!;
    const keep: number[] = [];
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      if (cx > POOL.x0 && cx < POOL.x1 && cz > POOL.z0 && cz < POOL.z1) continue;
      keep.push(a, b, c);
    }
    geo.setIndex(keep);
    geo.computeVertexNormals();
    const suv = positionWorld.xz.mul(1 / 2.6);
    const sand = new THREE.MeshStandardNodeMaterial();
    const wet = smoothstep(-0.95, -0.3, positionWorld.y);
    sand.colorNode = texture(sd, suv).rgb.mul(color(0xfff1dc)).mul(mix(float(0.5), float(1.25), wet));
    sand.normalNode = normalMap(texture(sn, suv), vec2(0.8));
    sand.roughnessNode = texture(sr, suv).r.mul(mix(float(0.35), float(1), wet));
    const ground = new THREE.Mesh(geo, sand);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Sea with two scrolling normal layers and a lagoon-to-deep colour ramp.
    const sea = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.07, metalness: 0 });
    const wuv = positionWorld.xz.mul(0.045);
    const n1 = texture(waterN, wuv.add(vec2(time.mul(0.012), time.mul(0.008))));
    const n2 = texture(waterN, wuv.mul(2.3).add(vec2(time.mul(-0.01), time.mul(0.013))));
    sea.normalNode = normalMap(n1.add(n2).mul(0.5), vec2(0.5));
    sea.colorNode = mix(color(0x35d3c9), color(0x08324e), smoothstep(31, 80, positionWorld.xz.length()));
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), sea);
    ocean.position.y = -0.55;
    ocean.receiveShadow = true;
    this.scene.add(ocean);

    // Teak deck around the pool (four slabs) with world-space UVs.
    const deckMat = new THREE.MeshStandardNodeMaterial();
    const duv = vec2(positionWorld.z, positionWorld.x).mul(1 / 2.4);
    deckMat.colorNode = texture(wd, duv).rgb.mul(color(0xffe4cc));
    deckMat.normalNode = normalMap(texture(wn, duv), vec2(1));
    deckMat.roughnessNode = texture(wr, duv).r;
    const P = POOL, m = 0.3;
    const slabs = [
      [DECK.x0, DECK.x1, DECK.z0, P.z0 - m], [DECK.x0, DECK.x1, P.z1 + m, DECK.z1],
      [DECK.x0, P.x0 - m, P.z0 - m, P.z1 + m], [P.x1 + m, DECK.x1, P.z0 - m, P.z1 + m],
    ];
    for (const [x0, x1, z0, z1] of slabs) this.scene.add(box(x0, x1, -0.14, 0.0, z0, z1, deckMat, true));
    // Stone coping.
    const stone = new THREE.MeshStandardMaterial({ color: 0xf1ece4, roughness: 0.55 });
    const cop = [
      [P.x0 - m, P.x1 + m, P.z0 - m, P.z0], [P.x0 - m, P.x1 + m, P.z1, P.z1 + m],
      [P.x0 - m, P.x0, P.z0, P.z1], [P.x1, P.x1 + m, P.z0, P.z1],
    ];
    for (const [x0, x1, z0, z1] of cop) this.scene.add(box(x0, x1, -0.14, 0.05, z0, z1, stone, true));
  }

  private waterNormals!: THREE.Texture;

  private buildPool() {
    const P = POOL;
    const w = P.x1 - P.x0, d = P.z1 - P.z0, depth = 1.5;
    const tiles = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 0.3 });
    this.assets.texture(POOL_TILES, true, PRIO.early).then((t) => {
      tiles.colorNode = texture(t, uv().mul(vec2(w / 1.2, d / 1.2))).rgb.mul(color(0x8fe9f2));
      tiles.needsUpdate = true;
    });
    const shell = new THREE.Mesh(new THREE.BoxGeometry(w, depth, d), tiles);
    shell.position.set((P.x0 + P.x1) / 2, -depth / 2 - 0.001, (P.z0 + P.z1) / 2);
    shell.receiveShadow = true;
    this.scene.add(shell);

    const water = new THREE.MeshPhysicalNodeMaterial({ transparent: true, roughness: 0.03, metalness: 0 });
    const wuv = positionWorld.xz.mul(0.22);
    const a = texture(this.waterNormals, wuv.add(vec2(time.mul(0.03), time.mul(0.02))));
    const b = texture(this.waterNormals, wuv.mul(1.7).add(vec2(time.mul(-0.025), time.mul(0.03))));
    water.normalNode = normalMap(a.add(b).mul(0.5), vec2(0.25));
    water.colorNode = color(0x29c6d6);
    water.opacityNode = float(0.62);
    const surf = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), water);
    surf.position.set((P.x0 + P.x1) / 2, -0.13, (P.z0 + P.z1) / 2);
    surf.receiveShadow = true;
    this.scene.add(surf);
  }

  private buildScreen() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.35, metalness: 0.8 });
    const W = 7.6, H = W * 9 / 16, bottom = 1.5;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, bottom + H + 0.3, 0.28), metal);
      post.position.set(sx * (W / 2 + 0.2), (bottom + H + 0.3) / 2, -0.15);
      post.castShadow = true;
      g.add(post);
    }
    const frame = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, H + 0.4, 0.22), metal);
    frame.position.set(0, bottom + H / 2, -0.12);
    frame.castShadow = true;
    g.add(frame);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.screen.material);
    panel.position.set(0, bottom + H / 2, 0.0);
    g.add(panel);
    const sign = makeNeonSign(this.neon);
    sign.position.set(0, bottom + H + 1.0, -0.05);
    g.add(sign);
    g.position.set(SCREEN.x, 0, SCREEN.z);
    this.scene.add(g);
    this.collision.addRect(SCREEN.x - W / 2 - 0.5, SCREEN.x + W / 2 + 0.5, SCREEN.z - 0.6, SCREEN.z + 0.3);
  }

  private buildStars() {
    const n = 1600, p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 0.95 + 0.05, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      p.set([Math.cos(th) * s * 400, u * 400, Math.sin(th) * s * 400], i * 3);
      const b = 0.6 + Math.random() ** 3 * 4;
      c.set([b, b, b * (0.9 + Math.random() * 0.2)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const mat = new THREE.PointsNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false });
    mat.opacityNode = this.starsOpacity;
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  private buildBottle() {
    const pts = [
      [0, 0], [0.11, 0], [0.12, 0.02], [0.12, 0.3], [0.1, 0.38], [0.045, 0.46], [0.04, 0.62], [0.05, 0.64], [0, 0.64],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x2f9e5a, roughness: 0.08, metalness: 0, emissive: 0x1aff7a, emissiveIntensity: 0.4, clearcoat: 1 });
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), glass);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = -0.32;
    mesh.scale.setScalar(1.6);
    this.bottle = new THREE.Group();
    this.bottle.add(mesh);
    this.bottle.position.set(BONFIRE.x, 2.6, BONFIRE.z);
    this.bottle.visible = false;
    this.scene.add(this.bottle);
  }

  private specs(): PropSpec[] {
    const specs: PropSpec[] = [
      { name: 'villa', x: 0, z: -31.5, rot: 0, size: 26, by: 'w', solid: 'none' },
      { name: 'sofa', x: -13.6, z: -5.2, rot: 75, size: 3.9, by: 'w' },
      { name: 'eggchair', x: -16.4, z: -0.6, rot: 105, size: 2.1, by: 'h', solid: 'circle', r: 0.6 },
      { name: 'monstera', x: -16.8, z: -9.4, rot: 20, size: 1.5, by: 'h', solid: 'circle', r: 0.45 },
      { name: 'monstera', x: -11.3, z: -11.2, rot: 140, size: 1.2, by: 'h', solid: 'circle', r: 0.4 },
      { name: 'monstera', x: 11.6, z: -11.4, rot: 60, size: 1.3, by: 'h', solid: 'circle', r: 0.4 },
      { name: 'monstera', x: 17.6, z: -3.6, rot: 200, size: 1.45, by: 'h', solid: 'circle', r: 0.45 },
      { name: 'bar', x: 15.4, z: -8.2, rot: -90, size: 4.4, by: 'w' },
      { name: 'surfboard', x: 17.6, z: -0.6, rot: -80, size: 2.6, by: 'h', solid: 'circle', r: 0.3 },
      { name: 'lounger', x: -8.3, z: -4.4, rot: 90, size: 2.1, by: 'w' },
      { name: 'lounger', x: -8.3, z: -1.5, rot: 90, size: 2.1, by: 'w' },
      { name: 'lounger', x: 8.3, z: -4.4, rot: -90, size: 2.1, by: 'w' },
      { name: 'lounger', x: 8.3, z: -1.5, rot: -90, size: 2.1, by: 'w' },
      { name: 'umbrella', x: -8.7, z: -7.3, rot: 0, size: 3.2, by: 'w', solid: 'circle', r: 0.15 },
      { name: 'umbrella', x: 8.7, z: -7.3, rot: 30, size: 3.2, by: 'w', solid: 'circle', r: 0.15 },
      { name: 'arch', x: 12.2, z: 5.8, rot: -55, size: 3.1, by: 'h', solid: 'none' },
      { name: 'swing', x: 16.2, z: 10.2, rot: -50, size: 2.6, by: 'w' },
      { name: 'bonfire', x: BONFIRE.x, z: BONFIRE.z, rot: 0, size: 1.9, by: 'w', solid: 'circle', r: 1.1 },
      { name: 'flamingo', x: 2.6, z: -3.4, rot: 30, size: 1.5, by: 'w', y: -0.3, solid: 'none' },
    ];
    for (let i = 0; i < 6; i++) {
      const p = seatPose(i);
      specs.push({ name: 'logbench', x: p.x, z: p.z, rot: THREE.MathUtils.radToDeg(p.ry), size: 1.7, by: 'w', solid: 'none' });
    }
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      specs.push({ name: 'torch', x: BONFIRE.x + Math.cos(a) * 7.4, z: BONFIRE.z + Math.sin(a) * 7.4, rot: 0, size: 2.3, by: 'h', solid: 'circle', r: 0.12 });
    }
    for (const [x, z] of [[-2.2, 5.2], [2.2, 5.2], [-11, 3.6], [11, 3.6]]) {
      specs.push({ name: 'torch', x, z, rot: 0, size: 2.3, by: 'h', solid: 'circle', r: 0.12 });
    }
    PALMS.forEach(([x, z, h], i) => specs.push({ name: 'palm', x, z, rot: i * 47, size: h, by: 'h', solid: 'circle', r: 0.35 }));
    return specs;
  }

  /** The whole collision map from layout data alone (pool, screen rects are added by their builders). */
  private registerPropCollision() {
    const P = POOL, m = 0.3;
    this.collision.addRect(P.x0 - m, P.x1 + m, P.z0 - m, P.z1 + m);
    for (const s of this.specs()) {
      const solid = s.solid ?? 'box';
      if (solid === 'circle') this.collision.addCircle(s.x, s.z, s.r ?? 0.5);
      else if (solid === 'box') {
        const fp = FOOTPRINT[s.name];
        if (fp) this.collision.addBox(s.x, s.z, fp[0], fp[1], THREE.MathUtils.degToRad(s.rot));
        else console.warn('[world] no footprint for', s.name);
      }
    }
    for (let i = 0; i < 6; i++) {
      // Benches: solid behind the seat line so seated characters can still be reached.
      const p = seatPose(i);
      this.collision.addCircle(BONFIRE.x + Math.cos(p.a) * (SEAT_R + 0.15), BONFIRE.z + Math.sin(p.a) * (SEAT_R + 0.15), 0.35);
    }
    // Arch feet.
    const ar = THREE.MathUtils.degToRad(-55);
    for (const sx of [-1.25, 1.25]) this.collision.addCircle(12.2 + Math.cos(ar) * sx, 5.8 - Math.sin(ar) * sx, 0.25);
  }

  /** Instances of one prop type as a single group (one precompile, one pop-in). Adds it to the scene unless told not to. */
  placeProp(name: string, src: THREE.Object3D, add = true) {
    const group = new THREE.Group();
    group.name = `props:${name}`;
    const box3 = new THREE.Box3(), size = new THREE.Vector3();
    box3.setFromObject(src);
    box3.getSize(size);
    for (const s of this.specs()) {
      if (s.name !== name) continue;
      const obj = src.clone();
      const k = s.size / (s.by === 'h' ? size.y : Math.max(size.x, size.z));
      obj.scale.setScalar(k);
      obj.position.set(s.x - ((box3.min.x + box3.max.x) / 2) * k, (s.y ?? 0) - box3.min.y * k, s.z - ((box3.min.z + box3.max.z) / 2) * k);
      const pivot = new THREE.Group();
      pivot.position.set(s.x, 0, s.z);
      pivot.rotation.y = THREE.MathUtils.degToRad(s.rot);
      obj.position.x -= s.x; obj.position.z -= s.z;
      pivot.add(obj);
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = s.name !== 'villa' || true;
          m.receiveShadow = true;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat && 'roughness' in mat && !mat.roughnessMap) mat.roughness = Math.max(mat.roughness, 0.55);
        }
      });
      group.add(pivot);
      if (s.name === 'flamingo') this.flamingo = pivot;
      if (s.name === 'torch') this.effects.addFire(s.x, size.y * k * 0.97, s.z, 0.32);
      const fp = FOOTPRINT[s.name];
      if (import.meta.env.DEV && fp && Math.abs(fp[0] - size.x * k * 0.92) > 0.05) console.warn('[world] footprint drift', s.name, fp, size.x * k * 0.92, size.z * k * 0.92);
    }
    if (add) this.scene.add(group);
    return group;
  }

  private buildStringLights() {
    const lines: [number, number, number, number][] = [
      [DECK.x0, DECK.z0 + 1, DECK.x0, DECK.z1], [DECK.x1, DECK.z0 + 1, DECK.x1, DECK.z1],
      [DECK.x0, DECK.z1, DECK.x1, DECK.z1], [-15.5, -11, -10.5, -12], [10.5, -12, 16.5, -11],
    ];
    const ring = 6;
    for (let i = 0; i < ring; i++) {
      const a0 = (i / ring) * Math.PI * 2 + 0.3, a1 = ((i + 1) / ring) * Math.PI * 2 + 0.3;
      lines.push([BONFIRE.x + Math.cos(a0) * 9, BONFIRE.z + Math.sin(a0) * 9, BONFIRE.x + Math.cos(a1) * 9, BONFIRE.z + Math.sin(a1) * 9]);
    }
    const H = 3.3, perM = 2.2;
    const pts: THREE.Vector3[] = [];
    const wire: number[] = [];
    const poles = new Map<string, [number, number]>();
    for (const [x0, z0, x1, z1] of lines) {
      poles.set(`${x0.toFixed(1)},${z0.toFixed(1)}`, [x0, z0]); poles.set(`${x1.toFixed(1)},${z1.toFixed(1)}`, [x1, z1]);
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L * perM);
      for (let k = 0; k <= n; k++) {
        const t = k / n, sag = Math.sin(t * Math.PI) * Math.min(0.9, L * 0.06);
        const p = new THREE.Vector3(x0 + (x1 - x0) * t, H - sag, z0 + (z1 - z0) * t);
        if (k > 0) wire.push(...pts[pts.length - 1].toArray(), ...p.toArray());
        pts.push(p);
      }
    }
    const bulbMat = new THREE.MeshBasicNodeMaterial();
    bulbMat.colorNode = vec3(1.0, 0.72, 0.42).mul(this.bulbs);
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 8, 6), bulbMat, pts.length);
    const m = new THREE.Matrix4();
    pts.forEach((p, i) => bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y - 0.06, p.z)));
    this.scene.add(bulbs);
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    this.scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x222018 })));
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 });
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, H + 0.1, 8);
    for (const [x, z] of poles.values()) {
      const p = new THREE.Mesh(poleGeo, poleMat);
      p.position.set(x, (H + 0.1) / 2, z);
      p.castShadow = true;
      this.scene.add(p);
      this.collision.addCircle(x, z, 0.12);
    }
  }

  setTod(name: Tod, instant = false) {
    this.target = TOD[name];
    if (instant) Object.assign(this.tod, this.target);
  }

  strike() { this.lightning = 1; }

  update(dt: number, camera: THREE.Camera) {
    const t = this.tod, g = this.target, k = 1 - Math.exp(-dt * 0.9);
    for (const key of Object.keys(t) as (keyof TodPreset)[]) {
      if (key === 'sun' || key === 'fog') continue;
      t[key] += (g[key] - t[key]) * k;
    }
    lerpHex(this.sun.color, g.sun, k);
    const fog = this.scene.fog as THREE.Fog;
    lerpHex(fog.color, g.fog, k);
    fog.far = t.fogFar;
    this.sun.intensity = t.sunI;
    this.scene.environmentIntensity = t.env;
    this.scene.backgroundIntensity = t.bg;
    this.exposure = t.exposure;
    const flicker = 0.85 + Math.sin(performance.now() * 0.013) * 0.08 + Math.sin(performance.now() * 0.031) * 0.07;
    this.fireLight.intensity = t.fire * 22 * flicker;
    this.effects.fireLevel = 0.7 + t.fire * 0.3;
    this.poolLight.intensity = t.pool * 4;
    this.screenLight.intensity = t.neon * 3;
    this.bulbs.value = t.bulbs;
    this.neon.value = t.neon;
    this.starsOpacity.value = t.stars;
    this.effects.rainAmount.value = t.rain;

    // Lightning: double flash, decays fast.
    if (t.rain > 0.5 && Math.random() < dt * 0.06) this.lightning = 1;
    this.lightning = Math.max(0, this.lightning - dt * 2.6);
    const fl = this.lightning > 0.6 ? 1 : this.lightning > 0.35 ? 0.2 : this.lightning > 0.15 ? 0.8 : 0;
    this.lightningLight.intensity = fl * 6;
    this.flash = fl * 0.18;
    if (this.lightning > 0.98) this.onThunder?.();

    if (this.flamingo) {
      const now = performance.now() / 1000;
      this.flamingo.position.x = 2.6 + Math.sin(now * 0.21) * 1.8;
      this.flamingo.position.z = -3.4 + Math.sin(now * 0.17 + 1) * 1.1;
      this.flamingo.rotation.y = now * 0.12;
      this.flamingo.position.y = Math.sin(now * 1.3) * 0.03;
    }
    this.screen.update(dt);
    this.effects.update(dt, camera);
  }

  onThunder?: () => void;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const _c = new THREE.Color();
function lerpHex(c: THREE.Color, hex: number, k: number) { c.lerp(_c.setHex(hex), k); }

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material, shadow: boolean) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.receiveShadow = shadow;
  m.castShadow = false;
  return m;
}

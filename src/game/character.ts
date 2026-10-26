import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Pose } from '../world/world';

const LOOPS = new Set(['idle', 'walk', 'dance', 'sit', 'talk', 'talk2']);
const WALK_REF = 1.15; // m/s the walk clips were authored at (roughly)

/** One animated cast member: Meshy rig + clips, name tag, speech bubble, smoothed movement. */
export class Character {
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  anim = '';
  height = 1.7;
  /** Where the hips sit relative to the root in the 'sit' clip (local XZ). */
  private readonly sitOffset = new THREE.Vector3();
  readonly labelEl = document.createElement('div');
  readonly bubbleEl = document.createElement('div');
  private bubbleTimer = 0;
  private readonly bubble: CSS2DObject;
  private readonly label: CSS2DObject;
  // Rendered state and network target.
  x = 0; z = 0; ry = 0;
  tx = 0; tz = 0; tr = 0;
  speed = 0;
  remoteAnim = 'idle';
  /** True while the director forces a pose (stage, seats). */
  forced = false;
  roses = 0;

  constructor(readonly id: string, gltf: GLTF, readonly displayName: string, readonly color: string) {
    const model = gltf.scene;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat?.isMeshStandardMaterial) { mat.roughness = 0.62; mat.metalness = 0; mat.envMapIntensity = 1.1; }
    });
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (!LOOPS.has(clip.name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions.set(clip.name, a);
    }
    this.measure(model);

    this.labelEl.className = 'tag';
    this.labelEl.style.setProperty('--c', color);
    this.label = new CSS2DObject(this.labelEl);
    this.label.position.set(0, this.height + 0.2, 0);
    this.bubbleEl.className = 'bubble';
    this.bubble = new CSS2DObject(this.bubbleEl);
    this.bubble.position.set(0, this.height + 0.5, 0);
    this.bubble.center.set(0.5, 1);
    this.root.add(this.label, this.bubble);
    this.setTag();
    this.play('idle', 0);
  }

  private measure(model: THREE.Object3D) {
    const hips = model.getObjectByName('Hips');
    const head = model.getObjectByName('Head') ?? model.getObjectByName('head');
    model.updateMatrixWorld(true);
    if (head) this.height = head.getWorldPosition(new THREE.Vector3()).y + 0.14;
    const sit = this.actions.get('sit');
    if (sit && hips) {
      sit.play(); this.mixer.update(0); model.updateMatrixWorld(true);
      const p = hips.getWorldPosition(new THREE.Vector3());
      this.sitOffset.set(p.x, 0, p.z);
      sit.stop(); this.mixer.update(0);
    }
  }

  setTag(nick = '', badge = '') {
    this.labelEl.innerHTML = `<b>${this.displayName}</b>${nick ? `<i>${escapeHtml(nick)}</i>` : ''}${this.roses ? `<em>🌹${this.roses}</em>` : ''}${badge}`;
  }

  clipDuration(name: string) { return this.actions.get(name)?.getClip().duration ?? 2; }
  has(name: string) { return this.actions.has(name); }

  play(name: string, fade = 0.3) {
    if (name === this.anim) return;
    const next = this.actions.get(name) ?? this.actions.get('idle');
    if (!next) return;
    this.anim = name;
    if (next === this.current) return;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
  }

  setWalkSpeed(speed: number) {
    const walk = this.actions.get('walk');
    if (walk) walk.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / WALK_REF, 0.6, 1.9));
  }

  place(p: Pose) {
    this.x = this.tx = p.x; this.z = this.tz = p.z; this.ry = this.tr = p.ry;
    this.sync();
  }

  /** Root placed so the sit clip's hips land over the bench centre. */
  seat(p: Pose) {
    const c = Math.cos(p.ry), s = Math.sin(p.ry);
    const ox = this.sitOffset.x * c + this.sitOffset.z * s;
    const oz = -this.sitOffset.x * s + this.sitOffset.z * c;
    this.place({ x: p.x - ox, z: p.z - oz, ry: p.ry });
  }

  say(text: string) {
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.add('show');
    this.bubbleTimer = 3.5 + text.length * 0.12;
  }

  /** Smooth towards the network target (remote players and AI seen by non-hosts). */
  follow(dt: number) {
    const k = 1 - Math.exp(-dt * 9);
    const dx = this.tx - this.x, dz = this.tz - this.z;
    if (dx * dx + dz * dz > 25) { this.x = this.tx; this.z = this.tz; }
    else { this.x += dx * k; this.z += dz * k; }
    this.speed = Math.hypot(dx, dz) * 9;
    this.ry = lerpAngle(this.ry, this.tr, k);
  }

  sync() {
    this.root.position.set(this.x, 0, this.z);
    this.root.rotation.y = this.ry;
  }

  update(dt: number) {
    this.sync();
    this.mixer.update(dt);
    if (this.bubbleTimer > 0 && (this.bubbleTimer -= dt) <= 0) this.bubbleEl.classList.remove('show');
  }

  headPos(out: THREE.Vector3) { return out.set(this.x, this.height - 0.12, this.z); }
}

export function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

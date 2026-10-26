import * as THREE from 'three/webgpu';
import { uniform, float, vec3, hash, instanceIndex, positionLocal, time } from 'three/tsl';

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const dotTexture = () => canvasTexture(64, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, s, s);
});

export const heartTexture = () => canvasTexture(128, (g, s) => {
  g.translate(s / 2, s / 2 + 6); g.scale(s / 128, s / 128);
  g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 14;
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, 34);
  g.bezierCurveTo(-60, -6, -40, -58, 0, -26);
  g.bezierCurveTo(40, -58, 60, -6, 0, 34);
  g.fill();
});

/**
 * CPU billboard particles on one InstancedMesh (one draw call per system).
 * Colours can exceed 1 so additive particles feed the bloom pass.
 */
export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private head = 0;
  private readonly p: Float32Array; private readonly v: Float32Array;
  private readonly c: Float32Array; private readonly life: Float32Array; private readonly max: Float32Array;
  private readonly size: Float32Array; private readonly grav: Float32Array; private readonly drag: Float32Array;
  private readonly m = new THREE.Matrix4(); private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(); private readonly t = new THREE.Vector3(); private readonly col = new THREE.Color();

  constructor(map: THREE.Texture, capacity: number, additive = true) {
    this.n = capacity;
    const mat = new THREE.MeshBasicNodeMaterial({
      map, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.p = new Float32Array(capacity * 3); this.v = new Float32Array(capacity * 3);
    this.c = new Float32Array(capacity * 3); this.life = new Float32Array(capacity); this.max = new Float32Array(capacity);
    this.size = new Float32Array(capacity); this.grav = new Float32Array(capacity); this.drag = new Float32Array(capacity);
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.m);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number,
    r: number, g: number, b: number, gravity = 0, drag = 0) {
    const i = this.head; this.head = (this.head + 1) % this.n;
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3); this.c.set([r, g, b], i * 3);
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grav[i] = gravity; this.drag[i] = drag;
  }

  update(dt: number, camera: THREE.Camera) {
    camera.getWorldQuaternion(this.q);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0) { this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); continue; }
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.v[k] *= damp; this.v[k + 1] = this.v[k + 1] * damp + this.grav[i] * dt; this.v[k + 2] *= damp;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      const t = this.life[i] / this.max[i];
      const fade = Math.min(1, t * 2.2) * Math.min(1, (1 - t) * 8 + 0.2);
      this.s.setScalar(this.size[i] * (0.55 + 0.45 * t));
      this.t.set(this.p[k], this.p[k + 1], this.p[k + 2]);
      this.m.compose(this.t, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.col.setRGB(this.c[k] * fade, this.c[k + 1] * fade, this.c[k + 2] * fade);
      this.mesh.setColorAt(i, this.col);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

/** All transient effects of the show: fire, embers, hearts, fireworks, rain. */
export class Effects {
  readonly group = new THREE.Group();
  readonly glow = new Particles(dotTexture(), 900);
  readonly hearts = new Particles(heartTexture(), 160);
  readonly rainAmount = uniform(0);
  private readonly rainCenter = uniform(new THREE.Vector3());
  private fires: { x: number; y: number; z: number; s: number; acc: number }[] = [];
  fireLevel = 1;
  private rockets: { x: number; y: number; z: number; vy: number; t: number; hue: number }[] = [];

  constructor() {
    this.group.add(this.glow.mesh, this.hearts.mesh, this.makeRain());
  }

  addFire(x: number, y: number, z: number, s: number) { this.fires.push({ x, y, z, s, acc: 0 }); }

  private makeRain() {
    const N = 2200;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const i = float(instanceIndex);
    const span = 36;
    const rx = hash(i).sub(0.5).mul(span);
    const rz = hash(i.add(17.13)).sub(0.5).mul(span);
    const y = hash(i.add(3.7)).mul(18).sub(time.mul(17)).mod(18).sub(1);
    mat.positionNode = positionLocal.add(vec3(this.rainCenter.x.add(rx), y, this.rainCenter.z.add(rz)));
    mat.colorNode = vec3(0.75, 0.82, 0.95);
    mat.opacityNode = this.rainAmount.mul(0.32);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.55, 0.012), mat, N);
    mesh.frustumCulled = false;
    return mesh;
  }

  heartBurst(x: number, y: number, z: number, n = 14, color = new THREE.Color(3, 0.6, 1.2)) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 0.9;
      this.hearts.emit(x, y, z, Math.cos(a) * sp, 1.0 + Math.random() * 1.2, Math.sin(a) * sp,
        1.6 + Math.random() * 0.8, 0.22 + Math.random() * 0.2, color.r, color.g, color.b, -0.3, 0.6);
    }
  }

  heartbreak(x: number, y: number, z: number) {
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * Math.PI * 2;
      this.hearts.emit(x, y, z, Math.cos(a) * 0.8, 0.6 + Math.random() * 0.6, Math.sin(a) * 0.8,
        1.4, 0.18, 0.5, 0.45, 0.8, -3.5, 0.2);
    }
  }

  firework(x: number, z: number) {
    this.rockets.push({ x, y: 0.5, z, vy: 16 + Math.random() * 5, t: 0.9 + Math.random() * 0.5, hue: Math.random() });
  }

  update(dt: number, camera: THREE.Camera) {
    // Flames and embers.
    for (const f of this.fires) {
      f.acc += f.s * this.fireLevel * 22 * dt;
      for (; f.acc >= 1; f.acc--) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.32 * f.s;
        const heat = 0.6 + Math.random() * 0.6;
        this.glow.emit(f.x + Math.cos(a) * r, f.y, f.z + Math.sin(a) * r,
          (Math.random() - 0.5) * 0.2, (1.0 + Math.random() * 1.0) * f.s, (Math.random() - 0.5) * 0.2,
          0.4 + Math.random() * 0.4, (0.32 + Math.random() * 0.26) * f.s, 1.8 * heat, 0.5 * heat, 0.07 * heat, 0.6, 0.4);
      }
      if (f.s > 1 && Math.random() < 6 * dt * this.fireLevel) {
        this.glow.emit(f.x, f.y + 0.4, f.z, (Math.random() - 0.5) * 0.8, 2 + Math.random() * 2, (Math.random() - 0.5) * 0.8,
          1.6 + Math.random(), 0.06, 4, 1.6, 0.4, -0.3, 0.3);
      }
    }
    // Fireworks.
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.t -= dt; r.y += r.vy * dt; r.vy -= 9 * dt;
      this.glow.emit(r.x, r.y, r.z, 0, -1, 0, 0.35, 0.18, 3, 2.2, 1.2);
      if (r.t <= 0) {
        const c = new THREE.Color().setHSL(r.hue, 0.9, 0.6).multiplyScalar(4);
        for (let k = 0; k < 110; k++) {
          const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
          const sp = 7 + Math.random() * 3;
          this.glow.emit(r.x, r.y, r.z, s * Math.cos(th) * sp, u * sp, s * Math.sin(th) * sp,
            1.4 + Math.random() * 0.8, 0.35, c.r, c.g, c.b, -4, 1.6);
        }
        this.rockets.splice(i, 1);
        this.onBoom?.();
      }
    }
    camera.getWorldPosition(this.rainCenter.value as THREE.Vector3);
    this.glow.update(dt, camera);
    this.hearts.update(dt, camera);
  }

  onBoom?: () => void;
}

import * as THREE from 'three/webgpu';

/**
 * Third-person orbit camera for free roam, plus scripted "shots" the show uses for its beats.
 * Every frame the game asks for either follow() or shot(); update() eases towards it.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 700);
  yaw = 0;
  pitch = 0.3;
  dist = 5.6;
  private readonly pos = new THREE.Vector3(0, 12, 30);
  private readonly look = new THREE.Vector3(0, 1, 0);
  private readonly wantPos = new THREE.Vector3();
  private readonly wantLook = new THREE.Vector3();
  private wantFov = 50;
  private stiffness = 8;
  private snap = true;

  follow(target: THREE.Vector3) {
    const cp = Math.cos(this.pitch);
    this.wantLook.copy(target).y += 0.15;
    this.wantPos.set(
      target.x + Math.sin(this.yaw) * cp * this.dist,
      target.y + 0.25 + Math.sin(this.pitch) * this.dist,
      target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.wantFov = 50;
    this.stiffness = 10;
  }

  shot(pos: THREE.Vector3Like, look: THREE.Vector3Like, fov = 38, stiffness = 2.2) {
    this.wantPos.set(pos.x, pos.y, pos.z);
    this.wantLook.set(look.x, look.y, look.z);
    this.wantFov = fov;
    this.stiffness = stiffness;
  }

  /** Jump straight to the requested framing on the next update (hard cut). */
  cut() { this.snap = true; }

  /** Orbit yaw that puts the camera behind a character facing `ry`. */
  behind(ry: number) { this.yaw = ry + Math.PI; }

  /** Ground-plane forward/right of the camera, for movement input. */
  basis() {
    return { fx: -Math.sin(this.yaw), fz: -Math.cos(this.yaw), rx: Math.cos(this.yaw), rz: -Math.sin(this.yaw) };
  }

  update(dt: number) {
    const k = this.snap ? 1 : 1 - Math.exp(-dt * this.stiffness);
    this.snap = false;
    this.pos.lerp(this.wantPos, k);
    this.look.lerp(this.wantLook, k);
    if (this.pos.y < 0.35) this.pos.y = 0.35;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    const f = this.camera.fov + (this.wantFov - this.camera.fov) * k;
    if (Math.abs(f - this.camera.fov) > 0.01) { this.camera.fov = f; this.camera.updateProjectionMatrix(); }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}

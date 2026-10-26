/** Flat 2D collision for a walkable island: circles, axis-aligned rects, and the island rim. */
export interface Circle { x: number; z: number; r: number }
export interface Rect { x0: number; x1: number; z0: number; z1: number }

export class Collision {
  circles: Circle[] = [];
  rects: Rect[] = [];
  /** Walkable radius around the origin and the northern limit (screen / villa). */
  radius = 27;
  northZ = -17.2;

  addCircle(x: number, z: number, r: number) { this.circles.push({ x, z, r }); }
  addRect(x0: number, x1: number, z0: number, z1: number) { this.rects.push({ x0, x1, z0, z1 }); }

  /** Rotated box footprint approximated by a row of circles along its long axis. */
  addBox(x: number, z: number, w: number, d: number, rotY: number) {
    const long = Math.max(w, d), short = Math.min(w, d);
    const n = Math.max(1, Math.ceil(long / short));
    const ax = w >= d ? 1 : 0;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
      const lx = ax ? t : 0, lz = ax ? 0 : t;
      this.addCircle(x + lx * c + lz * s, z - lx * s + lz * c, short / 2);
    }
  }

  /** Push a body of radius `br` at (x, z) out of every obstacle; returns the corrected point. */
  resolve(x: number, z: number, br = 0.3): [number, number] {
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.circles) {
        const dx = x - c.x, dz = z - c.z, rr = c.r + br;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-8) { const d = Math.sqrt(d2); x = c.x + (dx / d) * rr; z = c.z + (dz / d) * rr; }
      }
      for (const r of this.rects) {
        const x0 = r.x0 - br, x1 = r.x1 + br, z0 = r.z0 - br, z1 = r.z1 + br;
        if (x > x0 && x < x1 && z > z0 && z < z1) {
          const pushes = [x - x0, x1 - x, z - z0, z1 - z];
          const m = Math.min(...pushes);
          if (m === pushes[0]) x = x0; else if (m === pushes[1]) x = x1; else if (m === pushes[2]) z = z0; else z = z1;
        }
      }
    }
    const d = Math.hypot(x, z);
    if (d > this.radius) { x *= this.radius / d; z *= this.radius / d; }
    if (z < this.northZ) z = this.northZ;
    return [x, z];
  }

  blocked(x: number, z: number, br = 0.3) {
    const [rx, rz] = this.resolve(x, z, br);
    return Math.abs(rx - x) + Math.abs(rz - z) > 0.01;
  }
}

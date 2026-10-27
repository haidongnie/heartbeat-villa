import * as THREE from 'three/webgpu';
import { texture, uniform, float } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import { url } from '../core/assets';

const W = 1024, H = 576;
const FONT = '"ZCOOL KuaiLe", "Noto Sans SC", "PingFang SC", sans-serif';
const BODY = '"Noto Sans SC", "PingFang SC", sans-serif';

const portraits = new Map<string, HTMLImageElement>();
export function portrait(id: string) {
  let img = portraits.get(id);
  if (!img) { img = new Image(); img.src = url(`portraits/${id}.webp`); portraits.set(id, img); }
  return img;
}

export type ScreenContent =
  | { kind: 'idle' }
  | { kind: 'title'; title: string; sub?: string }
  | { kind: 'leak'; who: string; name: string; secret: string }
  | { kind: 'counts'; title: string; rows: { who: string; name: string; n: number; color: string }[] }
  | { kind: 'spotlight'; who: string; name: string; title: string; body: string; color?: string }
  | { kind: 'pair'; a: string; b: string; an: string; bn: string; title: string; match: boolean };

/** The villa's LED wall: a canvas texture redrawn when the show changes beats. */
export class BigScreen {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicNodeMaterial;
  private readonly glow = uniform(1.25);
  private content: ScreenContent = { kind: 'idle' };
  private t = 0;
  private dirty = true;

  constructor() {
    this.canvas.width = W; this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.material = new THREE.MeshBasicNodeMaterial({ toneMapped: true });
    this.material.colorNode = texture(this.tex).rgb.mul(this.glow as unknown as UniformNode<'float', number>).mul(float(1));
  }

  show(c: ScreenContent) { this.content = c; this.t = 0; this.dirty = true; }

  update(dt: number) {
    this.t += dt;
    // Animated layouts redraw at ~15 fps; static ones only on change.
    if (this.dirty || ((this.content.kind === 'idle' || this.content.kind === 'leak') && (this.t * 15) % 1 < dt * 15)) {
      this.draw();
      this.dirty = false;
    }
  }

  private bg(top: string, bottom: string) {
    const g = this.g;
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, top); grd.addColorStop(1, bottom);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.07; g.fillStyle = '#fff';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    g.globalAlpha = 1;
  }

  private heart(x: number, y: number, s: number, fill: string) {
    const g = this.g;
    g.save(); g.translate(x, y); g.scale(s, s); g.fillStyle = fill;
    g.beginPath(); g.moveTo(0, 30);
    g.bezierCurveTo(-55, -5, -35, -52, 0, -22); g.bezierCurveTo(35, -52, 55, -5, 0, 30); g.fill();
    g.restore();
  }

  private text(s: string, x: number, y: number, size: number, color: string, font = FONT, align: CanvasTextAlign = 'center') {
    const g = this.g;
    g.font = `${size}px ${font}`; g.textAlign = align; g.textBaseline = 'middle';
    g.shadowColor = color; g.shadowBlur = size * 0.35; g.fillStyle = color;
    g.fillText(s, x, y);
    g.shadowBlur = 0;
  }

  private wrap(s: string, x: number, y: number, maxW: number, size: number, color: string, lh = 1.45) {
    const g = this.g;
    g.font = `${size}px ${BODY}`;
    const lines: string[] = [];
    let line = '';
    for (const ch of s) {
      if (g.measureText(line + ch).width > maxW) { lines.push(line); line = ch; } else line += ch;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => this.text(l, x, y + i * size * lh, size, color, BODY, 'left'));
  }

  private photo(id: string, x: number, y: number, h: number, ring: string) {
    const img = portrait(id), g = this.g;
    const w = h * 0.8;
    g.save();
    const bg = g.createRadialGradient(x, y - h * 0.2, 10, x, y, h * 0.7);
    bg.addColorStop(0, 'rgba(255,255,255,0.45)'); bg.addColorStop(1, 'rgba(255,255,255,0.06)');
    g.fillStyle = bg;
    g.strokeStyle = ring; g.lineWidth = 6; g.shadowColor = ring; g.shadowBlur = 24;
    g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, 22); g.fill(); g.stroke();
    g.shadowBlur = 0; g.clip();
    if (img.complete && img.naturalWidth) {
      const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      g.drawImage(img, x - (img.naturalWidth * k) / 2, y - h / 2, img.naturalWidth * k, img.naturalHeight * k);
    } else img.onload = () => { this.dirty = true; };
    g.restore();
  }

  private draw() {
    const g = this.g, c = this.content, t = this.t;
    g.clearRect(0, 0, W, H);
    switch (c.kind) {
      case 'idle': {
        this.bg('#3b0c3f', '#120420');
        const beat = 1 + Math.max(0, Math.sin(t * 6)) ** 8 * 0.18;
        this.heart(W / 2, H / 2 - 40, 2.6 * beat, '#ff3d8b');
        this.text('心跳别墅', W / 2, H / 2 + 120, 84, '#ffd1e6');
        this.text('HEARTBEAT VILLA', W / 2, H / 2 + 190, 30, '#ff8cc0', BODY);
        break;
      }
      case 'title':
        this.bg('#4a1250', '#14051f');
        this.heart(W / 2, 120, 1.0, '#ff3d8b');
        this.text(c.title, W / 2, H / 2 + 10, 76, '#fff0f7');
        if (c.sub) this.text(c.sub, W / 2, H / 2 + 100, 32, '#ffb4d6', BODY);
        break;
      case 'leak': {
        const blink = Math.sin(t * 10) > 0;
        this.bg('#4c0612', '#140104');
        this.text(blink ? '⚠ 匿名爆料 ⚠' : '⚠  匿名爆料  ⚠', W / 2, 62, 56, '#ff4d5e');
        this.photo(c.who, 220, 330, 380, '#ff4d5e');
        this.text(c.name, 640, 170, 64, '#ffffff');
        this.wrap(c.secret, 430, 260, 540, 34, '#ffd6db');
        break;
      }
      case 'counts': {
        this.bg('#3a0f4a', '#100318');
        this.text(c.title, W / 2, 56, 52, '#ffe1f0');
        const n = c.rows.length, cw = W / n;
        const max = Math.max(1, ...c.rows.map((r) => r.n));
        c.rows.forEach((r, i) => {
          const x = cw * (i + 0.5);
          this.photo(r.who, x, 240, 200, r.color);
          for (let k = 0; k < r.n; k++) this.heart(x - ((r.n - 1) * 26) / 2 + k * 26, 405, 0.32, '#ff3d8b');
          this.text(r.n === 0 ? '0 条' : `${r.n} 条`, x, 455, r.n === max ? 44 : 36, r.n === 0 ? '#8d86a8' : '#ffffff');
          this.text(r.name, x, 510, 30, r.color, BODY);
        });
        break;
      }
      case 'spotlight':
        this.bg('#2a0f45', '#0c0418');
        this.photo(c.who, 220, 300, 420, c.color ?? '#ff7eb6');
        this.text(c.name, 650, 130, 60, c.color ?? '#ffffff');
        this.text(c.title, 650, 210, 36, '#ffd6ea', BODY);
        this.wrap(c.body, 430, 290, 540, 34, '#ffffff');
        break;
      case 'pair':
        this.bg(c.match ? '#5c1040' : '#1a1a2e', c.match ? '#1c0414' : '#08080f');
        this.photo(c.a, 250, 280, 380, c.match ? '#ff5fa2' : '#8d86a8');
        this.photo(c.b, 774, 280, 380, c.match ? '#ff5fa2' : '#8d86a8');
        this.heart(W / 2, 270, 1.2, c.match ? '#ff3d8b' : '#4a4560');
        this.text(c.title, W / 2, 520, 50, c.match ? '#ffe1f0' : '#b9b4cf');
        break;
    }
    this.tex.needsUpdate = true;
  }
}

/** Pink neon “心跳别墅” sign above the screen; brightness follows the time of day. */
export function makeNeonSign(level: UniformNode<'float', number>) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d')!;
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height);
    g.font = '150px "ZCOOL KuaiLe", "PingFang SC", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#ff4fa0'; g.shadowColor = '#ff4fa0'; g.shadowBlur = 30;
    g.strokeText('心跳别墅', 512, 128);
    g.shadowBlur = 0; g.fillStyle = '#ffd6ea'; g.fillText('心跳别墅', 512, 128);
  };
  draw();
  const tex = new THREE.CanvasTexture(c);
  // The sign is built before the web font arrives; redraw once it has.
  document.fonts?.load('150px "ZCOOL KuaiLe"', '心跳别墅').then(() => { draw(); tex.needsUpdate = true; }, () => {});
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const s = texture(tex);
  mat.colorNode = s.rgb.mul(level);
  mat.opacityNode = s.a;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), mat);
  return mesh;
}

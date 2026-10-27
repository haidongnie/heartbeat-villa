import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { UltraHDRLoader } from 'three/addons/loaders/UltraHDRLoader.js';

const MANIFEST: Record<string, [string, number]> = __ASSETS__;

/**
 * Resolve a public/ path against Vite's base and append its content hash, so the URL changes exactly
 * when the file changes (the service worker can then serve it cache-first forever).
 */
export const url = (p: string) => {
  const v = MANIFEST[p]?.[0];
  return import.meta.env.BASE_URL + p + (v ? `?v=${v}` : '');
};
export const assetBytes = (p: string) => MANIFEST[p]?.[1] ?? 1;

/** Lower number = downloaded earlier. */
export const PRIO = { core: 0, early: 10, cast: 20, props: 30, extra: 40 } as const;

interface Job { path: string; prio: number; seq: number; start: () => void }

export class Assets {
  readonly manager = new THREE.LoadingManager();
  private readonly gltf = new GLTFLoader(this.manager).setMeshoptDecoder(MeshoptDecoder);
  private readonly cache = new Map<string, Promise<unknown>>();
  /** Bytes received so far per public path (decoded size, comparable with the manifest sizes). */
  private readonly got = new Map<string, number>();
  private readonly waiting: Job[] = [];
  private active = 0;
  private coreActive = 0;
  private seq = 0;

  constructor(private readonly parallel = 6) {
    // Decode meshopt buffers off the main thread so streaming GLBs in does not stutter the title/casting screens.
    const workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    (MeshoptDecoder as { useWorkers?: (n: number) => void }).useWorkers?.(workers);
  }

  /** Memoised + prioritised: the first caller decides the priority, later callers can only raise it. */
  private enqueue<T>(path: string, prio: number, run: (onBytes: (n: number) => void) => Promise<T>): Promise<T> {
    const known = this.cache.get(path) as Promise<T> | undefined;
    if (known) {
      const job = this.waiting.find((j) => j.path === path);
      if (job && prio < job.prio) job.prio = prio;
      return known;
    }
    const p = new Promise<T>((resolve, reject) => {
      this.waiting.push({
        path, prio, seq: this.seq++,
        start: () => {
          const core = prio <= PRIO.core;
          this.active++;
          if (core) this.coreActive++;
          withRetry(() => run((n) => this.got.set(path, n)))
            .then((v) => { this.got.set(path, assetBytes(path)); resolve(v); }, reject)
            .finally(() => { this.active--; if (core) this.coreActive--; this.pump(); });
        },
      });
      this.pump();
    });
    this.cache.set(path, p);
    // A failed load must not stay cached: forget it so a later call downloads again.
    p.catch(() => { if (this.cache.get(path) === p) { this.cache.delete(path); this.got.delete(path); } });
    return p;
  }

  /**
   * Starts queued jobs in priority order. Core files are a barrier: nothing else starts while one is in flight,
   * otherwise the 2.7 MB HDR shares a saturated link with five character GLBs and the backdrop waits for them
   * (measured: backdrop 18.6 s without the barrier vs. all-ready 21.5 s at 8 Mbit/s).
   */
  private pump() {
    this.waiting.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    while (this.active < this.parallel && this.waiting.length) {
      if (this.coreActive > 0 && this.waiting[0].prio > PRIO.core) break;
      this.waiting.shift()!.start();
    }
  }

  /** 0..1 over the given public paths, weighted by file size. */
  progress(paths: readonly string[]) {
    let got = 0, total = 0;
    for (const p of paths) { const b = assetBytes(p); total += b; got += Math.min(b, this.got.get(p) ?? 0); }
    return total ? got / total : 1;
  }

  model(name: string, prio: number = PRIO.props): Promise<GLTF> {
    const path = `models/${name}.glb`;
    return this.enqueue(path, prio, (onBytes) => this.gltf.loadAsync(url(path), (e) => onBytes(e.loaded)));
  }

  /**
   * Equirect sky + image-based lighting from an Ultra HDR (gain-map) JPEG: ~96 KB instead of a 4.5 MB .hdr,
   * decoded into the same linear HalfFloat DataTexture HDRLoader used to produce.
   */
  env(path: string, prio: number = PRIO.core): Promise<THREE.DataTexture> {
    return this.enqueue(path, prio, async (onBytes) => {
      // UltraHDRLoader never settles if the image fails to decode, so give it a deadline (withRetry then retries).
      const tex = await Promise.race([
        new UltraHDRLoader(this.manager).loadAsync(url(path), (e) => onBytes(e.loaded)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout decoding ${path}`)), 20000)),
      ]);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.generateMipmaps = false; // PMREM reads level 0
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** Every caller of a given path uses the same colour space, so the cache key is the path alone. */
  texture(path: string, srgb: boolean, prio: number = PRIO.core): Promise<THREE.Texture> {
    return this.enqueue(path, prio, async () => {
      const tex = await new THREE.TextureLoader(this.manager).loadAsync(url(path));
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      return tex;
    });
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
}

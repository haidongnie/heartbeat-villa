import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/** Resolve a public/ path against Vite's base (GitHub Pages serves the game from /<repo>/). */
export const url = (p: string) => import.meta.env.BASE_URL + p;

export class Assets {
  readonly manager = new THREE.LoadingManager();
  private readonly gltf = new GLTFLoader(this.manager).setMeshoptDecoder(MeshoptDecoder);
  private readonly models = new Map<string, Promise<GLTF>>();
  private readonly textures = new Map<string, Promise<THREE.Texture>>();

  model(name: string): Promise<GLTF> {
    let p = this.models.get(name);
    if (!p) { p = this.gltf.loadAsync(url(`models/${name}.glb`)); this.models.set(name, p); }
    return p;
  }

  async hdr(path: string) {
    const tex = await new HDRLoader(this.manager).loadAsync(url(path));
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  texture(path: string, srgb: boolean, repeat = 1): Promise<THREE.Texture> {
    const key = `${path}|${repeat}`;
    let p = this.textures.get(key);
    if (!p) {
      p = new THREE.TextureLoader(this.manager).loadAsync(url(path)).then((tex) => {
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.setScalar(repeat);
        tex.anisotropy = 8;
        return tex;
      });
      this.textures.set(key, p);
    }
    return p;
  }
}

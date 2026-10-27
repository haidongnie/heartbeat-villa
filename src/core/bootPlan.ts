// What the boot downloads, in priority order. One list drives prefetching, progress bars and the ready gates.
import { CHAR_IDS, HOST } from '../data/story';

export const GROUND_TEX = [
  'textures/sand_01_diff.webp', 'textures/sand_01_nor_gl.webp', 'textures/sand_01_rough.webp',
  'textures/wood_floor_deck_diff.webp', 'textures/wood_floor_deck_nor_gl.webp', 'textures/wood_floor_deck_rough.webp',
  'textures/waternormals.webp',
] as const;
export const HDR = 'env/sunset_2k_uhdr.jpg';
export const POOL_TILES = 'textures/long_white_tiles_diff.webp';

/** Big silhouettes and the fire props first, then everything else. 'villa' is part of core. */
export const PROPS_EARLY = ['palm', 'torch', 'bonfire', 'logbench'] as const;
export const PROPS_LATE = ['lounger', 'umbrella', 'sofa', 'bar', 'eggchair', 'monstera', 'arch', 'swing', 'surfboard', 'flamingo'] as const;
export const CAST_MODELS = [HOST.id, ...CHAR_IDS] as const;

const m = (n: string) => `models/${n}.glb`;
/** (a) 3D title backdrop: lighting, ground, sea, pool, villa. */
export const CORE_PATHS = [HDR, ...GROUND_TEX, m('villa')];
/** (c)/(d) everything the show needs: core + cast + all props (the rose is optional). */
export const SHOW_PATHS = [...CORE_PATHS, POOL_TILES, ...PROPS_EARLY.map(m), ...CAST_MODELS.map(m), ...PROPS_LATE.map(m)];

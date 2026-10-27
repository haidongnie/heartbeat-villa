// Two-person interactions (hug, kiss): shared rules and staging. The host decides (consent, AI choice);
// every client then stages the same deterministic poses and clips locally, so nothing streams during the act.
import type { CharId } from '../data/story';
import type { Pose } from '../world/world';
import type { Character } from './character';

export type Kind = 'hug' | 'kiss';

export const INTERACT: Record<Kind, { dur: number; gap: number; label: string; emoji: string; range: number }> = {
  hug: { dur: 4.0, gap: 0.42, label: '拥抱', emoji: '🤗', range: 2.2 },
  kiss: { dur: 3.5, gap: 0.36, label: '亲吻', emoji: '💋', range: 2.2 },
};

/** Seconds a human has to answer before it counts as a refusal. */
export const ASK_TIMEOUT = 8;
/** Seconds before the same contestant may ask again. */
export const ASK_COOLDOWN = 6;

/** A host-approved interaction, broadcast to everyone. */
export interface Act {
  id: string;
  from: CharId;
  to: CharId;
  kind: Kind;
  ok: boolean;
  /** Why it failed, when !ok: the target said no, or never answered. */
  reason?: 'no' | 'timeout';
  /** Where both stand during an accepted act (from, to). */
  poses?: [Pose, Pose];
}

/** A pending request shown to a human target. */
export interface Ask { id: string; from: CharId; to: CharId; kind: Kind }

/** Face-to-face poses `gap` metres apart, centred between the two characters' current spots. */
export function meetPoses(a: { x: number; z: number }, b: { x: number; z: number }, gap: number): [Pose, Pose] {
  let dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz);
  if (L < 1e-3) { dx = 0; dz = 1; } else { dx /= L; dz /= L; }
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, h = gap / 2;
  return [
    { x: mx - dx * h, z: mz - dz * h, ry: Math.atan2(dx, dz) },
    { x: mx + dx * h, z: mz + dz * h, ry: Math.atan2(-dx, -dz) },
  ];
}

/** Which clip each partner plays: in a hug the taller reaches over the shoulders, the shorter around the waist. */
export function clipsFor(kind: Kind, a: Character, b: Character): [string, string] {
  if (kind === 'kiss') return ['kiss', 'kiss'];
  return a.height >= b.height ? ['hug_over', 'hug_waist'] : ['hug_waist', 'hug_over'];
}

/** AI consent: warmer feelings make a yes likelier; a kiss needs more than a hug. */
export function aiAccepts(kind: Kind, affinity: number) {
  const p = kind === 'hug' ? 0.35 + 0.2 * affinity : 0.12 + 0.17 * affinity;
  return Math.random() < Math.min(0.95, Math.max(0.05, p));
}

export const ACT_TEXT = {
  hug: (a: string, b: string) => `🤗 <b>${a}</b> 和 <b>${b}</b> 紧紧抱在了一起`,
  kiss: (a: string, b: string) => `💋 <b>${a}</b> 亲了 <b>${b}</b>`,
  no: (a: string, b: string, k: Kind) => `💔 <b>${b}</b> 拒绝了 <b>${a}</b> 的${INTERACT[k].label}`,
  timeout: (a: string, b: string, k: Kind) => `💔 <b>${b}</b> 没有回应 <b>${a}</b> 的${INTERACT[k].label}`,
};

export const ACT_HUAZI = {
  hug: ['抱住了!!', '这个拥抱好暖', '心跳加速', '空气都甜了'],
  kiss: ['亲上了!!!', '名场面诞生', '全场尖叫', '甜到犯规'],
  no: ['当场被拒!!', '空气突然安静', '尴尬了', '心碎一地'],
};

// Thin wrapper over Playroom Kit so the rest of the game never touches its globals directly.
import {
  insertCoin, onPlayerJoin, myPlayer, isHost, getState, setState, getRoomCode, RPC, type PlayerState,
} from 'playroomkit';
import type { CharId } from '../data/story';
import type { Tod } from '../world/world';

export type PhaseId =
  | 'intro' | 'roam' | 'text' | 'textReveal' | 'leak' | 'respond' | 'judge' | 'judgeReveal'
  | 'gather' | 'bottle' | 'truth' | 'truthReveal' | 'confess' | 'confessReveal' | 'finale';

export interface Phase {
  seq: number;
  step: number;
  id: PhaseId;
  ep: number;
  tod: Tod;
  dur: number;
  /** Host clock (ms). Clients only use it for the countdown display. */
  endsAt: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export type Cast = Record<CharId, string | null>;
export type Scores = Record<CharId, { h: number; d: number }>;
/** [x, z, ry, anim] */
export type NetPose = [number, number, number, string];

export const players = new Map<string, PlayerState>();
const joinOrder: string[] = [];

export const net = {
  async connect(onJoin: (p: PlayerState) => void, onQuit: (p: PlayerState) => void) {
    await insertCoin({
      skipLobby: true,
      maxPlayersPerRoom: 6,
      reconnectGracePeriod: 20000,
      gameId: import.meta.env.VITE_PLAYROOM_GAME_ID || undefined,
      defaultStates: { stage: 'casting' },
    });
    onPlayerJoin((p) => {
      players.set(p.id, p);
      if (!joinOrder.includes(p.id)) joinOrder.push(p.id);
      onJoin(p);
      p.onQuit(() => { players.delete(p.id); onQuit(p); });
    });
  },
  me: () => myPlayer(),
  isHost: () => isHost(),
  room: () => getRoomCode() ?? '',
  ordered: () => joinOrder.map((id) => players.get(id)).filter((p): p is PlayerState => !!p),
  get: <T>(key: string): T | undefined => getState(key) as T | undefined,
  set: (key: string, value: unknown, reliable = true) => setState(key, value, reliable),
  rpc: RPC,
};

/** Playroom writes the room into the URL hash (#r=...), so the current URL is the invite. */
export function inviteLink() {
  if (/[#&]r=/.test(location.hash)) return location.href;
  const u = new URL(location.href);
  u.hash = `r=${net.room()}`;
  return u.toString();
}

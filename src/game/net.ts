// Thin wrapper over Playroom Kit so the rest of the game never touches its globals directly.
// Playroom (and the React it bundles) is ~1 MB minified and only needed once the player clicks the title
// button, so it is loaded on demand into its own chunk instead of delaying the first paint.
import type { PlayerState } from 'playroomkit';
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

type Playroom = typeof import('playroomkit');
let pk: Playroom | undefined;
let pkLoading: Promise<Playroom> | undefined;

/** Fetch and evaluate the Playroom chunk once; safe to call early to warm it. A failed load can be retried. */
export function loadNet(): Promise<Playroom> {
  pkLoading ??= import('playroomkit').then(
    (m) => (pk = m),
    (e) => { pkLoading = undefined; throw e; },
  );
  return pkLoading;
}

const P = (): Playroom => {
  if (!pk) throw new Error('playroomkit used before net.connect()');
  return pk;
};

export const net = {
  async connect(onJoin: (p: PlayerState) => void, onQuit: (p: PlayerState) => void) {
    const { insertCoin, onPlayerJoin } = await loadNet();
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
  me: () => P().myPlayer(),
  isHost: () => !!pk && pk.isHost(),
  room: () => pk?.getRoomCode() ?? '',
  ordered: () => joinOrder.map((id) => players.get(id)).filter((p): p is PlayerState => !!p),
  get: <T>(key: string): T | undefined => pk?.getState(key) as T | undefined,
  set: (key: string, value: unknown, reliable = true) => P().setState(key, value, reliable),
  get rpc() { return P().RPC; },
};

/** Playroom writes the room into the URL hash (#r=...), so the current URL is the invite. */
export function inviteLink() {
  if (/[#&]r=/.test(location.hash)) return location.href;
  const u = new URL(location.href);
  u.hash = `r=${net.room()}`;
  return u.toString();
}

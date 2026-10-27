// Host-only show runner: advances the episode script, resolves everyone's secret choices,
// keeps score, and drives the AI contestants. All state it writes lives in Playroom globals,
// so if the host leaves, the next host picks up exactly where the show was.
import { CAST, CHAR, CHAR_IDS, DRAMA_FLASH, TRUTH_CARDS, type CharId, type LeakResponse } from '../data/story';
import { POIS, type Tod } from '../world/world';
import type { Collision } from '../world/collision';
import type { Character } from './character';
import { net, players, type Cast, type NetPose, type Phase, type PhaseId, type Scores } from './net';
import { ASK_COOLDOWN, ASK_TIMEOUT, INTERACT, aiAccepts, meetPoses, type Act, type Ask, type Kind } from './interactions';

interface StepDef { id: PhaseId; ep: number; dur: number; tod: Tod; round?: number }

const FAST = new URLSearchParams(location.search).has('fast') ? 0.35 : 1;
export const STEPS: StepDef[] = [
  { id: 'intro', ep: 1, dur: 26, tod: 'sunset' },
  { id: 'roam', ep: 1, dur: 80, tod: 'sunset', round: 1 },
  { id: 'text', ep: 1, dur: 22, tod: 'sunset' },
  { id: 'textReveal', ep: 1, dur: 13, tod: 'sunset' },
  { id: 'leak', ep: 2, dur: 12, tod: 'dusk' },
  { id: 'respond', ep: 2, dur: 18, tod: 'dusk' },
  { id: 'judge', ep: 2, dur: 15, tod: 'dusk' },
  { id: 'judgeReveal', ep: 2, dur: 12, tod: 'dusk' },
  { id: 'roam', ep: 2, dur: 65, tod: 'storm', round: 2 },
  { id: 'gather', ep: 3, dur: 7, tod: 'night' },
  ...[1, 2, 3].flatMap((round) => [
    { id: 'bottle' as const, ep: 3, dur: 7, tod: 'night' as const, round },
    { id: 'truth' as const, ep: 3, dur: 16, tod: 'night' as const, round },
    { id: 'truthReveal' as const, ep: 3, dur: 9, tod: 'night' as const, round },
  ]),
  { id: 'confess', ep: 4, dur: 25, tod: 'night' },
  { id: 'confessReveal', ep: 4, dur: 0, tod: 'night' },
  { id: 'finale', ep: 4, dur: 3600, tod: 'night' },
];
export const BEAT = 6.5;

type Aff = Record<CharId, Record<CharId, number>>;

export interface DirectorHost {
  chars: Map<CharId, Character>;
  collision: Collision;
  /** Is the director allowed to move characters right now (free-roam phases)? */
  freeRoam(): boolean;
  /** True once this client has every character loaded and is in the show (a freshly migrated host may not be). */
  active(): boolean;
  /** Called on the host when an AI contestant should play a one-shot. */
  botEmote(c: CharId, anim: string): void;
}

interface Bot {
  goal?: { x: number; z: number; follow?: CharId };
  wait: number;
  anim: string;
  sayT: number;
  roseAt: number;
  roseTo?: CharId;
  stuck: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const shuffle = <T>(a: T[]) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export class Director {
  private bots = new Map<CharId, Bot>();
  private publishT = 0;
  private flashDone = new Set<number>();
  /** Hug/kiss requests waiting for a human answer. */
  private pending = new Map<string, { ask: Ask; expires: number }>();
  /** Contestant -> time (ms) until which they are asking, being asked or mid-act. */
  private busy = new Map<CharId, number>();
  private cooldown = new Map<CharId, number>();
  private lastBotAct = 0;
  private actSeq = 0;

  constructor(private readonly host: DirectorHost) {}

  // ---------- cast ----------
  /** Human-controlled characters right now (cast entry points at a connected player). */
  static humanOf(cast: Cast | undefined, c: CharId) {
    const pid = cast?.[c];
    return pid && players.has(pid) ? pid : null;
  }

  startShow() {
    const cast = Object.fromEntries(CHAR_IDS.map((c) => [c, null])) as Cast;
    const loose: string[] = [];
    for (const p of net.ordered()) {
      const want = p.getState('char') as CharId | undefined;
      if (want && !cast[want]) cast[want] = p.id; else loose.push(p.id);
    }
    for (const pid of loose) { const free = CHAR_IDS.find((c) => !cast[c]); if (free) cast[free] = pid; }
    const aff = {} as Aff;
    for (const a of CAST) { aff[a.id] = {} as Record<CharId, number>; for (const b of CHAR_IDS) if (b !== a.id) aff[a.id][b] = (a.crush[b] ?? 0) + Math.random() * 0.8; }
    net.set('cast', cast);
    net.set('score', Object.fromEntries(CHAR_IDS.map((c) => [c, { h: 0, d: 0 }])));
    net.set('aff', aff);
    net.set('rosesSent', {});
    net.set('roses', {});
    this.flashDone.clear();
    this.enter(0, { seq: (net.get<Phase>('phase')?.seq ?? 0) });
    net.set('stage', 'show');
  }

  claim(c: CharId, pid: string) {
    const cast = { ...(net.get<Cast>('cast') ?? ({} as Cast)) };
    if (Director.humanOf(cast, c)) return false;
    for (const k of CHAR_IDS) if (cast[k] === pid) cast[k] = null;
    cast[c] = pid;
    net.set('cast', cast);
    this.bots.delete(c);
    return true;
  }

  release(pid: string) {
    const cast = { ...(net.get<Cast>('cast') ?? ({} as Cast)) };
    let changed = false;
    for (const k of CHAR_IDS) if (cast[k] === pid) { cast[k] = null; changed = true; }
    if (changed) net.set('cast', cast);
  }

  // ---------- phase machine ----------
  tick(dt: number) {
    const ph = net.get<Phase>('phase');
    if (!ph || net.get('stage') !== 'show') return;
    if (Date.now() >= ph.endsAt) this.advance(ph);
    if (ph.id === 'roam') {
      const t = ph.dur - (ph.endsAt - Date.now()) / 1000;
      if (t > ph.dur * 0.38 && !this.flashDone.has(ph.seq)) {
        this.flashDone.add(ph.seq);
        net.rpc.call('event', { k: 'flash', text: pick(DRAMA_FLASH) }, net.rpc.Mode.ALL);
      }
    }
    for (const [id, p] of this.pending) {
      if (Date.now() > p.expires) { this.pending.delete(id); this.resolveAct(p.ask, false, 'timeout'); }
    }
    this.updateBots(dt, ph);
  }

  skip() {
    const ph = net.get<Phase>('phase');
    if (ph) this.advance(ph);
  }

  private advance(ph: Phase) {
    if (ph.step + 1 >= STEPS.length) return;
    const carry = this.resolve(ph);
    this.enter(ph.step + 1, { ...carry, seq: ph.seq });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enter(step: number, carry: any) {
    const def = STEPS[step];
    const data = this.build(def, carry);
    let dur = def.dur;
    if (def.id === 'confessReveal') dur = data.beats.length * BEAT + 4;
    else if (def.id !== 'finale') dur *= FAST;
    const phase: Phase = { seq: carry.seq + 1, step, id: def.id, ep: def.ep, tod: def.tod, dur, endsAt: Date.now() + dur * 1000, data };
    net.set('phase', phase);
    if (def.id === 'roam') this.planRoses(def.round ?? 1);
  }

  private cast() { return net.get<Cast>('cast') ?? ({} as Cast); }
  private aff() { return net.get<Aff>('aff') ?? ({} as Aff); }
  private score() { return net.get<Scores>('score') ?? ({} as Scores); }

  private bump(changes: [CharId, 'h' | 'd', number][]) {
    const s = structuredClone(this.score());
    for (const [c, k, v] of changes) { s[c] ??= { h: 0, d: 0 }; s[c][k] += v; }
    net.set('score', s);
  }
  private like(changes: [CharId, CharId, number][]) {
    const a = structuredClone(this.aff());
    for (const [from, to, v] of changes) if (a[from] && from !== to) a[from][to] = (a[from][to] ?? 0) + v;
    net.set('aff', a);
  }

  /** Each human's pick for this phase (if made), otherwise an AI decision. */
  private picks<T>(ph: Phase, who: CharId[], decide: (c: CharId) => T): Record<CharId, T> {
    const cast = this.cast();
    const out = {} as Record<CharId, T>;
    for (const c of who) {
      const pid = Director.humanOf(cast, c);
      const v = pid ? (players.get(pid)?.getState('pick') as { seq: number; v: T } | undefined) : undefined;
      out[c] = v && v.seq === ph.seq && v.v != null ? v.v : decide(c);
    }
    return out;
  }

  private favourite(c: CharId, noise = 1.2, exclude: CharId[] = []) {
    const a = this.aff()[c] ?? {};
    let best: CharId = CHAR_IDS.find((x) => x !== c)!, bv = -1e9;
    for (const x of CHAR_IDS) {
      if (x === c || exclude.includes(x)) continue;
      const v = (a[x] ?? 0) + Math.random() * noise;
      if (v > bv) { bv = v; best = x; }
    }
    return best;
  }
  private leastFav(c: CharId) {
    const a = this.aff()[c] ?? {};
    let best: CharId = CHAR_IDS.find((x) => x !== c)!, bv = 1e9;
    for (const x of CHAR_IDS) { if (x === c) continue; const v = (a[x] ?? 0) + Math.random(); if (v < bv) { bv = v; best = x; } }
    return best;
  }

  /** Resolve the phase that just ended; returns data carried into the next phase. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolve(ph: Phase): any {
    const d = ph.data ?? {};
    switch (ph.id) {
      case 'text': {
        const p = this.picks<CharId>(ph, CHAR_IDS, (c) => this.favourite(c, 1.5));
        const counts = Object.fromEntries(CHAR_IDS.map((c) => [c, 0])) as Record<CharId, number>;
        for (const c of CHAR_IDS) if (p[c] && p[c] !== c) counts[p[c]]++;
        this.bump(CHAR_IDS.map((c) => [c, 'h', counts[c] * 2] as [CharId, 'h', number]));
        this.like(CHAR_IDS.map((c) => [p[c], c, 1] as [CharId, CharId, number]));
        return { counts };
      }
      case 'respond': {
        const target = d.target as CharId;
        const r = this.picks<{ r: LeakResponse; b?: CharId }>(ph, [target], (c) => {
          const roll = Math.random();
          return roll < 0.38 ? { r: 'admit' } : roll < 0.7 ? { r: 'deny' } : { r: 'blame', b: CHAR[c].blame };
        })[target];
        const blame = r.r === 'blame' ? (r.b && r.b !== target ? r.b : CHAR[target].blame) : undefined;
        const changes: [CharId, 'h' | 'd', number][] = [[target, 'd', r.r === 'deny' ? 4 : 3]];
        if (r.r === 'admit') changes.push([target, 'h', 2]);
        if (blame) { changes.push([blame, 'd', 3]); this.like([[blame, target, -3]]); }
        this.bump(changes);
        return { target, secret: d.secret, resp: r.r, blame };
      }
      case 'judge': {
        const others = CHAR_IDS.filter((c) => c !== d.target);
        const p = this.picks<'support' | 'oppose'>(ph, others, (c) => {
          const a = this.aff()[c]?.[d.target as CharId] ?? 0;
          const bias = d.resp === 'admit' ? 0.25 : d.resp === 'deny' ? -0.15 : -0.3;
          return a + bias + Math.random() * 1.5 > 1.1 ? 'support' : 'oppose';
        });
        const support = others.filter((c) => p[c] === 'support');
        const oppose = others.filter((c) => p[c] !== 'support');
        this.bump([[d.target, 'h', support.length], [d.target, 'd', oppose.length]]);
        this.like([...support.map((c) => [d.target, c, 1] as [CharId, CharId, number]), ...oppose.map((c) => [d.target, c, -1.5] as [CharId, CharId, number])]);
        return { ...d, support, oppose };
      }
      case 'truth': {
        const card = TRUTH_CARDS[d.card];
        const ans = this.picks<CharId>(ph, [d.target], (c) => (card.kind === 'love' ? this.favourite(c, 0.8) : this.leastFav(c)))[d.target as CharId];
        const answer = ans && ans !== d.target ? ans : this.favourite(d.target);
        if (card.kind === 'love') { this.bump([[answer, 'h', 2]]); this.like([[answer, d.target, 1.5], [d.target, answer, 0.5]]); }
        else { this.bump([[answer, 'd', 2], [d.target, 'd', 1]]); this.like([[answer, d.target, -2]]); }
        return { ...d, answer };
      }
      case 'confess': {
        // AI hearts are fickle: enough noise that not every story ends in a couple.
        const p = this.picks<CharId>(ph, CHAR_IDS, (c) => this.favourite(c, 2.8));
        for (const c of CHAR_IDS) if (!p[c] || p[c] === c) p[c] = this.favourite(c);
        return { picks: p };
      }
      case 'bottle':
        return { round: d.round, target: d.target, card: d.card };
      case 'confessReveal':
        return { picks: d.picks, beats: d.beats };
      default:
        return {};
    }
  }

  /** Build the data block for the phase being entered. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private build(def: StepDef, carry: any): any {
    const cast = this.cast();
    const humans = CHAR_IDS.filter((c) => Director.humanOf(cast, c));
    switch (def.id) {
      case 'roam': return { round: def.round };
      case 'textReveal': return { counts: carry.counts };
      case 'leak': {
        const target = pick(humans.length ? humans : CHAR_IDS);
        net.set('leakTarget', target);
        return { target, secret: CHAR[target].secret };
      }
      case 'respond': {
        const target = net.get<CharId>('leakTarget')!;
        return { target, secret: CHAR[target].secret };
      }
      case 'judge': case 'judgeReveal': return carry;
      case 'bottle': {
        const used = net.get<CharId[]>('bottleUsed') ?? [];
        const usedCards = net.get<number[]>('cardsUsed') ?? [];
        const fresh = CHAR_IDS.filter((c) => !used.includes(c));
        const freshHumans = fresh.filter((c) => humans.includes(c));
        const target = pick(freshHumans.length ? freshHumans : fresh.length ? fresh : CHAR_IDS);
        const kind = def.round === 2 ? 'shade' : 'love';
        const cards = TRUTH_CARDS.map((c, i) => ({ c, i })).filter(({ c, i }) => c.kind === kind && !usedCards.includes(i));
        const card = (cards.length ? pick(cards) : { i: 0 }).i;
        net.set('bottleUsed', def.round === 1 ? [target] : [...used, target]);
        net.set('cardsUsed', def.round === 1 ? [card] : [...usedCards, card]);
        return { round: def.round, target, card, spin: 3 + Math.floor(Math.random() * 3) };
      }
      case 'truth': return carry;
      case 'truthReveal': return carry;
      case 'confessReveal': {
        const picks = carry.picks as Record<CharId, CharId>;
        const done = new Set<CharId>();
        const beats: { who: CharId; to: CharId; match: boolean }[] = [];
        const singles: typeof beats = [], matches: typeof beats = [];
        for (const c of shuffle(CHAR_IDS)) {
          if (done.has(c)) continue;
          const to = picks[c];
          const match = picks[to] === c;
          if (match) done.add(to);
          done.add(c);
          (match ? matches : singles).push({ who: c, to, match });
        }
        // Heartbreaks first, matches last: the show saves the sweet part for the end.
        beats.push(...singles, ...matches);
        const changes: [CharId, 'h' | 'd', number][] = [];
        for (const b of beats) {
          if (b.match) changes.push([b.who, 'h', 5], [b.to, 'h', 5]);
          else changes.push([b.who, 'd', 2]);
        }
        this.bump(changes);
        return { picks, beats };
      }
      case 'finale': {
        const beats = (carry.beats ?? []) as { who: CharId; to: CharId; match: boolean }[];
        const couples = beats.filter((b) => b.match).map((b) => [b.who, b.to]);
        const s = this.score();
        const rank = (k: 'h' | 'd') => CHAR_IDS.slice().sort((a, b) => (s[b]?.[k] ?? 0) - (s[a]?.[k] ?? 0));
        const star = rank('h')[0];
        const drama = rank('d').find((c) => c !== star) ?? star;
        return { couples, picks: carry.picks, star, drama };
      }
      default: return {};
    }
  }

  // ---------- AI contestants ----------
  private planRoses(round: number) {
    const ph = net.get<Phase>('phase');
    const dur = ph?.dur ?? 60;
    for (const c of CHAR_IDS) {
      const b = this.bot(c);
      b.roseAt = Date.now() + rnd(0.25, 0.75) * dur * 1000;
      b.roseTo = Math.random() < 0.75 ? this.favourite(c, round === 1 ? 1.5 : 1) : undefined;
    }
  }

  private bot(c: CharId): Bot {
    let b = this.bots.get(c);
    if (!b) { b = { wait: rnd(0.5, 3), anim: 'idle', sayT: rnd(6, 20), roseAt: Infinity, stuck: 0 }; this.bots.set(c, b); }
    return b;
  }

  /** Server-side rose: validates one rose per contestant per roam round, then broadcasts. */
  rose(from: CharId, to: CharId) {
    const ph = net.get<Phase>('phase');
    if (!ph || ph.id !== 'roam' || from === to) return false;
    const sent = { ...(net.get<Record<string, number>>('rosesSent') ?? {}) };
    if (sent[from] === ph.data.round) return false;
    sent[from] = ph.data.round;
    net.set('rosesSent', sent);
    const roses = { ...(net.get<Record<string, number>>('roses') ?? {}) };
    roses[to] = (roses[to] ?? 0) + 1;
    net.set('roses', roses);
    this.bump([[to, 'h', 3]]);
    this.like([[to, from, 2], [from, to, 0.5]]);
    net.rpc.call('event', { k: 'rose', from, to }, net.rpc.Mode.ALL);
    return true;
  }

  private updateBots(dt: number, ph: Phase) {
    const cast = this.cast();
    const chars = this.host.chars;
    // A host that took over while its own client is still loading or not yet in the show: phases keep
    // advancing, bots wait (publishing title-screen poses as 'npc' would teleport them for everyone).
    if (chars.size < CHAR_IDS.length || !this.host.active()) return;
    const free = this.host.freeRoam();
    const npc: Record<string, NetPose> = {};
    for (const c of CHAR_IDS) {
      if (Director.humanOf(cast, c)) { this.bots.delete(c); continue; }
      const ch = chars.get(c);
      if (!ch) continue;
      const b = this.bot(c);
      if (free) this.stepBot(c, ch, b, dt, ph);
      npc[c] = [round2(ch.x), round2(ch.z), round2(ch.ry), b.anim];
    }
    if ((this.publishT -= dt) <= 0) {
      this.publishT = 0.12;
      net.set('npc', npc, false);
    }
  }

  private stepBot(c: CharId, ch: Character, b: Bot, dt: number, ph: Phase) {
    const chars = this.host.chars;
    // Chatter.
    if ((b.sayT -= dt) <= 0) {
      b.sayT = rnd(14, 30);
      net.rpc.call('say', { c, m: pick(CHAR[c].idle) }, net.rpc.Mode.ALL);
    }
    // Rose run: walk to the crush, then hand it over.
    const roundSent = (net.get<Record<string, number>>('rosesSent') ?? {})[c] === ph.data?.round;
    if (ph.id === 'roam' && b.roseTo && !roundSent && Date.now() > b.roseAt) {
      const t = chars.get(b.roseTo)!;
      if (Math.hypot(t.x - ch.x, t.z - ch.z) < 2.0) {
        this.rose(c, b.roseTo);
        b.roseTo = undefined; b.goal = undefined; b.wait = 3; b.anim = 'heart';
        ch.ry = Math.atan2(t.x - ch.x, t.z - ch.z);
        this.host.botEmote(c, 'heart');
        return;
      }
      b.goal = { x: t.x, z: t.z, follow: b.roseTo }; b.wait = 0;
    }
    if (b.wait > 0) {
      b.wait -= dt;
      if (b.goal?.follow) { const t = chars.get(b.goal.follow)!; ch.ry = lerpAng(ch.ry, Math.atan2(t.x - ch.x, t.z - ch.z), 1 - Math.exp(-dt * 6)); ch.tr = ch.ry; }
      if (b.wait <= 0) { b.anim = 'idle'; b.goal = undefined; }
      this.host.botEmote(c, b.anim);
      return;
    }
    if (!b.goal) {
      const roll = Math.random();
      if (roll < 0.45) { const p = pick(POIS); b.goal = { x: p.x + rnd(-1, 1), z: p.z + rnd(-1, 1) }; }
      else if (roll < 0.85) { const o = pick(CHAR_IDS.filter((x) => x !== c)); b.goal = { x: 0, z: 0, follow: o }; }
      else { b.wait = rnd(2, 5); b.anim = 'idle'; return; }
    }
    let gx = b.goal.x, gz = b.goal.z, stop = 0.5;
    if (b.goal.follow) { const t = chars.get(b.goal.follow)!; gx = t.x; gz = t.z; stop = 1.4; }
    const dx = gx - ch.x, dz = gz - ch.z, dist = Math.hypot(dx, dz);
    if (dist < stop) {
      // Arrived next to someone they like: sometimes go for a hug or a kiss (at most one AI move per ~15 s).
      const partner = b.goal.follow;
      if (partner && Date.now() - this.lastBotAct > 15000 && Math.random() < 0.35) {
        const aff = this.aff()[c]?.[partner] ?? 0;
        const kind: Kind = aff > 2.6 && Math.random() < 0.45 ? 'kiss' : 'hug';
        if (aff > 1.4 && this.interact(c, partner, kind)) { this.lastBotAct = Date.now(); ch.ry = Math.atan2(dx, dz); ch.speed = 0; return; }
      }
      // Arrived: linger (facing the partner if there is one); the goal is cleared when the wait ends.
      b.anim = b.goal.follow ? pick(['talk', 'talk', 'wave', 'heart', 'idle']) : pick(['idle', 'idle', 'talk', 'dance']);
      b.wait = b.anim === 'wave' || b.anim === 'heart' ? ch.clipDuration(b.anim) : rnd(3, 8);
      if (b.goal.follow) ch.ry = Math.atan2(dx, dz);
      ch.speed = 0;
      return;
    }
    const sp = 1.35;
    const nx = ch.x + (dx / dist) * sp * dt, nz = ch.z + (dz / dist) * sp * dt;
    const [rx, rz] = this.host.collision.resolve(nx, nz, 0.32);
    const moved = Math.hypot(rx - ch.x, rz - ch.z);
    b.stuck = moved < sp * dt * 0.3 ? b.stuck + dt : 0;
    if (b.stuck > 1.2) { b.goal = undefined; b.stuck = 0; b.wait = 0.5; }
    ch.x = rx; ch.z = rz; ch.tx = rx; ch.tz = rz;
    ch.ry = lerpAng(ch.ry, Math.atan2(dx, dz), 1 - Math.exp(-dt * 8));
    ch.tr = ch.ry;
    ch.speed = sp;
    b.anim = 'walk';
    this.host.botEmote(c, 'walk');
  }

  // ---------- hugs & kisses (host arbitrates, everyone stages the result) ----------
  private freePhase() {
    const id = net.get<Phase>('phase')?.id;
    return id === 'roam' || id === 'text';
  }

  /** Someone asks someone else for a hug or kiss. Humans get asked; the AI decides from its feelings. */
  interact(from: CharId, to: CharId, kind: Kind) {
    const now = Date.now();
    if (!this.freePhase() || from === to || !INTERACT[kind]) return false;
    if ((this.busy.get(from) ?? 0) > now || (this.busy.get(to) ?? 0) > now || (this.cooldown.get(from) ?? 0) > now) return false;
    const a = this.host.chars.get(from), b = this.host.chars.get(to);
    if (!a || !b || Math.hypot(a.x - b.x, a.z - b.z) > INTERACT[kind].range + 1.2) return false; // slack for latency
    const ask: Ask = { id: `${now.toString(36)}${(this.actSeq++).toString(36)}`, from, to, kind };
    this.cooldown.set(from, now + ASK_COOLDOWN * 1000);
    const hold = now + (ASK_TIMEOUT + 1) * 1000;
    this.busy.set(from, hold); this.busy.set(to, hold);
    const cast = this.cast();
    for (const c of [from, to]) if (!Director.humanOf(cast, c)) this.react(c, 'idle', ASK_TIMEOUT); // AI stands still meanwhile
    if (Director.humanOf(cast, to)) {
      this.pending.set(ask.id, { ask, expires: now + ASK_TIMEOUT * 1000 });
      net.rpc.call('ask', ask, net.rpc.Mode.ALL);
    } else {
      const ok = aiAccepts(kind, this.aff()[to]?.[from] ?? 0);
      setTimeout(() => this.resolveAct(ask, ok, ok ? undefined : 'no'), 900 + Math.random() * 900);
    }
    return true;
  }

  /** A human target's answer; only the player who controls the target may answer. */
  answer(id: string, ok: boolean, senderId: string) {
    const p = this.pending.get(id);
    if (!p || this.cast()[p.ask.to] !== senderId) return;
    this.pending.delete(id);
    this.resolveAct(p.ask, ok, ok ? undefined : 'no');
  }

  private resolveAct(ask: Ask, ok: boolean, reason?: 'no' | 'timeout') {
    const a = this.host.chars.get(ask.from), b = this.host.chars.get(ask.to);
    if (ok && (!a || !b || !this.freePhase())) { ok = false; reason = 'timeout'; } // the night moved on meanwhile
    const act: Act = { ...ask, ok, reason };
    const now = Date.now();
    if (ok) {
      act.poses = meetPoses(a!, b!, INTERACT[ask.kind].gap);
      const until = now + INTERACT[ask.kind].dur * 1000;
      this.busy.set(ask.from, until); this.busy.set(ask.to, until);
      const h = ask.kind === 'kiss' ? 3 : 2;
      this.bump([[ask.from, 'h', h], [ask.to, 'h', h]]);
      this.like([[ask.from, ask.to, h * 0.6], [ask.to, ask.from, h * 0.6]]);
    } else {
      this.busy.delete(ask.from); this.busy.delete(ask.to);
      this.bump([[ask.from, 'd', 2]]);
      this.like([[ask.from, ask.to, -0.5]]);
    }
    net.rpc.call('act', act, net.rpc.Mode.ALL);
  }

  /** Host-side: make an AI contestant stop and play a reaction. */
  react(c: CharId, anim: string, secs: number) {
    const b = this.bot(c);
    b.goal = undefined; b.anim = anim; b.wait = secs;
    this.host.botEmote(c, anim);
  }

  /** After a forced layout, AI resumes from wherever the stage left them. */
  resetBots() {
    for (const b of this.bots.values()) { b.goal = undefined; b.wait = rnd(0.5, 2.5); b.anim = 'idle'; }
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
function lerpAng(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

import * as THREE from 'three/webgpu';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { PlayerState } from 'playroomkit';
import { Assets, PRIO } from '../core/assets';
import { CAST_MODELS, CORE_PATHS, PROPS_EARLY, PROPS_LATE, SHOW_PATHS } from '../core/bootPlan';
import { createRenderer, createPost, detectQuality, precompile, type Post } from '../core/renderer';
import { portrait } from '../world/screen';
import { Audio } from '../audio/audio';
import {
  CAST, CHAR, CHAR_IDS, ENDINGS, HOST, HOST_LINES, HUAZI, LEAK_RESPONSES, TRUTH_CARDS, type CharId, type LeakResponse,
} from '../data/story';
import {
  World, BONFIRE, HOST_SPOT, SCREEN, faceTo, finalePose, lineupPose, seatPose, stagePose, type Pose,
} from '../world/world';
import { UI, PHASE_LABEL } from '../ui/ui';
import { CameraRig } from './cameraRig';
import { Character, lerpAngle } from './character';
import { Director, BEAT } from './director';
import { ACT_HUAZI, ACT_TEXT, ASK_TIMEOUT, INTERACT, clipsFor, meetPoses, type Act, type Ask, type Kind } from './interactions';
import { ProximityVoice, type Signal } from './voice';
import { net, players, inviteLink, loadNet, type Cast, type NetPose, type Phase, type Scores } from './net';

type Layout = 'free' | 'lineup' | 'stage' | 'seated' | 'finale';
const LAYOUT: Record<string, Layout> = {
  intro: 'lineup', roam: 'free', text: 'free', textReveal: 'stage', leak: 'stage', respond: 'stage', judge: 'stage',
  judgeReveal: 'stage', gather: 'seated', bottle: 'seated', truth: 'seated', truthReveal: 'seated', confess: 'seated',
  confessReveal: 'seated', finale: 'finale',
};
const EMOTE_KEYS = ['wave', 'heart', 'talk', 'angry', 'shock', 'dance'];
const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export class Game {
  private readonly quality = detectQuality();
  private renderer!: THREE.WebGPURenderer;
  private post!: Post;
  private readonly assets = new Assets();
  private world!: World;
  private readonly rig = new CameraRig();
  private readonly css = new CSS2DRenderer();
  private readonly ui = new UI();
  private readonly audio = new Audio();
  private director!: Director;
  readonly chars = new Map<CharId, Character>();
  private host!: Character;
  private readonly timer = new THREE.Timer();

  private connected = false;
  private stage: 'title' | 'casting' | 'show' = 'title';
  private cast: Cast = {} as Cast;
  private castSig = '';
  private myChar?: CharId;
  private phase?: Phase;
  private phaseT = 0;
  private layout: Layout = 'lineup';
  private fired = new Set<string>();
  private overrides = new Map<string, { anim: string; until: number; then?: string }>();
  private keys = new Set<string>();
  private joy = { x: 0, y: 0 };
  private emote = { anim: '', until: 0 };
  private sendT = 0;
  private pollT = 0;
  private castingSig = '';
  private flights: { obj: THREE.Object3D; from: THREE.Vector3; to: CharId; t: number }[] = [];
  private roseModel?: THREE.Object3D;
  private picked = false;
  private grade = { sat: 1.12, tint: new THREE.Color(1.04, 0.98, 0.95) };
  /** core: the 3D title backdrop is drawable. show: every character + prop is in the scene (gates 开播 and entering the show). */
  private readonly ready = { core: false, show: false };
  private coreReady!: Promise<void>;
  /** Boot hit a fatal error (no GPU, core assets unreachable): stop every timer that would hide the message. */
  private failed = false;
  /** A character keeps failing to download; shown in the load bar while it retries. */
  private retrying = 0;
  /** Characters staged in a hug/kiss: pose + clip until a time; overrides input, network and AI. */
  private readonly locks = new Map<CharId, { until: number; pose: Pose; anim: string; partner: CharId }>();
  /** A hug/kiss request waiting for my answer. */
  private asked?: Ask;
  /** Nearest other contestant (free roam), for roses and interactions. */
  private near?: { c: CharId; d: number };
  private voice?: ProximityVoice;
  private voiceSyncT = 0;

  // ------------------------------------------------------------------ boot
  async boot() {
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    const t0 = performance.now();
    // 1) t=0: queue every download (Assets runs 6 at a time in PRIO order) before touching the GPU.
    //    World's constructor builds everything that needs no file, including the complete collision map.
    this.world = new World(this.assets, this.quality === 'high' ? 2048 : 1024);
    for (const id of CAST_MODELS) portrait(id);                 // 115 KB of portraits for casting / screen / HUD
    const core = this.world.buildCore();                         // HDR + 7 ground textures + villa
    let gpu!: () => void;
    const gpuReady = new Promise<void>((r) => { gpu = r; });
    this.coreReady = Promise.all([core, gpuReady]).then(() => undefined);
    const cast = this.loadCast();
    const placed = (group: THREE.Object3D) => this.coreReady.then(() => this.compile(group)).then(() => popIn(group));
    const props = Promise.all([
      this.world.streamProps(PROPS_EARLY, PRIO.early, placed),
      this.world.streamProps(PROPS_LATE, PRIO.props, placed),
    ]);
    this.assets.model('rose', PRIO.extra).then((g) => { this.roseModel = g.scene; }, () => { /* optional: flyRose falls back */ });

    // 2) Nothing below needs the GPU or a model, so the title button works as soon as this script has run.
    this.director = new Director({
      chars: this.chars,
      collision: this.world.collision,
      freeRoam: () => this.stage === 'show' && this.layout === 'free',
      active: () => this.ready.show && this.stage === 'show',
      botEmote: (c, anim) => this.chars.get(c)?.play(anim),
    });
    this.world.onThunder = () => this.audio.thunder();
    this.world.effects.onBoom = () => this.audio.boom();
    this.bindInput(canvas);
    this.bindUi();
    this.timer.connect(document);
    this.css.setSize(innerWidth, innerHeight);
    document.getElementById('labels')!.append(this.css.domElement);
    window.addEventListener('resize', () => this.resize());
    // The multiplayer chunk is fetched once the backdrop is up, or as soon as the player reaches for the button.
    const warmNet = () => void loadNet().catch(() => { /* join() retries and reports */ });
    const showTitle = () => {
      if (this.ui.titleShown || this.failed) return;
      this.ui.backdropMode();                                    // loading gradient stays as the backdrop, bar moves to #loadbar
      this.ui.title(/[#&]r=/.test(location.hash), () => void this.join());
      const go = document.querySelector('#title .go');
      go?.addEventListener('pointerenter', warmNet, { once: true });
      go?.addEventListener('touchstart', warmNet, { once: true, passive: true });
    };
    const titleTimer = setTimeout(showTitle, 1500);              // fast links: title appears together with the 3D scene
    const ticker = setInterval(() => this.reportProgress(), 250);

    try {
      // 3) GPU (runs while the downloads are in flight).
      this.renderer = await createRenderer(canvas, this.quality);
      this.post = await createPost(this.renderer, this.world.scene, this.rig.camera, this.quality);
      this.resize();
      this.renderer.setAnimationLoop((t) => this.frame(t));      // netUpdate runs from now on; drawing waits for ready.core
      gpu();

      // 4) Core backdrop: precompile everything already in the scene, then one warm-up frame behind the opaque
      //    overlay (shadow-map, PMREM, bloom/SMAA/output pipelines), then fade the overlay out.
      await this.coreReady;
      const tc = performance.now();
      console.info(`[boot] gpu+core files ${Math.round(tc - t0)} ms`);
      await this.compile(this.world.scene);
      const tw = performance.now();
      this.idleCamera(0);
      this.rig.update(1);
      this.post.render();
      console.info(`[boot] precompile ${Math.round(tw - tc)} ms, warm-up frame ${Math.round(performance.now() - tw)} ms`);
    } catch (e) {
      // Fatal: without a GPU or the core scene the show cannot run. Keep the error visible (main.ts shows it).
      this.failed = true;
      clearTimeout(titleTimer);
      clearInterval(ticker);
      this.ui.failBoot();
      throw e;
    }
    this.ready.core = true;
    showTitle();
    this.ui.hideLoading();
    warmNet();
    console.info(`[boot] backdrop ${Math.round(performance.now() - t0)} ms`);

    // 5) The rest streams in; characters and props pop into the scene as they arrive.
    await Promise.all([cast, props]);
    this.ready.show = true;
    this.castingSig = '';
    clearInterval(ticker);
    this.reportProgress();
    console.info(`[boot] show-ready ${Math.round(performance.now() - t0)} ms`);
    if (import.meta.env.PROD) {
      // Copy everything this visit fetched into the service-worker cache (served from the HTTP cache, not the network).
      navigator.serviceWorker?.ready.then((reg) => reg.active?.postMessage({ type: 'warm', urls: performance.getEntriesByType('resource').map((e) => e.name) }));
    }
  }

  /** precompile() against the post-processing scene pass, so the first frame showing `root` does not stall. */
  private compile(root: THREE.Object3D) {
    return precompile(this.renderer, this.post, root, this.rig.camera, this.world.scene);
  }

  private reportProgress() {
    if (this.failed) return;
    const core = this.assets.progress(CORE_PATHS), all = this.assets.progress(SHOW_PATHS);
    const label = !this.ready.core ? `正在布置海岛 ${Math.round(core * 100)}%`
      : !this.ready.show ? (this.retrying ? '网络不稳，正在重试下载嘉宾……' : `嘉宾正在化妆 ${this.chars.size + (this.host ? 1 : 0)}/7 · ${Math.round(all * 100)}%`) : '';
    if (!this.ready.core) this.ui.progress(core, '正在布置海岛……');
    this.ui.loadbar(this.ready.show ? null : all, label);
    this.ui.loadGate(this.ready.show ? null : all);
    if (this.connected) {
      const pct = this.ready.show ? 100 : Math.floor(all * 10) * 10;  // 10% steps: few Playroom writes
      if (net.me().getState('load') !== pct) net.me().setState('load', pct, false);
    }
  }

  /** Host + six contestants. Each one appears (with a heart burst) on its title-screen spot as soon as it is ready. */
  private loadCast() {
    return Promise.all(CAST_MODELS.map(async (id) => {
      // After the title is up a cast download failure is not fatal: keep retrying with backoff (the Assets cache
      // forgets failures), and the show stays gated until everyone has arrived.
      let gltf;
      for (let attempt = 0; ; attempt++) {
        try { gltf = await this.assets.model(id, PRIO.cast); break; } catch (e) {
          console.warn('[boot] cast model failed, retrying', id, e);
          this.retrying++;
          await new Promise((r) => setTimeout(r, Math.min(20000, 3000 * 2 ** attempt)));
          this.retrying--;
        }
      }
      const def = id === HOST.id ? null : CHAR[id as CharId];
      const ch = new Character(id, gltf, def ? def.name : `主持人 ${HOST.name}`, def ? def.color : '#ffd36e');
      if (def) {
        const i = CHAR_IDS.indexOf(id as CharId), a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * 8.6, z = -3 + Math.sin(a) * 4.8;
        ch.place({ x, z, ry: faceTo(x, z, 0, -3) });
        ch.play(i % 3 === 0 ? 'dance' : i % 3 === 1 ? 'talk' : 'idle', 0);
      } else ch.place({ x: HOST_SPOT.x, z: HOST_SPOT.z, ry: faceTo(HOST_SPOT.x, HOST_SPOT.z, 0, -6) });
      await this.coreReady;
      await this.compile(ch.root);
      this.world.scene.add(ch.root);
      if (def) this.chars.set(id as CharId, ch); else this.host = ch;
      this.world.effects.heartBurst(ch.x, 1.4, ch.z, 10);
      this.castSig = '';                                         // re-apply name tags / ownership for the newcomer
    }));
  }

  private resize() {
    if (!innerWidth || !innerHeight || !this.renderer) return; // hidden / zero-size viewport, or GPU not up yet
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.rig.resize();
    this.css.setSize(innerWidth, innerHeight);
  }

  // ------------------------------------------------------------------ network
  private async join() {
    this.audio.unlock();
    this.audio.setMood('day');
    this.ui.toast('正在连接别墅……');
    try {
      await net.connect((p) => this.onJoin(p), (p) => this.onQuit(p));
    } catch (e) {
      console.error(e);
      this.ui.toast(`连接失败：${(e as Error).message ?? e}`);
      this.ui.title(false, () => void this.join());
      return;
    }
    this.connected = true;
    const me = net.me();
    if (!me.getState('name')) me.setState('name', this.defaultName(me), true);
    net.rpc.register('say', async (d: { c: CharId; m: string }) => { this.onSay(d.c, d.m); return 'ok'; });
    net.rpc.register('event', async (d) => { this.onEvent(d); return 'ok'; });
    net.rpc.register('rose', async (d: { from: CharId; to: CharId }) => { if (net.isHost()) this.director.rose(d.from, d.to); return 'ok'; });
    net.rpc.register('claim', async (d: { c: CharId }, sender: PlayerState) => { if (net.isHost()) this.director.claim(d.c, sender.id); return 'ok'; });
    net.rpc.register('interact', async (d: { from: CharId; to: CharId; kind: Kind }, sender: PlayerState) => {
      if (net.isHost() && this.cast[d.from] === sender.id) this.director.interact(d.from, d.to, d.kind);
      return 'ok';
    });
    net.rpc.register('ask', async (a: Ask) => { this.onAsk(a); return 'ok'; });
    net.rpc.register('answer', async (d: { id: string; ok: boolean }, sender: PlayerState) => {
      if (net.isHost()) this.director.answer(d.id, d.ok, sender.id);
      return 'ok';
    });
    net.rpc.register('act', async (a: Act) => { this.onAct(a); return 'ok'; });
    // Proximity voice: WebRTC signalling rides on Playroom RPC; every client ignores messages not addressed to it.
    this.voice = new ProximityVoice(me.id, (to, sig) => net.rpc.call('rtc', { to, from: me.id, s: sig }, net.rpc.Mode.OTHERS));
    this.voice.onMic = (on) => { me.setState('mic', on, true); this.ui.micState(on); };
    net.rpc.register('rtc', async (d: { to: string; from: string; s: Signal }) => {
      if (d.to === me.id) void this.voice?.onSignal(d.from, d.s);
      return 'ok';
    });
    this.ui.bindHud(net.isHost());
    this.stage = 'casting';
    this.renderCasting(true);
  }

  private defaultName(p: PlayerState) {
    const n = p.getProfile()?.name;
    return n && !/^player/i.test(n) ? n.slice(0, 12) : `嘉宾${Math.floor(1000 + Math.random() * 9000)}`;
  }

  private onJoin(p: PlayerState) {
    if (this.stage !== 'title') this.ui.feed(`<b>${this.nick(p)}</b> 入住了别墅`);
    this.castingSig = '';
  }

  private onQuit(p: PlayerState) {
    this.ui.feed(`<b>${this.nick(p)}</b> 离开了别墅，AI 接管了 TA 的嘉宾`);
    if (net.isHost()) this.director.release(p.id);
    this.castingSig = '';
  }

  private nick(p?: PlayerState) { return (p?.getState('name') as string) ?? p?.getProfile()?.name ?? '神秘嘉宾'; }

  private renderCasting(force = false) {
    const me = net.me();
    const midShow = net.get('stage') === 'show';
    const taken: Partial<Record<CharId, string>> = {};
    let mine: CharId | undefined;
    if (midShow) {
      for (const c of CHAR_IDS) { const pid = Director.humanOf(this.cast, c); if (pid) taken[c] = this.nick(players.get(pid)); }
    } else {
      for (const p of net.ordered()) {
        const c = p.getState('char') as CharId | undefined;
        if (!c) continue;
        if (p.id === me.id) mine = c;
        else if (!taken[c]) taken[c] = this.nick(p);
      }
      if (mine && taken[mine]) mine = undefined;
    }
    const loadTag = (p: PlayerState) => { const l = p.getState('load') as number | undefined; return l != null && l < 100 ? ` · 加载中 ${l}%` : ''; };
    const names = net.ordered().map((p) => this.nick(p) + (p.id === me.id ? '（你）' : '') + loadTag(p));
    const ready = this.ready.show;
    const sig = JSON.stringify([taken, mine, names, midShow, net.isHost(), this.nick(me), ready]);
    if (!force && sig === this.castingSig) return;
    this.castingSig = sig;
    this.ui.casting({
      name: this.nick(me), invite: inviteLink(), isHost: net.isHost(), midShow, taken, mine, players: names, ready,
      onPick: (c) => {
        this.audio.pop();
        if (midShow && !this.ready.show) { this.ui.toast('别墅还在加载，加载完成后就能接管这位嘉宾'); return; }
        if (midShow) {
          if (net.isHost()) this.director.claim(c, me.id);
          else net.rpc.call('claim', { c }, net.rpc.Mode.HOST);
        } else me.setState('char', c, true);
        this.castingSig = '';
      },
      onName: (n) => { me.setState('name', n, true); this.castingSig = ''; },
      onStart: () => { if (!this.ready.show) return; this.audio.pop(); this.director.startShow(); },
    });
  }

  // ------------------------------------------------------------------ frame
  private frame(time: number) {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.connected) this.netUpdate(dt);
    if (this.voice) this.voiceUpdate(dt);
    if (!this.ready.core) return;                 // nothing worth drawing yet; the overlay still covers the canvas
    if (this.stage === 'show') this.showUpdate(dt);
    else this.idleCamera(dt);

    for (const ch of this.chars.values()) ch.update(dt);
    this.host?.update(dt);
    this.updateFlights(dt);
    this.world.update(dt, this.rig.camera);
    this.rig.update(dt);
    this.renderer.toneMappingExposure = this.world.exposure;
    const g = this.post.grade;
    g.saturation.value += (this.grade.sat - g.saturation.value) * Math.min(1, dt * 3);
    (g.tint.value as THREE.Color).lerp(this.grade.tint, Math.min(1, dt * 3));
    g.flash.value = this.world.flash;
    if (!innerWidth || !innerHeight) return;
    this.post.render();
    this.css.render(this.world.scene, this.rig.camera);
  }

  /** Dev-only: pin the title camera, e.g. game.debugShot = [[x,y,z],[lx,ly,lz]]. */
  debugShot?: [number[], number[], number?];

  private idleCamera(dt: number) {
    if (this.debugShot) {
      const [p, l, fov] = this.debugShot;
      this.rig.shot(v3(p[0], p[1], p[2]), v3(l[0], l[1], l[2]), fov ?? 40, 20);
      return;
    }
    const t = performance.now() / 1000;
    const a = t * 0.05 + 1.2;
    this.rig.shot(v3(Math.cos(a) * 24, 6.5, -3 + Math.sin(a) * 24), v3(0, 1.2, -3), 45, 1.5);
    for (const ch of this.chars.values()) ch.follow(dt);
  }

  /** Poll Playroom state: stage, cast, phase. */
  private netUpdate(dt: number) {
    const stage = net.get<string>('stage') ?? 'casting';
    if ((this.pollT -= dt) <= 0) {
      this.pollT = 0.3;
      const cast = net.get<Cast>('cast');
      const sig = JSON.stringify(cast ?? {}) + [...players.keys()].join();
      if (sig !== this.castSig) { this.castSig = sig; this.onCast(cast ?? ({} as Cast)); }
      if (this.stage === 'casting') this.renderCasting();
      this.ui.setSkip(net.isHost());
    }
    const inCast = !!this.myChar;
    if (stage === 'show' && this.stage !== 'show' && inCast) { if (this.ready.show) this.enterShow(); }
    else if (stage === 'show' && this.stage === 'casting' && !inCast) this.renderCasting();
    else if (stage === 'casting' && this.stage === 'show') this.leaveShow();
    if (net.isHost() && stage === 'show') this.director.tick(dt);
  }

  private onCast(cast: Cast) {
    this.cast = cast;
    const me = net.me().id;
    const prev = this.myChar;
    this.myChar = CHAR_IDS.find((c) => cast[c] === me);
    for (const c of CHAR_IDS) {
      const ch = this.chars.get(c);
      if (!ch) continue;                          // not loaded yet: loadCast() resets castSig when it arrives
      const pid = Director.humanOf(cast, c);
      ch.labelEl.classList.toggle('me', c === this.myChar);
      ch.setTag(pid ? (pid === me ? '你' : this.nick(players.get(pid))) : 'AI 嘉宾');
    }
    if (prev !== this.myChar && this.myChar && this.stage === 'show') this.ui.toast(`你现在是 ${CHAR[this.myChar].name}！`);
  }

  private enterShow() {
    this.stage = 'show';
    this.ui.hideCasting();
    this.ui.hideFinale();
    this.ui.showHud(true);
    this.phase = undefined;
    const me = this.myChar ? this.chars.get(this.myChar)! : undefined;
    if (me) this.rig.behind(me.ry);
  }

  private leaveShow() {
    this.stage = 'casting';
    this.ui.showHud(false);
    this.ui.hideFinale();
    this.ui.closeChoice();
    this.ui.hideReveal();
    this.ui.letterbox(false);
    this.world.bottle.visible = false;
    this.world.setTod('sunset');
    this.audio.setMood('day');
    this.grade.sat = 1.12; this.grade.tint.set(1.04, 0.98, 0.95);
    this.castingSig = '';
    this.renderCasting(true);
  }

  // ------------------------------------------------------------------ show
  private showUpdate(dt: number) {
    const ph = net.get<Phase>('phase');
    if (ph && ph.seq !== this.phase?.seq) this.enterPhase(ph);
    if (!this.phase) return;
    this.phaseT += dt;
    this.ui.timer(this.phase.id === 'finale' ? null : (this.phase.endsAt - Date.now()) / 1000);
    const s = net.get<Scores>('score');
    const r = net.get<Record<string, number>>('roses') ?? {};
    for (const c of CHAR_IDS) {
      const ch = this.chars.get(c)!;
      if ((r[c] ?? 0) !== ch.roses) { ch.roses = r[c] ?? 0; ch.setTag(this.tagNick(c)); }
    }
    this.ui.me(this.myChar, s?.[this.myChar!]?.h ?? 0, s?.[this.myChar!]?.d ?? 0);

    if (this.layout === 'free') this.freeUpdate(dt);
    else this.forcedUpdate(dt);
    this.script(this.phase, this.phaseT);
    this.hostAnim();
  }

  private tagNick(c: CharId) {
    const pid = Director.humanOf(this.cast, c);
    return pid ? (pid === net.me().id ? '你' : this.nick(players.get(pid))) : 'AI 嘉宾';
  }

  private async enterPhase(ph: Phase) {
    const prev = this.phase;
    this.phase = ph;
    this.phaseT = Math.max(0, ph.dur - (ph.endsAt - Date.now()) / 1000);
    if (Math.abs(this.phaseT) > ph.dur) this.phaseT = 0;
    if (this.phaseT < 1.5) this.phaseT = 0;
    this.fired.clear();
    this.overrides.clear();
    this.locks.clear();
    if (this.asked) { this.asked = undefined; this.ui.askCard(null); }
    this.picked = false;
    this.ui.closeChoice();
    this.ui.waitNote(null);
    this.ui.hideReveal();
    this.ui.nameCard(null);
    this.ui.phase(ph.ep, PHASE_LABEL[ph.id] ?? '');
    this.world.setTod(ph.tod);
    if (!prev || prev.ep !== ph.ep) { this.ui.epCard(ph.ep); this.audio.whoosh(); }
    this.audio.setMood(ph.id === 'finale' || ph.id === 'confessReveal' ? 'sweet' : ph.tod === 'night' ? 'night' : ph.tod === 'storm' || ph.ep === 2 ? 'tense' : 'day');
    if (ph.id !== 'leak') { this.grade.sat = 1.12; this.grade.tint.set(1.04, 0.98, 0.95); }
    this.world.bottle.visible = ph.id === 'bottle' || ph.id === 'truth' || ph.id === 'truthReveal';
    if (ph.id === 'bottle') this.world.bottle.rotation.y = 0;
    const layout = LAYOUT[ph.id] ?? 'free';
    const letter = layout !== 'free';
    this.ui.letterbox(letter && ph.id !== 'finale');
    this.ui.emotes(layout === 'free');
    this.ui.roseButton(ph.id === 'roam' && this.myChar ? 'idle' : 'hidden');
    if (layout !== this.layout || layout !== 'free') {
      const wasFree = this.layout === 'free';
      if (layout !== this.layout && (wasFree || layout === 'free' || layout !== this.layout)) await this.ui.fade(380);
      this.layout = layout;
      this.applyLayout(ph);
      if (layout === 'free') {
        if (net.isHost()) this.director.resetBots();
        const me = this.myChar && this.chars.get(this.myChar);
        if (me) { this.rig.behind(me.ry); }
      }
      this.rig.cut();
    }
    this.onPhaseEnter(ph);
  }

  private order(): CharId[] {
    const ph = this.phase;
    if (ph?.id === 'finale') {
      const couples = (ph.data.couples ?? []) as [CharId, CharId][];
      const seen = new Set(couples.flat());
      return [...couples.flat(), ...CHAR_IDS.filter((c) => !seen.has(c))];
    }
    return CHAR_IDS;
  }

  private applyLayout(ph: Phase) {
    const ids = this.order();
    ids.forEach((c, i) => {
      const ch = this.chars.get(c)!;
      if (this.layout === 'lineup') ch.place(lineupPose(i, ids.length));
      else if (this.layout === 'stage') ch.place(stagePose(i, ids.length));
      else if (this.layout === 'seated') ch.seat(seatPose(CHAR_IDS.indexOf(c)));
      else if (this.layout === 'finale') ch.place(finalePose(i));
      ch.forced = this.layout !== 'free';
      ch.play(this.baseAnim(), 0.2);
    });
    this.placeHost(this.layout === 'seated' || this.layout === 'finale');
    void ph;
  }

  private baseAnim() { return this.layout === 'seated' ? 'sit' : 'idle'; }

  private placeHost(bonfire: boolean) {
    if (bonfire) {
      const a = (Math.PI * 4) / 3, x = BONFIRE.x + Math.cos(a) * 6.3, z = BONFIRE.z + Math.sin(a) * 6.3;
      this.host.place({ x, z, ry: faceTo(x, z, BONFIRE.x, BONFIRE.z) });
    } else this.host.place({ x: HOST_SPOT.x, z: HOST_SPOT.z, ry: faceTo(HOST_SPOT.x, HOST_SPOT.z, 0, -6) });
  }

  private hostTalkUntil = 0;
  private hostAnim() {
    const talking = performance.now() < this.hostTalkUntil;
    const o = this.overrides.get('host');
    if (o && performance.now() < o.until) this.host.play(o.anim);
    else this.host.play(talking ? 'talk' : 'idle');
  }
  private hostSay(text: string, hold = 4) {
    this.ui.subtitle(`主持人 ${HOST.name}`, text, '#ffd36e', hold);
    this.hostTalkUntil = performance.now() + (text.length * 45 + 1500);
  }

  /** Make a character play a one-shot (or timed loop) during scripted beats, then return to base. */
  private react(c: string, anim: string, secs?: number) {
    const ch = c === 'host' ? this.host : this.chars.get(c as CharId);
    if (!ch) return;
    const dur = secs ?? ch.clipDuration(anim) * 0.95;
    this.overrides.set(c, { anim, until: performance.now() + dur * 1000 });
  }

  private forcedUpdate(_dt: number) {
    const now = performance.now();
    for (const c of CHAR_IDS) {
      const ch = this.chars.get(c)!;
      const o = this.overrides.get(c);
      ch.play(o && now < o.until ? o.anim : this.baseAnim(), 0.35);
    }
  }

  // ---------------------------------------------------------------- free roam
  private freeUpdate(dt: number) {
    const host = net.isHost();
    const npc = host ? undefined : net.get<Record<string, NetPose>>('npc');
    const now = performance.now();
    for (const c of CHAR_IDS) {
      const ch = this.chars.get(c)!;
      ch.forced = false;
      const lock = this.locks.get(c);
      if (lock) {
        if (now < lock.until) { ch.place(lock.pose); ch.play(lock.anim, 0.25); continue; }
        this.locks.delete(c);
      }
      if (c === this.myChar) { this.moveMe(ch, dt); continue; }
      const pid = Director.humanOf(this.cast, c);
      if (pid) {
        const p = players.get(pid)?.getState('p') as NetPose | undefined;
        if (p) { ch.tx = p[0]; ch.tz = p[1]; ch.tr = p[2]; ch.remoteAnim = p[3]; }
        ch.follow(dt);
        ch.play(ch.remoteAnim);
        if (ch.anim === 'walk') ch.setWalkSpeed(Math.max(1.2, ch.speed));
      } else if (!host) {
        const p = npc?.[c];
        if (p) { ch.tx = p[0]; ch.tz = p[1]; ch.tr = p[2]; ch.remoteAnim = p[3]; }
        ch.follow(dt);
        ch.play(ch.remoteAnim);
      }
    }
    const me = this.myChar && this.chars.get(this.myChar);
    const myLock = this.myChar ? this.locks.get(this.myChar) : undefined;
    if (me && myLock) this.shotCouple(me, this.chars.get(myLock.partner)!);
    else if (me) this.rig.follow(me.headPos(new THREE.Vector3()));
    else this.idleCamera(dt);
    this.updateNear();
    this.updateRoseTarget();
  }

  /** Side two-shot of a hug/kiss, on whichever side the camera already is. */
  private shotCouple(a: Character, b: Character) {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let nx = -(b.z - a.z), nz = b.x - a.x;
    const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    const cam = this.rig.camera.position;
    if ((cam.x - mx) * nx + (cam.z - mz) * nz < 0) { nx = -nx; nz = -nz; }
    const h = Math.min(a.height, b.height);
    this.rig.shot(v3(mx + nx * 2.5, h + 0.05, mz + nz * 2.5), v3(mx, h - 0.15, mz), 40, 3);
  }

  private updateNear() {
    if (!this.myChar) { this.near = undefined; return; }
    const me = this.chars.get(this.myChar)!;
    let best: { c: CharId; d: number } | undefined;
    for (const c of CHAR_IDS) {
      if (c === this.myChar) continue;
      const o = this.chars.get(c)!;
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      if (d < 2.8 && (!best || d < best.d)) best = { c, d };
    }
    this.near = best;
    const ph = this.phase?.id;
    const can = (ph === 'roam' || ph === 'text') && !this.locks.has(this.myChar) && !!best && best.d <= INTERACT.hug.range;
    this.ui.actButtons(ph === 'roam' || ph === 'text' ? (can ? CHAR[best!.c].name : '') : null);
  }

  // ---------------------------------------------------------------- hugs & kisses
  private requestAct(kind: Kind) {
    const ph = this.phase?.id;
    if (this.layout !== 'free' || !this.myChar || !(ph === 'roam' || ph === 'text') || this.locks.has(this.myChar)) return;
    const t = this.near;
    if (!t || t.d > INTERACT[kind].range) { this.ui.toast(`走近一点才能${INTERACT[kind].label}`); return; }
    const payload = { from: this.myChar, to: t.c, kind };
    if (net.isHost()) {
      if (!this.director.interact(payload.from, payload.to, kind)) { this.ui.toast('现在不行，等一下再试'); return; }
    } else net.rpc.call('interact', payload, net.rpc.Mode.HOST);
    this.ui.toast(`${INTERACT[kind].emoji} 你想${INTERACT[kind].label}${CHAR[t.c].name}……`);
  }

  private onAsk(a: Ask) {
    if (a.to !== this.myChar || this.stage !== 'show') return;
    this.asked = a;
    this.audio.heartbeat(1);
    this.ui.askCard(`${INTERACT[a.kind].emoji} ${CHAR[a.from].name} 想${INTERACT[a.kind].label}你`, ASK_TIMEOUT, (ok) => this.answerAsk(ok));
  }

  private answerAsk(ok: boolean) {
    const a = this.asked;
    if (!a) return;
    this.asked = undefined;
    this.ui.askCard(null);
    this.audio.pop();
    if (net.isHost()) this.director.answer(a.id, ok, net.me().id);
    else net.rpc.call('answer', { id: a.id, ok }, net.rpc.Mode.HOST);
  }

  /** Host-approved (or refused) interaction: everyone stages the same poses and clips locally. */
  private onAct(a: Act) {
    if (this.asked?.id === a.id) { this.asked = undefined; this.ui.askCard(null); } // decided without me (timeout)
    if (this.stage !== 'show' || this.layout !== 'free') return;
    const A = this.chars.get(a.from), B = this.chars.get(a.to);
    if (!A || !B) return;
    const host = net.isHost();
    const mine = a.from === this.myChar || a.to === this.myChar;
    if (a.ok && a.poses) {
      const dur = INTERACT[a.kind].dur;
      const [clipA, clipB] = clipsFor(a.kind, A, B);
      const until = performance.now() + dur * 1000;
      this.locks.set(a.from, { until, pose: a.poses[0], anim: clipA, partner: a.to });
      this.locks.set(a.to, { until, pose: a.poses[1], anim: clipB, partner: a.from });
      A.place(a.poses[0]); B.place(a.poses[1]);
      if (host) {
        if (!Director.humanOf(this.cast, a.from)) this.director.react(a.from, clipA, dur);
        if (!Director.humanOf(this.cast, a.to)) this.director.react(a.to, clipB, dur);
      }
      this.ui.feed(ACT_TEXT[a.kind](CHAR[a.from].name, CHAR[a.to].name));
      this.ui.huazi(rnd(ACT_HUAZI[a.kind]));
      this.audio.chime();
      const mx = (a.poses[0].x + a.poses[1].x) / 2, mz = (a.poses[0].z + a.poses[1].z) / 2, y = Math.min(A.height, B.height) + 0.15;
      setTimeout(() => this.world.effects.heartBurst(mx, y, mz, a.kind === 'kiss' ? 22 : 14), a.kind === 'kiss' ? 1300 : 900);
      if (mine) { this.emote.until = 0; this.rig.cut(); }
    } else {
      this.ui.feed(ACT_TEXT[a.reason === 'timeout' ? 'timeout' : 'no'](CHAR[a.from].name, CHAR[a.to].name, a.kind));
      this.ui.huazi(rnd(ACT_HUAZI.no));
      this.audio.sad();
      if (a.from === this.myChar) {
        this.ui.toast(`💔 ${CHAR[a.to].name}${a.reason === 'timeout' ? '没有回应' : '拒绝了你'}`);
        this.emote = { anim: 'heartbreak', until: performance.now() + A.clipDuration('heartbreak') * 950 };
      }
      if (host) {
        if (!Director.humanOf(this.cast, a.from)) this.director.react(a.from, 'heartbreak', A.clipDuration('heartbreak'));
        if (!Director.humanOf(this.cast, a.to)) this.director.react(a.to, rnd(['angry', 'shock']), 2.5);
      }
    }
  }

  // ---------------------------------------------------------------- proximity voice
  private voiceUpdate(dt: number) {
    const v = this.voice!;
    if ((this.voiceSyncT -= dt) <= 0) { this.voiceSyncT = 1; v.sync([...players.keys()]); }
    const inShow = this.stage === 'show';
    const me = inShow && this.myChar ? this.chars.get(this.myChar) : undefined;
    const b = this.rig.basis();
    v.update(me ? { x: me.x, y: me.height - 0.1, z: me.z } : null, { x: b.fx, z: b.fz }, (pid) => {
      if (!inShow) return null;
      const c = CHAR_IDS.find((k) => this.cast[k] === pid);
      const ch = c && this.chars.get(c);
      return ch ? { x: ch.x, y: ch.height - 0.1, z: ch.z } : null;
    });
    for (const c of CHAR_IDS) {
      const ch = this.chars.get(c);
      if (!ch) continue;
      const pid = Director.humanOf(this.cast, c);
      ch.labelEl.classList.toggle('mic', !!pid && players.get(pid)?.getState('mic') === true);
      ch.labelEl.classList.toggle('talking', !!pid && v.level(pid) > 0.08);
    }
  }

  private async toggleMic() {
    if (!this.voice) { this.ui.toast('进入别墅后才能开麦'); return; }
    try {
      const on = await this.voice.setMic(!this.voice.micOn);
      this.ui.toast(on ? '🎙️ 麦克风已打开：离得越近，听得越清楚' : '🔇 麦克风已关闭');
    } catch (e) {
      console.warn('[voice] mic', e);
      this.ui.toast('无法使用麦克风：请在浏览器地址栏允许麦克风权限');
    }
  }

  private moveMe(ch: Character, dt: number) {
    const typing = document.activeElement instanceof HTMLInputElement;
    const k = this.keys;
    let mx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.joy.x;
    let my = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - this.joy.y;
    if (typing) mx = my = 0;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const now = performance.now();
    if (len > 0.08) {
      const b = this.rig.basis();
      const dx = b.fx * my + b.rx * mx, dz = b.fz * my + b.rz * mx;
      const run = k.has('ShiftLeft') || k.has('ShiftRight') || Math.hypot(this.joy.x, this.joy.y) > 0.9;
      const sp = (run ? 2.9 : 1.75) * Math.min(1, len);
      const [nx, nz] = this.world.collision.resolve(ch.x + dx * sp * dt, ch.z + dz * sp * dt, 0.32);
      ch.x = nx; ch.z = nz;
      ch.ry = lerpAngle(ch.ry, Math.atan2(dx, dz), 1 - Math.exp(-dt * 12));
      ch.play('walk', 0.2);
      ch.setWalkSpeed(sp);
      this.emote.until = 0;
    } else if (now < this.emote.until) {
      ch.play(this.emote.anim, 0.25);
    } else {
      ch.play('idle', 0.3);
    }
    if ((this.sendT -= dt) <= 0) {
      this.sendT = 0.1;
      net.me().setState('p', [Math.round(ch.x * 100) / 100, Math.round(ch.z * 100) / 100, Math.round(ch.ry * 100) / 100, ch.anim], false);
    }
  }

  private doEmote(anim: string) {
    if (this.layout !== 'free' || !this.myChar) return;
    const ch = this.chars.get(this.myChar)!;
    this.emote = { anim, until: performance.now() + (anim === 'dance' || anim === 'talk' ? 5000 : ch.clipDuration(anim) * 950) };
  }

  private roseTarget?: CharId;
  private updateRoseTarget() {
    const ph = this.phase;
    if (!ph || ph.id !== 'roam' || !this.myChar) { this.roseTarget = undefined; return; }
    const sent = (net.get<Record<string, number>>('rosesSent') ?? {})[this.myChar] === ph.data.round;
    if (sent) { this.ui.roseButton('idle'); this.roseTarget = undefined; this.setRoseLabel('🌹 今晚的玫瑰已送出'); return; }
    const best = this.near?.c;
    if (best !== this.roseTarget) {
      this.roseTarget = best;
      this.ui.roseButton(best ? 'ready' : 'idle', best ? CHAR[best].name : '');
    }
  }
  private setRoseLabel(text: string) {
    const b = document.querySelector('#hud .rose') as HTMLButtonElement;
    if (b && b.textContent !== text) { b.textContent = text; b.disabled = true; }
  }

  private giveRose() {
    if (!this.roseTarget || !this.myChar) return;
    const payload = { from: this.myChar, to: this.roseTarget };
    if (net.isHost()) this.director.rose(payload.from, payload.to);
    else net.rpc.call('rose', payload, net.rpc.Mode.HOST);
    this.emote = { anim: 'heart', until: performance.now() + 2500 };
  }

  // ---------------------------------------------------------------- events
  private onSay(c: CharId, m: string) {
    const ch = this.chars.get(c);
    if (!ch) return;
    ch.say(m);
    this.ui.feed(`<b style="--c:${CHAR[c].color}">${CHAR[c].name}</b>：${escape(m)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onEvent(d: any) {
    if (this.stage !== 'show') return;            // e.g. a mid-show guest still loading in the casting room
    if (d.k === 'rose') {
      const from = this.chars.get(d.from as CharId)!, to = this.chars.get(d.to as CharId)!;
      this.ui.feed(`🌹 <b style="--c:${CHAR[d.from as CharId].color}">${from.displayName}</b> 把玫瑰送给了 <b style="--c:${CHAR[d.to as CharId].color}">${to.displayName}</b>`);
      this.ui.huazi(rnd(HUAZI.rose));
      this.audio.chime();
      this.flyRose(from, d.to);
      if (d.to === this.myChar) { this.ui.toast(`💌 ${from.displayName} 把玫瑰送给了你！`); this.emote = { anim: 'heart', until: performance.now() + 2600 }; }
      if (net.isHost() && !Director.humanOf(this.cast, d.to)) this.director.react(d.to, 'heart', to.clipDuration('heart'));
    } else if (d.k === 'flash') {
      this.ui.toast(d.text);
      this.ui.feed(d.text);
      this.audio.sting();
      this.ui.huazi(rnd(HUAZI.leak));
    }
  }

  private flyRose(from: Character, to: CharId) {
    if (!this.roseModel) { this.world.effects.heartBurst(this.chars.get(to)!.x, 2, this.chars.get(to)!.z); return; }
    const obj = this.roseModel.clone();
    const box = new THREE.Box3().setFromObject(this.roseModel);
    const s = 0.45 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
    obj.scale.setScalar(s);
    this.world.scene.add(obj);
    this.flights.push({ obj, from: v3(from.x, from.height * 0.7, from.z), to, t: 0 });
  }

  private updateFlights(dt: number) {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += dt;
      const tc = this.chars.get(f.to)!;
      const end = v3(tc.x, tc.height + 0.75, tc.z);
      const k = Math.min(1, f.t / 1.1);
      f.obj.position.lerpVectors(f.from, end, k);
      f.obj.position.y += Math.sin(k * Math.PI) * 1.4;
      f.obj.rotation.y += dt * 6;
      if (k >= 1 && !f.obj.userData.burst) { f.obj.userData.burst = true; this.world.effects.heartBurst(end.x, end.y, end.z); }
      if (f.t > 4) { this.world.scene.remove(f.obj); this.flights.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- script
  private at(t: number, key: string, fn: () => void) {
    if (this.phaseT >= t && !this.fired.has(key)) { this.fired.add(key); fn(); }
  }

  private submit(v: unknown) {
    if (!this.phase) return;
    net.me().setState('pick', { seq: this.phase.seq, v }, true);
    this.picked = true;
    this.audio.pop();
  }

  private charChoices(exclude: CharId[] = []) {
    return CAST.filter((c) => !exclude.includes(c.id)).map((c) => ({ value: c.id, label: c.name, sub: c.title, char: c.id }));
  }

  private remaining() { return this.phase ? Math.max(1, (this.phase.endsAt - Date.now()) / 1000 - 0.6) : 10; }

  private onPhaseEnter(ph: Phase) {
    const d = ph.data ?? {};
    const name = (c: CharId) => CHAR[c].name;
    const mine = this.myChar;
    switch (ph.id) {
      case 'intro':
        this.world.screen.show({ kind: 'title', title: '欢迎来到心跳别墅', sub: 'SEASON 7 · 四夜限定' });
        break;
      case 'roam':
        this.world.screen.show({ kind: 'title', title: d.round === 1 ? '自由交流' : '暴雨夜', sub: '靠近心动的人，当众送出玫瑰' });
        if (d.round === 1) this.hostSay(HOST_LINES.roam1);
        else { this.hostSay(HOST_LINES.storm); this.ui.huazi(rnd(HUAZI.storm)); this.world.strike(); }
        break;
      case 'text':
        this.world.screen.show({ kind: 'title', title: '心动短信', sub: '匿名 · 只能发一条' });
        this.hostSay(HOST_LINES.text);
        if (mine) this.ui.choose('💌 心动短信', '匿名发给你最心动的人（TA 不会知道是你）', this.charChoices([mine]), this.remaining(), (v) => this.submit(v));
        break;
      case 'textReveal': {
        const counts = d.counts as Record<CharId, number>;
        this.world.screen.show({ kind: 'counts', title: '今晚的心动短信', rows: CAST.map((c) => ({ who: c.id, name: c.name, n: counts[c.id] ?? 0, color: c.color })) });
        this.hostSay(HOST_LINES.textReveal);
        this.audio.heartbeat(3);
        if (mine) this.ui.toast(counts[mine] ? `你收到了 ${counts[mine]} 条心动短信 💗` : '你一条短信都没有收到……');
        break;
      }
      case 'leak':
        this.world.screen.show({ kind: 'title', title: '⚠ 信号中断 ⚠', sub: '收到一条匿名爆料' });
        this.hostSay(HOST_LINES.leak);
        break;
      case 'respond':
        this.world.screen.show({ kind: 'leak', who: d.target, name: name(d.target), secret: d.secret });
        this.hostSay(HOST_LINES.respond.replace('{x}', name(d.target)));
        if (mine === d.target) {
          this.ui.choose<LeakResponse>('🎤 你要怎么回应？', `大屏幕说：${d.secret}`, (Object.keys(LEAK_RESPONSES) as LeakResponse[]).map((k) => ({ value: k, label: LEAK_RESPONSES[k].label })), this.remaining(), (r) => {
            if (r === 'blame') {
              this.ui.choose('🎯 甩锅给谁？', '被你点名的人会成为众矢之的', this.charChoices([mine!]), this.remaining(), (b) => this.submit({ r, b }));
            } else this.submit({ r });
          });
        } else this.ui.waitNote(`等待 ${name(d.target)} 回应……`);
        break;
      case 'judge':
        this.world.screen.show({ kind: 'spotlight', who: d.target, name: name(d.target), title: '你相信 TA 吗？', body: d.secret, color: CHAR[d.target as CharId].color });
        if (mine && mine !== d.target) {
          setTimeout(() => {
            if (this.phase?.seq !== ph.seq) return;
            this.ui.choose<'support' | 'oppose'>(`⚖️ 你站 ${name(d.target)} 吗？`, `TA 的回应：${LEAK_RESPONSES[d.resp as LeakResponse].label}`, [
              { value: 'support', label: '💗 站 TA', sub: '我相信你' },
              { value: 'oppose', label: '💔 不站', sub: '我不信' },
            ], this.remaining(), (v) => this.submit(v));
          }, 3500);
        } else if (mine === d.target) this.ui.waitNote('其他嘉宾正在决定是否站你……');
        break;
      case 'judgeReveal':
        this.world.screen.show({ kind: 'spotlight', who: d.target, name: name(d.target), title: `站TA ${d.support.length} 人 · 不站 ${d.oppose.length} 人`, body: d.support.length >= d.oppose.length ? '多数人选择了相信。' : '信任，崩塌了。', color: CHAR[d.target as CharId].color });
        break;
      case 'gather':
        this.world.screen.show({ kind: 'title', title: '篝火真心话', sub: '请到海边篝火旁坐下' });
        this.hostSay(HOST_LINES.gather);
        break;
      case 'bottle':
        if (d.round === 1) this.hostSay(HOST_LINES.bottle);
        this.audio.drumroll(5.2);
        break;
      case 'truth': {
        const card = TRUTH_CARDS[d.card];
        this.ui.reveal(`<div class="card2"><h3>真心话 · ${name(d.target)}</h3>${card.q}</div>`);
        if (mine === d.target) {
          this.ui.choose(`🍾 ${card.q}`, '必须当众点名一个人', this.charChoices([mine!]), this.remaining(), (v) => this.submit(v));
        } else this.ui.waitNote(`等待 ${name(d.target)} 回答……`);
        break;
      }
      case 'confess':
        this.hostSay(HOST_LINES.confess, 6);
        this.audio.heartbeat(2);
        if (mine) this.ui.choose('💘 最后的告白', '选择你要告白的人。互相选择 = 牵手成功', this.charChoices([mine]), this.remaining(), (v) => this.submit(v));
        break;
      case 'confessReveal':
        this.hostSay(HOST_LINES.confessReveal, 2);
        break;
      case 'finale': {
        this.hostSay(HOST_LINES.finale, 8);
        this.audio.match();
        break;
      }
    }
  }

  /** Per-frame beats for the current phase: camera shots, reactions, reveals. */
  private script(ph: Phase, t: number) {
    const d = ph.data ?? {};
    const ch = (c: CharId) => this.chars.get(c)!;
    switch (ph.id) {
      case 'intro': {
        HOST_LINES.intro.forEach((line, i) => this.at(i * 4.2 + 0.5, `l${i}`, () => this.hostSay(line, 2.4)));
        if (t < 8) {
          const a = 0.9 + t * 0.09;
          this.rig.shot(v3(Math.cos(a) * 30, 13 - t * 0.6, -2 + Math.sin(a) * 30), v3(0, 1, -4), 42, 1.8);
        } else if (t < 16.5) {
          this.shotClose(this.host, 2.6, 0.5, 34);
          this.at(8, 'hostwave', () => this.react('host', 'wave'));
        } else {
          const i = Math.min(5, Math.floor((t - 16.5) / 1.55));
          const c = CHAR_IDS[i];
          this.shotClose(ch(c), 2.4, i % 2 ? 0.45 : -0.45, 32);
          this.at(16.5 + i * 1.55, `nc${i}`, () => { this.ui.nameCard(c); this.react(c, 'wave'); this.audio.pop(); });
          this.at(25.6, 'ncoff', () => this.ui.nameCard(null));
        }
        break;
      }
      case 'textReveal': {
        if (t < 3.2) this.shotScreen(t); else this.shotStageFaces(t);
        const counts = d.counts as Record<CharId, number>;
        const max = Math.max(...Object.values(counts));
        this.at(2, 'react', () => {
          for (const c of CHAR_IDS) {
            if (counts[c] === max && max > 0) this.react(c, 'heart');
            else if (!counts[c]) this.react(c, 'heartbreak');
          }
          this.ui.huazi(max >= 3 ? '万人迷诞生!!' : '心动了心动了');
        });
        break;
      }
      case 'leak': {
        const target = d.target as CharId;
        if (t < 3.6) this.shotScreen(t);
        else if (t < 8) this.shotClose(ch(target), 1.9, 0.25, 30, 4);
        else this.shotStageFaces(t);
        this.at(3.4, 'reveal', () => {
          this.world.screen.show({ kind: 'leak', who: target, name: CHAR[target].name, secret: d.secret });
          this.audio.sting();
          this.grade.sat = 0.35; this.grade.tint.setRGB(1.25, 0.85, 0.85);
          this.ui.subtitle('大屏幕', `【爆料】${CHAR[target].name}：${d.secret}`, '#ff4d5e', 5);
          this.ui.huazi(rnd(HUAZI.leak));
          this.rig.cut();
        });
        this.at(4.2, 'shock', () => {
          for (const c of CHAR_IDS) this.react(c, c === target ? 'heartbreak' : 'shock');
          this.react('host', 'shock');
        });
        this.at(7, 'hz2', () => this.ui.huazi(rnd(HUAZI.leak)));
        break;
      }
      case 'respond':
        this.shotClose(ch(d.target), 2.4, -0.4, 34);
        this.at(0.2, 'talk', () => this.react(d.target, 'talk', 30));
        break;
      case 'judge': {
        const target = d.target as CharId;
        const resp = d.resp as LeakResponse;
        if (t < 3.5) this.shotClose(ch(target), 2.3, 0.35, 32);
        else if (resp === 'blame' && d.blame && t < 6) this.shotClose(ch(d.blame), 2.3, -0.3, 32);
        else this.shotStageFaces(t);
        this.at(0.3, 'say', () => {
          const line = LEAK_RESPONSES[resp].say.replace('{x}', d.blame ? CHAR[d.blame as CharId].name : '');
          ch(target).say(line);
          this.ui.subtitle(CHAR[target].name, line, CHAR[target].color, 3);
          this.react(target, resp === 'admit' ? 'heartbreak' : resp === 'deny' ? 'angry' : 'talk');
          this.ui.huazi(rnd(HUAZI[resp]));
          if (resp !== 'admit') this.audio.sting();
        });
        if (resp === 'blame' && d.blame) this.at(3.6, 'blamed', () => { this.react(d.blame, 'angry'); ch(d.blame).say('关我什么事？！'); this.ui.huazi('战火蔓延'); });
        break;
      }
      case 'judgeReveal': {
        this.shotStageFaces(t);
        const support = d.support as CharId[], oppose = d.oppose as CharId[];
        this.at(0.5, 'r', () => {
          for (const c of support) this.react(c, 'wave');
          for (const c of oppose) this.react(c, 'angry');
          const ok = support.length >= oppose.length;
          this.react(d.target, ok ? 'heart' : 'heartbreak');
          this.ui.reveal(`<div class="card2"><h3>${ok ? '信任保住了' : '信任崩塌'}</h3>站TA：${support.map((c) => CHAR[c].name).join('、') || '无人'}<br>不站：${oppose.map((c) => CHAR[c].name).join('、') || '无人'}</div>`, ok ? '' : 'miss');
          this.ui.huazi(ok ? '有被感动到' : '众叛亲离');
          if (ok) this.audio.chime(); else this.audio.sad();
        });
        break;
      }
      case 'roam':
        if (d.round === 2) this.at(2.5, 'thunder', () => this.world.strike());
        break;
      case 'gather': {
        const k = Math.min(1, t / 6);
        this.rig.shot(v3(BONFIRE.x + 2, 14 - k * 9, BONFIRE.z + 18 - k * 9), v3(BONFIRE.x, 0.8, BONFIRE.z), 40, 2);
        break;
      }
      case 'bottle': {
        const target = d.target as CharId;
        const seat = seatPose(CHAR_IDS.indexOf(target));
        const final = Math.atan2(Math.cos(seat.a), Math.sin(seat.a));
        const total = (d.spin as number) * Math.PI * 2 + final;
        const k = Math.min(1, t / 5.4);
        this.world.bottle.rotation.y = total * (1 - (1 - k) ** 3);
        this.world.bottle.position.y = 2.6 + Math.sin(t * 2) * 0.08;
        if (t < 5.6) this.rig.shot(v3(BONFIRE.x + 0.01, 9.5, BONFIRE.z + 7.5), v3(BONFIRE.x, 1.5, BONFIRE.z), 46, 2);
        else this.shotClose(ch(target), 2.2, 0.3, 32, 4);
        this.at(5.5, 'stop', () => { this.react(target, 'shock'); this.ui.huazi(rnd(HUAZI.bottle)); this.audio.sting(); this.rig.cut(); });
        break;
      }
      case 'truth':
        this.shotClose(ch(d.target), 2.3, -0.35, 34);
        break;
      case 'truthReveal': {
        const card = TRUTH_CARDS[d.card];
        const target = d.target as CharId, answer = d.answer as CharId;
        if (t < 2.4) this.shotClose(ch(target), 2.2, 0.3, 32);
        else this.shotClose(ch(answer), 2.3, -0.3, 32, 3.5);
        this.at(0.2, 'say', () => {
          this.react(target, 'talk', 2.4);
          this.ui.subtitle(CHAR[target].name, `${card.q}……我选——`, CHAR[target].color, 2);
          this.ui.reveal(this.ui.pairHtml(target, null, card.kind === 'love' ? '💗' : '⚡', card.q));
          this.audio.drumroll(2);
        });
        this.at(2.4, 'ans', () => {
          ch(target).say(`${CHAR[answer].name}。`);
          this.ui.reveal(this.ui.pairHtml(target, answer, card.kind === 'love' ? '💗' : '⚡', card.q), card.kind === 'love' ? '' : 'miss');
          this.react(answer, card.kind === 'love' ? 'heart' : 'angry');
          for (const c of CHAR_IDS) if (c !== answer && c !== target) this.react(c, 'shock');
          this.ui.huazi(rnd(card.kind === 'love' ? HUAZI.love : HUAZI.shade));
          if (card.kind === 'love') { this.world.effects.heartBurst(ch(answer).x, 2.0, ch(answer).z); this.audio.chime(); } else this.audio.sting();
          this.rig.cut();
        });
        break;
      }
      case 'confess': {
        const a = t * 0.12;
        this.rig.shot(v3(BONFIRE.x + Math.cos(a) * 8.5, 3.4, BONFIRE.z + Math.sin(a) * 8.5), v3(BONFIRE.x, 1.0, BONFIRE.z), 44, 1.5);
        this.at(10, 'hb', () => this.audio.heartbeat(2));
        break;
      }
      case 'confessReveal': this.confessScript(d, t); break;
      case 'finale': {
        const a = t * 0.05 + 1;
        this.rig.shot(v3(BONFIRE.x + Math.cos(a) * 13, 4.6, BONFIRE.z + Math.sin(a) * 13), v3(BONFIRE.x, 1.6, BONFIRE.z), 46, 1.2);
        const couples = (d.couples ?? []) as [CharId, CharId][];
        this.at(0.3, 'kiss', () => {
          for (const [x, y] of couples) {
            const A = ch(x), B = ch(y);
            const [pa, pb] = meetPoses(A, B, INTERACT.kiss.gap);
            A.place(pa); B.place(pb);
            this.react(x, 'kiss', INTERACT.kiss.dur); this.react(y, 'kiss', INTERACT.kiss.dur);
            setTimeout(() => this.world.effects.heartBurst((pa.x + pb.x) / 2, 1.9, (pa.z + pb.z) / 2, 22), 1300);
          }
          if (couples.length) this.ui.huazi(rnd(ACT_HUAZI.kiss));
          this.react('host', 'cheer');
        });
        this.at(0.3 + INTERACT.kiss.dur, 'dance', () => {
          for (const [x, y] of couples) { this.react(x, 'dance', 3600); this.react(y, 'dance', 3600); }
        });
        if (Math.floor(t / 1.3) !== Math.floor((t - 1 / 60) / 1.3)) this.world.effects.firework(BONFIRE.x + (Math.random() - 0.5) * 30, BONFIRE.z + 10 + Math.random() * 14);
        this.at(3, 'panel', () => this.showFinale(d));
        break;
      }
    }
  }

  private confessScript(d: { beats: { who: CharId; to: CharId; match: boolean }[]; picks: Record<CharId, CharId> }, t: number) {
    const beats = d.beats;
    const i = Math.min(beats.length - 1, Math.floor(Math.max(0, t - 2) / BEAT));
    const b = beats[i];
    if (!b) return;
    const bt = t - 2 - i * BEAT;
    const ch = (c: CharId) => this.chars.get(c)!;
    if (t < 2) this.rig.shot(v3(BONFIRE.x, 6, BONFIRE.z + 9), v3(BONFIRE.x, 1, BONFIRE.z), 44, 2);
    else if (bt < 2.4) this.shotClose(ch(b.who), 2.2, 0.3, 30, 3);
    else if (b.match) {
      // The couple stands together in front of the confessor's bench; three-quarter shot from the fire side.
      const a = ch(b.who), c = ch(b.to);
      const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
      const L = Math.hypot(BONFIRE.x - mx, BONFIRE.z - mz) || 1;
      const ix = (BONFIRE.x - mx) / L, iz = (BONFIRE.z - mz) / L;
      this.rig.shot(v3(mx - iz * 2.3 + ix * 1.5, 1.85, mz + ix * 2.3 + iz * 1.5), v3(mx, 1.2, mz), 44, 2.5);
    } else this.shotClose(ch(b.to), 2.4, -0.3, 32, 3);
    if (t < 2) return;
    this.at(2 + i * BEAT, `q${i}`, () => {
      this.ui.subtitle(`主持人 ${HOST.name}`, `${CHAR[b.who].name} 的告白对象是……`, '#ffd36e', 2);
      this.ui.reveal(this.ui.pairHtml(b.who, null, '💗', '……'));
      this.audio.drumroll(2.2);
      this.react(b.who, 'talk', 2.3);
      this.rig.cut();
    });
    this.at(2 + i * BEAT + 2.4, `a${i}`, () => {
      this.rig.cut();
      if (b.match) {
        const a = ch(b.who), c = ch(b.to);
        const dx = BONFIRE.x - a.x, dz = BONFIRE.z - a.z, L = Math.hypot(dx, dz) || 1;
        const px = -dz / L, pz = dx / L;
        const ax = a.x + (dx / L) * 0.25, az = a.z + (dz / L) * 0.25;
        // Face to face along the bench, so the fire-side camera sees the hug in profile.
        const [pa, pc] = meetPoses({ x: ax - px, z: az - pz }, { x: ax + px, z: az + pz }, INTERACT.hug.gap);
        a.place(pa); c.place(pc);
        const [ca, cc] = clipsFor('hug', a, c);
        this.ui.reveal(this.ui.pairHtml(b.who, b.to, '💞', '双向奔赴！'));
        this.ui.huazi(rnd(HUAZI.match)); this.ui.huazi(rnd(HUAZI.match));
        this.audio.match();
        this.react(b.who, ca, INTERACT.hug.dur); this.react(b.to, cc, INTERACT.hug.dur);
        const seq = this.phase?.seq;
        setTimeout(() => { if (this.phase?.seq === seq) { this.react(b.who, 'dance', 999); this.react(b.to, 'dance', 999); } }, INTERACT.hug.dur * 1000);
        for (let k = 0; k < 4; k++) setTimeout(() => this.world.effects.firework(BONFIRE.x + (Math.random() - 0.5) * 16, BONFIRE.z + 10 + Math.random() * 6), k * 350);
        this.world.effects.heartBurst(ch(b.who).x, 2, ch(b.who).z, 20);
        this.world.effects.heartBurst(ch(b.to).x, 2, ch(b.to).z, 20);
      } else {
        this.ui.reveal(this.ui.pairHtml(b.who, b.to, '💔', `单向心动……${CHAR[b.to].name} 选了 ${CHAR[d.picks[b.to]].name}`), 'miss');
        this.ui.huazi(rnd(HUAZI.miss));
        this.audio.sad();
        this.react(b.who, 'heartbreak');
        this.world.effects.heartbreak(ch(b.who).x, 2, ch(b.who).z);
      }
    });
    this.at(2 + i * BEAT + BEAT - 0.3, `h${i}`, () => this.ui.hideReveal());
  }

  private showFinale(d: { couples: [CharId, CharId][]; picks: Record<CharId, CharId>; star: CharId; drama: CharId }) {
    const s = net.get<Scores>('score') ?? ({} as Scores);
    const me = this.myChar;
    let ending = '感谢收看《心跳别墅》。下一季，你也许就是主角。';
    if (me) {
      const couple = d.couples.find((c) => c.includes(me));
      const mePick = d.picks?.[me];
      const admirer = CHAR_IDS.find((c) => c !== me && d.picks?.[c] === me);
      if (couple) ending = ENDINGS.match(CHAR[me].name, CHAR[couple[0] === me ? couple[1] : couple[0]].name);
      else if (admirer) ending = ENDINGS.chosenBy(CHAR[me].name, CHAR[admirer].name);
      else if (mePick) ending = ENDINGS.oneSided(CHAR[me].name, CHAR[mePick].name);
      else ending = ENDINGS.alone(CHAR[me].name);
    }
    this.ui.finale({
      couples: d.couples, star: d.star, drama: d.drama, scores: s, ending, mine: me, isHost: net.isHost(),
      onAgain: () => { net.set('stage', 'casting'); },
    });
  }

  // ---------------------------------------------------------------- shots
  /** Medium close-up from in front of a character (side offsets the angle). */
  private shotClose(c: Character, dist: number, side: number, fov: number, stiffness = 2.6) {
    const fx = Math.sin(c.ry + side), fz = Math.cos(c.ry + side);
    const h = c.anim === 'sit' ? c.height * 0.72 : c.height - 0.08;
    const head = v3(c.x, h, c.z);
    this.rig.shot(v3(c.x + fx * dist, h + 0.12, c.z + fz * dist), head, fov, stiffness);
  }

  /** The big screen's point of view: high above it, looking down at the cast's faces. */
  private shotStageFaces(t: number) {
    const sway = Math.sin(t * 0.25) * 1.6;
    this.rig.shot(v3(SCREEN.x + sway, 4.7, SCREEN.z + 0.9), v3(0, 1.0, -10.4), 57, 1.4);
  }

  /** Behind the cast, looking at the big screen. */
  private shotScreen(t: number) {
    this.rig.shot(v3(Math.sin(t * 0.3) * 0.8, 3.0, -4.6), v3(SCREEN.x, 3.3, SCREEN.z), 46 - Math.min(t, 3) * 2, 1.6);
  }

  // ---------------------------------------------------------------- input
  private bindInput(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (document.activeElement instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      const n = Number(e.key);
      if (n >= 1 && n <= 6) this.doEmote(EMOTE_KEYS[n - 1]);
      if (e.code === 'KeyR') this.giveRose();
      if (e.code === 'KeyH') this.requestAct('hug');
      if (e.code === 'KeyK') this.requestAct('kiss');
      if (e.code === 'KeyM') void this.toggleMic();
      if (e.code === 'KeyY' && this.asked) this.answerAsk(true);
      if (e.code === 'KeyN' && this.asked) this.answerAsk(false);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    let drag = -1, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => { drag = e.pointerId; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== drag) return;
      this.rig.yaw -= (e.clientX - lx) * 0.006;
      this.rig.pitch = THREE.MathUtils.clamp(this.rig.pitch + (e.clientY - ly) * 0.004, -0.05, 1.1);
      lx = e.clientX; ly = e.clientY;
    });
    const up = (e: PointerEvent) => { if (e.pointerId === drag) drag = -1; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { this.rig.dist = THREE.MathUtils.clamp(this.rig.dist + e.deltaY * 0.004, 2.6, 11); }, { passive: true });
    this.ui.joystick((x, y) => { this.joy.x = x; this.joy.y = y; });
  }

  private bindUi() {
    this.ui.onEmote = (a) => this.doEmote(a);
    this.ui.onRose = () => this.giveRose();
    this.ui.onInvite = () => this.ui.copy(inviteLink());
    this.ui.onMute = () => this.audio.toggleMute();
    this.ui.onSkip = () => { if (net.isHost()) this.director.skip(); };
    this.ui.onAct = (k) => this.requestAct(k);
    this.ui.onMic = () => void this.toggleMic();
    this.ui.onChat = (text) => {
      if (!this.myChar) return;
      net.rpc.call('say', { c: this.myChar, m: text }, net.rpc.Mode.ALL);
      if (this.layout === 'free') this.emote = { anim: 'talk', until: performance.now() + 2500 };
    };
  }
}

/** Props arrive while the title camera orbits: grow them in instead of popping (scale only, no pipeline change). */
function popIn(group: THREE.Object3D) {
  const t0 = performance.now();
  const kids = group.children.map((c) => [c, c.scale.clone()] as const);
  for (const [c] of kids) c.scale.setScalar(1e-3);
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 450), e = 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2; // ease-out-back
    for (const [c, s] of kids) c.scale.copy(s).multiplyScalar(Math.max(1e-3, e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export type { Pose };

// DOM overlay: loading, title, casting room, HUD, choice cards, variety-show captions, finale.
import { CAST, CHAR, EPISODES, type CharId } from '../data/story';
import { url } from '../core/assets';
import { escapeHtml } from '../game/character';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const el = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const portrait = (id: string) => url(`portraits/${id}.webp`);

export const PHASE_LABEL: Record<string, string> = {
  intro: '开场', roam: '自由交流', text: '心动短信', textReveal: '短信揭晓', leak: '匿名爆料', respond: '当事人回应',
  judge: '全员站队', judgeReveal: '站队结果', gather: '篝火集合', bottle: '命运之瓶', truth: '真心话',
  truthReveal: '真心话揭晓', confess: '秘密告白', confessReveal: '告白揭晓', finale: '大结局',
};

export interface Choice<T> { value: T; label: string; sub?: string; char?: CharId; disabled?: boolean }

export class UI {
  readonly root = $('#ui');
  private choiceTimer = 0;
  onChat?: (text: string) => void;
  onEmote?: (anim: string) => void;
  onRose?: () => void;
  onInvite?: () => void;
  onMute?: () => boolean;
  onSkip?: () => void;
  onAct?: (kind: 'hug' | 'kiss') => void;
  onMic?: () => void;

  // ---------- loading & title ----------
  progress(p: number, label = '') {
    $('#loading .bar i').style.width = `${Math.round(p * 100)}%`;
    if (label) $('#loading .hint').textContent = label;
  }
  hideLoading() { $('#loading').classList.add('gone'); }
  /** Fatal boot error: take down everything layered over the error message. */
  failBoot() {
    $('#title').hidden = true;
    $('#casting').hidden = true;
    $('#hud').hidden = true;
    $('#loadbar').hidden = true;
    $('#loading').classList.remove('backdrop', 'gone');
  }
  /** The loading gradient becomes the title backdrop until the 3D scene is ready; progress moves to #loadbar. */
  backdropMode() { $('#loading').classList.add('backdrop'); }
  /** Non-blocking progress line shown over title / casting / HUD until the show assets are in. */
  loadbar(p: number | null, label = '') {
    const b = $('#loadbar');
    b.hidden = p == null;
    if (p == null) return;
    $('i', b).style.width = `${Math.round(p * 100)}%`;
    $('span', b).textContent = label;
  }
  /** While the show assets stream in, 开播 stays disabled and says how far along it is. */
  loadGate(p: number | null) {
    const start = $<HTMLButtonElement>('#casting .start');
    if (p == null) { start.textContent = '🎬 开播！'; return; }
    start.disabled = true;
    start.textContent = `🎬 嘉宾化妆中 ${Math.round(p * 100)}%`;
  }
  titleShown = false;

  title(joining: boolean, onGo: () => void) {
    this.titleShown = true;
    const t = $('#title');
    t.hidden = false;
    $('.go', t).textContent = joining ? '加入好友的别墅' : '开一间别墅';
    $('.sub2', t).textContent = joining ? '你收到了一张心跳别墅的入住邀请' : '创建房间，把链接发给朋友一起入住（1–6 人，空位由 AI 嘉宾补上）';
    $('.go', t).onclick = () => { t.hidden = true; onGo(); };
  }

  // ---------- casting ----------
  casting(opts: {
    name: string; invite: string; isHost: boolean; midShow: boolean;
    taken: Partial<Record<CharId, string>>; mine?: CharId; players: string[]; ready: boolean;
    onPick: (c: CharId) => void; onName: (n: string) => void; onStart: () => void;
  }) {
    const box = $('#casting');
    box.hidden = false;
    const grid = $('.cards', box);
    grid.innerHTML = '';
    for (const c of CAST) {
      const who = opts.mine === c.id ? '你' : opts.taken[c.id];
      const card = el(`
        <button class="card ${opts.mine === c.id ? 'mine' : ''} ${who && opts.mine !== c.id ? 'taken' : ''}" style="--c:${c.color}">
          <div class="ph"><img src="${portrait(c.id)}" alt=""></div>
          <div class="meta">
            <div class="nm">${c.name}<small>${c.age}</small></div>
            <div class="tt">${c.title} · ${c.tag}</div>
            <div class="mt">“${c.motto}”</div>
          </div>
          ${who ? `<div class="who">${escapeHtml(who)}</div>` : '<div class="who ai">AI 嘉宾</div>'}
        </button>`);
      card.onclick = () => { if (!who || opts.mine === c.id) opts.onPick(c.id); };
      grid.append(card);
    }
    const name = $<HTMLInputElement>('.nick', box);
    if (document.activeElement !== name) name.value = opts.name;
    name.onchange = () => opts.onName(name.value.trim().slice(0, 12) || '神秘嘉宾');
    $('.invite input', box).setAttribute('value', opts.invite);
    ($('.invite input', box) as HTMLInputElement).value = opts.invite;
    $('.invite button', box).onclick = () => this.copy(opts.invite);
    $('.plist', box).innerHTML = opts.players.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
    const start = $<HTMLButtonElement>('.start', box);
    start.hidden = !opts.isHost || opts.midShow;
    start.disabled = !opts.mine || !opts.ready;
    grid.classList.toggle('wait', opts.midShow && !opts.ready);
    start.onclick = opts.onStart;
    $('.waiting', box).textContent = opts.midShow
      ? (opts.ready ? '节目正在直播中——选一位 AI 嘉宾，替 TA 入住别墅！' : '节目正在直播中——别墅加载完成后，就能接管一位 AI 嘉宾')
      : opts.mine && !opts.ready && !opts.isHost ? '已选好嘉宾，别墅还在加载……'
      : opts.isHost ? (opts.mine ? '人到齐了就开播吧。空位由 AI 嘉宾补上。' : '先选一位嘉宾') : '等待房主开播……';
  }
  hideCasting() { $('#casting').hidden = true; }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => this.toast('邀请链接已复制，发给朋友吧 💌'), () => this.toast(text));
  }

  // ---------- HUD ----------
  showHud(on: boolean) { $('#hud').hidden = !on; }
  bindHud(isHost: boolean) {
    const hud = $('#hud');
    $('.skip', hud).hidden = !isHost;
    $('.skip', hud).onclick = () => this.onSkip?.();
    $('.invite', hud).onclick = () => this.onInvite?.();
    $('.mute', hud).onclick = () => { $('.mute', hud).textContent = this.onMute?.() ? '🔇' : '🔊'; };
    hud.querySelectorAll<HTMLButtonElement>('.emotes button[data-a]').forEach((b) => { b.onclick = () => this.onEmote?.(b.dataset.a!); });
    $('.rose', hud).onclick = () => this.onRose?.();
    hud.querySelectorAll<HTMLButtonElement>('.emotes button[data-k]').forEach((b) => { b.onclick = () => this.onAct?.(b.dataset.k as 'hug' | 'kiss'); });
    for (const b of document.querySelectorAll<HTMLButtonElement>('.mic')) b.onclick = () => this.onMic?.();
    const input = $<HTMLInputElement>('.chat input', hud);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = input.value.trim(); if (v) this.onChat?.(v.slice(0, 40)); input.value = ''; input.blur(); }
      if (e.key === 'Escape') input.blur();
    };
    addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement !== input && !$('#hud').hidden) { e.preventDefault(); input.focus(); }
    });
  }
  setSkip(isHost: boolean) { $('#hud .skip').hidden = !isHost; }

  phase(ep: number, label: string) {
    $('#hud .ep').textContent = EPISODES[ep]?.title ?? '';
    $('#hud .ph').textContent = label;
  }
  timer(sec: number | null) {
    const t = $('#hud .timer');
    t.hidden = sec == null || sec > 600;
    if (sec != null) { t.textContent = `${Math.max(0, Math.ceil(sec))}s`; t.classList.toggle('low', sec < 6); }
  }
  private meSig = '';
  me(c: CharId | undefined, h = 0, d = 0) {
    const m = $('#hud .mecard');
    const sig = `${c}|${h}|${d}`;
    if (sig === this.meSig) return;
    this.meSig = sig;
    if (!c) { m.hidden = true; return; }
    m.hidden = false;
    m.style.setProperty('--c', CHAR[c].color);
    m.innerHTML = `<img src="${portrait(c)}"><div><b>${CHAR[c].name}</b><span>💗 ${h}　🔥 ${d}</span></div>`;
  }
  roseButton(state: 'hidden' | 'idle' | 'ready', target = '') {
    const b = $<HTMLButtonElement>('#hud .rose');
    b.hidden = state === 'hidden';
    b.disabled = state !== 'ready';
    b.innerHTML = state === 'ready' ? `🌹 送给 ${target} <kbd>R</kbd>` : '🌹 靠近某人送玫瑰';
  }
  emotes(on: boolean) { $('#hud .emotes').classList.toggle('off', !on); }

  /** Hug/kiss buttons: hidden outside free roam, disabled when nobody is in reach, else name the target. */
  private actSig: string | null | undefined;
  actButtons(target: string | null) {
    if (target === this.actSig) return;
    this.actSig = target;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#hud .emotes button[data-k]')) {
      b.hidden = target === null;
      b.disabled = !target;
      b.title = target ? `${b.dataset.k === 'hug' ? '拥抱' : '亲吻'} ${target}（${b.dataset.k === 'hug' ? 'H' : 'K'}）` : '靠近某人才能互动';
    }
  }

  /** Incoming hug/kiss request: accept / refuse with a countdown (null hides it). */
  private askTimer = 0;
  askCard(text: string | null, seconds = 8, onAnswer?: (ok: boolean) => void) {
    const c = $('#askcard');
    clearTimeout(this.askTimer);
    if (text == null) { c.hidden = true; return; }
    $('p', c).textContent = text;
    $<HTMLButtonElement>('.yes', c).onclick = () => onAnswer?.(true);
    $<HTMLButtonElement>('.no', c).onclick = () => onAnswer?.(false);
    const bar = $('.cd i', c);
    bar.style.transition = 'none'; bar.style.width = '100%';
    c.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `width ${seconds}s linear`; bar.style.width = '0%'; }));
    this.askTimer = window.setTimeout(() => { c.hidden = true; }, seconds * 1000);
  }

  micState(on: boolean) {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.mic')) {
      b.classList.toggle('on', on);
      b.textContent = on ? (b.classList.contains('wide') ? '🎙️ 麦克风已开' : '🎙️') : (b.classList.contains('wide') ? '🔇 开麦聊天' : '🔇');
    }
  }

  feed(html: string) {
    const f = $('#hud .feed');
    const line = el(`<div class="line">${html}</div>`);
    f.append(line);
    while (f.children.length > 7) f.firstElementChild!.remove();
    setTimeout(() => line.classList.add('old'), 9000);
  }

  // ---------- show presentation ----------
  private subTimer = 0;
  subtitle(who: string, text: string, color = '#ff7eb6', hold = 4.5) {
    const s = $('#subtitle');
    s.style.setProperty('--c', color);
    s.innerHTML = `<b>${who}</b><span></span>`;
    s.classList.add('show');
    const span = $('span', s);
    let i = 0;
    clearInterval(this.subTimer);
    this.subTimer = window.setInterval(() => {
      span.textContent = text.slice(0, ++i);
      if (i >= text.length) {
        clearInterval(this.subTimer);
        this.subTimer = window.setTimeout(() => s.classList.remove('show'), hold * 1000);
      }
    }, 45);
  }
  clearSubtitle() { clearInterval(this.subTimer); $('#subtitle').classList.remove('show'); }

  huazi(text: string, color?: string) {
    const h = el(`<div class="hz">${escapeHtml(text)}</div>`);
    const hues = ['#ff3d8b', '#ffcf3d', '#3df2ff', '#b36bff', '#ff7a3d'];
    h.style.setProperty('--c', color ?? hues[Math.floor(Math.random() * hues.length)]);
    h.style.left = `${12 + Math.random() * 56}%`;
    h.style.top = `${14 + Math.random() * 30}%`;
    h.style.setProperty('--r', `${(Math.random() - 0.5) * 16}deg`);
    $('#huazi').append(h);
    setTimeout(() => h.remove(), 2600);
  }

  toast(text: string) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout((t as unknown as { _t: number })._t);
    (t as unknown as { _t: number })._t = window.setTimeout(() => t.classList.remove('show'), 3200);
  }

  letterbox(on: boolean) { $('#letterbox').classList.toggle('on', on); document.body.classList.toggle('cine', on); }
  fade(ms = 450) {
    const f = $('#fade');
    f.classList.add('on');
    return new Promise<void>((r) => setTimeout(() => { r(); setTimeout(() => f.classList.remove('on'), 60); }, ms));
  }

  epCard(ep: number) {
    const e = EPISODES[ep];
    const c = $('#epcard');
    c.innerHTML = `<small>HEARTBEAT VILLA</small><h1>${e.title}</h1><p>${e.sub}</p>`;
    c.classList.remove('show'); void c.offsetWidth; c.classList.add('show');
  }

  nameCard(c: CharId | null) {
    const n = $('#namecard');
    if (!c) { n.classList.remove('show'); return; }
    const d = CHAR[c];
    n.style.setProperty('--c', d.color);
    n.innerHTML = `<img src="${portrait(c)}"><div><h2>${d.name}<small>${d.age} · ${d.title}</small></h2><p>“${d.motto}”</p></div>`;
    n.classList.remove('show'); void n.offsetWidth; n.classList.add('show');
  }

  /** Big centred reveal card (who → whom). */
  reveal(html: string, cls = '') {
    const r = $('#reveal');
    r.className = cls;
    r.innerHTML = html;
    r.classList.add('show');
  }
  hideReveal() { $('#reveal').classList.remove('show'); }
  pairHtml(a: CharId, b: CharId | null, mid: string, caption: string) {
    const p = (c: CharId | null) => c
      ? `<div class="pp" style="--c:${CHAR[c].color}"><img src="${portrait(c)}"><b>${CHAR[c].name}</b></div>`
      : '<div class="pp q"><span>?</span><b>……</b></div>';
    return `<div class="pair">${p(a)}<div class="mid">${mid}</div>${p(b)}</div><div class="cap">${caption}</div>`;
  }

  // ---------- choices ----------
  choose<T>(title: string, sub: string, options: Choice<T>[], seconds: number, onPick: (v: T) => void) {
    const m = $('#modal');
    m.hidden = false;
    m.innerHTML = `<div class="sheet"><h2>${title}</h2><p>${sub}</p><div class="opts"></div><div class="countdown"><i></i></div><div class="done" hidden>已提交 ✓ 等待其他嘉宾……</div></div>`;
    const opts = $('.opts', m);
    const isChar = options.some((o) => o.char);
    opts.classList.toggle('chars', isChar);
    for (const o of options) {
      const b = el(o.char
        ? `<button class="opt ch" style="--c:${CHAR[o.char].color}" ${o.disabled ? 'disabled' : ''}><img src="${portrait(o.char)}"><b>${o.label}</b>${o.sub ? `<small>${o.sub}</small>` : ''}</button>`
        : `<button class="opt tx" ${o.disabled ? 'disabled' : ''}><b>${o.label}</b>${o.sub ? `<small>${o.sub}</small>` : ''}</button>`) as HTMLButtonElement;
      b.onclick = () => {
        onPick(o.value);
        opts.querySelectorAll('button').forEach((x) => x.classList.toggle('picked', x === b));
        $('.done', m).hidden = false;
      };
      opts.append(b);
    }
    const bar = $('.countdown i', m);
    bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(() => { bar.style.transition = `width ${seconds}s linear`; bar.style.width = '0%'; });
    clearTimeout(this.choiceTimer);
    this.choiceTimer = window.setTimeout(() => this.closeChoice(), seconds * 1000);
  }
  closeChoice() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
  waitNote(text: string | null) {
    const w = $('#waitnote');
    w.textContent = text ?? '';
    w.classList.toggle('show', !!text);
  }

  // ---------- finale ----------
  finale(opts: {
    couples: [CharId, CharId][]; star: CharId; drama: CharId; scores: Record<CharId, { h: number; d: number }>;
    ending: string; mine?: CharId; isHost: boolean; onAgain: () => void;
  }) {
    const f = $('#finale');
    const chip = (c: CharId) => `<span class="chip" style="--c:${CHAR[c].color}"><img src="${portrait(c)}">${CHAR[c].name}</span>`;
    const rows = CAST.slice().sort((a, b) => (opts.scores[b.id]?.h ?? 0) - (opts.scores[a.id]?.h ?? 0))
      .map((c) => `<tr class="${c.id === opts.mine ? 'me' : ''}"><td>${chip(c.id)}</td><td>💗 ${opts.scores[c.id]?.h ?? 0}</td><td>🔥 ${opts.scores[c.id]?.d ?? 0}</td></tr>`).join('');
    f.innerHTML = `
      <div class="sheet">
        <small>HEARTBEAT VILLA · 本季大结局</small>
        <h1>心跳别墅 · 完</h1>
        <div class="awards">
          <div class="aw cp"><h3>💞 本季 CP</h3>${opts.couples.length ? opts.couples.map(([a, b]) => `<div>${chip(a)}<span class="x">×</span>${chip(b)}</div>`).join('') : '<div class="none">本季无 CP 成立……这才是真实的心跳别墅。</div>'}</div>
          <div class="aw"><h3>👑 万人迷</h3>${chip(opts.star)}</div>
          <div class="aw"><h3>🔥 戏精之王</h3>${chip(opts.drama)}</div>
        </div>
        <p class="ending">${opts.ending}</p>
        <table>${rows}</table>
        <div class="btns">
          ${opts.isHost ? '<button class="again">再来一季</button>' : '<span class="wait">等待房主开启下一季……</span>'}
          <button class="share">邀请更多朋友</button>
        </div>
      </div>`;
    f.hidden = false;
    const again = f.querySelector<HTMLButtonElement>('.again');
    if (again) again.onclick = opts.onAgain;
    $('.share', f).onclick = () => this.onInvite?.();
  }
  hideFinale() { $('#finale').hidden = true; }

  // ---------- touch joystick ----------
  joystick(onMove: (x: number, y: number) => void) {
    const zone = $('#joy');
    const knob = $('i', zone);
    let id = -1, cx = 0, cy = 0;
    const R = 46;
    zone.addEventListener('pointerdown', (e) => {
      id = e.pointerId; zone.setPointerCapture(id);
      const r = zone.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      move(e);
    });
    const move = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.hypot(dx, dy); if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      onMove(dx / R, dy / R);
    };
    zone.addEventListener('pointermove', move);
    const end = (e: PointerEvent) => { if (e.pointerId !== id) return; id = -1; knob.style.transform = ''; onMove(0, 0); };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }
}

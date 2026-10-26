// All sound is synthesised with WebAudio: a soft lo-fi loop that changes mood per night,
// plus reality-show stingers. No audio files to download.

type Mood = 'day' | 'tense' | 'night' | 'sweet' | 'off';

const CHORDS: Record<Exclude<Mood, 'off'>, number[][]> = {
  day: [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]],
  tense: [[57, 60, 64, 67], [53, 57, 60, 64], [52, 55, 59, 62], [56, 59, 62, 65]],
  night: [[57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67], [52, 55, 59, 64]],
  sweet: [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]],
};
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class Audio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private mood: Mood = 'off';
  private nextBar = 0;
  private bar = 0;
  private timer = 0;
  muted = false;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = 0.22; this.musicBus.connect(this.master);
    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 0.7; this.sfxBus.connect(this.master);
    this.timer = window.setInterval(() => this.schedule(), 200);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  setMood(m: Mood) {
    if (m === this.mood) return;
    this.mood = m;
    if (this.ctx && this.nextBar < this.ctx.currentTime) this.nextBar = this.ctx.currentTime + 0.1;
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || this.mood === 'off') return;
    const bpm = this.mood === 'tense' ? 76 : this.mood === 'sweet' ? 88 : 82;
    const beat = 60 / bpm, barLen = beat * 4;
    while (this.nextBar < ctx.currentTime + 1.2) {
      const t0 = Math.max(this.nextBar, ctx.currentTime + 0.05);
      const chord = CHORDS[this.mood][this.bar % 4];
      // Pad.
      for (const n of chord) this.voice(midi(n - 12), t0, barLen * 1.02, 'sawtooth', 0.035, 900);
      // Bass.
      this.voice(midi(chord[0] - 24), t0, beat * 1.8, 'triangle', 0.18, 400);
      this.voice(midi(chord[0] - 24), t0 + beat * 2, beat * 1.6, 'triangle', 0.14, 400);
      // Pluck arpeggio.
      const arp = [0, 2, 1, 3, 2, 1, 3, 2];
      for (let i = 0; i < 8; i++) {
        if (this.mood === 'tense' && i % 2) continue;
        this.voice(midi(chord[arp[i]] + 12), t0 + (i * beat) / 2, beat * 0.45, 'triangle', 0.05, 3000);
      }
      // Soft kick + hat.
      for (let i = 0; i < 4; i++) {
        this.kick(t0 + i * beat, i % 2 ? 0.12 : 0.22);
        this.hat(t0 + i * beat + beat / 2, 0.04);
      }
      this.nextBar = t0 + barLen;
      this.bar++;
    }
  }

  private voice(f: number, t: number, dur: number, type: OscillatorType, vol: number, cutoff: number, bus = this.musicBus) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = type; o.frequency.value = f;
    if (type === 'sawtooth') o.detune.value = (Math.random() - 0.5) * 14;
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.08, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(bus);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private noise(t: number, dur: number, vol: number, f: number, type: BiquadFilterType = 'highpass', bus = this.musicBus) {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = buf; flt.type = type; flt.frequency.value = f;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(flt).connect(g).connect(bus);
    s.start(t);
  }

  private kick(t: number, vol: number, bus = this.musicBus) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(bus); o.start(t); o.stop(t + 0.4);
  }

  private hat(t: number, vol: number) { this.noise(t, 0.05, vol, 7000); }

  private now() { return this.ctx ? this.ctx.currentTime + 0.01 : -1; }

  // ---- stingers ----
  heartbeat(times = 2) {
    const t = this.now(); if (t < 0) return;
    for (let i = 0; i < times; i++) {
      this.kick(t + i * 0.75, 0.9, this.sfxBus);
      this.kick(t + i * 0.75 + 0.22, 0.6, this.sfxBus);
    }
  }
  sting() {
    const t = this.now(); if (t < 0) return;
    for (const n of [38, 45, 50, 53]) this.voice(midi(n), t, 2.2, 'sawtooth', 0.12, 1200, this.sfxBus);
    this.kick(t, 1, this.sfxBus);
    this.noise(t, 1.2, 0.25, 300, 'lowpass', this.sfxBus);
    for (const n of [37, 44, 49, 52]) this.voice(midi(n), t + 0.9, 2.4, 'sawtooth', 0.1, 900, this.sfxBus);
  }
  chime() {
    const t = this.now(); if (t < 0) return;
    [84, 88, 91, 96].forEach((n, i) => this.voice(midi(n), t + i * 0.08, 1.2, 'sine', 0.18, 8000, this.sfxBus));
  }
  pop() {
    const t = this.now(); if (t < 0) return;
    this.voice(880, t, 0.08, 'sine', 0.15, 6000, this.sfxBus);
  }
  whoosh() {
    const t = this.now(); if (t < 0) return;
    this.noise(t, 0.6, 0.18, 900, 'bandpass', this.sfxBus);
  }
  drumroll(dur: number) {
    const t = this.now(); if (t < 0) return;
    for (let x = 0; x < dur; x += 0.045) this.noise(t + x, 0.06, 0.05 + (x / dur) * 0.12, 1800, 'bandpass', this.sfxBus);
  }
  match() {
    const t = this.now(); if (t < 0) return;
    [72, 76, 79, 84, 88].forEach((n, i) => this.voice(midi(n), t + i * 0.1, 1.6, 'triangle', 0.16, 6000, this.sfxBus));
    this.noise(t + 0.5, 1.5, 0.12, 5000, 'highpass', this.sfxBus);
  }
  sad() {
    const t = this.now(); if (t < 0) return;
    [64, 63, 59, 55].forEach((n, i) => this.voice(midi(n), t + i * 0.35, 1.2, 'sine', 0.16, 2000, this.sfxBus));
  }
  boom() {
    const t = this.now(); if (t < 0) return;
    this.kick(t, 0.5, this.sfxBus);
    this.noise(t, 0.9, 0.12, 2500, 'lowpass', this.sfxBus);
  }
  thunder() {
    const t = this.now(); if (t < 0) return;
    this.noise(t, 3.2, 0.5, 220, 'lowpass', this.sfxBus);
    this.noise(t + 0.05, 0.4, 0.3, 1200, 'lowpass', this.sfxBus);
  }

  dispose() { clearInterval(this.timer); void this.ctx?.close(); }
}

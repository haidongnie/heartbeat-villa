// Proximity voice chat: a WebRTC audio mesh (≤ 6 players → ≤ 5 peers each), signalled over Playroom RPC,
// mixed through WebAudio PannerNodes so a voice fades with the distance between the two characters.
// The mic stays off until the player turns it on; peers connect anyway so others can be heard.

export interface Signal { kind: 'offer' | 'answer' | 'ice'; sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }
type Send = (to: string, s: Signal) => void;

interface Peer {
  pc: RTCPeerConnection;
  sender?: RTCRtpSender;
  el?: HTMLAudioElement;
  src?: MediaStreamAudioSourceNode;
  panner?: PannerNode;
  analyser?: AnalyserNode;
  level: number;
  pendingIce: RTCIceCandidateInit[];
  retry?: number;
}

/** Ordered so mainland-China-reachable servers are tried alongside the usual ones. TURN is optional (env). */
function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  ];
  const turn = import.meta.env.VITE_TURN_URL;
  if (turn) servers.push({ urls: turn.split(','), username: import.meta.env.VITE_TURN_USER, credential: import.meta.env.VITE_TURN_CRED });
  return servers;
}

export class ProximityVoice {
  private readonly peers = new Map<string, Peer>();
  private ctx?: AudioContext;
  private mic?: MediaStream;
  private micAnalyser?: AnalyserNode;
  private readonly buf = new Float32Array(512);
  micOn = false;
  /** Called when the mic state changes so the game can publish it to the room. */
  onMic?: (on: boolean) => void;

  constructor(private readonly me: string, private readonly send: Send) {}

  private audio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const l = this.ctx.listener;
      if (l.positionX) { l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0; }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Keep one peer per other player; the lower id makes the offer so the two sides never collide. */
  sync(playerIds: string[]) {
    for (const id of playerIds) if (id !== this.me && !this.peers.has(id) && this.me < id) this.connect(id);
    for (const id of [...this.peers.keys()]) if (!playerIds.includes(id)) this.drop(id);
  }

  private create(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const peer: Peer = { pc, level: 0, pendingIce: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, { kind: 'ice', ice: e.candidate.toJSON() }); };
    pc.ontrack = (e) => this.attach(id, peer, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.me < id && peer.retry === undefined) {
        // Offerer rebuilds after a short pause (network change, NAT rebinding).
        peer.retry = window.setTimeout(() => { this.drop(id); this.connect(id); }, 3000);
      }
    };
    return peer;
  }

  private async connect(id: string) {
    const peer = this.create(id);
    const t = peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
    peer.sender = t.sender;
    if (this.mic) await t.sender.replaceTrack(this.mic.getAudioTracks()[0]);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.send(id, { kind: 'offer', sdp: peer.pc.localDescription!.toJSON() });
  }

  async onSignal(from: string, s: Signal) {
    try {
      let peer = this.peers.get(from);
      if (s.kind === 'offer') {
        if (peer) this.drop(from); // the other side restarted
        peer = this.create(from);
        await peer.pc.setRemoteDescription(s.sdp!);
        const t = peer.pc.getTransceivers()[0];
        if (t) { t.direction = 'sendrecv'; peer.sender = t.sender; if (this.mic) await t.sender.replaceTrack(this.mic.getAudioTracks()[0]); }
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.send(from, { kind: 'answer', sdp: peer.pc.localDescription!.toJSON() });
        for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c);
      } else if (s.kind === 'answer' && peer && peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(s.sdp!);
        for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c);
      } else if (s.kind === 'ice' && peer && s.ice) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(s.ice); else peer.pendingIce.push(s.ice);
      }
    } catch (e) {
      console.warn('[voice] signal', s.kind, 'from', from, e);
    }
  }

  private attach(id: string, peer: Peer, stream: MediaStream) {
    const ctx = this.audio();
    // Chrome only feeds a remote WebRTC stream into WebAudio while a media element is playing it.
    peer.el?.remove();
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    void el.play().catch(() => { /* muted autoplay is always allowed */ });
    peer.el = el;
    peer.src?.disconnect();
    const src = ctx.createMediaStreamSource(stream);
    const panner = new PannerNode(ctx, {
      panningModel: 'HRTF', distanceModel: 'linear', refDistance: 1.5, maxDistance: 14, rolloffFactor: 1,
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    src.connect(panner).connect(ctx.destination);
    Object.assign(peer, { src, panner, analyser });
  }

  private drop(id: string) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.retry);
    p.pc.close();
    p.src?.disconnect();
    p.panner?.disconnect();
    p.el?.remove();
    this.peers.delete(id);
  }

  /** Turn the microphone on/off. Returns the new state; throws if permission is denied. */
  async setMic(on: boolean) {
    if (on && !this.mic) {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = this.audio();
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      ctx.createMediaStreamSource(this.mic).connect(this.micAnalyser);
    }
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = on;
    for (const p of this.peers.values()) if (p.sender && track && p.sender.track !== track) await p.sender.replaceTrack(track);
    this.micOn = on;
    this.onMic?.(on);
    return on;
  }

  /**
   * Position every voice. `where(id)` gives the speaker's head position (or null when unknown: heard at full
   * volume, e.g. in the casting room). The listener sits at `ear`, facing `fwd`.
   */
  update(ear: { x: number; y: number; z: number } | null, fwd: { x: number; z: number }, where: (id: string) => { x: number; y: number; z: number } | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener, t = ctx.currentTime;
    const e = ear ?? { x: 0, y: 0, z: 0 };
    if (l.positionX) {
      l.positionX.setTargetAtTime(e.x, t, 0.05); l.positionY.setTargetAtTime(e.y, t, 0.05); l.positionZ.setTargetAtTime(e.z, t, 0.05);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.05); l.forwardY.setTargetAtTime(0, t, 0.05); l.forwardZ.setTargetAtTime(fwd.z, t, 0.05);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
    for (const [id, p] of this.peers) {
      if (!p.panner) continue;
      const s = ear ? where(id) : null;
      const pos = s ?? e; // unknown speaker or no listener: right at the ear = full volume
      p.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
      p.panner.positionY.setTargetAtTime(pos.y, t, 0.05);
      p.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
      p.level = rms(p.analyser!, this.buf);
    }
  }

  /** 0..1 loudness of a remote player (or of the local mic for this.me), for the "speaking" indicator. */
  level(id: string) {
    if (id === this.me) return this.micOn && this.micAnalyser ? rms(this.micAnalyser, this.buf) : 0;
    return this.peers.get(id)?.level ?? 0;
  }

  connected(id: string) {
    const s = this.peers.get(id)?.pc.connectionState;
    return s === 'connected';
  }

  dispose() {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
  }
}

function rms(a: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  a.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(s / buf.length) * 6);
}

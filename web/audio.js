// The room's sound. With an ElevenLabs key the server makes real sound effects
// once (room tone, whispers, knock, gust, creak...) and they are layered here;
// without one, everything falls back to procedural sound. The scrape of wood
// on wood is always procedural, because it follows the planchette's real speed.

export class Sound {
  constructor() { this.ctx = null; this.on = true; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = (this.ctx = new C());
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.9 : 0;
    this.master.connect(ctx.destination);

    // room drone: two low, slightly detuned tones breathing in and out
    const drone = ctx.createGain();
    drone.gain.value = 0.045;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 240;
    for (const f of [55, 55.6, 82.4]) {
      const o = ctx.createOscillator();
      o.type = f > 80 ? "sine" : "sawtooth";
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = 0.07; lfoG.gain.value = 0.02;
    lfo.connect(lfoG); lfoG.connect(drone.gain); lfo.start();
    lp.connect(drone); drone.connect(this.master);
    this.drone = drone;

    // scrape: brown noise through a band-pass, gain follows speed
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.bp = ctx.createBiquadFilter();
    this.bp.type = "bandpass"; this.bp.frequency.value = 420; this.bp.Q.value = 0.9;
    this.scrape = ctx.createGain();
    this.scrape.gain.value = 0;
    src.connect(this.bp); this.bp.connect(this.scrape); this.scrape.connect(this.master);
    src.start();
    this.noiseBuf = buf;

    // without the whisper sample, a faint high hiss rises when the model is torn
    const hs = ctx.createBufferSource(), hbp = ctx.createBiquadFilter();
    hs.buffer = buf; hs.loop = true; hbp.type = "bandpass"; hbp.frequency.value = 3200; hbp.Q.value = 2;
    this.tornNoise = ctx.createGain(); this.tornNoise.gain.value = 0;
    hs.connect(hbp); hbp.connect(this.tornNoise); this.tornNoise.connect(this.master); hs.start();
    this.beds();
  }

  setOn(on) {
    this.on = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.1);
  }

  move(speed) {
    if (!this.ctx) return;
    const v = Math.min(1, speed / 900);
    const t = this.ctx.currentTime;
    this.scrape.gain.setTargetAtTime(v * v * 0.9, t, 0.05);
    this.bp.frequency.setTargetAtTime(300 + v * 700, t, 0.08);
  }

  _knock(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * strength, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.4);
    const n = ctx.createBufferSource(), ng = ctx.createGain(), hp = ctx.createBiquadFilter();
    n.buffer = this.noiseBuf; hp.type = "highpass"; hp.frequency.value = 1400;
    ng.gain.setValueAtTime(0.25 * strength, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(hp); hp.connect(ng); ng.connect(this.master);
    n.start(t, Math.random()); n.stop(t + 0.08);
  }

  // a match striking: a scratch, then a soft catch of flame
  _strike() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(), g = ctx.createGain(), bp = ctx.createBiquadFilter();
    n.buffer = this.noiseBuf; bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t, Math.random()); n.stop(t + 0.4);
  }

  // candles blown out: a soft breath of air
  _blow(amt = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    n.buffer = this.noiseBuf; lp.type = "lowpass"; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(200, t + 1.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * amt, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    n.connect(lp); lp.connect(g); g.connect(this.master);
    n.start(t, Math.random()); n.stop(t + 1.7);
  }



  // ---------------------------------------------------------------- samples
  ensure() {
    if (!this.ctx) this.start();
    return this.ctx;
  }

  async load(names) {
    const ctx = this.ensure();
    if (!ctx) return [];
    this.buf = this.buf || {};
    const got = [];
    await Promise.all(names.map(async (n) => {
      try {
        const r = await fetch(`api/sfx/${n}`);
        if (!r.ok) return;
        let b = await ctx.decodeAudioData(await r.arrayBuffer());
        const bed = n === "room" || n === "whisper" || n === "music";
        b = normalize(ctx, b, bed ? 0.5 : 0.9);
        if (bed) b = seamless(ctx, b, n === "music" ? 2.5 : 1.5);
        this.buf[n] = b; got.push(n);
      } catch { /* that one stays procedural */ }
    }));
    this.beds();
    return got;
  }

  has(n) { return !!(this.buf && this.buf[n]); }

  // one-shot sample: gain, playback rate, stereo position
  shot(n, gain = 1, rate = 1, pan = 0) {
    if (!this.ctx || !this.has(n)) return false;
    const ctx = this.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = this.buf[n]; s.playbackRate.value = rate; g.gain.value = gain;
    s.connect(g);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.master); }
    else g.connect(this.master);
    s.start();
    return true;
  }

  // the room tone and the whisper bed, looping under everything
  beds() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.has("room") && !this.roomSrc) {
      const s = (this.roomSrc = ctx.createBufferSource()), g = ctx.createGain();
      s.buffer = this.buf.room; s.loop = true; g.gain.value = 0;
      g.gain.setTargetAtTime(0.55, ctx.currentTime, 2.5);
      s.connect(g); g.connect(this.master); s.start();
      this.roomGain = g;
      this.drone.gain.setTargetAtTime(0.022, ctx.currentTime, 2); // the synth drone steps back
    }
    if (this.has("music") && !this.musicSrc) {
      const s = (this.musicSrc = ctx.createBufferSource()), g = ctx.createGain();
      s.buffer = this.buf.music; s.loop = true; g.gain.value = 0;
      g.gain.setTargetAtTime(0.32, ctx.currentTime, 3);
      s.connect(g); g.connect(this.master); s.start();
      this.musicGain = g;
    }
    if (this.has("whisper") && !this.whisperSrc) {
      const s = (this.whisperSrc = ctx.createBufferSource()), g = ctx.createGain(), lp = ctx.createBiquadFilter();
      s.buffer = this.buf.whisper; s.loop = true; g.gain.value = 0;
      lp.type = "lowpass"; lp.frequency.value = 5200;
      s.connect(lp); lp.connect(g); g.connect(this.master); s.start();
      this.whisperGain = g;
    }
  }

  // how torn the model is, 0..1: the whispers rise with it
  torn(x) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.whisperGain) this.whisperGain.gain.setTargetAtTime(x > 0.05 ? 0.15 + x * 0.75 : 0, t, x > 0.05 ? 0.25 : 0.6);
    else if (this.tornNoise) this.tornNoise.gain.setTargetAtTime(x * 0.06, t, 0.3);
    if (this.roomGain) this.roomGain.gain.setTargetAtTime(0.55 - x * 0.25, t, 0.5); // the room holds its breath
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0.32 - x * 0.18, t, 0.5);
  }

  knock(strength = 1) {
    if (!this.shot("knock", 0.35 + strength * 0.35, 0.92 + Math.random() * 0.16, (Math.random() - 0.5) * 0.4)) this._knock(strength);
  }
  blow() {
    if (!this.shot("gust", 0.95)) this._blow();
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 1.2);
  }
  // when the candles are lit again, the music comes back
  strike() {
    if (!this.shot("strike", 0.7)) this._strike();
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0.32, this.ctx.currentTime, 2);
  }
  creak() { this.shot("creak", 0.8, 0.95, -0.3) || this._blow(0.3); }
  breath() { this.shot("breath", 0.9, 0.92, 0.25) || this._blow(0.5); }
}

function normalize(ctx, b, peak) {
  let m = 0;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.abs(d[i])); }
  if (m < 1e-4) return b;
  const k = peak / m;
  for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
  return b;
}

// fold the last few seconds into the start with an equal-power crossfade, so the loop has no seam
function seamless(ctx, b, secs) {
  const X = Math.min(Math.floor(secs * b.sampleRate), Math.floor(b.length / 3));
  const L = b.length - X, out = ctx.createBuffer(b.numberOfChannels, L, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const a = b.getChannelData(c), o = out.getChannelData(c);
    o.set(a.subarray(0, L));
    for (let i = 0; i < X; i++) {
      const t = i / X;
      o[i] = a[i] * Math.sin(t * Math.PI / 2) + a[L + i] * Math.cos(t * Math.PI / 2);
    }
  }
  return out;
}

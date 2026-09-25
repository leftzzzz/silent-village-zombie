// Procedural audio engine for the New Silent Village (Terminator mode) fan recreation.
// Every sound is synthesized in JS (deterministic, seeded) into AudioBuffers; nothing is downloaded.
//
//   import { audio } from './engine/audio.js';
//   audio.unlock();                                  // from a user gesture
//   audio.setListener(camPos, yaw);                  // every frame
//   audio.play('shot_ak47');                         // 2D (own gun)
//   audio.play('shot_ak47', { pos: {x, y, z} });     // spatial (HRTF, distance lowpass + reverb)
//   const hb = audio.loop('heartbeat'); hb.setVolume(0.5); hb.stop();
//   audio.startAmbient();
//
// Buffers are rendered by pure functions (renderSound) so they can be verified outside the browser.

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const att = (t, a) => (t <= 0 ? 0 : t >= a ? 1 : t / a);
const win = (u) => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u));
const semi = (n) => Math.pow(2, n / 12);
const glide = (a, b, x) => a * Math.pow(b / a, clamp(x, 0, 1));
const fnv = (v, d) => (v === undefined ? () => d : typeof v === 'function' ? v : () => v);

function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = a[i] < 0 ? -a[i] : a[i]; if (v > p) p = v; } return p; }
function norm(a, p = 1) { const m = peakOf(a); if (m > 1e-12) { const s = p / m; for (let i = 0; i < a.length; i++) a[i] *= s; } return a; }

// RBJ biquad (direct form I, doubles)
class BQ {
  constructor(sr, type = 'lowpass', f = 1000, q = 0.707, db = 0) {
    this.sr = sr; this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q, db);
  }
  set(f, q = 0.707, db = 0) {
    const sr = this.sr;
    f = clamp(f, 8, sr * 0.45); q = Math.max(q, 0.05);
    const w = (TAU * f) / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'peak': b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break;
      }
      default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; // lowpass
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  tick(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// in-place filter; f / q may be functions of time (seconds), updated every 32 samples
function filt(sr, a, type, f, q = 0.707, db = 0) {
  const fF = typeof f === 'function', qF = typeof q === 'function';
  const bq = new BQ(sr, type, fF ? f(0) : f, qF ? q(0) : q, db);
  const dyn = fF || qF;
  for (let i = 0; i < a.length; i++) {
    if (dyn && (i & 31) === 0 && i) { const t = i / sr; bq.set(fF ? f(t) : f, qF ? q(t) : q, db); }
    a[i] = bq.tick(a[i]);
  }
  return a;
}

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function oscv(type, ph, dt) {
  switch (type) {
    case 'saw': return 2 * ph - 1 - blep(ph, dt);
    case 'square': { let v = ph < 0.5 ? 1 : -1; v += blep(ph, dt); v -= blep((ph + 0.5) % 1, dt); return v; }
    case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
    default: return Math.sin(TAU * ph);
  }
}

// seamless loop: crossfade the extra tail (a.length - loopLen samples) into the head
function loopify(a, loopLen) {
  const fade = a.length - loopLen, out = a.slice(0, loopLen);
  for (let i = 0; i < fade; i++) {
    const x = i / fade;
    out[i] = a[i] * Math.sin((x * Math.PI) / 2) + a[loopLen + i] * Math.cos((x * Math.PI) / 2);
  }
  return out;
}

// vowel formants [F1..F4] (adult male); scaled for monsters / screams
const VOW = { a: [730, 1090, 2440, 3400], u: [640, 1190, 2390, 3300], o: [570, 840, 2410, 3300], oo: [300, 870, 2240, 3200], e: [530, 1840, 2480, 3500], i: [270, 2290, 3010, 3700] };
const FBW = [90, 110, 170, 250], FGN = [1, 0.55, 0.28, 0.12];
const vf = (name, sc = 1, bws = 1, g = FGN) => VOW[name].map((f, j) => [f * sc, FBW[j] * bws * Math.max(1, sc), g[j]]);
const vmix = (A, B, m) => A.map((x, j) => [lerp(x[0], B[j][0], m), lerp(x[1], B[j][1], m), lerp(x[2], B[j][2], m)]);

// ---------------------------------------------------------------------------------------------
// Synthesis context: seeded RNG + layer generators. Layer generators return peak-normalized arrays
// so composition gains read as relative peak levels.
class Syn {
  constructor(sr, seed) { this.sr = sr; this.r = mulberry32(seed); }
  n(s) { return Math.max(1, Math.ceil(s * this.sr)); }
  buf(s) { return new Float32Array(this.n(s)); }
  rnd() { return this.r(); }
  rr(a, b) { return a + (b - a) * this.r(); }
  ri(a, b) { return Math.floor(this.rr(a, b + 0.999)); }
  wn() { return this.r() * 2 - 1; }
  J(x, a = 0.06) { return x * (1 + (this.r() * 2 - 1) * a); }
  add(dst, src, t = 0, g = 1) {
    const o = Math.round(t * this.sr), m = Math.min(src.length, dst.length - o);
    for (let i = Math.max(0, -o); i < m; i++) dst[o + i] += src[i] * g;
    return dst;
  }
  filt(a, type, f, q = 0.707, db = 0) { return filt(this.sr, a, type, f, q, db); }
  env(a, fn) { const sr = this.sr; for (let i = 0; i < a.length; i++) a[i] *= fn(i / sr); return a; }
  gen(color = 'white') {
    const r = this.r;
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0;
      return () => { const w = r() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * 0.1848) * 0.25; };
    }
    if (color === 'brown') { let b = 0; return () => { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; return b * 3.5; }; }
    return () => r() * 2 - 1;
  }
  // smooth value noise in [-1,1] at `rate` Hz
  vn(rate, dur) {
    const m = Math.ceil(rate * dur) + 3, v = new Float32Array(m);
    for (let k = 0; k < m; k++) v[k] = this.wn();
    return (t) => {
      const x = Math.max(0, t * rate), i = Math.min(Math.floor(x), m - 2), fr = Math.min(1, x - i), u = (1 - Math.cos(Math.PI * fr)) * 0.5;
      return v[i] + (v[i + 1] - v[i]) * u;
    };
  }
  noise({ dur, color = 'white', type, f = 1000, q = 0.707, type2, f2 = 1000, q2 = 0.707, eq, env, raw = false }) {
    const n = this.n(dur), a = new Float32Array(n), g = this.gen(color);
    for (let i = 0; i < n; i++) a[i] = g();
    if (type) this.filt(a, type, f, q);
    if (type2) this.filt(a, type2, f2, q2);
    if (eq) for (const e of eq) this.filt(a, e[0], e[1], e[2], e[3]);
    if (env) this.env(a, env);
    return raw ? a : norm(a);
  }
  thud({ dur, f0, f1, ptau = 0.03, tau = 0.08, att: at = 0.0008, drive = 0, h2 = 0 }) {
    dur = dur || tau * 7 + 0.01;
    const n = this.n(dur), a = new Float32Array(n), sr = this.sr;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (f1 + (f0 - f1) * Math.exp(-t / ptau)) / sr; if (ph >= 1) ph -= 1;
      let v = Math.sin(TAU * ph); if (h2) v += h2 * Math.sin(2 * TAU * ph);
      v *= (1 - Math.exp(-t / at)) * Math.exp(-t / tau);
      a[i] = drive ? Math.tanh(v * drive) : v;
    }
    return norm(a);
  }
  click({ f = 3000, q = 5, dur, tau = 0.003, f2 = 0, g2 = 0.6, imp = 3 }) {
    dur = dur || tau * 8 + 0.004;
    const n = this.n(dur), a = new Float32Array(n), sr = this.sr;
    const b1 = new BQ(sr, 'bandpass', f, q), b2 = f2 ? new BQ(sr, 'bandpass', f2, q) : null;
    for (let i = 0; i < n; i++) {
      const x = this.wn() * Math.exp(-i / (tau * sr)) + (i === 0 ? imp : 0);
      a[i] = b1.tick(x) + (b2 ? g2 * b2.tick(x) : 0);
    }
    return norm(a);
  }
  // decaying inharmonic partials [[f, amp, tau], ...] (recursive oscillators)
  ring({ dur, partials, strike = 0, strikeF = 4000, beat = 0, att: at = 0.0006 }) {
    const sr = this.sr;
    if (!dur) dur = Math.max(...partials.map((p) => p[2])) * 6 + 0.01;
    const n = this.n(dur), a = new Float32Array(n);
    for (const [f, amp, tau] of partials) {
      if (f >= sr * 0.45 || f <= 0) continue;
      const w = (TAU * f) / sr, c2 = 2 * Math.cos(w), ph = this.rnd() * TAU, d = Math.exp(-1 / (tau * sr));
      const m = Math.min(n, Math.ceil(tau * sr * 7)), bw = beat ? (TAU * this.rr(0.4, 1.8)) / sr : 0;
      let y1 = Math.sin(ph - w), y2 = Math.sin(ph - 2 * w), e = amp;
      for (let i = 0; i < m; i++) {
        const y = c2 * y1 - y2; y2 = y1; y1 = y;
        let v = y * e; if (beat) v *= 1 - beat * 0.5 * (1 - Math.cos(bw * i));
        a[i] += v; e *= d;
      }
    }
    const na = Math.max(1, Math.round(at * sr));
    for (let i = 0; i < na && i < n; i++) a[i] *= i / na;
    norm(a);
    if (strike) this.add(a, this.click({ f: strikeF, q: 1.2, tau: 0.0015 }), 0, strike);
    return norm(a);
  }
  mclick(f, dec = 0.012) {
    const a = this.click({ f, q: 4, tau: 0.002 });
    const r = this.ring({ partials: [[f * 0.63, 0.6, dec], [f * 1.12, 0.8, dec * 0.8], [f * 1.71, 0.5, dec * 0.6]].map(([x, g, t]) => [this.J(x, 0.04), g, t]) });
    const out = new Float32Array(Math.max(a.length, r.length));
    this.add(out, a, 0, 1); this.add(out, r, 0, 0.6);
    return norm(out);
  }
  grains({ dur, count, fLo = 1000, fHi = 5000, q = 3, gdur = 0.006, dens = () => 1, amp }) {
    const a = new Float32Array(this.n(dur));
    let placed = 0, tries = 0;
    while (placed < count && tries < count * 30) {
      tries++;
      const u = this.rnd();
      if (this.rnd() > dens(u)) continue;
      placed++;
      const g = this.click({ f: this.rr(fLo, fHi), q, tau: gdur * this.rr(0.3, 1), imp: 1 });
      this.add(a, g, u * Math.max(0, dur - gdur * 8), amp ? amp(u) : 0.2 + 0.8 * this.rnd() ** 2);
    }
    return norm(a);
  }
  tone({ dur, f, type = 'sine', env, voices = 1, detune = 0, lp = 0, lpq = 0.7, vib = null }) {
    const sr = this.sr, n = this.n(dur), a = new Float32Array(n), fF = fnv(f);
    for (let v = 0; v < voices; v++) {
      const dm = voices > 1 ? Math.pow(2, (detune * ((2 * v) / (voices - 1) - 1)) / 1200) : 1;
      let ph = this.rnd();
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let fr = fF(t) * dm; if (vib) fr *= 1 + vib[1] * Math.sin(TAU * vib[0] * t);
        const dt = fr / sr; ph += dt; if (ph >= 1) ph -= 1;
        a[i] += oscv(type, ph, dt);
      }
    }
    if (lp) this.filt(a, 'lowpass', lp, lpq);
    if (env) this.env(a, env);
    return norm(a);
  }
  fm({ dur, f, ratio = 1.4, index = 3, env }) {
    const sr = this.sr, n = this.n(dur), a = new Float32Array(n), fF = fnv(f), iF = fnv(index);
    let pc = 0, pm = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, fc = fF(t);
      pc += fc / sr; pm += (fc * ratio) / sr; if (pc > 1e4) pc -= 1e4; if (pm > 1e4) pm -= 1e4;
      a[i] = Math.sin(TAU * pc + iF(t) * Math.sin(TAU * pm));
    }
    if (env) this.env(a, env);
    return norm(a);
  }
  pad(freqs, dur, { lp = 1200, env, det = 8, q = 0.8 } = {}) {
    const a = new Float32Array(this.n(dur));
    for (const f of freqs) this.add(a, this.tone({ dur, f, type: 'saw', voices: 2, detune: det }), 0, 1 / freqs.length);
    this.filt(a, 'lowpass', lp, q);
    if (env) this.env(a, env);
    return norm(a);
  }
  whoosh({ dur, f, q = 1.5, color = 'pink', peak = 0.45, pow = 2 }) {
    const fF = Array.isArray(f) ? (u) => (u < peak ? glide(f[0], f[1], u / peak) : glide(f[1], f[2] ?? f[1], (u - peak) / (1 - peak))) : f;
    const shape = (u) => { const w = u < peak ? (0.5 * u) / peak : 0.5 + (0.5 * (u - peak)) / (1 - peak); return Math.pow(Math.max(0, Math.sin(Math.PI * w)), pow); };
    return this.noise({ dur, color, type: 'bandpass', f: (t) => fF(t / dur), q, env: (t) => shape(t / dur) });
  }
  scrape({ dur, f0, f1, q = 3, grain = 0.6, color = 'white' }) {
    const g = this.vn(90, dur + 0.05);
    return this.noise({ dur, color, type: 'bandpass', f: (t) => glide(f0, f1, t / dur), q, env: (t) => win(t / dur) * (1 - grain + grain * Math.abs(g(t))) });
  }
  // electrical crackle: Poisson micro-bursts with heavy-tailed amplitudes
  crackle({ dur, rate = () => 300, hp = 1500, len = [0.0002, 0.002] }) {
    const sr = this.sr, n = this.n(dur), a = new Float32Array(n);
    let i = 0;
    while (i < n) {
      const r = Math.max(1, rate(i / sr));
      i += Math.max(1, Math.round((-Math.log(1 - this.rnd() + 1e-9) / r) * sr));
      if (i >= n) break;
      const amp = Math.pow(this.rnd(), 2.5) * (this.rnd() < 0.1 ? 3 : 1), l = Math.max(2, Math.round(sr * this.rr(len[0], len[1])));
      for (let k = 0; k < l && i + k < n; k++) a[i + k] += amp * this.wn() * Math.exp(-k / (l * 0.3));
    }
    this.filt(a, 'highpass', hp, 0.7);
    return norm(a);
  }
  // stick-slip friction (creaks, squeaks): irregular impulse train through resonances
  creak({ dur, f, res = [[420, 9, 1], [900, 10, 0.6], [1750, 8, 0.3]], irr = 0.15, env }) {
    const sr = this.sr, n = this.n(dur), exc = new Float32Array(n);
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (i >= next) { exc[i] = 0.5 + 0.5 * this.rnd(); next = i + Math.max(2, Math.round((sr / Math.max(20, f(i / n))) * (1 + irr * this.wn()))); }
    }
    const out = new Float32Array(n);
    for (const [rf, rq, rg] of res) { const b = exc.slice(); this.filt(b, 'bandpass', rf, rq); this.add(out, norm(b), 0, rg); }
    if (env) this.env(out, (t) => env(t / dur));
    return norm(out);
  }
  // formant voice: Rosenberg glottal pulse (+ saw buzz, aspiration, subharmonic fry, throat rattle)
  voice(dur, o) {
    const sr = this.sr, n = this.n(dur), out = new Float32Array(n);
    const f0F = fnv(o.f0, 100), brF = fnv(o.breath, 0.2), fryF = fnv(o.fry, 0), drF = fnv(o.drive, 0), jitF = fnv(o.jit, 0.02);
    const sawF = fnv(o.saw, 0), envF = fnv(o.env, 1), ratF = fnv(o.rattle, 0);
    const formF = typeof o.form === 'function' ? o.form : () => o.form;
    const vib = o.vib || [0, 0], rHz = o.rattleHz || 30;
    const jn = this.vn(25, dur + 0.1), jn2 = this.vn(3, dur + 0.1), rn = this.vn(12, dur + 0.1);
    let F = formF(0);
    const bqs = F.map(([f, bw]) => new BQ(sr, 'bandpass', f, f / bw));
    const tilt = new BQ(sr, 'lowpass', o.tilt || 3500, 0.6);
    const Tp = o.Tp || 0.42, Tn = o.Tn || 0.16;
    let ph = 0, prev = 0, ca = 1, cyc = 0, f0 = 100, br = 0, fry = 0, jit = 0, saw = 0, rat = 0, rph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 31) === 0) {
        F = formF(t);
        for (let k = 0; k < bqs.length; k++) bqs[k].set(F[k][0], F[k][0] / F[k][1]);
        br = brF(t); fry = fryF(t); jit = jitF(t); saw = sawF(t); rat = ratF(t);
        f0 = Math.max(20, f0F(t) * (1 + jit * jn(t) + jit * 0.5 * jn2(t)) * (1 + vib[1] * Math.sin(TAU * vib[0] * t)));
      }
      const dt = f0 / sr;
      ph += dt;
      if (ph >= 1) {
        ph -= 1; cyc++;
        ca = (1 - 0.15 * this.rnd() * (0.3 + jit * 5)) * (cyc & 1 ? 1 - fry * (0.4 + 0.6 * this.rnd()) : 1);
      }
      const flow = ph < Tp ? 0.5 * (1 - Math.cos((Math.PI * ph) / Tp)) : ph < Tp + Tn ? Math.cos((Math.PI * (ph - Tp)) / (2 * Tn)) : 0;
      let src = ((flow - prev) * sr) / (f0 * 6);
      prev = flow;
      if (saw) src -= saw * 0.6 * (2 * ph - 1 - blep(ph, dt));
      src *= ca;
      const x = tilt.tick(src) + this.wn() * br * (0.35 + 0.65 * flow);
      let y = 0;
      for (let k = 0; k < bqs.length; k++) y += bqs[k].tick(x) * F[k][2];
      if (rat) { rph += (rHz * (1 + 0.3 * rn(t))) / sr; y *= 1 - rat * (0.5 + 0.5 * Math.sin(TAU * rph)); }
      out[i] = y * envF(t);
    }
    norm(out);
    for (let i = 0; i < n; i++) { const d = drF(i / sr); if (d > 0.05) out[i] = Math.tanh(out[i] * d) / Math.tanh(d); }
    return norm(out);
  }
}

// ---------------------------------------------------------------------------------------------
// Sound generators

const GUN = {
  ak47: { dur: 1.3, f0: 210, f1: 62, fTau: 0.02, thTau: 0.055, thG: 0.25, bF0: 6000, bF1: 900, bFt: 0.04, bTau: 0.05, bPeak: 600, bPeakDb: 6, bodyG: 2.0, snapF: 1500, snapTau: 0.012, snapG: 0.8, crackHP: 1800, crackTau: 0.002, crackG: 0.7, mechF: 2600, mechT: 0.035, mechG: 0.12, drive: 2.4, tailLP: 900, tailTau: 0.45, tailG: 0.14, echoes: [[0.075, 0.3], [0.15, 0.2], [0.26, 0.12], [0.4, 0.06]] },
  m4a1: { dur: 1.0, f0: 260, f1: 80, fTau: 0.015, thTau: 0.04, thG: 0.2, bF0: 8500, bF1: 1500, bFt: 0.03, bTau: 0.035, bPeak: 1200, bPeakDb: 5, bodyG: 1.8, snapF: 2300, snapTau: 0.009, snapG: 0.9, crackHP: 2500, crackTau: 0.0015, crackG: 0.9, mechF: 3400, mechT: 0.028, mechG: 0.14, drive: 2.0, tailLP: 1100, tailTau: 0.32, tailG: 0.11, echoes: [[0.07, 0.26], [0.13, 0.16], [0.22, 0.09]] },
  mg3: { dur: 0.9, f0: 200, f1: 58, fTau: 0.018, thTau: 0.045, thG: 0.3, bF0: 6500, bF1: 1000, bFt: 0.025, bTau: 0.03, bPeak: 750, bPeakDb: 6, bodyG: 2.1, snapF: 1300, snapTau: 0.01, snapG: 0.85, crackHP: 2000, crackTau: 0.0018, crackG: 0.85, mechF: 2200, mechT: 0.022, mechG: 0.2, drive: 2.8, tailLP: 800, tailTau: 0.3, tailG: 0.12, echoes: [[0.08, 0.24], [0.16, 0.14], [0.27, 0.07]] },
  deagle: { dur: 1.8, f0: 180, f1: 50, fTau: 0.03, thTau: 0.09, thG: 0.38, bF0: 5000, bF1: 700, bFt: 0.06, bTau: 0.075, bPeak: 450, bPeakDb: 7, bodyG: 2.2, snapF: 1100, snapTau: 0.016, snapG: 0.8, crackHP: 1600, crackTau: 0.0025, crackG: 0.8, mechF: 2000, mechT: 0.045, mechG: 0.15, drive: 3.0, tailLP: 750, tailTau: 0.65, tailG: 0.18, echoes: [[0.09, 0.36], [0.18, 0.24], [0.31, 0.15], [0.48, 0.08], [0.7, 0.04]] },
};

// transient click + N-wave + filtered noise body + pitch-dropping thump + action clack, saturated,
// with brown-noise outdoor tail and lowpassed slapback echoes (stereo-decorrelated)
function gunshot(S, P) {
  const sr = S.sr, J = (x, a) => S.J(x, a ?? 0.06), dd = 0.32;
  const dry = S.buf(dd);
  const crack = S.noise({ dur: 0.03, type: 'highpass', f: J(P.crackHP), q: 0.7, env: (t) => Math.exp(-t / J(P.crackTau)) });
  const nw = Math.max(2, Math.round(sr * 0.0004));
  for (let i = 0; i < nw; i++) crack[i] += 1.1 * (1 - (2 * i) / nw);
  const bF0 = J(P.bF0), bF1 = J(P.bF1), bT = J(P.bTau);
  const body = S.noise({
    dur: dd, color: 'white', type: 'lowpass', f: (t) => bF1 + (bF0 - bF1) * Math.exp(-t / P.bFt), q: 0.9,
    type2: 'highpass', f2: 150, q2: 0.6, eq: [['peak', J(P.bPeak), 1.1, P.bPeakDb]],
    env: (t) => (1 - Math.exp(-t / 0.0004)) * (Math.exp(-t / bT) + 0.12 * Math.exp(-t / (bT * 4))),
  });
  const th = S.thud({ dur: dd, f0: J(P.f0), f1: J(P.f1), ptau: P.fTau, tau: J(P.thTau), drive: 1.6 });
  const snap = S.noise({ dur: 0.12, type: 'bandpass', f: J(P.snapF, 0.1), q: 0.8, env: (t) => att(t, 0.0003) * Math.exp(-t / J(P.snapTau)) });
  S.add(dry, crack, 0, P.crackG); S.add(dry, body, 0, P.bodyG); S.add(dry, th, 0, P.thG); S.add(dry, snap, 0, P.snapG);
  S.add(dry, S.mclick(J(P.mechF), 0.01), J(P.mechT, 0.1), P.mechG);
  const tk = Math.tanh(P.drive);
  for (let i = 0; i < dry.length; i++) dry[i] = Math.tanh(dry[i] * P.drive) / tk;
  norm(dry);
  const n = S.n(P.dur), L = new Float32Array(n), R = new Float32Array(n), tt = J(P.tailTau, 0.1);
  S.add(L, dry); S.add(R, dry);
  for (const ch of [L, R]) {
    const tail = S.noise({ dur: P.dur, color: 'brown', type: 'lowpass', f: (t) => 140 + P.tailLP / (1 + t * 3), q: 0.6, env: (t) => (1 - Math.exp(-t / 0.012)) * Math.exp(-t / tt) });
    S.add(ch, tail, 0.002, P.tailG);
  }
  const es = dry.slice(); S.filt(es, 'lowpass', 2600, 0.6); S.filt(es, 'highpass', 160, 0.6);
  P.echoes.forEach(([d, g], j) => {
    const e = es.slice(); S.filt(e, 'lowpass', 2400 / (1 + j * 0.7), 0.5);
    S.add(L, e, J(d, 0.12), g * S.rr(0.7, 1.1));
    S.add(R, e, J(d, 0.12) + S.rr(0.004, 0.018), g * S.rr(0.7, 1.1));
  });
  return [L, R];
}

function explosion(S) {
  const dur = 4.5, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
  const dry = S.buf(1.6);
  S.add(dry, S.noise({ dur: 0.08, type: 'highpass', f: 700, env: (t) => Math.exp(-t / 0.008) }), 0, 0.8);
  S.add(dry, S.noise({ dur: 1.6, color: 'pink', type: 'lowpass', f: (t) => 180 + 5200 * Math.exp(-t / 0.16), q: 0.8, env: (t) => att(t, 0.002) * (Math.exp(-t / 0.3) + 0.2 * Math.exp(-t / 0.9)) }), 0, 1);
  S.add(dry, S.noise({ dur: 1.2, type: 'lowpass', f: (t) => 400 + 7000 * Math.exp(-t / 0.08), type2: 'highpass', f2: 200, eq: [['peak', 900, 1, 5]], env: (t) => att(t, 0.001) * Math.exp(-t / 0.12) }), 0, 1.6);
  S.add(dry, S.thud({ dur: 1.5, f0: S.J(115), f1: 40, ptau: 0.09, tau: 0.4, drive: 2.2 }), 0, 0.55);
  for (let i = 0; i < dry.length; i++) dry[i] = Math.tanh(dry[i] * 2);
  norm(dry);
  const es = dry.slice(); S.filt(es, 'lowpass', 900, 0.6);
  [L, R].forEach((ch, j) => {
    S.add(ch, dry);
    S.add(ch, S.noise({ dur, color: 'brown', type: 'lowpass', f: (t) => 110 + 260 * Math.exp(-t / 0.6), q: 0.7, env: (t) => att(t, 0.04) * Math.exp(-t / 1.25) }), 0.01, 0.6);
    S.add(ch, S.grains({ dur: 2.6, count: 70, fLo: 1200, fHi: 6500, q: 3, gdur: 0.008, dens: (u) => Math.exp(-u * 3) }), 0.12 + j * 0.01, 0.22);
    S.add(ch, S.noise({ dur: 2.5, color: 'pink', type: 'highpass', f: 1800, env: (t) => att(t, 0.3) * Math.exp(-t / 0.7) }), 0.2, 0.08);
    S.add(ch, es, S.rr(0.22, 0.3), 0.3); S.add(ch, es, S.rr(0.5, 0.65), 0.16);
  });
  return [L, R];
}

function flesh(S) {
  const o = S.buf(0.35);
  S.add(o, S.noise({ dur: 0.15, color: 'pink', type: 'bandpass', f: S.J(420, 0.15), q: 1.5, env: (t) => att(t, 0.001) * Math.exp(-t / 0.025) }), 0, 1);
  S.add(o, S.thud({ f0: S.J(115), f1: 60, tau: 0.05, att: 0.001 }), 0, 0.8);
  S.add(o, S.noise({ dur: 0.12, type: 'bandpass', f: (t) => 900 * Math.pow(0.33, t / 0.12), q: 4, env: (t) => win(t / 0.12) }), 0.015, 0.4);
  S.add(o, S.click({ f: 1200, q: 1, tau: 0.002 }), 0, 0.3);
  return o;
}

function brass(S, f, dur, { a = 0.035, rel = 0.25, bright = 7, vibAt = 0.35 } = {}) {
  const sr = S.sr, n = S.n(dur + rel), out = new Float32Array(n), bq = new BQ(sr, 'lowpass', f * 2, 0.9);
  const ph = [S.rnd(), S.rnd(), S.rnd()], det = [1, semi(0.07), semi(-0.06)];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ae = t < a ? t / a : t < dur ? 1 - 0.25 * sstep(a, a + 0.25, t) : 0.75 * Math.exp(-(t - dur) / (rel * 0.35));
    const fe = t < a ? t / a : Math.exp(-(t - a) / 0.18) * 0.7 + 0.3 * (t < dur ? 1 : Math.exp(-(t - dur) / 0.1));
    const vb = 1 + 0.004 * sstep(vibAt, vibAt + 0.3, t) * Math.sin(TAU * 5.2 * t);
    let s = 0;
    for (let j = 0; j < 3; j++) { const dt = (f * det[j] * vb) / sr; ph[j] += dt; if (ph[j] >= 1) ph[j] -= 1; s += 2 * ph[j] - 1 - blep(ph[j], dt); }
    if ((i & 15) === 0) bq.set(f * (1.2 + bright * fe), 0.8);
    out[i] = bq.tick(s) * ae;
  }
  return norm(out);
}

function zGrowl(S, k) {
  const dur = S.rr(1.1, 1.7), base = S.rr(58, 82) * (k % 2 ? 1.1 : 1);
  const A = vf(['u', 'a', 'o', 'u'][k % 4], 0.72, 2.0), B = vf(['a', 'o', 'a', 'oo'][k % 4], 0.7, 2.2);
  const contour = k % 2 ? (u) => 1 + 0.35 * Math.sin(Math.PI * u) : (u) => 1.25 - 0.4 * u + 0.1 * Math.sin(TAU * 2 * u);
  const envG = (t) => att(t, 0.12) * (1 - sstep(dur - 0.35, dur, t)) * (0.8 + 0.2 * Math.sin(TAU * 3 * t));
  const v = S.voice(dur, {
    f0: (t) => base * contour(t / dur), form: (t) => vmix(A, B, Math.sin((Math.PI * t) / dur)),
    breath: 0.55, fry: 0.75, jit: 0.07, saw: 0.35, drive: 3, tilt: 2600, rattle: 0.5, rattleHz: S.rr(22, 34), env: envG,
  });
  const rat = S.noise({ dur, color: 'brown', type: 'bandpass', f: 320, q: 1.4, env: (t) => envG(t) * Math.pow(0.5 + 0.5 * Math.sin(TAU * 27 * t), 2) });
  const out = new Float32Array(v.length);
  S.add(out, v, 0, 1); S.add(out, rat, 0, 0.3);
  S.filt(out, 'lowshelf', 160, 0.7, 4); S.filt(out, 'highshelf', 3200, 0.7, -5);
  return out;
}

// control-rate table of fn(t) (every K samples), linearly interpolated: cheap per-sample envelopes
function ctl(sr, dur, fn, K = 64) {
  const m = Math.ceil((dur * sr) / K) + 2, v = new Float32Array(m);
  for (let j = 0; j < m; j++) v[j] = fn((j * K) / sr);
  const s = sr / K;
  return (t) => { const x = t * s, j = Math.min(x | 0, m - 2), f = x - j; return v[j] + (v[j + 1] - v[j]) * f; };
}

// wind bed: gust envelope with integer cycles per loop (periodic) + crossfaded noise => seamless 12 s loop
function ambBed(S) {
  const Lp = 12, X = 1.5, sr = S.sr, nL = Math.round(Lp * sr), w = TAU / Lp, D = Lp + X;
  const ph = [0, 1, 2, 3, 4].map(() => S.rnd() * TAU);
  const G = (t) => clamp(0.55 + 0.2 * Math.sin(w * t + ph[0]) + 0.13 * Math.sin(2 * w * t + ph[1]) + 0.08 * Math.sin(3 * w * t + ph[2]) + 0.05 * Math.sin(7 * w * t + ph[3]) + 0.035 * Math.sin(13 * w * t + ph[4]), 0.12, 1.2);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const cp = S.rnd() * TAU, Gc = (t) => G(t) * (1 + 0.08 * Math.sin(5 * w * t + cp));
    const e1 = ctl(sr, D, (t) => Gc(t) ** 1.3), e2 = ctl(sr, D, (t) => Gc(t) ** 2), e3 = ctl(sr, D, (t) => Math.max(0, Gc(t) - 0.5) ** 1.5), e4 = ctl(sr, D, (t) => Gc(t) ** 2.5);
    const g1 = ctl(sr, D, Gc), wf = ctl(sr, D, (t) => 620 + 420 * Gc(t) + 40 * Math.sin(3 * w * t + cp));
    const o = new Float32Array(nL + Math.round(X * sr));
    S.add(o, S.noise({ dur: D, color: 'brown', type: 'lowpass', f: (t) => 220 + 900 * g1(t) ** 2, q: 0.5, type2: 'highpass', f2: 55, q2: 0.6, env: e1 }), 0, 1);
    S.add(o, S.noise({ dur: D, color: 'pink', type: 'bandpass', f: (t) => 450 + 650 * g1(t), q: 0.8, env: e2 }), 0, 0.35);
    S.add(o, S.noise({ dur: D, type: 'bandpass', f: wf, q: 28, env: e3 }), 0, 0.22);
    S.add(o, S.noise({ dur: D, type: 'highpass', f: 3500, env: e4 }), 0, 0.06);
    chans.push(loopify(o, nL));
  }
  return chans;
}

// periodic (integer cycles per loop) tonal part rendered with warm-up so filters are in steady state
function periodicPart(S, Lp, fill, post) {
  const sr = S.sr, nL = Math.round(Lp * sr), nW = nL, a = new Float32Array(nW + nL);
  fill(a);
  post(a);
  return norm(a.slice(nW));
}
function sawBank(a, sr, parts) {
  for (const [f, g, type] of parts) {
    const dt = f / sr; let ph = 0;
    for (let i = 0; i < a.length; i++) { ph += dt; if (ph >= 1) ph -= 1; a[i] += g * oscv(type || 'saw', ph, dt); }
  }
}

function shieldLoop(S) {
  const Lp = 2, sr = S.sr, nL = Math.round(Lp * sr), X = 0.25;
  const hum = periodicPart(S, Lp, (a) => sawBank(a, sr, [[100, 1], [100.5, 0.8], [200, 0.35], [300, 0.2], [50, 0.4, 'sine']]), (a) => {
    S.filt(a, 'lowpass', 900, 0.8); S.filt(a, 'peak', 400, 2, 6);
    for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] *= 0.75 + 0.15 * Math.sin(TAU * 0.5 * t) + 0.1 * Math.sin(TAU * 3 * t); }
  });
  const nz = new Float32Array(nL + Math.round(X * sr));
  S.add(nz, S.crackle({ dur: Lp + X, rate: (t) => 60 + 40 * Math.sin(TAU * t) }), 0, 0.6);
  S.add(nz, S.noise({ dur: Lp + X, type: 'bandpass', f: 3000, q: 0.8 }), 0, 0.15);
  const out = new Float32Array(nL);
  S.add(out, hum, 0, 1); S.add(out, loopify(nz, nL), 0, 0.3);
  return out;
}

function electricLoop(S) {
  const Lp = 2, sr = S.sr, nL = Math.round(Lp * sr), X = 0.25;
  const buzz = periodicPart(S, Lp, (a) => sawBank(a, sr, [[60, 1, 'square'], [120, 0.5], [180, 0.25, 'square']]), (a) => {
    S.filt(a, 'bandpass', 700, 0.7);
    for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] *= 0.55 + 0.3 * Math.sin(TAU * 1.5 * t) + 0.15 * Math.sin(TAU * 6.5 * t); }
  });
  const nz = new Float32Array(nL + Math.round(X * sr));
  S.add(nz, S.crackle({ dur: Lp + X, rate: (t) => 150 + 2500 * Math.pow(Math.max(0, Math.sin(TAU * 2.5 * t)), 4) }), 0, 1);
  const sz = S.vn(30, Lp + X + 0.1);
  S.add(nz, S.noise({ dur: Lp + X, type: 'highpass', f: 4000, env: (t) => 0.3 + 0.7 * Math.abs(sz(t)) }), 0, 0.2);
  const out = new Float32Array(nL);
  S.add(out, loopify(nz, nL), 0, 1); S.add(out, buzz, 0, 0.45);
  return out;
}

const G = {
  // ----- weapons
  shot_ak47: (S) => gunshot(S, GUN.ak47),
  shot_m4a1: (S) => gunshot(S, GUN.m4a1),
  shot_mg3: (S) => gunshot(S, GUN.mg3),
  shot_deagle: (S) => gunshot(S, GUN.deagle),
  dryfire: (S) => {
    const o = S.buf(0.2);
    S.add(o, S.mclick(2600), 0, 0.8); S.add(o, S.mclick(4200), 0.035, 0.5); S.add(o, S.thud({ f0: 420, f1: 300, tau: 0.01 }), 0.035, 0.2);
    return o;
  },
  reload_rifle: (S) => {
    const o = S.buf(2.4);
    S.add(o, S.mclick(3200), 0.08, 0.45);
    S.add(o, S.scrape({ dur: 0.16, f0: 1600, f1: 2400, q: 3 }), 0.2, 0.3);
    S.add(o, S.thud({ f0: 320, f1: 220, tau: 0.02 }), 0.34, 0.25);
    S.add(o, S.noise({ dur: 0.5, color: 'pink', type: 'bandpass', f: 1100, q: 0.8, env: (t) => win(t / 0.5) }), 0.42, 0.08);
    S.add(o, S.scrape({ dur: 0.12, f0: 2600, f1: 1900, q: 3 }), 1.0, 0.28);
    S.add(o, S.thud({ f0: 190, f1: 120, tau: 0.03 }), 1.12, 0.7);
    S.add(o, S.mclick(2400), 1.12, 0.6);
    S.add(o, S.ring({ partials: [[1400, 1, 0.03], [2300, 0.7, 0.025], [3700, 0.4, 0.02]] }), 1.12, 0.25);
    S.add(o, S.mclick(2800), 1.68, 0.45);
    S.add(o, S.scrape({ dur: 0.14, f0: 1500, f1: 3200, q: 4 }), 1.7, 0.35);
    S.add(o, S.tone({ dur: 0.14, f: (t) => 820 + 600 * t, type: 'saw', lp: 2000, env: (t) => win(t / 0.14) }), 1.7, 0.06);
    S.add(o, S.mclick(2000, 0.02), 1.92, 0.9);
    S.add(o, S.thud({ f0: 260, f1: 160, tau: 0.025 }), 1.92, 0.55);
    S.add(o, S.ring({ partials: [[1700, 1, 0.06], [2900, 0.7, 0.045], [4400, 0.5, 0.03], [6100, 0.3, 0.02]] }), 1.921, 0.35);
    return o;
  },
  reload_mg: (S) => {
    const o = S.buf(4.2);
    S.add(o, S.mclick(2600), 0.15, 0.5);
    S.add(o, S.creak({ dur: 0.22, f: (u) => 650 + 250 * u, res: [[1300, 6, 1], [2600, 7, 0.4]], irr: 0.08, env: win }), 0.3, 0.2);
    S.add(o, S.thud({ f0: 220, f1: 150, tau: 0.035 }), 0.5, 0.5);
    S.add(o, S.ring({ partials: [[900, 1, 0.06], [1600, 0.7, 0.045], [2500, 0.4, 0.03]] }), 0.5, 0.3);
    S.add(o, S.grains({ dur: 0.8, count: 24, fLo: 2500, fHi: 6000, q: 8, gdur: 0.006, dens: (u) => 0.4 + 0.6 * win(u) }), 0.8, 0.45);
    S.add(o, S.noise({ dur: 0.8, color: 'pink', type: 'bandpass', f: 900, q: 0.8, env: (t) => win(t / 0.8) }), 0.8, 0.08);
    S.add(o, S.thud({ f0: 200, f1: 140, tau: 0.03 }), 1.75, 0.6); S.add(o, S.mclick(2200), 1.75, 0.5);
    S.add(o, S.thud({ f0: 160, f1: 100, tau: 0.05, drive: 1.5 }), 2.5, 1.0); S.add(o, S.mclick(1800, 0.02), 2.5, 0.9);
    S.add(o, S.ring({ partials: [[700, 1, 0.08], [1250, 0.7, 0.06], [2100, 0.5, 0.045], [3300, 0.3, 0.03]] }), 2.501, 0.45);
    S.add(o, S.scrape({ dur: 0.2, f0: 1200, f1: 2600, q: 4 }), 3.2, 0.4); S.add(o, S.mclick(2400), 3.2, 0.4);
    S.add(o, S.mclick(1900, 0.02), 3.5, 0.9); S.add(o, S.thud({ f0: 220, f1: 150, tau: 0.03 }), 3.5, 0.6);
    S.add(o, S.ring({ partials: [[1500, 1, 0.05], [2600, 0.6, 0.04], [3900, 0.4, 0.03]] }), 3.501, 0.3);
    return o;
  },
  reload_pistol: (S) => {
    const o = S.buf(1.8);
    S.add(o, S.mclick(3600), 0.08, 0.5);
    S.add(o, S.scrape({ dur: 0.12, f0: 2400, f1: 2900, q: 3 }), 0.16, 0.3);
    S.add(o, S.scrape({ dur: 0.08, f0: 2900, f1: 2300, q: 3 }), 0.75, 0.3);
    S.add(o, S.thud({ f0: 240, f1: 170, tau: 0.025 }), 0.84, 0.6); S.add(o, S.mclick(2800), 0.84, 0.6);
    S.add(o, S.scrape({ dur: 0.1, f0: 1800, f1: 3200, q: 4 }), 1.25, 0.35);
    S.add(o, S.mclick(2400, 0.018), 1.42, 0.9);
    S.add(o, S.ring({ partials: [[2100, 1, 0.04], [3500, 0.7, 0.03], [5200, 0.4, 0.02]] }), 1.421, 0.4);
    S.add(o, S.thud({ f0: 300, f1: 200, tau: 0.02 }), 1.42, 0.4);
    return o;
  },
  draw: (S) => {
    const o = S.buf(0.6);
    S.add(o, S.whoosh({ dur: 0.3, f: [800, 1600, 1000], q: 0.8, peak: 0.4 }), 0, 0.35);
    S.add(o, S.mclick(S.rr(2500, 3500)), 0.12, 0.45); S.add(o, S.mclick(S.rr(3000, 4200)), 0.17, 0.35); S.add(o, S.mclick(S.rr(2000, 3000)), 0.21, 0.3);
    S.add(o, S.mclick(2200, 0.018), 0.34, 0.8); S.add(o, S.thud({ f0: 300, f1: 200, tau: 0.02 }), 0.34, 0.3);
    return o;
  },
  knife_slash: (S) => {
    const dur = S.rr(0.3, 0.38), o = S.buf(dur);
    S.add(o, S.whoosh({ dur, f: [S.J(500), S.J(2400), S.J(800)], q: 1.8, peak: S.rr(0.35, 0.45) }), 0, 1);
    S.add(o, S.noise({ dur, type: 'highpass', f: 5000, env: (t) => Math.pow(win(t / dur), 4) }), 0, 0.15);
    return o;
  },
  knife_stab: (S) => {
    const o = S.buf(0.45);
    S.add(o, S.whoosh({ dur: 0.18, f: [400, 1600, 700], q: 1.2, peak: 0.6 }), 0, 0.8);
    S.add(o, S.thud({ f0: 140, f1: 80, tau: 0.05 }), 0.13, 0.7);
    S.add(o, S.noise({ dur: 0.12, type: 'bandpass', f: 1500, q: 1, env: (t) => Math.exp(-t / 0.03) }), 0.13, 0.3);
    return o;
  },
  knife_hit_wall: (S) => {
    const o = S.buf(0.6), b = S.rr(2600, 3200);
    S.add(o, S.ring({ partials: [[b, 1, 0.2], [b * 1.48, 0.8, 0.15], [b * 2.13, 0.6, 0.1], [b * 2.9, 0.4, 0.07]], strike: 0.5 }), 0, 1);
    S.add(o, S.noise({ dur: 0.08, type: 'highpass', f: 3000, env: (t) => win(t / 0.08) }), 0.01, 0.2);
    return o;
  },
  knife_hit_flesh: (S) => {
    const o = S.buf(0.45);
    S.add(o, S.noise({ dur: 0.12, type: 'bandpass', f: 1500, q: 1, env: (t) => Math.exp(-t / 0.03) }), 0, 0.5);
    S.add(o, flesh(S), 0.01, 0.9);
    S.add(o, S.noise({ dur: 0.15, color: 'pink', type: 'bandpass', f: (t) => 700 * Math.pow(0.35, t / 0.15), q: 3, env: (t) => win(t / 0.15) }), 0.03, 0.35);
    return o;
  },
  grenade_pin: (S) => {
    const o = S.buf(0.75);
    S.add(o, S.scrape({ dur: 0.07, f0: 3000, f1: 5000, q: 2 }), 0, 0.3);
    S.add(o, S.ring({ partials: [[4200, 1, 0.1], [6150, 0.7, 0.07], [8300, 0.4, 0.05]], strike: 0.4 }), 0.05, 0.5);
    S.add(o, S.mclick(2600), 0.35, 0.6);
    S.add(o, S.ring({ partials: [[2650, 1, 0.14], [3900, 0.7, 0.1], [5400, 0.4, 0.07]] }), 0.36, 0.45);
    return o;
  },
  grenade_throw: (S) => {
    const o = S.buf(0.45);
    S.add(o, S.whoosh({ dur: 0.4, f: [300, 1100, 500], q: 1.2, peak: 0.4 }), 0, 1);
    S.add(o, S.noise({ dur: 0.3, color: 'pink', type: 'bandpass', f: 900, q: 0.8, env: (t) => win(t / 0.3) }), 0, 0.25);
    return o;
  },
  grenade_bounce: (S) => {
    const o = S.buf(0.35), b = S.rr(600, 700);
    S.add(o, S.thud({ f0: S.J(230), f1: 150, tau: 0.04 }), 0, 0.8);
    S.add(o, S.ring({ partials: [[b, 1, 0.05], [b * 1.77, 0.6, 0.035], [b * 2.8, 0.4, 0.025]] }), 0, 0.5);
    S.add(o, S.grains({ dur: 0.15, count: 6, fLo: 1200, fHi: 4000, q: 1.5, gdur: 0.004 }), 0.005, 0.25);
    return o;
  },
  explosion,
  shell_casing: (S) => {
    const o = S.buf(0.7), b = S.rr(3000, 3900), nb = S.ri(3, 5);
    let t = 0, a = 1;
    for (let j = 0; j < nb; j++) {
      const f = b * S.rr(0.97, 1.03);
      S.add(o, S.ring({ partials: [[f, 1, 0.05 * a + 0.015], [f * 1.73, 0.7, 0.035 * a + 0.01], [f * 2.61, 0.5, 0.025 * a + 0.008], [f * 3.4, 0.3, 0.018]], strike: 0.3, strikeF: 6000 }), t, a);
      t += S.rr(0.07, 0.13) * (1 - j * 0.15); a *= S.rr(0.45, 0.65);
    }
    return o;
  },
  bullet_impact_wood: (S) => {
    const o = S.buf(0.4);
    S.add(o, S.click({ f: S.J(2500), q: 0.8, tau: 0.002 }), 0, 0.8);
    S.add(o, S.noise({ dur: 0.2, type: 'bandpass', f: S.J(700, 0.15), q: 3, env: (t) => Math.exp(-t / 0.03) }), 0, 1);
    S.add(o, S.thud({ f0: 300, f1: 180, tau: 0.02 }), 0, 0.5);
    S.add(o, S.grains({ dur: 0.18, count: 12, fLo: 2000, fHi: 5500, q: 3, gdur: 0.004, dens: (u) => Math.exp(-u * 2.5) }), 0.005, 0.3);
    return o;
  },
  bullet_impact_dirt: (S) => {
    const o = S.buf(0.5);
    S.add(o, S.thud({ f0: S.J(160), f1: 90, tau: 0.04 }), 0, 0.8);
    S.add(o, S.noise({ dur: 0.25, color: 'pink', type: 'lowpass', f: S.J(1500), env: (t) => att(t, 0.001) * Math.exp(-t / 0.05) }), 0, 0.7);
    S.add(o, S.grains({ dur: 0.4, count: 30, fLo: 800, fHi: 3500, q: 2, gdur: 0.005, dens: (u) => Math.exp(-u * 3) }), 0.01, 0.45);
    S.add(o, S.click({ f: 3500, q: 1, tau: 0.0015 }), 0, 0.35);
    return o;
  },
  bullet_impact_metal: (S, k) => {
    const o = S.buf(k === 2 ? 0.8 : 0.6), b = S.rr(1700, 2400);
    S.add(o, S.click({ f: 5000, q: 1, tau: 0.0015 }), 0, 0.6);
    S.add(o, S.ring({ partials: [[b, 1, 0.22], [b * 1.59, 0.8, 0.16], [b * 2.31, 0.6, 0.11], [b * 3.07, 0.4, 0.07], [b * 4.2, 0.25, 0.045]] }), 0, 1);
    if (k === 2) {
      const d = 0.55, rf = (t) => 3600 * Math.pow(0.5, t / d);
      S.add(o, S.tone({ dur: d, f: rf, vib: [28, 0.03], env: (t) => att(t, 0.02) * Math.pow(1 - t / d, 1.5) }), 0.02, 0.35);
      S.add(o, S.noise({ dur: d, type: 'bandpass', f: rf, q: 3, env: (t) => att(t, 0.02) * Math.pow(1 - t / d, 2) }), 0.02, 0.2);
    }
    return o;
  },
  bullet_flesh: flesh,
  headshot: (S) => {
    const o = S.buf(0.7);
    const cr = S.noise({ dur: 0.06, type: 'bandpass', f: 2200, q: 0.7, env: (t) => Math.exp(-t / 0.014) });
    for (let i = 0; i < cr.length; i++) cr[i] = Math.round(cr[i - (i % 7)] * 6) / 6;
    S.add(o, cr, 0, 0.7);
    S.add(o, S.ring({ partials: [[1760, 1, 0.35], [2665, 0.8, 0.28], [3920, 0.6, 0.2], [5230, 0.35, 0.12], [7100, 0.2, 0.08]], strike: 0.3, strikeF: 5000 }), 0, 1);
    S.add(o, S.thud({ f0: 200, f1: 90, tau: 0.04 }), 0, 0.6);
    return o;
  },
  whizz: (S) => {
    const dur = S.rr(0.28, 0.38), pk = S.rr(0.4, 0.5);
    const fc = (t) => 1400 + 3200 / (1 + Math.exp((t / dur - pk) * 14));
    const ev = (t) => { const u = t / dur; return u < pk ? Math.pow(u / pk, 2) : Math.pow(Math.max(0, 1 - (u - pk) / (1 - pk)), 1.5); };
    const o = S.buf(dur);
    S.add(o, S.noise({ dur, type: 'bandpass', f: fc, q: 2.5, env: ev }), 0, 1);
    S.add(o, S.tone({ dur, f: (t) => fc(t) * 0.9, env: (t) => ev(t) ** 2 }), 0, 0.25);
    return o;
  },
  hitmarker: (S) => {
    const o = S.buf(0.07);
    S.add(o, S.click({ f: 3200, q: 4, tau: 0.003 }), 0, 1);
    S.add(o, S.tone({ dur: 0.05, f: 2400, env: (t) => Math.exp(-t / 0.01) }), 0, 0.5);
    return o;
  },
  kill_confirm: (S) => {
    const o = S.buf(0.5);
    S.add(o, S.thud({ f0: 130, f1: 60, tau: 0.07 }), 0, 0.7);
    S.add(o, S.tone({ dur: 0.4, f: 1318.5, type: 'tri', env: (t) => att(t, 0.003) * Math.exp(-t / 0.12) }), 0, 0.45);
    S.add(o, S.tone({ dur: 0.42, f: 1975.5, type: 'tri', env: (t) => att(t, 0.003) * Math.exp(-t / 0.2) }), 0.07, 0.45);
    S.add(o, S.click({ f: 3000, q: 1.5, tau: 0.002 }), 0, 0.3);
    return o;
  },
  // ----- movement
  step_dirt: (S) => {
    const o = S.buf(0.28);
    S.add(o, S.thud({ f0: S.J(95), f1: 60, tau: 0.03, att: 0.002 }), 0, 0.5);
    S.add(o, S.noise({ dur: 0.14, color: 'pink', type: 'lowpass', f: S.J(1300), env: (t) => att(t, 0.003) * Math.exp(-t / 0.03) }), 0, 0.55);
    S.add(o, S.grains({ dur: 0.16, count: S.ri(10, 18), fLo: 1200, fHi: 5000, q: 1.5, gdur: 0.004, dens: (u) => Math.exp(-u * 3) }), 0.005, 0.7);
    S.add(o, S.grains({ dur: 0.1, count: 6, fLo: 1500, fHi: 4000, q: 1.2, gdur: 0.004, dens: (u) => Math.exp(-u * 2) }), 0.06, 0.35);
    return o;
  },
  step_wood: (S, k) => {
    const o = S.buf(0.35);
    S.add(o, S.thud({ f0: S.J(150), f1: 100, tau: 0.035, att: 0.001 }), 0, 1);
    S.add(o, S.noise({ dur: 0.3, type: 'bandpass', f: S.J(190), q: 6, env: (t) => Math.exp(-t / 0.06) }), 0, 0.55);
    S.add(o, S.noise({ dur: 0.25, type: 'bandpass', f: S.J(430), q: 5, env: (t) => Math.exp(-t / 0.04) }), 0, 0.35);
    S.add(o, S.click({ f: S.J(1800), q: 1.5, tau: 0.002 }), 0, 0.3);
    if (k === 3) S.add(o, S.creak({ dur: 0.25, f: (u) => 90 + 60 * u, res: [[520, 8, 1], [1100, 9, 0.5]], irr: 0.2, env: win }), 0.05, 0.25);
    return o;
  },
  step_metal: (S) => {
    const o = S.buf(0.5), b = S.rr(420, 560);
    S.add(o, S.thud({ f0: 220, f1: 160, tau: 0.025 }), 0, 0.5);
    S.add(o, S.ring({ partials: [[b, 1, 0.12], [b * 2.43, 0.7, 0.08], [b * 3.81, 0.5, 0.06], [b * 5.9, 0.3, 0.04]] }), 0, 0.6);
    S.add(o, S.click({ f: 3000, q: 1.2, tau: 0.002 }), 0, 0.4);
    return o;
  },
  jump: (S) => {
    const o = S.buf(0.4);
    S.add(o, S.grains({ dur: 0.1, count: 8, fLo: 1000, fHi: 4000, q: 1.5, gdur: 0.004 }), 0, 0.4);
    S.add(o, S.thud({ f0: 90, f1: 60, tau: 0.03 }), 0, 0.35);
    S.add(o, S.whoosh({ dur: 0.3, f: [700, 1300, 900], q: 0.8, peak: 0.35 }), 0.02, 0.45);
    S.add(o, S.grains({ dur: 0.15, count: 5, fLo: 2500, fHi: 6000, q: 6, gdur: 0.005 }), 0.05, 0.25);
    return o;
  },
  land: (S) => {
    const o = S.buf(0.5);
    S.add(o, S.thud({ f0: 110, f1: 58, tau: 0.05, drive: 1.5, att: 0.002 }), 0, 0.75);
    S.add(o, S.noise({ dur: 0.25, color: 'pink', type: 'lowpass', f: 900, env: (t) => att(t, 0.003) * Math.exp(-t / 0.05) }), 0, 0.6);
    S.add(o, S.grains({ dur: 0.25, count: 25, fLo: 1000, fHi: 4500, q: 1.5, gdur: 0.004, dens: (u) => Math.exp(-u * 3) }), 0.004, 0.55);
    S.add(o, S.grains({ dur: 0.18, count: 8, fLo: 2500, fHi: 5500, q: 6, gdur: 0.005 }), 0.03, 0.3);
    return o;
  },
  ladder: (S) => {
    const o = S.buf(0.4), b = S.rr(300, 380);
    S.add(o, S.ring({ partials: [[b, 1, 0.08], [b * 2.7, 0.6, 0.05], [b * 4.4, 0.35, 0.03]] }), 0, 0.8);
    S.add(o, S.thud({ f0: 180, f1: 120, tau: 0.03 }), 0, 0.6);
    S.add(o, S.click({ f: 2000, q: 1.5, tau: 0.002 }), 0, 0.3);
    S.add(o, S.noise({ dur: 0.12, color: 'pink', type: 'bandpass', f: 1500, q: 0.8, env: (t) => win(t / 0.12) }), 0.03, 0.12);
    return o;
  },
  // ----- zombies
  zombie_growl: zGrowl,
  zombie_attack: (S, k) => {
    const o = S.buf(0.75), d = S.rr(0.45, 0.6), b = S.rr(95, 125);
    S.add(o, S.whoosh({ dur: 0.25, f: [800, 3000, 1200], q: 2, peak: 0.4 }), 0.05, 0.6);
    S.add(o, S.voice(d, { f0: (t) => b * (1.1 - (0.35 * t) / d), form: vf(['a', 'e', 'a'][k % 3], 0.8, 2), breath: 0.75, fry: 0.6, jit: 0.07, saw: 0.3, drive: 3.5, tilt: 3500, rattle: 0.4, rattleHz: 30, env: (t) => att(t, 0.025) * Math.pow(Math.max(0, 1 - t / d), 1.2) }), 0, 1);
    return o;
  },
  zombie_hit: (S) => {
    const o = S.buf(0.45);
    S.add(o, S.whoosh({ dur: 0.1, f: [1500, 3200, 2200], q: 1.5, peak: 0.7 }), 0, 0.35);
    S.add(o, S.noise({ dur: 0.1, type: 'bandpass', f: 2500, q: 1.5, env: (t) => Math.exp(-t / 0.02) }), 0.06, 0.55);
    S.add(o, flesh(S), 0.065, 0.9);
    S.add(o, S.scrape({ dur: 0.12, f0: 3000, f1: 2200, q: 0.8, grain: 0.9 }), 0.065, 0.35);
    return o;
  },
  zombie_pain: (S) => {
    const d = S.rr(0.4, 0.6), b = S.rr(85, 110);
    return S.voice(d, { f0: (t) => b * (1 + 0.6 * Math.sin(Math.PI * Math.min(1, (t / d) * 1.3))), form: (t) => vmix(vf('a', 0.78, 1.8), vf('u', 0.75, 1.8), t / d), breath: 0.55, fry: 0.5, jit: 0.06, saw: 0.3, drive: 3, tilt: 3000, rattle: 0.3, env: (t) => att(t, 0.02) * Math.pow(Math.max(0, 1 - t / d), 1.3) });
  },
  zombie_death: (S) => {
    const d = S.rr(1.5, 1.9), b = S.rr(95, 120), o = S.buf(d + 0.6), g = S.vn(11, d + 0.1);
    S.add(o, S.voice(d, { f0: (t) => b * Math.pow(0.42, t / d) * (1 + 0.04 * g(t)), form: (t) => vmix(vf('a', 0.75, 2), vf('oo', 0.75, 2.2), t / d), breath: 0.6, fry: (t) => 0.4 + (0.5 * t) / d, jit: 0.08, saw: 0.35, drive: 3, tilt: 2600, rattle: (t) => 0.3 + (0.4 * t) / d, rattleHz: 14, env: (t) => att(t, 0.04) * (1 - sstep(d * 0.5, d, t)) }), 0, 1);
    S.add(o, S.thud({ f0: 90, f1: 50, tau: 0.08, drive: 1.5 }), d - 0.15, 0.7);
    S.add(o, S.grains({ dur: 0.3, count: 14, fLo: 1000, fHi: 4000, q: 1.5, dens: (u) => Math.exp(-u * 3) }), d - 0.14, 0.35);
    return o;
  },
  zombie_respawn: (S) => {
    const dur = 2.3, T = 1.8, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
    [[L, 1], [R, -1]].forEach(([ch, d]) => {
      S.add(ch, S.noise({ dur: T, color: 'pink', type: 'bandpass', f: (t) => 200 * Math.pow(17, t / T), q: 2, env: (t) => Math.pow(t / T, 2.2) }), 0, 0.6);
      const tones = S.buf(T);
      for (const r of [1, 1.189, 1.414]) S.add(tones, S.tone({ dur: T, f: (t) => 220 * r * Math.pow(2, t / T) * semi(0.08 * d), vib: [5.5, 0.01], env: (t) => Math.pow(t / T, 1.5) }), 0, 0.33);
      S.add(ch, tones, 0, 0.35);
      S.add(ch, S.noise({ dur: 0.5, color: 'pink', type: 'lowpass', f: (t) => 3000 * Math.exp(-t / 0.1) + 200, env: (t) => Math.exp(-t / 0.15) }), T, 0.4);
    });
    const th = S.thud({ dur: 0.5, f0: 75, f1: 38, tau: 0.12, drive: 2 });
    S.add(L, th, T, 0.55); S.add(R, th, T, 0.55);
    return [L, R];
  },
  zombie_jump: (S) => {
    const o = S.buf(0.6);
    S.add(o, S.voice(0.3, { f0: (t) => 125 - 60 * t, form: vf('u', 0.8, 2), breath: 0.6, fry: 0.5, jit: 0.06, drive: 3, tilt: 3000, env: (t) => att(t, 0.015) * Math.pow(Math.max(0, 1 - t / 0.3), 1.5) }), 0, 0.7);
    S.add(o, S.whoosh({ dur: 0.45, f: [300, 1100, 600], q: 1, peak: 0.35 }), 0.02, 0.6);
    S.add(o, S.thud({ f0: 100, f1: 60, tau: 0.04 }), 0, 0.45);
    return o;
  },
  infect: (S) => {
    const dur = 2.7, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n), m = (t) => sstep(0.55, 1.35, t);
    const vo = S.voice(2.3, {
      f0: (t) => lerp(320 + 110 * sstep(0, 0.45, t), 76, m(t)), vib: [6.5, 0.025],
      form: (t) => vmix(vf('a', 1.18, 1.2, [1, 0.7, 0.4, 0.2]), vf('o', 0.66, 2.3), m(t)),
      breath: (t) => 0.25 + 0.4 * m(t), fry: (t) => 0.05 + 0.8 * m(t), jit: (t) => 0.02 + 0.08 * m(t), saw: (t) => 0.1 + 0.4 * m(t),
      drive: (t) => 2 + 2.5 * m(t), rattle: (t) => 0.5 * m(t), rattleHz: 26, tilt: 3500,
      env: (t) => att(t, 0.04) * (1 - sstep(1.9, 2.3, t)),
    });
    S.add(L, vo); S.add(R, vo);
    for (const ch of [L, R]) {
      S.add(ch, S.noise({ dur: 1.0, color: 'pink', type: 'bandpass', f: (t) => 300 * Math.pow(9, t), q: 1.5, env: (t) => Math.pow(t, 3) * (t < 0.95 ? 1 : Math.max(0, (1 - t) / 0.05)) }), 0.35, 0.55);
      S.add(ch, S.noise({ dur: 0.6, color: 'pink', type: 'lowpass', f: (t) => 250 + 3500 * Math.exp(-t / 0.06), env: (t) => Math.exp(-t / 0.12) }), 1.33, 0.4);
    }
    const b = S.thud({ dur: 1.2, f0: 85, f1: 40, ptau: 0.08, tau: 0.3, drive: 2.5 });
    S.add(L, b, 1.33, 0.9); S.add(R, b, 1.33, 0.9);
    return [L, R];
  },
  evolve: (S) => {
    const o = S.buf(1.9);
    const sw = S.tone({ dur: 1.3, f: (t) => 55 * (1 + 0.5 * sstep(0, 1.2, t)), type: 'saw', voices: 3, detune: 15, env: (t) => att(t, 0.9) });
    S.filt(sw, 'lowpass', (t) => 200 + 2800 * sstep(0, 1.2, t), 1.5); norm(sw);
    S.add(o, sw, 0, 0.55);
    S.add(o, S.voice(1.3, { f0: (t) => 65 + 25 * t, form: (t) => vmix(vf('o', 0.7, 2), vf('a', 0.7, 2), t / 1.3), breath: 0.6, fry: 0.8, jit: 0.08, saw: 0.4, drive: 3.5, tilt: 2500, rattle: 0.5, env: (t) => att(t, 0.25) * (1 - sstep(1.0, 1.3, t)) }), 0.3, 0.85);
    S.add(o, S.thud({ dur: 0.7, f0: 85, f1: 40, ptau: 0.06, tau: 0.2, drive: 2.5 }), 1.2, 0.7);
    S.add(o, S.noise({ dur: 0.4, color: 'pink', type: 'lowpass', f: (t) => 300 + 4000 * Math.exp(-t / 0.04), env: (t) => Math.exp(-t / 0.07) }), 1.2, 0.35);
    return o;
  },
  terminator_roar: (S) => {
    const dur = 3.2, n = S.n(dur + 0.1), L = new Float32Array(n), R = new Float32Array(n);
    const envR = (t) => att(t, 0.25) * (1 - sstep(2.2, 3.1, t)) * (0.85 + 0.15 * Math.sin(TAU * 2.2 * t));
    const A = S.voice(dur, { f0: (t) => 44 * (1 + 0.15 * win(t / dur)), form: (t) => vmix(vf('o', 0.55, 2.5), vf('a', 0.55, 2.5), win(t / dur)), breath: 0.6, fry: 0.85, jit: 0.09, saw: 0.5, drive: 4, tilt: 2000, rattle: 0.6, rattleHz: 24, env: envR });
    const B = S.voice(dur, { f0: (t) => 68 * (1 + 0.2 * win(t / dur)), form: (t) => vmix(vf('u', 0.7, 2), vf('a', 0.7, 2), win(t / dur)), breath: 0.8, fry: 0.6, jit: 0.07, saw: 0.3, drive: 3, tilt: 2800, rattle: 0.4, rattleHz: 31, env: envR });
    const C = S.voice(dur, { f0: (t) => 96 * (1 + 0.25 * win(t / dur)), form: vf('a', 0.85, 2.5), breath: 0.95, fry: 0.4, jit: 0.1, drive: 3, tilt: 4000, env: envR });
    const sub = S.tone({ dur, f: 46, env: (t) => att(t, 0.4) * (1 - sstep(2.0, 3.0, t)) });
    const crk = S.crackle({ dur, rate: (t) => 150 * win(t / dur) + 10 });
    S.add(L, A, 0, 1); S.add(R, A, 0, 1); S.add(L, B, 0, 0.75); S.add(R, B, 0.012, 0.6); S.add(L, C, 0.01, 0.4); S.add(R, C, 0, 0.55);
    for (const ch of [L, R]) {
      S.add(ch, sub, 0, 0.3);
      S.add(ch, S.noise({ dur, color: 'pink', type: 'lowpass', f: 900, env: envR }), 0, 0.25);
      S.add(ch, crk, ch === L ? 0 : 0.005, 0.1);
      S.filt(ch, 'lowshelf', 120, 0.7, 4);
    }
    return [L, R];
  },
  terminator_zap: (S) => {
    const o = S.buf(1.0);
    S.add(o, S.crackle({ dur: 0.9, rate: (t) => 2200 * Math.exp(-t / 0.35) + 100, hp: 900 }), 0, 0.4);
    const bz = S.tone({ dur: 0.8, f: S.rr(85, 120), type: 'square', env: (t) => att(t, 0.005) * Math.exp(-t / 0.25) });
    const am = S.vn(60, 1);
    S.env(bz, (t) => 0.4 + 0.6 * Math.abs(am(t))); S.filt(bz, 'bandpass', 900, 0.7); norm(bz);
    S.add(o, bz, 0, 0.7);
    S.add(o, S.fm({ dur: 0.6, f: (t) => 2600 * Math.exp(-t * 4) + 180, ratio: 1.41, index: 5, env: (t) => Math.exp(-t / 0.18) }), 0, 0.55);
    S.add(o, S.thud({ f0: 130, f1: 60, tau: 0.06, drive: 2 }), 0, 0.35);
    S.add(o, S.noise({ dur: 0.9, type: 'highpass', f: 3000, env: (t) => Math.exp(-t / 0.3) }), 0.02, 0.15);
    return o;
  },
  shield_on: (S) => {
    const dur = 1.5, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
    [[L, 1], [R, -1]].forEach(([ch, d]) => {
      const sw = S.tone({ dur, f: (t) => 70 * Math.pow(2, Math.min(t, 0.8) / 0.8) * semi(0.06 * d), type: 'saw', voices: 2, detune: 12, env: (t) => att(t, 0.6) * (1 - 0.5 * sstep(0.9, 1.5, t)) * (1 - sstep(1.4, 1.5, t)) });
      S.filt(sw, 'lowpass', (t) => 250 + 2500 * sstep(0, 0.8, t), 2); norm(sw);
      S.add(ch, sw, 0, 0.6);
      S.add(ch, S.fm({ dur, f: (t) => 800 + 800 * sstep(0, 0.9, t), ratio: 2.01, index: 3, env: (t) => att(t, 0.8) * (1 - sstep(1.0, 1.5, t)) }), 0, 0.2);
      S.add(ch, S.crackle({ dur, rate: (t) => 300 + 600 * win(t / dur) }), 0, 0.3);
    });
    const w = S.thud({ f0: 90, f1: 50, tau: 0.12, att: 0.02 }), p = S.ring({ partials: [[1200, 1, 0.3], [1810, 0.6, 0.25], [2710, 0.4, 0.2]] });
    S.add(L, w, 0, 0.45); S.add(R, w, 0, 0.45); S.add(L, p, 0.8, 0.2); S.add(R, p, 0.8, 0.2);
    return [L, R];
  },
  shield_loop: shieldLoop,
  electric_loop: electricLoop,
  // ----- humans
  human_pain: (S, k) => {
    const dur = S.rr(0.3, 0.42), b = S.rr(125, 160), o = S.buf(dur + 0.15);
    S.add(o, S.voice(dur, { f0: (t) => b * (1.15 - (0.3 * t) / dur), form: (t) => vmix(vf(['u', 'a', 'e'][k % 3]), vf('u'), t / dur), breath: 0.35, fry: 0.12, jit: 0.03, drive: 1.8, tilt: 3000, env: (t) => att(t, 0.012) * Math.exp(-t / (dur * 0.45)) }), 0, 1);
    S.add(o, S.noise({ dur: dur + 0.1, color: 'pink', type: 'bandpass', f: 1400, q: 1, env: (t) => att(t, 0.02) * Math.exp(-t / 0.12) }), 0.01, 0.2);
    return o;
  },
  human_death: (S) => {
    const dur = S.rr(0.9, 1.15), b = S.rr(160, 200), o = S.buf(dur + 0.6);
    S.add(o, S.voice(dur, { f0: (t) => b * (1.1 - 0.5 * sstep(0.1, 1, t / dur)), form: (t) => vmix(vf('a'), vf('o'), t / dur), breath: 0.45, fry: (t) => 0.1 + (0.5 * t) / dur, jit: 0.04, vib: [7, 0.02], drive: 2, tilt: 2800, env: (t) => att(t, 0.03) * (1 - sstep(dur * 0.4, dur, t)) }), 0, 1);
    S.add(o, S.thud({ f0: 100, f1: 55, tau: 0.08, drive: 1.5 }), dur - 0.05, 0.55);
    S.add(o, S.grains({ dur: 0.25, count: 10, fLo: 1500, fHi: 4500, q: 2 }), dur - 0.04, 0.25);
    S.add(o, S.grains({ dur: 0.2, count: 6, fLo: 2500, fHi: 5500, q: 7 }), dur, 0.15);
    return o;
  },
  // ----- ghost hunter
  hunter_transform: (S) => {
    const dur = 3.0, T = 1.6, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
    const choir = S.voice(T, { f0: (t) => 220 * Math.pow(1.5, t / T), form: vf('a', 1.1), breath: 0.25, jit: 0.01, vib: [5, 0.01], tilt: 3500, env: (t) => Math.pow(t / T, 2) });
    [[L, 1], [R, -1]].forEach(([ch, d]) => {
      const riser = S.tone({ dur: T + 0.02, f: (t) => 110 * Math.pow(2, t / T) * semi(0.05 * d), type: 'saw', voices: 3, detune: 14, env: (t) => Math.pow(Math.min(1, t / T), 1.5) });
      S.filt(riser, 'lowpass', (t) => 300 + 5500 * Math.pow(Math.min(1, t / T), 2), 1.5); norm(riser);
      S.add(ch, riser, 0, 0.5);
      S.add(ch, S.tone({ dur: T + 0.02, f: (t) => 330 * Math.pow(2, t / T), type: 'saw', voices: 2, detune: 10, lp: 3000, env: (t) => Math.pow(Math.min(1, t / T), 2) }), 0, 0.2);
      S.add(ch, S.noise({ dur: T + 0.02, type: 'bandpass', f: (t) => 500 * Math.pow(12, t / T), q: 1.2, env: (t) => Math.pow(Math.min(1, t / T), 2.5) }), 0, 0.3);
      S.add(ch, choir, 0, 0.2);
      S.add(ch, S.thud({ dur: 1.4, f0: 90, f1: 42, ptau: 0.07, tau: 0.3, drive: 2.5 }), T, 0.65);
      S.add(ch, S.noise({ dur: 0.5, color: 'pink', type: 'lowpass', f: (t) => 400 + 6000 * Math.exp(-t / 0.04), env: (t) => Math.exp(-t / 0.08) }), T, 0.5);
      S.add(ch, S.noise({ dur: 0.4, type: 'bandpass', f: (t) => 2800 * Math.pow(2.6, t / 0.4), q: 7, env: (t) => att(t, 0.01) * Math.exp(-t / 0.12) }), T + 0.02, 0.45);
      S.add(ch, S.ring({ dur: 1.4, partials: [[2350, 1, 0.9], [3710, 0.8, 0.7], [5140, 0.6, 0.5], [6890, 0.4, 0.35], [8810, 0.25, 0.25]].map(([f, a, t]) => [S.J(f, 0.01), a, t]), beat: 0.4, strike: 0.3, strikeF: 6000 }), T + 0.03, 0.55);
      S.add(ch, S.pad([55, 110, 165], 1.4, { lp: 700, env: (t) => att(t, 0.05) * Math.exp(-t / 0.5), det: 15 }), T, 0.35);
    });
    return [L, R];
  },
  blade_slash: (S) => {
    const dur = S.rr(0.4, 0.5), b = S.rr(95, 125), pk = S.rr(0.35, 0.5), o = S.buf(dur + 0.05);
    S.add(o, S.whoosh({ dur, f: [600, 2600, 900], q: 1.4, peak: pk }), 0, 0.55);
    const hum = S.tone({ dur, f: (t) => b * (1 + 0.45 * win(t / dur)), type: 'saw', voices: 2, detune: 18, env: (t) => Math.pow(win(t / dur), 1.5) });
    S.filt(hum, 'lowpass', 1800, 1.2); S.filt(hum, 'peak', 600, 1.5, 6); norm(hum);
    S.add(o, hum, 0, 0.7);
    S.add(o, S.fm({ dur, f: (t) => 900 + 1400 * win(t / dur), ratio: 2.41, index: 2.5, env: (t) => Math.pow(win(t / dur), 3) }), 0, 0.15);
    S.add(o, S.crackle({ dur, rate: (t) => 400 * win(t / dur) + 20 }), 0, 0.18);
    return o;
  },
  blade_hit: (S) => {
    const o = S.buf(0.6);
    S.add(o, S.crackle({ dur: 0.45, rate: (t) => 3000 * Math.exp(-t / 0.1) + 30 }), 0, 0.7);
    S.add(o, S.thud({ f0: 160, f1: 70, tau: 0.05, drive: 2 }), 0, 0.8);
    S.add(o, S.noise({ dur: 0.2, color: 'pink', type: 'bandpass', f: 500, q: 1.4, env: (t) => Math.exp(-t / 0.03) }), 0, 0.45);
    S.add(o, S.fm({ dur: 0.35, f: (t) => 2500 * Math.exp(-t * 9) + 150, ratio: 1.41, index: 5, env: (t) => Math.exp(-t / 0.08) }), 0, 0.4);
    return o;
  },
  // ----- UI / game
  ui_click: (S) => {
    const o = S.buf(0.06);
    S.add(o, S.click({ f: 2000, q: 1.5, tau: 0.0015 }), 0, 0.5);
    S.add(o, S.tone({ dur: 0.06, f: 1200, env: (t) => att(t, 0.001) * Math.exp(-t / 0.012) }), 0, 0.7);
    return o;
  },
  ui_hover: (S) => {
    const o = S.buf(0.04);
    S.add(o, S.tone({ dur: 0.04, f: 2600, env: (t) => att(t, 0.001) * Math.exp(-t / 0.007) }), 0, 0.6);
    S.add(o, S.click({ f: 5000, q: 2, tau: 0.001 }), 0, 0.2);
    return o;
  },
  countdown_tick: (S) => {
    const o = S.buf(0.25), e = (t) => att(t, 0.002) * Math.exp(-t / 0.06);
    S.add(o, S.tone({ dur: 0.25, f: 1000, env: e }), 0, 1); S.add(o, S.tone({ dur: 0.25, f: 2000, env: e }), 0, 0.3); S.add(o, S.tone({ dur: 0.25, f: 3000, env: e }), 0, 0.12);
    S.add(o, S.click({ f: 3000, q: 1.5, tau: 0.001 }), 0, 0.2);
    return o;
  },
  round_start: (S) => {
    const dur = 3.4, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
    const imp = S.buf(2);
    S.add(imp, S.thud({ dur: 1.8, f0: 85, f1: 40, ptau: 0.08, tau: 0.45, drive: 2.5 }), 0, 0.7);
    S.add(imp, S.noise({ dur: 0.6, color: 'pink', type: 'lowpass', f: (t) => 300 + 4000 * Math.exp(-t / 0.05), env: (t) => Math.exp(-t / 0.09) }), 0, 0.6);
    S.add(imp, S.ring({ partials: [[220, 1, 1.2], [347, 0.8, 0.9], [521, 0.6, 0.6], [781, 0.4, 0.4], [1130, 0.25, 0.25]] }), 0, 0.3);
    const sirF = (t) => { const u = t - 0.15; return 330 + 420 * sstep(0, 1.2, u) - 300 * sstep(2.2, 3.1, u); };
    const sirEnv = (t) => att(t - 0.15, 0.25) * (1 - sstep(2.6, 3.3, t));
    const drum = S.thud({ dur: 0.8, f0: 90, f1: 45, tau: 0.15, drive: 2 });
    [[L, 1], [R, -1]].forEach(([ch, d]) => {
      S.add(ch, imp);
      S.add(ch, S.tone({ dur, f: (t) => sirF(t) * semi(0.04 * d), type: 'saw', voices: 2, detune: 10, lp: 2200, env: sirEnv }), 0, 0.45);
      S.add(ch, S.tone({ dur, f: (t) => sirF(t) * 1.5 * semi(0.05 * d), type: 'square', lp: 1800, env: (t) => sirEnv(t) * 0.5 }), 0, 0.18);
      S.add(ch, S.pad([65.4, 77.8, 98, 130.8], dur, { lp: (t) => 200 + 1300 * sstep(0, 0.35, t) * Math.exp(-t / 2.5), env: (t) => att(t, 0.05) * Math.exp(-t / 1.6), det: 12 }), 0, 0.45);
      S.add(ch, drum, 1.6, 0.45); S.add(ch, drum, 1.85, 0.35);
    });
    return [L, R];
  },
  win_human: (S) => {
    const n = S.n(2.8), L = new Float32Array(n), R = new Float32Array(n);
    const Gc = [196, 246.9, 293.7, 392], Cc = [261.6, 329.6, 392, 523.3];
    [[0, 0.11, Gc], [0.14, 0.11, Gc], [0.28, 1.5, Cc]].forEach(([t0, d, ch]) => ch.forEach((f, j) => {
      const b = brass(S, f, d, { rel: d > 1 ? 0.6 : 0.08 }), pan = (j / (ch.length - 1)) * 2 - 1;
      S.add(L, b, t0, 0.3 * (1 - 0.35 * pan)); S.add(R, b, t0, 0.3 * (1 + 0.35 * pan));
    }));
    const timp = S.buf(1.5);
    S.add(timp, S.thud({ dur: 1.4, f0: 105, f1: 98, ptau: 0.05, tau: 0.45 }), 0, 1);
    S.add(timp, S.noise({ dur: 0.3, color: 'pink', type: 'lowpass', f: 500, env: (t) => Math.exp(-t / 0.06) }), 0, 0.5);
    S.add(L, timp, 0.28, 0.5); S.add(R, timp, 0.28, 0.5);
    const cy = () => S.noise({ dur: 1.8, type: 'highpass', f: 5000, env: (t) => att(t, 0.005) * Math.exp(-t / 0.7) });
    S.add(L, cy(), 0.28, 0.12); S.add(R, cy(), 0.28, 0.12);
    return [L, R];
  },
  win_zombie: (S) => {
    const dur = 3.6, n = S.n(dur), L = new Float32Array(n), R = new Float32Array(n);
    [[L, 1], [R, -1]].forEach(([ch, d]) => {
      S.add(ch, S.noise({ dur: 0.7, color: 'pink', type: 'lowpass', f: (t) => 200 * Math.pow(15, t / 0.7), env: (t) => Math.pow(t / 0.7, 3) }), 0, 0.45);
      S.add(ch, S.pad([65.4, 92.5, 130.8, 138.6].map((f) => f * semi(0.05 * d)), 2.9, { lp: (t) => 500 + 300 * Math.sin(TAU * 0.4 * t), env: (t) => att(t, 0.03) * (1 - sstep(1.5, 2.9, t)) * (0.85 + 0.15 * Math.sin(TAU * 5 * t)), det: 14 }), 0.7, 0.6);
      S.add(ch, S.tone({ dur: 2.4, f: (t) => 1244 * semi(0.1 * d) * (1 - 0.03 * t), vib: [4, 0.006], env: (t) => att(t, 0.8) * (1 - sstep(1.4, 2.4, t)) }), 0.9, 0.08);
      S.add(ch, S.tone({ dur: 2.4, f: 1318, vib: [5, 0.006], env: (t) => att(t, 0.9) * (1 - sstep(1.4, 2.4, t)) }), 0.9, 0.06);
    });
    const boom = S.buf(2);
    S.add(boom, S.thud({ dur: 1.9, f0: 75, f1: 38, ptau: 0.1, tau: 0.5, drive: 2.5 }), 0, 1);
    S.add(boom, S.noise({ dur: 0.5, color: 'pink', type: 'lowpass', f: (t) => 200 + 2500 * Math.exp(-t / 0.05), env: (t) => Math.exp(-t / 0.1) }), 0, 0.4);
    S.add(L, boom, 0.7, 0.6); S.add(R, boom, 0.7, 0.6);
    return [L, R];
  },
  pickup: (S) => {
    const o = S.buf(0.45);
    S.add(o, S.click({ f: 2500, q: 1.5, tau: 0.0015 }), 0, 0.3);
    S.add(o, S.tone({ dur: 0.3, f: 880, type: 'tri', env: (t) => att(t, 0.002) * Math.exp(-t / 0.08) }), 0, 0.6);
    S.add(o, S.tone({ dur: 0.38, f: 1318.5, type: 'tri', env: (t) => att(t, 0.002) * Math.exp(-t / 0.18) }), 0.07, 0.6);
    return o;
  },
  supply_drop: (S) => {
    const o = S.buf(1.8);
    S.add(o, S.noise({ dur: 0.85, color: 'pink', type: 'bandpass', f: (t) => 2200 * Math.pow(0.2, t / 0.85), q: 1.2, env: (t) => Math.pow(t / 0.85, 2) }), 0, 0.35);
    S.add(o, S.thud({ f0: 105, f1: 55, tau: 0.09, drive: 2 }), 0.85, 0.75);
    S.add(o, S.click({ f: 900, q: 1.2, tau: 0.006 }), 0.85, 0.5);
    S.add(o, S.grains({ dur: 0.35, count: 20, fLo: 900, fHi: 3500, q: 2, dens: (u) => Math.exp(-u * 3) }), 0.86, 0.35);
    S.add(o, S.ring({ partials: [[880, 1, 0.08], [1470, 0.7, 0.06], [2310, 0.5, 0.04]] }), 0.87, 0.25);
    for (const t of [1.15, 1.4]) S.add(o, S.tone({ dur: 0.12, f: 1500, type: 'square', lp: 3000, env: (x) => att(x, 0.004) * (1 - sstep(0.08, 0.12, x)) }), t, 0.3);
    return o;
  },
  // clock-tower bell: church-bell partial ratios (hum, prime, minor tierce, quint, nominal...) with beating pairs
  bell: (S) => {
    const p = 196 * S.rr(0.995, 1.005), dur = 7;
    const P = [[0.5, 0.55, 3.2], [1.0, 0.45, 2.6], [1.183, 0.6, 2.4], [1.506, 0.3, 1.6], [2.0, 1.0, 2.2], [2.51, 0.32, 1.3], [2.66, 0.28, 1.1], [3.01, 0.22, 0.9], [4.07, 0.22, 0.6], [5.24, 0.12, 0.4], [6.1, 0.1, 0.3], [7.3, 0.06, 0.2]];
    const mk = () => {
      const parts = [];
      for (const [r, a, tau] of P) { const f = p * r * S.rr(0.998, 1.002); parts.push([f, a, tau], [f * (1 + S.rr(0.001, 0.003)), a * 0.5, tau * 0.9]); }
      const b = S.ring({ dur, partials: parts, att: 0.001 });
      S.add(b, S.click({ f: 2400, q: 0.9, tau: 0.004 }), 0, 0.3);
      S.add(b, S.thud({ f0: 420, f1: 330, tau: 0.03 }), 0, 0.2);
      return S.env(b, (t) => 1 - sstep(4.5, dur, t));
    };
    return [mk(), mk()];
  },
  heartbeat: (S) => {
    const o = S.buf(0.86);
    const lub = S.thud({ dur: 0.45, f0: 80, f1: 46, ptau: 0.02, tau: 0.065, drive: 2.5, att: 0.004, h2: 0.35 });
    const dub = S.thud({ dur: 0.45, f0: 95, f1: 54, ptau: 0.02, tau: 0.055, drive: 2.5, att: 0.004, h2: 0.35 });
    const nz = () => S.noise({ dur: 0.2, color: 'pink', type: 'bandpass', f: 140, q: 0.9, env: (t) => att(t, 0.004) * Math.exp(-t / 0.03) });
    S.add(o, lub, 0.02, 1); S.add(o, nz(), 0.02, 0.6); S.add(o, dub, 0.3, 0.72); S.add(o, nz(), 0.3, 0.45);
    return o;
  },
  low_hp: (S) => {
    const o = S.buf(1.5);
    S.add(o, S.noise({ dur: 0.55, type: 'bandpass', f: 1300, q: 1.6, eq: [['peak', 2600, 2, 6]], env: (t) => Math.pow(win(t / 0.55), 1.5) }), 0.05, 0.45);
    S.add(o, S.noise({ dur: 0.7, color: 'pink', type: 'bandpass', f: 800, q: 1.2, eq: [['peak', 1700, 2, 6]], env: (t) => att(t, 0.05) * Math.pow(Math.max(0, 1 - t / 0.7), 2) }), 0.7, 0.55);
    const hb = S.thud({ f0: 60, f1: 38, tau: 0.06, drive: 2.5, att: 0.004 });
    S.add(o, hb, 0.02, 0.4); S.add(o, hb, 0.3, 0.28);
    return o;
  },
  // ----- ambience
  ambient: ambBed,
  amb_crow: (S, k) => {
    const nC = 2 + (k % 3), o = S.buf(0.5 * nC + 0.4), base = S.rr(480, 600);
    let t = 0.02;
    for (let c = 0; c < nC; c++) {
      const d = S.rr(0.22, 0.32), f = base * S.rr(0.92, 1.08);
      S.add(o, S.voice(d, { f0: (x) => f * (1.05 - (0.3 * x) / d), form: [[1150, 220, 1], [1800, 260, 0.8], [2700, 400, 0.4], [3600, 500, 0.2]], breath: 0.7, fry: 0.45, jit: 0.06, saw: 0.3, drive: 4, tilt: 5000, Tp: 0.3, Tn: 0.1, env: (x) => att(x, 0.02) * (1 - sstep(d * 0.6, d, x)) }), t, S.rr(0.7, 1));
      t += d + S.rr(0.1, 0.22);
    }
    return S.filt(o, 'highpass', 400, 0.7);
  },
  amb_creak: (S) => {
    const dur = S.rr(0.7, 1.3), a = S.rr(60, 110), b = S.rr(40, 120);
    return S.creak({ dur, f: (u) => a + b * Math.sin(Math.PI * u), res: [[S.J(380), 7, 1], [S.J(760), 9, 0.7], [S.J(1450), 8, 0.35]], irr: 0.25, env: (u) => Math.pow(win(u), 0.7) });
  },
  amb_windmill: (S) => {
    const dur = 3.6, o = S.buf(dur), rot = S.rr(1.1, 1.4);
    for (let t = 0.05; t < dur - 0.5; t += rot) {
      S.add(o, S.creak({ dur: 0.45, f: (u) => 620 + 380 * Math.sin(Math.PI * u) + 60 * Math.sin(TAU * 7 * u), res: [[1150, 5, 1], [2300, 6, 0.5], [3400, 7, 0.2]], irr: 0.06, env: win }), t, S.rr(0.6, 1));
      S.add(o, S.creak({ dur: 0.3, f: (u) => 480 + 200 * u, res: [[900, 6, 1], [1900, 6, 0.5]], irr: 0.08, env: win }), t + rot * 0.5, 0.4);
      S.add(o, S.thud({ f0: 160, f1: 120, tau: 0.03 }), t + rot * 0.75, 0.25);
    }
    return o;
  },
  amb_howl: (S, k) => {
    const dur = S.rr(3.2, 4.0), b = S.rr(360, 420) * (k ? 0.85 : 1);
    const f0 = (t) => { const u = t / dur; if (u < 0.2) return lerp(b, b * 1.85, sstep(0, 0.2, u)); if (u < 0.55) return b * 1.85 * (1 + 0.02 * Math.sin(TAU * 1.2 * t)); return lerp(b * 1.85, b * 1.15, sstep(0.55, 1, u)); };
    return S.voice(dur, { f0, form: (t) => vmix(vf('oo', 1.3), vf('o', 1.35), win(t / dur)), breath: 0.12, fry: 0, jit: 0.012, vib: [5.5, 0.012], tilt: 1100, drive: 1.2, env: (t) => att(t, 0.35) * (1 - sstep(dur - 0.9, dur, t)) });
  },
  amb_sign: (S) => {
    const o = S.buf(1.9);
    const knock = () => { const b = S.buf(0.15); S.add(b, S.click({ f: S.rr(600, 900), q: 3, tau: 0.004 }), 0, 1); S.add(b, S.thud({ f0: 260, f1: 190, tau: 0.025 }), 0, 0.6); return norm(b); };
    S.add(o, S.creak({ dur: 0.5, f: (u) => 700 + 300 * u, res: [[1300, 5, 1], [2600, 6, 0.4]], irr: 0.1, env: win }), 0.05, 0.5);
    S.add(o, knock(), 0.5, 0.9); S.add(o, knock(), 0.58, 0.5);
    S.add(o, S.creak({ dur: 0.45, f: (u) => 950 - 300 * u, res: [[1250, 5, 1], [2500, 6, 0.4]], irr: 0.1, env: win }), 0.9, 0.45);
    S.add(o, knock(), 1.4, 0.7);
    S.add(o, S.grains({ dur: 0.3, count: 6, fLo: 2500, fHi: 5000, q: 6 }), 1.42, 0.2);
    return o;
  },
  amb_gust: (S) => {
    const dur = S.rr(3.5, 4.5), pk = S.rr(0.3, 0.5);
    const mk = () => {
      const b = S.buf(dur);
      S.add(b, S.whoosh({ dur, f: [350, 900, 450], q: 0.7, peak: pk, pow: 1.5 }), 0, 1);
      S.add(b, S.noise({ dur, type: 'bandpass', f: (t) => 900 + 400 * win(t / dur), q: 18, env: (t) => Math.pow(win(t / dur), 3) }), 0, 0.25);
      S.add(b, S.noise({ dur, type: 'highpass', f: 4000, env: (t) => Math.pow(win(t / dur), 2) }), 0, 0.12);
      return b;
    };
    return [mk(), mk()];
  },
};

// ---------------------------------------------------------------------------------------------
// Sound table: v = variations, sp = spatial profile, bus, gain (playback), rv = random pitch spread,
// max = concurrent instances, rev = reverb send, eager = render at unlock, loop = seamless loop buffer.
const P_GUN = { sp: 'gun', rev: 0.35, gain: 0.8, rv: 0.025, max: 8, v: 3, eager: true };
const P_IMP = { sp: 'mid', rev: 0.12, gain: 0.45, rv: 0.08, max: 8, v: 3, eager: true };
const P_STEP = { sp: 'quiet', rev: 0.04, gain: 0.32, rv: 0.06, max: 8, v: 4, eager: true };
const P_MECH = { sp: 'quiet', rev: 0.06, gain: 0.5, rv: 0.02, max: 3, v: 1 };
const P_ZOM = { sp: 'loud', rev: 0.2, gain: 0.6, rv: 0.06, max: 6, v: 3 };
const P_UI = { bus: 'ui', rev: 0, gain: 0.35, rv: 0, max: 4, v: 1 };
const P_STING = { bus: 'ui', rev: 0.2, gain: 0.7, rv: 0, max: 2, v: 1 };
const P_AMB = { bus: 'amb', sp: 'far', rev: 0.6, gain: 0.45, rv: 0.05, max: 3, v: 3 };

const DEFS = {
  shot_ak47: { ...P_GUN }, shot_m4a1: { ...P_GUN }, shot_mg3: { ...P_GUN, gain: 0.7, max: 10 }, shot_deagle: { ...P_GUN, gain: 0.85, max: 4 },
  dryfire: { ...P_MECH, gain: 0.45, eager: true },
  reload_rifle: { ...P_MECH }, reload_mg: { ...P_MECH }, reload_pistol: { ...P_MECH }, draw: { ...P_MECH, gain: 0.45 },
  knife_slash: { ...P_IMP, gain: 0.5, rev: 0.05 }, knife_stab: { ...P_IMP, v: 2, gain: 0.55, rev: 0.05, eager: false },
  knife_hit_wall: { ...P_IMP, gain: 0.5 }, knife_hit_flesh: { ...P_IMP, gain: 0.6 },
  grenade_pin: { ...P_MECH, gain: 0.45 }, grenade_throw: { ...P_MECH, gain: 0.45, v: 2 }, grenade_bounce: { ...P_IMP, gain: 0.5, eager: false },
  explosion: { sp: 'boom', rev: 0.5, gain: 1.0, rv: 0.04, max: 4, v: 2 },
  shell_casing: { ...P_IMP, sp: 'quiet', gain: 0.2, v: 4, max: 6, rv: 0.05 },
  bullet_impact_wood: { ...P_IMP }, bullet_impact_dirt: { ...P_IMP }, bullet_impact_metal: { ...P_IMP, gain: 0.4 },
  bullet_flesh: { ...P_IMP, gain: 0.55 },
  headshot: { ...P_UI, gain: 0.7, v: 2, eager: true }, whizz: { ...P_IMP, gain: 0.45, max: 4, rev: 0 },
  hitmarker: { ...P_UI, gain: 0.4, max: 3, eager: true }, kill_confirm: { ...P_UI, gain: 0.6, eager: true },
  step_dirt: { ...P_STEP }, step_wood: { ...P_STEP, gain: 0.35 }, step_metal: { ...P_STEP, gain: 0.3 },
  jump: { ...P_STEP, v: 2, gain: 0.35 }, land: { ...P_STEP, v: 3, gain: 0.45 }, ladder: { ...P_STEP, v: 3 },
  zombie_growl: { ...P_ZOM, v: 4 }, zombie_attack: { ...P_ZOM, gain: 0.7 }, zombie_hit: { ...P_ZOM, sp: 'mid', gain: 0.6 },
  zombie_pain: { ...P_ZOM }, zombie_death: { ...P_ZOM, v: 2, gain: 0.7 }, zombie_respawn: { ...P_ZOM, v: 1, gain: 0.6, rv: 0.02, rev: 0.3 },
  zombie_jump: { ...P_ZOM, v: 2, gain: 0.5 }, infect: { ...P_ZOM, v: 1, gain: 0.85, rv: 0.02, rev: 0.3, max: 3 },
  evolve: { ...P_ZOM, v: 1, gain: 0.8, rv: 0.02, max: 2 }, terminator_roar: { ...P_ZOM, sp: 'boom', v: 1, gain: 1.0, rv: 0.03, rev: 0.4, max: 2 },
  terminator_zap: { ...P_ZOM, gain: 0.7, rv: 0.05 }, shield_on: { ...P_ZOM, v: 1, gain: 0.6, rv: 0.02, max: 2 },
  shield_loop: { ...P_ZOM, v: 1, gain: 0.4, loop: true, rv: 0 }, electric_loop: { ...P_ZOM, v: 1, gain: 0.35, loop: true, rv: 0 },
  human_pain: { ...P_ZOM, sp: 'mid', gain: 0.55, rev: 0.12 }, human_death: { ...P_ZOM, sp: 'mid', v: 2, gain: 0.6, rev: 0.15 },
  hunter_transform: { ...P_ZOM, v: 1, gain: 0.85, rv: 0, rev: 0.3, max: 2 }, blade_slash: { ...P_IMP, gain: 0.6, rev: 0.1 }, blade_hit: { ...P_IMP, v: 2, gain: 0.6 },
  ui_click: { ...P_UI, eager: true }, ui_hover: { ...P_UI, gain: 0.2, eager: true }, countdown_tick: { ...P_UI, gain: 0.45 },
  round_start: { ...P_STING }, win_human: { ...P_STING }, win_zombie: { ...P_STING },
  pickup: { ...P_UI, gain: 0.5 }, supply_drop: { ...P_ZOM, sp: 'loud', v: 1, gain: 0.7, rv: 0 },
  bell: { sp: 'far', rev: 0.4, gain: 0.9, rv: 0.005, max: 2, v: 1 },
  heartbeat: { ...P_UI, gain: 0.6, loop: true }, low_hp: { ...P_UI, gain: 0.5 },
  ambient: { bus: 'amb', rev: 0, gain: 0.18, rv: 0, max: 1, v: 1, loop: true, srf: 0.5 },
  amb_crow: { ...P_AMB }, amb_creak: { ...P_AMB, sp: 'mid', gain: 0.35 }, amb_windmill: { ...P_AMB, v: 2 }, amb_howl: { ...P_AMB, v: 2, gain: 0.5 },
  amb_sign: { ...P_AMB, sp: 'mid', gain: 0.4 }, amb_gust: { ...P_AMB, sp: null, v: 2, gain: 0.3, rev: 0 },
};

export const SOUNDS = Object.keys(DEFS);

// Pure render: returns array of Float32Array channels (finalized: NaN-scrubbed, DC-free, peak 0.89, trimmed).
export function renderSound(name, variant = 0, sampleRate = 48000) {
  const def = DEFS[name], gen = G[name];
  if (!def || !gen) throw new Error('unknown sound ' + name);
  const sr = Math.round(sampleRate * (def.srf || 1));
  const S = new Syn(sr, (hashStr(name) + variant * 7919) >>> 0);
  let chs = gen(S, variant);
  if (!Array.isArray(chs)) chs = [chs];
  return finalize(chs, def, sr);
}

function finalize(chs, def, sr) {
  const n = Math.max(...chs.map((c) => c.length));
  chs = chs.map((c) => { if (c.length === n) return c; const x = new Float32Array(n); x.set(c); return x; });
  for (const a of chs) for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) a[i] = 0;
  if (def.loop) {
    for (const a of chs) { let m = 0; for (let i = 0; i < n; i++) m += a[i]; m /= n; for (let i = 0; i < n; i++) a[i] -= m; }
  } else {
    for (const a of chs) filt(sr, a, 'highpass', 32, 0.707); // removes DC + inaudible infrasonic energy
  }
  let pk = 0;
  for (const a of chs) pk = Math.max(pk, peakOf(a));
  const s = pk > 1e-9 ? 0.89 / pk : 0;
  for (const a of chs) for (let i = 0; i < n; i++) a[i] *= s;
  if (def.loop) return chs;
  let last = 0;
  for (const a of chs) for (let i = n - 1; i > last; i--) if (Math.abs(a[i]) > 0.0006) { last = i; break; }
  const len = Math.min(n, last + Math.round(sr * 0.02) + 1), fade = Math.min(Math.round(sr * 0.012), Math.floor(len * 0.2));
  return chs.map((a) => {
    const b = a.slice(0, len);
    for (let i = 0; i < fade; i++) b[len - 1 - i] *= i / fade;
    return b;
  });
}

// ---------------------------------------------------------------------------------------------
// Runtime

const MAX_VOICES = 48;
const MAX_HRTF = 16;
const MIN_GAIN = 0.004;
const SP = {
  gun: { ref: 4, roll: 0.55 },
  boom: { ref: 7, roll: 0.45 },
  loud: { ref: 4, roll: 0.7 },
  mid: { ref: 2.5, roll: 1.0 },
  quiet: { ref: 1.5, roll: 1.5 },
  far: { ref: 12, roll: 0.35 },
};
const distGain = (sp, d) => sp.ref / (sp.ref + sp.roll * (Math.max(d, sp.ref) - sp.ref));
const revGain = (sp, d) => sp.ref / (sp.ref + sp.roll * 0.3 * Math.max(0, d - sp.ref));
const lpHz = (d) => 800 + 19200 * Math.exp(-d / 28);

const AMB_EVENTS = [
  { name: 'amb_crow', every: [9, 26], first: 0.4, dist: [25, 70], y: [6, 16], vol: [0.6, 1] },
  { name: 'amb_creak', every: [6, 16], first: 0.5, dist: [6, 22], y: [0, 4], vol: [0.5, 0.9] },
  { name: 'amb_windmill', every: [14, 30], first: 0.3, dist: [40, 55], y: [8, 12], vol: [0.7, 1], fixed: true },
  { name: 'amb_howl', every: [35, 75], first: 0.5, dist: [90, 140], y: [0, 10], vol: [0.7, 1] },
  { name: 'amb_sign', every: [10, 24], first: 0.6, dist: [8, 25], y: [2, 4], vol: [0.5, 0.9] },
  { name: 'amb_gust', every: [7, 18], first: 0.5, vol: [0.4, 0.8] },
];

const rand = (a, b) => a + Math.random() * (b - a);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class AudioSys {
  constructor() {
    this.ctx = null;
    this._vol = 0.8;
    this._busVol = { sfx: 1, ui: 1, amb: 1 };
    this._bufs = new Map();
    this.voices = [];
    this.loops = new Set();
    this._pending = new Set();
    this._lp = { x: 0, y: 0, z: 0 };
    this._yaw = 0;
    this._ambOn = false;
    this._ambBed = null;
    this._ambTimers = new Map();
    this._lastVar = {};
    this._warned = 0;
    this._queue = [];
    this._waiting = new Map();
    this._worker = null;
    this._inflight = null;
    this._info = { unlockMs: 0, eagerMs: 0, bgDone: false, bgMs: 0, worker: 'none', renderMs: {} };
  }

  // ---- public API
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        const t0 = now();
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._resume();
        this._build();
        this._applyListener();
        const t1 = now();
        for (const n of SOUNDS) if (DEFS[n].eager) this._get(n);
        this._info.eagerMs = now() - t1;
        this._info.unlockMs = now() - t0;
        this._scheduleBg();
        for (const h of this._pending) this._startLoop(h);
        this._pending.clear();
        if (this._ambOn) { this._ambOn = false; this.startAmbient(); }
      } else this._resume();
    } catch (e) { this._warn(e); }
  }

  setMasterVolume(v) {
    try {
      this._vol = clamp(+v || 0, 0, 1);
      if (this.ctx) this.masterGain.gain.setTargetAtTime(this._vol, this.ctx.currentTime, 0.03);
    } catch (e) { this._warn(e); }
  }

  // extra: per-bus volume ('sfx' | 'ui' | 'amb'), 0..1
  setBusVolume(bus, v) {
    try {
      if (!(bus in this._busVol)) return;
      this._busVol[bus] = clamp(+v || 0, 0, 1);
      if (this.ctx) this.buses[bus].gain.setTargetAtTime(this._busVol[bus], this.ctx.currentTime, 0.03);
    } catch (e) { this._warn(e); }
  }

  setListener(pos, yaw) {
    try {
      if (pos) { this._lp.x = +pos.x || 0; this._lp.y = +pos.y || 0; this._lp.z = +pos.z || 0; }
      if (Number.isFinite(yaw)) this._yaw = yaw;
      if (!this.ctx) return;
      this._applyListener();
      for (const h of this.loops) if (h._n && h._n.pan) this._updLoop(h);
    } catch (e) { this._warn(e); }
  }

  play(name, opts = {}) {
    try {
      if (!this.ctx || !this.buses) return null;
      const def = DEFS[name];
      if (!def) return null;
      opts = opts || {};
      const vol = (opts.volume ?? 1) * def.gain;
      if (!(vol > 0)) return null;
      const spatial = !!(opts.pos && def.sp);
      const sp = spatial ? SP[def.sp] : null;
      let dist = 0, pr = vol;
      if (spatial) {
        dist = this._dist(opts.pos);
        pr = vol * distGain(sp, dist);
        if (pr < MIN_GAIN) return null;
      }
      const bufs = this._get(name);
      if (!bufs || !bufs.length) return null;
      if (!this._makeRoom(name, def, pr)) return null;
      const c = this.ctx, t = c.currentTime;
      const buf = bufs[this._pickVar(name, bufs.length)];
      const rate = clamp((opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * def.rv), 0.25, 4);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = c.createGain();
      g.gain.value = vol;
      src.connect(g);
      const v = { name, src, g, lp: null, pan: null, send: null, t0: t, dur: buf.duration / rate, pr, done: false, hrtf: false, def, vol };
      if (spatial) {
        v.lp = c.createBiquadFilter(); v.lp.type = 'lowpass'; v.lp.Q.value = 0.5; v.lp.frequency.value = lpHz(dist);
        v.hrtf = dist < 45 && this._hrtfCount() < MAX_HRTF;
        v.pan = this._panner(sp, v.hrtf);
        this._setPannerPos(v.pan, opts.pos);
        g.connect(v.lp); v.lp.connect(v.pan); v.pan.connect(this.buses[def.bus || 'sfx']);
      } else g.connect(this.buses[def.bus || 'sfx']);
      const rs = def.rev * (spatial ? revGain(sp, dist) : 0.6);
      if (rs > 0.005) {
        v.send = c.createGain(); v.send.gain.value = rs;
        (v.lp || g).connect(v.send); v.send.connect(this.revIn);
      }
      src.onended = () => this._cleanup(v);
      src.start(t);
      this.voices.push(v);
      return {
        stop: () => this._kill(v),
        setVolume: (x) => { try { if (!v.done) { v.vol = (+x || 0) * def.gain; v.g.gain.setTargetAtTime(v.vol, this.ctx.currentTime, 0.02); } } catch (e) { this._warn(e); } },
        setPos: (p) => { try { if (!v.done && v.pan && p) { this._setPannerPos(v.pan, p); v.lp.frequency.setTargetAtTime(lpHz(this._dist(p)), this.ctx.currentTime, 0.05); } } catch (e) { this._warn(e); } },
      };
    } catch (e) { this._warn(e); return null; }
  }

  // Looping sound. Returns a handle even before unlock (it starts once unlock() is called).
  loop(name, opts = {}) {
    opts = opts || {};
    const h = {
      name, _vol: opts.volume ?? 1, _pos: opts.pos ? { x: +opts.pos.x || 0, y: +opts.pos.y || 0, z: +opts.pos.z || 0 } : null,
      _rate: opts.rate ?? 1, _n: null, _stopped: false,
      stop: () => this._stopLoop(h),
      setVolume: (v) => { try { h._vol = +v || 0; if (h._n) this._updLoop(h); } catch (e) { this._warn(e); } },
      setPos: (p) => {
        try {
          if (!p) return;
          h._pos = { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 };
          if (!h._n) return;
          if (!h._n.pan && DEFS[name].sp) this._rebuildLoop(h); // started 2D -> switch to spatial chain
          else this._updLoop(h);
        } catch (e) { this._warn(e); }
      },
    };
    try {
      if (!DEFS[name]) { h._stopped = true; return h; }
      if (!this.ctx) this._pending.add(h);
      else this._startLoop(h);
    } catch (e) { this._warn(e); }
    return h;
  }

  startAmbient() {
    try {
      if (this._ambOn) return;
      this._ambOn = true;
      if (!this.ctx) return;
      if (!this._ambBed) this._ambBed = this.loop('ambient');
      if (this._windAngle === undefined) this._windAngle = Math.random() * TAU;
      for (const ev of AMB_EVENTS) this._schedAmb(ev, true);
    } catch (e) { this._warn(e); }
  }

  stopAmbient() {
    try {
      this._ambOn = false;
      for (const id of this._ambTimers.values()) clearTimeout(id);
      this._ambTimers.clear();
      if (this._ambBed) { this._stopLoop(this._ambBed, 1.2); this._ambBed = null; }
    } catch (e) { this._warn(e); }
  }

  // extras (debug / tests)
  renderAll() { if (!this.ctx) return 0; const t0 = now(); for (const n of SOUNDS) this._get(n); return now() - t0; }
  stats() {
    return {
      unlocked: !!this.ctx, state: this.ctx ? this.ctx.state : 'locked', voices: this.voices.length, loops: this.loops.size,
      hrtf: this._hrtfCount(), rendered: this._bufs.size, total: SOUNDS.length, ...this._info,
    };
  }

  // ---- internals
  _warn(e) { if (this._warned++ < 5) console.warn('[audio]', e && e.message ? e.message : e); }
  _resume() { try { if (this.ctx.state !== 'running') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); } } catch (e) { /* ignore */ } }

  _build() {
    const c = this.ctx;
    this.mix = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 12; this.comp.ratio.value = 3; this.comp.attack.value = 0.004; this.comp.release.value = 0.22;
    this.lim = c.createDynamicsCompressor();
    this.lim.threshold.value = -2.5; this.lim.knee.value = 0; this.lim.ratio.value = 20; this.lim.attack.value = 0.001; this.lim.release.value = 0.08;
    this.masterGain = c.createGain(); this.masterGain.gain.value = this._vol;
    this.mix.connect(this.comp); this.comp.connect(this.lim); this.lim.connect(this.masterGain); this.masterGain.connect(c.destination);
    this.buses = {};
    for (const b of ['sfx', 'ui', 'amb']) { const g = c.createGain(); g.gain.value = this._busVol[b]; g.connect(this.mix); this.buses[b] = g; }
    this.revIn = c.createGain(); this.revIn.gain.value = 0.5;
    this.conv = c.createConvolver(); this.conv.buffer = this._makeIR();
    this.revIn.connect(this.conv); this.conv.connect(this.buses.sfx);
  }

  // outdoor town IR: sparse early reflections off facades + darkening diffuse tail (~1.4 s RT60)
  _makeIR() {
    const c = this.ctx, sr = c.sampleRate, len = Math.floor(sr * 1.9), b = c.createBuffer(2, len, sr), r = mulberry32(1234);
    for (let ch = 0; ch < 2; ch++) {
      const d = new Float32Array(len);
      for (let k = 0; k < 12; k++) { const t = 0.012 + r() * 0.14; d[Math.floor(t * sr)] += (r() < 0.5 ? -1 : 1) * (0.9 - t * 3) * (0.5 + 0.5 * r()); }
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, e = Math.exp(-t / 0.2) * Math.min(1, t / 0.02), a = 1 - (0.25 + 0.7 * Math.min(1, t / 1.2));
        lp += (r() * 2 - 1 - lp) * a;
        d[i] += lp * e * 0.6;
      }
      const fo = Math.floor(sr * 0.05);
      for (let i = 0; i < fo; i++) d[len - 1 - i] *= i / fo;
      b.getChannelData(ch).set(d);
    }
    return b;
  }

  // synchronous render (main thread) unless already available
  _get(name) {
    const a = this._bufs.get(name);
    if (a) return a;
    const def = DEFS[name];
    if (!def || !this.ctx) return null;
    const t0 = now(), vars = [];
    for (let k = 0; k < (def.v || 1); k++) vars.push(renderSound(name, k, this.ctx.sampleRate));
    this._info.renderMs[name] = +(now() - t0).toFixed(1);
    return this._install(name, vars);
  }

  _install(name, vars) {
    if (this._bufs.has(name)) return this._bufs.get(name);
    const def = DEFS[name], sr = Math.round(this.ctx.sampleRate * (def.srf || 1));
    const a = vars.map((chs) => {
      const b = this.ctx.createBuffer(chs.length, chs[0].length, sr);
      chs.forEach((d, i) => (b.copyToChannel ? b.copyToChannel(d, i) : b.getChannelData(i).set(d)));
      return b;
    });
    this._bufs.set(name, a);
    const w = this._waiting.get(name);
    if (w) { this._waiting.delete(name); for (const h of w) this._startLoop(h); }
    return a;
  }

  // Background rendering of everything not eager: in a module Worker (same file) when possible,
  // otherwise main-thread slices of ~8 ms.
  _scheduleBg() {
    const pri = ['ambient', 'countdown_tick', 'round_start', 'heartbeat', 'draw', 'reload_rifle', 'reload_pistol', 'reload_mg', 'zombie_growl', 'zombie_attack', 'zombie_hit'];
    const rank = (n) => { const i = pri.indexOf(n); return i < 0 ? 99 : i; };
    this._queue = SOUNDS.filter((n) => !this._bufs.has(n)).sort((a, b) => rank(a) - rank(b));
    this._bgT0 = now();
    if (!this._startWorker()) this._bgSlices();
  }

  _startWorker() {
    if (typeof Worker === 'undefined') return false;
    let w;
    try { w = new Worker(new URL('./audio.js', import.meta.url), { type: 'module' }); } catch (e) { return false; }
    this._worker = w;
    this._info.worker = 'running';
    w.onmessage = (e) => {
      const { name, vars, error, ms } = e.data || {};
      if (name !== this._inflight) return;
      this._inflight = null;
      try {
        if (!error && vars) { this._info.renderMs[name] = ms; this._install(name, vars); }
        else if (error) this._warn(error);
      } catch (err) { this._warn(err); }
      this._workerNext();
    };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); this._workerFail(); };
    w.onmessageerror = () => this._workerFail();
    this._workerNext();
    return true;
  }

  _workerNext() {
    if (!this._worker) return;
    while (this._queue.length && this._bufs.has(this._queue[0])) this._queue.shift();
    if (!this._queue.length) {
      this._worker.terminate(); this._worker = null;
      this._info.worker = 'done'; this._bgDone();
      return;
    }
    this._inflight = this._queue.shift();
    this._worker.postMessage({ name: this._inflight, sr: this.ctx.sampleRate });
  }

  _workerFail() {
    if (!this._worker) return;
    try { this._worker.terminate(); } catch (e) { /* ignore */ }
    this._worker = null;
    this._info.worker = 'failed';
    if (this._inflight) { this._queue.unshift(this._inflight); this._inflight = null; }
    this._bgSlices();
  }

  _bgSlices() {
    const step = () => {
      try {
        const t0 = now();
        while (this._queue.length && now() - t0 < 8) { const n = this._queue.shift(); if (!this._bufs.has(n)) this._get(n); }
        if (this._queue.length) setTimeout(step, 20); else this._bgDone();
      } catch (e) { this._warn(e); }
    };
    setTimeout(step, 60);
  }

  _bgDone() {
    this._info.bgDone = true;
    this._info.bgMs = Math.round(now() - this._bgT0);
    for (const [name, set] of this._waiting) { this._waiting.delete(name); if (this._get(name)) for (const h of set) this._startLoop(h); }
  }

  // is `name` about to arrive from the worker? (then loops wait instead of rendering on the main thread)
  _deferToWorker(name) {
    if (!this._worker || this._bufs.has(name)) return false;
    if (this._inflight !== name) {
      const i = this._queue.indexOf(name);
      if (i < 0) return false;
      this._queue.splice(i, 1); this._queue.unshift(name);
    }
    return true;
  }

  _applyListener() {
    const l = this.ctx.listener, p = this._lp, fx = -Math.sin(this._yaw), fz = -Math.cos(this._yaw);
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  _dist(p) { const dx = (+p.x || 0) - this._lp.x, dy = (+p.y || 0) - this._lp.y, dz = (+p.z || 0) - this._lp.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

  _panner(sp, hrtf) {
    const p = this.ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse'; p.refDistance = sp.ref; p.rolloffFactor = sp.roll; p.maxDistance = 10000;
    p.coneInnerAngle = 360; p.coneOuterAngle = 360;
    p.channelCount = 1; p.channelCountMode = 'explicit';
    return p;
  }
  _setPannerPos(p, pos) {
    const x = +pos.x || 0, y = +pos.y || 0, z = +pos.z || 0;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
  }
  _hrtfCount() { let n = 0; for (const v of this.voices) if (v.hrtf) n++; for (const h of this.loops) if (h._n && h._n.hrtf) n++; return n; }

  _pickVar(name, n) {
    if (n <= 1) return 0;
    let k = Math.floor(Math.random() * n);
    if (k === this._lastVar[name]) k = (k + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this._lastVar[name] = k;
    return k;
  }

  // voice limiting: per-sound instance cap + global cap; victims = lowest (priority * remaining life)
  _makeRoom(name, def, pr) {
    const t = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => !v.done && t < v.t0 + v.dur + 0.5);
    const score = (v) => v.pr * (1 - clamp((t - v.t0) / v.dur, 0, 1));
    let same = 0, worstSame = null;
    for (const v of this.voices) if (v.name === name) { same++; if (!worstSame || score(v) < score(worstSame)) worstSame = v; }
    if (same >= (def.max || 6) && worstSame) this._kill(worstSame);
    if (this.voices.length >= MAX_VOICES) {
      let worst = null;
      for (const v of this.voices) if (!worst || score(v) < score(worst)) worst = v;
      if (worst && score(worst) > pr) return false;
      if (worst) this._kill(worst);
    }
    return true;
  }

  _kill(v) {
    if (!v || v.done) return;
    v.done = true;
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    try {
      const t = this.ctx.currentTime;
      v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + 0.03);
      v.src.stop(t + 0.04);
    } catch (e) { this._cleanup(v); }
  }

  _cleanup(v) {
    v.done = true;
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    for (const n of [v.src, v.g, v.lp, v.pan, v.send]) if (n) try { n.disconnect(); } catch (e) { /* ignore */ }
  }

  _startLoop(h) {
    if (h._stopped || h._n) return;
    if (this._deferToWorker(h.name)) {
      if (!this._waiting.has(h.name)) this._waiting.set(h.name, new Set());
      this._waiting.get(h.name).add(h);
      return;
    }
    const def = DEFS[h.name], bufs = this._get(h.name);
    if (!bufs) return;
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    src.loop = true;
    src.playbackRate.value = clamp(h._rate, 0.25, 4);
    const g = c.createGain(); g.gain.value = 0;
    src.connect(g);
    const n = { src, g, lp: null, pan: null, send: null, hrtf: false };
    const bus = this.buses[def.bus || 'sfx'];
    if (h._pos && def.sp) {
      n.lp = c.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.Q.value = 0.5;
      n.hrtf = this._hrtfCount() < MAX_HRTF;
      n.pan = this._panner(SP[def.sp], n.hrtf);
      g.connect(n.lp); n.lp.connect(n.pan); n.pan.connect(bus);
    } else g.connect(bus);
    if (def.rev > 0) { n.send = c.createGain(); n.send.gain.value = 0; (n.lp || g).connect(n.send); n.send.connect(this.revIn); }
    src.start(c.currentTime, h.name === 'heartbeat' ? 0 : Math.random() * src.buffer.duration);
    h._n = n;
    this.loops.add(h);
    this._updLoop(h, 0.08);
  }

  _updLoop(h, tc = 0.05) {
    const n = h._n, def = DEFS[h.name], t = this.ctx.currentTime;
    const vol = Math.max(0, h._vol) * def.gain;
    let rs = def.rev * 0.6;
    if (n.pan && h._pos) {
      const d = this._dist(h._pos);
      this._setPannerPos(n.pan, h._pos);
      n.lp.frequency.setTargetAtTime(lpHz(d), t, 0.05);
      rs = def.rev * revGain(SP[def.sp], d);
    }
    n.g.gain.setTargetAtTime(vol, t, tc);
    if (n.send) n.send.gain.setTargetAtTime(rs, t, tc);
  }

  _rebuildLoop(h) {
    const n = h._n;
    h._n = null;
    this.loops.delete(h);
    const t = this.ctx.currentTime;
    n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(n.g.gain.value, t); n.g.gain.linearRampToValueAtTime(0, t + 0.06);
    n.src.stop(t + 0.08);
    n.src.onended = () => { for (const x of [n.src, n.g, n.lp, n.pan, n.send]) if (x) try { x.disconnect(); } catch (e) { /* ignore */ } };
    this._startLoop(h);
  }

  _stopLoop(h, fade = 0.15) {
    try {
      h._stopped = true;
      this._pending.delete(h);
      for (const set of this._waiting.values()) set.delete(h);
      const n = h._n;
      if (!n) return;
      h._n = null;
      this.loops.delete(h);
      const t = this.ctx.currentTime;
      n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(n.g.gain.value, t); n.g.gain.linearRampToValueAtTime(0, t + fade);
      n.src.stop(t + fade + 0.02);
      n.src.onended = () => { for (const x of [n.src, n.g, n.lp, n.pan, n.send]) if (x) try { x.disconnect(); } catch (e) { /* ignore */ } };
    } catch (e) { this._warn(e); }
  }

  _schedAmb(ev, first) {
    const delay = rand(ev.every[0], ev.every[1]) * (first ? ev.first : 1);
    const id = setTimeout(() => {
      this._ambTimers.delete(ev.name);
      if (!this._ambOn) return;
      try { this._ambEvent(ev); } catch (e) { this._warn(e); }
      this._schedAmb(ev, false);
    }, delay * 1000);
    this._ambTimers.set(ev.name, id);
  }

  _ambEvent(ev) {
    const vol = rand(ev.vol[0], ev.vol[1]);
    if (!ev.dist) { this.play(ev.name, { volume: vol }); return; }
    const a = ev.fixed ? this._windAngle + rand(-0.15, 0.15) : Math.random() * TAU, d = rand(ev.dist[0], ev.dist[1]);
    this.play(ev.name, { volume: vol, pos: { x: this._lp.x + Math.sin(a) * d, y: rand(ev.y[0], ev.y[1]), z: this._lp.z + Math.cos(a) * d } });
  }
}

export const audio = new AudioSys();

// When this same file is loaded as a module Worker, it serves background render requests.
/* global WorkerGlobalScope */
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (e) => {
    const { name, sr } = e.data || {};
    try {
      const t0 = now(), def = DEFS[name], vars = [];
      for (let k = 0; k < (def.v || 1); k++) vars.push(renderSound(name, k, sr));
      self.postMessage({ name, vars, ms: +(now() - t0).toFixed(1) }, vars.flat().map((a) => a.buffer));
    } catch (err) {
      self.postMessage({ name, error: String((err && err.message) || err) });
    }
  };
}

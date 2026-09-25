// First-person viewmodel: arms + weapon rig with procedural animation.
// Rendered by the game as a second pass (depth cleared) using this.scene / this.camera.
// Camera sits at the origin of its own scene looking down -Z.
import * as THREE from 'three';
import { createWeaponModel, getDawnEnvironment, canvasTexture, fbm, Tex, getWeaponMaterial } from './models.js';

// ---------------------------------------------------------------------------
// small math helpers (allocation free)
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const k = (u, a, b) => sstep((u - a) / (b - a)); // smooth 0->1 between a and b
const lin = (u, a, b) => clamp((u - a) / (b - a), 0, 1);
const pulse = (u, a, b, c, d) => k(u, a, b) * (1 - k(u, c, d));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeOutBack = (t) => { t = clamp(t, 0, 1); const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

class Spring {
  constructor(stiff = 200, zeta = 0.6) { this.k = stiff; this.c = 2 * Math.sqrt(stiff) * zeta; this.x = 0; this.v = 0; this.target = 0; }
  update(dt) {
    // semi-implicit Euler with sub-steps for stability
    const n = Math.ceil(dt / 0.008);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset() { this.x = this.v = 0; }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _mInv = new THREE.Matrix4();
const _e1 = new THREE.Euler();
const _s1 = new THREE.Vector3(1, 1, 1);

// quaternion from "fingers point along f, back of hand faces b" (hand local: fingers -Z, back +Y)
function handQuat(f, b, out = new THREE.Quaternion()) {
  const z = _v1.set(-f[0], -f[1], -f[2]).normalize();
  const y = _v2.set(b[0], b[1], b[2]);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = _v3.crossVectors(y, z);
  _m1.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m1);
}

function mirrorSpec(s) {
  if (!s) return s;
  return { ...s, p: [-s.p[0], s.p[1], s.p[2]], f: [-s.f[0], s.f[1], s.f[2]], b: [-s.b[0], s.b[1], s.b[2]] };
}

function prepSpec(s) {
  if (s && !s._q) { s._q = handQuat(s.f, s.b); s._p = new THREE.Vector3().fromArray(s.p); }
  return s;
}

// ---------------------------------------------------------------------------
// Arm / skin textures
// ---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function pixels(ctx, W, H, fn) {
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const c = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    fn(x, y, i, c);
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function drawCamo(ctx, W, H) {
  const n1 = fbm(W, H, 3, 6, 4, 201), n2 = fbm(W, H, 4, 8, 4, 202), n3 = fbm(W, H, 6, 12, 3, 203), g = fbm(W, H, 64, 64, 1, 204);
  pixels(ctx, W, H, (x, y, i, c) => {
    let r = 176, gg = 156, b = 116;
    if (n1[i] > 0.55) { r = 140; gg = 116; b = 82; }
    if (n2[i] > 0.6) { r = 112; gg = 108; b = 74; }
    if (n3[i] > 0.64) { r = 84; gg = 66; b = 48; }
    if (n3[i] < 0.3) { r = 204; gg = 190; b = 152; }
    const weave = ((x >> 1) + (y >> 1)) % 2 ? 0.93 : 1.05;
    const f = weave * (0.92 + g[i] * 0.16);
    c[0] = r * f; c[1] = gg * f; c[2] = b * f;
  });
}

function drawWeave(ctx, W, H) {
  const g = fbm(W, H, 32, 32, 2, 211);
  pixels(ctx, W, H, (x, y, i, c) => {
    const w = (Math.sin(x * Math.PI / 2) * Math.sin(y * Math.PI / 2)) * 0.5 + 0.5;
    const v = 0.35 + 0.4 * w + 0.25 * g[i];
    c[0] = c[1] = c[2] = clamp01(v) * 255;
  });
}

function drawGlove(ctx, W, H) {
  const n = fbm(W, H, 8, 8, 4, 221), g = fbm(W, H, 64, 64, 1, 222);
  pixels(ctx, W, H, (x, y, i, c) => {
    const w = ((x >> 1) + (y >> 1)) % 2 ? 0.94 : 1.04;
    const v = (0.85 + n[i] * 0.25) * w * (0.95 + g[i] * 0.1);
    c[0] = 84 * v; c[1] = 76 * v; c[2] = 62 * v;
  });
}

function drawZombie(ctx, W, H) {
  const n = fbm(W, H, 4, 4, 5, 231), m = fbm(W, H, 8, 8, 4, 232), s = fbm(W, H, 3, 3, 4, 233), p = fbm(W, H, 32, 32, 2, 234);
  pixels(ctx, W, H, (x, y, i, c) => {
    let r = 122, g = 132, b = 106;
    const t = n[i];
    r = lerp(r, 78, t * 0.9); g = lerp(g, 90, t * 0.9); b = lerp(b, 70, t * 0.9);
    if (m[i] > 0.62) { const q = (m[i] - 0.62) * 3; r = lerp(r, 96, q); g = lerp(g, 70, q); b = lerp(b, 62, q); }
    if (s[i] > 0.68) { const q = clamp01((s[i] - 0.68) * 5); r = lerp(r, 120, q); g = lerp(g, 30, q); b = lerp(b, 26, q); }
    const f = 0.88 + p[i] * 0.24;
    c[0] = r * f; c[1] = g * f; c[2] = b * f;
  });
  // veins
  const R = mulberry(5);
  ctx.lineCap = 'round';
  for (let v = 0; v < 26; v++) {
    let x = R() * W, y = R() * H;
    let a = R() * 6.28;
    ctx.strokeStyle = `rgba(52,40,64,${0.25 + R() * 0.3})`;
    ctx.lineWidth = 0.8 + R() * 1.6;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s2 = 0; s2 < 30; s2++) { a += (R() - 0.5) * 0.8; x += Math.cos(a) * 5; y += Math.sin(a) * 5; ctx.lineTo(x, y); }
    ctx.stroke();
  }
}

function drawMother(ctx, W, H) {
  const n = fbm(W, H, 4, 4, 5, 241), f = fbm(W, H, 3, 48, 3, 242), s = fbm(W, H, 5, 5, 4, 243);
  pixels(ctx, W, H, (x, y, i, c) => {
    // muscle striations along v (arm length) = y
    const fib = 0.5 + 0.5 * Math.sin((x / W) * 90 + f[i] * 12);
    let r = 150 - 50 * n[i], g = 52 - 20 * n[i], b = 48 - 16 * n[i];
    r *= 0.8 + 0.3 * fib; g *= 0.75 + 0.3 * fib; b *= 0.75 + 0.3 * fib;
    if (s[i] > 0.66) { const q = clamp01((s[i] - 0.66) * 4); r = lerp(r, 110, q); g = lerp(g, 100, q); b = lerp(b, 78, q); }
    if (s[i] < 0.28) { const q = clamp01((0.28 - s[i]) * 5); r = lerp(r, 60, q); g = lerp(g, 14, q); b = lerp(b, 16, q); }
    c[0] = r; c[1] = g; c[2] = b;
  });
}

function drawTermSkin(ctx, W, H) {
  const n = fbm(W, H, 6, 6, 5, 251), cr = fbm(W, H, 16, 16, 3, 252);
  pixels(ctx, W, H, (x, y, i, c) => {
    let v = 0.75 + n[i] * 0.4;
    const crack = Math.abs(cr[i] - 0.5);
    if (crack < 0.025) v *= 0.45;
    c[0] = 50 * v; c[1] = 52 * v; c[2] = 58 * v;
  });
}

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function drawVeins(ctx, W, H) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const R = mulberry(9);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const branch = (x, y, a, len, w, depth) => {
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < len; s++) {
      a += (R() - 0.5) * 0.9;
      x += Math.cos(a) * 4; y += Math.sin(a) * 4;
      ctx.lineTo(x, y);
      if (depth < 2 && R() < 0.07) { ctx.stroke(); branch(x, y, a + (R() < 0.5 ? 0.8 : -0.8), len * 0.5, w * 0.6, depth + 1); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x, y); }
    }
    ctx.stroke();
  };
  for (let pass = 0; pass < 2; pass++) {
    ctx.shadowColor = 'rgba(120,230,255,1)';
    ctx.shadowBlur = pass === 0 ? 10 : 0;
    ctx.strokeStyle = pass === 0 ? 'rgba(90,200,255,0.9)' : 'rgba(230,255,255,1)';
    const R2 = mulberry(9);
    const saved = R;
    for (let v = 0; v < 14; v++) {
      const x = R2() * W, y = R2() * H * 0.2 + (v % 2) * H * 0.5;
      branch(x, y, Math.PI / 2 + (R2() - 0.5) * 0.6, 30 + R2() * 30, pass === 0 ? 3.2 : 1.2, 0);
    }
    void saved;
  }
}

function drawClaw(ctx, W, H) {
  // along v: base (v=0) bone-yellow -> tip dark
  const g = ctx.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, '#6b5a44');
  g.addColorStop(0.25, '#d8cba6');
  g.addColorStop(0.7, '#a89770');
  g.addColorStop(1, '#2a2118');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const R = mulberry(3);
  ctx.strokeStyle = 'rgba(60,40,20,0.35)';
  for (let i = 0; i < 20; i++) { const x = R() * W; ctx.beginPath(); ctx.moveTo(x, H * R()); ctx.lineTo(x + (R() - 0.5) * 4, H * R()); ctx.stroke(); }
}

function drawTrailGrad(ctx, W, H) {
  // v=0 base (transparent) .. v=1 tip (bright)
  pixels(ctx, W, H, (x, y, i, c) => {
    const v = 1 - (y + 0.5) / H;
    const val = Math.pow(v, 2.4) * 0.6 + 0.5 * Math.exp(-Math.pow((v - 0.94) * 14, 2));
    c[0] = c[1] = c[2] = clamp01(val) * 255;
  });
}

// ---------------------------------------------------------------------------
// Arm materials (cached, shared)
// ---------------------------------------------------------------------------
const AMATS = new Map();
function amat(key) {
  let m = AMATS.get(key);
  if (m) return m;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  switch (key) {
    case 'sleeve': {
      const t = canvasTexture('camo', 512, 512, drawCamo);
      m = std({ map: t, roughness: 0.93, metalness: 0, bumpMap: canvasTexture('weave', 64, 64, drawWeave, { srgb: false }), bumpScale: 0.8 });
      break;
    }
    case 'sleeveDark': m = std({ color: 0x5a4c38, roughness: 0.95, bumpMap: canvasTexture('weave', 64, 64, drawWeave, { srgb: false }), bumpScale: 0.8 }); break;
    case 'glove': m = std({ map: canvasTexture('glove', 128, 128, drawGlove), roughness: 0.78, metalness: 0.05, bumpMap: canvasTexture('weave', 64, 64, drawWeave, { srgb: false }), bumpScale: 0.5 }); break;
    case 'gloveTan': m = std({ color: 0x8c7556, roughness: 0.8, bumpMap: Tex.stipple(), bumpScale: 0.4 }); break;
    case 'pad': m = std({ color: 0x2c2c2e, roughness: 0.5, metalness: 0.1 }); break;
    case 'zombie': { const t = canvasTexture('zskin', 512, 512, drawZombie); m = std({ map: t, bumpMap: canvasTexture('zskin', 512, 512, drawZombie, { srgb: false }), bumpScale: 2.0, roughness: 0.62, metalness: 0 }); break; }
    case 'mother': { const t = canvasTexture('mskin', 512, 512, drawMother); m = std({ map: t, bumpMap: canvasTexture('mskin', 512, 512, drawMother, { srgb: false }), bumpScale: 2.5, roughness: 0.45, metalness: 0 }); break; }
    case 'claw': m = std({ map: canvasTexture('claw', 16, 128, drawClaw, { repeat: false }), roughness: 0.35, metalness: 0.05 }); break;
    case 'motherClaw': m = std({ map: canvasTexture('claw', 16, 128, drawClaw, { repeat: false }), color: 0xd8a0a0, roughness: 0.3 }); break;
    case 'term': m = std({
      map: canvasTexture('tskin', 512, 512, drawTermSkin), bumpMap: canvasTexture('tskin', 512, 512, drawTermSkin, { srgb: false }), bumpScale: 2.5,
      emissiveMap: canvasTexture('tveins', 512, 512, drawVeins), emissive: new THREE.Color(0.35, 0.9, 1.0), emissiveIntensity: 1.2, roughness: 0.7, metalness: 0.15,
    }); break;
    case 'termPlate': m = std({ color: 0x24262a, roughness: 0.45, metalness: 0.6, map: Tex.scratchCol(), emissiveMap: canvasTexture('tveins', 512, 512, drawVeins), emissive: new THREE.Color(0.35, 0.9, 1.0), emissiveIntensity: 0.6 }); break;
    case 'gold': m = getWeaponMaterial('gold'); break;
    case 'hunterBlack': m = std({ color: 0x1a1a1d, roughness: 0.55, metalness: 0.35, bumpMap: canvasTexture('weave', 64, 64, drawWeave, { srgb: false }), bumpScale: 0.6 }); break;
    case 'hunterGlow': m = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.5, 0.5) }); break;
    default: throw new Error('arm mat ' + key);
  }
  m.name = 'arm_' + key;
  AMATS.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// Arm style definitions
// ---------------------------------------------------------------------------
const FINGERS = [
  { k: [-0.0275, 0.002, -0.089], L: [0.040, 0.024, 0.020], r: 0.0088 },
  { k: [-0.009, 0.003, -0.093], L: [0.044, 0.027, 0.021], r: 0.0091 },
  { k: [0.0095, 0.002, -0.09], L: [0.041, 0.026, 0.02], r: 0.0086 },
  { k: [0.026, -0.001, -0.083], L: [0.032, 0.02, 0.018], r: 0.0077 },
];
const THUMB = { k: [-0.025, -0.009, -0.02], L: [0.036, 0.03, 0.025], r: [0.0118, 0.0103, 0.0095] };

const STYLES = {
  human: {
    palm: [0.082, 0.029, 0.092], fr: 1.1, fl: 1.0, handMat: 'glove', fingerMat: 'glove', palmMat: 'glove', pad: true,
    fore: { len: 0.27, prof: [[-0.004, 0.0], [-0.004, 0.036], [0.012, 0.0385], [0.028, 0.0405], [0.036, 0.0395], [0.06, 0.039], [0.13, 0.043], [0.2, 0.047], [0.27, 0.048], [0.275, 0.0]], mat: 'sleeve', oval: [1.1, 0.9] },
    upper: { len: 0.3, prof: [[-0.01, 0.0], [-0.01, 0.046], [0.1, 0.052], [0.3, 0.056], [0.31, 0.0]], mat: 'sleeve' },
    wristCuff: { r: 0.037, len: 0.045, mat: 'glove' },
  },
  hunter: {
    palm: [0.084, 0.03, 0.094], fr: 1.12, fl: 1.0, handMat: 'hunterBlack', fingerMat: 'hunterBlack', palmMat: 'hunterBlack', plates: true,
    fore: { len: 0.27, prof: [[0.0, 0.036], [0.03, 0.042], [0.1, 0.047], [0.2, 0.053], [0.27, 0.055]], mat: 'hunterBlack', oval: [1.08, 0.94], bracer: true },
    upper: { len: 0.3, prof: [[0, 0.055], [0.1, 0.06], [0.3, 0.064]], mat: 'hunterBlack' },
    wristCuff: { r: 0.038, len: 0.04, mat: 'gold' },
  },
  zombie: {
    palm: [0.07, 0.024, 0.084], fr: 0.78, fl: 1.28, handMat: 'zombie', fingerMat: 'zombie', palmMat: 'zombie', claws: { len: 0.042, r: 0.0055, mat: 'claw' }, knobs: true,
    fore: { len: 0.27, prof: [[0.0, 0.024], [0.02, 0.026], [0.05, 0.029], [0.12, 0.034], [0.2, 0.037], [0.25, 0.035], [0.27, 0.036]], mat: 'zombie', oval: [1.15, 0.85], bones: true },
    upper: { len: 0.3, prof: [[0, 0.036], [0.1, 0.038], [0.3, 0.042]], mat: 'zombie' },
  },
  mother: {
    scale: 1.22, palm: [0.074, 0.026, 0.086], fr: 0.85, fl: 1.3, handMat: 'mother', fingerMat: 'mother', palmMat: 'mother', claws: { len: 0.058, r: 0.0068, mat: 'motherClaw' }, knobs: true,
    fore: { len: 0.27, prof: [[0.0, 0.027], [0.02, 0.03], [0.05, 0.034], [0.12, 0.04], [0.2, 0.044], [0.27, 0.042]], mat: 'mother', oval: [1.12, 0.88], bones: true },
    upper: { len: 0.3, prof: [[0, 0.042], [0.1, 0.046], [0.3, 0.05]], mat: 'mother' },
  },
  terminator: {
    scale: 1.0, palm: [0.125, 0.052, 0.112], fr: 1.95, fl: 1.08, handMat: 'term', fingerMat: 'term', palmMat: 'term', knuckles: true,
    fore: { len: 0.29, prof: [[0.0, 0.062], [0.03, 0.07], [0.08, 0.082], [0.16, 0.094], [0.24, 0.096], [0.29, 0.09]], mat: 'term', oval: [1.1, 0.95], plates: true },
    upper: { len: 0.3, prof: [[0, 0.09], [0.1, 0.1], [0.3, 0.11]], mat: 'term' },
  },
};

// Pose layout: 4 fingers * 3 curls, 4 spreads, thumb [yaw, pitch, roll, c1, c2, c3] => 22 floats
const P_LEN = 22;
function mkPose(f, s, t) { const a = new Float32Array(P_LEN); for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) a[i * 3 + j] = f[i][j]; for (let i = 0; i < 4; i++) a[12 + i] = s[i]; for (let i = 0; i < 6; i++) a[16 + i] = t[i]; return a; }
const POSES = {
  relax: mkPose([[0.25, 0.35, 0.2], [0.3, 0.4, 0.2], [0.35, 0.45, 0.25], [0.42, 0.5, 0.3]], [-0.08, -0.02, 0.04, 0.12], [0.4, -0.4, 0.8, 0.1, 0.3, 0.2]),
  grip: mkPose([[1.25, 1.45, 0.85], [1.35, 1.5, 0.85], [1.4, 1.5, 0.85], [1.45, 1.45, 0.8]], [-0.06, 0, 0.04, 0.1], [-0.05, -0.8, 1.2, 0.1, 0.5, 0.4]),
  trigger: mkPose([[0.75, 1.05, 0.6], [1.35, 1.5, 0.85], [1.4, 1.5, 0.85], [1.45, 1.45, 0.8]], [-0.02, 0, 0.04, 0.1], [-0.05, -0.8, 1.2, 0.1, 0.5, 0.4]),
  support: mkPose([[0.85, 0.95, 0.5], [0.9, 1.0, 0.5], [0.95, 1.0, 0.5], [1.0, 0.95, 0.45]], [-0.06, 0, 0.05, 0.12], [0.15, -0.6, 1.0, 0.1, 0.3, 0.2]),
  mgSupport: mkPose([[0.75, 0.9, 0.5], [0.8, 0.95, 0.5], [0.85, 0.95, 0.5], [0.9, 0.95, 0.45]], [-0.06, 0, 0.05, 0.12], [0.2, -0.55, 1.0, 0.1, 0.3, 0.2]),
  fist: mkPose([[1.5, 1.75, 1.15], [1.55, 1.8, 1.15], [1.55, 1.8, 1.15], [1.55, 1.75, 1.1]], [-0.04, 0, 0.03, 0.07], [0.0, -0.9, 1.3, 0.2, 0.7, 0.6]),
  knife: mkPose([[1.3, 1.55, 1.0], [1.4, 1.6, 1.0], [1.45, 1.6, 1.0], [1.5, 1.55, 0.95]], [-0.05, 0, 0.04, 0.09], [0.0, -0.85, 1.25, 0.15, 0.6, 0.5]),
  ball: mkPose([[0.75, 0.9, 0.6], [0.8, 0.95, 0.6], [0.85, 0.95, 0.6], [0.9, 0.95, 0.55]], [-0.14, -0.04, 0.06, 0.16], [0.25, -0.6, 1.0, 0.15, 0.4, 0.3]),
  claw: mkPose([[0.3, 0.55, 0.45], [0.25, 0.5, 0.45], [0.3, 0.55, 0.45], [0.4, 0.6, 0.45]], [-0.26, -0.08, 0.09, 0.28], [0.5, -0.3, 0.9, 0.1, 0.5, 0.5]),
  clawOpen: mkPose([[0.1, 0.35, 0.3], [0.05, 0.3, 0.3], [0.1, 0.35, 0.3], [0.15, 0.4, 0.3]], [-0.3, -0.1, 0.12, 0.32], [0.8, -0.1, 0.6, 0.0, 0.2, 0.2]),
  flat: mkPose([[0.12, 0.12, 0.06], [0.1, 0.1, 0.05], [0.12, 0.12, 0.06], [0.15, 0.15, 0.08]], [-0.05, -0.01, 0.03, 0.08], [0.5, -0.15, 0.5, 0.0, 0.1, 0.05]),
  magGrab: mkPose([[0.85, 1.0, 0.6], [0.9, 1.05, 0.6], [0.95, 1.05, 0.6], [1.0, 1.0, 0.55]], [-0.06, 0, 0.05, 0.1], [0.3, -0.5, 1.0, 0.1, 0.35, 0.25]),
  pinch: mkPose([[0.75, 0.9, 0.45], [1.2, 1.4, 0.9], [1.35, 1.45, 0.9], [1.4, 1.45, 0.85]], [-0.02, 0, 0.04, 0.1], [0.1, -0.45, 1.1, 0.2, 0.5, 0.4]),
  palmPush: mkPose([[0.2, 0.25, 0.1], [0.2, 0.25, 0.1], [0.25, 0.3, 0.12], [0.3, 0.35, 0.15]], [-0.06, 0, 0.04, 0.1], [0.5, -0.15, 0.6, 0.05, 0.1, 0.05]),
};

// ---------------------------------------------------------------------------
// Geometry cache for arms
// ---------------------------------------------------------------------------
const AGEO = new Map();
function ageo(key, make) { let g = AGEO.get(key); if (!g) { g = make(); AGEO.set(key, g); } return g; }

function capsuleZ(r, len, radial = 10) {
  // capsule centered at z = -len/2 spanning joint (0) to next joint (-len)
  const g = new THREE.CapsuleGeometry(r, len, 4, radial);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, -len / 2);
  return g;
}

function latheAlongZ(prof, seg, oval) {
  // prof: [z, r] from z=0 upward; lathe revolves around Y -> rotate so Y -> +Z
  const pr = prof.slice();
  if (pr[0][1] > 0) pr.unshift([pr[0][0], 0]);
  if (pr[pr.length - 1][1] > 0) pr.push([pr[pr.length - 1][0], 0]);
  const pts = pr.map(([z, r]) => new THREE.Vector2(Math.max(r, 1e-4), z));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(Math.PI / 2); // +Y -> +Z
  if (oval) g.scale(oval[0], oval[1], 1);
  // uv: u around, v along -> repeat for fabric
  return g;
}

function clawGeo(len, r) {
  const pts = [];
  const N = 8;
  for (let i = 0; i <= N; i++) { const t = i / N; pts.push(new THREE.Vector2(r * (1 - t) * (1 - 0.3 * t) + 0.0002, t * len)); }
  const g = new THREE.LatheGeometry(pts, 8);
  g.rotateX(-Math.PI / 2); // +Y -> -Z
  // flatten sideways & bend down (toward palm, -Y)
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i); const t = -z / len;
    p.setX(i, p.getX(i) * 0.75);
    p.setY(i, p.getY(i) * 1.1 - t * t * len * 0.55);
  }
  g.computeVertexNormals();
  return g;
}

// small rounded pad (box with softened edges)
class RoundedPad extends THREE.BufferGeometry {
  constructor(w, h, d) {
    super();
    const g = new THREE.CapsuleGeometry(0.5, 0.6, 3, 10);
    g.rotateZ(Math.PI / 2);
    g.scale(w / 1.6, h, d);
    this.copy(g);
    g.dispose();
  }
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------
class Hand {
  constructor(styleKey) {
    const st = STYLES[styleKey];
    this.root = new THREE.Group();
    this.root.name = 'hand';
    const S = st.scale || 1;
    this.root.scale.setScalar(S);
    const pw = st.palm[0], ph = st.palm[1], pl = st.palm[2];
    const wx = pw / 0.082;
    const handM = amat(st.handMat), fingM = amat(st.fingerMat);
    // palm (tapered rounded box)
    const palmG = ageo('palm:' + styleKey, () => {
      const g = new THREE.CapsuleGeometry(0.5, 0.2, 6, 14);
      // squash capsule into a palm block: unit capsule -> scale
      g.rotateX(Math.PI / 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const t = (z + 0.6) / 1.2; // 0 at -z end (fingers), 1 at wrist
        x *= pw * lerp(1.0, 0.8, clamp(t, 0, 1)) * 1.02;
        y *= ph * (y > 0 ? 1.0 : 1.1);
        z = lerp(-pl, -0.004, clamp(t, 0, 1));
        // arch: back of hand slightly domed
        y += (1 - Math.pow(Math.abs(x) / (pw * 0.6), 2)) * ph * 0.12;
        p.setXYZ(i, x, y, z);
      }
      g.computeVertexNormals();
      return g;
    });
    this.root.add(new THREE.Mesh(palmG, amat(st.palmMat)));
    // thenar muscle
    const thenar = new THREE.Mesh(ageo('thenar:' + styleKey, () => new THREE.SphereGeometry(1, 12, 10)), amat(st.palmMat));
    thenar.scale.set(0.017 * wx, 0.013 * (ph / 0.029), 0.03);
    thenar.position.set(-0.022 * wx, -0.009 * (ph / 0.029), -0.03);
    thenar.rotation.y = -0.4;
    this.root.add(thenar);
    // wrist cuff
    if (st.wristCuff) {
      const c = st.wristCuff;
      const cg = ageo('cuff:' + styleKey, () => { const g = new THREE.CylinderGeometry(c.r, c.r * 1.02, c.len, 16, 1, false); g.rotateX(Math.PI / 2); g.scale(1.12, 0.78, 1); g.translate(0, 0, 0.004); return g; });
      const cm = new THREE.Mesh(cg, amat(c.mat));
      this.root.add(cm);
      if (styleKey === 'human') {
        const strap = new THREE.Mesh(ageo('strap', () => { const g = new THREE.BoxGeometry(0.05, 0.006, 0.022); return g; }), amat('pad'));
        strap.position.set(0.004, 0.03, 0.008);
        this.root.add(strap);
      }
    }
    // knuckle protector / back plates
    if (st.pad) {
      const back = new THREE.Mesh(ageo('backpad', () => new RoundedPad(0.05, 0.006, 0.036)), amat('pad'));
      back.position.set(0.002, 0.0172, -0.052);
      back.rotation.x = 0.05;
      this.root.add(back);
    }
    if (st.plates) {
      const plate = new THREE.Mesh(ageo('hplate', () => new THREE.BoxGeometry(0.078, 0.01, 0.075)), amat('gold'));
      plate.position.set(0, 0.019, -0.052);
      this.root.add(plate);
      const glow = new THREE.Mesh(ageo('hglow', () => new THREE.BoxGeometry(0.004, 0.012, 0.06)), amat('hunterGlow'));
      glow.position.set(0, 0.02, -0.052);
      this.root.add(glow);
    }
    if (st.knuckles) {
      for (let i = 0; i < 4; i++) {
        const kn = new THREE.Mesh(ageo('tknuckle', () => new THREE.IcosahedronGeometry(1, 1)), amat('termPlate'));
        kn.scale.set(0.017, 0.014, 0.017);
        kn.position.set(FINGERS[i].k[0] * wx, ph * 0.45, FINGERS[i].k[2] * (pl / 0.092) + 0.004);
        this.root.add(kn);
      }
    }
    if (st.bonesHand || st.knobs) {
      // tendons on the back of the hand
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(ageo('tendon:' + styleKey, () => capsuleZ(0.0035, pl * 0.75, 6)), handM);
        t.position.set(FINGERS[i].k[0] * wx * 0.9, ph * 0.42, -0.008);
        t.rotation.y = -FINGERS[i].k[0] * 1.2;
        this.root.add(t);
      }
    }

    // fingers
    this.f = [];
    for (let i = 0; i < 4; i++) {
      const F = FINGERS[i];
      const joints = [];
      let parent = this.root;
      for (let j = 0; j < 3; j++) {
        const jt = new THREE.Object3D();
        if (j === 0) jt.position.set(F.k[0] * wx, F.k[1] * (ph / 0.029), F.k[2] * (pl / 0.092));
        else jt.position.set(0, 0, -F.L[j - 1] * st.fl);
        jt.rotation.order = 'YXZ';
        parent.add(jt);
        const L = F.L[j] * st.fl;
        const r = F.r * st.fr * (j === 2 ? 0.9 : j === 1 ? 0.95 : 1);
        const seg = new THREE.Mesh(ageo(`fs:${styleKey}:${i}:${j}`, () => capsuleZ(r, L, 10)), fingM);
        jt.add(seg);
        if (st.knobs && j < 2) {
          const kn = new THREE.Mesh(ageo('knob:' + styleKey, () => new THREE.SphereGeometry(1, 8, 6)), fingM);
          kn.scale.setScalar(r * 1.25);
          kn.position.set(0, 0, -L);
          jt.add(kn);
        }
        if (st.pad && j === 0) {
          const kp = new THREE.Mesh(ageo(`kp:${i}`, () => { const g = new RoundedPad(r * 2.0, r * 0.7, 0.016); g.translate(0, r * 0.82, -0.006); return g; }), amat('pad'));
          jt.add(kp);
        }
        if (st.plates) {
          const pg = new THREE.Mesh(ageo(`fp:${i}:${j}`, () => { const g = new THREE.BoxGeometry(r * 2.1, r * 0.9, L * 0.8); g.translate(0, r * 0.75, -L / 2); return g; }), amat('gold'));
          jt.add(pg);
        }
        joints.push(jt);
        parent = jt;
      }
      if (st.claws) {
        const c = new THREE.Mesh(ageo('claw:' + styleKey, () => clawGeo(st.claws.len, st.claws.r)), amat(st.claws.mat));
        c.position.set(0, 0.001, -F.L[2] * st.fl * 0.95);
        joints[2].add(c);
      }
      this.f.push(joints);
    }
    // thumb
    const tj = [];
    let parent = this.root;
    for (let j = 0; j < 3; j++) {
      const jt = new THREE.Object3D();
      if (j === 0) jt.position.set(THUMB.k[0] * wx, THUMB.k[1] * (ph / 0.029), THUMB.k[2]);
      else jt.position.set(0, 0, -THUMB.L[j - 1] * st.fl * (j === 1 ? 0.95 : 1));
      jt.rotation.order = 'YXZ';
      parent.add(jt);
      const L = THUMB.L[j] * st.fl;
      const r = THUMB.r[j] * st.fr;
      const seg = new THREE.Mesh(ageo(`ts:${styleKey}:${j}`, () => capsuleZ(r, L, 10)), fingM);
      jt.add(seg);
      if (st.plates && j > 0) {
        const pg = new THREE.Mesh(ageo(`tp:${j}`, () => { const g = new THREE.BoxGeometry(r * 2.1, r * 0.9, L * 0.8); g.translate(0, r * 0.75, -L / 2); return g; }), amat('gold'));
        jt.add(pg);
      }
      tj.push(jt);
      parent = jt;
    }
    if (st.claws) {
      const c = new THREE.Mesh(ageo('claw:' + styleKey, () => clawGeo(st.claws.len, st.claws.r)), amat(st.claws.mat));
      c.position.set(0, 0.001, -THUMB.L[2] * st.fl * 0.9);
      tj[2].add(c);
    }
    this.t = tj;
    // fingertip marker (middle finger tip) for trails
    this.tip = new THREE.Object3D();
    this.tip.position.set(0, 0, -FINGERS[1].L[2] * st.fl - (st.claws ? st.claws.len * 0.8 : 0.01));
    this.f[1][2].add(this.tip);
    this.pose = new Float32Array(P_LEN);
    this.pose.set(POSES.relax);
  }
  apply(p, twitch) {
    for (let i = 0; i < 4; i++) {
      const J = this.f[i];
      const tw = twitch ? twitch[i] : 0;
      J[0].rotation.set(-(p[i * 3] + tw), p[12 + i], 0);
      J[1].rotation.set(-(p[i * 3 + 1] + tw * 0.8), 0, 0);
      J[2].rotation.set(-(p[i * 3 + 2] + tw * 0.6), 0, 0);
    }
    this.t[0].rotation.set(p[17] - p[19] * 0.4, p[16], p[18]);
    this.t[1].rotation.set(-p[20], 0, 0);
    this.t[2].rotation.set(-p[21], 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Arm (hand + IK forearm/upper arm)
// ---------------------------------------------------------------------------
class Arm {
  constructor(styleKey, side, scene, rig) {
    const st = STYLES[styleKey];
    this.side = side;
    this.style = st;
    this.mount = new THREE.Object3D();
    this.flip = new THREE.Group();
    this.flip.scale.x = side;
    this.mount.add(this.flip);
    this.hand = new Hand(styleKey);
    this.flip.add(this.hand.root);
    const S = st.scale || 1;
    this.foreLen = st.fore.len * S;
    this.upperLen = st.upper.len * S;
    this.group = new THREE.Group(); // camera-space container for forearm/upper
    scene.add(this.group);
    const foreG = ageo('fore:' + styleKey, () => latheAlongZ(st.fore.prof, 18, st.fore.oval));
    this.fore = new THREE.Group();
    const foreMesh = new THREE.Mesh(foreG, amat(st.fore.mat));
    this.fore.add(foreMesh);
    if (st.fore.cuff) {
      const c = st.fore.cuff;
      const cm = new THREE.Mesh(ageo('fcuff:' + styleKey, () => { const g = new THREE.TorusGeometry(c.r * 0.9, c.len * 0.5, 8, 20); g.scale(st.fore.oval[0], st.fore.oval[1], 1.4); return g; }), amat(st.fore.mat));
      cm.position.z = c.z;
      this.fore.add(cm);
      // rolled sleeve fold
      const fold = new THREE.Mesh(ageo('ffold:' + styleKey, () => { const g = new THREE.TorusGeometry(c.r * 0.98, 0.006, 6, 20); g.scale(st.fore.oval[0], st.fore.oval[1], 1); return g; }), amat(st.fore.mat));
      fold.position.z = c.z + 0.02;
      this.fore.add(fold);
    }
    if (st.fore.bracer) {
      const br = new THREE.Mesh(ageo('bracer', () => {
        const g = latheAlongZ([[0.015, 0.041], [0.03, 0.046], [0.14, 0.052], [0.19, 0.056], [0.2, 0.052]], 16, [1.12, 0.98]);
        return g;
      }), amat('gold'));
      this.fore.add(br);
      for (const z of [0.05, 0.1, 0.15]) {
        const ring = new THREE.Mesh(ageo('bring', () => { const g = new THREE.TorusGeometry(0.052, 0.0022, 5, 24); g.scale(1.12, 0.98, 1); return g; }), amat('hunterGlow'));
        ring.position.z = z;
        ring.scale.setScalar(0.92 + z * 0.5);
        this.fore.add(ring);
      }
      const spine = new THREE.Mesh(ageo('bspine', () => new THREE.BoxGeometry(0.012, 0.012, 0.16)), amat('hunterBlack'));
      spine.position.set(0, 0.055, 0.1);
      this.fore.add(spine);
    }
    if (st.fore.bones) {
      // protruding ulna ridge + wounds bumps
      const ridge = new THREE.Mesh(ageo('ridge:' + styleKey, () => capsuleZ(0.009, 0.2, 8)), amat(st.fore.mat));
      ridge.position.set(0.018, 0.012, 0.02);
      ridge.rotation.y = Math.PI;
      ridge.scale.set(1, 0.8, 1);
      this.fore.add(ridge);
      const bone = new THREE.Mesh(ageo('bone', () => new THREE.SphereGeometry(0.012, 8, 6)), amat('claw'));
      bone.position.set(-0.02, 0.018, 0.13);
      bone.scale.set(1, 0.6, 2.2);
      this.fore.add(bone);
    }
    if (st.fore.plates) {
      for (let i = 0; i < 5; i++) {
        const pl = new THREE.Mesh(ageo('tplate', () => new THREE.DodecahedronGeometry(1, 0)), amat('termPlate'));
        const a = -0.9 + i * 0.45;
        pl.position.set(Math.sin(a) * 0.08, Math.cos(a) * 0.075, 0.08 + (i % 2) * 0.08);
        pl.scale.set(0.035, 0.018, 0.05);
        pl.rotation.set(0.2, 0, -a);
        this.fore.add(pl);
      }
    }
    this.fore.scale.x = side;
    this.group.add(this.fore);
    this.upper = new THREE.Mesh(ageo('upper:' + styleKey, () => latheAlongZ(st.upper.prof, 16, st.fore.oval)), amat(st.upper.mat));
    this.group.add(this.upper);
    this.shoulder = new THREE.Object3D();
    rig.add(this.shoulder);
    this.pole = new THREE.Vector3(side * 0.6, -1, 0.15);
    this.visible = true;
  }
  setVisible(v) {
    this.visible = v;
    this.mount.visible = v;
    this.group.visible = v;
  }
  dispose(scene, rig) {
    scene.remove(this.group);
    rig.remove(this.shoulder);
    if (this.mount.parent) this.mount.parent.remove(this.mount);
  }
  // Solve two-bone IK in camera/world space.
  solve() {
    if (!this.visible) return;
    const W = _v1.setFromMatrixPosition(this.hand.root.matrixWorld);
    const S = _v2.setFromMatrixPosition(this.shoulder.matrixWorld);
    const a = this.upperLen, b = this.foreLen;
    const dir = _v3.subVectors(W, S);
    let d = dir.length();
    dir.divideScalar(d || 1);
    const dc = clamp(d, Math.abs(a - b) + 0.02, (a + b) * 0.995);
    const x = (a * a - b * b + dc * dc) / (2 * dc);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const m = _v4.copy(this.pole).addScaledVector(dir, -this.pole.dot(dir)).normalize();
    const E = _v5.copy(S).addScaledVector(dir, x * (d / dc)).addScaledVector(m, h);
    // forearm: wrist -> elbow along +Z, up = back of hand
    const up = _v4.set(0, 1, 0).transformDirection(this.hand.root.matrixWorld);
    aim(this.fore, W, E, up);
    const fl = W.distanceTo(E);
    this.fore.scale.set(this.side, 1, fl / this.foreLen);
    aim(this.upper, E, S, _v3.copy(this.pole).negate());
    this.upper.scale.set(1, 1, E.distanceTo(S) / this.upperLen);
  }
}

// orient obj at 'from' with +Z pointing toward 'to'
function aim(obj, from, to, up) {
  obj.position.copy(from);
  _m2.lookAt(to, from, up);
  obj.quaternion.setFromRotationMatrix(_m2);
}

// ---------------------------------------------------------------------------
// Per-weapon configuration (holder space = weapon space; holder base in camera space)
// ---------------------------------------------------------------------------
const PIVOT = new THREE.Vector3(0.09, -0.15, -0.3);

const WCFG = {
  ak47: {
    type: 'rifle', base: { p: [0.165, -0.212, -0.43], r: [0.065, 0.065, -0.03] },
    rh: { p: [0.034, 0.012, 0.074], f: [0, -0.35, -0.94], b: [1, 0.15, 0], pose: 'trigger' },
    lh: { p: [0.061, 0.002, -0.246], f: [-0.85, 0.35, -0.25], b: [0.35, -0.9, 0], pose: 'support' },
    lhMag: { p: [-0.03, -0.035, -0.02], f: [0.6, 0.6, -0.5], b: [-0.6, -0.5, 0.5], pose: 'magGrab' },
    lhCharge: { p: [-0.1, -0.052, 0.01], f: [1, 0.35, -0.05], b: [0, -1, 0.15], pose: 'magGrab', pole: [-0.7, -1, 0.2] },
    shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
    recoil: { back: 0.85, up: 2.7, side: 0.9, roll: 1.3 }, flash: 0.21, bolt: 0.075, shell: 0.039,
    magOut: { p: [0, -0.03, -0.022], r: [0.42, 0, 0] }, charge: 'pull',
  },
  m4a1: {
    type: 'rifle', base: { p: [0.165, -0.214, -0.43], r: [0.065, 0.065, -0.03] },
    rh: { p: [0.034, 0.012, 0.074], f: [0, -0.35, -0.94], b: [1, 0.15, 0], pose: 'trigger' },
    lh: { p: [0.062, 0.006, -0.22], f: [-0.85, 0.35, -0.25], b: [0.35, -0.9, 0], pose: 'support' },
    lhMag: { p: [-0.03, -0.03, -0.02], f: [0.6, 0.6, -0.5], b: [-0.6, -0.5, 0.5], pose: 'magGrab' },
    lhCharge: { p: [-0.05, -0.02, 0.06], f: [0.35, 0.25, -0.9], b: [-1, 0.1, 0], pose: 'palmPush', pole: [-1, -0.6, 0.2] },
    shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
    recoil: { back: 0.7, up: 2.1, side: 0.6, roll: 0.8 }, flash: 0.18, bolt: 0.05, shell: 0.036,
    magOut: { p: [0, -0.06, 0.002], r: [0.05, 0, 0] }, charge: 'slap',
  },
  mg3: {
    type: 'mg', base: { p: [0.175, -0.222, -0.45], r: [0.06, 0.065, -0.03] },
    rh: { p: [0.036, 0.016, 0.074], f: [0, -0.35, -0.94], b: [1, 0.15, 0], pose: 'trigger' },
    lh: { p: [0.062, 0.012, -0.23], f: [-0.85, 0.35, -0.25], b: [0.35, -0.9, 0], pose: 'mgSupport' },
    lhMag: { p: [-0.1, 0.0, 0.0], f: [0.9, 0.2, -0.3], b: [-0.3, 0.2, 0.9], pose: 'magGrab', pole: [-1, -0.6, 0.2] },
    lhCharge: { p: [-0.105, -0.052, 0.01], f: [1, 0.35, -0.05], b: [0, -1, 0.15], pose: 'magGrab', pole: [-0.7, -1, 0.2] },
    lhCover: { p: [-0.026, -0.06, 0.03], f: [0.15, 1, -0.15], b: [-1, 0.1, 0], pose: 'magGrab', pole: [-0.8, -1, 0.2] },
    lhTray: { p: [-0.075, 0.125, -0.02], f: [1, -0.3, -0.25], b: [0, 1, 0.2], pose: 'flat', pole: [-0.7, -1, 0.2] },
    shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
    recoil: { back: 0.55, up: 1.5, side: 1.0, roll: 1.0 }, flash: 0.26, bolt: 0, shell: 0.042,
    magOut: { p: [-0.02, -0.03, 0], r: [0, 0, 0.1] },
  },
  deagle: {
    type: 'pistol', base: { p: [0.14, -0.155, -0.36], r: [0.06, 0.1, 0.0] },
    rh: { p: [0.034, 0.022, 0.094], f: [0, -0.3, -0.95], b: [1, 0.2, 0], pose: 'trigger' },
    lh: null,
    lhMag: { p: [-0.012, -0.045, 0.01], f: [0.3, 0.9, -0.3], b: [-0.9, 0.2, 0.3], pose: 'magGrab' },
    lhCharge: { p: [-0.086, 0.036, 0.009], f: [1, -0.3, -0.1], b: [0, 1, 0.25], pose: 'magGrab', pole: [-1, -0.4, 0.2] },
    shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
    recoil: { back: 1.3, up: 8.0, side: 1.4, roll: 2.0 }, flash: 0.24, bolt: 0.03, shell: 0.033,
  },
  knife: {
    type: 'knife', base: { p: [0.16, -0.18, -0.36], r: [0.2, 0.28, -0.25] },
    rh: { p: [0.004, 0.058, 0.03], f: [0.15, -0.95, -0.25], b: [0.95, 0.2, 0], pose: 'knife' },
    lh: null, shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
  },
  grenade: {
    type: 'grenade', base: { p: [0.16, -0.17, -0.34], r: [0.15, 0.2, -0.1] },
    rh: { p: [0.045, 0.02, 0.05], f: [-0.3, -0.35, -0.9], b: [0.9, 0.3, 0.2], pose: 'ball' },
    lh: null, lhPin: { p: [-0.035, -0.074, 0.027], f: [0.4, 0.8, -0.3], b: [-0.9, 0.2, 0.2], pose: 'pinch', pole: [-0.2, -1, 0.3] },
    shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
  },
  blade: {
    type: 'blade', base: { p: [0.19, -0.2, -0.38], r: [0.32, 0.42, -0.55] },
    rh: { p: [0.004, 0.06, 0.02], f: [0.15, -0.95, -0.25], b: [0.95, 0.2, 0], pose: 'knife' },
    lh: null, shL: [-0.02, -0.42, -0.2], shR: [0.26, -0.36, 0.02], poleL: [-0.3, -1, 0.2], poleR: [0.9, -1, 0.2],
  },
  claws: {
    type: 'claws', base: { p: [0, 0, 0], r: [0, 0, 0] },
    rh: { p: [0.165, -0.175, -0.35], f: [-0.25, 0.55, -0.8], b: [0.45, 0.8, 0.25], pose: 'claw' },
    lhSym: true, shL: [-0.2, -0.32, 0.02], shR: [0.2, -0.32, 0.02], poleL: [-0.9, -1, 0.3], poleR: [0.9, -1, 0.3],
  },
  fists: {
    type: 'fists', base: { p: [0, 0, 0], r: [0, 0, 0] },
    rh: { p: [0.22, -0.2, -0.39], f: [-0.2, 0.45, -0.87], b: [0.55, 0.8, 0.2], pose: 'fist' },
    lhSym: true, shL: [-0.26, -0.38, 0.02], shR: [0.26, -0.38, 0.02], poleL: [-0.9, -1, 0.3], poleR: [0.9, -1, 0.3],
  },
};
for (const id in WCFG) {
  const c = WCFG[id];
  if (c.lhSym) c.lh = mirrorSpec(c.rh);
  for (const key of ['rh', 'lh', 'lhMag', 'lhCharge', 'lhCover', 'lhTray', 'lhPin']) prepSpec(c[key]);
}
const LH_REST = prepSpec({ p: [-0.1, -0.32, 0.12], f: [0.6, 0.6, -0.5], b: [-0.5, -0.8, 0], pose: 'relax' });

export const MELEE_DURATION = {
  knife: [0.45, 0.85], claws: [0.5, 0.9], blade: [0.6, 1.0], fists: [0.55, 0.95], gun: [0.5, 0.5],
};
const DRAW_TIME = 0.45;

// ---------------------------------------------------------------------------
// FX: trail ribbon
// ---------------------------------------------------------------------------
class Trail {
  constructor(n = 24) {
    this.n = n;
    this.base = new Float32Array(n * 3);
    this.tipA = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(99);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    this.col = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) { uv[i * 4] = i / (n - 1); uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i / (n - 1); uv[i * 4 + 3] = 1; }
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mat = new THREE.MeshBasicMaterial({ map: canvasTexture('trailGrad', 4, 64, drawTrailGrad, { repeat: false, srgb: false }), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.color = new THREE.Color(1, 0.7, 0.3);
    this.life = 0.16;
    this.active = false;
    this.mesh.visible = false;
  }
  reset() { this.age.fill(99); this.mesh.visible = false; }
  update(dt, baseV, tipV, emit) {
    const n = this.n;
    for (let i = 0; i < n; i++) this.age[i] += dt;
    if (emit) {
      // shift
      this.base.copyWithin(3, 0, (n - 1) * 3);
      this.tipA.copyWithin(3, 0, (n - 1) * 3);
      this.age.copyWithin(1, 0, n - 1);
      this.base[0] = baseV.x; this.base[1] = baseV.y; this.base[2] = baseV.z;
      this.tipA[0] = tipV.x; this.tipA[1] = tipV.y; this.tipA[2] = tipV.z;
      this.age[0] = 0;
    }
    let any = false;
    let lastAlive = -1;
    for (let i = 0; i < n; i++) {
      const alive = this.age[i] < this.life;
      if (alive) lastAlive = i;
      const a = alive ? (1 - this.age[i] / this.life) * (1 - i / n) : 0;
      if (a > 0) any = true;
      // dead samples collapse onto the last live sample so no quads stretch to stale points
      const src = alive || lastAlive < 0 ? i : lastAlive;
      const o = i * 6;
      this.pos[o] = this.base[src * 3]; this.pos[o + 1] = this.base[src * 3 + 1]; this.pos[o + 2] = this.base[src * 3 + 2];
      this.pos[o + 3] = this.tipA[src * 3]; this.pos[o + 4] = this.tipA[src * 3 + 1]; this.pos[o + 5] = this.tipA[src * 3 + 2];
      const r = this.color.r * a, g = this.color.g * a, b = this.color.b * a;
      this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b;
      this.col[o + 3] = r; this.col[o + 4] = g; this.col[o + 5] = b;
    }
    this.mesh.visible = any;
    if (any) {
      this.mesh.geometry.attributes.position.needsUpdate = true;
      this.mesh.geometry.attributes.color.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------------------
// FX: electric arcs (camera-facing jagged ribbons)
// ---------------------------------------------------------------------------
class Arcs {
  constructor(maxSeg = 200) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 4 * 3);
    this.col = new Float32Array(maxSeg * 4 * 3);
    const uv = new Float32Array(maxSeg * 4 * 2);
    const idx = new Uint16Array(maxSeg * 6);
    for (let i = 0; i < maxSeg; i++) {
      uv.set([0, 0, 0, 1, 1, 1, 1, 0], i * 8);
      const a = i * 4;
      idx.set([a, a + 1, a + 2, a, a + 2, a + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mat = new THREE.MeshBasicMaterial({ map: Tex.glowLine(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.count = 0;
    this.pts = new Float32Array(16 * 3);
    this.rand = mulberry(1234);
  }
  begin() { this.count = 0; }
  // jagged bolt from a to b
  bolt(a, b, width, bright, jag = 0.25) {
    const R = this.rand;
    const n = 9;
    const P = this.pts;
    const len = a.distanceTo(b);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const w = Math.sin(t * Math.PI) * len * jag;
      P[i * 3] = lerp(a.x, b.x, t) + (i && i < n - 1 ? (R() - 0.5) * w : 0);
      P[i * 3 + 1] = lerp(a.y, b.y, t) + (i && i < n - 1 ? (R() - 0.5) * w : 0);
      P[i * 3 + 2] = lerp(a.z, b.z, t) + (i && i < n - 1 ? (R() - 0.5) * w : 0);
    }
    for (let i = 0; i < n - 1 && this.count < this.max; i++) {
      this._seg(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], P[i * 3 + 3], P[i * 3 + 4], P[i * 3 + 5], width, bright);
    }
  }
  _seg(x0, y0, z0, x1, y1, z1, w, br) {
    // side = normalize(cross(seg, viewDir)) * w ; view dir from origin to midpoint
    const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
    const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5, mz = (z0 + z1) * 0.5;
    let cx = sy * mz - sz * my, cy = sz * mx - sx * mz, cz = sx * my - sy * mx;
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx = (cx / cl) * w; cy = (cy / cl) * w; cz = (cz / cl) * w;
    const o = this.count * 12;
    const P = this.pos;
    P[o] = x0 - cx; P[o + 1] = y0 - cy; P[o + 2] = z0 - cz;
    P[o + 3] = x0 + cx; P[o + 4] = y0 + cy; P[o + 5] = z0 + cz;
    P[o + 6] = x1 + cx; P[o + 7] = y1 + cy; P[o + 8] = z1 + cz;
    P[o + 9] = x1 - cx; P[o + 10] = y1 - cy; P[o + 11] = z1 - cz;
    const r = 0.22 * br, g = 0.62 * br, b = 1.0 * br;
    for (let j = 0; j < 4; j++) { this.col[o + j * 3] = r; this.col[o + j * 3 + 1] = g; this.col[o + j * 3 + 2] = b; }
    this.count++;
  }
  end() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.count * 6);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }
}

// ---------------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------------
const GUNS = new Set(['ak47', 'm4a1', 'mg3', 'deagle']);
const KIND_DEFAULT = { human: 'ak47', hunter: 'blade', zombie: 'claws', mother: 'claws', terminator: 'fists' };

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.name = 'viewmodel';
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 10);
    this.scene.add(this.camera);
    this.scene.environment = getDawnEnvironment();
    this.scene.environmentIntensity = 0.85;

    // Lights: warm low key (dawn sun), cool sky fill, faint back rim.
    this.keyLight = new THREE.DirectionalLight(0xffc38c, 2.6);
    this.keyLight.position.set(-0.8, 1.0, 0.55);
    this.scene.add(this.keyLight);
    this.hemi = new THREE.HemisphereLight(0xa9c2e6, 0x6a4a30, 0.85);
    this.scene.add(this.hemi);
    this.rimLight = new THREE.DirectionalLight(0x9db6ff, 0.7);
    this.rimLight.position.set(1.0, 0.4, -1.0);
    this.scene.add(this.rimLight);
    this.flashLight = new THREE.PointLight(0xffa04a, 0, 2.5, 2);
    this.scene.add(this.flashLight);
    this.fxLight = new THREE.PointLight(0x6fdcff, 0, 1.6, 2);
    this.scene.add(this.fxLight);

    this.rig = new THREE.Group();
    this.rig.name = 'vm_rig';
    this.scene.add(this.rig);
    this.holder = new THREE.Group();
    this.holder.name = 'vm_holder';
    this.rig.add(this.holder);

    // state
    this.kind = null;
    this.weaponId = null;
    this.cfg = null;
    this.models = {};
    this.model = null;
    this.parts = {};
    this.arms = { human: null };
    this.armCache = {};
    this.R = null; this.L = null;
    this.time = 0;
    this.visible = true;
    this.drawT = 1;
    this.action = null; // {type, t, dur, heavy}
    this.boltT = 9;
    this.flashT = 9;
    this.lastGround = true;
    this.phase = 0;
    this.bobAmt = 0;
    this.sprintF = 0; this.crouchF = 0; this.airF = 0;
    this.sp = {
      px: new Spring(260, 0.55), py: new Spring(260, 0.55), pz: new Spring(240, 0.5),
      rx: new Spring(220, 0.5), ry: new Spring(200, 0.55), rz: new Spring(180, 0.5),
      swayX: new Spring(90, 0.75), swayY: new Spring(90, 0.75), land: new Spring(120, 0.45),
    };
    this.twitch = new Float32Array(4);
    this.twitchV = new Float32Array(4);
    this.rand = mulberry(42);
    this.poseR = new Float32Array(P_LEN); this.poseR.set(POSES.relax);
    this.poseL = new Float32Array(P_LEN); this.poseL.set(POSES.relax);
    this.poseTmp = new Float32Array(P_LEN);

    // animation scratch
    this.A = {
      pos: new THREE.Vector3(), rot: new THREE.Vector3(),
      rOff: new THREE.Vector3(), rRot: new THREE.Vector3(), lOff: new THREE.Vector3(), lRot: new THREE.Vector3(),
      magP: new THREE.Vector3(), magR: new THREE.Vector3(), magVis: true,
      lA: 'fg', lB: 'fg', lW: 0, lPose: null, lPoseW: 0, rPose: null, rPoseW: 0,
      bolt: -1, cover: 0, trail: false, arcs: 0, lHidden: false,
    };
    this._pA = new THREE.Vector3(); this._qA = new THREE.Quaternion();
    this._pB = new THREE.Vector3(); this._qB = new THREE.Quaternion();
    this._holderInv = new THREE.Matrix4();

    // FX objects
    this._buildFlash();
    this._buildShells();
    this.trail = new Trail(26);
    this.scene.add(this.trail.mesh);
    this.arcs = new Arcs(220);
    this.scene.add(this.arcs.mesh);
    this.arcTimer = 0;
    this.arcBurst = 0;
    this.thrown = { active: false, obj: null, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0 };

    this.setKind('human');
    this.equip('ak47');
    this.drawT = DRAW_TIME;
  }

  // ------------------------------------------------------------------ API
  setAspect(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
  setFov(deg) { this.camera.fov = deg; this.camera.updateProjectionMatrix(); }
  setVisible(b) { b = !!b; if (b === this.visible) return; this.visible = b; this.rig.visible = this.visible; if (this.R) this.R.group.visible = b && this.R.visible; if (this.L) this.L.group.visible = b && this.L.visible; if (!b) { this.flashGroup.visible = false; this.flashLight.intensity = 0; } }
  get busy() { return !!this.action || this.drawT < DRAW_TIME; }

  setKind(kind) {
    if (!STYLES[kind]) kind = 'human';
    if (kind === this.kind) return;
    this.kind = kind;
    if (this.R) { this.R.dispose(this.scene, this.rig); this.L.dispose(this.scene, this.rig); }
    let pair = this.armCache[kind];
    if (!pair) {
      pair = { R: new Arm(kind, 1, this.scene, this.rig), L: new Arm(kind, -1, this.scene, this.rig) };
      this.armCache[kind] = pair;
    } else {
      this.scene.add(pair.R.group); this.scene.add(pair.L.group);
      this.rig.add(pair.R.shoulder); this.rig.add(pair.L.shoulder);
    }
    this.R = pair.R; this.L = pair.L;
    this.holder.add(this.R.mount);
    this.holder.add(this.L.mount);
    const def = KIND_DEFAULT[kind];
    const ok = kind === 'human' ? this.weaponId && !['claws', 'fists', 'blade'].includes(this.weaponId) : this.weaponId === def;
    if (!ok) this.equip(def);
    else this._applyCfgArms();
  }

  equip(id) {
    if (!WCFG[id]) id = KIND_DEFAULT[this.kind] || 'ak47';
    // keep arms consistent with the equipped item if the caller skipped setKind()
    const need = id === 'claws' ? (this.kind === 'mother' ? 'mother' : 'zombie') : id === 'fists' ? 'terminator' : id === 'blade' ? 'hunter' : 'human';
    if (need !== this.kind && this.R) this.setKind(need);
    this.weaponId = id;
    this.cfg = WCFG[id];
    if (this.model) this.holder.remove(this.model);
    this.model = null;
    this.parts = {};
    if (id !== 'claws' && id !== 'fists') {
      let m = this.models[id];
      if (!m) {
        m = createWeaponModel(id, { lod: 'fp' });
        if (id === 'blade') {
          // private glow materials so pulsing does not affect third-person copies
          m.traverse((o) => {
            if (o.isMesh && (o.material.name === 'wpn_glowAdd' || o.material.name === 'wpn_energyEdge' || o.material.name === 'wpn_energy')) o.material = o.material.clone();
          });
        }
        this.models[id] = m;
      }
      this.model = m;
      this.holder.add(m);
      const P = this.parts;
      for (const n of ['muzzle', 'mag', 'bolt', 'slide', 'cover', 'pin', 'spoon', 'glow', 'eject', 'chargeGrip', 'magGrip', 'coverGrip', 'pinGrip', 'trailBase', 'charger']) P[n] = m.getObjectByName(n) || null;
      if (P.mag) { P.magRestP = P.mag.userData.restP || (P.mag.userData.restP = P.mag.position.clone()); }
      m.visible = true;
      if (P.pin) { P.pin.visible = true; P.pin.position.set(-0.01, 0.046, 0); P.pin.rotation.set(0, 0, 0); }
      if (P.spoon) { P.spoon.visible = true; P.spoon.rotation.set(0, 0, 0); }
      if (P.mag) { P.mag.visible = true; P.mag.position.copy(P.magRestP); P.mag.rotation.set(0, 0, 0); }
      if (P.cover) P.cover.rotation.set(0, 0, 0);
      this._glowMats = [];
      if (id === 'blade') m.traverse((o) => { if (o.isMesh && o.material.name.startsWith('wpn_')) { if (['wpn_glowAdd', 'wpn_energyEdge', 'wpn_energy'].includes(o.material.name)) this._glowMats.push(o.material); } });
      if (P.muzzle) P.muzzle.add(this.flashGroup);
    }
    this.action = null;
    this.drawT = 0;
    this.boltT = 9;
    this.flashT = 9;
    this.trail.reset();
    this.thrownReset();
    this.trail.color.setRGB(...(id === 'blade' ? [0.42, 0.22, 0.06] : [0.12, 0.12, 0.13]));
    this.trail.life = id === 'blade' ? 0.18 : 0.1;
    this._applyCfgArms();
  }

  fire() {
    if (!GUNS.has(this.weaponId) || !this.visible) return;
    if (this.action && this.action.type !== 'fire') return;
    const rc = this.cfg.recoil;
    const R = this.rand;
    const sp = this.sp;
    sp.pz.v += rc.back * (0.85 + R() * 0.3);
    sp.py.v += rc.back * 0.12 * (R() - 0.3);
    sp.px.v += rc.back * 0.12 * (R() - 0.5);
    sp.rx.v += rc.up * (0.8 + R() * 0.4);
    sp.ry.v += rc.side * (R() - 0.5) * 2;
    sp.rz.v += rc.roll * (R() - 0.5) * 2;
    this.boltT = 0;
    this.flashT = 0;
    // randomize flash
    this.flashGroup.rotation.z = R() * Math.PI * 2;
    const s = this.cfg.flash * (0.8 + R() * 0.45);
    this.flashStar.scale.setScalar(s);
    this.flashSide1.scale.set(1, s * 0.6, s * (1.1 + R() * 0.7));
    this.flashSide2.scale.set(1, s * 0.6, s * (1.1 + R() * 0.7));
    this._ejectShell();
  }

  reload(duration = 2.5) {
    if (!GUNS.has(this.weaponId)) return;
    this.action = { type: 'reload', t: 0, dur: Math.max(0.3, duration) };
    this.drawT = DRAW_TIME;
  }

  melee(heavy = false) {
    const id = this.weaponId;
    let d;
    if (id === 'knife' || id === 'claws' || id === 'blade' || id === 'fists') d = MELEE_DURATION[id][heavy ? 1 : 0];
    else if (id === 'grenade') return;
    else d = MELEE_DURATION.gun[0];
    this.action = { type: 'melee', t: 0, dur: d, heavy: !!heavy, side: this.rand() < 0.5 ? 1 : -1 };
    this.drawT = DRAW_TIME;
    this.arcBurst = 0;
  }

  throwGrenade() {
    if (this.weaponId !== 'grenade') this.equip('grenade');
    this.drawT = DRAW_TIME;
    this.action = { type: 'throw', t: 0, dur: 1.05, released: false };
  }

  getMuzzleOffset(out) {
    this.rig.updateMatrixWorld(true);
    const m = this.parts.muzzle;
    if (m) out.setFromMatrixPosition(m.matrixWorld);
    else if (this.R) out.setFromMatrixPosition(this.R.hand.tip.matrixWorld);
    else out.set(0.1, -0.1, -0.5);
    return out;
  }

  // ------------------------------------------------------------------ internals
  _applyCfgArms() {
    const c = this.cfg;
    if (!c || !this.R) return;
    this.R.shoulder.position.fromArray(c.shR).sub(PIVOT);
    this.L.shoulder.position.fromArray(c.shL).sub(PIVOT);
    this.R.pole.fromArray(c.poleR).normalize();
    this.L.pole.fromArray(c.poleL).normalize();
    this.R.setVisible(true);
    this.L.setVisible(!!c.lh);
    if (c.rh) this.poseR.set(POSES[c.rh.pose]);
    if (c.lh) this.poseL.set(POSES[c.lh.pose]);
    this._placeMount(this.R.mount, c.rh, null);
    if (c.lh) this._placeMount(this.L.mount, c.lh, null);
  }

  _placeMount(mount, spec, off) {
    mount.position.copy(spec._p);
    mount.quaternion.copy(spec._q);
    if (off) mount.position.add(off);
  }

  _buildFlash() {
    const g = new THREE.Group();
    g.name = 'muzzleFlash';
    const starMat = new THREE.MeshBasicMaterial({ map: Tex.flashStar(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(1.6, 1.3, 1.0) });
    const sideMat = new THREE.MeshBasicMaterial({ map: Tex.flashSide(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(1.5, 1.2, 0.9) });
    const star = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), starMat);
    const sideG = new THREE.PlaneGeometry(1, 1);
    sideG.rotateY(Math.PI / 2); // x -> -z ... now spans z [0.5,-0.5]
    sideG.translate(0, 0, -0.5);
    // swap so plane's u runs from the muzzle forward (width along Y = 'x scale')
    const s1 = new THREE.Mesh(sideG, sideMat);
    const s2 = new THREE.Mesh(sideG, sideMat);
    s2.rotation.z = Math.PI / 2;
    // side plane: scale.x -> (unused, plane has no x extent after rotation) ; scale.y -> height ; scale.z -> length
    this.flashStar = star; this.flashSide1 = s1; this.flashSide2 = s2;
    g.add(star, s1, s2);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshBasicMaterial({ map: Tex.softDot(), color: new THREE.Color(2, 1.5, 0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    core.scale.setScalar(0.03);
    g.add(core);
    this.flashCore = core;
    this.flashMats = [starMat, sideMat, core.material];
    g.visible = false;
    g.renderOrder = 12;
    star.renderOrder = s1.renderOrder = s2.renderOrder = core.renderOrder = 12;
    this.flashGroup = g;
  }

  _buildShells() {
    this.shells = [];
    const geo = new THREE.CylinderGeometry(0.0055, 0.006, 1, 10, 1);
    geo.rotateX(Math.PI / 2);
    const mouth = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 8, 1, true);
    mouth.rotateX(Math.PI / 2);
    const mat = getWeaponMaterial('brass');
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this.shells.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: 9, len: 0.039 });
    }
    this.shellIdx = 0;
  }

  _ejectShell() {
    const P = this.parts;
    if (!P.eject) return;
    const sh = this.shells[this.shellIdx];
    this.shellIdx = (this.shellIdx + 1) % this.shells.length;
    this.holder.updateWorldMatrix(true, true);
    sh.mesh.position.setFromMatrixPosition(P.eject.matrixWorld);
    const R = this.rand;
    const down = this.weaponId === 'mg3';
    _v1.set(down ? 0.1 : 1.4 + R() * 0.5, down ? -1.2 : 1.0 + R() * 0.6, down ? 0.1 : 0.5 + R() * 0.4);
    _v1.transformDirection(this.holder.matrixWorld).multiplyScalar(down ? 1.2 : 1.6 + R() * 0.6);
    sh.vel.copy(_v1);
    sh.spin.set((R() - 0.5) * 30, (R() - 0.5) * 30, (R() - 0.5) * 10);
    sh.mesh.quaternion.setFromRotationMatrix(_m1.extractRotation(this.holder.matrixWorld));
    sh.mesh.rotateY(Math.PI / 2);
    sh.len = this.cfg.shell || 0.039;
    sh.mesh.scale.set(1, 1, sh.len);
    sh.t = 0;
    sh.mesh.visible = this.visible;
  }

  thrownReset() {
    if (this.thrown.obj) this.thrown.obj.visible = false;
    this.thrown.active = false;
  }

  // anchor transform (holder space) for left-hand targets
  _anchor(name, outP, outQ) {
    const c = this.cfg;
    let spec = null, marker = null;
    switch (name) {
      case 'fg': spec = c.lh || LH_REST; break;
      case 'rest': spec = LH_REST; break;
      case 'mag': spec = c.lhMag; marker = this.parts.magGrip; break;
      case 'charge': spec = c.lhCharge; marker = this.parts.chargeGrip; break;
      case 'cover': spec = c.lhCover; marker = this.parts.coverGrip; break;
      case 'tray': spec = c.lhTray; break;
      case 'pin': spec = c.lhPin; marker = this.parts.pinGrip; break;
      default: spec = LH_REST;
    }
    if (!spec) spec = LH_REST;
    if (marker) {
      // marker transform relative to holder
      _m1.multiplyMatrices(this._holderInv, marker.matrixWorld);
      outP.copy(spec._p).applyMatrix4(_m1);
      _m1.decompose(_v5, _q1, _v4);
      outQ.multiplyQuaternions(_q1, spec._q);
    } else {
      outP.copy(spec._p);
      outQ.copy(spec._q);
    }
    return spec;
  }

  // ------------------------------------------------------------------ update
  update(dt, s = {}) {
    dt = clamp(dt || 0, 0, 0.05);
    this.time = s.time !== undefined ? s.time : this.time + dt;
    const t = this.time;
    const c = this.cfg;
    const sp = this.sp;
    const speed = clamp(s.speed || 0, 0, 10);
    const onGround = s.onGround !== false;

    // --- locomotion factors
    const fr = 1 - Math.exp(-dt * 8);
    this.sprintF += ((s.sprint && speed > 1 && !this.action ? 1 : 0) - this.sprintF) * fr;
    this.crouchF += ((s.crouch ? 1 : 0) - this.crouchF) * fr;
    this.airF += ((onGround ? 0 : 1) - this.airF) * (1 - Math.exp(-dt * 6));
    const bobTarget = onGround ? clamp(speed / 5, 0, 1.5) : 0;
    this.bobAmt += (bobTarget - this.bobAmt) * (1 - Math.exp(-dt * 6));
    if (onGround) this.phase += dt * speed * 1.3;
    if (onGround && !this.lastGround) { sp.land.v -= 0.35 + Math.min(0.5, this.airT || 0) * 0.4; }
    this.airT = onGround ? 0 : (this.airT || 0) + dt;
    this.lastGround = onGround;

    // --- look sway (angular velocity based)
    const inv = dt > 0 ? 1 / dt : 0;
    sp.swayX.target = clamp((s.lookDX || 0) * inv * 0.018, -0.09, 0.09);
    sp.swayY.target = clamp((s.lookDY || 0) * inv * 0.018, -0.07, 0.07);
    const swayX = sp.swayX.update(dt), swayY = sp.swayY.update(dt);
    const land = sp.land.update(dt);

    // --- recoil springs
    const rpx = sp.px.update(dt), rpy = sp.py.update(dt), rpz = sp.pz.update(dt);
    const rrx = sp.rx.update(dt), rry = sp.ry.update(dt), rrz = sp.rz.update(dt);

    // --- rig (whole view) transform
    const zombieLike = c.type === 'claws' || c.type === 'fists';
    const b = this.bobAmt * (1 + this.sprintF * 0.7) * (1 - this.crouchF * 0.4);
    const ph = this.phase;
    const bx = Math.sin(ph) * 0.011 * b;
    const by = (Math.cos(ph * 2) - 1) * 0.5 * 0.009 * b;
    const idle = 1 - clamp(this.bobAmt, 0, 1) * 0.7;
    const breathe = Math.sin(t * 1.5);
    const hunch = zombieLike ? 1 : 0;
    this.rig.position.set(
      PIVOT.x + bx - swayX * 0.12 + Math.sin(t * 0.6) * 0.0009 * idle - this.crouchF * 0.012 + hunch * Math.sin(t * 0.8) * 0.006,
      PIVOT.y + by + swayY * 0.1 + breathe * 0.0013 * idle + land * 0.06 + this.airF * 0.012 + this.crouchF * 0.004 + hunch * Math.sin(t * 1.6) * 0.004,
      PIVOT.z + this.crouchF * 0.012 - land * 0.02,
    );
    this.rig.rotation.set(
      Math.sin(ph * 2) * 0.006 * b + breathe * 0.004 * idle - swayY * 0.9 + land * 0.4 - this.airF * 0.03,
      Math.sin(ph) * 0.01 * b + swayX * 0.9,
      Math.sin(ph) * 0.018 * b - swayX * 0.5 - this.crouchF * 0.035 + hunch * Math.sin(t * 0.8) * 0.03,
      'YXZ',
    );

    // --- animation offsets from actions
    const A = this.A;
    A.pos.set(0, 0, 0); A.rot.set(0, 0, 0);
    A.rOff.set(0, 0, 0); A.rRot.set(0, 0, 0); A.lOff.set(0, 0, 0); A.lRot.set(0, 0, 0);
    A.magP.set(0, 0, 0); A.magR.set(0, 0, 0); A.magVis = true;
    A.lA = 'fg'; A.lB = 'fg'; A.lW = 0; A.lPose = null; A.lPoseW = 0; A.rPose = null; A.rPoseW = 0;
    A.bolt = -1; A.cover = 0; A.trail = false; A.arcs = 0; A.lHidden = !c.lh;

    // draw / raise
    if (this.drawT < DRAW_TIME) {
      this.drawT += dt;
      const e = easeOutBack(this.drawT / DRAW_TIME);
      const inv2 = 1 - e;
      A.pos.y -= 0.16 * inv2; A.pos.z += 0.05 * inv2; A.pos.x += 0.03 * inv2;
      A.rot.x -= 0.9 * inv2; A.rot.z += 0.35 * inv2; A.rot.y += 0.2 * inv2;
    }

    // idle character per weapon
    if (c.type === 'claws') this._idleClaws(dt, t, ph, b);
    else if (c.type === 'fists') this._idleFists(dt, t, ph, b);

    // actions
    const act = this.action;
    if (act) {
      act.t += dt;
      const u = clamp(act.t / act.dur, 0, 1);
      if (act.type === 'reload') this._animReload(u, act);
      else if (act.type === 'melee') this._animMelee(u, act);
      else if (act.type === 'throw') this._animThrow(u, act, dt);
      if (act.t >= act.dur) {
        this.action = null;
        if (act.type === 'throw' && this.weaponId === 'grenade') this.equip('grenade');
      }
    }

    // sprint pose
    const spf = this.sprintF;
    if (spf > 0.001) {
      if (zombieLike) {
        // arms pump alternately
        const sw = Math.sin(ph) * spf;
        A.rOff.z += sw * 0.07; A.rOff.y += -Math.abs(sw) * 0.02;
        A.lOff.z -= sw * 0.07; A.lOff.y += -Math.abs(sw) * 0.02;
        A.pos.y -= 0.02 * spf;
      } else {
        A.pos.x -= 0.02 * spf; A.pos.y -= 0.025 * spf; A.pos.z += 0.03 * spf;
        A.rot.x -= 0.28 * spf; A.rot.y += 0.62 * spf; A.rot.z += 0.3 * spf;
      }
    }

    // --- holder transform
    const base = c.base;
    this.holder.position.set(base.p[0] - PIVOT.x + A.pos.x + rpx, base.p[1] - PIVOT.y + A.pos.y + rpy, base.p[2] - PIVOT.z + A.pos.z + rpz);
    this.holder.rotation.set(base.r[0] + A.rot.x + rrx, base.r[1] + A.rot.y + rry, base.r[2] + A.rot.z + rrz, 'YXZ');

    // --- weapon parts
    const P = this.parts;
    this.boltT += dt;
    if (P.bolt || P.slide) {
      let tr = 0;
      const bt = this.boltT;
      if (bt < 0.016) tr = bt / 0.016; else if (bt < 0.075) tr = 1 - (bt - 0.016) / 0.059;
      if (A.bolt >= 0) tr = A.bolt;
      const part = P.bolt || P.slide;
      part.position.z = (part.userData.restZ ?? (part.userData.restZ = part.position.z)) + tr * (c.bolt || 0.04);
    }
    if (P.charger && A.bolt >= 0 && c.charge === 'pull') P.charger.position.z = (P.charger.userData.restZ ?? (P.charger.userData.restZ = P.charger.position.z)) + A.bolt * 0.05;
    if (P.mag) {
      P.mag.position.copy(P.magRestP).add(A.magP);
      P.mag.rotation.set(A.magR.x, A.magR.y, A.magR.z);
      P.mag.visible = A.magVis;
    }
    if (P.cover) P.cover.rotation.x = A.cover;
    if (this._glowMats && this._glowMats.length) {
      const pulse2 = 0.75 + 0.25 * Math.sin(t * 6.0) + 0.08 * Math.sin(t * 23.0) + (A.trail ? 0.5 : 0);
      for (let gi = 0; gi < this._glowMats.length; gi++) {
        const m = this._glowMats[gi];
        if (m.isMeshStandardMaterial) m.emissiveIntensity = 1.1 * pulse2;
        else if (m.name === 'wpn_glowAdd') m.opacity = clamp(0.55 * pulse2, 0, 1);
      }
    }

    // --- hand mounts
    this.holder.updateMatrixWorld(true);
    this._holderInv.copy(this.holder.matrixWorld).invert();
    if (c.rh) {
      this._placeMount(this.R.mount, c.rh, A.rOff);
      if (A.rRot.lengthSq() > 0) { _q1.setFromEuler(_e1.set(A.rRot.x, A.rRot.y, A.rRot.z, 'YXZ')); this.R.mount.quaternion.premultiply(_q1); }
    }
    // left hand
    const L = this.L;
    let lVisible = !A.lHidden;
    if (c.lhSym) {
      this._placeMount(L.mount, c.lh, A.lOff);
      if (A.lRot.lengthSq() > 0) { _q1.setFromEuler(_e1.set(A.lRot.x, A.lRot.y, A.lRot.z, 'YXZ')); L.mount.quaternion.premultiply(_q1); }
    } else if (lVisible) {
      const sA = this._anchor(A.lA, this._pA, this._qA);
      const sB = this._anchor(A.lB, this._pB, this._qB);
      const pA = sA.pose, pB = sB.pose;
      const w = A.lW;
      const poA = sA.pole || c.poleL, poB = sB.pole || c.poleL;
      L.pole.set(lerp(poA[0], poB[0], w), lerp(poA[1], poB[1], w), lerp(poA[2], poB[2], w)).normalize();
      L.mount.position.lerpVectors(this._pA, this._pB, w);
      L.mount.quaternion.slerpQuaternions(this._qA, this._qB, w);
      L.mount.position.add(A.lOff);
      // pose target
      const tgt = this.poseTmp;
      const PA = POSES[pA] || POSES.relax, PB = POSES[pB] || POSES.relax;
      for (let i = 0; i < P_LEN; i++) tgt[i] = lerp(PA[i], PB[i], w);
      this._blendPose(this.poseL, A.lPose ? blendInto(tgt, POSES[A.lPose], A.lPoseW) : tgt, dt, 16);
    }
    L.setVisible(lVisible && this.visible);
    this.R.group.visible = this.visible && this.R.visible;
    // right-hand pose
    if (c.rh) {
      const base2 = POSES[c.rh.pose];
      this._blendPose(this.poseR, A.rPose ? blendInto(this._copy(base2), POSES[A.rPose], A.rPoseW) : base2, dt, 18);
    }
    if (c.lhSym) {
      const base3 = POSES[c.lh.pose];
      this._blendPose(this.poseL, A.lPose ? blendInto(this._copy(base3), POSES[A.lPose], A.lPoseW) : base3, dt, 18);
    }
    const tw = c.type === 'claws' ? this.twitch : null;
    this.R.hand.apply(this.poseR, tw);
    L.hand.apply(this.poseL, tw);

    // --- IK
    this.rig.updateMatrixWorld(true);
    this.R.solve();
    L.solve();

    // --- FX
    this._updateFlash(dt);
    this._updateShells(dt);
    this._updateTrail(dt, A.trail);
    this._updateArcs(dt, A.arcs, t);
    this._updateThrown(dt);
  }

  _copy(src) { this.poseTmp.set(src); return this.poseTmp; }

  _blendPose(cur, tgt, dt, rate) {
    const f = 1 - Math.exp(-dt * rate);
    for (let i = 0; i < P_LEN; i++) cur[i] += (tgt[i] - cur[i]) * f;
  }

  // ------------------------------------------------------------------ idles
  _idleClaws(dt, t, ph, b) {
    const A = this.A;
    // hunched breathing, slow sway, alternating arm motion with walking
    const sw = Math.sin(ph) * b;
    A.rOff.set(Math.sin(t * 1.1) * 0.008, Math.sin(t * 2.0) * 0.006 - Math.abs(sw) * 0.012, sw * 0.03);
    A.lOff.set(Math.sin(t * 1.3 + 1) * 0.008, Math.sin(t * 2.0 + 1.3) * 0.006 - Math.abs(sw) * 0.012, -sw * 0.03);
    A.rRot.set(Math.sin(t * 1.7) * 0.05, Math.sin(t * 0.9) * 0.05, Math.sin(t * 1.2) * 0.06);
    A.lRot.set(Math.sin(t * 1.5 + 2) * 0.05, -Math.sin(t * 0.8) * 0.05, -Math.sin(t * 1.1) * 0.06);
    // finger twitches: random impulses decaying springs
    const R = this.rand;
    for (let i = 0; i < 4; i++) {
      if (R() < dt * 1.6) this.twitchV[i] += (R() - 0.3) * 9;
      this.twitchV[i] += (-120 * this.twitch[i] - 9 * this.twitchV[i]) * dt;
      this.twitch[i] += this.twitchV[i] * dt;
      this.twitch[i] += Math.sin(t * 7 + i * 1.7) * 0.002;
    }
  }

  _idleFists(dt, t, ph, b) {
    const A = this.A;
    const sw = Math.sin(ph) * b;
    A.rOff.set(Math.sin(t * 0.9) * 0.006, Math.sin(t * 1.4) * 0.008 - Math.abs(sw) * 0.015, sw * 0.035);
    A.lOff.set(Math.sin(t * 0.8 + 1) * 0.006, Math.sin(t * 1.4 + 1.1) * 0.008 - Math.abs(sw) * 0.015, -sw * 0.035);
    A.rRot.set(Math.sin(t * 1.2) * 0.03, 0, Math.sin(t * 0.9) * 0.04);
    A.lRot.set(Math.sin(t * 1.1 + 1) * 0.03, 0, -Math.sin(t * 0.9) * 0.04);
    A.arcs = 0.25;
  }

  // ------------------------------------------------------------------ reloads
  _animReload(u, act) {
    const c = this.cfg, A = this.A;
    if (c.type === 'rifle') {
      const tilt = pulse(u, 0.0, 0.14, 0.82, 0.97);
      A.rot.z -= 0.42 * tilt; A.rot.x += 0.12 * tilt; A.rot.y -= 0.1 * tilt;
      A.pos.x -= 0.03 * tilt; A.pos.y += 0.03 * tilt; A.pos.z += 0.035 * tilt;
      this._magCycle(u, 0.14, 0.26, 0.4, 0.53, 0.6);
      // left hand path
      A.lHidden = false;
      if (u < 0.14) { A.lA = 'fg'; A.lB = 'mag'; A.lW = k(u, 0.04, 0.14); }
      else if (u < 0.61) { A.lA = 'mag'; A.lB = 'mag'; A.lW = 0; }
      else if (u < 0.7) { A.lA = 'mag'; A.lB = 'charge'; A.lW = k(u, 0.61, 0.7); }
      else if (u < 0.82) { A.lA = 'charge'; A.lB = 'charge'; A.lW = 0; }
      else { A.lA = 'charge'; A.lB = 'fg'; A.lW = k(u, 0.82, 0.94); }
      // seated mag jolt
      const jolt = pulse(u, 0.58, 0.6, 0.6, 0.66);
      A.pos.y += 0.012 * jolt; A.rot.x -= 0.03 * jolt;
      if (c.charge === 'pull') {
        const pull = k(u, 0.71, 0.77) * (1 - k(u, 0.785, 0.8));
        A.bolt = pull;
        A.lOff.z += 0.0; // hand follows bolt via marker
        const snap = pulse(u, 0.785, 0.8, 0.8, 0.86);
        A.rot.x += 0.04 * snap; A.pos.z += 0.01 * snap;
      } else {
        // bolt locked back during reload, slap the bolt catch
        A.bolt = u > 0.05 && u < 0.76 ? 1 : k(u, 0.76, 0.78) > 0 ? 1 - k(u, 0.76, 0.78) : 0;
        if (u < 0.05) A.bolt = -1;
        const slap = pulse(u, 0.72, 0.76, 0.76, 0.8);
        A.lOff.x += 0.012 * slap;
        const snap = pulse(u, 0.76, 0.78, 0.78, 0.84);
        A.rot.z += 0.05 * snap; A.pos.x += 0.004 * snap;
      }
    } else if (c.type === 'pistol') {
      const tilt = pulse(u, 0.0, 0.12, 0.84, 0.97);
      A.rot.z -= 0.3 * tilt; A.rot.x += 0.22 * tilt; A.rot.y -= 0.12 * tilt;
      A.pos.x -= 0.05 * tilt; A.pos.y += 0.075 * tilt; A.pos.z += 0.04 * tilt;
      // mag drops free (gravity-ish)
      if (u < 0.36) {
        const d = lin(u, 0.1, 0.36);
        A.magP.set(0, -0.02 * k(u, 0.1, 0.14) - 0.6 * d * d, 0.01 * d);
        A.magR.set(-0.25 * d, 0, 0.4 * d);
        A.magVis = u < 0.33;
      } else {
        const come = k(u, 0.38, 0.55), ins = k(u, 0.55, 0.62);
        A.magP.set(0, lerp(lerp(-0.35, -0.07, come), 0, ins), lerp(0.06 * (1 - come), 0, ins));
        A.magR.set(lerp(0.4 * (1 - come), 0, ins), 0, 0);
        A.magVis = u > 0.4;
      }
      A.lHidden = !(u > 0.3 && u < 0.86);
      if (u < 0.4) { A.lA = 'rest'; A.lB = 'mag'; A.lW = k(u, 0.3, 0.4); }
      else if (u < 0.64) { A.lA = 'mag'; A.lB = 'mag'; A.lW = 0; }
      else { A.lA = 'mag'; A.lB = 'rest'; A.lW = k(u, 0.64, 0.84); }
      // slide locked back (empty) until the slide stop is released
      A.bolt = u < 0.02 ? -1 : u < 0.7 ? 1 : 1 - k(u, 0.7, 0.72);
      const jolt = pulse(u, 0.6, 0.62, 0.62, 0.68);
      A.pos.y += 0.01 * jolt;
      const snap = pulse(u, 0.7, 0.72, 0.72, 0.8);
      A.rot.x += 0.06 * snap; A.pos.z += 0.008 * snap;
    } else if (c.type === 'mg') {
      const tilt = pulse(u, 0.0, 0.1, 0.88, 0.98);
      A.rot.z -= 0.22 * tilt; A.rot.x += 0.1 * tilt; A.rot.y -= 0.12 * tilt;
      A.pos.x -= 0.05 * tilt; A.pos.y += 0.035 * tilt; A.pos.z += 0.05 * tilt;
      A.cover = -0.95 * pulse(u, 0.14, 0.22, 0.72, 0.78);
      this._magCycle(u, 0.3, 0.36, 0.44, 0.56, 0.6, true);
      A.lHidden = false;
      if (u < 0.08) { A.lA = 'fg'; A.lB = 'fg'; A.lW = 0; }
      else if (u < 0.14) { A.lA = 'fg'; A.lB = 'cover'; A.lW = k(u, 0.08, 0.14); }
      else if (u < 0.22) { A.lA = 'cover'; A.lB = 'cover'; A.lW = 0; }
      else if (u < 0.3) { A.lA = 'cover'; A.lB = 'mag'; A.lW = k(u, 0.22, 0.3); }
      else if (u < 0.61) { A.lA = 'mag'; A.lB = 'mag'; A.lW = 0; }
      else if (u < 0.66) { A.lA = 'mag'; A.lB = 'tray'; A.lW = k(u, 0.61, 0.66); }
      else if (u < 0.7) { A.lA = 'tray'; A.lB = 'cover'; A.lW = k(u, 0.66, 0.7); }
      else if (u < 0.78) { A.lA = 'cover'; A.lB = 'cover'; A.lW = 0; }
      else if (u < 0.84) { A.lA = 'cover'; A.lB = 'charge'; A.lW = k(u, 0.78, 0.84); }
      else if (u < 0.9) { A.lA = 'charge'; A.lB = 'charge'; A.lW = 0; A.lOff.z += 0.05 * pulse(u, 0.84, 0.87, 0.87, 0.9); }
      else { A.lA = 'charge'; A.lB = 'fg'; A.lW = k(u, 0.9, 0.98); }
      // belt tray tap and cover slam jolts
      const slam = pulse(u, 0.76, 0.78, 0.78, 0.84);
      A.pos.y -= 0.012 * slam; A.rot.x -= 0.03 * slam;
      const jolt = pulse(u, 0.86, 0.88, 0.88, 0.93);
      A.rot.x += 0.03 * jolt;
    }
  }

  // detach -> drop -> return -> insert (shared by rifle & MG)
  _magCycle(u, a, b, c2, d, e, box = false) {
    const A = this.A, cfg = this.cfg;
    const out = cfg.magOut;
    const FAR_Y = -0.36;
    if (u < c2) {
      const o = k(u, a, b), dr = k(u, b, c2);
      A.magP.set(out.p[0] * o + (box ? -0.05 : -0.04) * dr, out.p[1] * o + FAR_Y * dr, out.p[2] * o + 0.05 * dr);
      A.magR.set(out.r[0] * o + 0.6 * dr, out.r[1] * o, out.r[2] * o + 0.5 * dr);
      A.magVis = u < c2 - 0.005;
    } else {
      const cm = k(u, c2, d), ins = k(u, d, e);
      const x0 = box ? -0.05 : -0.04;
      A.magP.set(lerp(lerp(x0, out.p[0], cm), 0, ins), lerp(lerp(FAR_Y, out.p[1] - 0.02, cm), 0, ins), lerp(lerp(0.05, out.p[2], cm), 0, ins));
      A.magR.set(lerp(lerp(0.6, out.r[0], cm), 0, ins), lerp(out.r[1] * cm, 0, ins), lerp(lerp(0.5, out.r[2], cm), 0, ins));
      A.magVis = u > c2 + 0.01;
    }
  }

  // ------------------------------------------------------------------ melee
  _animMelee(u, act) {
    const A = this.A, id = this.weaponId, h = act.heavy;
    if (id === 'knife') {
      if (!h) {
        // right -> left horizontal slash
        const wind = k(u, 0.0, 0.18), sw = k(u, 0.18, 0.42), rec = k(u, 0.5, 1.0);
        const a = wind * (1 - sw), bS = sw * (1 - rec);
        A.pos.x += 0.06 * a - 0.2 * bS; A.pos.y += 0.03 * a + 0.03 * bS; A.pos.z += 0.03 * a - 0.08 * bS;
        A.rot.y += -0.5 * a + 1.25 * bS; A.rot.z += 0.2 * a - 0.9 * bS; A.rot.x += 0.1 * a - 0.2 * bS;
        A.trail = u > 0.17 && u < 0.45;
      } else {
        // heavy: raise and stab forward-down
        const wind = k(u, 0.0, 0.35), st = k(u, 0.38, 0.5), rec = k(u, 0.6, 1.0);
        const a = wind * (1 - st), bS = st * (1 - rec);
        A.pos.x += -0.03 * a - 0.07 * bS; A.pos.y += 0.1 * a + 0.03 * bS; A.pos.z += 0.08 * a - 0.2 * bS;
        A.rot.x += 0.5 * a - 0.35 * bS; A.rot.y += 0.25 * a + 0.3 * bS; A.rot.z += 0.35 * a - 0.2 * bS;
        A.trail = u > 0.37 && u < 0.54;
      }
    } else if (id === 'blade') {
      if (!h) {
        const wind = k(u, 0.0, 0.2), sw = k(u, 0.2, 0.45), rec = k(u, 0.55, 1.0);
        const a = wind * (1 - sw), bS = sw * (1 - rec);
        A.pos.x += 0.1 * a - 0.28 * bS; A.pos.y += 0.05 * a + 0.02 * bS; A.pos.z += 0.05 * a - 0.08 * bS;
        A.rot.y += -0.7 * a + 1.5 * bS; A.rot.z += 0.6 * a - 1.2 * bS; A.rot.x += -0.2 * a - 0.35 * bS;
        A.trail = u > 0.19 && u < 0.5;
      } else {
        // overhead diagonal cleave
        const wind = k(u, 0.0, 0.32), sw = k(u, 0.32, 0.55), rec = k(u, 0.62, 1.0);
        const a = wind * (1 - sw), bS = sw * (1 - rec);
        A.pos.x += 0.02 * a - 0.2 * bS; A.pos.y += 0.16 * a - 0.12 * bS; A.pos.z += 0.08 * a - 0.12 * bS;
        A.rot.x += 0.7 * a - 1.4 * bS; A.rot.y += -0.2 * a + 0.6 * bS; A.rot.z += 0.5 * a - 0.9 * bS;
        A.trail = u > 0.31 && u < 0.6;
      }
    } else if (id === 'claws') {
      if (!h) {
        const wind = k(u, 0.0, 0.25), sw = k(u, 0.25, 0.48), rec = k(u, 0.55, 1.0);
        const a = wind * (1 - sw), bS = sw * (1 - rec);
        A.rOff.x += 0.08 * a - 0.26 * bS; A.rOff.y += 0.14 * a - 0.04 * bS; A.rOff.z += 0.06 * a - 0.08 * bS;
        A.rRot.x += 0.5 * a - 0.5 * bS; A.rRot.z += -0.5 * a + 1.1 * bS; A.rRot.y += -0.3 * a + 0.7 * bS;
        A.rPose = 'clawOpen'; A.rPoseW = a;
        A.pos.z -= 0.03 * bS;
        A.trail = u > 0.24 && u < 0.52;
      } else {
        const wind = k(u, 0.0, 0.38), sw = k(u, 0.38, 0.56), rec = k(u, 0.62, 1.0);
        const a = wind * (1 - sw), bS = sw * (1 - rec);
        for (let side = 0; side < 2; side++) {
          const off = side ? A.lOff : A.rOff, rot = side ? A.lRot : A.rRot, sgn = side ? -1 : 1;
          off.x += sgn * (0.04 * a - 0.12 * bS); off.y += 0.2 * a - 0.02 * bS; off.z += 0.1 * a - 0.14 * bS;
          rot.x += 0.8 * a - 0.9 * bS; rot.z += sgn * (-0.3 * a + 0.5 * bS);
        }
        A.rPose = 'clawOpen'; A.rPoseW = a; A.lPose = 'clawOpen'; A.lPoseW = a;
        A.pos.z -= 0.06 * bS; A.pos.y -= 0.02 * bS;
        A.trail = u > 0.37 && u < 0.6;
      }
    } else if (id === 'fists') {
      if (!h) {
        const wind = k(u, 0.0, 0.2), pu = k(u, 0.2, 0.34), rec = k(u, 0.42, 1.0);
        const a = wind * (1 - pu), bS = pu * (1 - rec);
        A.rOff.x += 0.02 * a - 0.15 * bS; A.rOff.y += 0.01 * a + 0.1 * bS; A.rOff.z += 0.08 * a - 0.22 * bS;
        A.rRot.x += 0.2 * a + 0.35 * bS; A.rRot.y += 0.4 * bS;
        A.lOff.z += 0.04 * bS;
        A.arcs = 0.25 + 1.4 * pulse(u, 0.28, 0.34, 0.45, 0.7);
        A.pos.z -= 0.02 * bS;
      } else {
        const wind = k(u, 0.0, 0.36), sl = k(u, 0.36, 0.5), rec = k(u, 0.6, 1.0);
        const a = wind * (1 - sl), bS = sl * (1 - rec);
        for (let side = 0; side < 2; side++) {
          const off = side ? A.lOff : A.rOff, rot = side ? A.lRot : A.rRot, sgn = side ? -1 : 1;
          off.x += sgn * (-0.03 * a - 0.12 * bS); off.y += 0.24 * a - 0.04 * bS; off.z += 0.1 * a - 0.1 * bS;
          rot.x += 1.0 * a - 0.7 * bS;
        }
        A.arcs = 0.3 + 2.2 * pulse(u, 0.46, 0.5, 0.6, 0.9);
        A.pos.y -= 0.04 * bS; A.pos.z -= 0.04 * bS;
      }
    } else {
      // rifle / pistol bash
      const a = pulse(u, 0.0, 0.25, 0.35, 0.9);
      A.pos.x -= 0.06 * a; A.pos.z -= 0.1 * a; A.pos.y += 0.02 * a;
      A.rot.y += 0.5 * a; A.rot.z += 0.4 * a;
    }
  }

  // ------------------------------------------------------------------ grenade
  _animThrow(u, act, dt) {
    const A = this.A, P = this.parts;
    // left hand comes up, grabs the pin, pulls it away
    A.lHidden = !(u > 0.02 && u < 0.62);
    const pull = k(u, 0.3, 0.42);
    if (u < 0.26) { A.lA = 'rest'; A.lB = 'pin'; A.lW = k(u, 0.04, 0.26); }
    else { A.lA = 'pin'; A.lB = 'pin'; A.lW = 0; }
    if (P.pin) {
      P.pin.position.set(-0.01 - 0.09 * pull - 0.25 * k(u, 0.42, 0.62), 0.046 + 0.02 * pull - 0.3 * k(u, 0.42, 0.62), 0.02 * pull);
      P.pin.rotation.z = 0.8 * pull;
      P.pin.visible = u < 0.6;
    }
    // bring grenade in for the pull, wind back, throw
    const bring = pulse(u, 0.05, 0.25, 0.4, 0.5);
    const wind = k(u, 0.42, 0.6), thr = k(u, 0.6, 0.7), low = k(u, 0.72, 0.95);
    const w = wind * (1 - thr);
    A.pos.x += -0.07 * bring + 0.05 * w - 0.12 * thr; A.pos.y += 0.035 * bring + 0.1 * w + 0.02 * thr - 0.3 * low; A.pos.z += -0.05 * bring + 0.12 * w - 0.22 * thr;
    A.rot.x += 0.1 * bring + 0.6 * w - 0.4 * thr; A.rot.z += -0.2 * bring - 0.3 * w + 0.2 * thr; A.rot.y += 0.2 * bring;
    A.rPose = 'flat'; A.rPoseW = k(u, 0.64, 0.7);
    if (!act.released && u >= 0.66) {
      act.released = true;
      this._releaseGrenade();
    }
    if (this.model) this.model.visible = !act.released;
  }

  _releaseGrenade() {
    const th = this.thrown;
    if (!th.obj) {
      th.obj = createWeaponModel('grenade', { lod: 'fp' });
      const pin = th.obj.getObjectByName('pin');
      if (pin) pin.visible = false;
      this.scene.add(th.obj);
    }
    this.holder.updateMatrixWorld(true);
    this.model.matrixWorld.decompose(th.obj.position, th.obj.quaternion, _v1);
    th.vel.set(-0.6, 1.2, -5.5);
    th.spin.set(-14, 3, 2);
    th.t = 0;
    th.active = true;
    th.obj.visible = this.visible;
    const spoon = th.obj.getObjectByName('spoon');
    if (spoon) spoon.rotation.set(0, 0, 0);
  }

  _updateThrown(dt) {
    const th = this.thrown;
    if (!th.active) return;
    th.t += dt;
    th.vel.y -= 9.8 * dt;
    th.obj.position.addScaledVector(th.vel, dt);
    th.obj.rotation.x += th.spin.x * dt; th.obj.rotation.y += th.spin.y * dt; th.obj.rotation.z += th.spin.z * dt;
    const spoon = th.obj.getObjectByName('spoon');
    if (spoon) spoon.rotation.z = -Math.min(1.8, th.t * 12);
    if (th.t > 0.45) { th.active = false; th.obj.visible = false; }
  }

  // ------------------------------------------------------------------ FX updates
  _updateFlash(dt) {
    this.flashT += dt;
    const on = this.flashT < 0.05 && this.visible;
    this.flashGroup.visible = on;
    if (on) {
      const a = 1 - this.flashT / 0.05;
      for (let fi = 0; fi < this.flashMats.length; fi++) this.flashMats[fi].opacity = a;
      this.flashCore.scale.setScalar(0.035 * (0.7 + a * 0.5));
      this.flashStar.material.opacity = a;
    }
    const li = this.flashT < 0.06 ? (1 - this.flashT / 0.06) : 0;
    this.flashLight.intensity = li * 6;
    if (li > 0 && this.parts.muzzle) this.flashLight.position.setFromMatrixPosition(this.parts.muzzle.matrixWorld);
  }

  _updateShells(dt) {
    for (let si = 0; si < this.shells.length; si++) {
      const sh = this.shells[si];
      if (sh.t > 1) continue;
      sh.t += dt;
      sh.vel.y -= 9.8 * dt;
      sh.vel.multiplyScalar(1 - dt * 0.6);
      sh.mesh.position.addScaledVector(sh.vel, dt);
      sh.mesh.rotation.x += sh.spin.x * dt; sh.mesh.rotation.y += sh.spin.y * dt; sh.mesh.rotation.z += sh.spin.z * dt;
      const fade = sh.t > 0.6 ? clamp(1 - (sh.t - 0.6) / 0.3, 0, 1) : 1;
      sh.mesh.scale.set(fade, fade, sh.len * fade);
      if (sh.t > 0.9) sh.mesh.visible = false;
    }
  }

  _updateTrail(dt, emit) {
    const id = this.weaponId;
    let base = null, tip = null;
    if ((id === 'knife' || id === 'blade') && this.parts.muzzle) { base = this.parts.trailBase; tip = this.parts.muzzle; }
    if (!base || !tip) { if (this.trail.mesh.visible) this.trail.update(dt, _v1, _v2, false); return; }
    _v1.setFromMatrixPosition(base.matrixWorld);
    _v2.setFromMatrixPosition(tip.matrixWorld);
    this.trail.update(dt, _v1, _v2, emit && this.visible);
    if (id === 'claws' && this.A.lPoseW > 0 && emit) { /* single trail on right hand is enough */ }
  }

  _updateArcs(dt, level, t) {
    const arcs = this.arcs;
    const isT = this.weaponId === 'fists' && this.kind === 'terminator';
    // emissive pulse on terminator skin
    if (this.kind === 'terminator') {
      const m = amat('term');
      m.emissiveIntensity = 0.9 + 0.45 * Math.sin(t * 3.1) + 0.2 * Math.sin(t * 11.3) + level * 0.25;
      amat('termPlate').emissiveIntensity = 0.4 + 0.3 * Math.sin(t * 3.1 + 1) + level * 0.2;
    }
    if (!isT || !this.visible) { if (arcs.mesh.visible) { arcs.begin(); arcs.end(); } this.fxLight.intensity = 0; return; }
    this.arcTimer -= dt;
    const R = this.rand;
    if (this.arcTimer <= 0) {
      this.arcTimer = 0.04 + R() * 0.05;
      arcs.begin();
      // occasional flicker at idle, dense when attacking
      const nIdle = R() < 0.35 + level * 0.4 ? 1 + Math.floor(R() * 2) : 0;
      const n = nIdle + Math.floor(level * 4 * R());
      for (let ai = 0; ai < 2; ai++) {
        const arm = ai ? this.L : this.R;
        const hm = arm.hand.root.matrixWorld;
        for (let i = 0; i < n; i++) {
          // fist center approx in hand space
          _v1.set((R() - 0.5) * 0.08, 0.02 + (R() - 0.3) * 0.05, -0.1 - R() * 0.06).applyMatrix4(hm);
          if (level > 1 && R() < 0.5) {
            // discharge forward
            _v2.set((R() - 0.5) * 0.14, (R() - 0.5) * 0.12, -0.14 - R() * 0.12).applyMatrix4(hm);
          } else {
            // crawl up along the forearm
            _v2.copy(arm.fore.position);
            arm.fore.updateMatrixWorld();
            _v3.set((R() - 0.5) * 0.13, (R() - 0.5) * 0.11, 0.02 + R() * 0.07).applyMatrix4(arm.fore.matrixWorld);
            _v2.copy(_v3);
          }
          arcs.bolt(_v1, _v2, 0.0011 + R() * 0.0008 + level * 0.0003, 0.55 + R() * 0.6, 0.35);
        }
      }
      arcs.end();
      this.fxLight.intensity = (n > 0 ? 0.15 + level * 0.3 : 0) * (0.6 + R() * 0.6);
      _v4.setFromMatrixPosition(this.R.hand.root.matrixWorld);
      this.fxLight.position.copy(_v4).lerp(_v5.setFromMatrixPosition(this.L.hand.root.matrixWorld), 0.3);
    }
  }
}

function blendInto(dst, src, w) {
  if (!src || w <= 0) return dst;
  for (let i = 0; i < P_LEN; i++) dst[i] = lerp(dst[i], src[i], w);
  return dst;
}

// Dev helper: a standalone posed hand (right hand; mirror with scale.x = -1) for previews.
export function createHandPreview(kind = 'human', pose = 'relax') {
  const h = new Hand(STYLES[kind] ? kind : 'human');
  h.apply(POSES[pose] || POSES.relax, null);
  return h.root;
}
export const HAND_POSES = Object.keys(POSES);

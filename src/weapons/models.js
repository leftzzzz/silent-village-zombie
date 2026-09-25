// Procedural weapon models for the CF "New Silent Village" recreation.
// Conventions: meters, barrel toward -Z, +Y up, origin = right hand grip point
// (knife/blade: handle, grenade: center).
// Named children: 'muzzle', 'mag', 'bolt' | 'slide', 'foregrip', plus extras
// ('eject', 'chargeGrip', 'cover', 'pin', 'spoon', 'glow', 'trailBase', 'magGrip').
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Procedural noise + canvas textures
// ---------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tileable value noise (lattice fx * fy wraps over the w*h texture).
function pnoise(w, h, fx, fy, seed) {
  const r = rng(seed);
  const g = new Float32Array(fx * fy);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * fy;
    let y0 = Math.floor(gy);
    let ty = gy - y0;
    ty = ty * ty * (3 - 2 * ty);
    y0 %= fy;
    const y1 = (y0 + 1) % fy;
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * fx;
      let x0 = Math.floor(gx);
      let tx = gx - x0;
      tx = tx * tx * (3 - 2 * tx);
      x0 %= fx;
      const x1 = (x0 + 1) % fx;
      const a = g[y0 * fx + x0] + (g[y0 * fx + x1] - g[y0 * fx + x0]) * tx;
      const b = g[y1 * fx + x0] + (g[y1 * fx + x1] - g[y1 * fx + x0]) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

export function fbm(w, h, fx, fy, oct, seed, gain = 0.5) {
  const out = new Float32Array(w * h);
  let amp = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    const n = pnoise(w, h, fx << o, fy << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

const TEX = new Map();
const _canvasCache = new Map();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// cached canvas generator -> texture in chosen color space
export function canvasTexture(key, w, h, draw, { srgb = true, repeat = true } = {}) {
  const k = key + (srgb ? ':s' : ':l');
  if (TEX.has(k)) return TEX.get(k);
  let c = _canvasCache.get(key);
  if (!c) {
    c = makeCanvas(w, h);
    draw(c.getContext('2d'), w, h, c);
    _canvasCache.set(key, c);
  }
  const t = toTexture(c, srgb, repeat);
  TEX.set(k, t);
  return t;
}

function putPixels(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const col = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      col[3] = 255;
      fn(x, y, i, col);
      d[i * 4] = col[0];
      d[i * 4 + 1] = col[1];
      d[i * 4 + 2] = col[2];
      d[i * 4 + 3] = col[3];
    }
  }
  ctx.putImageData(img, 0, 0);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

// Draw a stroke wrapped around a tile so it stays seamless.
function wrapStroke(ctx, w, h, fn) {
  for (let ox = -1; ox <= 1; ox++)
    for (let oy = -1; oy <= 1; oy++) {
      ctx.save();
      ctx.translate(ox * w, oy * h);
      fn();
      ctx.restore();
    }
}

// --- individual texture generators -----------------------------------------
function drawWood(ctx, W, H) {
  const warp = fbm(W, H, 3, 6, 4, 11);
  const fine = fbm(W, H, 8, 96, 3, 12);
  const pores = pnoise(W, H, 48, 384, 13);
  const blotch = fbm(W, H, 2, 4, 3, 14);
  putPixels(ctx, W, H, (x, y, i, c) => {
    const v = y / H;
    const ring = 0.5 + 0.5 * Math.sin((v * 9 + warp[i] * 2.6) * Math.PI * 2);
    const line = Math.pow(ring, 5);
    let t = 0.35 * line + 0.35 * fine[i] + 0.25 * blotch[i];
    if (pores[i] > 0.78) t += 0.18;
    t = clamp01(t);
    c[0] = mix(122, 46, t);
    c[1] = mix(72, 26, t);
    c[2] = mix(44, 15, t);
  });
}

// scratched metal: returns base + scratches; mode 'col' (bright scratches) / 'rough' (smooth scratches)
function drawScratch(mode) {
  return (ctx, W, H) => {
    const n = fbm(W, H, 4, 4, 5, mode === 'col' ? 21 : 21);
    const s = fbm(W, H, 32, 32, 2, 22);
    putPixels(ctx, W, H, (x, y, i, c) => {
      const v = mode === 'col' ? 0.62 + 0.22 * n[i] + 0.08 * s[i] : 0.82 + 0.18 * n[i];
      c[0] = c[1] = c[2] = v * 255;
    });
    const r = rng(77);
    ctx.lineCap = 'round';
    for (let k = 0; k < 420; k++) {
      const x = r() * W, y = r() * H;
      const dir = r() < 0.6 ? 0.15 + r() * 0.3 : r() * Math.PI;
      const len = 4 + Math.pow(r(), 2) * 50;
      const a = 0.08 + r() * 0.22;
      ctx.lineWidth = 0.5 + r() * 0.9;
      ctx.strokeStyle = mode === 'col' ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`;
      const dx = Math.cos(dir) * len, dy = Math.sin(dir) * len;
      wrapStroke(ctx, W, H, () => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + dx, y + dy);
        ctx.stroke();
      });
    }
  };
}

function drawKnurl(ctx, W, H) {
  const k = 16;
  const n = pnoise(W, H, 64, 64, 31);
  putPixels(ctx, W, H, (x, y, i, c) => {
    const u = x / W, v = y / H;
    const a = Math.abs(Math.sin((u + v) * k * Math.PI));
    const b = Math.abs(Math.sin((u - v) * k * Math.PI));
    const val = Math.min(a, b) * 0.85 + n[i] * 0.15;
    c[0] = c[1] = c[2] = val * 255;
  });
}

function drawStipple(ctx, W, H) {
  const n = pnoise(W, H, 96, 96, 41);
  const m = fbm(W, H, 8, 8, 3, 42);
  putPixels(ctx, W, H, (x, y, i, c) => {
    const val = 0.5 + 0.35 * (n[i] - 0.5) * 2 * 0.8 + 0.15 * m[i];
    c[0] = c[1] = c[2] = clamp01(val) * 255;
  });
}

function drawBrushed(ctx, W, H) {
  const n = fbm(W, H, 2, 128, 3, 51);
  const m = fbm(W, H, 4, 4, 3, 52);
  putPixels(ctx, W, H, (x, y, i, c) => {
    const val = 0.72 + 0.2 * n[i] + 0.08 * m[i];
    c[0] = c[1] = c[2] = clamp01(val) * 255;
  });
}

function drawOlive(ctx, W, H) {
  const n = fbm(W, H, 6, 6, 5, 61);
  const s = pnoise(W, H, 64, 64, 62);
  putPixels(ctx, W, H, (x, y, i, c) => {
    const v = 0.82 + 0.14 * n[i] + 0.06 * s[i];
    c[0] = c[1] = c[2] = clamp01(v) * 255;
  });
}

// perforated MG3 barrel jacket alpha (u around, v along; v=0 rear, u=0 top, 0.25 right)
function drawJacket(ctx, W, H) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  const cols = 10, rows = 7;
  for (let cI = 0; cI < cols; cI++) {
    const u = (cI + 0.5) / cols;
    for (let rI = 0; rI < rows; rI++) {
      const v = 0.1 + (rI + 0.5) * (0.8 / rows);
      const off = (rI % 2) * (0.5 / cols);
      const uu = (u + off) % 1;
      // leave the right-side barrel-change hatch region to the slot below
      if (uu > 0.17 && uu < 0.33 && v < 0.48) continue;
      // keep bottom solid-ish where bipod folds
      if (Math.abs(uu - 0.5) < 0.06) continue;
      ctx.beginPath();
      ctx.ellipse(uu * W, (1 - v) * H, W * 0.022, H * 0.034, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // barrel change slot on the right side
  const x0 = 0.19 * W, x1 = 0.31 * W, y0 = (1 - 0.46) * H, y1 = (1 - 0.1) * H;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 10);
  ctx.fill();
}

function drawFlashStar(ctx, W, H) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  ctx.globalCompositeOperation = 'lighter';
  const r = rng(91);
  const spikes = 9;
  for (let k = 0; k < spikes; k++) {
    const ang = (k / spikes) * Math.PI * 2 + r() * 0.3;
    const len = (0.3 + r() * 0.2) * W;
    const wdt = 0.035 * W + r() * 0.02 * W;
    const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    g.addColorStop(0, 'rgba(255,240,200,0.9)');
    g.addColorStop(0.4, 'rgba(255,170,60,0.55)');
    g.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang + 1.5708) * wdt, cy + Math.sin(ang + 1.5708) * wdt);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.lineTo(cx + Math.cos(ang - 1.5708) * wdt, cy + Math.sin(ang - 1.5708) * wdt);
    ctx.fill();
  }
  const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.3);
  rg.addColorStop(0, 'rgba(255,255,240,1)');
  rg.addColorStop(0.25, 'rgba(255,220,140,0.85)');
  rg.addColorStop(0.6, 'rgba(255,130,30,0.3)');
  rg.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
}

function drawFlashSide(ctx, W, H) {
  // flame along +u (u=0 at the muzzle), centered on v
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const r = rng(92);
  for (let k = 0; k < 5; k++) {
    const len = W * (0.55 + r() * 0.4);
    const wd = H * (0.12 + r() * 0.14);
    const cy = H / 2 + (r() - 0.5) * H * 0.12;
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,245,210,0.9)');
    g.addColorStop(0.35, 'rgba(255,180,70,0.6)');
    g.addColorStop(1, 'rgba(255,80,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, cy - wd * 0.35);
    ctx.quadraticCurveTo(len * 0.35, cy - wd, len, cy);
    ctx.quadraticCurveTo(len * 0.35, cy + wd, 0, cy + wd * 0.35);
    ctx.fill();
  }
}

// soft line: bright center across v, fades toward u ends a little
function drawGlowLine(ctx, W, H) {
  putPixels(ctx, W, H, (x, y, i, c) => {
    const v = (y + 0.5) / H * 2 - 1;
    const core = Math.exp(-v * v * 40);
    const halo = Math.exp(-v * v * 5) * 0.55;
    const val = clamp01(core + halo);
    c[0] = c[1] = c[2] = val * 255;
  });
}

function drawSoftDot(ctx, W, H) {
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export const Tex = {
  wood: () => canvasTexture('wood', 512, 512, drawWood),
  woodBump: () => canvasTexture('wood', 512, 512, drawWood, { srgb: false }),
  scratchCol: () => canvasTexture('scratchC', 512, 512, drawScratch('col')),
  scratchRough: () => canvasTexture('scratchR', 512, 512, drawScratch('rough'), { srgb: false }),
  knurl: () => canvasTexture('knurl', 256, 256, drawKnurl, { srgb: false }),
  stipple: () => canvasTexture('stipple', 256, 256, drawStipple, { srgb: false }),
  brushed: () => canvasTexture('brushed', 512, 256, drawBrushed, { srgb: false }),
  brushedCol: () => canvasTexture('brushed', 512, 256, drawBrushed),
  olive: () => canvasTexture('olive', 256, 256, drawOlive),
  jacket: () => canvasTexture('jacket', 512, 512, drawJacket, { srgb: false, repeat: false }),
  flashStar: () => canvasTexture('flashStar', 256, 256, drawFlashStar, { repeat: false }),
  flashSide: () => canvasTexture('flashSide', 256, 128, drawFlashSide, { repeat: false }),
  glowLine: () => canvasTexture('glowLine', 16, 64, drawGlowLine, { repeat: false }),
  softDot: () => canvasTexture('softDot', 64, 64, drawSoftDot, { repeat: false }),
};

// HDR equirect "dawn" environment for reflections (warm low sun, blue zenith).
let _env = null;
export function getDawnEnvironment() {
  if (_env) return _env;
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  const sunU = 0.62, sunEl = 0.14; // sun azimuth (u) and elevation (radians)
  const sd = new THREE.Vector3(Math.cos(sunEl) * Math.sin(sunU * Math.PI * 2), Math.sin(sunEl), Math.cos(sunEl) * Math.cos(sunU * Math.PI * 2));
  const n = fbm(W, H, 8, 4, 4, 5);
  for (let y = 0; y < H; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI; // +pi/2 top
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const az = ((x + 0.5) / W) * Math.PI * 2;
      const dx = Math.cos(el) * Math.sin(az), dy = Math.sin(el), dz = Math.cos(el) * Math.cos(az);
      let r, g, b;
      if (el >= 0) {
        const t = Math.pow(1 - el / (Math.PI / 2), 3);
        r = mix(0.16, 1.25, t); g = mix(0.28, 0.72, t); b = mix(0.55, 0.42, t);
        const cl = n[y * W + x];
        if (el < 0.5 && cl > 0.55) { const k = (cl - 0.55) * 1.6 * (1 - el / 0.5); r = mix(r, 1.4, k); g = mix(g, 0.8, k); b = mix(b, 0.6, k); }
      } else {
        const t = Math.min(1, -el / 0.5);
        r = mix(0.55, 0.16, t); g = mix(0.36, 0.11, t); b = mix(0.22, 0.07, t);
        // dark silhouettes of buildings near the horizon
        const bl = n[y * W + ((x * 3) % W)];
        if (-el < 0.12 && bl > 0.5) { r *= 0.5; g *= 0.5; b *= 0.5; }
      }
      const cosA = dx * sd.x + dy * sd.y + dz * sd.z;
      const sun = Math.pow(Math.max(0, cosA), 900) * 60 + Math.pow(Math.max(0, cosA), 12) * 1.2;
      data[i] = r + sun * 1.0;
      data[i + 1] = g + sun * 0.72;
      data[i + 2] = b + sun * 0.42;
      data[i + 3] = 1;
    }
  }
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(data[i], 60000));
  const t = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  _env = t;
  return t;
}

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------
const MATS = new Map();
const std = (o) => new THREE.MeshStandardMaterial(o);

const MAT_DEFS = {
  parker: () => std({ color: 0x5a5d62, metalness: 0.5, roughness: 0.55, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  blued: () => std({ color: 0x50545b, metalness: 0.7, roughness: 0.4, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  darkSteel: () => std({ color: 0x8c9096, metalness: 0.9, roughness: 0.32, roughnessMap: Tex.scratchRough() }),
  anod: () => std({ color: 0x3e4044, metalness: 0.4, roughness: 0.52, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  magAl: () => std({ color: 0x505356, metalness: 0.45, roughness: 0.5, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  magSteel: () => std({ color: 0x4e4944, metalness: 0.45, roughness: 0.55, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  wood: () => std({ color: 0xffffff, metalness: 0.0, roughness: 0.6, map: Tex.wood(), bumpMap: Tex.woodBump(), bumpScale: 0.6 }),
  polymer: () => std({ color: 0x232426, metalness: 0.08, roughness: 0.72, bumpMap: Tex.stipple(), bumpScale: 0.5 }),
  rubber: () => std({ color: 0x1a1a1b, metalness: 0.0, roughness: 0.86, bumpMap: Tex.knurl(), bumpScale: 1.2 }),
  frameBlack: () => std({ color: 0x323336, metalness: 0.5, roughness: 0.45, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough() }),
  stainless: () => std({ color: 0xd2d3d0, metalness: 1.0, roughness: 0.3, map: Tex.brushedCol(), roughnessMap: Tex.brushed() }),
  brass: () => std({ color: 0xd9ad55, metalness: 1.0, roughness: 0.28 }),
  copper: () => std({ color: 0xc27a4c, metalness: 1.0, roughness: 0.34 }),
  olive: () => std({ color: 0x5d6a3c, metalness: 0.2, roughness: 0.58, map: Tex.olive() }),
  oliveBox: () => std({ color: 0x4f5a34, metalness: 0.35, roughness: 0.55, map: Tex.scratchCol() }),
  yellowPaint: () => std({ color: 0xd9b23a, metalness: 0.1, roughness: 0.55 }),
  bladeSteel: () => std({ color: 0xbfc3c7, metalness: 1.0, roughness: 0.26, roughnessMap: Tex.brushed(), map: Tex.brushedCol() }),
  bladeEdge: () => std({ color: 0xeef0f2, metalness: 1.0, roughness: 0.14, roughnessMap: Tex.brushed() }),
  black: () => std({ color: 0x060606, metalness: 0.2, roughness: 0.9 }),
  sightDot: () => new THREE.MeshBasicMaterial({ color: 0xf2f2e0 }),
  gold: () => std({ color: 0xe0ae52, metalness: 1.0, roughness: 0.26, roughnessMap: Tex.scratchRough() }),
  hunterBlack: () => std({ color: 0x17181b, metalness: 0.6, roughness: 0.38, map: Tex.scratchCol() }),
  gripWrap: () => std({ color: 0x1c1b1a, metalness: 0.0, roughness: 0.9, bumpMap: Tex.knurl(), bumpScale: 1.5 }),
  bladeCore: () => std({ color: 0x2a2622, metalness: 0.9, roughness: 0.25, map: Tex.brushedCol(), emissive: 0x3a1a04, emissiveIntensity: 0.6 }),
  energy: () => new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.3, 0.4) }),
  energyEdge: () => std({ color: 0x3a2a14, metalness: 0.2, roughness: 0.3, emissive: new THREE.Color(1.0, 0.5, 0.12), emissiveIntensity: 1.2 }),
  glowAdd: () => new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.55, 0.16), map: Tex.glowLine(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  jacket: () => std({ color: 0x5a5d62, metalness: 0.5, roughness: 0.55, map: Tex.scratchCol(), roughnessMap: Tex.scratchRough(), alphaMap: Tex.jacket(), alphaTest: 0.5, side: THREE.DoubleSide }),
};

export function getWeaponMaterial(key) {
  let m = MATS.get(key);
  if (!m) {
    const def = MAT_DEFS[key];
    if (!def) throw new Error('unknown weapon material ' + key);
    m = def();
    m.name = 'wpn_' + key;
    MATS.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const KEEP = new Set(['position', 'normal', 'uv']);

function prep(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const k of Object.keys(g.attributes)) if (!KEEP.has(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  g.morphAttributes = {};
  return g;
}

// Box projection UVs in geometry-local space (u follows local Z for side faces).
function boxUV(g, scale) {
  const p = g.attributes.position.array;
  const uv = g.attributes.uv.array;
  const n = g.attributes.position.count;
  for (let t = 0; t < n; t += 3) {
    const i0 = t * 3, i1 = i0 + 3, i2 = i0 + 6;
    const ax = p[i1] - p[i0], ay = p[i1 + 1] - p[i0 + 1], az = p[i1 + 2] - p[i0 + 2];
    const bx = p[i2] - p[i0], by = p[i2 + 1] - p[i0 + 1], bz = p[i2 + 2] - p[i0 + 2];
    const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
    for (let k = 0; k < 3; k++) {
      const j = (t + k) * 3;
      const x = p[j], y = p[j + 1], z = p[j + 2];
      let u, v;
      if (nx >= ny && nx >= nz) { u = z; v = y; }
      else if (ny >= nz) { u = z; v = x; }
      else { u = x; v = y; }
      uv[(t + k) * 2] = u / scale;
      uv[(t + k) * 2 + 1] = v / scale;
    }
  }
  g.attributes.uv.needsUpdate = true;
}

function scaleUV(g, su, sv) {
  const uv = g.attributes.uv.array;
  for (let i = 0; i < uv.length; i += 2) { uv[i] *= su; uv[i + 1] *= sv; }
}

function postVerts(g, fn) {
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
}

let _lowDetail = false; // set while building 'tp' models
const rbox = (w, h, d, r = 0.002, s = 2) =>
  r > 0 ? new RoundedBoxGeometry(w, h, d, _lowDetail ? 1 : s, Math.min(r, Math.min(w, h, d) / 2 - 1e-5)) : new THREE.BoxGeometry(w, h, d);

// Cylinder along Z; r1 = front (-Z) radius, r2 = back radius
const cylZ = (r1, r2, len, seg = 16, open = false) => new THREE.CylinderGeometry(r1, r2, len, seg, 1, open).rotateX(-Math.PI / 2);
const cylX = (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);
const cylY = (r1, r2, len, seg = 12) => new THREE.CylinderGeometry(r1, r2, len, seg);

function shapeFrom(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

// Extrude a side profile given in (z, y) weapon coordinates, centered on x = 0.
function extrudeZY(shapeOrPts, width, bevel = 0.0015, curveSeg = 6, bevelSeg = 2) {
  const shape = Array.isArray(shapeOrPts) ? shapeFrom(shapeOrPts) : shapeOrPts;
  const depth = Math.max(0.0002, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelOffset: -bevel * 0.9,
    bevelSegments: bevelSeg, curveSegments: curveSeg, steps: 1,
  });
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return g;
}

// Extrude a cross-section given in (x, y) along -Z from zBack to zFront.
function extrudeXY(shape, zBack, zFront, bevel = 0.001, curveSeg = 8) {
  const len = zBack - zFront;
  const depth = Math.max(0.0002, len - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelOffset: -bevel * 0.9,
    bevelSegments: 2, curveSegments: curveSeg, steps: 1,
  });
  g.translate(0, 0, zFront + bevel);
  return g;
}

// Lathe around Z. pts: [radius, z] ordered from back (+z) to front (-z).
function latheZ(pts, seg = 16) {
  return new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), -z)), seg).rotateX(-Math.PI / 2);
}

// Knife/sword blade with a real V-grind: stations along -Z.
// st: [{z, top, grind, edge, t}] ordered from guard to tip. Returns {flat, grind} geometries.
function bladeGeometry(st) {
  const flat = [], grind = [];
  const tri = (arr, a, b, c, hint) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) arr.push(...a, ...c, ...b);
    else arr.push(...a, ...b, ...c);
  };
  const quad = (arr, a, b, c, d, hint) => { tri(arr, a, b, c, hint); tri(arr, a, c, d, hint); };
  for (let i = 0; i < st.length - 1; i++) {
    const A = st[i], B = st[i + 1];
    for (const sx of [-1, 1]) {
      const tA = [sx * A.t / 2, A.top, A.z], gA = [sx * A.t / 2, A.grind, A.z], eA = [0, A.edge, A.z];
      const tB = [sx * B.t / 2, B.top, B.z], gB = [sx * B.t / 2, B.grind, B.z], eB = [0, B.edge, B.z];
      quad(flat, tA, gA, gB, tB, [sx, 0, 0]);
      quad(grind, gA, eA, eB, gB, [sx, -1, 0]);
    }
    const ltA = [-A.t / 2, A.top, A.z], rtA = [A.t / 2, A.top, A.z];
    const ltB = [-B.t / 2, B.top, B.z], rtB = [B.t / 2, B.top, B.z];
    quad(flat, ltA, rtA, rtB, ltB, [0, 1, 0]);
  }
  // rear cap
  const R = st[0];
  const cap = [[-R.t / 2, R.top, R.z], [R.t / 2, R.top, R.z], [R.t / 2, R.grind, R.z], [0, R.edge, R.z], [-R.t / 2, R.grind, R.z]];
  tri(flat, cap[0], cap[1], cap[2], [0, 0, 1]);
  tri(flat, cap[0], cap[2], cap[3], [0, 0, 1]);
  tri(flat, cap[0], cap[3], cap[4], [0, 0, 1]);
  const mk = (arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  return { flat: mk(flat), grind: mk(grind) };
}

// flat ribbon along a polyline in the YZ plane (for glow strips); width along 'axis' ('y' or 'x')
function ribbonGeometry(pts, halfW, axis) {
  const pos = [], uv = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ua = i / (n - 1), ub = (i + 1) / (n - 1);
    const off = (p, s) => (axis === 'y' ? [p[0], p[1] + s * halfW, p[2]] : [p[0] + s * halfW, p[1], p[2]]);
    const a0 = off(a, -1), a1 = off(a, 1), b0 = off(b, -1), b1 = off(b, 1);
    pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    uv.push(ua, 0, ub, 0, ub, 1, ua, 0, ub, 1, ua, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Builder: collects parts, merges by (group, material)
// ---------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// third-person LOD: fold visually similar materials together to cut draw calls
const TP_REMAP = {
  blued: 'parker', darkSteel: 'parker', black: 'parker', magSteel: 'parker', frameBlack: 'parker',
  magAl: 'anod', copper: 'brass', bladeEdge: 'bladeSteel', sightDot: 'parker', gripWrap: 'hunterBlack', oliveBox: 'olive',
};

class Builder {
  constructor(lod) {
    this.lod = lod;
    this.fp = lod !== 'tp';
    this.parts = new Map();
    this.pivots = {};
    this.markers = [];
  }
  seg(n) { return this.fp ? n : Math.max(5, Math.round(n * 0.45)); }
  pivot(name, p) { this.pivots[name] = p; }
  add(geo, matKey, o = {}) {
    if (o.d && !this.fp) { geo.dispose(); return; }
    const g = prep(geo);
    if (o.post) postVerts(g, o.post);
    if (o.uv === 'keep') { if (o.uvs) scaleUV(g, o.uvs[0], o.uvs[1]); }
    else boxUV(g, o.uv || 0.12);
    if (o.p || o.r || o.s) {
      _p.fromArray(o.p || [0, 0, 0]);
      _q.setFromEuler(_e.set(...(o.r || [0, 0, 0]), o.ro || 'XYZ'));
      _s.fromArray(o.s || [1, 1, 1]);
      g.applyMatrix4(_m4.compose(_p, _q, _s));
    }
    const grp = o.g || 'static';
    if (!this.fp && TP_REMAP[matKey]) matKey = TP_REMAP[matKey];
    if (!this.parts.has(grp)) this.parts.set(grp, new Map());
    const byMat = this.parts.get(grp);
    if (!byMat.has(matKey)) byMat.set(matKey, []);
    byMat.get(matKey).push(g);
  }
  marker(name, p, g = null, r = null) { this.markers.push({ name, p, g, r }); }
  build() {
    const root = new THREE.Group();
    const groups = { static: root };
    const getGroup = (name) => {
      if (!groups[name]) {
        const gr = new THREE.Group();
        gr.name = name;
        gr.position.fromArray(this.pivots[name] || [0, 0, 0]);
        root.add(gr);
        groups[name] = gr;
      }
      return groups[name];
    };
    for (const [grp, byMat] of this.parts) {
      const parent = getGroup(grp);
      const pv = grp === 'static' ? null : this.pivots[grp] || [0, 0, 0];
      for (const [mk, list] of byMat) {
        const merged = list.length === 1 ? list[0] : mergeGeometries(list);
        if (list.length > 1) list.forEach((g) => g.dispose());
        if (pv) merged.translate(-pv[0], -pv[1], -pv[2]);
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, getWeaponMaterial(mk));
        mesh.name = grp + ':' + mk;
        if (!this.fp) { mesh.castShadow = true; }
        parent.add(mesh);
      }
    }
    for (const m of this.markers) {
      const o = new THREE.Object3D();
      o.name = m.name;
      const parent = m.g ? getGroup(m.g) : root;
      o.position.fromArray(m.p);
      if (m.g) o.position.sub(parent.position);
      if (m.r) o.rotation.set(...m.r);
      parent.add(o);
    }
    return root;
  }
}

// ---------------------------------------------------------------------------
// AK-47
// ---------------------------------------------------------------------------
function buildAK(b) {
  const Y = 0.072;
  const s = (n) => b.seg(n);
  // receiver + dust cover
  b.add(rbox(0.042, 0.056, 0.29, 0.003), 'parker', { p: [0, 0.058, -0.03] });
  b.add(rbox(0.043, 0.03, 0.226, 0.0125, b.fp ? 3 : 2), 'parker', { p: [0, 0.0895, 0.002] });
  if (b.fp) for (let i = 0; i < 7; i++) b.add(rbox(0.0438, 0.0309, 0.0032, 0.0125, 3), 'parker', { p: [0, 0.0899, -0.088 + i * 0.027] });
  b.add(rbox(0.012, 0.008, 0.01, 0.002), 'parker', { p: [0, 0.098, 0.117], d: 1 });
  // magazine well dimples & lower side stamping
  b.add(rbox(0.0435, 0.012, 0.05, 0.004), 'parker', { p: [0, 0.047, -0.098], d: 1 });
  // rear sight block & leaf
  b.add(rbox(0.032, 0.022, 0.07, 0.004), 'parker', { p: [0, 0.092, -0.145] });
  b.add(rbox(0.022, 0.004, 0.072, 0.0012), 'blued', { p: [0, 0.1045, -0.142], r: [0.04, 0, 0] });
  b.add(rbox(0.027, 0.007, 0.009, 0.0015), 'blued', { p: [0, 0.106, -0.158], d: 1 });
  b.add(rbox(0.004, 0.006, 0.004, 0.001), 'blued', { p: [-0.006, 0.108, -0.108], d: 1 });
  b.add(rbox(0.004, 0.006, 0.004, 0.001), 'blued', { p: [0.006, 0.108, -0.108], d: 1 });
  // front trunnion & barrel
  b.add(rbox(0.04, 0.05, 0.02, 0.003), 'parker', { p: [0, 0.064, -0.184] });
  b.add(cylZ(0.0105, 0.0105, 0.335, s(16)), 'blued', { p: [0, Y, -0.35] });
  // slant muzzle brake
  b.add(cylZ(0.0125, 0.0125, 0.032, s(16)), 'blued', { p: [0, Y, -0.53] });
  b.add(rbox(0.012, 0.006, 0.02, 0.002), 'blued', { p: [-0.004, Y + 0.011, -0.535], r: [0, 0.3, 0], d: 1 });
  b.add(cylZ(0.0062, 0.0062, 0.002, s(12)), 'black', { p: [0, Y, -0.5465] });
  // gas block & tube
  b.add(rbox(0.024, 0.05, 0.03, 0.005), 'parker', { p: [0, 0.086, -0.415] });
  b.add(cylZ(0.0095, 0.0095, 0.23, s(14)), 'parker', { p: [0, 0.099, -0.29] });
  b.add(cylZ(0.009, 0.009, 0.012, s(12)), 'parker', { p: [0, 0.099, -0.407], d: 1 });
  // upper handguard (wood, around gas tube)
  b.add(cylZ(0.0168, 0.0168, 0.142, s(18)), 'wood', { p: [0, 0.097, -0.265], s: [1.12, 1, 1], uv: 0.16 });
  // lower handguard with palm swell
  b.add(extrudeZY([[-0.183, 0.086], [-0.358, 0.086], [-0.361, 0.062], [-0.352, 0.051], [-0.33, 0.046], [-0.29, 0.043], [-0.24, 0.043], [-0.205, 0.046], [-0.186, 0.053], [-0.182, 0.07]], 0.05, 0.007, 6, b.fp ? 3 : 1), 'wood', {
    uv: 0.16,
    post: (v) => { const t = (v.z + 0.183) / -0.178; v.x *= 1 + 0.1 * Math.sin(Math.PI * Math.min(1, Math.max(0, t))); },
  });
  // handguard retainers
  b.add(rbox(0.054, 0.042, 0.008, 0.003), 'parker', { p: [0, 0.068, -0.364] });
  b.add(rbox(0.048, 0.052, 0.006, 0.002), 'parker', { p: [0, 0.064, -0.179] });
  // front sight
  b.add(cylZ(0.0145, 0.0145, 0.028, s(16)), 'parker', { p: [0, Y, -0.476] });
  b.add(rbox(0.016, 0.04, 0.02, 0.003), 'parker', { p: [0, 0.094, -0.478] });
  b.add(rbox(0.003, 0.03, 0.018, 0.001), 'parker', { p: [-0.0085, 0.119, -0.478] });
  b.add(rbox(0.003, 0.03, 0.018, 0.001), 'parker', { p: [0.0085, 0.119, -0.478] });
  b.add(cylY(0.0014, 0.0016, 0.02, 6), 'blued', { p: [0, 0.122, -0.478] });
  b.add(rbox(0.01, 0.012, 0.02, 0.002), 'parker', { p: [0, 0.055, -0.475], d: 1 });
  // cleaning rod
  b.add(cylZ(0.003, 0.003, 0.13, 6), 'blued', { p: [0, 0.056, -0.425], d: 1 });
  b.add(cylZ(0.0045, 0.0045, 0.008, 8), 'blued', { p: [0, 0.056, -0.492], d: 1 });
  // trigger guard (stamped loop)
  {
    const sh = new THREE.Shape();
    sh.moveTo(-0.070, 0.032); sh.lineTo(-0.070, 0.006); sh.quadraticCurveTo(-0.070, -0.006, -0.056, -0.006);
    sh.lineTo(-0.030, -0.006); sh.quadraticCurveTo(-0.017, -0.006, -0.016, 0.012); sh.lineTo(-0.016, 0.032); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.065, 0.029); hole.lineTo(-0.065, 0.007); hole.quadraticCurveTo(-0.065, -0.001, -0.055, -0.001);
    hole.lineTo(-0.031, -0.001); hole.quadraticCurveTo(-0.021, -0.001, -0.021, 0.013); hole.lineTo(-0.021, 0.029); hole.closePath();
    sh.holes.push(hole);
    b.add(extrudeZY(sh, 0.011, 0.001, 6, 1), 'parker', {});
  }
  // trigger
  b.add(extrudeZY([[-0.044, 0.031], [-0.047, 0.02], [-0.045, 0.009], [-0.041, 0.006], [-0.041, 0.018], [-0.038, 0.031]], 0.006, 0.001, 4, 1), 'blued', {});
  // pistol grip (wood)
  b.add(extrudeZY([[-0.018, 0.031], [-0.013, 0.0], [-0.006, -0.04], [0.001, -0.07], [0.012, -0.079], [0.032, -0.076], [0.035, -0.067], [0.026, -0.03], [0.02, 0.0], [0.019, 0.031]], 0.03, 0.006, 6, b.fp ? 3 : 1), 'wood', { uv: 0.12 });
  b.add(rbox(0.024, 0.004, 0.02, 0.001), 'parker', { p: [0, -0.078, 0.022], r: [-0.12, 0, 0], d: 1 });
  // stock (wood) + butt plate
  b.add(extrudeZY([[0.112, 0.09], [0.2, 0.082], [0.3, 0.07], [0.382, 0.06], [0.388, 0.04], [0.392, -0.02], [0.395, -0.074], [0.385, -0.078], [0.3, -0.04], [0.22, -0.006], [0.16, 0.018], [0.112, 0.036]], 0.036, 0.007, 6, b.fp ? 3 : 1), 'wood', {
    uv: 0.2, post: (v) => { v.x *= 0.82 + 0.4 * Math.min(1, Math.max(0, (v.z - 0.112) / 0.28)); },
  });
  b.add(extrudeZY([[0.388, 0.062], [0.4, 0.062], [0.406, -0.078], [0.394, -0.08]], 0.047, 0.002, 4, 1), 'parker', {});
  b.add(rbox(0.02, 0.004, 0.07, 0.001), 'parker', { p: [0, 0.089, 0.146], r: [0.04, 0, 0], d: 1 });
  b.add(cylX(0.0032, 0.0405, 8), 'parker', { p: [0, 0.074, 0.14], d: 1 });
  // rivets
  if (b.fp) {
    for (const [z, y] of [[-0.162, 0.042], [-0.162, 0.07], [-0.148, 0.056], [-0.052, 0.04], [-0.01, 0.04], [0.035, 0.04], [0.098, 0.044], [0.098, 0.074]]) {
      b.add(cylX(0.0022, 0.0442, 8), 'blued', { p: [0, y, z] });
    }
  }
  // selector lever (right side)
  b.add(extrudeZY([[0.1, 0.082], [0.1, 0.073], [-0.05, 0.059], [-0.062, 0.058], [-0.062, 0.067], [-0.046, 0.07]], 0.003, 0.0006, 4, 1), 'parker', { p: [0.0226, 0, 0] });
  b.add(cylX(0.0055, 0.004, 10), 'parker', { p: [0.0225, 0.078, 0.1], d: 1 });
  // ejection port (right side) + bolt carrier / charging handle
  b.add(rbox(0.003, 0.016, 0.074, 0.001), 'black', { p: [0.0205, 0.083, -0.036] });
  b.pivot('bolt', [0.02, 0.083, -0.07]);
  b.add(rbox(0.004, 0.012, 0.068, 0.0015), 'darkSteel', { p: [0.0215, 0.083, -0.04], g: 'bolt' });
  b.add(rbox(0.022, 0.007, 0.009, 0.002), 'darkSteel', { p: [0.031, 0.084, -0.104], g: 'bolt' });
  b.add(cylY(0.0055, 0.0055, 0.013, s(12)), 'darkSteel', { p: [0.043, 0.086, -0.104], r: [0, 0, -0.35], g: 'bolt' });
  // magazine (curved stamped steel)
  {
    const C = [-0.365, 0.09], Ro = 0.3, Ri = 0.24, th0 = 0.184, th1 = 0.184 + 0.72;
    const pts = [];
    const N = b.fp ? 14 : 6;
    for (let i = 0; i <= N; i++) { const th = th0 + (th1 - th0) * (i / N); pts.push([C[0] + Ro * Math.cos(th), C[1] - Ro * Math.sin(th)]); }
    for (let i = N; i >= 0; i--) { const th = th0 + (th1 - th0) * (i / N); pts.push([C[0] + Ri * Math.cos(th), C[1] - Ri * Math.sin(th)]); }
    b.pivot('mag', [0, 0.04, -0.1]);
    b.add(extrudeZY(pts, 0.026, 0.0025, 4, b.fp ? 2 : 1), 'magSteel', { g: 'mag', uv: 0.1 });
    if (b.fp) {
      // pressed ribs
      const rib = (r0, r1, a0, a1, w) => {
        const rp = [];
        for (let i = 0; i <= 12; i++) { const th = a0 + (a1 - a0) * (i / 12); rp.push([C[0] + r1 * Math.cos(th), C[1] - r1 * Math.sin(th)]); }
        for (let i = 12; i >= 0; i--) { const th = a0 + (a1 - a0) * (i / 12); rp.push([C[0] + r0 * Math.cos(th), C[1] - r0 * Math.sin(th)]); }
        b.add(extrudeZY(rp, w, 0.001, 4, 1), 'magSteel', { g: 'mag', uv: 0.1 });
      };
      rib(0.262, 0.272, th0 + 0.06, th1 - 0.05, 0.0288);
      rib(0.286, 0.3015, th0 + 0.02, th1 - 0.01, 0.0275);
      rib(0.2385, 0.254, th0 + 0.02, th1 - 0.01, 0.0275);
    }
    // floor plate
    const thb = th1;
    const mzr = (Ro + Ri) / 2;
    const bz = C[0] + mzr * Math.cos(thb) - Math.sin(thb) * 0.004, by = C[1] - mzr * Math.sin(thb) - Math.cos(thb) * 0.004;
    b.add(rbox(0.03, 0.009, 0.07, 0.003), 'magSteel', { p: [0, by, bz], r: [thb, 0, 0], g: 'mag' });
    b.add(rbox(0.012, 0.01, 0.012, 0.002), 'magSteel', { p: [0, 0.042, -0.132], g: 'mag', d: 1 });
    b.marker('magGrip', [0, -0.05, -0.12], 'mag');
  }
  b.marker('muzzle', [0, Y, -0.547]);
  b.marker('foregrip', [0, 0.042, -0.27]);
  b.marker('eject', [0.024, 0.086, -0.036]);
  b.marker('chargeGrip', [0.045, 0.087, -0.104], 'bolt');
  b.marker('trailBase', [0, Y, -0.2]);
}

// ---------------------------------------------------------------------------
// M4A1
// ---------------------------------------------------------------------------
function railTeeth(b, x, y, z0, z1, horizontal, mat = 'anod') {
  if (!b.fp) return;
  for (let z = z0; z >= z1; z -= 0.01) {
    if (horizontal) b.add(rbox(0.022, 0.004, 0.0052, 0.0008, 1), mat, { p: [x, y, z] });
    else b.add(rbox(0.004, 0.022, 0.0052, 0.0008, 1), mat, { p: [x, y, z] });
  }
}

function buildM4(b) {
  const Y = 0.08;
  const s = (n) => b.seg(n);
  // lower receiver + magwell
  b.add(rbox(0.03, 0.036, 0.23, 0.003), 'anod', { p: [0, 0.041, -0.025] });
  b.add(rbox(0.034, 0.052, 0.074, 0.004), 'anod', { p: [0, 0.022, -0.099] });
  b.add(rbox(0.036, 0.008, 0.078, 0.003), 'anod', { p: [0, -0.001, -0.099], d: 1 });
  // upper receiver
  b.add(rbox(0.029, 0.041, 0.24, 0.004), 'anod', { p: [0, 0.0785, -0.025] });
  b.add(rbox(0.021, 0.006, 0.236, 0.001), 'anod', { p: [0, 0.1015, -0.025] });
  railTeeth(b, 0, 0.1062, 0.088, -0.138, true);
  // carry handle
  {
    const sh = shapeFrom([[-0.03, 0.104], [-0.024, 0.13], [-0.012, 0.139], [0.066, 0.139], [0.072, 0.147], [0.094, 0.147], [0.094, 0.104]]);
    const hole = new THREE.Path();
    hole.moveTo(-0.014, 0.106); hole.lineTo(-0.009, 0.127); hole.lineTo(0.05, 0.127); hole.lineTo(0.056, 0.106); hole.closePath();
    sh.holes.push(hole);
    b.add(extrudeZY(sh, 0.018, 0.0025, 4, 2), 'anod', {});
    b.add(cylX(0.006, 0.008, 12), 'anod', { p: [-0.012, 0.112, 0.002], d: 1 });
    b.add(cylX(0.006, 0.008, 12), 'anod', { p: [-0.012, 0.112, 0.07], d: 1 });
    b.add(rbox(0.018, 0.012, 0.012, 0.002), 'anod', { p: [0, 0.152, 0.086] });
    b.add(new THREE.TorusGeometry(0.0022, 0.0009, 5, 12), 'black', { p: [0, 0.153, 0.0925], d: 1 });
  }
  // charging handle
  b.pivot('charger', [0, 0.095, 0.1]);
  b.add(rbox(0.009, 0.006, 0.034, 0.0015), 'anod', { p: [0, 0.095, 0.09], g: 'charger' });
  b.add(rbox(0.036, 0.007, 0.008, 0.002), 'anod', { p: [0, 0.095, 0.105], g: 'charger' });
  // forward assist, ejection port, deflector (right side)
  b.add(cylZ(0.0062, 0.0062, 0.03, s(12)), 'anod', { p: [0.018, 0.086, 0.07], d: 1 });
  b.add(rbox(0.002, 0.016, 0.05, 0.0008), 'black', { p: [0.0147, 0.083, -0.03] });
  b.add(rbox(0.007, 0.014, 0.016, 0.002), 'anod', { p: [0.0165, 0.087, 0.008], d: 1 });
  b.pivot('bolt', [0.014, 0.083, -0.03]);
  b.add(rbox(0.003, 0.012, 0.046, 0.001), 'darkSteel', { p: [0.0148, 0.083, -0.03], g: 'bolt' });
  // bolt catch, selector, mag release, pins
  b.add(rbox(0.004, 0.018, 0.011, 0.0012), 'anod', { p: [-0.0165, 0.052, -0.058] });
  b.add(cylX(0.0065, 0.004, 12), 'anod', { p: [-0.0165, 0.05, 0.03] });
  b.add(rbox(0.002, 0.004, 0.018, 0.001), 'anod', { p: [-0.0185, 0.05, 0.022], r: [0.4, 0, 0], d: 1 });
  b.add(cylX(0.0055, 0.004, 10), 'anod', { p: [0.017, 0.034, -0.057], d: 1 });
  b.add(cylX(0.0026, 0.0322, 8), 'anod', { p: [0, 0.052, -0.13], d: 1 });
  b.add(cylX(0.0026, 0.0322, 8), 'anod', { p: [0, 0.05, 0.075], d: 1 });
  // buffer tube + castle nut
  b.add(cylZ(0.0145, 0.0145, 0.2, s(16)), 'anod', { p: [0, 0.075, 0.195] });
  b.add(cylZ(0.0175, 0.0175, 0.01, s(16)), 'anod', { p: [0, 0.075, 0.098] });
  // collapsible stock
  b.add(extrudeZY([[0.175, 0.094], [0.305, 0.099], [0.312, 0.091], [0.312, -0.028], [0.3, -0.035], [0.262, -0.021], [0.24, 0.03], [0.21, 0.053], [0.175, 0.059]], 0.042, 0.005, 4, b.fp ? 3 : 1), 'polymer', {});
  b.add(rbox(0.044, 0.13, 0.012, 0.004), 'rubber', { p: [0, 0.033, 0.317] });
  b.add(rbox(0.0435, 0.012, 0.028, 0.002), 'black', { p: [0, 0.0, 0.29], r: [0.35, 0, 0], d: 1 });
  b.add(rbox(0.012, 0.01, 0.06, 0.002), 'polymer', { p: [0, 0.056, 0.2], d: 1 });
  // pistol grip (A2 with finger groove)
  b.add(extrudeZY([[-0.016, 0.024], [-0.011, -0.004], [-0.013, -0.02], [-0.005, -0.036], [0.002, -0.066], [0.014, -0.078], [0.034, -0.075], [0.029, -0.04], [0.023, -0.004], [0.023, 0.024]], 0.029, 0.005, 6, b.fp ? 3 : 1), 'polymer', {});
  // trigger guard + trigger
  {
    const sh = new THREE.Shape();
    sh.moveTo(-0.063, 0.025); sh.lineTo(-0.063, 0.004); sh.quadraticCurveTo(-0.063, -0.005, -0.052, -0.005);
    sh.lineTo(-0.024, -0.005); sh.quadraticCurveTo(-0.014, -0.005, -0.013, 0.01); sh.lineTo(-0.012, 0.025); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.059, 0.022); hole.lineTo(-0.059, 0.005); hole.quadraticCurveTo(-0.059, -0.001, -0.051, -0.001);
    hole.lineTo(-0.025, -0.001); hole.quadraticCurveTo(-0.018, -0.001, -0.017, 0.011); hole.lineTo(-0.017, 0.022); hole.closePath();
    sh.holes.push(hole);
    b.add(extrudeZY(sh, 0.013, 0.0012, 6, 1), 'anod', {});
    b.add(extrudeZY([[-0.038, 0.025], [-0.041, 0.014], [-0.039, 0.004], [-0.035, 0.002], [-0.035, 0.014], [-0.032, 0.025]], 0.006, 0.001, 4, 1), 'blued', {});
  }
  // quad rail handguard
  const hz = -0.236;
  b.add(cylZ(0.03, 0.03, 0.012, s(20)), 'anod', { p: [0, Y, -0.151] });
  b.add(rbox(0.05, 0.05, 0.18, 0.007), 'anod', { p: [0, Y, hz] });
  b.add(rbox(0.021, 0.006, 0.18, 0.001), 'anod', { p: [0, Y + 0.027, hz] });
  b.add(rbox(0.021, 0.006, 0.18, 0.001), 'anod', { p: [0, Y - 0.027, hz] });
  b.add(rbox(0.006, 0.021, 0.18, 0.001), 'anod', { p: [0.027, Y, hz] });
  b.add(rbox(0.006, 0.021, 0.18, 0.001), 'anod', { p: [-0.027, Y, hz] });
  railTeeth(b, 0, Y + 0.0315, -0.152, -0.32, true);
  railTeeth(b, 0, Y - 0.0315, -0.152, -0.32, true);
  railTeeth(b, 0.0315, Y, -0.152, -0.32, false);
  railTeeth(b, -0.0315, Y, -0.152, -0.32, false);
  if (b.fp) for (const z of [-0.18, -0.236, -0.292]) {
    b.add(cylX(0.0028, 0.0525, 8), 'anod', { p: [0, Y + 0.012, z] });
  }
  // barrel, front sight base, flash hider
  b.add(cylZ(0.0095, 0.0095, 0.17, s(16)), 'blued', { p: [0, Y, -0.41] });
  b.add(cylZ(0.0106, 0.0106, 0.004, s(16)), 'blued', { p: [0, Y, -0.375], d: 1 });
  b.add(cylZ(0.0142, 0.0142, 0.022, s(16)), 'anod', { p: [0, Y, -0.356] });
  b.add(extrudeZY([[-0.345, 0.088], [-0.368, 0.088], [-0.361, 0.126], [-0.352, 0.126]], 0.012, 0.0015, 4, 1), 'anod', {});
  b.add(rbox(0.0026, 0.026, 0.012, 0.0008), 'anod', { p: [-0.0072, 0.131, -0.3565] });
  b.add(rbox(0.0026, 0.026, 0.012, 0.0008), 'anod', { p: [0.0072, 0.131, -0.3565] });
  b.add(cylY(0.0013, 0.0016, 0.02, 6), 'blued', { p: [0, 0.134, -0.3565] });
  b.add(rbox(0.008, 0.014, 0.014, 0.002), 'anod', { p: [0, 0.064, -0.357], d: 1 });
  b.add(cylZ(0.011, 0.0105, 0.042, s(16)), 'blued', { p: [0, Y, -0.511] });
  if (b.fp) for (let k = 0; k < 5; k++) {
    const a = -0.9 + k * 0.45;
    b.add(rbox(0.0028, 0.0022, 0.026, 0.0008), 'black', { p: [Math.sin(a) * 0.0105, Y + Math.cos(a) * 0.0105, -0.513], r: [0, 0, -a] });
  }
  b.add(cylZ(0.0062, 0.0062, 0.002, s(12)), 'black', { p: [0, Y, -0.5325] });
  // STANAG magazine
  b.pivot('mag', [0, 0.02, -0.1]);
  b.add(extrudeZY([[-0.066, 0.022], [-0.068, -0.05], [-0.072, -0.1], [-0.078, -0.15], [-0.142, -0.144], [-0.138, -0.1], [-0.134, -0.05], [-0.132, 0.022]], 0.024, 0.0018, 4, b.fp ? 2 : 1), 'magAl', { g: 'mag' });
  if (b.fp) {
    b.add(extrudeZY([[-0.084, 0.0], [-0.089, -0.128], [-0.095, -0.127], [-0.09, 0.0]], 0.0256, 0.0008, 2, 1), 'magAl', { g: 'mag' });
    b.add(extrudeZY([[-0.108, 0.0], [-0.112, -0.13], [-0.118, -0.13], [-0.114, 0.0]], 0.0256, 0.0008, 2, 1), 'magAl', { g: 'mag' });
  }
  b.add(rbox(0.028, 0.008, 0.072, 0.003), 'polymer', { p: [0, -0.151, -0.11], r: [0.094, 0, 0], g: 'mag' });
  b.marker('magGrip', [0, -0.06, -0.1], 'mag');
  b.marker('muzzle', [0, Y, -0.533]);
  b.marker('foregrip', [0, Y - 0.034, -0.24]);
  b.marker('eject', [0.016, 0.084, -0.03]);
  b.marker('chargeGrip', [-0.02, 0.054, -0.058]);
  b.marker('trailBase', [0, Y, -0.2]);
}

// ---------------------------------------------------------------------------
// MG3
// ---------------------------------------------------------------------------
function buildMG3(b) {
  const Y = 0.08;
  const s = (n) => b.seg(n);
  // receiver
  b.add(rbox(0.05, 0.066, 0.34, 0.004), 'parker', { p: [0, 0.07, 0.02] });
  if (b.fp) {
    b.add(rbox(0.0515, 0.03, 0.12, 0.003), 'parker', { p: [0, 0.064, 0.1] });
    b.add(rbox(0.0515, 0.018, 0.1, 0.003), 'parker', { p: [0, 0.058, -0.07] });
    for (const z of [-0.12, -0.02, 0.06, 0.16]) b.add(cylX(0.0028, 0.0525, 8), 'blued', { p: [0, 0.048, z] });
  }
  // feed tray + cover (hinged at front)
  b.add(rbox(0.05, 0.006, 0.07, 0.001), 'darkSteel', { p: [0, 0.101, -0.02] });
  b.pivot('cover', [0, 0.112, -0.1]);
  b.add(rbox(0.052, 0.02, 0.2, 0.005), 'parker', { p: [0, 0.112, 0.0], g: 'cover' });
  b.add(rbox(0.036, 0.008, 0.18, 0.003), 'parker', { p: [0, 0.123, 0.0], g: 'cover', d: 1 });
  b.add(rbox(0.03, 0.012, 0.022, 0.003), 'parker', { p: [0, 0.109, 0.108], g: 'cover' });
  b.add(rbox(0.024, 0.02, 0.024, 0.004), 'parker', { p: [0, 0.098, 0.12] });
  // rear sight (leaf) in front of the cover
  b.add(rbox(0.022, 0.016, 0.036, 0.003), 'parker', { p: [0, 0.109, -0.123] });
  b.add(rbox(0.02, 0.003, 0.04, 0.001), 'blued', { p: [0, 0.119, -0.12], r: [0.08, 0, 0], d: 1 });
  // barrel jacket (perforated) + inner barrel
  b.add(cylZ(0.024, 0.024, 0.48, s(28), true), 'jacket', { p: [0, Y, -0.39], uv: 'keep' });
  b.add(cylZ(0.0118, 0.0118, 0.5, s(12)), 'blued', { p: [0, Y, -0.39] });
  b.add(cylZ(0.0275, 0.0275, 0.024, s(24)), 'parker', { p: [0, Y, -0.158] });
  b.add(cylZ(0.022, 0.026, 0.032, s(24)), 'parker', { p: [0, Y, -0.626] });
  // muzzle booster / flash hider
  b.add(latheZ([[0.02, -0.64], [0.021, -0.648], [0.017, -0.664], [0.019, -0.69], [0.022, -0.712], [0.0165, -0.726], [0.0095, -0.728]], s(20)), 'blued', { p: [0, Y, 0] });
  b.add(cylZ(0.0085, 0.0085, 0.002, s(12)), 'black', { p: [0, Y, -0.7285] });
  // front sight
  b.add(rbox(0.012, 0.008, 0.02, 0.002), 'parker', { p: [0, 0.106, -0.6] });
  b.add(rbox(0.0035, 0.03, 0.008, 0.001), 'blued', { p: [0, 0.121, -0.6] });
  // bipod (folded back under the jacket)
  b.add(rbox(0.03, 0.014, 0.02, 0.003), 'parker', { p: [0, 0.056, -0.575] });
  for (const sx of [-1, 1]) {
    b.add(cylZ(0.0048, 0.0048, 0.26, s(8)), 'parker', { p: [sx * 0.011, 0.05, -0.445], r: [0, sx * 0.03, 0] });
    b.add(rbox(0.018, 0.006, 0.03, 0.002), 'parker', { p: [sx * 0.016, 0.047, -0.32] });
  }
  // charging handle (right)
  b.add(rbox(0.03, 0.01, 0.014, 0.003), 'parker', { p: [0.038, 0.075, -0.12] });
  b.add(cylY(0.006, 0.006, 0.02, s(10)), 'parker', { p: [0.054, 0.075, -0.12] });
  // pistol grip + trigger guard + trigger
  b.add(extrudeZY([[-0.018, 0.038], [-0.013, 0.0], [-0.006, -0.04], [0.001, -0.07], [0.012, -0.079], [0.033, -0.076], [0.036, -0.067], [0.027, -0.03], [0.021, 0.0], [0.02, 0.038]], 0.032, 0.006, 6, b.fp ? 3 : 1), 'polymer', {});
  {
    const sh = new THREE.Shape();
    sh.moveTo(-0.07, 0.04); sh.lineTo(-0.07, 0.008); sh.quadraticCurveTo(-0.07, -0.004, -0.056, -0.004);
    sh.lineTo(-0.03, -0.004); sh.quadraticCurveTo(-0.017, -0.004, -0.016, 0.014); sh.lineTo(-0.016, 0.04); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.065, 0.037); hole.lineTo(-0.065, 0.009); hole.quadraticCurveTo(-0.065, 0.001, -0.055, 0.001);
    hole.lineTo(-0.031, 0.001); hole.quadraticCurveTo(-0.021, 0.001, -0.021, 0.015); hole.lineTo(-0.021, 0.037); hole.closePath();
    sh.holes.push(hole);
    b.add(extrudeZY(sh, 0.012, 0.001, 6, 1), 'parker', {});
    b.add(extrudeZY([[-0.044, 0.038], [-0.047, 0.024], [-0.045, 0.012], [-0.041, 0.009], [-0.041, 0.022], [-0.038, 0.038]], 0.007, 0.001, 4, 1), 'blued', {});
  }
  // stock
  b.add(extrudeZY([[0.19, 0.1], [0.44, 0.094], [0.452, 0.089], [0.458, -0.05], [0.445, -0.058], [0.4, -0.052], [0.36, -0.01], [0.3, 0.02], [0.24, 0.036], [0.19, 0.04]], 0.044, 0.006, 6, b.fp ? 3 : 1), 'polymer', {});
  b.add(rbox(0.047, 0.15, 0.01, 0.003), 'parker', { p: [0, 0.021, 0.46] });
  // ammo box + belt ('mag')
  b.pivot('mag', [-0.075, 0.06, -0.03]);
  b.add(rbox(0.075, 0.11, 0.13, 0.006), 'oliveBox', { p: [-0.078, 0.004, -0.03], g: 'mag' });
  b.add(rbox(0.079, 0.012, 0.134, 0.004), 'oliveBox', { p: [-0.078, 0.058, -0.03], g: 'mag' });
  if (b.fp) {
    for (const z of [-0.075, 0.015]) b.add(rbox(0.078, 0.09, 0.006, 0.002), 'oliveBox', { p: [-0.078, 0.0, z], g: 'mag' });
    b.add(rbox(0.012, 0.006, 0.07, 0.002), 'parker', { p: [-0.118, 0.03, -0.03], g: 'mag' });
  }
  {
    const n = b.fp ? 7 : 3;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = mix(-0.062, -0.024, t), y = mix(0.066, 0.1, Math.sin(t * Math.PI / 2));
      const rz = -0.9 * (1 - t);
      if (b.fp) {
        b.add(cylZ(0.0058, 0.0062, 0.052, 10), 'brass', { p: [x, y, -0.02], g: 'mag' });
        b.add(latheZ([[0.0055, -0.046], [0.0052, -0.056], [0.0032, -0.068], [0.0005, -0.072]], 10), 'copper', { p: [x, y, 0], g: 'mag' });
        b.add(rbox(0.004, 0.015, 0.046, 0.0012), 'parker', { p: [x + 0.004, y - 0.003, -0.015], r: [0, 0, rz], g: 'mag' });
      } else {
        b.add(rbox(0.012, 0.012, 0.07, 0.002), 'brass', { p: [x, y, -0.03], g: 'mag' });
      }
    }
  }
  b.marker('magGrip', [-0.078, 0.02, -0.03], 'mag');
  b.marker('muzzle', [0, Y, -0.729]);
  b.marker('foregrip', [0, 0.045, -0.24]);
  b.marker('eject', [0, 0.036, -0.02]);
  b.marker('chargeGrip', [0.056, 0.075, -0.12]);
  b.marker('coverGrip', [-0.026, 0.112, 0.03], 'cover');
  b.marker('trailBase', [0, Y, -0.2]);
}

// ---------------------------------------------------------------------------
// Desert Eagle
// ---------------------------------------------------------------------------
function buildDeagle(b) {
  const Y = 0.075;
  const s = (n) => b.seg(n);
  // frame (black) incl. dust cover under barrel
  b.add(rbox(0.03, 0.022, 0.23, 0.003), 'frameBlack', { p: [0, 0.047, -0.08] });
  b.add(rbox(0.026, 0.01, 0.1, 0.003), 'frameBlack', { p: [0, 0.038, -0.14] });
  // fixed polygonal barrel with bore
  {
    const sh = shapeFrom([[-0.0165, 0.058], [0.0165, 0.058], [0.0165, 0.07], [0.012, 0.092], [-0.012, 0.092], [-0.0165, 0.07]]);
    const hole = new THREE.Path();
    hole.absarc(0, Y, 0.0065, 0, Math.PI * 2, true);
    sh.holes.push(hole);
    b.add(extrudeXY(sh, -0.104, -0.22, 0.0015, s(16)), 'stainless', { uv: 0.1 });
    b.add(cylZ(0.0066, 0.0066, 0.03, s(12), true), 'black', { p: [0, Y, -0.205] });
    b.add(rbox(0.012, 0.005, 0.114, 0.0012), 'stainless', { p: [0, 0.0945, -0.162] });
    if (b.fp) for (let z = -0.115; z >= -0.212; z -= 0.012) b.add(rbox(0.0125, 0.002, 0.004, 0.0005), 'black', { p: [0, 0.0968, z] });
    b.add(rbox(0.004, 0.009, 0.012, 0.001), 'frameBlack', { p: [0, 0.1015, -0.211] });
  }
  // slide
  b.pivot('slide', [0, 0.076, 0]);
  b.add(extrudeZY([[-0.104, 0.058], [-0.104, 0.093], [0.05, 0.093], [0.057, 0.087], [0.057, 0.058]], 0.034, 0.004, 4, b.fp ? 3 : 1), 'stainless', { g: 'slide', uv: 0.1 });
  if (b.fp) {
    for (let k = 0; k < 9; k++) {
      const z = 0.014 + k * 0.0042;
      for (const sx of [-1, 1]) b.add(rbox(0.001, 0.026, 0.0018, 0.0003, 1), 'black', { p: [sx * 0.0171, 0.076, z], r: [0.15, 0, 0], g: 'slide' });
    }
    // slide top flat + sight
    b.add(rbox(0.022, 0.003, 0.14, 0.001), 'stainless', { p: [0, 0.0935, -0.03], g: 'slide' });
    // safeties
    for (const sx of [-1, 1]) b.add(rbox(0.004, 0.006, 0.016, 0.0015), 'frameBlack', { p: [sx * 0.0185, 0.083, 0.046], r: [0.5, 0, 0], g: 'slide' });
  }
  b.add(rbox(0.024, 0.009, 0.011, 0.0015), 'frameBlack', { p: [0, 0.0975, 0.045], g: 'slide' });
  b.add(rbox(0.004, 0.003, 0.004, 0.0005), 'sightDot', { p: [0, 0.1035, -0.2105], d: 1 });
  b.add(rbox(0.002, 0.016, 0.052, 0.0006), 'black', { p: [0.0171, 0.08, -0.035], g: 'slide' });
  // hammer
  b.add(rbox(0.008, 0.018, 0.012, 0.002), 'frameBlack', { p: [0, 0.075, 0.062], r: [-0.35, 0, 0] });
  // slide stop, takedown, mag release (left side visible)
  b.add(rbox(0.003, 0.006, 0.036, 0.0012), 'frameBlack', { p: [-0.0165, 0.056, -0.035] });
  b.add(rbox(0.003, 0.008, 0.012, 0.001), 'frameBlack', { p: [-0.0165, 0.05, -0.075], d: 1 });
  b.add(cylX(0.0045, 0.004, 10), 'frameBlack', { p: [-0.016, 0.028, -0.008], d: 1 });
  // trigger guard (squared front)
  {
    const sh = shapeFrom([[-0.078, 0.038], [-0.081, 0.012], [-0.077, -0.004], [-0.022, -0.006], [-0.012, 0.004], [-0.011, 0.038]]);
    const hole = new THREE.Path();
    hole.moveTo(-0.073, 0.035); hole.lineTo(-0.075, 0.013); hole.lineTo(-0.072, 0.0); hole.lineTo(-0.024, -0.001); hole.lineTo(-0.017, 0.006); hole.lineTo(-0.016, 0.035); hole.closePath();
    sh.holes.push(hole);
    b.add(extrudeZY(sh, 0.013, 0.0015, 4, 1), 'frameBlack', {});
    b.add(extrudeZY([[-0.042, 0.038], [-0.046, 0.024], [-0.044, 0.01], [-0.039, 0.008], [-0.039, 0.022], [-0.036, 0.038]], 0.007, 0.001, 4, 1), 'stainless', {});
  }
  // grip frame + rubber panels
  b.add(extrudeZY([[-0.013, 0.038], [-0.006, 0.0], [0.004, -0.05], [0.009, -0.078], [0.05, -0.078], [0.045, -0.04], [0.039, 0.0], [0.042, 0.03], [0.05, 0.043], [0.046, 0.05], [0.03, 0.05]], 0.028, 0.004, 6, b.fp ? 3 : 1), 'frameBlack', {});
  b.add(extrudeZY([[-0.004, 0.032], [0.006, -0.03], [0.012, -0.07], [0.043, -0.07], [0.036, -0.03], [0.032, 0.032]], 0.0335, 0.0025, 6, b.fp ? 2 : 1), 'rubber', { uv: 0.04 });
  // magazine
  b.pivot('mag', [0, -0.08, 0.028]);
  b.add(rbox(0.031, 0.01, 0.05, 0.003), 'frameBlack', { p: [0, -0.083, 0.029], r: [-0.14, 0, 0], g: 'mag' });
  b.add(extrudeZY([[0.001, 0.036], [0.034, 0.036], [0.047, -0.08], [0.012, -0.08]], 0.02, 0.001, 2, 1), 'blued', { g: 'mag' });
  b.add(cylZ(0.0058, 0.0058, 0.03, s(10)), 'brass', { p: [0, 0.041, 0.018], r: [-0.12, 0, 0], g: 'mag', d: 1 });
  b.marker('magGrip', [0, -0.085, 0.03], 'mag');
  b.marker('muzzle', [0, Y, -0.221]);
  b.marker('eject', [0.018, 0.086, -0.03]);
  b.marker('chargeGrip', [0, 0.09, 0.03], 'slide');
  b.marker('trailBase', [0, Y, -0.1]);
}

// ---------------------------------------------------------------------------
// M9 bayonet knife
// ---------------------------------------------------------------------------
function buildKnife(b) {
  const s = (n) => b.seg(n);
  // handle (checkered black)
  b.add(extrudeZY([[-0.047, 0.013], [-0.02, 0.0152], [0.01, 0.0162], [0.04, 0.0152], [0.066, 0.0132], [0.066, -0.0132], [0.04, -0.0158], [0.024, -0.017], [0.01, -0.0158], [-0.004, -0.017], [-0.02, -0.0155], [-0.047, -0.0132]], 0.022, 0.0065, 8, b.fp ? 3 : 1), 'rubber', { uv: 0.04 });
  // guard + ring
  b.add(rbox(0.018, 0.05, 0.008, 0.0025), 'darkSteel', { p: [0, -0.001, -0.0515] });
  b.add(new THREE.TorusGeometry(0.0085, 0.003, s(8), s(18)), 'darkSteel', { p: [0, 0.031, -0.0515] });
  // pommel
  b.add(rbox(0.024, 0.031, 0.016, 0.005), 'darkSteel', { p: [0, 0, 0.073] });
  b.add(rbox(0.008, 0.012, 0.006, 0.002), 'darkSteel', { p: [0.012, 0.004, 0.066], d: 1 });
  // blade
  const Z = [-0.055, -0.062, -0.1, -0.14, -0.17, -0.19, -0.205, -0.218, -0.227, -0.232];
  const TOP = [0.0128, 0.0128, 0.0128, 0.0128, 0.0124, 0.01, 0.0075, 0.0048, 0.0022, 0.0002];
  const EDG = [-0.019, -0.019, -0.0186, -0.018, -0.0168, -0.0146, -0.011, -0.0066, -0.0026, 0.0];
  const T = [0.0062, 0.0062, 0.006, 0.0058, 0.0055, 0.005, 0.0042, 0.0032, 0.0018, 0.0006];
  const st = Z.map((z, i) => ({ z, top: TOP[i], edge: EDG[i], t: T[i], grind: i === 0 ? EDG[i] + 0.004 : mix(EDG[i], TOP[i], 0.52) }));
  const bg = bladeGeometry(st);
  b.add(bg.flat, 'bladeSteel', { uv: 0.08 });
  b.add(bg.grind, 'bladeEdge', { uv: 0.08 });
  // saw-back teeth on the spine
  if (b.fp) {
    const pts = [[-0.07, 0.0125]];
    for (let z = -0.07; z > -0.135; z -= 0.0065) { pts.push([z - 0.0032, 0.0165]); pts.push([z - 0.0065, 0.0125]); }
    pts.push([-0.136, 0.0118]); pts.push([-0.07, 0.0118]);
    b.add(extrudeZY(pts, 0.0036, 0.0003, 1, 1), 'bladeSteel', { uv: 0.08 });
  }
  b.marker('muzzle', [0, 0.0, -0.232]);
  b.marker('trailBase', [0, 0.0, -0.07]);
}

// ---------------------------------------------------------------------------
// HE grenade
// ---------------------------------------------------------------------------
function buildGrenade(b) {
  const s = (n) => b.seg(n);
  b.add(new THREE.SphereGeometry(0.031, s(22), s(16)), 'olive', { s: [1, 1.1, 1], uv: 0.06 });
  b.add(cylY(0.0272, 0.0272, 0.005, s(22)), 'yellowPaint', { p: [0, 0.019, 0] });
  b.add(cylY(0.0098, 0.011, 0.018, s(16)), 'oliveBox', { p: [0, 0.039, 0] });
  b.add(cylY(0.0075, 0.0085, 0.007, s(14)), 'darkSteel', { p: [0, 0.051, 0] });
  // spoon (lever) along +X side
  b.pivot('spoon', [0.01, 0.053, 0]);
  {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.004, 0.056, 0), new THREE.Vector3(0.016, 0.056, 0), new THREE.Vector3(0.027, 0.047, 0),
      new THREE.Vector3(0.034, 0.03, 0), new THREE.Vector3(0.036, 0.008, 0), new THREE.Vector3(0.0345, -0.006, 0),
    ]);
    b.add(new THREE.TubeGeometry(curve, s(16), 0.0014, 4, false), 'darkSteel', { s: [1, 1, 5.2], g: 'spoon' });
  }
  // pin + ring on -X side
  b.pivot('pin', [-0.01, 0.046, 0]);
  b.add(cylX(0.001, 0.024, 6), 'darkSteel', { p: [-0.001, 0.046, 0.0], g: 'pin' });
  b.add(new THREE.TorusGeometry(0.011, 0.0013, s(6), s(22)), 'darkSteel', { p: [-0.025, 0.041, 0.002], r: [0, 0.25, 0.35], g: 'pin' });
  b.marker('muzzle', [0, 0, 0]);
  b.marker('pinGrip', [-0.034, 0.038, 0.004], 'pin');
}

// ---------------------------------------------------------------------------
// Ghost Hunter energy blade
// ---------------------------------------------------------------------------
function buildBlade(b) {
  const s = (n) => b.seg(n);
  // handle
  b.add(cylZ(0.0145, 0.0155, 0.17, s(16)), 'gripWrap', { p: [0, 0, 0.02], uv: 0.05 });
  for (const z of [-0.055, 0.0, 0.05, 0.1]) b.add(cylZ(0.0172, 0.0172, 0.008, s(16)), 'gold', { p: [0, 0, z] });
  b.add(latheZ([[0.0, 0.14], [0.012, 0.136], [0.019, 0.124], [0.017, 0.11], [0.016, 0.105]], s(16)), 'gold', {});
  b.add(new THREE.SphereGeometry(0.0075, 10, 8), 'energy', { p: [0, 0, 0.141] });
  // guard
  b.add(extrudeZY([[-0.062, 0.022], [-0.07, 0.06], [-0.084, 0.07], [-0.09, 0.05], [-0.086, -0.052], [-0.078, -0.072], [-0.07, -0.062], [-0.062, -0.03]], 0.032, 0.004, 4, 2), 'gold', {});
  b.add(rbox(0.038, 0.034, 0.03, 0.006), 'hunterBlack', { p: [0, -0.004, -0.078] });
  b.add(rbox(0.04, 0.004, 0.024, 0.001), 'energy', { p: [0, -0.004, -0.078] });
  // blade (curved, glowing V-edge)
  const N = b.fp ? 22 : 9;
  const st = [];
  const z0 = -0.088, L = 0.78;
  const curve = (u) => 0.075 * u * u;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const z = z0 - L * u;
    const c = curve(u);
    let top = 0.028 - 0.008 * u + c;
    let edge = -0.034 + 0.008 * u + c;
    const tipU = 0.86;
    if (u > tipU) {
      const k = (u - tipU) / (1 - tipU);
      top = mix(top, c + 0.004, k * k);
      edge = mix(edge, c + 0.004, Math.sqrt(k));
    }
    const t = mix(0.012, 0.005, u) * (u > 0.96 ? (1 - u) / 0.04 * 0.8 + 0.2 : 1);
    st.push({ z, top, edge, t, grind: mix(edge, top, 0.4) });
  }
  const bg = bladeGeometry(st);
  b.add(bg.flat, 'bladeCore', { uv: 0.2 });
  b.add(bg.grind, 'energyEdge', { uv: 0.2 });
  // glowing fuller lines
  if (b.fp) {
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let i = 1; i < N - 2; i++) { const p = st[i]; pts.push(new THREE.Vector3(sx * (p.t / 2 - 0.0002), mix(p.edge, p.top, 0.72), p.z)); }
      b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.0012, 4, false), 'energy', {});
    }
  }
  // additive glow strips along the edge (pulsed by viewmodel)
  {
    const pts = st.slice(1).map((p) => [0, mix(p.edge, p.grind, 0.3), p.z]);
    b.pivot('glow', [0, 0, 0]);
    b.add(ribbonGeometry(pts, 0.03, 'y'), 'glowAdd', { g: 'glow', uv: 'keep' });
    b.add(ribbonGeometry(pts, 0.026, 'x'), 'glowAdd', { g: 'glow', uv: 'keep' });
  }
  const tip = st[st.length - 1];
  b.marker('muzzle', [0, tip.edge, tip.z]);
  const tb = st[Math.round(st.length * 0.5)];
  b.marker('trailBase', [0, tb.edge, tb.z]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const BUILDERS = { ak47: buildAK, m4a1: buildM4, mg3: buildMG3, deagle: buildDeagle, knife: buildKnife, grenade: buildGrenade, blade: buildBlade };
export const WEAPON_IDS = Object.keys(BUILDERS);
const TEMPLATES = new Map();

export function createWeaponModel(id, { lod = 'fp' } = {}) {
  const key = id + ':' + lod;
  let tpl = TEMPLATES.get(key);
  if (!tpl) {
    const fn = BUILDERS[id];
    if (!fn) throw new Error('createWeaponModel: unknown weapon id ' + id);
    const b = new Builder(lod);
    _lowDetail = lod === 'tp';
    try { fn(b); } finally { _lowDetail = false; }
    tpl = b.build();
    tpl.name = 'weapon_' + id;
    tpl.userData.weaponId = id;
    tpl.userData.lod = lod;
    TEMPLATES.set(key, tpl);
  }
  const g = tpl.clone(true);
  return g;
}

// =============================================================================
//  Procedural texture library — "New Silent Village" (CF fan recreation)
//  Every texture is generated at runtime (typed-array pixel loops + a few
//  canvas text masks). Deterministic: same seed → same pixels on every client.
//  All surface textures tile seamlessly (periodic noise / periodic layouts).
//
//  Conventions
//  - Generator math uses image space (x → right = +U, y → down = −V). Data is
//    flipped on packing, so image "top" = V=1 (e.g. "bottom of tile" = V≈0).
//  - map: sRGB; normalMap: OpenGL (+Y = +V) tangent space; roughnessMap: linear,
//    grayscale (R=G=B). Metal sets pack G=roughness, B=metalness in the same
//    texture and also expose it as `metalnessMap` (use with material.metalness=1).
//  - Returned sets are CACHED and SHARED — clone before changing repeat/offset,
//    e.g. `withRepeat(Tex.brick(), 3, 2)` (clones share the GPU upload).
//  - Tile sizes (meters per 0..1 UV) are in TILE_METERS; object-type textures
//    (window, door, sign, poster, clock) map one object onto 0..1 UV.
// =============================================================================
import * as THREE from 'three';

/** Real-world size (meters) covered by one texture tile (0..1 UV), square tiles. */
export const TILE_METERS = {
  woodSiding: 2,      // 10 lap boards, 20 cm exposure, boards along U, dirt band at tile bottom
  planks: 2,          // 14 deck boards along U (~14 cm), joists every 40 cm
  weatheredWood: 1,   // continuous grain along U ({vertical:true} → along V)
  crate: 1,           // one crate face (frame + diagonal brace)
  dirt: 4,
  ground: 4,
  road: 8,            // two wagon tracks (4 ruts) running along V, compacted centre at U≈0.5
  rock: 8,            // horizontal strata
  shingles: 2,        // 16 rows, 12.5 cm exposure, butts facing −V (eave)
  corrugated: 1,      // 13 ridges (7.7 cm pitch) running along V, bolt row near top
  brick: 1,           // 5 bricks × 14 courses (running bond)
  stoneFoundation: 2,
  plaster: 2,
  metal: 1,
  container: 2.5,     // 9 trapezoid corrugations along V; top/bottom rails at tile edges (1 tile = container height)
  sandbag: 0.5,       // burlap weave, one seam per tile
  hay: 1,
  cloth: 1,           // stripes (if any): 8 per tile, vertical
  metalDark: 1,
};

/** Intended object size [w, h] in meters for non-tiling textures (UV 0..1 = whole object). */
export const OBJECT_METERS = {
  window: [1.0, 1.5], door: [1.1, 2.2], poster: [0.5, 0.75], clockFace: [1.0, 1.0], sign: null /* any, keep w:h ratio */,
};

// ----------------------------------------------------------------------------- state
const SIZES = { low: 256, medium: 512, high: 1024 };
let _quality = 'high';
let _maxAniso = 8;          // used until initTextures() provides the real value
const _cache = new Map();
const _allTex = [];

export function initTextures(renderer) {
  try {
    const a = renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy();
    if (a) _maxAniso = Math.max(1, Math.min(16, a));
  } catch (e) { /* keep default */ }
  for (const t of _allTex) if (t.anisotropy !== _maxAniso) { t.anisotropy = _maxAniso; t.needsUpdate = true; }
}

export function setTextureQuality(q) { if (SIZES[q]) _quality = q; }
export function getTextureQuality() { return _quality; }
const baseSize = () => SIZES[_quality];
const qScale = () => SIZES[_quality] / 1024;

/** Clone a texture set (sharing GPU data) and set repeat on every map. */
export function withRepeat(set, rx, ry = rx) {
  const out = {};
  const done = new Map();
  for (const k in set) {
    const t = set[k];
    if (!t || !t.isTexture) { out[k] = t; continue; }
    if (!done.has(t)) { const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; done.set(t, c); }
    out[k] = done.get(t);
  }
  return out;
}

function cached(key, gen) {
  const k = key + '|' + _quality;
  let s = _cache.get(k);
  if (!s) {
    const outer = _poolDepth++ === 0;
    try { s = gen(); } finally { if (--_poolDepth === 0 && outer) releasePool(); }
    _cache.set(k, s);
  }
  return s;
}

// ---- scratch-buffer pool: every Float32Array/Int32Array a generator allocates is
// temporary (textures keep only their packed Uint8 data), so buffers are recycled
// between generators and dropped shortly after the last texture is built.
const _pool = new Map(), _inUse = [];
let _poolDepth = 0, _poolTimer = 0;
function f32(n) {
  const list = _pool.get('f' + n);
  let a = list && list.pop();
  if (a) a.fill(0); else a = new Float32Array(n);
  _inUse.push(a);
  return a;
}
function i32(n) {
  const list = _pool.get('i' + n);
  let a = list && list.pop();
  if (a) a.fill(0); else a = new Int32Array(n);
  _inUse.push(a);
  return a;
}
function releasePool() {
  for (const a of _inUse) {
    const key = (a instanceof Float32Array ? 'f' : 'i') + a.length;
    let list = _pool.get(key);
    if (!list) { list = []; _pool.set(key, list); }
    if (list.length < 24) list.push(a);
  }
  _inUse.length = 0;
  if (typeof setTimeout === 'function') {
    clearTimeout(_poolTimer);
    _poolTimer = setTimeout(() => { if (_poolDepth === 0) _pool.clear(); }, 2000);
    if (_poolTimer && _poolTimer.unref) _poolTimer.unref();
  }
}

// ----------------------------------------------------------------------------- math / rng
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

function hmix(h) {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function hashStr(s) {
  s = String(s);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const seedOf = (seed, salt) => hmix(hashStr(seed ?? 0) ^ Math.imul(salt + 1, 0x9e3779b1)) || 1;

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (R, a, b) => a + (b - a) * R();
const pick = (R, arr) => arr[Math.floor(R() * arr.length) % arr.length];
const gauss = (R) => (R() + R() + R() - 1.5) * 1.1547;

function rgb(c) {
  const h = new THREE.Color(c).getHex();
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}
const wrapD = (a, b, P) => { let d = Math.abs(a - b) % P; return d > P * 0.5 ? P - d : d; };
const wrapS = (d, P) => { d %= P; if (d > P * 0.5) d -= P; else if (d < -P * 0.5) d += P; return d; };

// ----------------------------------------------------------------------------- noise fields
const GX = new Float32Array(16), GY = new Float32Array(16);
for (let i = 0; i < 16; i++) { const a = ((i + 0.5) / 16) * Math.PI * 2; GX[i] = Math.cos(a); GY[i] = Math.sin(a); }

// add one periodic gradient-noise octave (cx × cy lattice cells over the field)
function octave(out, rw, rh, cx, cy, amp, seed) {
  const kx = cx / rw, ky = cy / rh;
  const s = Math.imul(seed | 0, 0x5bd1e995) | 0;
  for (let y = 0; y < rh; y++) {
    const py = (y + 0.5) * ky, yi = py | 0, fy = py - yi;
    const y1 = yi + 1 >= cy ? 0 : yi + 1;
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const hy0 = (Math.imul(yi, 0x27d4eb2f) + s) | 0, hy1 = (Math.imul(y1, 0x27d4eb2f) + s) | 0;
    const fy1 = fy - 1;
    let o = y * rw;
    for (let x = 0; x < rw; x++, o++) {
      const px = (x + 0.5) * kx, xi = px | 0, fx = px - xi;
      const x1 = xi + 1 >= cx ? 0 : xi + 1;
      const hx0 = Math.imul(xi, 0x165667b1), hx1 = Math.imul(x1, 0x165667b1);
      const a = hmix(hx0 + hy0) & 15, b = hmix(hx1 + hy0) & 15, c = hmix(hx0 + hy1) & 15, d = hmix(hx1 + hy1) & 15;
      const fx1 = fx - 1;
      const n00 = GX[a] * fx + GY[a] * fy, n10 = GX[b] * fx1 + GY[b] * fy;
      const n01 = GX[c] * fx + GY[c] * fy1, n11 = GX[d] * fx1 + GY[d] * fy1;
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const nx0 = n00 + (n10 - n00) * u, nx1 = n01 + (n11 - n01) * u;
      out[o] += (nx0 + (nx1 - nx0) * v) * 1.5 * amp;
    }
  }
}

// separable bilinear, wrapping resample
function resample(src, sw, sh, dw, dh) {
  let tmp = src;
  if (sw !== dw) {
    const xa = new Int32Array(dw), xb = new Int32Array(dw), xf = new Float32Array(dw);
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5; let i = Math.floor(sx); xf[x] = sx - i;
      i %= sw; if (i < 0) i += sw; xa[x] = i; xb[x] = i + 1 >= sw ? 0 : i + 1;
    }
    tmp = f32(dw * sh);
    for (let y = 0; y < sh; y++) {
      const r = y * sw, o = y * dw;
      for (let x = 0; x < dw; x++) { const a = src[r + xa[x]]; tmp[o + x] = a + (src[r + xb[x]] - a) * xf[x]; }
    }
  }
  if (sh === dh) return tmp === src ? src.slice() : tmp;
  const out = f32(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5; let j = Math.floor(sy); const fy = sy - j;
    j %= sh; if (j < 0) j += sh; const r0 = j * dw, r1 = (j + 1 >= sh ? 0 : j + 1) * dw, o = y * dw;
    for (let x = 0; x < dw; x++) { const a = tmp[r0 + x]; out[o + x] = a + (tmp[r1 + x] - a) * fy; }
  }
  return out;
}

/**
 * Tileable fBm (gradient noise), pyramid-evaluated: each octave is computed at
 * ~spp samples per lattice cell and bilinearly upsampled, so low octaves are cheap.
 * sx, sy = lattice cells across the tile for the first octave (integers → seamless).
 * Output roughly in [-1, 1] (std ≈ 0.25–0.3).
 */
function fbm(W, H, o) {
  const sx = Math.max(1, Math.round(o.sx || 4)), sy = Math.max(1, Math.round(o.sy || o.sx || 4));
  const oct = o.oct || 5, gain = o.gain ?? 0.5, seed = o.seed | 0, spp = o.spp || 6;
  let n = 0, tot = 0, a = 1;
  for (let i = 0; i < oct; i++) { if (i > 0 && ((sx << i) > W / 2 || (sy << i) > H / 2)) break; n++; tot += a; a *= gain; }
  let cur = null, cw = 0, ch = 0, amp = 1 / tot;
  // octaves are evaluated at most at half resolution (then upsampled) unless o.full
  const capW = o.full || W < 256 ? W : W >> 1, capH = o.full || H < 256 ? H : H >> 1;
  for (let i = 0; i < n; i++) {
    const cx = sx << i, cy = sy << i;
    const rw = Math.min(capW, cx * spp), rh = Math.min(capH, cy * spp);
    if (!cur) cur = f32(rw * rh);
    else if (rw !== cw || rh !== ch) cur = resample(cur, cw, ch, rw, rh);
    cw = rw; ch = rh;
    octave(cur, rw, rh, cx, cy, amp, seed + i * 7919);
    amp *= gain;
  }
  if (cw !== W || ch !== H) cur = resample(cur, cw, ch, W, H);
  return cur;
}

// white noise in [0,1); tables are shared (per size, 4 variants) — read-only!
const _whiteCache = new Map();
// white noise in [0,1); tables are shared (per size, 4 variants) — read-only!
function white(W, H, seed) {
  const key = W + 'x' + H + ':' + (seed & 3);
  let out = _whiteCache.get(key);
  if (out) return out;
  out = new Float32Array(W * H);  // persistent (cached)
  let a = (seed & 3) * 0x9e3779b1 + W * 31 + H;
  for (let i = 0; i < out.length; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  _whiteCache.set(key, out);
  return out;
}

// fine 1-D fibre streaks: each row (or column) gets its own periodic 1-D noise; [-0.5,0.5]
function fibers(W, H, K, seed, vertical = false) {
  const out = f32(W * H), R = makeRng(seed);
  const L = vertical ? H : W, M = vertical ? W : H, vals = new Float32Array(K + 1);
  const prev = new Float32Array(L), cur = new Float32Array(L), step = K / L;
  for (let m = 0; m < M; m++) {
    for (let k = 0; k < K; k++) vals[k] = R() - 0.5;
    vals[K] = vals[0];
    let p = R() * K;
    for (let l = 0; l < L; l++) {
      const k0 = p | 0, f = p - k0, s = f * f * (3 - 2 * f);
      cur[l] = vals[k0] + (vals[k0 + 1] - vals[k0]) * s;
      p += step; if (p >= K) p -= K;
    }
    if (vertical) {
      for (let l = 0; l < L; l++) { out[l * W + m] = m === 0 ? cur[l] : cur[l] * 0.7 + prev[l] * 0.3; prev[l] = cur[l]; }
    } else {
      const o = m * W;
      for (let l = 0; l < L; l++) { out[o + l] = m === 0 ? cur[l] : cur[l] * 0.7 + prev[l] * 0.3; prev[l] = cur[l]; }
    }
  }
  return out;
}

// periodic 1-D noise function on t ∈ [0,1)
function noise1(K, seed) {
  const R = makeRng(seed), v = new Float32Array(K);
  for (let k = 0; k < K; k++) v[k] = R() * 2 - 1;
  return (t) => {
    t -= Math.floor(t);
    const p = t * K, i = p | 0, f = p - i, j = i + 1 === K ? 0 : i + 1, s = f * f * (3 - 2 * f);
    return v[i] + (v[j] - v[i]) * s;
  };
}

// wrapped separable box blur
function blur(src, W, H, r) {
  r = Math.max(1, Math.round(r));
  const tmp = f32(W * H), out = f32(W * H), d = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W; let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + (((k % W) + W) % W)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s * d;
      s += src[row + ((x + r + 1) % W)] - src[row + (((x - r) % W) + W) % W];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[(((k % H) + H) % H) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s * d;
      s += tmp[((y + r + 1) % H) * W + x] - tmp[((((y - r) % H) + H) % H) * W + x];
    }
  }
  return out;
}

function sampleW(f, W, H, x, y) {
  x -= 0.5; y -= 0.5;
  let xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  xi %= W; if (xi < 0) xi += W; yi %= H; if (yi < 0) yi += H;
  const x1 = xi + 1 === W ? 0 : xi + 1, y1 = yi + 1 === H ? 0 : yi + 1;
  const a = f[yi * W + xi], b = f[yi * W + x1], c = f[y1 * W + xi], d = f[y1 * W + x1];
  const t = a + (b - a) * fx;
  return t + (c + (d - c) * fx - t) * fy;
}

/** Periodic Worley noise. Distances in cell units. Optional warp arrays (tile units). */
function worley(W, H, cx, cy, seed, o = {}) {
  const N = cx * cy, R = makeRng(seed), jit = o.jitter ?? 0.9;
  const fx = f32(N), fy = f32(N);
  for (let i = 0; i < N; i++) { fx[i] = 0.5 + (R() - 0.5) * jit; fy[i] = 0.5 + (R() - 0.5) * jit; }
  const f1 = f32(W * H), f2 = f32(W * H), id = i32(W * H);
  const ox = o.offs ? f32(W * H) : null, oy = o.offs ? f32(W * H) : null;
  const wx = o.wx, wy = o.wy, wa = o.wa || 0, mask = o.mask, mth = o.maskT ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask && mask[i] <= mth) { f1[i] = 1; f2[i] = 2; continue; }
      let u = ((x + 0.5) / W) * cx, v = ((y + 0.5) / H) * cy;
      if (wa) { u += wx[i] * wa * cx; v += wy[i] * wa * cy; }
      u -= Math.floor(u / cx) * cx; v -= Math.floor(v / cy) * cy;
      const ix = u | 0, iy = v | 0;
      let d1 = 1e9, d2 = 1e9, best = 0, bx = 0, by = 0;
      for (let dy = -1; dy <= 1; dy++) {
        let gy = iy + dy; gy = gy < 0 ? gy + cy : gy >= cy ? gy - cy : gy;
        for (let dx = -1; dx <= 1; dx++) {
          let gx = ix + dx; gx = gx < 0 ? gx + cx : gx >= cx ? gx - cx : gx;
          const k = gy * cx + gx;
          const ex = u - (ix + dx + fx[k]), ey = v - (iy + dy + fy[k]);
          const d = ex * ex + ey * ey;
          if (d < d1) { d2 = d1; d1 = d; best = k; bx = ex; by = ey; } else if (d < d2) d2 = d;
        }
      }
      f1[i] = Math.sqrt(d1); f2[i] = Math.sqrt(d2); id[i] = best;
      if (ox) { ox[i] = bx; oy[i] = by; }
    }
  }
  return { f1, f2, id, ox, oy };
}

// ----------------------------------------------------------------------------- raster helpers (wrapping)
function forDisc(W, H, cx, cy, r, fn) {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  const ir = 1 / r;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * ir;
    let yy = y % H; if (yy < 0) yy += H;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * ir, d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      let xx = x % W; if (xx < 0) xx += W;
      fn(yy * W + xx, Math.sqrt(d2), dx, dy);
    }
  }
}
// rotated ellipse: fn(i, d, lx, ly) with lx,ly in normalized local coords
function forEllipse(W, H, cx, cy, a, b, ang, fn) {
  const r = Math.max(a, b), c = Math.cos(ang), s = Math.sin(ang);
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    let yy = y % H; if (yy < 0) yy += H;
    const py = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - cx;
      const lx = (px * c + py * s) / a, ly = (-px * s + py * c) / b, d2 = lx * lx + ly * ly;
      if (d2 >= 1) continue;
      let xx = x % W; if (xx < 0) xx += W;
      fn(yy * W + xx, Math.sqrt(d2), lx, ly);
    }
  }
}
// thick anti-aliased segment: fn(i, dNorm 0..1 from centre line, tAlong 0..1)
function forLine(W, H, x0, y0, x1, y1, r, fn) {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  if (L2 < 1e-6) { forDisc(W, H, x0, y0, r, (i, d) => fn(i, d, 0)); return; }
  const L = Math.sqrt(L2), nx = -dy / L, ny = dx / L;
  const visit = (x, y) => {
    const px = x + 0.5 - x0, py = y + 0.5 - y0;
    const t = (px * dx + py * dy) / L2;
    let d;
    if (t <= 0) d = Math.sqrt(px * px + py * py);
    else if (t >= 1) d = Math.sqrt((px - dx) * (px - dx) + (py - dy) * (py - dy));
    else d = Math.abs(px * nx + py * ny);
    if (d < r) {
      let xx = x % W; if (xx < 0) xx += W;
      let yy = y % H; if (yy < 0) yy += H;
      fn(yy * W + xx, d / r, t < 0 ? 0 : t > 1 ? 1 : t);
    }
  };
  if (Math.abs(dx) >= Math.abs(dy)) {
    const xa = Math.floor(Math.min(x0, x1) - r), xb = Math.ceil(Math.max(x0, x1) + r);
    const sl = dy / dx, ext = (r * L) / Math.abs(dx) + 1;
    for (let x = xa; x <= xb; x++) {
      const yc = y0 + (x + 0.5 - x0) * sl;
      for (let y = Math.floor(yc - ext); y <= Math.ceil(yc + ext); y++) visit(x, y);
    }
  } else {
    const ya = Math.floor(Math.min(y0, y1) - r), yb = Math.ceil(Math.max(y0, y1) + r);
    const sl = dx / dy, ext = (r * L) / Math.abs(dy) + 1;
    for (let y = ya; y <= yb; y++) {
      const xc = x0 + (y + 0.5 - y0) * sl;
      for (let x = Math.floor(xc - ext); x <= Math.ceil(xc + ext); x++) visit(x, y);
    }
  }
}
// jagged polyline (for cracks); returns list of points
function jagged(R, x0, y0, x1, y1, segs, amp) {
  const pts = [[x0, y0]];
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  for (let i = 1; i < segs; i++) {
    const t = i / segs, o = (R() - 0.5) * 2 * amp;
    pts.push([x0 + dx * t + nx * o, y0 + dy * t + ny * o]);
  }
  pts.push([x1, y1]);
  return pts;
}
function forPolyline(W, H, pts, r, fn) {
  for (let i = 0; i + 1 < pts.length; i++) forLine(W, H, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, fn);
}

// ----------------------------------------------------------------------------- canvas (text masks)
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
/** Draw white-on-black with `draw(ctx)` and return a Float32 mask (red channel). */
function canvasMask(w, h, draw) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  draw(ctx, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, m = f32(w * h);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) m[i] = d[j] * (1 / 255);
  return m;
}
function fitText(ctx, text, maxW, px, fontFn) {
  ctx.font = fontFn(px);
  const w = ctx.measureText(text).width;
  if (w > maxW) { px = Math.max(6, Math.floor((px * maxW) / w)); ctx.font = fontFn(px); }
  return px;
}

let _ryeOK = false;
function ryeAvailable() {
  if (_ryeOK) return true;
  try {
    const ctx = makeCanvas(8, 8).getContext('2d');
    const s = 'WANTED Saloon 1887';
    ctx.font = '40px monospace'; const a = ctx.measureText(s).width;
    ctx.font = "40px 'Rye', monospace"; const b = ctx.measureText(s).width;
    _ryeOK = Math.abs(a - b) > 0.5;
  } catch (e) { _ryeOK = false; }
  return _ryeOK;
}
// Western display font: 'Rye' when the page has it loaded, bold serif fallback otherwise.
const westernFont = (px) => (ryeAvailable() ? `${px}px 'Rye', Georgia, serif` : `bold ${px}px Georgia, 'Times New Roman', serif`);
const serifFont = (px, w = 'bold') => `${w} ${px}px Georgia, 'Times New Roman', serif`;
const stencilFont = (px) => `bold ${px}px 'Stencil', 'Stencil Std', 'Arial Black', Impact, sans-serif`;

const _fontWaiters = [];
let _fontHooked = false;
function flushFontWaiters() {
  if (!_fontWaiters.length || !ryeAvailable()) return;
  const list = _fontWaiters.splice(0);
  for (const f of list) { try { f(); } catch (e) { console.warn('[textures] font regen failed', e); } }
}
function whenWesternFont(cb) {
  if (typeof document === 'undefined' || !document.fonts) return;
  _fontWaiters.push(cb);
  if (!_fontHooked) {
    _fontHooked = true;
    try { document.fonts.addEventListener('loadingdone', () => setTimeout(flushFontWaiters, 0)); } catch (e) { /* noop */ }
  }
  try { document.fonts.load("40px 'Rye'").then(() => setTimeout(flushFontWaiters, 0), () => {}); } catch (e) { /* noop */ }
}
// Regenerate a text texture set in place once the Western font becomes available.
function regenWhenFont(set, gen) {
  if (ryeAvailable()) return;
  whenWesternFont(() => {
    const n = gen();
    for (const k in set) {
      const a = set[k], b = n[k];
      if (a && b && a.isDataTexture && b.isDataTexture && a.image.data.length === b.image.data.length) {
        a.image.data.set(b.image.data); a.needsUpdate = true;
      }
      if (b && b.dispose) b.dispose();
    }
  });
}

// ----------------------------------------------------------------------------- packing → THREE textures
function makeTex(data, W, H, srgb, clamp) {
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.flipY = false;
  t.anisotropy = _maxAniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  _allTex.push(t);
  return t;
}

function surf(W, H, metal = false, alpha = false) {
  const N = W * H;
  return {
    W, H, r: f32(N), g: f32(N), b: f32(N),
    h: f32(N), ro: f32(N), me: metal ? f32(N) : null, a: alpha ? f32(N) : null,
  };
}

// Sobel normal map (wrapping unless clamp), output flipped to GL row order, packed RGBA8
function normalData(h, W, H, k, clamp) {
  const buf = new ArrayBuffer(W * H * 4), out = new Uint32Array(buf);
  for (let y = 0; y < H; y++) {
    const yu = y === 0 ? (clamp ? 0 : H - 1) : y - 1, yd = y === H - 1 ? (clamp ? H - 1 : 0) : y + 1;
    const ym = yu * W, y0 = y * W, yp = yd * W;
    let o = (H - 1 - y) * W;
    for (let x = 0; x < W; x++, o++) {
      const xm = x === 0 ? (clamp ? 0 : W - 1) : x - 1, xp = x === W - 1 ? (clamp ? W - 1 : 0) : x + 1;
      const tl = h[ym + xm], tc = h[ym + x], tr = h[ym + xp], l = h[y0 + xm], r = h[y0 + xp];
      const bl = h[yp + xm], bc = h[yp + x], br = h[yp + xp];
      const nx = -((tr + 2 * r + br) - (tl + 2 * l + bl)) * k;
      const ny = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) * k;
      const inv = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
      out[o] = 0xff000000 | (((inv + 128) | 0) << 16) | (((ny * inv + 128) | 0) << 8) | ((nx * inv + 128) | 0);
    }
  }
  return new Uint8Array(buf);
}

/**
 * Turn a float surface into a texture set.
 * nStrength: normal strength tuned at 1024-base; scaled for lower quality.
 */
function finish(s, nStrength, opt = {}) {
  const { W, H } = s, clamp = !!opt.clamp, sat = opt.sat ?? 0.86;
  const buf = new ArrayBuffer(W * H * 4), u32 = new Uint32Array(buf);
  const R_ = s.r, G_ = s.g, B_ = s.b, A_ = s.a;
  for (let y = 0; y < H; y++) {
    let o = (H - 1 - y) * W, i = y * W;
    for (let x = 0; x < W; x++, i++, o++) {
      let r = R_[i], g = G_[i], b = B_[i];
      const l = r * 0.3 + g * 0.59 + b * 0.11;
      r = (l + (r - l) * sat) * 255 + 0.5; g = (l + (g - l) * sat) * 255 + 0.5; b = (l + (b - l) * sat) * 255 + 0.5;
      const ri = r < 0 ? 0 : r > 255 ? 255 : r | 0, gi = g < 0 ? 0 : g > 255 ? 255 : g | 0, bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      u32[o] = 0xff000000 | (bi << 16) | (gi << 8) | ri;
    }
  }
  if (A_) {
    const u8 = new Uint8Array(buf);
    for (let y = 0; y < H; y++) {
      let o = ((H - 1 - y) * W) * 4 + 3, i = y * W;
      for (let x = 0; x < W; x++, i++, o += 4) { const a = A_[i] * 255 + 0.5; u8[o] = a < 0 ? 0 : a > 255 ? 255 : a; }
    }
  }
  const set = { map: makeTex(new Uint8Array(buf), W, H, true, clamp) };
  if (nStrength) set.normalMap = makeTex(normalData(s.h, W, H, nStrength * qScale(), clamp), W, H, false, clamp);
  if (s.ro && !opt.noRough) {
    const half = W >= 1024 && H >= 1024 && !opt.fullRough;
    const rw = half ? W >> 1 : W, rh = half ? H >> 1 : H;
    const rb = new ArrayBuffer(rw * rh * 4), ru = new Uint32Array(rb);
    const ro = s.ro, me = s.me;
    for (let y = 0; y < rh; y++) {
      let o = (rh - 1 - y) * rw;
      for (let x = 0; x < rw; x++, o++) {
        let rv, mv = 0;
        if (half) {
          const i = 2 * y * W + 2 * x;
          rv = (ro[i] + ro[i + 1] + ro[i + W] + ro[i + W + 1]) * 0.25;
          if (me) mv = (me[i] + me[i + 1] + me[i + W] + me[i + W + 1]) * 0.25;
        } else { const i = y * W + x; rv = ro[i]; if (me) mv = me[i]; }
        rv = rv * 255 + 0.5; rv = rv < 0 ? 0 : rv > 255 ? 255 : rv;
        let bv = rv;
        if (me) { bv = mv * 255 + 0.5; bv = bv < 0 ? 0 : bv > 255 ? 255 : bv; }
        const ri = rv & 255;
        ru[o] = 0xff000000 | ((bv & 255) << 16) | (ri << 8) | ri;
      }
    }
    set.roughnessMap = makeTex(new Uint8Array(rb), rw, rh, false, clamp);
    if (s.me) set.metalnessMap = set.roughnessMap;
  }
  return set;
}

// helper to write color
function put(s, i, r, g, b) { s.r[i] = r; s.g[i] = g; s.b[i] = b; }
function mixPx(s, i, r, g, b, t) {
  s.r[i] += (r - s.r[i]) * t; s.g[i] += (g - s.g[i]) * t; s.b[i] += (b - s.b[i]) * t;
}
function mulPx(s, i, m) { s.r[i] *= m; s.g[i] *= m; s.b[i] *= m; }

// cavity / AO from height: darken where below local average
function applyCavity(s, radius, amount, lighten = 0.3) {
  const bl = blur(s.h, s.W, s.H, radius);
  for (let i = 0; i < bl.length; i++) {
    let d = (s.h[i] - bl[i]) * amount;
    d = d < -0.6 ? -0.6 : d > 0.25 * lighten ? 0.25 * lighten : d;
    mulPx(s, i, 1 + d);
  }
}

// shared wood grain value from a stretched field: returns ring-line intensity 0..1

// Smooth meander field for wood grain. Ring coordinate: R = N * coord + A * g.
function grainNoise(W, H, seed, vertical = false, along = 2, across = 6) {
  return vertical ? fbm(W, H, { sx: across, sy: along, oct: 3, gain: 0.45, seed }) : fbm(W, H, { sx: along, sy: across, oct: 3, gain: 0.45, seed });
}

// Per-index 1-D masks along a line: table[idx*L + l] in [-1,1], periodic in l.
function maskTable(M, L, K, seed) {
  const t = f32(M * L), R = makeRng(seed), v = new Float32Array(K);
  for (let m = 0; m < M; m++) {
    for (let k = 0; k < K; k++) v[k] = R() * 2 - 1;
    for (let l = 0; l < L; l++) {
      const p = (l / L) * K, k0 = p | 0, f = p - k0, k1 = k0 + 1 === K ? 0 : k0 + 1, s = f * f * (3 - 2 * f);
      t[m * L + l] = v[k0] + (v[k1] - v[k0]) * s;
    }
  }
  return t;
}

// =============================================================================
//  SURFACES
// =============================================================================

// woodSiding — 2 m tile, 10 lap boards along U with peeling paint over grey wood.
function genWoodSiding(color, peel, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 11), R = makeRng(sd);
  const [pr, pg, pb] = rgb(color);
  const NB = 10, bh = H / NB, NR = 90, GA = 2.6;
  const B = [];
  for (let i = 0; i < NB; i++) B.push({ j: R() < 0.7 ? R() * W : -1, tone: R() * 2 - 1, pbias: (R() - 0.5) * 0.2, go: R() * NR, gray: R() });
  const gN = grainNoise(W, H, sd + 2, false, 1, 12);
  const nP = fbm(W, H, { sx: 3, sy: 20, oct: 6, gain: 0.58, seed: sd + 1 });
  const nC = fbm(W, H, { sx: 6, sy: 40, oct: 3, gain: 0.5, seed: sd + 7 });
  const fib = fibers(W, H, 28, sd + 3);
  const nD = fbm(W, H, { sx: 4, sy: 4, oct: 5, seed: sd + 4 });
  const nS = fbm(W, H, { sx: 30, sy: 2, oct: 3, seed: sd + 5 });
  const wn = white(W, H, sd + 6);
  const s = surf(W, H);
  const T = 0.42 - peel * 0.85;
  for (let y = 0; y < H; y++) {
    const bi = Math.min(NB - 1, (y / bh) | 0), b = B[bi], t = (y - bi * bh) / bh;
    const prof = t < 0.92 ? 0.22 + 0.62 * t : 0.22 + 0.62 * 0.92 - ((t - 0.92) / 0.08) ** 2 * 0.3;
    const ao = 0.45 + 0.55 * sstep(0.0, 0.18, t);
    const edgeWear = sstep(0.82, 1.0, t) * 0.25 + sstep(0.08, 0.0, t) * 0.1;
    const vd = sstep(0.6, 1.0, y / H);
    const rowR = (y / H) * NR + b.go;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dj = b.j < 0 ? 1e9 : wrapD(x, b.j, W);
      const jw = sstep(20 * k, 0, dj) * 0.3;
      const Rr = rowR + gN[i] * GA, f = Rr - Math.floor(Rr);
      const late = sstep(0.72, 0.95, f) * sstep(1.0, 0.97, f);
      const fb = fib[i], w = wn[i];
      const wm = (0.9 + fb * 0.32 + gN[i] * 0.25) * (1 - late * 0.2) * (0.93 + nD[i] * 0.16);
      const wr = 0.49 * wm, wg = 0.48 * wm, wb = 0.46 * wm;
      const pv = nP[i] + (f - 0.5) * 0.06 + late * 0.05 + (w - 0.5) * 0.03 + b.pbias + edgeWear + jw;
      const paint = sstep(T + 0.01, T - 0.01, pv);
      const rimIn = paint * sstep(0.045, 0.0, T - pv);
      const rimOut = (1 - paint) * sstep(0.03, 0.0, pv - T);
      const crackle = paint * sstep(0.012, 0.0, Math.abs(nC[i])) * (0.4 + 0.6 * sstep(-0.3, 0.2, nD[i]));
      const fade = 0.03 + 0.08 * clamp01(nD[i] + 0.5) + b.gray * 0.04 + (1 - t) * 0.03;
      const tm = (1 + b.tone * 0.045 + (w - 0.5) * 0.035) * (1 - late * 0.05);
      let cr = lerp(pr, 0.72, fade) * tm, cg = lerp(pg, 0.71, fade) * tm, cb = lerp(pb, 0.68, fade) * tm;
      cr += rimIn * 0.05; cg += rimIn * 0.05; cb += rimIn * 0.045;
      const dk = (1 - rimOut * 0.4) * (1 - crackle * 0.45);
      let r = lerp(wr, cr, paint) * dk, gg = lerp(wg, cg, paint) * dk, bb = lerp(wb, cb, paint) * dk;
      const streak = Math.max(0, nS[i]) * (1 - t) * 0.8;
      const dirt = clamp01(vd * (0.75 + 0.6 * nD[i]) + streak * 0.3);
      r = lerp(r, 0.36, dirt * 0.75); gg = lerp(gg, 0.3, dirt * 0.75); bb = lerp(bb, 0.23, dirt * 0.75);
      put(s, i, r * ao, gg * ao, bb * ao);
      let h = prof + paint * 0.04 + rimIn * 0.03 - crackle * 0.02 + (1 - paint) * (fb * 0.04 - late * 0.03 + f * 0.02);
      if (dj < 1.6 * k + 0.4) { h -= 0.35; mulPx(s, i, 0.35); }
      s.h[i] = h;
      s.ro[i] = clamp01(lerp(0.9, 0.62 + nD[i] * 0.12, paint) + dirt * 0.08);
    }
  }
  const nailR = Math.max(1.2, 2.4 * k);
  const nail = (nx, ny) => {
    forDisc(W, H, nx, ny, nailR, (i, d) => { const c = 0.15 + (1 - d) * 0.08; put(s, i, c * 1.1, c * 0.85, c * 0.7); s.h[i] += (1 - d * d) * 0.05; s.ro[i] = 0.6; });
    const len = rr(R, 10, 45) * k;
    forLine(W, H, nx, ny + nailR, nx + rr(R, -1, 1), ny + nailR + len, Math.max(0.8, 1.6 * k), (i, d, t) => mixPx(s, i, 0.42, 0.26, 0.15, (1 - d) * (1 - t) * 0.4));
  };
  for (let bi = 0; bi < NB; bi++) {
    const ny = bi * bh + bh * 0.8;
    for (let st = 0; st < 5; st++) nail(((st + 0.5) * W) / 5 + rr(R, -5, 5) * k, ny + rr(R, -2, 2) * k);
    if (B[bi].j >= 0) { nail(B[bi].j - 6 * k, ny); nail(B[bi].j + 6 * k, ny); }
  }
  return finish(s, 9);
}

// planks — 2 m tile, 14 floor/deck boards along U.
function genPlanks(color, worn, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 21), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const NB = 14, bh = H / NB, NR = 110, GA = 3.2;
  const B = [];
  for (let i = 0; i < NB; i++) {
    const knots = [];
    const nk = R() < 0.55 ? (R() < 0.3 ? 2 : 1) : 0;
    for (let j = 0; j < nk; j++) knots.push({ x: R() * W, t: rr(R, 0.3, 0.7), r: rr(R, 5, 10) * k });
    B.push({ j1: R() * W, j2: R() < 0.3 ? R() * W : -1, tone: R() * 2 - 1, go: R() * NR, gray: R(), wear: R(), knots });
  }
  const gN = grainNoise(W, H, sd + 1, false, 2, 16);
  const fib = fibers(W, H, 32, sd + 2);
  const nL = fbm(W, H, { sx: 4, sy: 4, oct: 5, seed: sd + 3 });
  const nS = fbm(W, H, { sx: 5, sy: 20, oct: 5, seed: sd + 4 });
  const wn = white(W, H, sd + 5);
  const s = surf(W, H);
  const gapW = 2.2 * k + 0.4;
  for (let y = 0; y < H; y++) {
    const bi = Math.min(NB - 1, (y / bh) | 0), b = B[bi], t = (y - bi * bh) / bh;
    const dt = t * bh, ed = Math.min(dt - gapW, bh - dt);
    const crown = 0.55 + 0.08 * (1 - (2 * t - 1) ** 2);
    const round = sstep(0, 5 * k, ed);
    const edgeDark = 1 - (1 - sstep(0, 8 * k, ed)) * 0.3;
    const rowR = (y / H) * NR + b.go;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let kinf = 0, kcore = 0;
      for (let q = 0; q < b.knots.length; q++) {
        const kn = b.knots[q];
        const dx = wrapS(x - kn.x, W) / (kn.r * 2.4), dy = (dt - kn.t * bh) / kn.r;
        const d2 = dx * dx + dy * dy;
        if (d2 < 12) { kinf += Math.exp(-d2 * 0.5) * 2.2 * (dy < 0 ? -1 : 1); kcore += sstep(0.6, 0.25, d2); }
      }
      const Rr = rowR + gN[i] * GA + kinf, f = Rr - Math.floor(Rr);
      const late = sstep(0.7, 0.95, f) * sstep(1.0, 0.97, f), fb = fib[i];
      const dj = Math.min(wrapD(x, b.j1, W), b.j2 < 0 ? 1e9 : wrapD(x, b.j2, W));
      const wear = worn * sstep(-0.15, 0.35, nS[i] + (b.wear - 0.5) * 0.5);
      const gray = clamp01(0.4 + b.gray * 0.4 + nL[i] * 0.45);
      let m = (1.04 + b.tone * 0.16 + gN[i] * 0.3) * (1 - late * 0.2) * (0.94 + fb * 0.28) * (1 - kcore * 0.6);
      let r = cr * m, gg = cg * m, bb = cb * m;
      const l = (r + gg + bb) / 3;
      r = lerp(r, l * 1.03, gray * 0.6); gg = lerp(gg, l, gray * 0.6); bb = lerp(bb, l * 0.95, gray * 0.6);
      r = lerp(r, r * 1.15 + 0.05, wear * 0.5); gg = lerp(gg, gg * 1.13 + 0.045, wear * 0.5); bb = lerp(bb, bb * 1.1 + 0.04, wear * 0.5);
      const endDark = sstep(16 * k, 0, dj) * 0.25;
      m = edgeDark * (1 - endDark) * (0.97 + (wn[i] - 0.5) * 0.06);
      put(s, i, r * m, gg * m, bb * m);
      let h = crown * (0.4 + 0.6 * round) + late * 0.035 * (1 - wear * 0.6) + fb * 0.025 + f * 0.012 - kcore * 0.04;
      let ro = 0.82 - wear * 0.16 + late * 0.03 + (wn[i] - 0.5) * 0.04;
      if (dt < gapW || dj < 1.3 * k + 0.4) { h = 0.02; put(s, i, 0.07, 0.06, 0.05); ro = 1; }
      s.h[i] = h; s.ro[i] = ro;
    }
  }
  const nailR = Math.max(1.1, 2.2 * k);
  for (let bi = 0; bi < NB; bi++) {
    for (let j = 0; j < 5; j++) {
      const x = ((j + 0.5) * W) / 5 + rr(R, -2, 2) * k;
      for (const tt of [0.28, 0.74]) {
        const y = (bi + tt) * bh;
        forDisc(W, H, x, y, nailR * 2.4, (i, d) => mixPx(s, i, 0.22, 0.15, 0.1, (1 - d) * 0.22));
        forDisc(W, H, x, y, nailR, (i, d) => { put(s, i, 0.15, 0.13, 0.12); s.h[i] += (1 - d) * 0.02; s.ro[i] = 0.55; });
      }
    }
  }
  return finish(s, 8);
}

// weatheredWood — 1 m tile, raw silver-grey sun-bleached wood, grain along U.
function genWeatheredWood(seed, vertical) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 31), R = makeRng(sd);
  const NR = 40, GA = 1.7;
  const gN = grainNoise(W, H, sd + 1, false, 1, 4);
  const gV = fbm(W, H, { sx: 1, sy: 3, oct: 2, seed: sd + 9 });
  const gS = fbm(W, H, { sx: 1, sy: 28, oct: 3, gain: 0.5, seed: sd + 2 });
  const fib = fibers(W, H, 20, sd + 3);
  const nB = fbm(W, H, { sx: 3, sy: 6, oct: 5, seed: sd + 6 });
  const mt = maskTable(64, W, 5, sd + 4);
  const wn = white(W, H, sd + 7);
  const s = surf(W, H);
  const knots = [];
  for (let n = 0, nk = 1 + ((R() * 3) | 0); n < nk; n++) knots.push({ x: R() * W, y: R() * H, r: rr(R, 7, 14) * k });
  for (let y = 0; y < H; y++) {
    const base = (y / H) * NR;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let kinf = 0, kcore = 0;
      for (let q = 0; q < knots.length; q++) {
        const kn = knots[q], dx = wrapS(x - kn.x, W) / (kn.r * 2.6), dy = wrapS(y - kn.y, H) / kn.r, d2 = dx * dx + dy * dy;
        if (d2 < 16) { kinf += Math.exp(-d2 * 0.4) * 2.5 * (dy < 0 ? -1 : 1); kcore += sstep(0.7, 0.2, d2); }
      }
      const Rr = base + gN[i] * GA + gV[i] * 6 + kinf, f = Rr - Math.floor(Rr);
      const ridge = sstep(0.12, 0.9, f) * sstep(1.0, 0.95, f);
      const Rc = Rr / 6.5 + 0.31, ci = Math.floor(Rc), fc = Rc - ci;
      const cm = mt[(ci & 63) * W + x];
      const cw = 0.004 + 0.012 * clamp01(cm);
      const crack = cm > 0.05 ? sstep(cw, cw * 0.25, Math.abs(fc - 0.5)) : 0;
      const fb = fib[i], w = wn[i], st = gS[i];
      const warm = clamp01(0.3 + nB[i] * 1.1);
      let r = lerp(0.58, 0.56, warm), g = lerp(0.565, 0.51, warm), b = lerp(0.535, 0.44, warm);
      const m = (0.82 + ridge * 0.12 + fb * 0.3 + st * 0.4) * (0.95 + (w - 0.5) * 0.08);
      r *= m; g *= m; b *= m;
      const groove = (1 - ridge) * 0.25;
      r = lerp(r, r * 0.84, groove); g = lerp(g, g * 0.8, groove); b = lerp(b, b * 0.74, groove);
      if (crack > 0) { const c = 1 - crack * 0.8; r *= c; g *= c * 0.97; b *= c * 0.93; }
      if (kcore > 0) { const c = 1 - kcore * 0.5; r *= c; g *= c * 0.95; b *= c * 0.9; }
      put(s, i, r, g, b);
      s.h[i] = 0.5 + ridge * 0.07 + fb * 0.07 + st * 0.1 - crack * 0.45 - kcore * 0.08;
      s.ro[i] = clamp01(0.84 + (1 - ridge) * 0.06 + crack * 0.06);
    }
  }
  const nn = 3 + ((R() * 3) | 0);
  for (let n = 0; n < nn; n++) {
    const x = R() * W, y = R() * H;
    forLine(W, H, x, y, x + rr(R, -2, 2), y + rr(R, 20, 60) * k, 2.2 * k, (i, d, t) => mixPx(s, i, 0.38, 0.24, 0.15, (1 - d) * (1 - t) * 0.45));
    forDisc(W, H, x, y, 3.2 * k, (i, d) => { mulPx(s, i, 0.3 + d * 0.5); s.h[i] -= (1 - d) * 0.12; });
  }
  if (vertical) transposeSurf(s);
  return finish(s, 11);
}
function transposeSurf(s) {
  const { W } = s;
  for (const key of ['r', 'g', 'b', 'h', 'ro']) {
    const a = s[key], o = f32(a.length);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) o[x * W + (W - 1 - y)] = a[y * W + x];
    s[key] = o;
  }
}

// crate — one 1 m crate face: frame, vertical panel boards, diagonal brace, stencils.
function genCrate(seed) {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf(seed, 41), R = makeRng(sd);
  const gH = grainNoise(W, H, sd + 1, false, 1, 8), gV = grainNoise(W, H, sd + 2, true, 1, 8);
  const fibH = fibers(W, H, 16, sd + 3), fibV = fibers(W, H, 16, sd + 4, true);
  const nD = fbm(W, H, { sx: 4, sy: 4, oct: 5, seed: sd + 5 });
  const wn = white(W, H, sd + 6);
  const labels = ['FRAGILE', 'SUPPLY CO.', 'DRY GOODS', 'AMMUNITION', 'HANDLE WITH CARE', 'MINING CO.', 'BLASTING POWDER', 'U.S. ARMY'];
  const lab = pick(R, labels), num = 'No. ' + (10 + ((R() * 89) | 0));
  const red = R() < 0.35;
  const sten = canvasMask(W, H, (ctx) => {
    ctx.save(); ctx.translate(W * 0.36, H * 0.36); ctx.rotate(-0.02);
    fitText(ctx, num, W * 0.34, Math.round(H * 0.1), stencilFont); ctx.fillText(num, 0, 0); ctx.restore();
    ctx.save(); ctx.translate(W * 0.63, H * 0.7); ctx.rotate(0.015);
    fitText(ctx, lab, W * 0.42, Math.round(H * 0.075), stencilFont); ctx.fillText(lab, 0, 0); ctx.restore();
    for (const ax of [0.3, 0.7]) {
      ctx.beginPath(); const cx = W * ax, cy = H * 0.06, a = H * 0.035;
      ctx.moveTo(cx, cy - a); ctx.lineTo(cx + a, cy); ctx.lineTo(cx + a * 0.4, cy); ctx.lineTo(cx + a * 0.4, cy + a);
      ctx.lineTo(cx - a * 0.4, cy + a); ctx.lineTo(cx - a * 0.4, cy); ctx.lineTo(cx - a, cy); ctx.closePath(); ctx.fill();
    }
    ctx.font = stencilFont(Math.round(H * 0.035)); ctx.fillText('THIS SIDE UP', W * 0.5, H * 0.06);
  });
  const nSt = fbm(W, H, { sx: 16, sy: 16, oct: 3, seed: sd + 7 });
  const s = surf(W, H);
  const fw = 0.12, bw = 0.065, NP = 4, inner = 1 - 2 * fw, pw = inner / NP, NR = 44, GA = 2.2;
  const tone = [], goff = [];
  for (let i = 0; i < 12; i++) { tone.push(rr(R, -1, 1)); goff.push(R() * NR); }
  const S2 = Math.SQRT1_2;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / W;
      let part, e, Rr, fb, id;
      const perp = ((u - fw) + (v - (1 - fw))) * S2, along = ((u - fw) - (v - (1 - fw))) * S2;
      if (v < fw || v > 1 - fw) { part = 2; id = v < fw ? 0 : 1; e = Math.min(v < fw ? Math.min(v, fw - v) : Math.min(v - (1 - fw), 1 - v), u, 1 - u); Rr = v * NR + gH[i] * GA; fb = fibH[i]; }
      else if (u < fw || u > 1 - fw) { part = 3; id = u < fw ? 2 : 3; e = Math.min(u < fw ? Math.min(u, fw - u) : Math.min(u - (1 - fw), 1 - u), v - fw, 1 - fw - v); Rr = u * NR + gV[i] * GA; fb = fibV[i]; }
      else if (Math.abs(perp) < bw) { part = 1; id = 4; e = bw - Math.abs(perp); Rr = perp * NR * 1.3 + sampleW(gH, W, H, along * W, perp * W * 3) * GA; fb = fibH[(((y + x) % H) * W) + (x % W)]; }
      else { part = 0; const pu = (u - fw) / pw, pi = Math.min(NP - 1, Math.floor(pu)), pf = pu - pi; id = 5 + pi; e = Math.min(pf, 1 - pf) * pw; Rr = u * NR + gV[i] * GA; fb = fibV[i]; }
      Rr += goff[id];
      const f = Rr - Math.floor(Rr), late = sstep(0.7, 0.95, f) * sstep(1.0, 0.97, f);
      const m = (0.94 + tone[id] * 0.08) * (1 - late * 0.22) * (0.92 + fb * 0.3);
      const gray = clamp01(0.3 + nD[i] * 0.8);
      let r = 0.6 * m, gg = 0.49 * m, bb = 0.36 * m;
      const l = (r + gg + bb) / 3;
      r = lerp(r, l, gray * 0.5); gg = lerp(gg, l * 0.98, gray * 0.5); bb = lerp(bb, l * 0.95, gray * 0.5);
      let h, ao = 1;
      const rnd = sstep(0, 0.012, e);
      if (part === 0) {
        const dF = Math.min(u - fw, 1 - fw - u, v - fw, 1 - fw - v), dB = Math.abs(perp) - bw;
        ao = 0.5 + 0.5 * sstep(0, 0.05, Math.min(dF, dB));
        h = 0.25 + 0.1 * rnd + late * 0.02 + fb * 0.02;
        if (e < 0.004) { h = 0.05; r = gg = bb = 0.05; }
      } else if (part === 1) {
        const dF = Math.min(u - fw, 1 - fw - u, v - fw, 1 - fw - v);
        ao = 0.7 + 0.3 * sstep(0, 0.03, dF);
        h = 0.55 + 0.15 * rnd + late * 0.02 + fb * 0.02;
      } else {
        h = 0.65 + 0.2 * rnd + late * 0.02 + fb * 0.02;
        if (part === 3) ao = 0.75 + 0.25 * sstep(0, 0.02, Math.min(v - fw, 1 - fw - v));
      }
      const eg = 1 - sstep(0, 0.03, e);
      const mm = ao * (1 - eg * 0.22) * (0.97 + (wn[i] - 0.5) * 0.06);
      r *= mm; gg *= mm; bb *= mm;
      const st = sten[i] * sstep(-0.35, 0.1, nSt[i] + (wn[i] - 0.5) * 0.5) * 0.85;
      if (st > 0) { if (red) { r = lerp(r, 0.42, st); gg = lerp(gg, 0.14, st); bb = lerp(bb, 0.1, st); } else { r = lerp(r, 0.1, st); gg = lerp(gg, 0.09, st); bb = lerp(bb, 0.08, st); } }
      put(s, i, r, gg, bb);
      s.h[i] = h;
      s.ro[i] = 0.85 + (wn[i] - 0.5) * 0.06 - st * 0.1;
    }
  }
  const nailAt = (u, v) => forDisc(W, H, u * W, v * H, 2.6 * k, (i, d) => { put(s, i, 0.16, 0.14, 0.13); s.h[i] += (1 - d) * 0.05; s.ro[i] = 0.5; });
  for (const [u, v] of [[0.04, 0.04], [0.08, 0.06], [0.96, 0.04], [0.92, 0.06], [0.04, 0.96], [0.08, 0.94], [0.96, 0.96], [0.92, 0.94],
    [0.06, 0.2], [0.06, 0.5], [0.06, 0.8], [0.94, 0.2], [0.94, 0.5], [0.94, 0.8], [0.3, 0.06], [0.5, 0.94], [0.7, 0.06], [0.3, 0.94], [0.7, 0.94]]) nailAt(u, v);
  return finish(s, 7);
}

// dirt — 4 m tile: dusty ground, pebbles, dried-mud cracks, dry grass tufts.
function genDirt(seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 51), R = makeRng(sd);
  const lf = fbm(W, H, { sx: 3, oct: 7, gain: 0.55, seed: sd + 1 });
  const mf = fbm(W, H, { sx: 12, oct: 5, gain: 0.5, seed: sd + 2 });
  const pm = fbm(W, H, { sx: 2, oct: 4, seed: sd + 4 });
  const wn = white(W, H, sd + 5);
  const cm = f32(W * H);
  for (let i = 0; i < cm.length; i++) cm[i] = sstep(0.16, 0.3, pm[i]);
  const wo = worley(W, H, 26, 26, sd + 8, { wx: mf, wy: lf, wa: 0.006, mask: cm, maskT: 0.01 });
  const s = surf(W, H);
  for (let i = 0; i < W * H; i++) {
    const n = lf[i] + mf[i] * 0.45;
    const e = wo.f2[i] - wo.f1[i];
    const crack = cm[i] * sstep(0.03, 0.006, e);
    const plate = cm[i] * sstep(0.0, 0.2, e);
    const lt = sstep(-0.45, 0.45, n);
    let r = lerp(0.45, 0.64, lt), g = lerp(0.39, 0.57, lt), b = lerp(0.31, 0.46, lt);
    const t = pm[(i + (W * H >> 1) + (W >> 1)) % (W * H)];
    r *= 1 + t * 0.08; b *= 1 - t * 0.06;
    const w = wn[i], sp = 0.92 + w * 0.16;
    r *= sp; g *= sp; b *= sp;
    if (w > 0.993) { r *= 0.62; g *= 0.62; b *= 0.62; } else if (w < 0.005) { r = lerp(r, 0.78, 0.5); g = lerp(g, 0.74, 0.5); b = lerp(b, 0.68, 0.5); }
    const c = (1 - cm[i] * 0.05) * (1 - crack * 0.45);
    put(s, i, r * c, g * c, b * c);
    s.h[i] = 0.5 + lf[i] * 0.3 + mf[i] * 0.12 + (w - 0.5) * 0.06 + plate * 0.03 - crack * 0.15;
    s.ro[i] = 0.95 - cm[i] * 0.04 + (w - 0.5) * 0.04;
  }
  scatterPebbles(s, R, k, 2400, [1.2, 3.2]);
  scatterPebbles(s, R, k, 240, [3, 7]);
  scatterPebbles(s, R, k, 16, [8, 15]);
  for (let n = 0; n < 30; n++) {
    const x = R() * W, y = R() * H, a = R() * Math.PI, L = rr(R, 10, 40) * k;
    forLine(W, H, x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, Math.max(0.8, rr(R, 0.8, 1.6) * k), (i, d) => { const c = 0.27 + (1 - d) * 0.1; mixPx(s, i, c * 1.2, c, c * 0.8, 0.85); s.h[i] += (1 - d) * 0.05; });
  }
  grassTufts(s, R, k, 80, 1);
  return finish(s, 7);
}
function scatterPebbles(s, R, k, count, rad) {
  const { W, H } = s;
  const pal = [[0.55, 0.52, 0.47], [0.62, 0.57, 0.5], [0.46, 0.43, 0.39], [0.58, 0.5, 0.42], [0.68, 0.65, 0.6], [0.4, 0.38, 0.35]];
  for (let n = 0; n < count; n++) {
    const x = R() * W, y = R() * H, r0 = rr(R, rad[0], rad[1]) * k;
    if (r0 < 0.7) continue;
    const a = r0 * rr(R, 1, 1.5), b = r0 * rr(R, 0.7, 1), ang = R() * Math.PI;
    const c = pal[(R() * pal.length) | 0], tn = rr(R, 0.85, 1.12), hA = 0.012 * r0 / k;
    forEllipse(W, H, x, y, a * 1.45, b * 1.45, ang, (i, d) => { if (d > 0.68) mulPx(s, i, 1 - (1 - (d - 0.68) / 0.32) * 0.3); });
    forEllipse(W, H, x, y, a, b, ang, (i, d, lx, ly) => {
      const dome = Math.sqrt(1 - d * d), t = sstep(1, 0.78, d);
      const m = tn * (0.9 + 0.1 * dome);
      mixPx(s, i, c[0] * m, c[1] * m, c[2] * m, t);
      s.h[i] += dome * hA * t;
      s.ro[i] = lerp(s.ro[i], 0.72, t);
    });
  }
}
function grassTufts(s, R, k, count, amt) {
  const { W, H } = s;
  for (let n = 0; n < count; n++) {
    const x = R() * W, y = R() * H, blades = 5 + ((R() * 10) | 0), base = rr(R, 0, 1);
    const cr = lerp(0.62, 0.72, base), cg = lerp(0.54, 0.62, base), cb = lerp(0.32, 0.4, base);
    forDisc(W, H, x, y, 5 * k, (i, d) => mulPx(s, i, 1 - (1 - d) * 0.35));
    for (let b = 0; b < blades; b++) {
      const a = R() * Math.PI * 2, L = rr(R, 7, 22) * k * amt;
      const ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L * 0.8 - L * 0.2;
      forLine(W, H, x, y, ex, ey, Math.max(0.6, 0.9 * k), (i, d, t) => {
        const f = (1 - d) * (0.6 + 0.4 * t);
        mixPx(s, i, cr * (0.7 + t * 0.4), cg * (0.7 + t * 0.4), cb * (0.7 + t * 0.35), Math.min(1, f * 1.3));
        s.h[i] += (1 - d) * 0.04 * (1 - t * 0.5);
        s.ro[i] = 0.9;
      });
    }
  }
}

// road — 8 m tile: packed street dirt, wagon ruts along V, hoof prints, dark compacted centre.
function genRoad(seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 61), R = makeRng(sd);
  const ppm = W / 8;
  const lf = fbm(W, H, { sx: 2, sy: 3, oct: 7, gain: 0.55, seed: sd + 1 });
  const mf = fbm(W, H, { sx: 10, oct: 5, seed: sd + 2 });
  const st = fbm(W, H, { sx: 24, sy: 2, oct: 3, seed: sd + 3 });
  const wn = white(W, H, sd + 4);
  const tracks = [2.95 + rr(R, -0.15, 0.15), 5.05 + rr(R, -0.15, 0.15)];
  const ruts = [];
  for (const tc of tracks) {
    const w1 = noise1(3, sd + ruts.length * 17 + 5), ph = R();
    for (const side of [-0.725, 0.725]) {
      for (let q = 0; q < 2; q++) {
        ruts.push({ c: (tc + side) * ppm + (q === 0 ? 0 : rr(R, -0.12, 0.12)) * ppm, w1, w2: noise1(5, sd + ruts.length * 31 + 9), ph, a1: 0.12 * ppm, a2: 0.03 * ppm, hw: rr(R, 0.11, 0.16) * ppm, dep: q === 0 ? 1 : rr(R, 0.35, 0.6) });
      }
    }
  }
  const rutRow = new Float32Array(W), bermRow = new Float32Array(W);
  const s = surf(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    rutRow.fill(0); bermRow.fill(0);
    for (let q = 0; q < ruts.length; q++) {
      const r = ruts[q], c = r.c + r.w1(v + r.ph) * r.a1 + r.w2(v) * r.a2, ext = r.hw * 2.6, dv = r.dep * (0.6 + 0.4 * r.w2(v * 2 + 0.37));
      for (let xx = Math.floor(c - ext); xx <= Math.ceil(c + ext); xx++) {
        let x = xx % W; if (x < 0) x += W;
        const d = Math.abs(xx - c) / r.hw;
        if (d < 1) { const rv = (0.5 + 0.5 * Math.cos(d * Math.PI)) * dv; if (rv > rutRow[x]) rutRow[x] = rv; }
        else if (d < 2.6) { const bv = (0.5 - 0.5 * Math.cos(((d - 1) / 1.6) * Math.PI * 2)) * dv; if (bv > bermRow[x]) bermRow[x] = bv; }
      }
    }
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = x / W;
      const rut = rutRow[x], berm = bermRow[x];
      const cd = Math.abs(u - 0.5);
      const compact = sstep(0.36, 0.12, cd + lf[i] * 0.05);
      const n = lf[i] + mf[i] * 0.4;
      const lt = sstep(-0.5, 0.5, n) * (1 - compact * 0.3);
      let r = lerp(0.45, 0.65, lt), g = lerp(0.39, 0.57, lt), b = lerp(0.31, 0.46, lt);
      r = lerp(r, r * 0.84, compact); g = lerp(g, g * 0.82, compact); b = lerp(b, b * 0.81, compact);
      const sm = 1 + st[i] * 0.1 * compact;
      const w = wn[i], sp = 0.94 + w * 0.12;
      r *= sm * sp; g *= sm * sp; b *= sm * sp;
      r = lerp(r, r * 0.86, rut); g = lerp(g, g * 0.84, rut); b = lerp(b, b * 0.83, rut);
      put(s, i, r, g, b);
      s.h[i] = 0.5 + lf[i] * 0.3 + mf[i] * 0.1 * (1 - compact * 0.6) + (w - 0.5) * 0.045 * (1 - compact * 0.5 - rut * 0.4) - rut * 0.11 + berm * 0.015 + st[i] * 0.03;
      s.ro[i] = 0.96 - compact * 0.08 - rut * 0.08 + (w - 0.5) * 0.04;
    }
  }
  const hoof = (cx, cy, ang, depth, sc) => {
    const a = 0.06 * ppm * sc, b = 0.068 * ppm * sc;
    forEllipse(W, H, cx, cy, a * 1.3, b * 1.3, ang, (i, d, lx, ly) => {
      const bowl = (1 - d * d) * 0.025 * depth;
      const ring = ly > -0.35 ? sstep(0.22, 0.0, Math.abs(d - 0.62)) * sstep(-0.35, 0.0, ly) : 0;
      s.h[i] -= bowl + ring * 0.035 * depth;
      mulPx(s, i, 1 - (bowl * 3 + ring * 0.12) * depth);
    });
  };
  for (const tc of tracks) {
    for (let n = 0; n < 40; n++) hoof((tc + rr(R, -0.45, 0.45)) * ppm, R() * H, rr(R, -0.3, 0.3) + (R() < 0.5 ? Math.PI : 0), rr(R, 0.5, 1.0), rr(R, 0.9, 1.1));
  }
  for (let n = 0; n < 50; n++) hoof(R() * W, R() * H, R() * 6.28, rr(R, 0.2, 0.45), rr(R, 0.9, 1.1));
  scatterPebbles(s, R, k * 0.6, 1500, [1.5, 4]);
  scatterPebbles(s, R, k * 0.6, 110, [4, 9]);
  grassTufts(s, R, k * 0.55, 20, 1);
  return finish(s, 6);
}

// rock — 8 m tile: canyon sandstone — horizontal strata with ledges, vertical joints per layer, facets, varnish.
function genRock(seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 71), R = makeRng(sd);
  const hw = W >> 1, hh = H >> 1;
  const wv = fbm(W, H, { sx: 2, sy: 2, oct: 4, gain: 0.5, seed: sd + 1 });
  const big = fbm(W, H, { sx: 3, sy: 2, oct: 5, gain: 0.5, seed: sd + 2 });
  const mid = fbm(W, H, { sx: 14, sy: 10, oct: 3, gain: 0.5, seed: sd + 3 });
  const jw = fbm(W, H, { sx: 3, sy: 12, oct: 4, gain: 0.5, seed: sd + 4 });
  const vs = fbm(W, H, { sx: 36, sy: 2, oct: 3, seed: sd + 7 });
  const wn = white(W, H, sd + 8);
  const chp = worley(hw, hh, 16, 26, sd + 6, { jitter: 1, offs: true });
  const fa = f32(hw * hh);
  for (let i = 0; i < fa.length; i++) {
    const h2 = hmix(chp.id[i] + sd * 3);
    fa[i] = ((h2 & 255) / 255 - 0.5) * chp.ox[i] + (((h2 >>> 8) & 255) / 255 - 0.5) * chp.oy[i];
  }
  const facet = resample(fa, hw, hh, W, H);
  const L = 4096, tH = new Float32Array(L), tR = new Float32Array(L), tG = new Float32Array(L), tB = new Float32Array(L), tHd = new Float32Array(L), tE = new Float32Array(L), tLi = new Int16Array(L);
  const pal = [[0.7, 0.46, 0.33], [0.74, 0.52, 0.37], [0.77, 0.6, 0.44], [0.62, 0.38, 0.27], [0.82, 0.7, 0.55], [0.64, 0.47, 0.36], [0.72, 0.55, 0.41]];
  const lay = []; let acc = 0;
  while (acc < 1) {
    const th = rr(R, 0.025, 0.1) * (R() < 0.18 ? 1.7 : 1), nj = 1 + ((R() * 3) | 0), js = [];
    for (let j = 0; j < nj; j++) js.push(R());
    lay.push({ th, hard: R() ** 0.8, c: pal[(R() * pal.length) | 0], lam: rr(R, 3, 9), tn: rr(R, 0.92, 1.06), js });
    acc += th;
  }
  let li = 0, start = 0;
  for (let i = 0; i < L; i++) {
    const v = ((i + 0.5) / L) * acc;
    while (li < lay.length - 1 && v > start + lay[li].th) { start += lay[li].th; li++; }
    const ly = lay[li], sp = (v - start) / ly.th;
    const top = sstep(0, 0.008 + ly.hard * 0.012, sp * ly.th), bot = sstep(0, 0.004 + ly.hard * 0.006, (1 - sp) * ly.th);
    const lam = Math.sin(sp * ly.lam * Math.PI * 2) * 0.5 + 0.5;
    const face = 0.3 + ly.hard * 0.22, tb = top * bot;
    tH[i] = face - (face - 0.1) * (1 - tb) * 0.4 + lam * 0.012;
    const dk = 1 - (1 - tb) * 0.1 - sp * 0.05;
    tR[i] = ly.c[0] * ly.tn * dk * (0.98 + lam * 0.04); tG[i] = ly.c[1] * ly.tn * dk * (0.98 + lam * 0.04); tB[i] = ly.c[2] * ly.tn * dk;
    tHd[i] = ly.hard; tE[i] = 1 - tb; tLi[i] = li;
  }
  const s = surf(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let vv = y / H + wv[i] * 0.05 + big[i] * 0.012 + facet[i] * 0.003;
      vv -= Math.floor(vv);
      const ti = Math.min(L - 1, (vv * L) | 0), ly = lay[tLi[ti]];
      const hard = ly.hard;
      // vertical joints that break each layer into blocks
      const u = x / W + jw[i] * 0.025;
      let dj = 1;
      for (let j = 0; j < ly.js.length; j++) { let d = Math.abs(u - ly.js[j]); d -= Math.floor(d); if (d > 0.5) d = 1 - d; if (d < dj) dj = d; }
      const djp = dj * W;
      const jcr = sstep(2.8 * k, 0.6 * k, djp), jrnd = sstep(0, 14 * k, djp);
      const streak = sstep(0.12, 0.35, vs[i]) * 0.5;
      const mot = 1 + mid[i] * 0.12 + big[i] * 0.08 + facet[i] * 0.16;
      const w = wn[i];
      let r = tR[ti] * mot, g = tG[ti] * mot, b = tB[ti] * mot;
      const sp = 0.94 + w * 0.12; r *= sp; g *= sp; b *= sp;
      r = lerp(r, 0.34, streak * 0.35); g = lerp(g, 0.25, streak * 0.35); b = lerp(b, 0.2, streak * 0.35);
      const c = 1 - jcr * 0.55 - tE[ti] * 0.05 - (1 - jrnd) * 0.1;
      put(s, i, r * c, g * c, b * c);
      s.h[i] = tH[ti] * (0.55 + 0.45 * jrnd) + big[i] * 0.3 + facet[i] * (0.1 + hard * 0.06) + mid[i] * 0.02 + (w - 0.5) * 0.03 - jcr * 0.25;
      s.ro[i] = 0.9 + (w - 0.5) * 0.06 - hard * 0.04;
    }
  }
  for (let n = 0; n < 140; n++) {
    const x = R() * W, y = R() * H, rad = rr(R, 2, 8) * k, i0 = ((y | 0) % H) * W + ((x | 0) % W);
    let vv = y / H + wv[i0] * 0.05 + big[i0] * 0.012; vv -= Math.floor(vv);
    if (tHd[Math.min(L - 1, (vv * L) | 0)] > 0.5) continue;
    forEllipse(W, H, x, y, rad * 1.3, rad, 0, (i, d) => { const dd = (1 - d * d); s.h[i] -= dd * 0.05; mulPx(s, i, 1 - dd * 0.25); });
  }
  applyCavity(s, 5 * k, 0.8);
  return finish(s, 8);
}

// shingles — 2 m tile, 16 rows of split wooden shakes, butts toward −V.
function genShingles(color, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 81), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const NR = 16, rh = H / NR, ppm = W / 2;
  const rows = [];
  for (let r = 0; r < NR; r++) {
    const off = R() * W, sh = [];
    let x = 0;
    while (x < W) {
      let w = rr(R, 0.09, 0.22) * ppm;
      if (W - x < 0.14 * ppm) w = W - x; else if (W - x - w < 0.08 * ppm) w = W - x;
      sh.push({ x0: x, w, tone: rr(R, -1, 1), len: R() < 0.2 ? rr(R, 0.02, 0.07) : rr(R, 0, 0.02), split: R() < 0.18 ? rr(R, 0.2, 0.8) : -1, miss: R() < 0.012, gray: R(), go: R() * 50 });
      x += w;
    }
    const idx = new Int16Array(W);
    let j = 0;
    for (let px = 0; px < W; px++) { while (j < sh.length - 1 && px >= sh[j].x0 + sh[j].w) j++; idx[px] = j; }
    rows.push({ off: off | 0, sh, idx });
  }
  const fib = fibers(W, H, 12, sd + 1, true);
  const gN = grainNoise(W, H, sd + 2, true, 2, 10);
  const nW = fbm(W, H, { sx: 4, sy: 4, oct: 5, seed: sd + 3 });
  const nL = fbm(W, H, { sx: 24, sy: 24, oct: 3, seed: sd + 4 });
  const nS = fbm(W, H, { sx: 30, sy: 3, oct: 3, seed: sd + 6 });
  const wn = white(W, H, sd + 5);
  const s = surf(W, H);
  const gapW = 1.2 * k + 0.4;
  for (let y = 0; y < H; y++) {
    const ri = Math.min(NR - 1, (y / rh) | 0), row = rows[ri], t = (y - ri * rh) / rh;
    const ao = 0.42 + 0.58 * sstep(0, 0.22, t);
    const prof = 0.2 + 0.6 * t * (t < 0.94 ? 1 : 1 - ((t - 0.94) / 0.06) * 0.4);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let xs = x + row.off; if (xs >= W) xs -= W;
      const sh = row.sh[row.idx[xs]];
      const lu = (xs - sh.x0) / sh.w, ex = Math.min(xs - sh.x0, sh.x0 + sh.w - xs);
      const fb = fib[i];
      const Rr = (xs / W) * 150 + gN[i] * 7 + sh.go, f = Rr - Math.floor(Rr), late = sstep(0.75, 0.96, f) * sstep(1.0, 0.97, f);
      let m = (0.95 + sh.tone * 0.17) * (0.93 + fb * 0.2) * (1 - late * 0.12);
      const gray = clamp01(0.35 + sh.gray * 0.4 + nW[i] * 0.5);
      let r = cr * m, gg = cg * m, bb = cb * m;
      const l = (r + gg + bb) / 3;
      r = lerp(r, l * 1.02, gray * 0.65); gg = lerp(gg, l, gray * 0.65); bb = lerp(bb, l * 0.96, gray * 0.65);
      const strk = Math.max(0, nS[i]) * 0.18;
      const lich = sstep(0.45, 0.58, nL[i] + nW[i] * 0.3) * 0.5;
      r = lerp(r, 0.62, lich); gg = lerp(gg, 0.62, lich); bb = lerp(bb, 0.53, lich);
      const lc = (lu * 2 - 1) * (lu * 2 - 1);
      let h = prof + fb * 0.035 + late * 0.02 + lc * lc * 0.04 + sh.tone * 0.02;
      let ro = 0.88 + (wn[i] - 0.5) * 0.05;
      let mm = ao * (1 - strk) * (0.96 + (wn[i] - 0.5) * 0.08) * (1 - sstep(0.9, 1, t) * 0.12);
      if (sh.miss) { mm *= 0.3 + 0.25 * t; h = 0.02 + t * 0.2; ro = 0.95; }
      else if (t > 1 - sh.len) { mm *= 0.35; h = 0.12; }
      else if (ex < gapW || (sh.split > 0 && Math.abs(lu - sh.split) < 0.008 + 0.008 * t && t > 0.35)) { mm *= 0.3; h = 0.1; ro = 1; }
      put(s, i, r * mm, gg * mm, bb * mm);
      s.h[i] = h; s.ro[i] = ro;
    }
  }
  return finish(s, 9);
}

// corrugated — 1 m tile, 13 ridges along V, bolt rows, rust streaks.
function genCorrugated(color, rust, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 91), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const sat = Math.max(cr, cg, cb) - Math.min(cr, cg, cb);
  const baseMetal = sat < 0.12 ? 0.35 : 0.1;
  const NRID = 13;
  const nR = fbm(W, H, { sx: 5, sy: 2, oct: 7, gain: 0.6, seed: sd + 1 });
  const nS = fbm(W, H, { sx: 52, sy: 2, oct: 4, seed: sd + 2 });
  const nM = fbm(W, H, { sx: 20, sy: 20, oct: 3, seed: sd + 3 });
  const nD = fbm(W, H, { sx: 3, oct: 4, seed: sd + 4 });
  const wn = white(W, H, sd + 6);
  const s = surf(W, H, true);
  const T = 0.64 - rust * 0.72;
  const boltY = H * 0.11;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const edgeRust = sstep(0.1, 0.0, v) * 0.08 + sstep(0.8, 1.0, v) * 0.14;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = x / W;
      const prof = 0.5 + 0.5 * Math.cos(u * NRID * Math.PI * 2);
      const streakBelow = y > boltY ? Math.max(0, nS[i]) * Math.exp(-(y - boltY) / (H * 0.45)) : 0;
      const rv = nR[i] + (1 - prof) * 0.1 + edgeRust + streakBelow * 0.6 + (wn[i] - 0.5) * 0.04;
      const rm = sstep(T, T + 0.1, rv);
      const heavy = sstep(T + 0.1, T + 0.32, rv);
      const dirt = clamp01(0.4 + nD[i] * 0.8) * 0.25 + (1 - prof) * 0.08;
      const mt = 1 + nM[i] * 0.07 + (wn[i] - 0.5) * 0.04;
      let r = cr * mt, g = cg * mt, b = cb * mt;
      r = lerp(r, 0.36, dirt * 0.5); g = lerp(g, 0.33, dirt * 0.5); b = lerp(b, 0.29, dirt * 0.5);
      const rc = clamp01(0.5 + nM[i] * 2);
      const tt = heavy * 0.7 + rc * 0.3;
      r = lerp(r, lerp(0.5, 0.29, tt), rm); g = lerp(g, lerp(0.32, 0.18, tt), rm); b = lerp(b, lerp(0.2, 0.12, tt), rm);
      const stn = streakBelow * (1 - rm) * 0.45 * (0.3 + rust);
      r = lerp(r, 0.44, stn); g = lerp(g, 0.28, stn); b = lerp(b, 0.17, stn);
      const lap = sstep(2.5 * k, 0.5 * k, Math.abs(wrapS(x - W / (NRID * 2), W)));
      const shade = 1 - lap * 0.25;
      put(s, i, r * shade, g * shade, b * shade);
      s.h[i] = prof * 0.24 + (wn[i] - 0.5) * 0.025 * rm + heavy * 0.025 + nD[i] * 0.03 - lap * 0.02;
      s.ro[i] = clamp01(lerp(0.48 + dirt * 0.7 + nM[i] * 0.1, 0.9, rm));
      s.me[i] = lerp(baseMetal * (1 - dirt), 0, rm);
    }
  }
  for (let n = 0; n < NRID; n += 2) {
    for (const by of [boltY, H * 0.61]) {
      const bx = (n * W) / NRID, byy = by + rr(R, -1.5, 1.5) * k;
      forDisc(W, H, bx, byy, 7 * k, (i, d) => { s.h[i] += (1 - d) * 0.02; mixPx(s, i, 0.3, 0.22, 0.16, 0.3 * rust); });
      forDisc(W, H, bx, byy, 4.2 * k, (i, d) => { const c = 0.32 + (1 - d) * 0.15; put(s, i, c, c * 0.95, c * 0.9); s.h[i] += Math.sqrt(1 - d * d) * 0.06; s.ro[i] = 0.5; s.me[i] = 0.5; });
      if (R() < 0.3 + rust * 0.6) {
        const len = rr(R, 0.1, 0.45) * H;
        forLine(W, H, bx, byy + 4 * k, bx + rr(R, -3, 3) * k, byy + len, rr(R, 2, 4.5) * k, (i, d, t) => { const a = (1 - d) * (1 - t) ** 1.5 * 0.6; mixPx(s, i, 0.45, 0.27, 0.15, a); s.me[i] *= 1 - a; s.ro[i] = lerp(s.ro[i], 0.85, a); });
      }
    }
  }
  return finish(s, 11);
}

// brick — 1 m tile: 5 bricks × 14 courses, worn mortar, chips, missing bricks.
function genBrick(color, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 101), R = makeRng(sd);
  const [br, bg, bb] = rgb(color);
  const NC = 5, NRW = 14, bw = W / NC, bh = H / NRW, mort = 10 * k;
  const bricks = [];
  for (let i = 0; i < NC * NRW; i++) {
    const tp = R();
    let m = [1, 1, 1];
    if (tp < 0.1) m = [0.7, 0.66, 0.68]; else if (tp < 0.2) m = [1.12, 1.08, 1.02]; else if (tp < 0.26) m = [1.06, 1.1, 0.94];
    const l = rr(R, 0.88, 1.08), hue = rr(R, -0.04, 0.04);
    bricks.push({ m: [m[0] * l * (1 + hue), m[1] * l, m[2] * l * (1 - hue)], chip: rr(R, 0.3, 1.4), miss: R() < 0.008, crack: R() < 0.06 ? { x: rr(R, 0.25, 0.75), sl: rr(R, -0.5, 0.5) } : null });
  }
  const nE = fbm(W, H, { sx: 32, sy: 32, oct: 3, gain: 0.55, seed: sd + 1 });
  const nF = fbm(W, H, { sx: 12, sy: 12, oct: 4, seed: sd + 2 });
  const nL = fbm(W, H, { sx: 3, oct: 5, seed: sd + 3 });
  const wn = white(W, H, sd + 5);
  const s = surf(W, H);
  const half = (W * H) >> 1;
  for (let y = 0; y < H; y++) {
    const row = Math.min(NRW - 1, (y / bh) | 0), ly = y - row * bh, off = row & 1 ? bw * 0.5 : 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xs = (x + off) % W, col = Math.min(NC - 1, (xs / bw) | 0), lx = xs - col * bw;
      const b = bricks[row * NC + col];
      let e = Math.min(lx, bw - lx, ly, bh - ly) - mort * 0.5;
      e += nE[i] * 7 * k * b.chip - (b.chip - 0.5) * 1.5 * k;
      const inside = sstep(-0.7, 0.7, e);
      const bev = sstep(0, 5 * k, e);
      const w = wn[i];
      let r = br * b.m[0] * (1 + nF[i] * 0.12), g = bg * b.m[1] * (1 + nF[i] * 0.14), bl = bb * b.m[2] * (1 + nF[i] * 0.12);
      if (w > 0.975) { r *= 0.72; g *= 0.72; bl *= 0.72; }
      r *= 0.95 + w * 0.08; g *= 0.95 + w * 0.08; bl *= 0.95 + w * 0.08;
      const grime = sstep(0.0, 0.5, nL[i]) * 0.18;
      const eflo = sstep(0.25, 0.55, nL[(i + half) % (W * H)]) * (1 - bev * 0.7) * 0.3;
      r = lerp(r * (1 - grime), 0.7, eflo); g = lerp(g * (1 - grime), 0.67, eflo); bl = lerp(bl * (1 - grime), 0.62, eflo);
      const mm = 0.88 + nF[i] * 0.25 + (w - 0.5) * 0.22;
      const mr = 0.62 * mm, mg = 0.58 * mm, mb = 0.51 * mm;
      let hB = 0.42 + 0.3 * bev + nF[i] * 0.04 + (w - 0.5) * 0.02 - (w > 0.975 ? 0.05 : 0);
      let hM = 0.15 + nF[i] * 0.05 + (w - 0.5) * 0.06;
      let ro = lerp(0.95, 0.84 + nF[i] * 0.06, inside);
      if (b.crack && inside > 0.5) {
        const cx = b.crack.x * bw + (ly - bh * 0.5) * b.crack.sl + nE[i] * 6 * k;
        if (Math.abs(lx - cx) < 1.3 * k + 0.3) { hB -= 0.25; r *= 0.4; g *= 0.4; bl *= 0.4; }
      }
      if (b.miss) {
        const d = Math.min(lx, bw - lx, ly, bh - ly) - mort * 0.5 + nE[i] * 4 * k;
        const hole = sstep(-1, 4 * k, d);
        hB = lerp(hM, -0.15, hole);
        const c = lerp(1, 0.32, hole);
        r = lerp(mr, br * 0.8, hole) * c; g = lerp(mg, bg * 0.8, hole) * c; bl = lerp(mb, bb * 0.8, hole) * c; ro = 1;
      }
      const ao = 1 - (1 - sstep(-2 * k, 3 * k, e)) * 0.25;
      put(s, i, lerp(mr, r * 0.92, inside) * ao, lerp(mg, g * 0.92, inside) * ao, lerp(mb, bl * 0.92, inside) * ao);
      s.h[i] = lerp(hM, hB, inside);
      s.ro[i] = ro;
    }
  }
  return finish(s, 9, { sat: 0.74 });
}

// stoneFoundation — 2 m tile: rough fieldstone rubble with recessed mortar.
function genStoneFoundation(seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 111), R = makeRng(sd);
  const wx = fbm(W, H, { sx: 6, oct: 4, seed: sd + 1 }), wy = fbm(W, H, { sx: 6, oct: 4, seed: sd + 2 });
  const wo = worley(W, H, 6, 9, sd + 3, { jitter: 0.85, wx, wy, wa: 0.04, offs: true });
  const nF = fbm(W, H, { sx: 10, oct: 6, gain: 0.55, seed: sd + 5 });
  const nM = fbm(W, H, { sx: 24, oct: 3, seed: sd + 6 });
  const wn = white(W, H, sd + 8);
  const pal = [[0.56, 0.55, 0.53], [0.6, 0.57, 0.52], [0.46, 0.45, 0.43], [0.57, 0.51, 0.46], [0.67, 0.65, 0.61], [0.51, 0.49, 0.45]];
  const s = surf(W, H);
  const NCELL = 6 * 9, CR = new Float32Array(NCELL), CG = new Float32Array(NCELL), CB = new Float32Array(NCELL), AX = new Float32Array(NCELL), AY = new Float32Array(NCELL);
  for (let c = 0; c < NCELL; c++) {
    const hs = hmix(c + sd), col = pal[hs % pal.length], tn = 0.9 + (((hs >>> 8) & 255) / 255) * 0.2;
    CR[c] = col[0] * tn; CG[c] = col[1] * tn; CB[c] = col[2] * tn;
    AX[c] = (((hs >>> 16) & 255) / 255 - 0.5) * 0.7; AY[c] = (((hs >>> 24) & 255) / 255 - 0.5) * 0.7;
  }
  for (let i = 0; i < W * H; i++) {
    const e = wo.f2[i] - wo.f1[i];
    const mw = 0.06 + nM[i] * 0.03;
    const st = sstep(mw, mw + 0.035, e);
    const rnd = sstep(mw, mw + 0.14, e);
    const id = wo.id[i];
    const plane = AX[id] * wo.ox[i] + AY[id] * wo.oy[i];
    const w = wn[i];
    let r = CR[id] * (1 + nF[i] * 0.2), g = CG[id] * (1 + nF[i] * 0.2), b = CB[id] * (1 + nF[i] * 0.18);
    const sp = w > 0.965 ? 0.78 : w < 0.025 ? 1.18 : 0.96 + w * 0.08;
    r *= sp; g *= sp; b *= sp;
    const dust = clamp01(-wo.oy[i] * 1.8) * 0.28 * rnd;
    r = lerp(r, 0.66, dust); g = lerp(g, 0.6, dust); b = lerp(b, 0.5, dust);
    const ao = 0.72 + 0.28 * sstep(mw, mw + 0.16, e);
    const mm = 0.85 + nF[i] * 0.25 + (w - 0.5) * 0.3;
    const mr = 0.7 * mm, mg = 0.66 * mm, mb = 0.58 * mm;
    put(s, i, lerp(mr * 0.95, r * ao, st), lerp(mg * 0.95, g * ao, st), lerp(mb * 0.95, b * ao, st));
    s.h[i] = lerp(0.14 + nM[i] * 0.05 + (w - 0.5) * 0.07, 0.24 + rnd * 0.22 + plane * 0.28 + nF[i] * 0.1 + (w - 0.5) * 0.025, st);
    s.ro[i] = lerp(0.96, 0.82 + nF[i] * 0.08, st);
  }
  return finish(s, 5.5);
}

// plaster — 2 m tile: cracked adobe stucco with fallen patches showing mud brick.
function genPlaster(color, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 121);
  const [pr, pg, pb] = rgb(color);
  const nL = fbm(W, H, { sx: 3, oct: 6, seed: sd + 1 });
  const nT = fbm(W, H, { sx: 6, sy: 3, oct: 5, gain: 0.55, seed: sd + 2 });
  const nX = fbm(W, H, { sx: 3, oct: 7, gain: 0.55, seed: sd + 3 });
  const nC = fbm(W, H, { sx: 3, oct: 5, gain: 0.55, seed: sd + 4 });
  const nCm = fbm(W, H, { sx: 2, oct: 3, seed: sd + 5 });
  const nV = fbm(W, H, { sx: 14, sy: 2, oct: 3, seed: sd + 6 });
  const nB = fbm(W, H, { sx: 20, oct: 3, seed: sd + 7 });
  const wn = white(W, H, sd + 8);
  const s = surf(W, H);
  const T = 0.24;
  const NBr = 5, NRr = 16, abw = W / NBr, abh = H / NRr, am = 7 * k;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      const de = nX[i] - T;
      const ex = sstep(0.0, 0.008, de);
      const rim = sstep(-0.04, 0.0, de) * (1 - ex);
      const cw = 0.003 + 0.004 * sstep(0.0, 0.4, nCm[i]) + rim * 0.004;
      const crack = (nCm[i] > -0.05 || rim > 0) ? sstep(cw, cw * 0.2, Math.abs(nC[i])) : 0;
      const tm = 1 + nL[i] * 0.12 + nT[i] * 0.08 + (w - 0.5) * 0.05;
      let r = pr * tm, g = pg * tm, b = pb * tm;
      const stain = sstep(0.15, 0.45, nV[i]) * 0.06;
      r *= 1 - stain; g *= 1 - stain * 1.05; b *= 1 - stain * 1.1;
      r *= 1 - crack * 0.5; g *= 1 - crack * 0.52; b *= 1 - crack * 0.55;
      r *= 1 - rim * 0.12; g *= 1 - rim * 0.12; b *= 1 - rim * 0.12;
      let h = 0.62 + nT[i] * 0.05 + nL[i] * 0.05 + (w - 0.5) * 0.035 - crack * 0.2 + rim * 0.02;
      let ro = 0.9 + (w - 0.5) * 0.05;
      if (ex > 0) {
        const row = (y / abh) | 0, off = row & 1 ? abw * 0.5 : 0, xs = (x + off) % W, lx = xs % abw, lyy = y - row * abh;
        const e2 = Math.min(lx, abw - lx, lyy, abh - lyy) - am * 0.5 + nB[i] * 5 * k;
        const brk = sstep(-1, 2 * k, e2);
        const hs = hmix(row * 31 + ((xs / abw) | 0) + sd), tn = 0.88 + ((hs & 255) / 255) * 0.2;
        const ar = lerp(0.5, 0.58 * tn, brk) * (1 + nB[i] * 0.2), ag = lerp(0.42, 0.46 * tn, brk) * (1 + nB[i] * 0.2), ab = lerp(0.33, 0.35 * tn, brk) * (1 + nB[i] * 0.18);
        const straw = w > 0.985 ? 1 : 0;
        const ao = 0.62 + 0.38 * sstep(0, 0.05, de);
        r = lerp(r, (straw ? 0.72 : ar) * ao, ex); g = lerp(g, (straw ? 0.63 : ag) * ao, ex); b = lerp(b, (straw ? 0.44 : ab) * ao, ex);
        h = lerp(h, 0.2 + brk * 0.1 + nB[i] * 0.06 + (w - 0.5) * 0.05, ex);
        ro = lerp(ro, 0.97, ex);
      }
      put(s, i, r, g, b);
      s.h[i] = h; s.ro[i] = ro;
    }
  }
  return finish(s, 8);
}

// metal — 1 m tile: painted steel, scratches, rust blisters.
function genMetal(color, rust, seed) {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf(seed, 131), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const nO = fbm(W, H, { sx: 48, oct: 2, seed: sd + 1 });
  const nL = fbm(W, H, { sx: 3, oct: 5, seed: sd + 2 });
  const nR = fbm(W, H, { sx: 3, oct: 7, gain: 0.62, seed: sd + 3 });
  const nV = fbm(W, H, { sx: 20, sy: 2, oct: 3, seed: sd + 4 });
  const nC = fbm(W, H, { sx: 16, oct: 3, seed: sd + 5 });
  const wn = white(W, H, sd + 6);
  const scr = f32(W * H);
  for (let n = 0; n < 140; n++) {
    const x = R() * W, y = R() * H, a = R() < 0.6 ? rr(R, -0.4, 0.4) : R() * Math.PI, L = rr(R, 6, 60) * k;
    forLine(W, H, x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, Math.max(0.6, rr(R, 0.5, 1.1) * k), (i, d, t) => { scr[i] = Math.max(scr[i], (1 - d) * Math.sin(t * Math.PI) ** 0.3); });
  }
  const s = surf(W, H, true);
  const T = 0.48 - rust * 0.7;
  for (let i = 0; i < W * H; i++) {
    const w = wn[i];
    const rv = nR[i] + nL[i] * 0.25 + (w - 0.5) * 0.03;
    const rm = sstep(T, T + 0.05, rv), blis = sstep(T - 0.07, T, rv) * (1 - rm);
    const fade = clamp01(0.3 + nL[i]) * 0.2;
    const grime = sstep(0.1, 0.45, nV[i]) * 0.1;
    const tm = (1 + nO[i] * 0.03 + (w - 0.5) * 0.03) * (1 - grime);
    let r = lerp(cr, 0.7, fade) * tm, g = lerp(cg, 0.7, fade) * tm, b = lerp(cb, 0.68, fade) * tm;
    const rc = clamp01(0.5 + nC[i] * 1.5);
    r = lerp(r, lerp(0.48, 0.28, rc), rm); g = lerp(g, lerp(0.3, 0.17, rc), rm); b = lerp(b, lerp(0.18, 0.1, rc), rm);
    r *= 1 - blis * 0.15; g *= 1 - blis * 0.17; b *= 1 - blis * 0.19;
    const sc = scr[i] * (1 - rm);
    r = lerp(r, 0.6, sc); g = lerp(g, 0.6, sc); b = lerp(b, 0.58, sc);
    put(s, i, r, g, b);
    s.h[i] = 0.5 + nO[i] * 0.012 + blis * 0.05 + rm * ((w - 0.5) * 0.06 - 0.01) - sc * 0.03;
    s.ro[i] = clamp01(lerp(lerp(0.5 + nL[i] * 0.12 + grime, 0.9, rm), 0.35, sc));
    s.me[i] = sc * 0.8;
  }
  return finish(s, 6);
}

// metalDark — 1 m tile: dark gunmetal for lamps, bells, generators.
function genMetalDark() {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf('md', 141), R = makeRng(sd);
  const nL = fbm(W, H, { sx: 3, oct: 5, seed: sd + 1 });
  const nC = fbm(W, H, { sx: 24, oct: 3, seed: sd + 2 });
  const fb = fibers(W, H, 24, sd + 3);
  const nR = fbm(W, H, { sx: 8, oct: 5, seed: sd + 4 });
  const wn = white(W, H, sd + 5);
  const scr = f32(W * H);
  for (let n = 0; n < 90; n++) {
    const x = R() * W, y = R() * H, a = R() * Math.PI, L = rr(R, 5, 40) * k;
    forLine(W, H, x, y, x + Math.cos(a) * L, y + Math.sin(a) * L, Math.max(0.5, 0.8 * k), (i, d) => { scr[i] = Math.max(scr[i], 1 - d); });
  }
  const s = surf(W, H, true);
  for (let i = 0; i < W * H; i++) {
    const w = wn[i];
    const wear = sstep(0.2, 0.5, nL[i]) * 0.5;
    const rs = sstep(0.42, 0.55, nR[i]);
    const m = 1 + nC[i] * 0.12 + fb[i] * 0.1 + (w - 0.5) * 0.06 + wear * 0.35;
    let r = 0.23 * m, g = 0.235 * m, b = 0.245 * m;
    r = lerp(r, 0.3, rs * 0.7); g = lerp(g, 0.17, rs * 0.7); b = lerp(b, 0.1, rs * 0.7);
    const sc = scr[i] * 0.6;
    r = lerp(r, 0.45, sc); g = lerp(g, 0.45, sc); b = lerp(b, 0.46, sc);
    put(s, i, r, g, b);
    s.h[i] = 0.5 + nC[i] * 0.02 + fb[i] * 0.01 + rs * (w - 0.5) * 0.05 - sc * 0.02;
    s.ro[i] = clamp01(0.55 - wear * 0.2 + nC[i] * 0.08 + rs * 0.35 - sc * 0.1);
    s.me[i] = lerp(0.55, 0.05, rs) + sc * 0.3;
  }
  return finish(s, 5);
}

// container — 2.5 m tile: shipping-container corrugated side with stencils, rust, dents.
function genContainer(color, seed) {
  const S = baseSize(), W = S, H = S, k = S / 1024, sd = seedOf(seed, 151), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const NP = 9, P = W / NP;
  const nL = fbm(W, H, { sx: 3, oct: 5, seed: sd + 1 });
  const nR = fbm(W, H, { sx: 6, sy: 3, oct: 6, gain: 0.6, seed: sd + 2 });
  const nS = fbm(W, H, { sx: 60, sy: 2, oct: 4, seed: sd + 3 });
  const nC = fbm(W, H, { sx: 14, oct: 3, seed: sd + 4 });
  const nE = fbm(W, H, { sx: 40, sy: 40, oct: 2, seed: sd + 5 });
  const wn = white(W, H, sd + 6);
  const dents = [];
  for (let n = 0; n < 5; n++) dents.push({ x: R() * W, y: rr(R, 0.15, 0.85) * H, r: rr(R, 0.04, 0.12) * W, d: rr(R, 0.05, 0.12) });
  const brand = pick(R, ['KESTREL', 'MERIDIAN', 'ATLAS LINE', 'OCEANIC', 'NORDLINE', 'TRANSPAC']);
  const pre = pick(R, ['KSTU', 'MRDU', 'ATLU', 'OCNU', 'NRDU', 'TPCU']);
  const code = `${pre} ${String(100000 + ((R() * 899999) | 0))} ${(R() * 9) | 0}`;
  const sten = canvasMask(W, H, (ctx) => {
    ctx.textAlign = 'left';
    ctx.font = `bold ${Math.round(H * 0.045)}px 'Arial Black', Arial, sans-serif`;
    ctx.fillText(code, W * 0.55, H * 0.13);
    ctx.font = `bold ${Math.round(H * 0.035)}px Arial, sans-serif`;
    ctx.fillText('22G1', W * 0.55, H * 0.185);
    ctx.font = `bold ${Math.round(H * 0.02)}px Arial, sans-serif`;
    const info = ['MAX.GROSS  30,480 KG', '                67,200 LB', 'TARE          2,250 KG', '                  4,960 LB', 'NET           28,230 KG', 'CU.CAP.      33.2 CU.M'];
    info.forEach((t, j) => ctx.fillText(t, W * 0.06, H * (0.14 + j * 0.028)));
    ctx.textAlign = 'center';
    fitText(ctx, brand, W * 0.8, Math.round(H * 0.16), (px) => `bold ${px}px 'Arial Black', Impact, sans-serif`);
    ctx.fillText(brand, W * 0.5, H * 0.52);
  });
  const s = surf(W, H, true);
  const topR = 0.055, botR = 0.955;
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      let q = (x % P) / P; if (q > 0.5) q -= 1;
      const aq = Math.abs(q);
      const prof = sstep(0.31, 0.19, aq);
      const slope = sstep(0.17, 0.2, aq) * sstep(0.33, 0.3, aq);
      let dent = 0;
      for (const d of dents) {
        const dx = wrapS(x - d.x, W) / d.r, dy = (y - d.y) / d.r, d2 = dx * dx + dy * dy;
        if (d2 < 4) dent += Math.exp(-d2 * 1.5) * d.d;
      }
      let rail = 0, h;
      if (v < topR) { rail = 1; h = 0.42 - sstep(topR - 0.012, topR, v) * 0.08 + sstep(0.0, 0.01, v) * 0.02; }
      else if (v > botR) { rail = 1; h = 0.4 - sstep(botR + 0.012, botR, v) * 0.08; }
      else h = prof * 0.2 - dent + nL[i] * 0.02;
      const topStreak = Math.max(0, nS[i]) * sstep(0.7, 0.05, v) * 1.3;
      const rv = nR[i] * 0.8 + sstep(0.82, 1.0, v) * 0.4 + rail * 0.2 + topStreak * 0.3 + dent * 2 + slope * nE[i] * 0.3;
      const rm = sstep(0.42, 0.5, rv);
      const chip = slope * sstep(0.3, 0.45, nE[i] + (w - 0.5) * 0.2) * 0.8;
      const fade = clamp01(0.25 + nL[i] * 0.8) * 0.22 + (1 - v) * 0.05;
      const tm = 1 + nC[i] * 0.07 + (w - 0.5) * 0.035;
      let r = lerp(cr, cr * 1.2 + 0.06, fade) * tm, g = lerp(cg, cg * 1.2 + 0.06, fade) * tm, b = lerp(cb, cb * 1.2 + 0.06, fade) * tm;
      const st = sten[i] * sstep(-0.3, 0.15, nC[i] + (w - 0.5) * 0.4) * (1 - rm);
      r = lerp(r, 0.82, st * 0.85); g = lerp(g, 0.8, st * 0.85); b = lerp(b, 0.74, st * 0.85);
      const strk = topStreak * 0.3;
      r = lerp(r, 0.36, strk); g = lerp(g, 0.22, strk); b = lerp(b, 0.14, strk);
      const rcol = clamp01(0.5 + nC[i]);
      const ra = Math.max(rm, chip);
      r = lerp(r, lerp(0.48, 0.27, rcol), ra); g = lerp(g, lerp(0.29, 0.16, rcol), ra); b = lerp(b, lerp(0.17, 0.1, rcol), ra);
      const ao = rail ? 1 : 1 - sstep(topR + 0.02, topR, v) * 0.3 - sstep(botR - 0.015, botR, v) * 0.3;
      put(s, i, r * ao, g * ao, b * ao);
      s.h[i] = h + ra * (w - 0.5) * 0.02;
      s.ro[i] = clamp01(lerp(0.55 + nC[i] * 0.1 + fade * 0.3, 0.9, ra) - st * 0.05);
      s.me[i] = 0;
    }
  }
  return finish(s, 9);
}

// sandbag — 0.5 m tile: coarse burlap weave with a stitched seam.
function weaveHeight(u, v, tw, tv) {
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const over = (iu + iv) & 1;
  const cu = 1 - ((fu - 0.5) / (tw * 0.5)) ** 2, cv = 1 - ((fv - 0.5) / (tv * 0.5)) ** 2;
  const hv = cu > 0 ? Math.sqrt(cu) * (over ? 0.8 + 0.2 * Math.cos((fv - 0.5) * Math.PI) : 0.45 + 0.1 * Math.cos((fv - 0.5) * Math.PI)) : -1;
  const hh = cv > 0 ? Math.sqrt(cv) * (!over ? 0.8 + 0.2 * Math.cos((fu - 0.5) * Math.PI) : 0.45 + 0.1 * Math.cos((fu - 0.5) * Math.PI)) : -1;
  return hv > hh ? hv : hh === -1 ? -1 : -2 - hh; // encode: ≥0 vertical on top; ≤-2 horizontal (value = -2-h); -1 gap
}
// sandbag — 0.5 m tile: coarse burlap weave with a stitched seam.
function genSandbag(seed) {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf(seed, 161), R = makeRng(sd);
  const NT = 48, p = W / NT;
  const fu = fibers(W, H, 40, sd + 1, true), fvv = fibers(W, H, 40, sd + 2);
  const wx = fbm(W, H, { sx: 8, sy: 3, oct: 3, seed: sd + 3 }), wy = fbm(W, H, { sx: 3, sy: 8, oct: 3, seed: sd + 4 });
  const nD = fbm(W, H, { sx: 4, oct: 5, seed: sd + 5 });
  const nLp = fbm(W, H, { sx: 3, oct: 3, seed: sd + 7 });
  const wn = white(W, H, sd + 6);
  const tu = new Float32Array(NT), tv = new Float32Array(NT);
  for (let i = 0; i < NT; i++) { tu[i] = rr(R, 0.78, 1.18); tv[i] = rr(R, 0.78, 1.18); }
  const s = surf(W, H);
  const seamY = H * 0.86;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      const u = x / p + wy[i] * 1.1, v = y / p + wx[i] * 1.1;
      const iu = ((Math.floor(u) % NT) + NT) % NT, iv = ((Math.floor(v) % NT) + NT) % NT;
      const wh = weaveHeight(u, v, 0.74 * (0.8 + 0.2 * tu[iu]) + fu[i] * 0.12, 0.7 * (0.8 + 0.2 * tv[iv]) + fvv[i] * 0.12);
      let h, tone, fib;
      if (wh >= 0) { h = wh; tone = tu[iu]; fib = fu[i]; }
      else if (wh <= -2) { h = -2 - wh; tone = tv[iv]; fib = fvv[i]; }
      else { h = -0.25; tone = 0.45; fib = 0; }
      const lit = wh === -1 ? 0.55 : 0.84 + h * 0.16;
      const m = (0.9 + (tone - 1) * 0.6) * lit * (0.9 + fib * 0.35) * (0.93 + (w - 0.5) * 0.14);
      let r = 0.6 * m, g = 0.54 * m, b = 0.42 * m;
      const dirt = clamp01(0.3 + nD[i] * 0.9) * 0.4;
      r = lerp(r, r * 0.68, dirt); g = lerp(g, g * 0.66, dirt); b = lerp(b, b * 0.64, dirt);
      const dy = (y - seamY) / (7 * k);
      const fold = Math.exp(-dy * dy) * 0.7 - Math.exp(-(((y - seamY - 10 * k) / (3 * k)) ** 2)) * 0.5;
      const foldShade = 1 - Math.exp(-(((y - seamY - 10 * k) / (4 * k)) ** 2)) * 0.35;
      put(s, i, r * foldShade, g * foldShade, b * foldShade);
      s.h[i] = h * 0.4 + fold + (w - 0.5) * 0.14 + fib * 0.1 + nLp[i] * 1.2;
      s.ro[i] = 0.95;
    }
  }
  const sy = seamY - 10 * k;
  for (let x = 0; x < W; x += 12 * k) {
    forLine(W, H, x + 2 * k, sy, x + 9 * k, sy + 0.6 * k, 1.7 * k, (i, d) => { const c = 0.66 + (1 - d) * 0.1; put(s, i, c, c * 0.9, c * 0.72); s.h[i] += (1 - d * d) * 0.35; });
  }
  return finish(s, 3);
}

// hay — 1 m tile: packed straw strands (mostly along U).
function genHay(seed) {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf(seed, 171), R = makeRng(sd);
  const s = surf(W, H);
  const zb = f32(W * H);
  const nB = fbm(W, H, { sx: 4, oct: 4, seed: sd + 1 });
  for (let i = 0; i < W * H; i++) { const c = 0.42 + nB[i] * 0.08; put(s, i, c * 1.22, c * 1.0, c * 0.55); s.h[i] = 0; s.ro[i] = 1; zb[i] = -1; }
  const pal = [[0.8, 0.68, 0.42], [0.85, 0.76, 0.52], [0.72, 0.6, 0.34], [0.66, 0.58, 0.42], [0.78, 0.66, 0.4], [0.7, 0.63, 0.4], [0.88, 0.8, 0.58]];
  const NS = 7000;
  for (let n = 0; n < NS; n++) {
    const z = n / NS;
    const x = R() * W, y = R() * H;
    const ang = R() < 0.85 ? gauss(R) * 0.25 : R() * Math.PI;
    const L = rr(R, 25, 100) * k, rad = Math.max(0.8, rr(R, 1.4, 2.8) * k);
    const c = pal[(R() * pal.length) | 0], tn = rr(R, 0.86, 1.08), bend = rr(R, -0.15, 0.15);
    const x1 = x + Math.cos(ang) * L, y1 = y + Math.sin(ang) * L;
    const mx = (x + x1) / 2 - Math.sin(ang) * L * bend * 0.2, my = (y + y1) / 2 + Math.cos(ang) * L * bend * 0.2;
    const fn = (i, d, t) => {
      const cp = Math.sqrt(1 - d * d);
      const hz = z * 0.5 + cp * 0.5;
      if (hz <= zb[i]) return;
      zb[i] = hz;
      const sh = (0.8 + 0.22 * cp) * tn * (0.92 + 0.08 * Math.sin(t * 9 + n));
      put(s, i, c[0] * sh, c[1] * sh, c[2] * sh);
      s.h[i] = hz; s.ro[i] = 0.72 + (1 - cp) * 0.15;
    };
    forLine(W, H, x, y, mx, my, rad, fn);
    forLine(W, H, mx, my, x1, y1, rad, (i, d, t) => fn(i, d, t * 0.5 + 0.5));
  }
  applyCavity(s, 3 * k, 0.6, 0.5);
  return finish(s, 4);
}

// cloth — 1 m tile: faded canvas awning fabric, optional vertical stripes (8/tile).
function genCloth(color, stripes, seed) {
  const S = Math.max(128, baseSize() >> 1), W = S, H = S, k = S / 512, sd = seedOf(seed, 181);
  const [cr, cg, cb] = rgb(color);
  const NT = 128, p = W / NT;
  const nF = fbm(W, H, { sx: 3, oct: 6, gain: 0.55, seed: sd + 1 });
  const nW = fbm(W, H, { sx: 2, sy: 3, oct: 3, seed: sd + 2 });
  const nS = fbm(W, H, { sx: 5, oct: 5, seed: sd + 3 });
  const nV = fbm(W, H, { sx: 24, sy: 2, oct: 3, seed: sd + 4 });
  const fu = fibers(W, H, 24, sd + 5, true), fv = fibers(W, H, 24, sd + 6);
  const wn = white(W, H, sd + 7);
  const s = surf(W, H);
  const cream = [0.8, 0.76, 0.66];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      const wh = weaveHeight(x / p, y / p, 0.94, 0.94);
      const hw = wh >= 0 ? wh : wh <= -2 ? -2 - wh : 0;
      const fib = wh >= 0 ? fu[i] : fv[i];
      let r = cr, g = cg, b = cb;
      if (stripes) {
        const sq = ((x / W) * 8) % 2;
        const onCol = sq < 1 ? sstep(0.0, 0.035, Math.min(sq, 1 - sq)) : 0;
        r = lerp(cream[0], cr, onCol); g = lerp(cream[1], cg, onCol); b = lerp(cream[2], cb, onCol);
      }
      const fade = clamp01(0.45 + nF[i] * 0.9 + (1 - y / H) * 0.1);
      const l = (r + g + b) / 3;
      r = lerp(r, l * 1.05 + 0.12, fade * 0.5); g = lerp(g, l * 1.02 + 0.11, fade * 0.5); b = lerp(b, l * 0.95 + 0.1, fade * 0.5);
      const tide = sstep(0.018, 0.0, Math.abs(nS[i] - 0.22)) * 0.18 + sstep(0.22, 0.4, nS[i]) * 0.07;
      const grime = sstep(0.05, 0.4, nV[i]) * 0.1;
      const m = (0.95 + hw * 0.05 + fib * 0.1) * (1 - tide - grime) * (0.97 + (w - 0.5) * 0.06);
      put(s, i, r * m * 0.95, g * m * 0.93, b * m * 0.9);
      s.h[i] = hw * 0.12 + fib * 0.05 + nW[i] * 0.35;
      s.ro[i] = 0.92;
    }
  }
  return finish(s, 3);
}

// window — one window (≈1.0 × 1.5 m): weathered frame, 6 dusty panes, cracks.
function genWindow(lit, seed) {
  const S = baseSize(), W = Math.max(128, S >> 1), H = Math.round(W * 1.5), k = W / 512, sd = seedOf(seed, 191), R = makeRng(sd);
  const frameCols = ['#cfc6ae', '#56645a', '#6b4b36', '#7f929b', '#8c3f31'];
  const [fr, fg, fb] = rgb(pick(R, frameCols));
  const nP = fbm(W, H, { sx: 6, sy: 12, oct: 5, seed: sd + 1 });
  const nD = fbm(W, H, { sx: 5, sy: 7, oct: 5, seed: sd + 2 });
  const nV = fbm(W, H, { sx: 40, sy: 3, oct: 3, seed: sd + 3 });
  const gH = grainNoise(W, H, sd + 4, false, 1, 12), gV = grainNoise(W, H, sd + 5, true, 1, 8);
  const wn = white(W, H, sd + 6);
  const cas = 0.075, casT = 0.05, sill = 0.07, sash = 0.045, mul = 0.022;
  const COLS = 2, ROWS = 3;
  const x0 = cas + sash, x1 = 1 - cas - sash, y0 = casT + sash * (W / H), y1 = 1 - sill - sash * (W / H);
  const pw = (x1 - x0 - mul * (COLS - 1)) / COLS, ph = (y1 - y0 - mul * (W / H) * (ROWS - 1)) / ROWS;
  const panes = [];
  for (let j = 0; j < COLS * ROWS; j++) {
    const r = R();
    panes.push({ cracked: r < 0.2, broken: r > 0.9, ix: rr(R, 0.25, 0.75), iy: rr(R, 0.25, 0.75), dust: rr(R, 0.5, 1.1), cur: R() });
  }
  const s = surf(W, H);
  const em = lit ? surf(W, H) : null;
  const crk = f32(W * H), hole = f32(W * H);
  // crack & hole rasters
  for (let j = 0; j < panes.length; j++) {
    const pn = panes[j]; if (!pn.cracked && !pn.broken) continue;
    const c = j % COLS, r = (j / COLS) | 0;
    const px0 = (x0 + c * (pw + mul)) * W, py0 = (y0 + r * (ph + mul * (W / H))) * H, pwp = pw * W, php = ph * H;
    const cx = px0 + pn.ix * pwp, cy = py0 + pn.iy * php;
    const rays = 5 + ((R() * 5) | 0);
    const ends = [];
    for (let q = 0; q < rays; q++) {
      const a = (q / rays) * Math.PI * 2 + rr(R, -0.2, 0.2), L = rr(R, 0.5, 1.2) * Math.max(pwp, php);
      const ex = cx + Math.cos(a) * L, ey = cy + Math.sin(a) * L;
      const pts = jagged(R, cx, cy, ex, ey, 6, 4 * k);
      ends.push(pts);
      forPolyline(W, H, pts, Math.max(0.6, 0.9 * k), (i, d) => { crk[i] = Math.max(crk[i], (1 - d) * 0.8); });
    }
    for (const rad of [0.12, 0.25]) {
      for (let q = 0; q < rays; q++) {
        if (R() < 0.35) continue;
        const a = ends[q], b = ends[(q + 1) % rays];
        const ia = Math.min(a.length - 1, Math.round(rad * 10)), ib = Math.min(b.length - 1, Math.round(rad * 10));
        forLine(W, H, a[ia][0], a[ia][1], b[ib][0], b[ib][1], Math.max(0.6, 0.9 * k), (i, d) => { crk[i] = Math.max(crk[i], (1 - d) * 0.8); });
      }
    }
    if (pn.broken) {
      const hn = noise1(7, sd + j * 13), hn2 = noise1(31, sd + j * 7), hr = rr(R, 0.25, 0.4) * Math.min(pwp, php);
      forDisc(W, H, cx, cy, hr * 1.7, (i, d, dx, dy) => { const a = Math.atan2(dy, dx) / (Math.PI * 2); const sp = hn2(a); const lim = 0.55 + 0.25 * hn(a) + 0.18 * sp * Math.abs(sp); if (d < lim) hole[i] = 1; });
    }
  }
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / W, w = wn[i];
      // classify
      let region = 0, e = 1, pane = -1, pu = 0, pv = 0;
      if (u < cas || u > 1 - cas || v < casT || v > 1 - sill) {
        region = v > 1 - sill ? 3 : 1;
        e = region === 3 ? Math.min(v - (1 - sill), 1 - v) * 1.5 : Math.min(u < cas ? Math.min(u, cas - u) : u > 1 - cas ? Math.min(u - (1 - cas), 1 - u) : 1, v < casT ? Math.min(v, casT - v) * 1.5 : 1);
      } else if (u < x0 || u > x1 || v < y0 || v > y1) {
        region = 2; e = Math.min(Math.abs(u - x0), Math.abs(u - x1), Math.abs(v - y0) * H / W, Math.abs(v - y1) * H / W, u - cas, 1 - cas - u);
      } else {
        const cu = (u - x0) / (pw + mul), c = Math.min(COLS - 1, Math.floor(cu)), lu = (u - x0) - c * (pw + mul);
        const mulV = mul * (W / H);
        const cv = (v - y0) / (ph + mulV), r = Math.min(ROWS - 1, Math.floor(cv)), lv = (v - y0) - r * (ph + mulV);
        if (lu > pw || lv > ph) { region = 4; e = Math.min(lu > pw ? Math.min(lu - pw, pw + mul - lu) : 1, lv > ph ? Math.min(lv - ph, ph + mulV - lv) * H / W : 1); }
        else { pane = r * COLS + c; pu = lu / pw; pv = lv / ph; e = Math.min(lu, pw - lu, (lv) * H / W, (ph - lv) * H / W); }
      }
      if (pane < 0) {
        const vert = (region === 1 && (u < cas || u > 1 - cas)) || (region === 4 && (u - x0) % (pw + mul) > pw) || (region === 2 && (u < x0 || u > x1));
        const Rr = vert ? u * 50 + gV[i] * 2 : v * 75 + gH[i] * 2, fr = Rr - Math.floor(Rr);
        const line = sstep(0.72, 0.95, fr) * sstep(1.0, 0.97, fr);
        const peelT = 0.12;
        const paint = sstep(peelT + 0.02, peelT - 0.02, nP[i] + (1 - sstep(0, 0.012, e)) * 0.3);
        const wm = (0.82 + (w - 0.5) * 0.1) * (1 - line * 0.2);
        let r = lerp(0.46 * wm, fr * (0.95 + nD[i] * 0.1), paint), g2 = lerp(0.43 * wm, fg * (0.95 + nD[i] * 0.1), paint), b = lerp(0.39 * wm, fb * (0.95 + nD[i] * 0.1), paint);
        const dirt = clamp01(0.3 + nD[i]) * 0.25 + (region === 3 ? 0.1 : 0);
        r = lerp(r, 0.3, dirt); g2 = lerp(g2, 0.26, dirt); b = lerp(b, 0.2, dirt);
        const hB = region === 1 ? 0.85 : region === 3 ? 0.95 : region === 2 ? 0.7 : 0.62;
        const rnd = sstep(0, 0.01, e);
        const ao = region === 1 ? 1 : 0.8 + 0.2 * sstep(0, 0.02, e);
        put(s, i, r * ao, g2 * ao, b * ao);
        s.h[i] = hB - (1 - rnd) * 0.12 + paint * 0.02 + line * 0.01;
        s.ro[i] = lerp(0.9, 0.7, paint);
      } else {
        const pn = panes[pane];
        const dust = clamp01((sstep(0.35, 1.0, pv) * 0.55 + (1 - sstep(0, 0.18, Math.min(pu, 1 - pu, pv, 1 - pv))) * 0.4 + nD[i] * 0.5 + 0.15) * pn.dust + Math.max(0, nV[i]) * 0.3);
        const refl = (1 - pv) * 0.08 + sstep(0.02, 0.0, Math.abs(pu - pv * 0.6 - 0.25)) * 0.03;
        let r = 0.07 + refl, g2 = 0.075 + refl, b = 0.085 + refl * 1.1;
        if (lit) { r = 0.2; g2 = 0.14; b = 0.08; }
        r = lerp(r, 0.42, dust * 0.75); g2 = lerp(g2, 0.37, dust * 0.75); b = lerp(b, 0.29, dust * 0.75);
        const c = crk[i];
        r = lerp(r, 0.5, c * 0.45); g2 = lerp(g2, 0.52, c * 0.45); b = lerp(b, 0.52, c * 0.45);
        const ao = 0.55 + 0.45 * sstep(0, 0.025, e);
        let h = 0.3 - (1 - sstep(0, 0.008, e)) * 0.05 + c * 0.03;
        let ro = lerp(0.1, 0.75, dust) + c * 0.2;
        if (hole[i] > 0) { r = 0.02; g2 = 0.018; b = 0.016; h = 0.1; ro = 1; }
        put(s, i, r * ao, g2 * ao, b * ao);
        s.h[i] = h; s.ro[i] = clamp01(ro);
        if (em) {
          const cf = pn.cur < 0.6 ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(pu * 22 + pane)) * sstep(0.0, 0.5, Math.abs((u - 0.5) * 2)) : 0;
          const glow = (0.55 + 0.45 * (1 - Math.abs(u - 0.5) * 1.6)) * (1 - dust * 0.45) * (1 - cf * 0.55) * ao;
          const gh = hole[i] > 0 ? 1.2 : glow;
          put(em, i, 1.0 * gh, 0.6 * gh, 0.26 * gh);
        }
      }
    }
  }
  const set = finish(s, 8);
  if (em) {
    const col = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      let o = (H - 1 - y) * W * 4, i = y * W;
      for (let x = 0; x < W; x++, i++, o += 4) { col[o] = em.r[i] * 255; col[o + 1] = em.g[i] * 255; col[o + 2] = em.b[i] * 255; col[o + 3] = 255; }
    }
    set.emissiveMap = makeTex(col, W, H, true, false);
  }
  return set;
}

// door — one plank door with casing (≈1.1 × 2.2 m): ledges, Z braces, strap hinges, ring pull.
function genDoor(color, seed) {
  const S = baseSize(), W = Math.max(128, S >> 1), H = W * 2, k = W / 512, sd = seedOf(seed, 201), R = makeRng(sd);
  const [cr, cg, cb] = rgb(color);
  const gV = grainNoise(W, H, sd + 1, true, 1, 8), gH = grainNoise(W, H, sd + 2, false, 1, 16);
  const NR = 44, GA = 2.2;
  const fbV = fibers(W, H, 20, sd + 3, true), fbH = fibers(W, H, 12, sd + 4);
  const nP = fbm(W, H, { sx: 14, sy: 6, oct: 6, gain: 0.58, seed: sd + 5 });
  const nD = fbm(W, H, { sx: 4, sy: 8, oct: 5, seed: sd + 6 });
  const wn = white(W, H, sd + 7);
  const cas = 0.085, casT = 0.045, thr = 0.012, NP = 5;
  const dx0 = cas, dx1 = 1 - cas, dy0 = casT, dy1 = 1 - thr;
  const ledges = [0.13, 0.5, 0.86], lh = 0.06;
  const s = surf(W, H, true);
  const tones = []; for (let i = 0; i < 12; i++) tones.push(rr(R, -1, 1));
  const T = 0.05 - 0.4 * R();
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / W, w = wn[i];
      let part = 0, e = 1, g, fb, id = 0, h;
      const RV = u * NR + gV[i] * GA, RH = v * NR * 2 + gH[i] * GA;
      if (u < dx0 || u > dx1 || v < dy0) { part = 3; g = v < dy0 ? RH : RV; fb = v < dy0 ? fbH[i] : fbV[i]; id = 10; e = v < dy0 ? Math.min(v, dy0 - v) * 2 : Math.min(u < dx0 ? Math.min(u, dx0 - u) : Math.min(u - dx1, 1 - u), v - dy0 + 0.02); }
      else if (v > dy1) { part = 4; g = RH; fb = fbH[i]; e = 1; }
      else {
        const du = (u - dx0) / (dx1 - dx0), dv = (v - dy0) / (dy1 - dy0);
        let li = -1;
        for (let q = 0; q < 3; q++) if (Math.abs(dv - ledges[q]) < lh * 0.5) li = q;
        // Z braces between ledges (lower-left → upper-right)
        let br = false, bE = 0;
        for (let q = 0; q < 2 && li < 0; q++) {
          const ya = ledges[q] + lh * 0.5, yb = ledges[q + 1] - lh * 0.5;
          if (dv > ya && dv < yb) {
            const t = (dv - ya) / (yb - ya); const cxl = lerp(0.92, 0.08, t);
            const dd = Math.abs(du - cxl) * (dx1 - dx0) * W / H;
            const bw2 = 0.03;
            if (dd < bw2) { br = true; bE = bw2 - dd; }
          }
        }
        if (li >= 0) { part = 2; g = RH; fb = fbH[i]; id = 6 + li; e = Math.min(lh * 0.5 - Math.abs(dv - ledges[li]), du, 1 - du) * 0.5; }
        else if (br) { part = 1; g = ((x * 0.64 + y * 0.77) / W) * NR + sampleW(gH, W, H, x * 0.77 - y * 0.64, x * 0.64 + y * 0.77) * GA; fb = fbV[i]; id = 9; e = bE * 1.5; }
        else { const pu = du * NP, pi = Math.min(NP - 1, Math.floor(pu)), pf = pu - pi; part = 0; g = RV; fb = fbV[i]; id = pi; e = Math.min(pf, 1 - pf) / NP * (dx1 - dx0) * 0.5; }
      }
      const Rr = g + id * 7.3, fr = Rr - Math.floor(Rr), line = sstep(0.72, 0.95, fr) * sstep(1.0, 0.97, fr);
      const edge = 1 - sstep(0, 0.012, e);
      const pv = nP[i] + edge * 0.35 + sstep(0.85, 1.0, v) * 0.3 + (w - 0.5) * 0.04;
      const paint = part === 4 ? 0 : sstep(T + 0.012, T - 0.012, pv);
      const wm = (0.86 + tones[id % 12] * 0.06) * (1 - line * 0.25) * (0.9 + fb * 0.3);
      let r = lerp(0.45 * wm, cr * (0.93 + nD[i] * 0.12 + tones[id % 12] * 0.04), paint);
      let g2 = lerp(0.42 * wm, cg * (0.93 + nD[i] * 0.12 + tones[id % 12] * 0.04), paint);
      let b = lerp(0.38 * wm, cb * (0.93 + nD[i] * 0.12 + tones[id % 12] * 0.04), paint);
      const kick = sstep(0.82, 1.0, v) * clamp01(0.5 + nD[i]) * 0.55;
      r = lerp(r, 0.3, kick); g2 = lerp(g2, 0.25, kick); b = lerp(b, 0.19, kick);
      if (part === 0) h = 0.4 + sstep(0, 0.006, e) * 0.1;
      else if (part === 1 || part === 2) h = 0.62 + sstep(0, 0.008, e) * 0.12;
      else if (part === 3) h = 0.8 + sstep(0, 0.012, e) * 0.12;
      else h = 0.3;
      if (part === 0 && e < 0.0025) { h = 0.3; r *= 0.35; g2 *= 0.35; b *= 0.35; }
      h += fb * 0.02 + line * 0.015 + paint * 0.02;
      const ao = part === 0 ? 0.8 : 1;
      put(s, i, r * ao, g2 * ao, b * ao);
      s.h[i] = h; s.ro[i] = lerp(0.88, 0.7, paint); s.me[i] = 0;
    }
  }
  // hardware (iron): strap hinges on the left, ring pull + keyhole plate on the right
  const iron = (i, hh, d) => { const c = 0.1 + (1 - d) * 0.05 + (wn[i] - 0.5) * 0.03; put(s, i, c * 1.05, c, c * 0.95); s.h[i] = Math.max(s.h[i], hh); s.ro[i] = 0.55; s.me[i] = 0.75; };
  for (const lv of [ledges[0], ledges[2]]) {
    const yc = (dy0 + lv * (dy1 - dy0)) * H, xs = dx0 * W - 6 * k, len = 0.48 * W;
    forLine(W, H, xs, yc, xs + len, yc, 11 * k, (i, d, t) => { const taper = 1 - t * 0.45; if (d < taper) iron(i, 0.9 + (1 - d) * 0.05, d / taper); });
    forDisc(W, H, xs + len, yc, 13 * k, (i, d) => iron(i, 0.9 + (1 - d) * 0.05, d));
    for (let q = 0; q < 4; q++) forDisc(W, H, xs + 25 * k + q * len / 4, yc, 3.5 * k, (i, d) => { const c = 0.18 + (1 - d) * 0.1; put(s, i, c, c, c); s.h[i] += (1 - d) * 0.05; });
    // rust bleed below
    forLine(W, H, xs + len * 0.5, yc + 10 * k, xs + len * 0.5 + 2 * k, yc + rr(R, 40, 110) * k, 20 * k, (i, d, t) => mixPx(s, i, 0.38, 0.22, 0.13, (1 - d) * (1 - t) * 0.3));
  }
  const hx = (dx1 - 0.08) * W, hy = (dy0 + 0.49 * (dy1 - dy0)) * H;
  forLine(W, H, hx, hy - 30 * k, hx, hy + 38 * k, 14 * k, (i, d) => iron(i, 0.9, d));
  forDisc(W, H, hx, hy + 18 * k, 5 * k, (i, d) => { put(s, i, 0.02, 0.02, 0.02); s.h[i] -= 0.2; });
  forDisc(W, H, hx, hy - 8 * k, 26 * k, (i, d) => { const ring = Math.abs(d - 0.8); if (ring < 0.18) iron(i, 1.0 + (0.18 - ring) * 0.8, ring / 0.18); });
  return finish(s, 8);
}

// =============================================================================
//  SIGNS / PRINTED
// =============================================================================
function genSign(text, o) {
  const f = Math.max(0.5, qScale());
  const W = Math.max(32, Math.round((o.w ?? 512) * f)), H = Math.max(16, Math.round((o.h ?? 128) * f));
  const bg = o.bg ?? '#3b2a1c', fgc = o.fg ?? '#e9d8a6', border = o.border ?? true, style = o.style ?? 'carved';
  const sd = seedOf((o.seed ?? 1) + '|' + text, 211), R = makeRng(sd), k = H / 128;
  const [br, bgG, bb] = rgb(bg), [fr, fg, fb] = rgb(fgc);
  const nb = Math.max(1, Math.round(H / (W * 0.14)));
  const cy = Math.max(1, Math.round((8 * H) / W));
  const gA = grainNoise(W, H, sd + 1, false, 1, Math.max(2, cy * 4));
  const NRs = Math.max(8, Math.round(H / 5));
  const fibH = fibers(W, H, 16, sd + 2);
  const nP = fbm(W, H, { sx: 8, sy: Math.max(2, cy * 2), oct: 5, gain: 0.55, seed: sd + 3 });
  const nC = fbm(W, H, { sx: 24, sy: Math.max(2, cy * 3), oct: 3, seed: sd + 4 });
  const nD = fbm(W, H, { sx: 4, sy: Math.max(1, cy), oct: 4, seed: sd + 5 });
  const wn = white(W, H, sd + 6);
  const ins = Math.round(H * 0.09), bwid = Math.max(2, H * 0.028);
  const mask = canvasMask(W, H, (ctx) => {
    const px = fitText(ctx, text, W - ins * 2 - H * 0.3, Math.round(H * 0.56), westernFont);
    ctx.font = westernFont(px);
    ctx.fillText(text, W / 2, H / 2 + px * 0.04);
  });
  const mB = blur(mask, W, H, Math.max(1, H * 0.015));
  const bh = H / nb, tones = []; for (let i = 0; i < nb; i++) tones.push({ t: rr(R, -1, 1), go: R() * 20 });
  const s = surf(W, H);
  const carved = style !== 'painted';
  for (let y = 0; y < H; y++) {
    const bi = Math.min(nb - 1, (y / bh) | 0), tt = tones[bi], ty = y - bi * bh;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      const eO = Math.min(x, W - 1 - x, y, H - 1 - y);
      const eB = Math.min(ty, bh - ty);
      const Rr = (y / H) * NRs + gA[i] * 2 + tt.go, fr = Rr - Math.floor(Rr), line = sstep(0.72, 0.95, fr) * sstep(1.0, 0.97, fr);
      const wm = (0.85 + tt.t * 0.06) * (1 - line * 0.25) * (0.9 + fibH[i] * 0.3);
      let r = 0.44 * wm, g = 0.4 * wm, b = 0.34 * wm;
      const edgeW = 1 - sstep(0, 6 * k, eO);
      const paint = sstep(0.34, 0.3, nP[i] + edgeW * 0.35 + (w - 0.5) * 0.04);
      const pm = 0.9 + nD[i] * 0.15;
      r = lerp(r, br * pm, paint); g = lerp(g, bgG * pm, paint); b = lerp(b, bb * pm, paint);
      // border line
      let bl = 0;
      if (border) {
        const dr = Math.min(Math.abs(x - ins), Math.abs(W - 1 - ins - x), Math.abs(y - ins), Math.abs(H - 1 - ins - y));
        const inR = x >= ins - bwid && x <= W - 1 - ins + bwid && y >= ins - bwid && y <= H - 1 - ins + bwid;
        if (inR) bl = sstep(bwid * 0.5 + 0.8, bwid * 0.5 - 0.3, dr);
      }
      const tm = mask[i];
      const chip = sstep(0.28, 0.4, nC[i] + (w - 0.5) * 0.3);
      const letter = Math.max(tm, bl);
      let h = 0.6 + fibH[i] * 0.03 + line * 0.02 - edgeW * 0.25 - (eB < 1.5 * k ? 0.3 : 0) + paint * 0.02;
      if (carved) {
        const cut = Math.max(mB[i], bl);
        h -= cut * 0.35;
        const fill = letter * (1 - chip * 0.8);
        const sh = 1 - sstep(0.2, 0.9, cut) * 0.25;
        r = lerp(r * 0.55, fr, fill) * sh; g = lerp(g * 0.55, fg, fill) * sh; b = lerp(b * 0.55, fb, fill) * sh;
      } else {
        const fill = letter * (1 - chip);
        r = lerp(r, fr * (0.92 + nD[i] * 0.1), fill); g = lerp(g, fg * (0.92 + nD[i] * 0.1), fill); b = lerp(b, fb * (0.92 + nD[i] * 0.1), fill);
        h += fill * 0.03;
      }
      if (eB < 1.5 * k && nb > 1) { r *= 0.3; g *= 0.3; b *= 0.3; }
      const m = (1 - edgeW * 0.35) * (0.96 + (w - 0.5) * 0.08);
      put(s, i, r * m, g * m, b * m);
      s.h[i] = h; s.ro[i] = 0.82;
    }
  }
  // bolt heads at the ends
  for (const bx of [H * 0.2, W - H * 0.2]) for (let q = 0; q < nb; q++) {
    forDisc(W, H, bx, (q + 0.5) * bh, Math.max(1.5, 4 * k), (i, d) => { const c = 0.14 + (1 - d) * 0.1; put(s, i, c, c * 0.95, c * 0.9); s.h[i] += (1 - d * d) * 0.1; });
  }
  return finish(s, 6, { clamp: false });
}

function drawOutlaw(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx - 1.05 * s, cy + 1.3 * s);
  ctx.bezierCurveTo(cx - 1.0 * s, cy + 0.6 * s, cx - 0.6 * s, cy + 0.5 * s, cx - 0.2 * s, cy + 0.42 * s);
  ctx.lineTo(cx - 0.17 * s, cy + 0.2 * s); ctx.lineTo(cx + 0.17 * s, cy + 0.2 * s); ctx.lineTo(cx + 0.2 * s, cy + 0.42 * s);
  ctx.bezierCurveTo(cx + 0.6 * s, cy + 0.5 * s, cx + 1.0 * s, cy + 0.6 * s, cx + 1.05 * s, cy + 1.3 * s);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx, cy - 0.02 * s, 0.27 * s, 0.34 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx, cy - 0.3 * s, 0.62 * s, 0.1 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 0.3 * s, cy - 0.3 * s); ctx.bezierCurveTo(cx - 0.32 * s, cy - 0.65 * s, cx - 0.22 * s, cy - 0.72 * s, cx - 0.08 * s, cy - 0.66 * s);
  ctx.quadraticCurveTo(cx, cy - 0.6 * s, cx + 0.08 * s, cy - 0.66 * s);
  ctx.bezierCurveTo(cx + 0.22 * s, cy - 0.72 * s, cx + 0.32 * s, cy - 0.65 * s, cx + 0.3 * s, cy - 0.3 * s);
  ctx.closePath(); ctx.fill();
  // bandana (knockout) is drawn by the caller
}

function genPoster(kind, seed) {
  const S = baseSize(), W = Math.max(128, S >> 1), H = Math.round(W * 1.5), k = W / 512, sd = seedOf(seed + '|' + kind, 221), R = makeRng(sd);
  const names = ['"BLACK" JACK MORROW', 'EZEKIEL "ONE-EYE" CRANE', 'THE DAWN KID', 'SILAS VANCE', 'DUTCH MALLORY', 'CALEB "RATTLER" HOLT'];
  const rewards = ['$5,000', '$2,500', '$10,000', '$1,500', '$3,000', '$7,500'];
  const name = pick(R, names), reward = pick(R, rewards);
  const mk = () => canvasMask(W, H, (ctx) => {
    const m = W * 0.06;
    ctx.lineWidth = Math.max(1, 3 * k); ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
    ctx.lineWidth = Math.max(1, 1.2 * k); ctx.strokeRect(m + 7 * k, m + 7 * k, W - 2 * m - 14 * k, H - 2 * m - 14 * k);
    if (kind === 'notice') {
      let px = fitText(ctx, 'NOTICE', W * 0.78, Math.round(H * 0.12), westernFont); ctx.fillText('NOTICE', W / 2, H * 0.14);
      const lines = ['BY ORDER OF THE', 'TOWN MARSHAL', '—', 'NO FIREARMS', 'TO BE CARRIED', 'WITHIN TOWN LIMITS', '—', 'VIOLATORS WILL BE', 'FINED OR JAILED'];
      lines.forEach((t, j) => { const big = j >= 3 && j <= 5; px = fitText(ctx, t, W * 0.74, Math.round(H * (big ? 0.06 : 0.04)), big ? westernFont : serifFont); ctx.fillText(t, W / 2, H * (0.27 + j * 0.068)); });
      fitText(ctx, 'DAWN VILLAGE, 1887', W * 0.6, Math.round(H * 0.03), (p) => serifFont(p, 'italic')); ctx.fillText('DAWN VILLAGE, 1887', W / 2, H * 0.9);
      return;
    }
    fitText(ctx, 'WANTED', W * 0.8, Math.round(H * 0.14), westernFont); ctx.fillText('WANTED', W / 2, H * 0.135);
    fitText(ctx, 'DEAD OR ALIVE', W * 0.62, Math.round(H * 0.04), serifFont); ctx.fillText('DEAD OR ALIVE', W / 2, H * 0.225);
    const fx = W * 0.27, fy = H * 0.26, fw = W * 0.46, fh = H * 0.3;
    ctx.lineWidth = Math.max(1, 2 * k); ctx.strokeRect(fx, fy, fw, fh);
    ctx.save(); ctx.beginPath(); ctx.rect(fx + 3 * k, fy + 3 * k, fw - 6 * k, fh - 6 * k); ctx.clip();
    ctx.globalAlpha = 0.18; ctx.fillRect(fx, fy, fw, fh); ctx.globalAlpha = 1;
    drawOutlaw(ctx, W / 2, fy + fh * 0.52, fh * 0.42);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.ellipse(W / 2, fy + fh * 0.6, fh * 0.12, fh * 0.05, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    fitText(ctx, name, W * 0.8, Math.round(H * 0.045), westernFont); ctx.fillText(name, W / 2, H * 0.615);
    fitText(ctx, 'REWARD', W * 0.5, Math.round(H * 0.06), westernFont); ctx.fillText('REWARD', W / 2, H * 0.685);
    fitText(ctx, reward, W * 0.7, Math.round(H * 0.1), westernFont); ctx.fillText(reward, W / 2, H * 0.77);
    const small = ['FOR THE CAPTURE OF THE OUTLAW WHO ROBBED', 'THE DAWN VILLAGE BANK & SHOT A DEPUTY.', 'ARMED AND DANGEROUS — DO NOT APPROACH.'];
    small.forEach((t, j) => { fitText(ctx, t, W * 0.78, Math.round(H * 0.022), (p) => serifFont(p, '')); ctx.fillText(t, W / 2, H * (0.835 + j * 0.03)); });
    fitText(ctx, 'SHERIFF\'S OFFICE', W * 0.5, Math.round(H * 0.026), serifFont); ctx.fillText('SHERIFF\'S OFFICE', W / 2, H * 0.925);
  });
  const ink = mk();
  const inkB = blur(ink, W, H, Math.max(1, 1.5 * k));
  const nS = fbm(W, H, { sx: 3, sy: 4, oct: 6, seed: sd + 1 });
  const nI = fbm(W, H, { sx: 16, sy: 24, oct: 3, seed: sd + 2 });
  const nW = fbm(W, H, { sx: 4, sy: 6, oct: 5, seed: sd + 3 });
  const fb = fibers(W, H, 24, sd + 4);
  const eN = noise1(24, sd + 5), eN2 = noise1(60, sd + 6);
  const wn = white(W, H, sd + 7);
  const corner = (R() * 4) | 0, cut = rr(R, 0.1, 0.2);
  const s = surf(W, H, false, true);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, u = (x + 0.5) / W, w = wn[i];
      // torn edge alpha
      const eu = Math.min(u, 1 - u), ev = Math.min(v, 1 - v) * 1.5;
      const jag = (eN(u * 0.5 + (v < 0.5 ? 0 : 0.5)) * 0.008 + eN2(v * 0.7 + (u < 0.5 ? 0 : 0.37)) * 0.006);
      let a = sstep(0.006, 0.012, Math.min(eu, ev) + jag + (w - 0.5) * 0.004);
      const cu = corner & 1 ? 1 - u : u, cv = corner & 2 ? 1 - v : v;
      const cd = cu + cv / 1.5 - cut + eN2(cu * 3) * 0.02;
      if (cd < 0) a = 0; else a *= sstep(0.0, 0.006, cd);
      const ed = Math.min(eu, ev, cd < 1 ? cd : 1);
      const age = sstep(0.12, 0.0, ed) * 0.55;
      const stain = sstep(0.1, 0.45, nS[i]) * 0.25 + sstep(0.012, 0.0, Math.abs(nS[i] - 0.3)) * 0.2;
      const fox = w > 0.9985 ? 0.5 : 0;
      let r = 0.8, g = 0.72, b = 0.53;
      const m = (1 + fb[i] * 0.08 + nW[i] * 0.05) * (1 - age * 0.5) * (1 - stain * 0.5) * (1 - fox * 0.4);
      r *= m; g *= m * 0.98; b *= m * 0.94;
      r = lerp(r, 0.5, age * 0.5); g = lerp(g, 0.36, age * 0.5); b = lerp(b, 0.2, age * 0.5);
      const crease = Math.max(sstep(2.5 * k, 0, Math.abs(x - W / 2)), sstep(2.5 * k, 0, Math.abs(y - H * 0.5)));
      r *= 1 - crease * 0.12; g *= 1 - crease * 0.12; b *= 1 - crease * 0.12;
      const iv = ink[i] * (0.82 + 0.18 * sstep(-0.3, 0.3, nI[i])) + inkB[i] * 0.1;
      r = lerp(r, 0.1, iv * 0.88); g = lerp(g, 0.08, iv * 0.88); b = lerp(b, 0.06, iv * 0.88);
      put(s, i, r, g, b);
      s.a[i] = a;
      s.h[i] = nW[i] * 0.4 + fb[i] * 0.05 - crease * 0.05 + iv * 0.01;
      s.ro[i] = 0.9;
    }
  }
  // nail holes at top corners + centre
  for (const [nx, ny] of [[0.1, 0.035], [0.9, 0.035], [0.5, 0.03]]) {
    if (R() < 0.3) continue;
    forDisc(W, H, nx * W, ny * H, 9 * k, (i, d) => mixPx(s, i, 0.35, 0.2, 0.1, (1 - d) * 0.5));
    forDisc(W, H, nx * W, ny * H, 2.5 * k, (i) => { s.a[i] = 0; });
  }
  return finish(s, 4, { noRough: true });
}

function genClockFace() {
  const S = baseSize(), W = Math.max(128, S >> 1), H = W, k = W / 512, sd = seedOf('clock', 231), R = makeRng(sd);
  const romans = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const c = W / 2;
  const ink = canvasMask(W, H, (ctx) => {
    ctx.lineWidth = Math.max(1, 2.2 * k);
    for (const rr_ of [0.405, 0.37]) { ctx.beginPath(); ctx.arc(c, c, rr_ * W, 0, Math.PI * 2); ctx.stroke(); }
    for (let t = 0; t < 60; t++) {
      const a = (t / 60) * Math.PI * 2, big = t % 5 === 0;
      const r0 = 0.37 * W, r1 = 0.405 * W;
      ctx.lineWidth = Math.max(1, (big ? 4 : 1.6) * k);
      ctx.beginPath(); ctx.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0); ctx.lineTo(c + Math.sin(a) * r1, c - Math.cos(a) * r1); ctx.stroke();
    }
    ctx.font = serifFont(Math.round(W * 0.085), 'bold');
    for (let j = 0; j < 12; j++) {
      ctx.save(); ctx.translate(c, c); ctx.rotate((j / 12) * Math.PI * 2); ctx.translate(0, -0.3 * W);
      ctx.scale(j === 0 ? 0.85 : 1, 1.15); ctx.fillText(romans[j], 0, 0); ctx.restore();
    }
    ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.beginPath(); ctx.arc(c, c, 0.14 * W, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, 0.035 * W, 0, Math.PI * 2); ctx.fill();
    ctx.font = serifFont(Math.round(W * 0.026), 'italic');
    ctx.fillText('J. W. HARLAN & SONS', c, c + 0.19 * W);
    ctx.fillText('DAWN VILLAGE · 1887', c, c + 0.225 * W);
  });
  const nS = fbm(W, H, { sx: 3, oct: 6, seed: sd + 1 });
  const nP = fbm(W, H, { sx: 8, oct: 4, seed: sd + 2 });
  const wo = worley(W, H, 22, 22, sd + 3, { jitter: 1 });
  const wn = white(W, H, sd + 4);
  const crk = f32(W * H);
  const ix = c + rr(R, -0.25, 0.25) * W, iy = c + rr(R, 0.1, 0.3) * W;
  for (let q = 0; q < 9; q++) {
    const a = R() * Math.PI * 2, L = rr(R, 0.15, 0.55) * W;
    forPolyline(W, H, jagged(R, ix, iy, ix + Math.cos(a) * L, iy + Math.sin(a) * L, 7, 5 * k), Math.max(0.7, 1.2 * k), (i, d) => { crk[i] = Math.max(crk[i], 1 - d); });
  }
  const s = surf(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, w = wn[i];
      const dx = (x + 0.5 - c) / W, dy = (y + 0.5 - c) / W, r = Math.sqrt(dx * dx + dy * dy);
      let cr, cg, cb;
      if (r < 0.44) {
        const st = sstep(0.0, 0.5, nS[i]) * 0.3 + sstep(0.3, 0.44, r) * 0.35 + (dy > 0 ? dy * 0.4 : 0);
        const craq = sstep(0.02, 0.004, wo.f2[i] - wo.f1[i]) * sstep(-0.1, 0.3, nP[i]) * 0.45;
        cr = 0.86 * (1 - st * 0.35); cg = 0.8 * (1 - st * 0.42); cb = 0.62 * (1 - st * 0.55);
        cr *= 1 - craq * 0.35; cg *= 1 - craq * 0.4; cb *= 1 - craq * 0.45;
        const iv = ink[i] * (0.85 + (w - 0.5) * 0.2);
        cr = lerp(cr, 0.09, iv); cg = lerp(cg, 0.075, iv); cb = lerp(cb, 0.06, iv);
        const haze = clamp01(0.2 + nP[i] * 0.4) * 0.15;
        cr = lerp(cr, 0.55, haze); cg = lerp(cg, 0.5, haze); cb = lerp(cb, 0.42, haze);
        const cc = crk[i] * 0.55;
        cr = lerp(cr, 0.95, cc); cg = lerp(cg, 0.95, cc); cb = lerp(cb, 0.93, cc);
        const edge = sstep(0.43, 0.44, r);
        cr *= 1 - edge * 0.5; cg *= 1 - edge * 0.5; cb *= 1 - edge * 0.5;
      } else if (r < 0.5) {
        const t = (r - 0.44) / 0.06, prof = Math.sin(t * Math.PI);
        const pat = sstep(0.0, 0.4, nP[i] + nS[i] * 0.5);
        const lit = 0.55 + prof * 0.5 - t * 0.2 + (dy < 0 ? -dy * 0.3 : 0);
        cr = lerp(0.36, 0.26, pat) * lit; cg = lerp(0.28, 0.33, pat) * lit; cb = lerp(0.18, 0.26, pat) * lit;
      } else { cr = 0.1; cg = 0.09; cb = 0.08; }
      put(s, i, cr, cg, cb);
    }
  }
  const set = finish(s, 0, { noRough: true, clamp: true });
  return set;
}

function genBulletHole() {
  const W = Math.max(64, baseSize() >> 3), H = W, sd = seedOf('bh', 241), R = makeRng(sd);
  const jn = noise1(16, sd + 1), jn2 = noise1(64, sd + 2), jn3 = noise1(29, sd + 3);
  const s = surf(W, H, false, true);
  const rays = [];
  const nr = 6 + ((R() * 5) | 0);
  for (let q = 0; q < nr; q++) rays.push({ a: R(), l: rr(R, 0.18, 0.42), w: rr(R, 0.003, 0.006) });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / H - 0.5, r = Math.sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
      const rh = 0.075 * (1 + jn(a) * 0.18 + jn2(a) * 0.08);
      const rs = 0.15 * (1 + jn3(a) * 0.3 + jn2(a) * 0.3);
      let ray = 0;
      for (const q of rays) { let da = Math.abs(a - q.a); da = Math.min(da, 1 - da) * Math.PI * 2 * r; if (r < q.l && r > rh) ray = Math.max(ray, sstep(q.w, 0, da) * (1 - r / q.l)); }
      const soot = sstep(0.46, 0.08, r) * 0.4;
      let al = soot, cr = 0.07, cg = 0.065, cb = 0.06, h = 0.5;
      if (r < rs) { const t = sstep(rs, rs * 0.75, r); al = Math.max(al, t * 0.55); cr = lerp(cr, 0.34, t); cg = lerp(cg, 0.3, t); cb = lerp(cb, 0.25, t); h = 0.5 + t * 0.1 * (1 - r / rs); }
      if (ray > 0) { al = Math.max(al, ray * 0.85); cr = lerp(cr, 0.05, ray); cg = lerp(cg, 0.045, ray); cb = lerp(cb, 0.04, ray); h -= ray * 0.08; }
      if (r < rh * 1.45) { const t = sstep(rh * 1.45, rh, r); cr = lerp(cr, 0.1, t); cg = lerp(cg, 0.08, t); cb = lerp(cb, 0.065, t); al = Math.max(al, t); h = lerp(h, 0.4, t); }
      if (r < rh) { cr = 0.012; cg = 0.01; cb = 0.009; al = 1; h = 0.4 - (1 - r / rh) * 0.4; }
      put(s, i, cr, cg, cb); s.a[i] = al; s.h[i] = h;
    }
  }
  return finish(s, 3, { clamp: true, noRough: true });
}

function genBlood(seed) {
  const W = Math.max(64, baseSize() >> 2), H = W, sd = seedOf(seed, 251), R = makeRng(sd);
  const rn = noise1(12, sd + 1), rn2 = noise1(40, sd + 2);
  const spikes = [];
  for (let q = 0; q < 9; q++) spikes.push({ a: R(), w: rr(R, 0.01, 0.03), h: rr(R, 0.2, 0.9) });
  const s = surf(W, H, false, true);
  const nI = fbm(W, H, { sx: 6, oct: 4, seed: sd + 3 });
  const base = rr(R, 0.13, 0.19);
  const ox = rr(R, -0.04, 0.04), oy = rr(R, -0.04, 0.04);
  const thick = f32(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, dx = (x + 0.5) / W - 0.5 - ox, dy = (y + 0.5) / H - 0.5 - oy, r = Math.sqrt(dx * dx + dy * dy), a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
    let sp = 0;
    for (const q of spikes) { let da = Math.abs(a - q.a); da = Math.min(da, 1 - da); sp = Math.max(sp, Math.exp(-(da * da) / (q.w * q.w)) * q.h); }
    const lim = base * (1 + rn(a) * 0.28 + rn2(a) * 0.08 + sp);
    thick[i] = sstep(lim + 1.2 / W, lim - 1.2 / W, r) * (1 - r / (lim * 2.2));
  }
  // satellite droplets
  for (let q = 0; q < 34; q++) {
    const sp = spikes[(R() * spikes.length) | 0], a = (R() < 0.6 ? sp.a + rr(R, -0.03, 0.03) : R()) * Math.PI * 2 - Math.PI;
    const d = rr(R, base * 1.3, 0.47), rad = rr(R, 0.004, 0.022) * (1 - d) * W;
    if (rad < 0.8) continue;
    const cx = (0.5 + ox + Math.cos(a) * d) * W, cy = (0.5 + oy + Math.sin(a) * d) * H;
    if (cx < rad * 2 || cy < rad * 2 || cx > W - rad * 2 || cy > H - rad * 2) continue;
    forEllipse(W, H, cx, cy, rad * rr(R, 1.2, 2.2), rad, a, (i, dd) => { thick[i] = Math.max(thick[i], sstep(1, 0.7, dd) * 0.8); });
  }
  for (let i = 0; i < W * H; i++) {
    const t = thick[i];
    const edge = sstep(0.05, 0.25, t) * sstep(0.55, 0.3, t);
    const m = 1 + nI[i] * 0.15;
    put(s, i, lerp(0.42, 0.24, t) * m * (1 - edge * 0.25), lerp(0.035, 0.015, t) * m, lerp(0.03, 0.015, t) * m);
    s.a[i] = clamp01(sstep(0.0, 0.12, t) * (0.8 + 0.2 * t));
  }
  return finish(s, 0, { clamp: true, noRough: true });
}

function genScorch() {
  const W = Math.max(64, baseSize() >> 2), H = W, sd = seedOf('scorch', 261);
  const an = noise1(10, sd + 1), an2 = noise1(48, sd + 2), an3 = noise1(128, sd + 5);
  const nI = fbm(W, H, { sx: 6, oct: 5, seed: sd + 3 });
  const nF = fbm(W, H, { sx: 24, oct: 3, seed: sd + 4 });
  const wn = white(W, H, sd + 6);
  const s = surf(W, H, false, true);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / H - 0.5, r = Math.sqrt(dx * dx + dy * dy) * 2, a = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
    const ray = an3(a) * 0.5 + 0.5;
    const rr_ = r * (1 + an(a) * 0.2 + an2(a) * 0.1) + nI[i] * 0.12 - ray * 0.12 * r;
    const dens = sstep(0.98, 0.15, rr_);
    const core = sstep(0.5, 0.0, rr_);
    const speck = wn[i] > 0.94 && rr_ < 1.05 ? 0.35 : 0;
    const brk = 0.75 + 0.25 * sstep(-0.3, 0.3, nF[i]);
    const c = lerp(0.22, 0.025, core) * (1 - speck * 0.5);
    put(s, i, c * 1.12, c * 0.9, c * 0.72);
    s.a[i] = clamp01(Math.max(Math.pow(dens, 1.25) * brk * (0.85 + nI[i] * 0.3), speck));
  }
  return finish(s, 0, { clamp: true, noRough: true, sat: 1 });
}

function genParticleSoft() {
  const W = baseSize() >= 1024 ? 128 : 64, H = W, sd = seedOf('ps', 271);
  const nI = fbm(W, H, { sx: 4, oct: 3, seed: sd + 1 });
  const s = surf(W, H, false, true);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, dx = ((x + 0.5) / W - 0.5) * 2, dy = ((y + 0.5) / H - 0.5) * 2, r2 = dx * dx + dy * dy;
    const f = r2 >= 1 ? 0 : (1 - r2) * (1 - r2);
    put(s, i, 1, 1, 1);
    s.a[i] = clamp01(f * (0.88 + nI[i] * 0.25));
  }
  return finish(s, 0, { clamp: true, noRough: true });
}
function genParticleSpark() {
  const W = 64, H = 64;
  const s = surf(W, H, false, true);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, dx = ((x + 0.5) / W - 0.5) * 2, dy = ((y + 0.5) / H - 0.5) * 2, r2 = dx * dx + dy * dy;
    const core = Math.exp(-r2 * 40), glow = Math.exp(-r2 * 7) * 0.45;
    const flare = (Math.exp(-dy * dy * 500 - dx * dx * 3) + Math.exp(-dx * dx * 500 - dy * dy * 3)) * 0.25;
    const edge = r2 >= 1 ? 0 : 1 - r2;
    const a = clamp01((core + glow + flare) * edge);
    const t = clamp01(core * 1.5);
    put(s, i, 1, lerp(0.62, 1, t), lerp(0.22, 0.9, t));
    s.a[i] = a;
  }
  return finish(s, 0, { clamp: true, noRough: true });
}

// =============================================================================
//  PUBLIC API
// =============================================================================
const J = (o) => JSON.stringify(o ?? {});

export const Tex = {
  /** Lap siding, 2 m tile, 10 boards along U, painted `color`, peel 0..1. */
  woodSiding: ({ color = '#6f8fa8', peel = 0.5, seed = 1 } = {}) => cached('woodSiding' + J({ color, peel, seed }), () => genWoodSiding(color, peel, seed)),
  /** Floor / porch planks, 2 m tile, boards along U. */
  planks: ({ color = '#9a8266', worn = 0.5, seed = 1 } = {}) => cached('planks' + J({ color, worn, seed }), () => genPlanks(color, worn, seed)),
  /** Raw silver-grey wood, 1 m tile, grain along U (vertical:true → along V). */
  weatheredWood: ({ seed = 1, vertical = false } = {}) => cached('weatheredWood' + J({ seed, vertical }), () => genWeatheredWood(seed, vertical)),
  /** One crate face per tile (1 m). */
  crate: ({ seed = 1 } = {}) => cached('crate' + J({ seed }), () => genCrate(seed)),
  /** Dusty ground, 4 m tile. */
  dirt: ({ seed = 1 } = {}) => cached('dirt' + J({ seed }), () => genDirt(seed)),
  /** Street dirt with wagon ruts along V, 8 m tile. */
  road: ({ seed = 1 } = {}) => cached('road' + J({ seed }), () => genRoad(seed)),
  /** Canyon sandstone, 8 m tile. */
  rock: ({ seed = 1 } = {}) => cached('rock' + J({ seed }), () => genRock(seed)),
  /** Wooden shingles/shakes, 2 m tile (butts toward −V). */
  shingles: ({ color = '#8a7862', seed = 1 } = {}) => cached('shingles' + J({ color, seed }), () => genShingles(color, seed)),
  /** Corrugated sheet, 1 m tile, ridges along V. Includes metalnessMap. */
  corrugated: ({ color = '#8a8f93', rust = 0.6, seed = 1 } = {}) => cached('corrugated' + J({ color, rust, seed }), () => genCorrugated(color, rust, seed)),
  /** Old brick, 1 m tile. */
  brick: ({ color = '#8b4a36', seed = 1 } = {}) => cached('brick' + J({ color, seed }), () => genBrick(color, seed)),
  /** Fieldstone foundation, 2 m tile. */
  stoneFoundation: ({ seed = 1 } = {}) => cached('stoneFoundation' + J({ seed }), () => genStoneFoundation(seed)),
  /** Cracked stucco / adobe, 2 m tile. */
  plaster: ({ color = '#b8aa92', seed = 1 } = {}) => cached('plaster' + J({ color, seed }), () => genPlaster(color, seed)),
  /** Painted steel, 1 m tile. Includes metalnessMap. */
  metal: ({ color = '#56605a', rust = 0.3, seed = 1 } = {}) => cached('metal' + J({ color, rust, seed }), () => genMetal(color, rust, seed)),
  /** Shipping container side, 2.5 m tile. */
  container: ({ color = '#8a3b2a', seed = 1 } = {}) => cached('container' + J({ color, seed }), () => genContainer(color, seed)),
  /** Burlap sandbag, 0.5 m tile. */
  sandbag: ({ seed = 1 } = {}) => cached('sandbag' + J({ seed }), () => genSandbag(seed)),
  /** Hay bale straw, 1 m tile. */
  hay: ({ seed = 1 } = {}) => cached('hay' + J({ seed }), () => genHay(seed)),
  /** Canvas awning fabric, 1 m tile. */
  cloth: ({ color = '#8c3a2e', stripes = false, seed = 1 } = {}) => cached('cloth' + J({ color, stripes, seed }), () => genCloth(color, stripes, seed)),
  /** One window (UV 0..1), ~1 × 1.5 m. lit → emissiveMap. */
  window: ({ lit = false, seed = 1 } = {}) => cached('window' + J({ lit, seed }), () => genWindow(lit, seed)),
  /** One plank door incl. casing (UV 0..1), ~1.1 × 2.2 m. Includes metalnessMap (iron hardware). */
  door: ({ color = '#6b4a32', seed = 1 } = {}) => cached('door' + J({ color, seed }), () => genDoor(color, seed)),
  /** Weathered wooden signboard with Western lettering → {map, normalMap, roughnessMap}. */
  sign: (text = 'SALOON', opts = {}) => {
    const key = 'sign' + J([text, opts]);
    return cached(key, () => {
      const set = genSign(String(text), opts);
      regenWhenFont(set, () => genSign(String(text), opts));
      return set;
    });
  },
  /** Paper poster: 'wanted' | 'notice'. map has alpha (torn edges) → use alphaTest ≈ 0.5. */
  poster: (kind = 'wanted', { seed = 1 } = {}) => cached('poster' + J([kind, seed]), () => {
    const set = genPoster(kind, seed);
    regenWhenFont(set, () => genPoster(kind, seed));
    return set;
  }),
  /** Aged Roman-numeral clock dial (no hands) → {map}. Dial radius = 0.44 of the texture. */
  clockFace: () => cached('clockFace', genClockFace),
  /** Dark gunmetal, 1 m tile. Includes metalnessMap. */
  metalDark: () => cached('metalDark', genMetalDark),
  decalBulletHole: () => cached('decalBulletHole', genBulletHole),
  decalBlood: (o = {}) => { const seed = typeof o === 'object' && o ? (o.seed ?? 1) : (o ?? 1); return cached('decalBlood' + J({ seed }), () => genBlood(seed)); },
  decalScorch: () => cached('decalScorch', genScorch),
  particleSoft: () => cached('particleSoft', genParticleSoft),
  particleSpark: () => cached('particleSpark', genParticleSpark),
};
Tex.ground = Tex.dirt;

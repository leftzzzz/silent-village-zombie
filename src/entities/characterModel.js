// Procedural articulated character models + procedural animation for the CF "New Silent Village" recreation.
// Kinds: human (4 skins), zombie (level 1..3), mother, terminator, hunter.
// Everything (geometry, materials, patterns) is generated in code — no external assets.
//
// Rendering approach: every bone owns ONE merged mesh. All parts of a character share ONE material
// (MeshStandardMaterial patched via onBeforeCompile) whose per-vertex attributes select a procedural
// surface pattern (camo, digital camo, fabric weave, MOLLE webbing, skin, rotten zombie skin with veins,
// obsidian with glowing cracks, brushed metal, bone, flesh, hair, knit...). Patterns are evaluated in
// bone-local space so they never swim while animating. The compiled program is shared by all
// instances; each instance clones the material only for its own flash/pulse uniforms.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PI = Math.PI;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// ------------------------------------------------------------------------------------------------
// Weapon factory hook
// ------------------------------------------------------------------------------------------------
let weaponFactory = null;
export function setWeaponFactory(fn) {
  weaponFactory = typeof fn === 'function' ? fn : null;
}

// ------------------------------------------------------------------------------------------------
// Surface pattern ids (stored in vertex attribute aMat.x)
// ------------------------------------------------------------------------------------------------
const PAT = {
  PLAIN: 0, CAMO: 1, DIGI: 2, FABRIC: 3, SKIN: 4, ZSKIN: 5, METAL: 6, OBSID: 7, GLOW: 8,
  HAIR: 9, KNIT: 10, BONE: 11, FLESH: 12, MOLLE: 13, LEATHER: 14, DENIM: 15,
};
const M = (pat, rough, metal = 0, emis = 0) => [pat, rough, metal, emis];

const VERT_PARS = /* glsl */ `
attribute vec4 aMat;
varying vec4 vMat;
varying vec3 vObjPos;
`;
const FRAG_PARS = /* glsl */ `
varying vec4 vMat;
varying vec3 vObjPos;
uniform vec3 uPal0; uniform vec3 uPal1; uniform vec3 uPal2; uniform vec3 uPal3;
uniform vec3 uSkinA; uniform vec3 uSkinB; uniform vec3 uVein; uniform vec3 uGlow;
uniform vec4 uFlash; uniform float uTime; uniform float uCharge; uniform float uVeinGlow;
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 h33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float vn(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float s = 0.0; float a = 0.5; for (int i = 0; i < 3; i++){ s += a * vn(p); p = p * 2.07 + vec3(11.3, 7.1, 3.7); a *= 0.5; } return s * 1.1428; }
vec2 voro(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); float d1 = 8.0; float d2 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 g = vec3(float(x), float(y), float(z)); vec3 r = g + h33(i + g) - f; float d = dot(r, r);
    if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d1), sqrt(d2));
}
vec3 charBump(vec3 sp, vec3 N, float h, float fd){
  vec3 sx = dFdx(sp); vec3 sy = dFdy(sp);
  vec3 R1 = cross(sy, N); vec3 R2 = cross(N, sx);
  float det = dot(sx, R1) * fd;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 g = sign(det) * (dh.x * R1 + dh.y * R2);
  return normalize(abs(det) * N - g);
}
`;
const FRAG_PATTERN = /* glsl */ `
int mid = int(vMat.x + 0.5);
float fRough = vMat.y;
float fMetal = vMat.z;
float fEm = vMat.w;
vec3 P = vObjPos;
float fw = length(fwidth(P));
float fine = 1.0 - smoothstep(0.0006, 0.002, fw);
float med = 1.0 - smoothstep(0.002, 0.009, fw);
vec3 alb = diffuseColor.rgb;
vec3 emA = vec3(0.0);
float hgt = 0.0;
float weave = (sin(P.x * 1600.0 + 1.7 * sin(P.y * 1600.0)) + sin(P.y * 1600.0 + 1.7 * sin(P.z * 1600.0)) + sin(P.z * 1600.0 + 1.7 * sin(P.x * 1600.0))) * 0.00004 * fine;
float wrink = (fbm(P * vec3(20.0, 8.0, 20.0)) - 0.5) * 0.004 * med;
if (mid == 1) {
  vec3 q = P * vec3(12.0, 7.0, 12.0);
  q += 0.8 * vec3(vn(P * 26.0), vn(P * 26.0 + 5.2), vn(P * 26.0 + 9.7));
  float n1 = fbm(q);
  float n2 = fbm(q * 1.3 + 4.2);
  float n3 = vn(q * 2.2 + 7.0);
  vec3 c = uPal0;
  c = mix(c, uPal1, smoothstep(0.5, 0.52, n1));
  c = mix(c, uPal2, smoothstep(0.6, 0.62, n2) * 0.9);
  c = mix(c, uPal3, smoothstep(0.7, 0.72, n3) * 0.85);
  alb *= c * (0.93 + 0.14 * vn(P * 60.0));
  hgt = weave + wrink;
} else if (mid == 2) {
  vec3 qi = floor(P * 75.0);
  vec3 qc = qi / 75.0;
  float n1 = fbm(qc * 7.0) + (h13(qi) - 0.5) * 0.16;
  float n2 = fbm(qc * 9.5 + 3.1) + (h13(qi + 7.0) - 0.5) * 0.2;
  vec3 c = uPal0;
  c = mix(c, uPal1, step(0.5, n1));
  c = mix(c, uPal2, step(0.6, n2));
  c = mix(c, uPal3, step(0.68, n1) * step(n2, 0.44));
  alb *= c * (0.94 + 0.1 * vn(P * 60.0));
  hgt = weave + wrink;
} else if (mid == 3 || mid == 13 || mid == 15) {
  alb *= 0.88 + 0.22 * fbm(P * 18.0);
  hgt = weave + wrink;
  if (mid == 13) {
    float f = fract(P.y * 40.0);
    float band = smoothstep(0.08, 0.18, f) * (1.0 - smoothstep(0.6, 0.7, f));
    float slot = step(0.82, fract(P.x * 28.0 + P.z * 28.0));
    alb *= 1.0 - band * 0.16 - band * slot * 0.25;
    hgt += band * 0.0008 * med;
  }
  if (mid == 15) {
    alb *= 0.82 + 0.3 * vn(P * vec3(30.0, 400.0, 30.0));
    float dirt = smoothstep(0.55, 0.8, fbm(P * 9.0 + 3.0));
    alb = mix(alb, alb * vec3(0.55, 0.45, 0.35), dirt);
    float blood = smoothstep(0.7, 0.75, fbm(P * 6.0 + 17.0));
    alb = mix(alb, vec3(0.12, 0.02, 0.015), blood * 0.85);
  }
} else if (mid == 4) {
  float m = fbm(P * 25.0);
  alb *= (0.92 + 0.14 * m) * mix(vec3(1.0), vec3(1.07, 0.95, 0.92), fbm(P * 9.0 + 3.0));
  hgt = vn(P * 900.0) * 0.00008 * fine + (m - 0.5) * 0.0006 * med;
} else if (mid == 5) {
  float m = fbm(P * 8.0);
  float m2 = fbm(P * 26.0 + 2.0);
  vec3 c = mix(uSkinA, uSkinB, smoothstep(0.3, 0.8, m * 0.7 + m2 * 0.4));
  vec3 wq = P * vec3(30.0, 13.0, 30.0) + vec3(vn(P * 11.0), vn(P * 11.0 + 3.0), vn(P * 11.0 + 7.0)) * 1.8;
  float r1 = 1.0 - abs(vn(wq) * 2.0 - 1.0);
  float r2 = 1.0 - abs(vn(wq * 2.3 + 4.0) * 2.0 - 1.0);
  float vein = smoothstep(0.9, 0.99, r1) * (0.4 + 0.6 * smoothstep(0.7, 0.95, r2));
  vein = max(vein, smoothstep(0.94, 0.995, r2) * 0.5) * smoothstep(0.3, 0.6, fbm(P * 3.0 + 5.0));
  c = mix(c, uVein, vein * 0.6);
  float w = smoothstep(0.74, 0.78, fbm(P * 7.0 + 11.0));
  c = mix(c, vec3(0.16, 0.025, 0.02), w);
  alb *= c;
  fRough = mix(fRough, 0.28, w);
  hgt = ((m2 - 0.5) * 0.003 + vein * 0.0007 - w * 0.0025) * med + (vn(P * 500.0) - 0.5) * 0.0002 * fine;
  emA += uVein * vein * uVeinGlow;
} else if (mid == 6) {
  float br = vn(P * vec3(420.0, 8.0, 420.0));
  alb *= 0.9 + 0.16 * br;
  fRough = clamp(fRough + (br - 0.5) * 0.12 + (fbm(P * 30.0) - 0.5) * 0.15, 0.08, 1.0);
  hgt = (br - 0.5) * 0.00008 * fine;
} else if (mid == 7) {
  vec3 q = P * 6.5 + (fbm(P * 4.0) - 0.5) * 1.6;
  vec2 v = voro(q);
  float e = v.y - v.x;
  float crack = 1.0 - smoothstep(0.01, 0.045, e);
  float n = fbm(P * 18.0);
  alb *= mix(vec3(0.5), vec3(1.2), n);
  fRough = mix(0.22, 0.5, n) + crack * 0.2;
  hgt = (smoothstep(0.0, 0.25, e) * 0.004 - crack * 0.002 + (n - 0.5) * 0.001) * med;
  float pulse = 0.6 + 0.4 * sin(uTime * 3.1 + P.y * 9.0 + P.x * 4.0);
  float fl = 0.85 + 0.15 * sin(uTime * 37.0 + P.y * 40.0);
  float glow = crack * fEm * (pulse * fl + uCharge * 2.5);
  emA += uGlow * glow;
  alb = mix(alb, uGlow * 0.2, crack * 0.6);
} else if (mid == 8) {
  emA += alb * fEm * (0.9 + 0.1 * sin(uTime * 5.0) + uCharge * 0.8);
  alb *= 0.25;
} else if (mid == 9) {
  float s1 = vn(P * vec3(600.0, 25.0, 600.0));
  alb *= 0.7 + 0.45 * s1;
  hgt = s1 * 0.0003 * fine + wrink * 0.3;
} else if (mid == 10) {
  float k = abs(sin((P.x + P.z) * 650.0 + sin(P.y * 1300.0) * 0.6));
  alb *= 0.9 + 0.15 * k;
  hgt = k * 0.00012 * fine + wrink * 0.5;
} else if (mid == 11) {
  float n = fbm(P * 35.0);
  alb *= 0.72 + 0.35 * n;
  float cr = smoothstep(0.93, 0.99, 1.0 - abs(vn(P * 60.0) * 2.0 - 1.0));
  alb *= 1.0 - cr * 0.5;
  hgt = ((n - 0.5) * 0.001 - cr * 0.0004) * med;
} else if (mid == 12) {
  float st = sin(P.y * 420.0 + fbm(P * 30.0) * 6.0) * 0.5 + 0.5;
  alb *= mix(vec3(0.55, 0.35, 0.33), vec3(1.0), st * 0.6 + 0.4 * fbm(P * 20.0));
  fRough = mix(0.2, 0.45, st);
  hgt = st * 0.0004 * fine + (fbm(P * 20.0) - 0.5) * 0.002 * med;
} else if (mid == 14) {
  float n = fbm(P * 45.0);
  alb *= 0.85 + 0.25 * n;
  fRough = clamp(fRough + (n - 0.5) * 0.25, 0.2, 1.0);
  hgt = (vn(P * 300.0) - 0.5) * 0.0002 * fine + wrink * 0.4;
} else {
  alb *= 0.96 + 0.08 * vn(P * 45.0);
  hgt = (vn(P * 250.0) - 0.5) * 0.00005 * fine;
}
diffuseColor.rgb = alb;
`;

function patchVertex(src) {
  return src
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;\nvObjPos = position;');
}
function patchFragment(src) {
  return src
    .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
    .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_PATTERN)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(fRough, 0.04, 1.0);')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fMetal;')
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = charBump(-vViewPosition, normal, hgt, faceDirection);')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += emA + uFlash.rgb * uFlash.a;');
}

function makeCharMaterial(pal) {
  const u = {
    uPal0: { value: pal.camo[0] }, uPal1: { value: pal.camo[1] }, uPal2: { value: pal.camo[2] }, uPal3: { value: pal.camo[3] },
    uSkinA: { value: pal.skinA }, uSkinB: { value: pal.skinB }, uVein: { value: pal.vein }, uGlow: { value: pal.glow },
    uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTime: { value: 0 }, uCharge: { value: 0 }, uVeinGlow: { value: pal.veinGlow || 0 },
  };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = patchVertex(sh.vertexShader);
    sh.fragmentShader = patchFragment(sh.fragmentShader);
  };
  m.customProgramCacheKey = () => 'cfCharMat_v1';
  m.userData.u = u;
  m.name = 'charMat';
  return m;
}

// ------------------------------------------------------------------------------------------------
// Geometry helpers (build time only — allocations fine here)
// ------------------------------------------------------------------------------------------------
const _bv = new THREE.Vector3();
const _bv2 = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _be = new THREE.Euler();
const _bm = new THREE.Matrix4();
const _bs = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

function xf(g, p, r, s) {
  _be.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, (r && r[3]) || 'XYZ');
  _bq.setFromEuler(_be);
  _bm.compose(_bv.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0), _bq, _bs.set(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1));
  g.applyMatrix4(_bm);
  return g;
}
function rbox(w, h, d, r = 0.01, seg = 2) {
  const rr = Math.max(0.0005, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}
const ell = (rx, ry, rz, ws = 12, hs = 8) => new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz);
const cyl = (rt, rb, h, seg = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

function orientBetween(g, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  _bv.set(dx, dy, dz).normalize();
  _bq.setFromUnitVectors(UPV, _bv);
  _bm.compose(_bv2.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _bq, _bs.set(1, 1, 1));
  g.applyMatrix4(_bm);
  return g;
}
function capsAB(a, b, r, rad = 8, cap = 3) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return orientBetween(new THREE.CapsuleGeometry(r, Math.max(1e-4, len), cap, rad), a, b);
}
function coneAB(a, b, r, seg = 8) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return orientBetween(new THREE.ConeGeometry(r, Math.max(1e-4, len), seg), a, b);
}
function cylAB(a, b, r0, r1, seg = 8) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return orientBetween(new THREE.CylinderGeometry(r1, r0, Math.max(1e-4, len), seg, 1), a, b);
}
// tapered tube along a Catmull-Rom path
function tube(pts, r0, r1 = r0, tSeg = 12, rSeg = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed);
  const g = new THREE.TubeGeometry(curve, tSeg, r0, rSeg, closed);
  if (r1 !== r0) {
    const pos = g.attributes.position;
    const c = new THREE.Vector3();
    for (let i = 0; i <= tSeg; i++) {
      const t = i / tSeg;
      curve.getPointAt(t, c);
      const f = lerp(1, r1 / r0, t);
      for (let j = 0; j <= rSeg; j++) {
        const k = i * (rSeg + 1) + j;
        pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * f, c.y + (pos.getY(k) - c.y) * f, c.z + (pos.getZ(k) - c.z) * f);
      }
    }
    g.computeVertexNormals();
  }
  return g;
}
const cr = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
// Loft: rings [y, rx, rz, xc, zc, n(superellipse exponent)] sampled with Catmull-Rom.
// Rings with zero radius become poles. deform(v, t, theta, cos, sin, ringIndex) may edit v.
function loft(rings, o = {}) {
  const seg = o.seg || 16, sub = o.sub || 3;
  const R = rings.map((r) => [r[0], r[1], r[2], r[3] || 0, r[4] || 0, r[5] || 2]);
  const S = [];
  for (let i = 0; i < R.length - 1; i++) {
    const a = R[Math.max(0, i - 1)], b = R[i], c = R[i + 1], d = R[Math.min(R.length - 1, i + 2)];
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const row = new Array(6);
      for (let ch = 0; ch < 6; ch++) row[ch] = cr(a[ch], b[ch], c[ch], d[ch], t);
      if (k > 0) { row[1] = Math.max(row[1], 0.0); row[2] = Math.max(row[2], 0.0); }
      S.push(row);
    }
  }
  S.push(R[R.length - 1].slice());
  const nr = S.length;
  const pos = [];
  const start = [];
  for (let i = 0; i < nr; i++) {
    const [y, rx, rz, xc, zc, n] = S[i];
    if (Math.max(rx, rz) < 1e-5) {
      start.push(-(pos.length / 3) - 1);
      _bv.set(xc, y, zc);
      if (o.deform) o.deform(_bv, i / (nr - 1), 0, 1, 0, i);
      pos.push(_bv.x, _bv.y, _bv.z);
      continue;
    }
    start.push(pos.length / 3);
    const ex = 2 / Math.max(0.6, n);
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * TAU;
      const c = Math.cos(th), s = Math.sin(th);
      _bv.set(xc + rx * Math.sign(c) * Math.pow(Math.abs(c), ex), y, zc + rz * Math.sign(s) * Math.pow(Math.abs(s), ex));
      if (o.deform) o.deform(_bv, i / (nr - 1), th, c, s, i);
      pos.push(_bv.x, _bv.y, _bv.z);
    }
  }
  const up = S[nr - 1][0] > S[0][0];
  const idx = [];
  for (let i = 0; i < nr - 1; i++) {
    const A = start[i], B = start[i + 1];
    if (A < 0 && B < 0) continue;
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      if (A < 0) {
        const p = -A - 1, c = B + j, d = B + j1;
        if (up) idx.push(p, c, d); else idx.push(p, d, c);
      } else if (B < 0) {
        const q = -B - 1, a = A + j, b = A + j1;
        if (up) idx.push(a, q, b); else idx.push(a, b, q);
      } else {
        const a = A + j, b = A + j1, c = B + j, d = B + j1;
        if (up) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
    }
  }
  const cap = (ri, top) => {
    const st = start[ri];
    if (st < 0) return;
    const [y, , , xc, zc] = S[ri];
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < seg; j++) { cx += pos[(st + j) * 3]; cy += pos[(st + j) * 3 + 1]; cz += pos[(st + j) * 3 + 2]; }
    const ci = pos.length / 3;
    pos.push(cx / seg, cy / seg, cz / seg);
    void y; void xc; void zc;
    for (let j = 0; j < seg; j++) {
      const a = st + j, b = st + (j + 1) % seg;
      if (top) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  if (o.capEnd !== false) cap(nr - 1, up);
  if (o.capStart !== false) cap(0, !up);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// Loft oriented along -Z (for feet): rings given as [zForwardDistance, halfWidth, halfHeight, xc, yc, n]
function loftZ(rings, o = {}) {
  const g = loft(rings.map((r) => [r[0], r[1], r[2], r[3] || 0, r[4] || 0, r[5] || 2]), o);
  // loft y -> -z (forward), loft z -> +y (height)
  return xf(g, [0, 0, 0], [-PI / 2, 0, 0]);
}

// deterministic JS noise for build-time deforms
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf_ = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), xf_), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), xf_), yf),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), xf_), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), xf_), yf),
    zf,
  );
}
// "tear" deform: pushes shell vertices inside the body where noise is high => ragged holes.
function tearDeform(freqA, freqY, thresh, depth, seed = 0, extra) {
  return (v, t, th, c, s, i) => {
    const n = noise3(Math.cos(th) * freqA + seed, v.y * freqY, Math.sin(th) * freqA + seed * 2);
    const k = sstep(thresh, thresh + 0.06, n) * depth;
    if (k > 0) { v.x *= 1 - k; v.z *= 1 - k; }
    if (extra) extra(v, t, th, c, s, i);
  };
}

function toColor(c) { return c && c.isColor ? c : new THREE.Color(c); }

function prepGeo(geo, color, mat) {
  const g = geo;
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  g.morphAttributes = {};
  const n = g.attributes.position.count;
  const c = toColor(color);
  const col = new Float32Array(n * 3), am = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    am[i * 4] = mat[0]; am[i * 4 + 1] = mat[1]; am[i * 4 + 2] = mat[2]; am[i * 4 + 3] = mat[3];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(am, 4));
  return g;
}

class Builder {
  constructor() { this.parts = {}; }
  add(bone, geo, color, mat) {
    (this.parts[bone] || (this.parts[bone] = [])).push(prepGeo(geo, color, mat));
    return this;
  }
  build() {
    const out = {};
    for (const k in this.parts) {
      const list = this.parts[k];
      const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!g) throw new Error('characterModel: merge failed for bone ' + k);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      out[k] = g;
      if (list.length > 1) for (const p of list) p.dispose();
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// Palettes
// ------------------------------------------------------------------------------------------------
const C = (hex) => new THREE.Color(hex);
const DEFAULT_PAL = {
  camo: [C(0x888888), C(0x666666), C(0x444444), C(0xaaaaaa)],
  skinA: C(0x7d8a72), skinB: C(0x4a4f3a), vein: C(0x3b2a3a), glow: C(0x40fff0), veinGlow: 0,
};
const HUMAN_SKINS = [
  { name: 'desert', camo: [0xc2ab84, 0xa48a62, 0x7d6546, 0xd6c6a2], cloth: PAT.CAMO, shirt: 0xffffff, pants: 0xf2efe8,
    vest: 0x7b6647, gear: 0x655339, web: 0x4b3e2b, boots: 0x8c7352, sole: 0x2b2621, gloves: 0x6d5b41, pad: 0x3b3128,
    skin: 0xb88a6c, hair: 0x2b1e15, lip: 0x9a6452 },
  { name: 'swat', camo: [0x1c1d20, 0x151618, 0x232428, 0x2b2c30], cloth: PAT.FABRIC, shirt: 0x1f2024, pants: 0x1c1d20,
    vest: 0x141518, gear: 0x1b1c1f, web: 0x0f0f11, boots: 0x161616, sole: 0x0b0b0b, gloves: 0x141414, pad: 0x0a0a0a,
    skin: 0xb07a58, hair: 0x1a1512, lip: 0x8a5040 },
  { name: 'urban', camo: [0x8f9397, 0x6b6f74, 0x4a4e53, 0xb3b5b7], cloth: PAT.DIGI, shirt: 0xffffff, pants: 0xf4f4f4,
    vest: 0x4e5155, gear: 0x404347, web: 0x2f3134, boots: 0x1d1d1d, sole: 0x0e0e0e, gloves: 0x232323, pad: 0x151515,
    skin: 0xc99b82, hair: 0x2a1d14, lip: 0xa66e62 },
  { name: 'fox', camo: [0x1b1b20, 0x151518, 0x222226, 0x2a2a2e], cloth: PAT.FABRIC, shirt: 0x1d1d22, pants: 0x19191d,
    vest: 0x2a2b30, gear: 0x202125, web: 0x121214, boots: 0x161616, sole: 0x0b0b0b, gloves: 0x121212, pad: 0x0a0a0a,
    skin: 0xe0b59c, hair: 0x1f1512, lip: 0xa85a58 },
];
const ZOMBIE_PALS = {
  1: { skinA: C(0x86917a), skinB: C(0x4d523d), vein: C(0x3d2638), glow: C(0xd6ff5a), veinGlow: 0, eye: 0xb0ff28, pants: 0x4b5566, shirt: 0x7a705c },
  2: { skinA: C(0x707a66), skinB: C(0x3a3e2d), vein: C(0x46202c), glow: C(0xe0ff50), veinGlow: 0, eye: 0xc8ff20, pants: 0x5a5444, shirt: 0x5e5648 },
  3: { skinA: C(0x5c6453), skinB: C(0x2a2d22), vein: C(0x6a2010), glow: C(0xffd040), veinGlow: 0.3, eye: 0xffa010, pants: 0x3c3c42, shirt: 0x4a4238 },
  mother: { skinA: C(0x8a8481), skinB: C(0x4a3c3e), vein: C(0x7a0a0a), glow: C(0xff2a18), veinGlow: 0.12, eye: 0xff1a08, pants: 0x3a3434, shirt: 0x4a3c36 },
};

// ------------------------------------------------------------------------------------------------
// Rigs (joint layout). Coordinates in meters, bone-local offsets from parent.
// ------------------------------------------------------------------------------------------------
function humanRig(fem = false, s = 1) {
  return {
    scale: s,
    hipsY: 0.965 * s, hip: [0.092 * s, -0.05 * s, 0], thighLen: 0.44 * s, shinLen: 0.435 * s, ankleH: 0.085 * s,
    spine: [0, 0.1 * s, 0], chest: [0, 0.17 * s, 0], neck: [0, 0.255 * s, 0.0], head: [0, 0.09 * s, 0.005 * s],
    shoulder: [(fem ? 0.168 : 0.185) * s, 0.2 * s, 0.0], upperLen: 0.29 * s, foreLen: 0.265 * s,
    headCenter: [0, 0.085 * s, -0.005 * s], headRadius: 0.125 * s,
    footX: 0.105 * s, footZ: 0.04 * s, crouchDrop: 0.37 * s, liftWalk: 0.09 * s, liftRun: 0.19 * s,
    aimPivot: [0, 0.2 * s, 0], palm: [-0.03 * (fem ? 0.92 : 1) * s, -0.098 * (fem ? 0.92 : 1) * s, 0],
    walkSpeed: 2.2, runSpeed: 5.0, bodyThick: 0.13 * s, strideK: 1, bobK: 1, hunch: 0,
  };
}

// ------------------------------------------------------------------------------------------------
// Shared part builders
// ------------------------------------------------------------------------------------------------
// Hand in rest pose: wrist at origin, fingers toward -Y, palm faces -X*sd (toward body), thumb toward -Z.
function buildHand(B, bone, sd, o) {
  const k = o.k || 1;
  const col = o.color, mat = o.mat || M(PAT.LEATHER, 0.7);
  const fcol = o.fingerColor !== undefined ? o.fingerColor : col, fmat = o.fingerMat || mat;
  const pl = 0.085 * k * (o.palmL || 1), pw = 0.08 * k * (o.palmW || 1), pt = 0.032 * k * (o.palmT || 1);
  B.add(bone, xf(rbox(pt, pl, pw, 0.012 * k), [0.002 * sd * k, -pl * 0.52, 0]), col, mat);
  if (o.pad) B.add(bone, xf(rbox(0.012 * k, 0.034 * k, 0.066 * k, 0.005 * k), [0.017 * sd * k, -0.074 * k, 0], [0, 0, 0.12 * sd]), o.pad, M(PAT.PLAIN, 0.45));
  const lens = o.lens || [[0.042, 0.027, 0.022], [0.046, 0.03, 0.024], [0.044, 0.028, 0.023], [0.034, 0.022, 0.019]];
  const curl = o.curl || [0.3, 1.1, 0.85];
  const fr = 0.0095 * k * (o.fingerR || 1);
  const spread = o.spread || 0;
  for (let i = 0; i < 4; i++) {
    let x = 0.002 * sd * k, y = -pl * 1.0, z = (i - 1.5) * pw * 0.245;
    let ang = curl[0];
    let dzs = (i - 1.5) * spread;
    for (let s = 0; s < 3; s++) {
      const L = lens[i][s] * k;
      const nx = x - Math.sin(ang) * sd * L, ny = y - Math.cos(ang) * L * Math.cos(dzs), nz = z + Math.sin(dzs) * L;
      const r = fr * (1 - s * 0.1) * (i === 3 ? 0.88 : 1);
      B.add(bone, capsAB([x, y, z], [nx, ny, nz], r, 6, 2), s === 2 && o.tipColor !== undefined ? o.tipColor : fcol, fmat);
      if (s === 2 && o.claw) {
        const cl = o.claw * k;
        const tx = nx - Math.sin(ang + 0.35) * sd * cl, ty = ny - Math.cos(ang + 0.35) * cl, tz = nz + Math.sin(dzs) * cl;
        B.add(bone, coneAB([nx, ny, nz], [tx, ty, tz], r * 0.95, 6), o.clawColor, M(PAT.BONE, 0.45));
      }
      x = nx; y = ny; z = nz; ang += curl[s + 1] !== undefined ? curl[s + 1] : curl[curl.length - 1];
      dzs *= 0.7;
    }
  }
  // thumb
  const tb = [-0.008 * sd * k, -0.028 * k, -pw * 0.42];
  const t1 = [tb[0] - 0.018 * sd * k, tb[1] - 0.02 * k, tb[2] - 0.024 * k];
  const tcurl = o.thumbCurl !== undefined ? o.thumbCurl : 1;
  const t2 = [t1[0] - 0.02 * sd * k * tcurl, t1[1] - 0.022 * k, t1[2] - 0.012 * k * (2 - tcurl)];
  const t3 = [t2[0] - 0.014 * sd * k * tcurl, t2[1] - 0.016 * k, t2[2] + 0.002 * k];
  B.add(bone, capsAB(tb, t1, fr * 1.25, 6, 2), col, mat);
  B.add(bone, capsAB(t1, t2, fr * 1.1, 6, 2), fcol, fmat);
  B.add(bone, capsAB(t2, t3, fr * 1.0, 6, 2), o.tipColor !== undefined ? o.tipColor : fcol, fmat);
  if (o.claw) B.add(bone, coneAB(t3, [t3[0] - 0.012 * sd * k, t3[1] - o.claw * k * 0.8, t3[2] - 0.004], fr, 6), o.clawColor, M(PAT.BONE, 0.45));
}

function buildBoot(B, bone, o) {
  const k = o.k || 1, ah = o.ankleH;
  const upper = loftZ([
    [-0.078 * k, 0.0, 0.0, 0, -ah * 0.42],
    [-0.072 * k, 0.03 * k, 0.034 * k, 0, -ah * 0.42],
    [-0.048 * k, 0.043 * k, 0.05 * k, 0, -ah * 0.36],
    [0.0, 0.047 * k, 0.058 * k, 0, -ah * 0.27],
    [0.07 * k, 0.048 * k, 0.043 * k, 0, -ah * 0.46],
    [0.14 * k, 0.05 * k, 0.031 * k, 0, -ah * 0.62],
    [0.19 * k, 0.045 * k, 0.027 * k, 0, -ah * 0.66],
    [0.215 * k, 0.03 * k, 0.021 * k, 0, -ah * 0.7],
    [0.226 * k, 0.0, 0.0, 0, -ah * 0.72],
  ], { seg: 14, sub: 2 });
  B.add(bone, upper, o.color, o.mat || M(PAT.LEATHER, 0.65));
  const sy = -ah + 0.013 * k;
  const sole = loftZ([
    [-0.084 * k, 0.0, 0.0, 0, sy],
    [-0.078 * k, 0.034 * k, 0.013 * k, 0, sy, 3],
    [0.0, 0.048 * k, 0.013 * k, 0, sy, 3],
    [0.14 * k, 0.054 * k, 0.013 * k, 0, sy, 3],
    [0.215 * k, 0.037 * k, 0.013 * k, 0, sy, 3],
    [0.232 * k, 0.0, 0.0, 0, sy],
  ], { seg: 14, sub: 2 });
  B.add(bone, sole, o.sole, M(PAT.PLAIN, 0.85));
  if (o.laces) {
    for (let i = 0; i < 4; i++) {
      const z = -0.01 * k - i * 0.028 * k, y = -ah * 0.27 + 0.05 * k - i * 0.012 * k;
      B.add(bone, xf(rbox(0.05 * k, 0.006 * k, 0.008 * k, 0.002), [0, y + 0.004, z - 0.004], [0.5, 0, 0]), o.laces, M(PAT.FABRIC, 0.9));
    }
  }
}

function buildNose(len, depth, width) {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  sh.lineTo(depth * 0.35, len * 0.1);
  sh.lineTo(depth, len * 0.78);
  sh.lineTo(depth * 0.8, len * 0.95);
  sh.lineTo(depth * 0.2, len);
  sh.lineTo(0, len);
  const g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: true, bevelThickness: width * 0.25, bevelSize: width * 0.22, bevelSegments: 2, curveSegments: 2 });
  // shape X (forward) -> -Z, extrusion Z -> X
  xf(g, [0, 0, 0], [0, PI / 2, 0]);
  return xf(g, [-width / 2, 0, 0]);
}

function buildHumanHead(B, o) {
  const s = o.s || 1, fem = !!o.fem;
  const jawK = fem ? 0.88 : 1;
  const rings = [
    [-0.03, 0.0, 0.0, 0, -0.054],
    [-0.026, 0.024 * jawK, 0.018, 0, -0.056],
    [-0.014, 0.047 * jawK, 0.038, 0, -0.043],
    [0.01, 0.062 * jawK, 0.068, 0, -0.02],
    [0.045, 0.069 * (fem ? 0.95 : 1), 0.09, 0, -0.004],
    [0.085, 0.075, 0.1, 0, 0.004],
    [0.12, 0.078, 0.102, 0, 0.008],
    [0.155, 0.072, 0.094, 0, 0.012],
    [0.18, 0.056, 0.074, 0, 0.014],
    [0.196, 0.028, 0.038, 0, 0.014],
    [0.2, 0.0, 0.0, 0, 0.014],
  ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]);
  const deform = (v) => {
    const fz = -0.058 * s;
    if (v.z < fz) v.z = fz + (v.z - fz) * 0.86;
    for (const ex of [-0.033 * s, 0.033 * s]) {
      const d2 = ((v.x - ex) ** 2 + ((v.y - 0.086 * s) * 1.3) ** 2) / (0.016 * s) ** 2;
      if (v.z < -0.05 * s) v.z += 0.007 * s * Math.exp(-d2);
    }
    // brow ridge & cheekbones
    if (v.z < -0.06 * s) v.z -= 0.004 * s * Math.exp(-(((v.y - 0.104 * s) / (0.01 * s)) ** 2));
    if (o.deform) o.deform(v);
  };
  B.add('head', loft(rings, { seg: 22, sub: 3, deform }), o.skin, M(PAT.SKIN, 0.55));
  if (o.nose !== false) {
    const nk = fem ? 0.82 : 1;
    const nose = loft([
      [0.1, 0.0, 0.0, 0, -0.085], [0.095, 0.006, 0.005, 0, -0.088], [0.075, 0.0075, 0.008, 0, -0.093], [0.055, 0.009, 0.011, 0, -0.099],
      [0.04, 0.013, 0.013, 0, -0.103], [0.03, 0.015, 0.01, 0, -0.1], [0.024, 0.011, 0.006, 0, -0.095], [0.022, 0.0, 0.0, 0, -0.092],
    ].map((r) => [r[0] * s, r[1] * s * nk, r[2] * s * nk, 0, (-0.085 + (r[4] + 0.085) * nk) * s]), { seg: 10, sub: 2 });
    B.add('head', nose, o.skin, M(PAT.SKIN, 0.5));
  }
  for (const sd of [-1, 1]) {
    B.add('head', xf(ell(0.011, 0.029, 0.018, 8, 6), [sd * 0.076 * s, 0.078 * s, 0.012 * s], [0, -sd * 0.3, sd * 0.1], [s, s, s]), o.skin, M(PAT.SKIN, 0.55));
    if (o.eyes !== false) {
      const ek = fem ? 1.08 : 1;
      B.add('head', xf(new THREE.SphereGeometry(0.0108 * s * ek, 10, 8), [sd * 0.033 * s, 0.086 * s, -0.079 * s]), 0xcfc6bb, M(PAT.PLAIN, 0.2));
      B.add('head', xf(new THREE.SphereGeometry(0.0066 * s * ek, 8, 6), [sd * 0.033 * s, 0.086 * s, -0.0876 * s]), o.iris || 0x2b1b10, M(PAT.PLAIN, 0.12));
      // lids (upper covers top of the eyeball, lower a sliver)
      B.add('head', xf(ell(0.0135 * ek, 0.0075, 0.0105, 10, 6), [sd * 0.033 * s, 0.0925 * s, -0.081 * s], [0.25, 0, 0], [s, s, s]), fem ? 0x3a2622 : o.skin, M(PAT.SKIN, 0.5));
      B.add('head', xf(ell(0.012, 0.004, 0.009, 10, 6), [sd * 0.033 * s, 0.0795 * s, -0.08 * s], [-0.2, 0, 0], [s, s, s]), o.skin, M(PAT.SKIN, 0.55));
      B.add('head', xf(rbox(0.028 * s, (fem ? 0.0045 : 0.006) * s, 0.01 * s, 0.002 * s), [sd * 0.034 * s, 0.104 * s, -0.089 * s], [0.15, 0, -sd * (fem ? 0.16 : 0.07)]), o.brow || o.hair || 0x2a1d14, M(PAT.HAIR, 0.7));
    }
  }
  if (o.lips !== false) {
    const lk = fem ? 1.02 : 1;
    B.add('head', xf(ell(0.02 * lk, 0.0048 * lk, 0.009, 10, 6), [0, 0.02 * s, -0.083 * s], [0, 0, 0], [s, s, s]), o.lip || o.skin, M(PAT.SKIN, 0.35));
    B.add('head', xf(ell(0.018 * lk, 0.0055 * lk, 0.009, 10, 6), [0, 0.012 * s, -0.081 * s], [0, 0, 0], [s, s, s]), o.lip || o.skin, M(PAT.SKIN, 0.35));
  }
}

// Human torso rings (chest-local)
function torsoRings(s, fem) {
  const kx = fem ? 0.9 : 1;
  return [
    [-0.06, 0.150 * (fem ? 0.84 : 1), 0.100, 0, 0.0, 2.2],
    [0.03, 0.158 * (fem ? 0.86 : 1), 0.104, 0, -0.004, 2.3],
    [0.11, 0.172 * kx, fem ? 0.114 : 0.108, 0, fem ? -0.014 : -0.008, 2.4],
    [0.18, 0.180 * kx, 0.104, 0, -0.004, 2.5],
    [0.225, 0.160 * kx, 0.092, 0, 0.004, 2.3],
    [0.255, 0.105 * kx, 0.075, 0, 0.008, 2.1],
    [0.28, 0.058, 0.055, 0, 0.012, 2],
    [0.30, 0.052, 0.050, 0, 0.012, 2],
  ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5]]);
}
function scaleRings(rings, s, add = 0) { return rings.map((r) => [r[0] * s, r[1] * s + add, r[2] * s + add, (r[3] || 0) * s, (r[4] || 0) * s, r[5] || 2]); }

// Arms & legs for human-like bodies
function buildHumanLimbs(B, o) {
  const s = o.s, fem = o.fem;
  const kl = fem ? 0.88 : 1;
  for (const sd of [-1, 1]) {
    const L = sd < 0 ? 'L' : 'R';
    // upper arm (sleeve)
    const ua = [
      [0.07, 0.0, 0.0], [0.058, 0.036, 0.042], [0.028, 0.055, 0.06, -0.004, -0.004], [-0.04, 0.056, 0.059],
      [-0.12, 0.052, 0.055, 0, -0.004], [-0.21, 0.046, 0.048], [-0.28, 0.044, 0.045], [-0.315, 0.0, 0.0],
    ].map((r) => [r[0] * s, r[1] * s * kl, r[2] * s * kl, 0, (r[4] || 0) * s]);
    B.add('upperArm' + L, loft(ua, { seg: 14 }), o.shirt, o.shirtMat);
    if (o.patch && sd < 0) B.add('upperArm' + L, xf(rbox(0.008, 0.045, 0.06, 0.003), [sd * 0.057 * s * kl, -0.07 * s, 0], [0, 0, sd * 0.06]), o.patch, M(PAT.FABRIC, 0.8));
    // forearm
    const fa = [[0.035, 0.0, 0.0], [0.02, 0.04, 0.042], [-0.04, 0.047, 0.045], [-0.12, 0.042, 0.038], [-0.2, 0.036, 0.032], [-0.225, 0.0, 0.0]]
      .map((r) => [r[0] * s, r[1] * s * kl, r[2] * s * kl]);
    B.add('foreArm' + L, loft(fa, { seg: 12 }), o.shirt, o.shirtMat);
    B.add('foreArm' + L, loft([[-0.165, 0.04, 0.036], [-0.2, 0.039, 0.034], [-0.262, 0.033, 0.029]].map((r) => [r[0] * s, r[1] * s * kl, r[2] * s * kl]), { seg: 12 }), o.cuff !== undefined ? o.cuff : o.gloves, M(PAT.LEATHER, 0.7));
    if (o.elbowPad) B.add('foreArm' + L, xf(rbox(0.06, 0.07, 0.03, 0.012), [0, -0.005 * s, 0.035 * s * kl], [-0.15, 0, 0], [s * kl, s, s]), o.elbowPad, M(PAT.PLAIN, 0.5));
    buildHand(B, 'hand' + L, sd, { k: s * (fem ? 0.9 : 1), color: o.gloves, fingerColor: o.fingerColor, tipColor: o.tipColor, pad: o.pad, mat: M(PAT.LEATHER, 0.7), fingerMat: o.fingerMat });
    // thigh
    const th = [
      [0.085, 0.0, 0.0], [0.065, 0.07, 0.075], [0.0, 0.092, 0.096, 0.004 * sd, 0.004], [-0.12, 0.087, 0.09],
      [-0.27, 0.074, 0.077], [-0.39, 0.063, 0.066], [-0.44, 0.058, 0.061], [-0.47, 0.0, 0.0],
    ].map((r) => [r[0] * s, r[1] * s * (fem ? 0.95 : 1), r[2] * s * (fem ? 0.95 : 1), (r[3] || 0) * s, (r[4] || 0) * s]);
    B.add('thigh' + L, loft(th, { seg: 16 }), o.pants, o.pantsMat);
    if (o.cargo !== false) B.add('thigh' + L, xf(rbox(0.03, 0.12, 0.1, 0.012), [sd * 0.082 * s, -0.2 * s, 0.0], [0, 0, sd * 0.06], [s, s, s]), o.pants, o.pantsMat);
    if (sd > 0 && o.holster !== false) {
      B.add('thighR', xf(rbox(0.026, 0.16, 0.085, 0.01), [0.092 * s, -0.17 * s, -0.004 * s], [0, 0, 0.05], [s, s, s]), o.web, M(PAT.FABRIC, 0.8));
      B.add('thighR', xf(rbox(0.036, 0.13, 0.05, 0.012), [0.108 * s, -0.16 * s, -0.012 * s], [0, 0, 0.05], [s, s, s]), o.gear, M(PAT.PLAIN, 0.55));
      B.add('thighR', xf(rbox(0.028, 0.07, 0.034, 0.008), [0.106 * s, -0.06 * s, 0.012 * s], [0.35, 0, 0.05], [s, s, s]), 0x1a1a1a, M(PAT.PLAIN, 0.5));
      for (const y of [-0.12, -0.25]) B.add('thighR', loft([[y - 0.012, 0.0905, 0.093], [y + 0.012, 0.089, 0.092]].map((r) => [r[0] * s, r[1] * s * (1 + (y + 0.12) * 0.55), r[2] * s * (1 + (y + 0.12) * 0.55)]), { seg: 16 }), o.web, M(PAT.FABRIC, 0.85));
    }
    // shin
    const sh = [[0.04, 0.0, 0.0], [0.02, 0.055, 0.058], [-0.08, 0.057, 0.062, 0, 0.008], [-0.2, 0.05, 0.054, 0, 0.004], [-0.29, 0.052, 0.056], [-0.33, 0.0, 0.0]]
      .map((r) => [r[0] * s, r[1] * s * (fem ? 0.93 : 1), r[2] * s * (fem ? 0.93 : 1), 0, (r[4] || 0) * s]);
    B.add('shin' + L, loft(sh, { seg: 14 }), o.pants, o.pantsMat);
    if (o.kneePad) {
      B.add('shin' + L, xf(rbox(0.085, 0.1, 0.035, 0.016), [0, -0.025 * s, -0.056 * s], [0.1, 0, 0], [s, s, s]), o.kneePad, M(PAT.PLAIN, 0.45));
      B.add('shin' + L, loft([[-0.06, 0.061, 0.064], [-0.045, 0.061, 0.064]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 14 }), o.web, M(PAT.FABRIC, 0.85));
    }
    B.add('shin' + L, loft([[-0.255, 0.05, 0.053], [-0.3, 0.049, 0.052], [-0.39, 0.046, 0.05], [-0.44, 0.048, 0.056]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 14 }), o.boots, M(PAT.LEATHER, 0.65));
    buildBoot(B, 'foot' + L, { k: s * (fem ? 0.94 : 1), ankleH: o.ankleH, color: o.boots, sole: o.sole, laces: o.laces });
  }
}

// ------------------------------------------------------------------------------------------------
// HUMAN
// ------------------------------------------------------------------------------------------------
function buildHuman(skin) {
  const P = HUMAN_SKINS[skin] || HUMAN_SKINS[0];
  const fem = skin === 3;
  const s = fem ? 0.97 : 1;
  const rig = humanRig(fem, s);
  const B = new Builder();
  const shirtMat = M(P.cloth, 0.85), pantsMat = M(P.cloth, 0.88);
  const vestMat = M(PAT.MOLLE, 0.8), gearMat = M(PAT.MOLLE, 0.82), webMat = M(PAT.FABRIC, 0.85);
  const cam = P.cloth !== PAT.FABRIC; // camo cloth tints are white multipliers

  // ---- hips: pelvis, belt, pouches
  const pk = fem ? 1.04 : 1;
  B.add('hips', loft([
    [0.12, 0.13, 0.095, 0, 0.0, 2.2], [0.07, 0.15 * pk, 0.105, 0, 0.004, 2.3], [0.0, 0.162 * pk, 0.112, 0, 0.012, 2.3],
    [-0.07, 0.158 * pk, 0.11, 0, 0.014, 2.2], [-0.12, 0.12, 0.09, 0, 0.006, 2], [-0.15, 0.06, 0.06, 0, 0, 2], [-0.16, 0.0, 0.0],
  ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s, r[5] || 2]), { seg: 18 }), P.pants, pantsMat);
  B.add('hips', loft([[0.035, 0.166 * pk, 0.117, 0, 0.005, 2.4], [0.078, 0.162 * pk, 0.114, 0, 0.004, 2.4]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5]]), { seg: 22 }), P.web, webMat);
  B.add('hips', xf(rbox(0.05, 0.036, 0.012, 0.004), [0, 0.056 * s, -0.121 * s]), 0x3a3a3a, M(PAT.METAL, 0.45, 0.7));
  B.add('hips', xf(rbox(0.062, 0.075, 0.045, 0.01), [0.155 * s, 0.03 * s, -0.035 * s], [0, 0.55, 0]), P.gear, gearMat);
  B.add('hips', xf(rbox(0.075, 0.095, 0.052, 0.014), [-0.162 * s, 0.015 * s, 0.03 * s], [0, -0.45, 0]), P.gear, gearMat);
  B.add('hips', xf(rbox(0.11, 0.06, 0.04, 0.01), [0, 0.045 * s, 0.128 * s]), P.gear, gearMat);

  // ---- spine: abdomen + cummerbund
  B.add('spine', loft([[-0.06, 0.152, 0.105], [0.02, 0.148, 0.1, 0, -0.004], [0.1, 0.152, 0.102, 0, -0.006], [0.2, 0.16, 0.106, 0, -0.006]]
    .map((r) => [r[0] * s, r[1] * s * (fem ? 0.84 : 1), r[2] * s, 0, (r[4] || 0) * s]), { seg: 18 }), P.shirt, shirtMat);
  B.add('spine', loft([[0.03, 0.163, 0.116, 0, -0.004, 3], [0.17, 0.173, 0.121, 0, -0.008, 3.2]]
    .map((r) => [r[0] * s, r[1] * s * (fem ? 0.86 : 1), r[2] * s, 0, r[4] * s, r[5]]), { seg: 20 }), P.vest, vestMat);

  // ---- chest: shirt torso, vest, plates, pouches
  B.add('chest', loft(torsoRings(s, fem), { seg: 20 }), P.shirt, shirtMat);
  const vk = fem ? 0.9 : 1;
  B.add('chest', loft([
    [-0.07, 0.166 * (fem ? 0.87 : 1), 0.118, 0, -0.002, 3.2], [0.02, 0.172 * (fem ? 0.9 : 1), 0.121, 0, -0.006, 3.3], [0.12, 0.186 * vk, fem ? 0.126 : 0.124, 0, fem ? -0.014 : -0.01, 3.4],
    [0.19, 0.19 * vk, 0.118, 0, -0.006, 3.2], [0.235, 0.17 * vk, 0.106, 0, 0.0, 3.0],
  ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5]]), {
    seg: 22,
    deform: (v, t, th, c) => { if (t > 0.5) v.y -= 0.1 * s * Math.pow(Math.abs(c), 4) * sstep(0.5, 1, t); },
  }), P.vest, vestMat);
  if (!fem) {
    B.add('chest', xf(rbox(0.26, 0.27, 0.03, 0.012), [0, 0.1 * s, -0.13 * s], [-0.04, 0, 0], [s, s, s]), P.vest, vestMat);
    B.add('chest', xf(rbox(0.27, 0.29, 0.03, 0.012), [0, 0.1 * s, 0.123 * s], [0.03, 0, 0], [s, s, s]), P.vest, vestMat);
  }
  for (const sd of [-1, 1]) {
    B.add('chest', xf(rbox(0.056, 0.018, 0.235, 0.007), [sd * 0.102 * s * vk, 0.262 * s, 0.0], [0, 0, -sd * 0.28], [s, s, s]), P.vest, vestMat);
  }
  // magazine pouches
  const pz = (fem ? -0.155 : -0.162) * s;
  for (let i = -1; i <= 1; i++) {
    B.add('chest', xf(rbox(0.066, 0.092, 0.04, 0.008), [i * 0.073 * s, 0.015 * s, pz], [-0.04, 0, 0], [s, s, s]), P.gear, gearMat);
    if (i !== 0) B.add('chest', xf(rbox(0.07, 0.024, 0.046, 0.007), [i * 0.073 * s, 0.063 * s, pz], [-0.04, 0, 0], [s, s, s]), P.gear, gearMat);
    else B.add('chest', xf(rbox(0.028, 0.06, 0.018, 0.004), [0, 0.07 * s, pz + 0.003], [-0.1, 0, 0], [s, s, s]), 0x1d1d1d, M(PAT.PLAIN, 0.45));
  }
  B.add('chest', xf(rbox(0.12, 0.058, 0.026, 0.009), [0, 0.15 * s, pz + 0.018 * s], [-0.08, 0, 0], [s * vk, s, s]), P.gear, gearMat);
  // radio + antenna, hydration pack, side pouch
  B.add('chest', xf(rbox(0.058, 0.12, 0.05, 0.012), [-0.15 * s * vk, 0.075 * s, 0.1 * s], [0, 0.4, 0], [s, s, s]), P.gear, gearMat);
  B.add('chest', cylAB([-0.165 * s * vk, 0.13 * s, 0.11 * s], [-0.175 * s * vk, 0.43 * s, 0.13 * s], 0.0035, 0.002, 5), 0x1a1a1a, M(PAT.PLAIN, 0.5));
  B.add('chest', xf(rbox(0.2, 0.27, 0.06, 0.025), [0, 0.085 * s, 0.16 * s], [0.04, 0, 0], [s * vk, s, s]), P.gear, gearMat);
  B.add('chest', xf(rbox(0.05, 0.07, 0.048, 0.01), [0.172 * s * vk, 0.01 * s, -0.045 * s], [0, -0.5, 0], [s, s, s]), P.gear, gearMat);
  // collar
  B.add('chest', loft([[0.255, 0.075, 0.07, 0, 0.01], [0.3, 0.066, 0.062, 0, 0.012]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]), { seg: 16 }), P.shirt, shirtMat);

  // ---- neck
  B.add('neck', loft([[-0.03, 0.058, 0.06], [0.04, 0.05, 0.053], [0.1, 0.05, 0.054], [0.13, 0.0, 0.0]].map((r) => [r[0] * s, r[1] * s * (fem ? 0.88 : 1), r[2] * s * (fem ? 0.88 : 1)]), { seg: 14 }), P.skin, M(PAT.SKIN, 0.55));

  // ---- head & headgear
  if (skin === 0) {
    buildHumanHead(B, { s, skin: P.skin, hair: P.hair, lip: P.lip });
    helmet(B, s, { camo: true, color: 0xffffff, mat: M(PAT.CAMO, 0.8), rail: 0x3b3326, strap: P.web });
    // goggles over the eyes
    B.add('head', loft([[0.074, 0.106, 0.128, 0, 0.008], [0.092, 0.106, 0.128, 0, 0.008]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]), {
      seg: 24, deform: (v, t, th, c, sn) => { v.y += (0.028 * sstep(-1, 0.1, sn) + 0.02 * sstep(0, 1, sn)) * s; },
    }), 0x2e3326, M(PAT.FABRIC, 0.8));
    const fr = xf(new THREE.CylinderGeometry(0.108, 0.108, 0.048, 18, 1, true, PI - 1.12, 2.24), [0, 0.086 * s, 0.0], [0, 0, 0], [s, s, s * 1.02]);
    B.add('head', fr, 0x1b1c1a, M(PAT.PLAIN, 0.6));
    const lens = xf(new THREE.CylinderGeometry(0.111, 0.111, 0.036, 18, 1, true, PI - 1.02, 2.04), [0, 0.087 * s, 0.0], [0, 0, 0], [s, s, s * 1.02]);
    B.add('head', lens, 0xb07a20, M(PAT.PLAIN, 0.05, 0.9));
    // shemagh around the neck
    B.add('neck', loft([[-0.03, 0.085, 0.088], [0.01, 0.082, 0.085], [0.04, 0.068, 0.071], [0.055, 0.058, 0.061]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), {
      seg: 18, deform: (v, t, th) => { const k = 1 + 0.07 * Math.sin(th * 5 + v.y * 60) * (1 - t * 0.5); v.x *= k; v.z *= k; },
    }), 0xa08a66, M(PAT.FABRIC, 0.9));
  } else if (skin === 1) {
    // balaclava: head shell with an eye slit
    buildHumanHead(B, { s, skin: P.skin, hair: P.hair, lip: P.lip, nose: false, lips: false });
    const bal = [
      [-0.036, 0.0, 0.0, 0, -0.056], [-0.03, 0.03, 0.024, 0, -0.058], [-0.012, 0.049, 0.044, 0, -0.043], [0.012, 0.062, 0.074, 0, -0.018],
      [0.045, 0.072, 0.094, 0, -0.004], [0.085, 0.079, 0.104, 0, 0.004], [0.12, 0.082, 0.106, 0, 0.008], [0.155, 0.076, 0.098, 0, 0.012],
      [0.18, 0.06, 0.078, 0, 0.014], [0.2, 0.03, 0.04, 0, 0.014], [0.205, 0.0, 0.0, 0, 0.014],
    ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]);
    B.add('head', loft(bal, {
      seg: 22, sub: 3,
      deform: (v) => {
        const fz = -0.06 * s; if (v.z < fz) v.z = fz + (v.z - fz) * 0.86;
        if (v.z < -0.03 * s) {
          const ey = Math.abs(v.y - 0.088 * s) / (0.017 * s), ex = Math.abs(v.x) / (0.058 * s);
          const k = (1 - sstep(0.75, 1.0, ey)) * (1 - sstep(0.8, 1.0, ex));
          if (k > 0) { v.x *= 1 - 0.1 * k; v.z *= 1 - 0.1 * k; v.y = 0.088 * s + (v.y - 0.088 * s) * (1 - 0.1 * k); }
          // nose ridge
          v.z -= 0.016 * s * Math.exp(-((v.x / (0.013 * s)) ** 2)) * sstep(0.02, 0.045, v.y / s) * (1 - sstep(0.066, 0.078, v.y / s));
        }
      },
    }), 0x131316, M(PAT.KNIT, 0.95));
    B.add('neck', loft([[-0.035, 0.066, 0.068], [0.04, 0.056, 0.058], [0.12, 0.058, 0.06]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 14 }), 0x131316, M(PAT.KNIT, 0.95));
    helmet(B, s, { color: 0x1a1b1e, mat: M(PAT.PLAIN, 0.55), rail: 0x0e0e0e, strap: P.web, counter: true });
    for (const sd of [-1, 1]) {
      B.add('head', xf(cyl(0.039, 0.036, 0.032, 16), [sd * 0.094 * s, 0.075 * s, 0.008 * s], [0, 0, PI / 2], [s, s, s]), 0x25282a, M(PAT.PLAIN, 0.55));
      B.add('head', xf(cyl(0.028, 0.028, 0.006, 12), [sd * 0.112 * s, 0.075 * s, 0.008 * s], [0, 0, PI / 2], [s, s, s]), 0x3a3d3a, M(PAT.PLAIN, 0.5));
    }
    B.add('head', tube([[-0.1, 0.06, -0.01], [-0.085, 0.03, -0.07], [-0.03, 0.018, -0.1]].map((p) => p.map((x) => x * s)), 0.003 * s, 0.003 * s, 10, 5), 0x151515, M(PAT.PLAIN, 0.5));
    B.add('head', xf(new THREE.SphereGeometry(0.008 * s, 8, 6), [-0.026 * s, 0.018 * s, -0.102 * s]), 0x111111, M(PAT.KNIT, 0.9));
  } else if (skin === 2) {
    buildHumanHead(B, { s, skin: P.skin, hair: P.hair, lip: P.lip, iris: 0x3a2a1a });
    // short hair
    B.add('head', loft([[0.06, 0.079, 0.1, 0, 0.012], [0.1, 0.081, 0.105, 0, 0.01], [0.15, 0.076, 0.098, 0, 0.012], [0.18, 0.058, 0.077, 0, 0.014], [0.2, 0.03, 0.04, 0, 0.014], [0.205, 0, 0, 0, 0.014]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]), {
      seg: 20, capStart: false,
      deform: (v, t, th, c, sn) => { if (sn < -0.2) { const k = sstep(-0.2, -0.6, sn) * (1 - sstep(0.13 * s, 0.15 * s, v.y)); v.x *= 1 - 0.1 * k; v.z *= 1 - 0.12 * k; } },
    }), P.hair, M(PAT.HAIR, 0.75));
    // beret
    const beret = loft([[0, 0.083, 0.104], [0.012, 0.096, 0.116, 0.006], [0.03, 0.103, 0.122, 0.014, 0.0], [0.046, 0.086, 0.104, 0.018], [0.056, 0.0, 0.0, 0.02]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, (r[3] || 0) * s, (r[4] || 0) * s]), { seg: 22 });
    B.add('head', xf(beret, [0.004 * s, 0.13 * s, 0.006 * s], [-0.06, 0, -0.2]), 0x5c151a, M(PAT.FABRIC, 0.95));
    B.add('head', xf(loft([[-0.006, 0.081, 0.103], [0.01, 0.083, 0.105]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 20 }), [0.004 * s, 0.13 * s, 0.006 * s], [-0.06, 0, -0.2]), 0x151210, M(PAT.LEATHER, 0.5));
    B.add('head', xf(rbox(0.02, 0.026, 0.006, 0.003), [-0.044 * s, 0.158 * s, -0.098 * s], [-0.2, 0.35, 0.05]), 0xb09040, M(PAT.METAL, 0.35, 0.9));
  } else {
    // FOX: female face, hair, ponytail, red scarf
    buildHumanHead(B, { s, fem: true, skin: P.skin, hair: P.hair, lip: P.lip, iris: 0x3a2618, brow: 0x1a1210 });
    const hairline = (c, sn) => {
      const side = 0.075, back = 0.035;
      const front = 0.158 - 0.042 * sstep(-0.25, 0.85, c) + 0.01 * sstep(-0.3, -0.9, c);
      return sn >= 0 ? lerp(side, back, sn) : lerp(side, front, sstep(0.0, 0.75, -sn));
    };
    B.add('head', loft([[0.028, 0.08, 0.1, 0, 0.02], [0.06, 0.082, 0.105, 0, 0.012], [0.1, 0.084, 0.108, 0, 0.008], [0.14, 0.083, 0.105, 0, 0.01], [0.17, 0.072, 0.092, 0, 0.012], [0.195, 0.05, 0.064, 0, 0.014], [0.21, 0.022, 0.03, 0, 0.014], [0.214, 0, 0, 0, 0.014]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]), {
      seg: 36, sub: 4, capStart: false,
      deform: (v, t, th, c, sn) => {
        const hl = hairline(c, sn) * s;
        let f = 1;
        if (v.y < hl) { v.y = hl; f = 0.93; }
        else if (sn < 0) f = 1 + 0.025 * (1 - sstep(hl + 0.012 * s, hl + 0.05 * s, v.y));
        v.x *= f; v.z = (v.z - 0.01 * s) * f + 0.01 * s;
      },
    }), P.hair, M(PAT.HAIR, 0.55));
    for (const sd of [-1, 1]) B.add('head', tube([[sd * 0.073, 0.145, -0.058], [sd * 0.081, 0.095, -0.062], [sd * 0.076, 0.045, -0.054], [sd * 0.068, 0.015, -0.044]].map((p) => p.map((x) => x * s)), 0.011 * s, 0.003 * s, 12, 6), P.hair, M(PAT.HAIR, 0.55));
    // ponytail on its own bone for sway
    B.add('tail', xf(new THREE.TorusGeometry(0.02, 0.007, 6, 12), [0, 0, 0], [PI / 2 - 0.4, 0, 0], [s, s, s]), 0x6a0f0c, M(PAT.FABRIC, 0.7));
    B.add('tail', loft([[0.01, 0.0, 0.0], [0.0, 0.024, 0.026], [-0.06, 0.036, 0.034, 0, 0.012], [-0.16, 0.032, 0.028, 0, 0.022], [-0.26, 0.018, 0.016, 0, 0.02], [-0.32, 0.0, 0.0, 0, 0.015]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s]), { seg: 12 }), P.hair, M(PAT.HAIR, 0.6));
    // scarf
    B.add('neck', loft([[-0.03, 0.088, 0.09], [0.01, 0.085, 0.087], [0.05, 0.072, 0.075], [0.075, 0.06, 0.063]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), {
      seg: 18, deform: (v, t, th) => { const k = 1 + 0.08 * Math.sin(th * 5 + v.y * 70) * (1 - t * 0.4); v.x *= k; v.z *= k; },
    }), P.scarf || 0x9c1612, M(PAT.FABRIC, 0.85));
    B.add('neck', xf(ell(0.03, 0.028, 0.022, 10, 8), [-0.045 * s, -0.01 * s, -0.075 * s], [0, 0, 0.3], [s, s, s]), 0x9c1612, M(PAT.FABRIC, 0.85));
    B.add('chest', loft([[0.27, 0.034, 0.008, -0.03, 0.095], [0.18, 0.04, 0.008, -0.04, 0.142], [0.06, 0.038, 0.007, -0.05, 0.16], [-0.06, 0.03, 0.006, -0.055, 0.155]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, r[3] * s, r[4] * s]), { seg: 10 }), 0x9c1612, M(PAT.FABRIC, 0.85));
    B.add('chest', loft([[0.26, 0.03, 0.008, 0.0, 0.1], [0.16, 0.034, 0.008, 0.01, 0.146], [0.08, 0.03, 0.007, 0.02, 0.158]]
      .map((r) => [r[0] * s, r[1] * s, r[2] * s, r[3] * s, r[4] * s]), { seg: 10 }), 0x8a130f, M(PAT.FABRIC, 0.85));
  }

  buildHumanLimbs(B, {
    s, fem, shirt: P.shirt, shirtMat, pants: P.pants, pantsMat, gloves: P.gloves, pad: skin === 3 ? null : P.pad, web: P.web, gear: P.gear,
    boots: P.boots, sole: P.sole, ankleH: rig.ankleH, laces: skin === 0 ? 0x4a3c2a : null,
    kneePad: skin === 1 || skin === 2 ? P.pad : null, elbowPad: skin === 2 ? P.pad : null,
    patch: skin === 0 ? 0x5a5a3a : skin === 2 ? 0x3a3a3a : null,
    fingerColor: skin === 3 ? P.skin : undefined, fingerMat: skin === 3 ? M(PAT.SKIN, 0.55) : undefined,
  });
  void cam;
  rig.extraBones = fem ? { tail: { parent: 'head', pos: [0, 0.16 * s, 0.095 * s] } } : null;
  return { geos: B.build(), rig, pal: { ...DEFAULT_PAL, camo: P.camo.map(C) } };
}

function helmet(B, s, o) {
  const raise = (c, sn) => 0.055 * Math.pow(Math.max(0, -sn), 1.5) + 0.022 * Math.pow(Math.abs(c), 4);
  const g = loft([[0.07, 0.1, 0.12, 0, 0.008, 2.2], [0.12, 0.103, 0.123, 0, 0.008, 2.2], [0.17, 0.092, 0.11, 0, 0.01, 2.1], [0.205, 0.062, 0.076, 0, 0.012, 2], [0.222, 0.0, 0.0, 0, 0.012]]
    .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s, r[5] || 2]), {
    seg: 24, sub: 3, capStart: false,
    deform: (v, t, th, c, sn) => { if (t < 0.25) v.y += raise(c, sn) * s * (1 - t / 0.25); },
  });
  B.add('head', g, o.color, o.mat);
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const th = (i / 24) * TAU, c = Math.cos(th), sn = Math.sin(th);
    const ex = 2 / 2.2;
    pts.push([0.101 * s * Math.sign(c) * Math.pow(Math.abs(c), ex), (0.07 + raise(c, sn)) * s, 0.008 * s + 0.121 * s * Math.sign(sn) * Math.pow(Math.abs(sn), ex)]);
  }
  B.add('head', tube(pts, 0.0055 * s, 0.0055 * s, 48, 5, true), o.rail, M(PAT.PLAIN, 0.6));
  B.add('head', xf(rbox(0.036, 0.026, 0.014, 0.005), [0, 0.162 * s, -0.114 * s], [-0.5, 0, 0], [s, s, s]), 0x1e1e1e, M(PAT.METAL, 0.4, 0.6));
  for (const sd of [-1, 1]) B.add('head', xf(rbox(0.012, 0.022, 0.11, 0.004), [sd * 0.102 * s, 0.123 * s, 0.004 * s], [0, 0, -sd * 0.12], [s, s, s]), o.rail, M(PAT.PLAIN, 0.5));
  B.add('head', xf(rbox(0.07, 0.05, 0.008, 0.004), [0, 0.19 * s, 0.075 * s], [0.85, 0, 0], [s, s, s]), o.rail, M(PAT.FABRIC, 0.9));
  if (o.counter) B.add('head', xf(rbox(0.06, 0.035, 0.022, 0.008), [0, 0.105 * s, 0.13 * s], [0.2, 0, 0], [s, s, s]), 0x101010, M(PAT.PLAIN, 0.6));
  B.add('head', tube([[-0.082, 0.07, 0.014], [-0.068, 0.012, -0.018], [-0.042, -0.022, -0.045], [0, -0.035, -0.058], [0.042, -0.022, -0.045], [0.068, 0.012, -0.018], [0.082, 0.07, 0.014]].map((p) => p.map((x) => x * s)), 0.0032 * s, 0.0032 * s, 20, 4), o.strap, M(PAT.FABRIC, 0.85));
}

// ------------------------------------------------------------------------------------------------
// Placeholder weapons (used until setWeaponFactory() provides real ones)
// Weapon space: origin at pistol grip, barrel toward -Z, 'muzzle' child at tip, 'foregrip' child.
// ------------------------------------------------------------------------------------------------
let _wmats = null;
function weaponMats() {
  if (_wmats) return _wmats;
  _wmats = {
    metal: new THREE.MeshStandardMaterial({ color: 0x2c2e31, metalness: 0.75, roughness: 0.42 }),
    poly: new THREE.MeshStandardMaterial({ color: 0x17181a, metalness: 0.1, roughness: 0.72 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6e3b1c, metalness: 0.0, roughness: 0.55 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x3e4229, metalness: 0.05, roughness: 0.75 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc9cbcf, metalness: 0.95, roughness: 0.22 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1.0, roughness: 0.3 }),
    core: new THREE.MeshStandardMaterial({ color: 0x331a00, emissive: 0xffc070, emissiveIntensity: 5, roughness: 0.3 }),
    shell: new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  };
  return _wmats;
}
function bladeShape(len, h0, tipLen) {
  const sh = new THREE.Shape();
  sh.moveTo(0, -h0 * 0.5);
  sh.lineTo(len - tipLen, -h0 * 0.42);
  sh.lineTo(len, 0.0);
  sh.lineTo(len - tipLen * 1.4, h0 * 0.42);
  sh.lineTo(len * 0.35, h0 * 0.5);
  sh.lineTo(0, h0 * 0.5);
  return sh;
}
function extrudeBlade(len, h0, tipLen, thick, bevel) {
  const g = new THREE.ExtrudeGeometry(bladeShape(len, h0, tipLen), { depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 });
  xf(g, [0, 0, 0], [0, PI / 2, 0]); // shape X -> -Z
  return xf(g, [-thick / 2, 0, 0]);
}
const _wcache = new Map();
function placeholderWeaponDef(id) {
  if (_wcache.has(id)) return _wcache.get(id);
  const parts = {};
  const add = (mat, g) => { g.deleteAttribute('uv'); if (!g.index) prepIndexOnly(g); (parts[mat] || (parts[mat] = [])).push(g); };
  let muzzle = [0, 0.06, -0.6], fore = [0, 0.04, -0.3];
  const W = String(id);
  if (W === 'ak47') {
    add('metal', xf(rbox(0.048, 0.064, 0.34, 0.008), [0, 0.05, -0.1]));
    add('metal', xf(rbox(0.044, 0.02, 0.25, 0.008), [0, 0.087, -0.085]));
    add('metal', cylAB([0, 0.062, -0.27], [0, 0.062, -0.62], 0.0105, 0.0105, 10));
    add('metal', cylAB([0, 0.062, -0.58], [0, 0.062, -0.64], 0.016, 0.016, 10));
    add('metal', cylAB([0, 0.093, -0.18], [0, 0.093, -0.44], 0.011, 0.011, 10));
    add('wood', xf(rbox(0.042, 0.028, 0.19, 0.01), [0, 0.094, -0.3]));
    add('wood', xf(rbox(0.056, 0.05, 0.22, 0.014), [0, 0.046, -0.36]));
    add('metal', xf(rbox(0.012, 0.045, 0.012, 0.003), [0, 0.088, -0.555]));
    add('metal', xf(rbox(0.024, 0.014, 0.04, 0.003), [0, 0.1, -0.14]));
    add('wood', xf(rbox(0.04, 0.066, 0.28, 0.014), [0, 0.018, 0.2], [0.13, 0, 0]));
    add('wood', xf(rbox(0.046, 0.12, 0.024, 0.01), [0, -0.005, 0.335], [0.13, 0, 0]));
    add('wood', xf(rbox(0.03, 0.1, 0.042, 0.009), [0, -0.035, 0.012], [-0.32, 0, 0]));
    add('metal', xf(rbox(0.028, 0.08, 0.062, 0.006), [0, -0.012, -0.125], [0.14, 0, 0]));
    add('metal', xf(rbox(0.028, 0.08, 0.06, 0.006), [0, -0.082, -0.146], [0.36, 0, 0]));
    add('metal', xf(rbox(0.028, 0.07, 0.058, 0.006), [0, -0.146, -0.18], [0.6, 0, 0]));
    muzzle = [0, 0.062, -0.645]; fore = [0, 0.028, -0.29];
  } else if (W === 'm4a1') {
    add('poly', xf(rbox(0.045, 0.06, 0.24, 0.008), [0, 0.056, -0.07]));
    add('poly', xf(rbox(0.04, 0.05, 0.16, 0.008), [0, 0.016, -0.06]));
    add('poly', xf(rbox(0.026, 0.14, 0.064, 0.006), [0, -0.062, -0.1], [0.12, 0, 0]));
    add('metal', xf(rbox(0.054, 0.054, 0.21, 0.006), [0, 0.058, -0.29]));
    add('metal', cylAB([0, 0.058, -0.39], [0, 0.058, -0.52], 0.009, 0.009, 10));
    add('metal', cylAB([0, 0.058, -0.51], [0, 0.058, -0.56], 0.012, 0.012, 10));
    add('metal', xf(rbox(0.01, 0.05, 0.016, 0.003), [0, 0.1, -0.375]));
    add('metal', cylAB([0, 0.118, -0.03], [0, 0.118, -0.12], 0.019, 0.019, 12));
    add('poly', xf(rbox(0.03, 0.03, 0.06, 0.005), [0, 0.095, -0.075]));
    add('metal', cylAB([0, 0.052, 0.05], [0, 0.048, 0.2], 0.014, 0.014, 10));
    add('poly', xf(rbox(0.042, 0.078, 0.13, 0.012), [0, 0.03, 0.24], [0.05, 0, 0]));
    add('poly', xf(rbox(0.028, 0.092, 0.038, 0.008), [0, -0.035, 0.012], [-0.32, 0, 0]));
    muzzle = [0, 0.058, -0.565]; fore = [0, 0.03, -0.25];
  } else if (W === 'mg3') {
    add('metal', xf(rbox(0.062, 0.09, 0.42, 0.01), [0, 0.05, -0.1]));
    add('metal', cylAB([0, 0.065, -0.31], [0, 0.065, -0.72], 0.022, 0.022, 12));
    add('metal', cylAB([0, 0.065, -0.72], [0, 0.065, -0.8], 0.028, 0.02, 12));
    for (const sx of [-1, 1]) add('metal', cylAB([sx * 0.012, 0.04, -0.66], [sx * 0.022, 0.012, -0.44], 0.005, 0.005, 6));
    add('poly', xf(rbox(0.046, 0.1, 0.3, 0.014), [0, 0.02, 0.26], [0.08, 0, 0]));
    add('poly', xf(rbox(0.032, 0.1, 0.042, 0.009), [0, -0.035, 0.012], [-0.3, 0, 0]));
    add('olive', xf(rbox(0.08, 0.1, 0.12, 0.01), [-0.075, -0.02, -0.12]));
    add('metal', xf(rbox(0.012, 0.05, 0.08, 0.004), [0.034, 0.105, -0.4]));
    muzzle = [0, 0.065, -0.805]; fore = [0, 0.02, -0.3];
  } else if (W === 'deagle') {
    add('metal', xf(rbox(0.03, 0.036, 0.27, 0.006), [0, 0.058, -0.075]));
    add('metal', xf(rbox(0.028, 0.026, 0.19, 0.005), [0, 0.03, -0.09]));
    add('metal', xf(rbox(0.01, 0.03, 0.05, 0.003), [0, 0.004, -0.04]));
    add('poly', xf(rbox(0.031, 0.11, 0.046, 0.009), [0, -0.03, 0.012], [-0.25, 0, 0]));
    muzzle = [0, 0.058, -0.215]; fore = [-0.035, -0.02, -0.005];
  } else if (W === 'knife') {
    add('poly', cylAB([0, 0, 0.06], [0, 0, -0.045], 0.014, 0.013, 10));
    add('metal', xf(rbox(0.014, 0.05, 0.012, 0.003), [0, 0.002, -0.052]));
    add('steel', xf(extrudeBlade(0.2, 0.034, 0.05, 0.003, 0.0012), [0, 0.004, -0.058]));
    muzzle = [0, 0.004, -0.26]; fore = [0, 0, 0];
  } else if (W === 'grenade') {
    add('olive', xf(new THREE.SphereGeometry(0.032, 12, 10), [0, 0, 0], [0, 0, 0], [1, 1.25, 1]));
    add('metal', cylAB([0, 0.035, 0], [0, 0.058, 0], 0.011, 0.011, 8));
    add('metal', xf(rbox(0.01, 0.07, 0.014, 0.003), [0.03, 0.02, 0], [0, 0, 0.12]));
    add('metal', xf(new THREE.TorusGeometry(0.012, 0.0022, 5, 12), [-0.018, 0.058, 0], [0, PI / 2, 0]));
    muzzle = [0, 0, 0]; fore = [0, 0, 0];
  } else if (W === 'blade') {
    add('metal', cylAB([0, 0, 0.12], [0, 0, -0.1], 0.018, 0.018, 12));
    add('gold', xf(new THREE.SphereGeometry(0.026, 10, 8), [0, 0, 0.135]));
    add('gold', xf(rbox(0.05, 0.17, 0.05, 0.014), [0, 0, -0.115]));
    add('gold', xf(rbox(0.03, 0.06, 0.1, 0.01), [0, 0, -0.17]));
    add('core', xf(extrudeBlade(1.02, 0.07, 0.2, 0.012, 0.004), [0, 0, -0.16]));
    add('shell', xf(extrudeBlade(1.08, 0.11, 0.24, 0.03, 0.01), [0, 0, -0.14]));
    muzzle = [0, 0, -1.2]; fore = [0, 0, 0];
  } else {
    add('metal', xf(rbox(0.05, 0.07, 0.5, 0.01), [0, 0.05, -0.2]));
    add('poly', xf(rbox(0.03, 0.1, 0.042, 0.009), [0, -0.035, 0.012], [-0.3, 0, 0]));
    muzzle = [0, 0.05, -0.46];
  }
  const def = { geos: {}, muzzle, fore };
  for (const k in parts) {
    for (const g of parts[k]) { for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a); g.clearGroups(); }
    def.geos[k] = parts[k].length === 1 ? parts[k][0] : mergeGeometries(parts[k], false);
  }
  _wcache.set(id, def);
  return def;
}
function prepIndexOnly(g) {
  const n = g.attributes.position.count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
}
function makePlaceholderWeapon(id) {
  const def = placeholderWeaponDef(id);
  const mats = weaponMats();
  const g = new THREE.Group();
  g.name = 'weapon:' + id;
  for (const k in def.geos) {
    const m = new THREE.Mesh(def.geos[k], mats[k]);
    m.castShadow = k !== 'shell';
    m.receiveShadow = k !== 'shell';
    g.add(m);
  }
  const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.fromArray(def.muzzle); g.add(mz);
  const fg = new THREE.Object3D(); fg.name = 'foregrip'; fg.position.fromArray(def.fore); g.add(fg);
  g.userData.placeholder = true;
  return g;
}

function classifyWeapon(id) {
  const s = String(id || '').toLowerCase();
  if (s === 'blade' || s.includes('blade') || s.includes('sword')) return 'blade';
  if (s.includes('knife') || s.includes('axe') || s.includes('machete') || s.includes('kukri')) return 'knife';
  if (s.includes('grenade') || s.includes('nade') || s.includes('flash') || s.includes('smoke')) return 'grenade';
  if (s.includes('deagle') || s.includes('pistol') || s.includes('usp') || s.includes('glock') || s.includes('revolver') || s === 'p228') return 'pistol';
  if (s.includes('mg') || s.includes('m249') || s.includes('gatling') || s.includes('minigun') || s.includes('pkm')) return 'mg';
  return 'rifle';
}

// ------------------------------------------------------------------------------------------------
// Animation constants & scratch objects (no per-frame allocations)
// ------------------------------------------------------------------------------------------------
const BONE_DEF = [
  ['hips', null], ['spine', 'hips'], ['chest', 'spine'], ['neck', 'chest'], ['head', 'neck'],
  ['upperArmL', 'chest'], ['foreArmL', 'upperArmL'], ['handL', 'foreArmL'],
  ['upperArmR', 'chest'], ['foreArmR', 'upperArmR'], ['handR', 'foreArmR'],
  ['thighL', 'hips'], ['shinL', 'thighL'], ['footL', 'shinL'],
  ['thighR', 'hips'], ['shinR', 'thighR'], ['footR', 'shinR'],
];
const BONE_INDEX = {};
BONE_DEF.forEach(([n], i) => { BONE_INDEX[n] = i; });

const qE = (x, y, z, o = 'XYZ') => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, o));
const qBasis = (x, y, z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)));
const Q_ID = new THREE.Quaternion();
const GRIP_R = qE(1.22, 0, 0);
const GRIP_ID = qE(0, 0, 0);
const GRIP_MELEE = qE(0.7, 0, 0); // handle tilted toward the fingers (wrist cock)
const GRIP_L_FORE = qE(0.15, 0, 2.45);
const GRIP_L_PISTOL = qE(1.22, 0.1, 0.1);
const GUARD_L = qE(1.35, 0.25, 0.9);
const CLIMB_R = qBasis([0, 1, 0], [0, 0, 1], [1, 0, 0]);
const CLIMB_L = qBasis([0, -1, 0], [0, 0, 1], [-1, 0, 0]);
const POLE_R = new THREE.Vector3(0.8, -1.0, 0.5).normalize();
const POLE_L = new THREE.Vector3(-0.8, -1.0, 0.4).normalize();
const POLE_CLIMB_R = new THREE.Vector3(0.9, -0.6, 0.3).normalize();
const POLE_CLIMB_L = new THREE.Vector3(-0.9, -0.6, 0.3).normalize();
const PISTOL_SUPPORT = new THREE.Vector3(-0.034, -0.022, -0.006);
// weapon mount pose in aimPivot space: [px, py, pz, rx, ry, rz]
const WPOSE = {
  rifle: [0.1, -0.055, -0.27, 0, 0, 0],
  mg: [0.11, -0.085, -0.25, 0, 0, 0],
  pistol: [0.03, -0.005, -0.44, 0, 0, 0],
  knife: [0.2, -0.3, -0.24, 0.35, -0.1, 0],
  grenade: [0.19, -0.2, -0.24, 0.4, 0, 0],
  blade: [0.24, -0.42, -0.15, 0.15, -0.22, 0],
};
const WDEFAULT_FORE = { rifle: [0, 0.03, -0.28], mg: [0, 0.02, -0.3], pistol: [-0.034, -0.022, -0.006], knife: [0, 0, 0], grenade: [0, 0, 0], blade: [0, 0, 0] };
const WSTANCE = { rifle: -0.42, mg: -0.45, pistol: -0.12, knife: -0.25, grenade: -0.2, blade: -0.32 };
const WFIRE = { rifle: [10, 1.0], mg: [14, 1.15], pistol: [3.2, 1.8], knife: [0, 0], grenade: [0, 0], blade: [0, 0] };
const EMPTY_STATE = Object.freeze({});

// Attack tracks. Armed: [t, px,py,pz, rx,ry,rz, yaw,pitch,drop,charge]; FK: [t, rUx,rUy,rUz,rFx, lUx,lUy,lUz,lFx, yaw,pitch,drop,charge]
function mkTrack(dur, keys, o = {}) {
  const nch = keys[0].length - 1;
  return { dur, nch, stride: nch + 1, count: keys.length, keys: new Float32Array(keys.flat()), fk: !!o.fk, additive: !!o.additive };
}
const TR = {
  knife1: mkTrack(0.45, [
    [0, 0.2, -0.3, -0.24, 0.35, -0.1, 0, 0, 0, 0, 0],
    [0.28, 0.3, 0.02, -0.08, 0.35, -2.2, 1.57, -0.35, 0.05, 0, 0],
    [0.55, 0.02, -0.1, -0.46, 0.0, 1.57, 1.57, 0.35, -0.1, 0.02, 0],
    [0.78, -0.22, -0.18, -0.3, -0.1, 2.3, 1.57, 0.45, -0.1, 0.02, 0],
    [1, 0.2, -0.3, -0.24, 0.35, -0.1, 0, 0, 0, 0, 0],
  ]),
  knife2: mkTrack(0.6, [
    [0, 0.2, -0.3, -0.24, 0.35, -0.1, 0, 0, 0, 0, 0],
    [0.35, 0.24, -0.2, -0.04, 0.1, 0, 0, -0.3, 0.05, 0, 0],
    [0.55, 0.06, -0.1, -0.62, 0.0, 0, 0, 0.25, -0.2, 0.04, 0],
    [0.75, 0.08, -0.12, -0.58, 0.0, 0, 0, 0.2, -0.18, 0.04, 0],
    [1, 0.2, -0.3, -0.24, 0.35, -0.1, 0, 0, 0, 0, 0],
  ]),
  blade1: mkTrack(0.5, [
    [0, 0.24, -0.42, -0.15, 0.15, -0.22, 0, 0, 0, 0, 0],
    [0.3, 0.36, 0.08, 0.02, 0.5, -2.3, 1.57, -0.6, 0.1, 0, 0],
    [0.55, 0.02, -0.08, -0.52, 0.0, 1.57, 1.57, 0.5, -0.15, 0.03, 0],
    [0.78, -0.28, -0.14, -0.28, -0.15, 2.4, 1.57, 0.7, -0.1, 0.03, 0],
    [1, 0.24, -0.42, -0.15, 0.15, -0.22, 0, 0, 0, 0, 0],
  ]),
  blade2: mkTrack(0.7, [
    [0, 0.24, -0.42, -0.15, 0.15, -0.22, 0, 0, 0, 0, 0],
    [0.38, 0.12, 0.4, 0.06, 2.1, 0, 0, -0.1, 0.2, 0, 0],
    [0.6, 0.05, -0.3, -0.48, -0.55, 0, 0, 0.1, -0.45, 0.1, 0],
    [0.82, 0.05, -0.32, -0.46, -0.6, 0, 0, 0.1, -0.4, 0.09, 0],
    [1, 0.24, -0.42, -0.15, 0.15, -0.22, 0, 0, 0, 0, 0],
  ]),
  bash: mkTrack(0.45, [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0.35, -0.04, 0.03, -0.17, -0.35, 0.15, 0.2, 0.25, -0.12, 0.02, 0],
    [0.55, -0.04, 0.02, -0.15, -0.3, 0.1, 0.15, 0.2, -0.1, 0.02, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ], { additive: true }),
  throw: mkTrack(0.75, [
    [0, 0.19, -0.2, -0.24, 0.4, 0, 0, 0, 0, 0, 0],
    [0.35, 0.24, 0.3, 0.14, 1.8, 0, 0, -0.35, 0.2, 0, 0],
    [0.55, 0.1, 0.1, -0.46, -0.2, 0, 0, 0.35, -0.2, 0.02, 0],
    [0.78, 0.0, -0.15, -0.36, -0.6, 0, 0, 0.3, -0.15, 0.02, 0],
    [1, 0.19, -0.2, -0.24, 0.4, 0, 0, 0, 0, 0, 0],
  ]),
  claw1: mkTrack(0.5, [
    [0, 0.4, 0, 0.15, 0.6, 0.4, 0, -0.15, 0.6, 0, 0, 0, 0],
    [0.35, 2.3, 0, 0.7, 1.4, 0.5, 0, -0.3, 0.7, -0.45, 0.15, 0, 0],
    [0.6, 0.9, 0, -0.45, 0.25, 0.6, 0, -0.2, 0.6, 0.5, -0.3, 0.03, 0],
    [0.8, 0.6, 0, -0.3, 0.5, 0.5, 0, -0.2, 0.6, 0.3, -0.2, 0.02, 0],
    [1, 0.4, 0, 0.15, 0.6, 0.4, 0, -0.15, 0.6, 0, 0, 0, 0],
  ], { fk: true }),
  claw2: mkTrack(0.65, [
    [0, 0.4, 0, 0.15, 0.6, 0.4, 0, -0.15, 0.6, 0, 0, 0, 0],
    [0.4, 2.7, 0, 0.25, 0.7, 2.7, 0, -0.25, 0.7, 0, 0.3, 0, 0],
    [0.62, 1.0, 0, 0.1, 0.15, 1.0, 0, -0.1, 0.15, 0, -0.55, 0.08, 0],
    [0.8, 0.8, 0, 0.15, 0.3, 0.8, 0, -0.15, 0.3, 0, -0.4, 0.06, 0],
    [1, 0.4, 0, 0.15, 0.6, 0.4, 0, -0.15, 0.6, 0, 0, 0, 0],
  ], { fk: true }),
  term1: mkTrack(0.6, [
    [0, 0.12, 0, 0.32, 0.4, 0.12, 0, -0.32, 0.4, 0, 0, 0, 0],
    [0.35, -0.5, 0, 0.45, 2.0, 0.5, 0, -0.3, 1.0, -0.5, 0.1, 0, 0.8],
    [0.55, 1.45, 0, 0.0, 0.1, 0.2, 0, -0.4, 0.6, 0.55, -0.25, 0.05, 1.0],
    [0.75, 1.3, 0, 0.05, 0.2, 0.2, 0, -0.4, 0.6, 0.4, -0.2, 0.04, 0.6],
    [1, 0.12, 0, 0.32, 0.4, 0.12, 0, -0.32, 0.4, 0, 0, 0, 0],
  ], { fk: true }),
  term2: mkTrack(0.85, [
    [0, 0.12, 0, 0.32, 0.4, 0.12, 0, -0.32, 0.4, 0, 0, 0, 0],
    [0.4, 2.8, 0, 0.35, 0.9, 2.8, 0, -0.35, 0.9, 0, 0.25, 0, 0.8],
    [0.62, 0.9, 0, 0.2, 0.2, 0.9, 0, -0.2, 0.2, 0, -0.6, 0.18, 1.0],
    [0.85, 0.8, 0, 0.2, 0.3, 0.8, 0, -0.2, 0.3, 0, -0.5, 0.15, 0.5],
    [1, 0.12, 0, 0.32, 0.4, 0.12, 0, -0.32, 0.4, 0, 0, 0, 0],
  ], { fk: true }),
};
function evalTrack(tr, t, out) {
  const k = tr.keys, st = tr.stride, n = tr.count;
  let i = 0;
  while (i < n - 2 && k[(i + 1) * st] <= t) i++;
  const t0 = k[i * st], t1 = k[(i + 1) * st];
  const u = smooth(clamp((t - t0) / Math.max(1e-5, t1 - t0), 0, 1));
  for (let c = 1; c < st; c++) out[c - 1] = lerp(k[i * st + c], k[(i + 1) * st + c], u);
}

// Death poses: bone -> euler (XYZ); p = [hips y factor (x hipsY) | -1 => bodyThick, hips z (x legScale)]
const DEATH_DEF = [
  { // fall backward
    t1: 0.3, t2: 0.95,
    k1: { hips: [0.3, 0, 0.05], spine: [0.15, 0, 0], chest: [0.12, 0.1, 0], neck: [-0.2, 0, 0], head: [-0.35, 0.2, 0], upperArmL: [0.5, 0, -0.5], upperArmR: [0.3, 0, 0.6], foreArmL: [0.9, 0, 0], foreArmR: [1.1, 0, 0], handL: [0.3, 0, 0], handR: [0.3, 0, 0], thighL: [0.7, 0, -0.1], thighR: [0.45, 0, 0.1], shinL: [-1.3, 0, 0], shinR: [-1.0, 0, 0], footL: [0.3, 0, 0], footR: [0.25, 0, 0] },
    p1: [0.74, 0.06],
    k2: { hips: [1.5, 0, 0.1], spine: [0.05, 0, 0], chest: [0.05, 0.05, 0], neck: [0.1, 0, 0], head: [0.25, 0.6, 0.1], upperArmL: [-0.25, 0, -1.25], upperArmR: [-0.1, 0, 1.0], foreArmL: [0.25, 0, 0], foreArmR: [0.45, 0, 0], handL: [0.3, 0, 0], handR: [0.3, 0, 0], thighL: [0.15, 0, -0.2], thighR: [0.45, 0, 0.15], shinL: [-0.2, 0, 0], shinR: [-0.7, 0, 0], footL: [0.6, 0, 0], footR: [0.5, 0, 0] },
    p2: [-1, 0.42],
  },
  { // fall forward (face down)
    t1: 0.3, t2: 0.9,
    k1: { hips: [-0.3, 0, 0], spine: [-0.3, 0, 0], chest: [-0.2, 0, 0.05], neck: [-0.1, 0, 0], head: [0.1, 0.1, 0], upperArmL: [0.8, 0, -0.3], upperArmR: [0.7, 0, 0.3], foreArmL: [0.6, 0, 0], foreArmR: [0.7, 0, 0], handL: [0.2, 0, 0], handR: [0.2, 0, 0], thighL: [0.8, 0, -0.05], thighR: [0.6, 0, 0.05], shinL: [-1.5, 0, 0], shinR: [-1.2, 0, 0], footL: [0.4, 0, 0], footR: [0.3, 0, 0] },
    p1: [0.7, -0.05],
    k2: { hips: [-1.52, 0.15, 0], spine: [-0.05, 0, 0], chest: [0.0, 0, 0.05], neck: [0.1, 0, 0], head: [0.15, 1.1, 0], upperArmL: [0.25, 0, -1.2], upperArmR: [0.35, 0, 1.4], foreArmL: [0.25, 0, 0], foreArmR: [0.2, 0, 0], handL: [0.1, 0, 0], handR: [0.1, 0, 0], thighL: [0.1, 0, -0.12], thighR: [0.05, 0, 0.14], shinL: [-0.35, 0, 0], shinR: [-0.2, 0, 0], footL: [-0.7, 0, 0], footR: [-0.8, 0, 0] },
    p2: [-1, -0.42],
  },
  { // crumple: knees first, then forward/sideways
    t1: 0.42, t2: 1.05,
    k1: { hips: [-0.15, 0.1, 0.05], spine: [-0.4, 0, 0], chest: [-0.3, 0.1, 0], neck: [-0.2, 0, 0], head: [-0.3, 0.3, 0.2], upperArmL: [0.3, 0, -0.2], upperArmR: [0.3, 0, 0.25], foreArmL: [0.4, 0, 0], foreArmR: [0.5, 0, 0], handL: [0.3, 0, 0], handR: [0.3, 0, 0], thighL: [1.45, 0, -0.12], thighR: [1.35, 0, 0.12], shinL: [-2.3, 0, 0], shinR: [-2.2, 0, 0], footL: [0.8, 0, 0], footR: [0.8, 0, 0] },
    p1: [0.46, 0.02],
    k2: { hips: [-1.45, 0.5, 0.25], spine: [-0.1, 0.1, 0], chest: [0.05, 0.15, 0.1], neck: [0.1, 0, 0], head: [0.1, 1.0, 0.1], upperArmL: [0.4, 0, -1.0], upperArmR: [1.6, 0, 0.5], foreArmL: [0.5, 0, 0], foreArmR: [0.6, 0, 0], handL: [0.3, 0, 0], handR: [0.3, 0, 0], thighL: [0.5, 0, -0.1], thighR: [0.2, 0, 0.2], shinL: [-1.0, 0, 0], shinR: [-0.5, 0, 0], footL: [-0.5, 0, 0], footR: [-0.6, 0, 0] },
    p2: [-1, -0.35],
  },
];
const DEATH_Q = DEATH_DEF.map((d) => {
  const mk = (k) => BONE_DEF.map(([n]) => (k[n] ? qE(k[n][0], k[n][1], k[n][2]) : new THREE.Quaternion()));
  return { t1: d.t1, t2: d.t2, k1: mk(d.k1), k2: mk(d.k2), p1: d.p1, p2: d.p2 };
});

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _q5 = new THREE.Quaternion(), _q6 = new THREE.Quaternion(), _q7 = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qd = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _e1 = new THREE.Euler();
const _ikD = new THREE.Vector3(), _ikU = new THREE.Vector3(), _ikV = new THREE.Vector3(), _ikE = new THREE.Vector3();
const _ikH = new THREE.Vector3(), _ikY = new THREE.Vector3(), _ikZ = new THREE.Vector3(), _ikT = new THREE.Vector3();
const _ikM = new THREE.Matrix4();

// Analytic two-bone IK in the parent space of the upper bone. Bones point along local -Y.
// hingeSign: +1 arms (elbow bends forward-flexing), -1 legs (knee).
function solveTwoBone(S, T, a, b, pole, hingeSign, qUpper, qLowerLocal, qLowerParent) {
  _ikD.subVectors(T, S);
  let d = _ikD.length();
  if (d < 1e-6) { _ikD.set(0, -1, 0); d = 1e-6; }
  _ikU.copy(_ikD).multiplyScalar(1 / d);
  d = clamp(d, Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
  _ikV.copy(pole).addScaledVector(_ikU, -pole.dot(_ikU));
  if (_ikV.lengthSq() < 1e-8) { _ikV.set(0, 0, 1).addScaledVector(_ikU, -_ikU.z); if (_ikV.lengthSq() < 1e-8) _ikV.set(1, 0, 0); }
  _ikV.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  _ikE.copy(S).addScaledVector(_ikU, x).addScaledVector(_ikV, h);
  _ikH.crossVectors(_ikV, _ikU).multiplyScalar(hingeSign).normalize();
  _ikY.subVectors(S, _ikE).normalize();
  _ikZ.crossVectors(_ikH, _ikY);
  _ikM.makeBasis(_ikH, _ikY, _ikZ);
  qUpper.setFromRotationMatrix(_ikM);
  _ikT.copy(S).addScaledVector(_ikU, d);
  _ikY.subVectors(_ikE, _ikT).normalize();
  _ikZ.crossVectors(_ikH, _ikY);
  _ikM.makeBasis(_ikH, _ikY, _ikZ);
  qLowerParent.setFromRotationMatrix(_ikM);
  qLowerLocal.copy(qUpper).invert().multiply(qLowerParent);
}

// ------------------------------------------------------------------------------------------------
// Model cache
// ------------------------------------------------------------------------------------------------
const _models = new Map();
function getModel(kind, skin, level) {
  const key = kind === 'human' ? 'human:' + skin : kind === 'zombie' ? 'zombie:' + level : kind;
  let m = _models.get(key);
  if (!m) {
    if (kind === 'human') m = buildHuman(skin);
    else if (kind === 'zombie') m = buildZombie(level, false);
    else if (kind === 'mother') m = buildZombie(3, true);
    else if (kind === 'terminator') m = buildTerminator();
    else m = buildHunter();
    m.pal = { ...DEFAULT_PAL, ...m.pal };
    _models.set(key, m);
  }
  return m;
}
const ARC_N = 4, ARC_SEGS = 7;

// ------------------------------------------------------------------------------------------------
// Character
// ------------------------------------------------------------------------------------------------
class Character {
  constructor(kind, skin, level) {
    this.kind = kind;
    this.skin = skin;
    this.level = level;
    const model = getModel(kind, skin, level);
    const R = (this.rig = model.rig);
    this.height = kind === 'human' ? 1.8 : kind === 'hunter' ? 1.9 : kind === 'zombie' ? 1.95 + 0.05 * (level - 1) : kind === 'mother' ? 2.05 : 2.5;
    this.radius = kind === 'human' ? 0.35 : kind === 'hunter' ? 0.37 : kind === 'zombie' ? 0.4 + 0.02 * (level - 1) : kind === 'mother' ? 0.42 : 0.6;
    this.headRadius = R.headRadius;
    this.mat = makeCharMaterial(model.pal);
    this.root = new THREE.Group();
    this.root.name = 'char_' + kind;
    const b = (this.b = {});
    this.boneList = [];
    for (const [name, parent] of BONE_DEF) {
      const o = new THREE.Object3D();
      o.name = name;
      b[name] = o;
      (parent ? b[parent] : this.root).add(o);
      this.boneList.push(o);
    }
    if (R.extraBones) {
      for (const name in R.extraBones) {
        const e = R.extraBones[name];
        const o = new THREE.Object3D();
        o.name = name;
        o.position.fromArray(e.pos);
        b[e.parent].add(o);
        b[name] = o;
      }
    }
    b.hips.position.set(0, R.hipsY, 0);
    b.spine.position.fromArray(R.spine);
    b.chest.position.fromArray(R.chest);
    b.neck.position.fromArray(R.neck);
    b.head.position.fromArray(R.head);
    b.upperArmL.position.set(-R.shoulder[0], R.shoulder[1], R.shoulder[2]);
    b.upperArmR.position.fromArray(R.shoulder);
    b.foreArmL.position.set(0, -R.upperLen, 0);
    b.foreArmR.position.set(0, -R.upperLen, 0);
    b.handL.position.set(0, -R.foreLen, 0);
    b.handR.position.set(0, -R.foreLen, 0);
    b.thighL.position.set(-R.hip[0], R.hip[1], R.hip[2]);
    b.thighR.position.fromArray(R.hip);
    b.shinL.position.set(0, -R.thighLen, 0);
    b.shinR.position.set(0, -R.thighLen, 0);
    b.footL.position.set(0, -R.shinLen, 0);
    b.footR.position.set(0, -R.shinLen, 0);
    this.meshes = [];
    for (const name in model.geos) {
      const bone = b[name];
      if (!bone) continue;
      const mesh = new THREE.Mesh(model.geos[name], this.mat);
      mesh.name = name + '_mesh';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      bone.add(mesh);
      this.meshes.push(mesh);
    }
    this.aimPivot = new THREE.Object3D();
    this.aimPivot.name = 'aimPivot';
    this.aimPivot.position.fromArray(R.aimPivot || [0, R.shoulder[1], 0]);
    b.chest.add(this.aimPivot);
    this.gunMount = new THREE.Object3D();
    this.gunMount.name = 'gunMount';
    this.gunMount.rotation.order = 'YXZ';
    this.aimPivot.add(this.gunMount);
    this.headCenter = new THREE.Vector3().fromArray(R.headCenter);
    this.palmR = new THREE.Vector3().fromArray(R.palm);
    this.palmL = new THREE.Vector3(-R.palm[0], R.palm[1], R.palm[2]);
    this.legK = (R.thighLen + R.shinLen) / 0.875;

    // state
    this.armed = kind === 'human' || kind === 'hunter';
    this.t = 0; this.phase = 0; this.stride = 1; this.climbPhase = 0;
    this.moveAmt = 0; this.runAmt = 0; this.crouchAmt = 0; this.airAmt = 0; this.climbAmt = 0;
    this.dirX = 0; this.dirZ = -1; this.pitchS = 0; this.stanceS = 0;
    this.reloadAmt = 0; this.reloadT = 0;
    this.recoil = 0; this.recoilV = 0; this.jitX = 0; this.jitY = 0; this.shotT = 0; this._prevFire = false;
    this.attackT = -1; this.attackDur = 0.5; this.atkTrack = null; this._prevAtk = 0;
    this._atkYaw = 0; this._atkPitch = 0; this._atkDrop = 0; this._atkEnv = 0; this.charge = 0;
    this.hurtT = 0; this.hurtSide = 1; this._prevHurt = false;
    this.dead = false; this.deathT = 0; this.deathVar = 0;
    this.flashT = 0; this.flashDur = 0.15; this.flashC = new THREE.Color();
    this.twitchT = 1 + Math.random() * 2; this.twitchA = 0; this.twitchK = 0;
    this.seed = Math.random();
    this._snap = this.boneList.map(() => new THREE.Quaternion());
    this._snapHips = new THREE.Vector3();
    this._trk = new Float32Array(16);
    this._fk = new Float32Array(12);
    this._ft = [new THREE.Vector3(), new THREE.Vector3()];
    this._fp = [0, 0];
    this._fy = [0, 0];
    this._hand = [new THREE.Vector3(), new THREE.Vector3()];
    this._handQ = [new THREE.Quaternion(), new THREE.Quaternion()];
    this._rk = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._ikQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
    this.weapon = null; this.weaponId = null; this.wclass = 'rifle'; this.muzzle = null;
    this.foreLocal = new THREE.Vector3();
    this.fireRate = 0; this.recoilK = 0; this._wpnHidden = false;
    this.arcs = null;
    if (kind === 'terminator') this._makeArcs();
    if (this.armed) this.setWeapon(kind === 'hunter' ? 'blade' : 'ak47');
    this.update(0, EMPTY_STATE);
  }

  // ---------------------------------------------------------------------------------------------
  setWeapon(id) {
    if (!this.armed) return;
    if (this.kind === 'hunter' && classifyWeapon(id) !== 'blade') id = 'blade';
    if (id === this.weaponId && this.weapon) return;
    if (this.weapon) { this.gunMount.remove(this.weapon); this.weapon = null; }
    this.weaponId = id;
    this.wclass = classifyWeapon(id);
    let w = null;
    if (weaponFactory) {
      try { w = weaponFactory(id, { lod: 'tp' }); } catch (e) { console.warn('characterModel: weapon factory failed for', id, e); w = null; }
    }
    if (!w) w = makePlaceholderWeapon(id);
    w.traverse((o) => { if (o.isMesh && !(o.material && o.material.transparent)) { o.castShadow = true; o.receiveShadow = true; } });
    this.gunMount.add(w);
    this.weapon = w;
    this.muzzle = w.getObjectByName('muzzle') || null;
    const fg = this.wclass === 'pistol' ? null : w.getObjectByName('foregrip');
    if (fg && fg !== w) {
      _m1.identity();
      for (let o = fg; o && o !== w; o = o.parent) { o.updateMatrix(); _m1.premultiply(o.matrix); }
      this.foreLocal.setFromMatrixPosition(_m1);
    } else this.foreLocal.fromArray(WDEFAULT_FORE[this.wclass]);
    const f = WFIRE[this.wclass];
    this.fireRate = f[0];
    this.recoilK = f[1];
    this._wpnHidden = false;
    w.visible = !this.dead;
  }

  flash(hexColor = 0xff0000, duration = 0.15) {
    this.flashC.setHex(hexColor);
    this.flashDur = Math.max(0.01, duration);
    this.flashT = this.flashDur;
  }

  getMuzzleWorldPos(out = new THREE.Vector3()) {
    const m = this.muzzle && this.weapon && this.weapon.visible ? this.muzzle : this.b.handR;
    m.updateWorldMatrix(true, false);
    if (m === this.b.handR) return out.copy(this.palmR).applyMatrix4(m.matrixWorld);
    return out.setFromMatrixPosition(m.matrixWorld);
  }

  getHeadWorldPos(out = new THREE.Vector3()) {
    this.b.head.updateWorldMatrix(true, false);
    return out.copy(this.headCenter).applyMatrix4(this.b.head.matrixWorld);
  }

  setVisible(v) { this.root.visible = !!v; }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this.weapon) { this.gunMount.remove(this.weapon); this.weapon = null; }
    this.mat.dispose();
    if (this.arcs) {
      for (const a of this.arcs) { a.geometry.dispose(); if (a.parent) a.parent.remove(a); }
      this.arcMat.dispose();
      this.arcs = null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  update(dt, s = EMPTY_STATE) {
    if (!s) s = EMPTY_STATE;
    dt = clamp(+dt || 0, 0, 0.1);
    this.t += dt;
    const dead = !!s.dead;
    if (dead !== this.dead) {
      this.dead = dead;
      if (dead) this._startDeath(); else this._revive();
    }
    if (this.dead) {
      this.deathT += dt;
      this._poseDeath();
      this._fx(dt);
      return;
    }
    const atk = s.attack | 0;
    if (atk && !this._prevAtk) this._startAttack(atk);
    this._prevAtk = atk;
    const hurt = !!s.hurt;
    if (hurt && !this._prevHurt) { this.hurtT = 0.32; this.hurtSide = Math.random() < 0.5 ? -1 : 1; }
    this._prevHurt = hurt;
    if (this.hurtT > 0) this.hurtT = Math.max(0, this.hurtT - dt);
    if (this.attackT >= 0) {
      this.attackT += dt;
      if (this.attackT >= this.attackDur) { this.attackT = -1; this._wpnHidden = false; }
    }
    this._locomotion(dt, s);
    this._evalAttack();
    this._poseBody(dt);
    if (this.armed) this._poseArmsArmed(); else this._poseArmsFK();
    this._fx(dt);
  }

  _locomotion(dt, s) {
    const R = this.rig;
    const speed = Math.max(0, +s.speed || 0);
    const onGround = s.onGround !== false;
    const climbing = !!s.climbing;
    const grounded = onGround && !climbing;
    this.crouchAmt = damp(this.crouchAmt, s.crouch && grounded ? 1 : 0, 9, dt);
    this.airAmt = damp(this.airAmt, !onGround && !climbing ? 1 : 0, onGround ? 14 : 8, dt);
    this.climbAmt = damp(this.climbAmt, climbing ? 1 : 0, 6, dt);
    this.moveAmt = damp(this.moveAmt, grounded ? clamp(speed / 0.8, 0, 1) : 0, 7, dt);
    this.runAmt = damp(this.runAmt, grounded ? sstep(R.walkSpeed, R.runSpeed, speed) * (1 - 0.85 * this.crouchAmt) : 0, 5, dt);
    if (speed > 0.05) {
      const sx = clamp(+s.strafe || 0, -1, 1);
      const fz = Math.sqrt(Math.max(0, 1 - sx * sx));
      const tz = s.back ? fz : -fz;
      this.dirX = damp(this.dirX, sx, 10, dt);
      this.dirZ = damp(this.dirZ, tz, 10, dt);
      const l = Math.hypot(this.dirX, this.dirZ);
      if (l > 1e-3) { this.dirX /= l; this.dirZ /= l; } else { this.dirX = sx; this.dirZ = tz; }
    }
    const legK = this.legK;
    let stride = (0.9 + 0.28 * speed) * legK * R.strideK;
    stride = lerp(stride, (0.62 + 0.22 * speed) * legK, this.crouchAmt);
    stride *= lerp(1, 0.8, Math.abs(this.dirX));
    if (this.dirZ > 0.3) stride *= 0.85;
    this.stride = clamp(stride, 0.5 * legK, 2.9 * legK);
    if (grounded) { this.phase += (speed * dt) / this.stride; this.phase -= Math.floor(this.phase); }
    if (climbing) {
      const cs = s.climbSpeed;
      const has = typeof cs === 'number';
      const rate = has ? Math.abs(cs) / (0.6 * R.scale) : 0.85;
      this.climbPhase += rate * dt * (has && cs < 0 ? -1 : 1);
      this.climbPhase -= Math.floor(this.climbPhase);
    }
    this.pitchS = damp(this.pitchS, clamp(+s.pitch || 0, -1.45, 1.45), 18, dt);
    // reload / fire (armed only)
    const reloading = !!s.reloading && this.armed && this.wclass !== 'knife' && this.wclass !== 'grenade' && this.wclass !== 'blade';
    this.reloadAmt = damp(this.reloadAmt, reloading ? 1 : 0, 8, dt);
    if (reloading) this.reloadT += dt; else if (this.reloadAmt < 0.02) this.reloadT = 0;
    const firing = !!s.firing && this.armed;
    if (this.wclass === 'grenade') {
      if (firing && !this._prevFire && this.attackT < 0) this._startAttack(1);
    } else if (firing && this.fireRate > 0 && this.reloadAmt < 0.5 && this.attackT < 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT += 1 / this.fireRate;
        if (this.shotT < 0) this.shotT = 0;
        this.recoilV += 9 * this.recoilK;
        this.jitX = (Math.random() - 0.3) * 0.025 * this.recoilK;
        this.jitY = (Math.random() - 0.5) * 0.035 * this.recoilK;
      }
    } else this.shotT = 0;
    this._prevFire = firing;
    const n = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.recoilV += (-170 * this.recoil - 17 * this.recoilV) * h;
      this.recoil += this.recoilV * h;
    }
    this.jitX = damp(this.jitX, 0, 9, dt);
    this.jitY = damp(this.jitY, 0, 9, dt);
    // zombie head twitch
    if (!this.armed) {
      this.twitchT -= dt;
      if (this.twitchT < 0) { this.twitchT = 1.2 + Math.random() * 3.2; this.twitchA = (Math.random() - 0.5) * 0.9; this.twitchK = 1; }
      this.twitchK = damp(this.twitchK, 0, 5, dt);
    }
  }

  _startAttack(type) {
    let tr;
    if (this.armed) {
      const w = this.wclass;
      if (w === 'knife') tr = type === 2 ? TR.knife2 : TR.knife1;
      else if (w === 'blade') tr = type === 2 ? TR.blade2 : TR.blade1;
      else if (w === 'grenade') tr = TR.throw;
      else tr = TR.bash;
    } else if (this.kind === 'terminator') tr = type === 2 ? TR.term2 : TR.term1;
    else tr = type === 2 ? TR.claw2 : TR.claw1;
    this.atkTrack = tr;
    this.attackT = 0;
    this.attackDur = tr.dur;
  }

  _evalAttack() {
    this._atkYaw = this._atkPitch = this._atkDrop = 0;
    this.charge = 0;
    this._atkEnv = 0;
    if (this.attackT < 0 || !this.atkTrack) return;
    const tr = this.atkTrack;
    const t = clamp(this.attackT / tr.dur, 0, 1);
    evalTrack(tr, t, this._trk);
    const env = sstep(0, 0.1, t) * (1 - sstep(0.86, 1, t));
    this._atkEnv = tr.additive ? 1 : env;
    const o = tr.fk ? 8 : 6;
    this._atkYaw = this._trk[o] * env;
    this._atkPitch = this._trk[o + 1] * env;
    this._atkDrop = this._trk[o + 2] * env;
    this.charge = this._trk[o + 3] * env;
    if (this.wclass === 'grenade' && this.armed) this._wpnHidden = t > 0.56;
  }

  _footTarget(side) {
    const R = this.rig, sc = R.scale, out = this._ft[side];
    const sx = side ? 1 : -1;
    const m = this.moveAmt, run = this.runAmt, cr = this.crouchAmt;
    const ph = (this.phase + (side ? 0.5 : 0)) % 1;
    const beta = lerp(0.62, 0.38, run);
    const L = this.stride;
    let along, lift = 0, pitch;
    if (ph < beta) {
      const u = ph / beta;
      along = L * beta * (0.5 - u);
      pitch = 0.22 * (1 - sstep(0, 0.18, u)) - 0.42 * sstep(0.62, 1, u);
    } else {
      const u = (ph - beta) / (1 - beta);
      along = L * beta * (smooth(u) - 0.5);
      lift = Math.sin(PI * u) * lerp(R.liftWalk, R.liftRun, run) * (1 - 0.45 * cr);
      pitch = lerp(-0.42, 0.22, sstep(0.05, 0.85, u));
    }
    along *= m; lift *= m; pitch *= m;
    pitch -= 0.35 * cr * (side ? 1 : 0.15);
    const heel = pitch < 0 ? Math.sin(-pitch) * 0.11 * sc : Math.sin(pitch) * 0.045 * sc;
    const fx = sx * lerp(R.footX, R.footX * 1.45, cr);
    const fz = lerp(sx * R.footZ, side ? 0.12 * sc : -0.11 * sc, cr);
    const cross = ph >= beta ? Math.sin((PI * (ph - beta)) / (1 - beta)) * Math.abs(this.dirX) * 0.1 * sc * m : 0;
    out.set(fx + this.dirX * along, R.ankleH + lift + heel, fz + this.dirZ * along - cross);
    if (this.airAmt > 0.001) {
      _v1.set(sx * R.footX * 1.1, R.ankleH + (side ? 0.2 : 0.3) * sc * this.legK, side ? 0.1 * sc : -0.14 * sc);
      out.lerp(_v1, this.airAmt);
      pitch = lerp(pitch, side ? -0.45 : 0.1, this.airAmt);
    }
    if (this.climbAmt > 0.001) {
      this._climbTarget(0, side, _v1);
      out.lerp(_v1, this.climbAmt);
      pitch = lerp(pitch, 0.05, this.climbAmt);
    }
    this._fp[side] = pitch;
    this._fy[side] = -sx * 0.1;
  }

  _climbTarget(limb, side, out) {
    const R = this.rig, sc = R.scale;
    const rung = 0.3 * sc;
    const ph = (this.climbPhase + (side ? 0.5 : 0) + (limb ? 0.5 : 0)) % 1;
    const beta = 0.6;
    let dy, dz;
    if (ph < beta) { dy = rung * (0.5 - ph / beta); dz = 0; }
    else { const u = (ph - beta) / (1 - beta); dy = rung * (smooth(u) - 0.5); dz = Math.sin(PI * u) * 0.06 * sc; }
    const sx = side ? 1 : -1;
    if (limb === 0) out.set(sx * 0.12 * sc, R.ankleH + 0.14 * sc * this.legK + dy, -0.2 * sc + dz);
    else out.set(sx * 0.2 * sc, R.hipsY + 0.58 * sc + dy, -0.3 * sc + dz);
  }

  _legIK(side) {
    const R = this.rig, b = this.b;
    const th = side ? b.thighR : b.thighL, sh = side ? b.shinR : b.shinL, ft = side ? b.footR : b.footL;
    _q1.copy(b.hips.quaternion).invert();
    _v2.copy(this._ft[side]).sub(b.hips.position).applyQuaternion(_q1);
    _v3.set((side ? 1 : -1) * 0.15, 0, -1).applyQuaternion(_q1);
    solveTwoBone(th.position, _v2, R.thighLen, R.shinLen, _v3, -1, th.quaternion, sh.quaternion, _q2);
    _e1.set(this._fp[side], this._fy[side], 0, 'YXZ');
    _q3.setFromEuler(_e1);
    ft.quaternion.copy(_q2).invert().multiply(_q1).multiply(_q3);
  }

  _poseBody(dt) {
    const R = this.rig, b = this.b, sc = R.scale;
    const m = this.moveAmt, run = this.runAmt, cr = this.crouchAmt, clb = this.climbAmt;
    const ph = this.phase, t = this.t;
    const beta = lerp(0.62, 0.38, run);
    const hk = this.hurtT > 0 ? Math.sin((1 - this.hurtT / 0.32) * PI) : 0;
    const c4 = Math.cos(4 * PI * (ph - beta * 0.5));
    let hy = R.hipsY - R.crouchDrop * cr - this._atkDrop * sc;
    hy += m * (lerp(0.012, -0.03, run) * c4 * R.bobK - 0.035 * run) * sc;
    hy -= clb * 0.03 * sc;
    hy += Math.sin(t * 1.7) * 0.004 * sc * (1 - m);
    hy -= this.airAmt * 0.02 * sc;
    const swayX = -Math.cos(TAU * (ph - beta * 0.5)) * 0.022 * sc * m * R.bobK;
    const fwd = -this.dirZ;
    const lean = (fwd > 0 ? 1 : 0.6) * fwd * (0.04 * m + 0.17 * run);
    const roll = this.dirX * 0.12 * run;
    const idleX = Math.sin(t * 0.55 + this.seed * 5) * 0.012 * sc * (1 - m);
    b.hips.position.set(swayX + idleX, hy, 0.04 * sc * cr - clb * 0.06 * sc);
    const twist = Math.cos(TAU * ph) * 0.12 * m * (1 - 0.4 * run);
    this.stanceS = damp(this.stanceS, this.armed ? (WSTANCE[this.wclass] || 0) * (1 - 0.55 * run) * (1 - clb) * (1 - 0.3 * this.reloadAmt) : 0, 6, dt);
    const st = this.stanceS;
    _e1.set(-lean * 0.4 - 0.22 * cr - R.hunch * 0.25 - clb * 0.05, twist + st * 0.45 + this._atkYaw * 0.3, -roll * 0.5 - (swayX / sc) * 1.4, 'YXZ');
    b.hips.quaternion.setFromEuler(_e1);
    const breath = Math.sin(t * 1.9 + this.seed * 3) * (this.armed ? 0.012 : 0.03);
    const pk = this.armed ? 1 : 0.45;
    _e1.set(-lean * 0.35 + this.pitchS * 0.2 * pk - 0.12 * cr - R.hunch * 0.45 + this._atkPitch * 0.5 + hk * 0.12, -twist * 0.6 + st * 0.3 + this._atkYaw * 0.35, roll * 0.25, 'YXZ');
    b.spine.quaternion.setFromEuler(_e1);
    _e1.set(-lean * 0.25 + this.pitchS * 0.3 * pk + breath - 0.05 * cr - R.hunch * 0.4 + this._atkPitch * 0.5 + hk * 0.15, -twist * 0.5 + st * 0.25 + this._atkYaw * 0.35 + hk * 0.1 * this.hurtSide, roll * 0.2 + hk * 0.06 * this.hurtSide, 'YXZ');
    b.chest.quaternion.setFromEuler(_e1);
    // head: stabilized toward aim direction
    _qc.copy(b.hips.quaternion).multiply(b.spine.quaternion).multiply(b.chest.quaternion);
    let hp, hyw = 0, hr = 0;
    const W = this.wclass;
    if (this.armed) {
      hp = this.pitchS * 0.9 - hk * 0.3;
      if ((W === 'rifle' || W === 'mg') && this.reloadAmt < 0.5) { hp -= 0.06; hyw = 0.06; hr = -0.1; }
      if (this.reloadAmt > 0.01) { hp -= 0.35 * this.reloadAmt; hyw += 0.15 * this.reloadAmt; }
    } else {
      hp = this.pitchS * 0.6 - 0.05 - hk * 0.35 + (R.headDroop || 0);
      hr = this.twitchA * this.twitchK;
      hyw = this.twitchA * this.twitchK * 0.5 + Math.sin(t * 0.7 + this.seed * 9) * 0.12 * (1 - m);
    }
    _e1.set(hp, hyw, hr, 'YXZ');
    _q2.setFromEuler(_e1);
    _q3.copy(_qc).invert().multiply(_q2);
    b.neck.quaternion.copy(Q_ID).slerp(_q3, 0.4);
    if (R.neckBaseQ) b.neck.quaternion.multiply(R.neckBaseQ);
    _q4.copy(_qc).multiply(b.neck.quaternion);
    b.head.quaternion.copy(_q4).invert().multiply(_q2);
    // tail (ponytail)
    if (b.tail) {
      _e1.set(-0.25 - 0.45 * run + this.pitchS * 0.7 + Math.sin(TAU * ph * 2) * 0.08 * m, 0, Math.sin(TAU * ph) * 0.12 * m, 'XYZ');
      b.tail.quaternion.setFromEuler(_e1);
    }
    // legs
    this._footTarget(0);
    this._footTarget(1);
    this._legIK(0);
    this._legIK(1);
    void dt;
  }

  _chestInverse() {
    const b = this.b;
    b.hips.updateMatrix(); b.spine.updateMatrix(); b.chest.updateMatrix();
    _m2.multiplyMatrices(b.hips.matrix, b.spine.matrix).multiply(b.chest.matrix);
    _m3.copy(_m2).invert();
  }

  _armIK(side, tgt, q, pole, qu, qf, qh) {
    const R = this.rig, b = this.b;
    const ua = side ? b.upperArmR : b.upperArmL;
    _v7.copy(side ? this.palmR : this.palmL).applyQuaternion(q);
    _v8.copy(tgt).sub(_v7);
    solveTwoBone(ua.position, _v8, R.upperLen, R.foreLen, pole, 1, qu, qf, _q7);
    qh.copy(_q7).invert().multiply(q);
  }

  _poseArmsArmed() {
    const R = this.rig, b = this.b, sc = R.scale, W = this.wclass;
    const base = WPOSE[W] || WPOSE.rifle;
    const melee = W === 'knife' || W === 'grenade' || W === 'blade';
    const m = this.moveAmt, run = this.runAmt;
    const aimP = this.pitchS * (melee ? 0.5 : 1) + this.recoil * 0.05 + this.jitX;
    const swayY = Math.sin(TAU * this.phase) * 0.035 * m * (melee ? 1.5 : 1) + this.jitY;
    _e1.set(aimP, swayY, 0, 'YXZ');
    _q2.setFromEuler(_e1);
    _q3.copy(_qc).invert().multiply(_q2);
    if (melee) this.aimPivot.quaternion.copy(Q_ID).slerp(_q3, 0.55);
    else this.aimPivot.quaternion.copy(_q3);
    let px = base[0] * sc, py = base[1] * sc, pz = base[2] * sc, rx = base[3], ry = base[4], rz = base[5];
    const bob = Math.sin(TAU * this.phase * 2) * 0.012 * sc * m;
    if (!melee) {
      py += -0.03 * sc * run + bob;
      rx -= 0.14 * run;
      px -= 0.01 * sc * run;
    } else {
      const sw = Math.cos(TAU * this.phase);
      pz += sw * 0.1 * sc * run;
      py += bob - 0.05 * sc * run;
      rx -= 0.35 * run;
    }
    const rl = this.reloadAmt;
    if (rl > 0.001 && !melee) {
      if (W === 'pistol') { rx += 0.35 * rl; rz += 0.35 * rl; pz += 0.14 * sc * rl; py -= 0.03 * sc * rl; px -= 0.03 * sc * rl; }
      else { rz += 0.55 * rl; rx -= 0.22 * rl; py -= 0.07 * sc * rl; pz += 0.08 * sc * rl; px -= 0.05 * sc * rl; }
    }
    if (this.attackT >= 0 && this.atkTrack) {
      const T = this._trk, e = this._atkEnv;
      if (this.atkTrack.additive) { px += T[0] * sc; py += T[1] * sc; pz += T[2] * sc; rx += T[3]; ry += T[4]; rz += T[5]; }
      else { px = lerp(px, T[0] * sc, e); py = lerp(py, T[1] * sc, e); pz = lerp(pz, T[2] * sc, e); rx = lerp(rx, T[3], e); ry = lerp(ry, T[4], e); rz = lerp(rz, T[5], e); }
    }
    pz += this.recoil * 0.045 * sc;
    rx += this.recoil * 0.07;
    this.gunMount.position.set(px, py, pz);
    this.gunMount.rotation.set(rx, ry, rz);
    this.aimPivot.updateMatrix();
    this.gunMount.updateMatrix();
    _m1.multiplyMatrices(this.aimPivot.matrix, this.gunMount.matrix);
    if (W === 'rifle' || W === 'mg') {
      // keep the support hand within reach: slide the weapon back along its axis if needed
      _v4.copy(this.foreLocal).applyMatrix4(_m1);
      const reach = (R.upperLen + R.foreLen) * 0.93 + 0.07 * sc;
      const d = _v4.distanceTo(b.upperArmL.position);
      if (d > reach) {
        this.gunMount.position.z += Math.min(0.14 * sc, d - reach);
        this.gunMount.updateMatrix();
        _m1.multiplyMatrices(this.aimPivot.matrix, this.gunMount.matrix);
      }
    }
    _q3.copy(this.aimPivot.quaternion).multiply(this.gunMount.quaternion);
    const tR = this._hand[1], qR = this._handQ[1], tL = this._hand[0], qL = this._handQ[0];
    tR.set(0, 0, 0).applyMatrix4(_m1);
    qR.copy(_q3).multiply(melee ? GRIP_MELEE : GRIP_R);
    if (W === 'rifle' || W === 'mg') { tL.copy(this.foreLocal).applyMatrix4(_m1); qL.copy(_q3).multiply(GRIP_L_FORE); }
    else if (W === 'pistol') { tL.copy(PISTOL_SUPPORT).applyMatrix4(_m1); qL.copy(_q3).multiply(GRIP_L_PISTOL); }
    else {
      const sw = Math.cos(TAU * this.phase) * run;
      tL.set(-0.12 * sc, (0.06 - 0.04 * run) * sc + bob, (-0.2 - sw * 0.08) * sc);
      qL.copy(GUARD_L);
    }
    if (rl > 0.01 && !melee) this._reloadLeft(tL, qL, rl);
    let pr = POLE_R, pl = POLE_L;
    if (this.climbAmt > 0.001) {
      this._chestInverse();
      _q5.copy(_qc).invert();
      for (let side = 0; side < 2; side++) {
        this._climbTarget(1, side, _v6);
        _v6.applyMatrix4(_m3);
        this._hand[side].lerp(_v6, this.climbAmt);
        _q6.copy(_q5).multiply(side ? CLIMB_R : CLIMB_L);
        this._handQ[side].slerp(_q6, this.climbAmt);
      }
      if (this.climbAmt > 0.5) { pr = POLE_CLIMB_R; pl = POLE_CLIMB_L; }
    }
    this._armIK(1, tR, qR, pr, b.upperArmR.quaternion, b.foreArmR.quaternion, b.handR.quaternion);
    this._armIK(0, tL, qL, pl, b.upperArmL.quaternion, b.foreArmL.quaternion, b.handL.quaternion);
    if (this.weapon) this.weapon.visible = this.climbAmt < 0.5 && !this._wpnHidden;
  }

  _reloadLeft(tL, qL, rl) {
    const W = this.wclass, sc = this.rig.scale, K = this._rk;
    const dur = W === 'pistol' ? 1.6 : W === 'mg' ? 2.8 : 2.1;
    const u = (this.reloadT / dur) % 1;
    K[0].copy(tL);
    if (W === 'pistol') {
      K[1].set(-0.11 * sc, -0.26 * sc, -0.1 * sc);
      K[2].set(0, -0.12, 0.018).applyMatrix4(_m1);
      K[3].copy(K[2]);
    } else {
      K[1].set(0, -0.07, -0.12).applyMatrix4(_m1);
      K[2].set(-0.06 * sc, -0.02 * sc, -0.2 * sc);
      K[3].set(0, -0.05, -0.105).applyMatrix4(_m1);
    }
    let a, bI, f;
    if (u < 0.12) { a = 0; bI = 1; f = u / 0.12; }
    else if (u < 0.35) { a = 1; bI = 2; f = (u - 0.12) / 0.23; }
    else if (u < 0.5) { a = 2; bI = 2; f = 0; }
    else if (u < 0.7) { a = 2; bI = 3; f = (u - 0.5) / 0.2; }
    else if (u < 0.82) { a = 3; bI = 3; f = 0; }
    else { a = 3; bI = 0; f = (u - 0.82) / 0.18; }
    _v5.copy(K[a]).lerp(K[bI], smooth(f));
    if (u >= 0.7 && u < 0.82) _v5.y += Math.sin(((u - 0.7) / 0.12) * PI) * 0.025 * sc;
    tL.lerp(_v5, rl);
    const away = (u > 0.1 && u < 0.72) ? 1 : 0;
    if (away) { _q6.copy(GUARD_L); qL.slerp(_q6, rl * 0.6); }
  }

  _poseArmsFK() {
    const R = this.rig, b = this.b, A = this._fk;
    const m = this.moveAmt, run = this.runAmt, t = this.t;
    const big = this.kind === 'terminator';
    const sw = Math.cos(TAU * this.phase);
    let rUx = big ? 0.42 : 0.72, rUz = big ? 0.4 : 0.16, rFx = big ? 0.75 : 0.6;
    const idleSw = Math.sin(t * 1.3 + this.seed * 6) * 0.06;
    const amp = lerp(big ? 0.3 : 0.28, big ? 0.6 : 0.95, run) * m;
    const baseX = lerp(rUx, big ? 0.35 : lerp(0.85, 0.55, run), m);
    const hk = this.hurtT > 0 ? Math.sin((1 - this.hurtT / 0.32) * PI) : 0;
    rFx = lerp(rFx, big ? lerp(0.7, 1.05, run) : lerp(0.5, 1.3, run), m);
    rUz = lerp(rUz, big ? 0.42 : lerp(0.18, 0.3, run), m);
    A[0] = baseX + amp * sw + idleSw * (1 - m) + hk * 0.4;
    A[1] = 0;
    A[2] = rUz;
    A[3] = rFx + 0.2 * m * Math.max(0, sw) + hk * 0.5;
    A[4] = baseX - amp * sw - idleSw * 0.8 * (1 - m) + hk * 0.4;
    A[5] = 0;
    A[6] = -rUz;
    A[7] = rFx + 0.2 * m * Math.max(0, -sw) + hk * 0.5;
    if (this.airAmt > 0.01) {
      const a = this.airAmt;
      A[0] = lerp(A[0], 0.9, a); A[4] = lerp(A[4], 0.9, a); A[2] = lerp(A[2], 0.5, a); A[6] = lerp(A[6], -0.5, a);
    }
    if (this.attackT >= 0 && this.atkTrack && this.atkTrack.fk) {
      const e = this._atkEnv, T = this._trk;
      for (let i = 0; i < 8; i++) A[i] = lerp(A[i], T[i], e);
    }
    _e1.set(A[0], A[1], A[2], 'ZXY'); b.upperArmR.quaternion.setFromEuler(_e1);
    _e1.set(A[3], 0, 0, 'XYZ'); b.foreArmR.quaternion.setFromEuler(_e1);
    _e1.set(A[4], A[5], A[6], 'ZXY'); b.upperArmL.quaternion.setFromEuler(_e1);
    _e1.set(A[7], 0, 0, 'XYZ'); b.foreArmL.quaternion.setFromEuler(_e1);
    const wr = big ? 0.1 : 0.25 + 0.1 * Math.sin(t * 2.1 + this.seed);
    _e1.set(wr, 0, 0.1, 'XYZ'); b.handR.quaternion.setFromEuler(_e1);
    _e1.set(wr, 0, -0.1, 'XYZ'); b.handL.quaternion.setFromEuler(_e1);
    if (this.climbAmt > 0.001) {
      this._chestInverse();
      _q5.copy(_qc).invert();
      const Q = this._ikQ;
      for (let side = 0; side < 2; side++) {
        this._climbTarget(1, side, _v6);
        _v6.applyMatrix4(_m3);
        _q6.copy(_q5).multiply(side ? CLIMB_R : CLIMB_L);
        this._armIK(side, _v6, _q6, side ? POLE_CLIMB_R : POLE_CLIMB_L, Q[0], Q[1], Q[2]);
        const c = this.climbAmt;
        (side ? b.upperArmR : b.upperArmL).quaternion.slerp(Q[0], c);
        (side ? b.foreArmR : b.foreArmL).quaternion.slerp(Q[1], c);
        (side ? b.handR : b.handL).quaternion.slerp(Q[2], c);
      }
    }
  }

  _startDeath() {
    this.deathT = 0;
    const zombieLike = !this.armed;
    const r = Math.random();
    this.deathVar = zombieLike ? (r < 0.55 ? 2 : r < 0.8 ? 1 : 0) : (r < 0.6 ? 0 : 1);
    if (this._forceDeathVar !== undefined) this.deathVar = this._forceDeathVar;
    for (let i = 0; i < this.boneList.length; i++) this._snap[i].copy(this.boneList[i].quaternion);
    this._snapHips.copy(this.b.hips.position);
    this.attackT = -1;
    this.charge = 0;
  }

  _poseDeath() {
    const t = this.deathT, R = this.rig, D = DEATH_Q[this.deathVar];
    const hp = this.b.hips.position;
    const L = this.boneList;
    if (t < D.t1) {
      const a = 1 - Math.pow(1 - t / D.t1, 2);
      for (let i = 0; i < L.length; i++) L[i].quaternion.copy(this._snap[i]).slerp(D.k1[i], a);
      _v1.set(0, R.hipsY * D.p1[0], D.p1[1] * R.scale * this.legK);
      hp.copy(this._snapHips).lerp(_v1, a);
    } else {
      const u = clamp((t - D.t1) / (D.t2 - D.t1), 0, 1);
      const a = u * u;
      for (let i = 0; i < L.length; i++) L[i].quaternion.copy(D.k1[i]).slerp(D.k2[i], a);
      let y = lerp(R.hipsY * D.p1[0], R.bodyThick, a);
      if (t > D.t2) { const e = t - D.t2; y += R.bodyThick * 0.3 * Math.exp(-7 * e) * Math.abs(Math.sin(e * 14)); }
      hp.set(0, y, lerp(D.p1[1], D.p2[1], a) * R.scale * this.legK);
    }
    if (this.weapon) this.weapon.visible = t < 0.22;
  }

  _revive() {
    this.deathT = 0;
    this.moveAmt = this.runAmt = this.airAmt = this.climbAmt = this.crouchAmt = 0;
    this.recoil = this.recoilV = 0;
    this.attackT = -1;
    this.reloadAmt = 0;
    this._wpnHidden = false;
    if (this.weapon) this.weapon.visible = true;
  }

  _fx(dt) {
    const u = this.mat.userData.u;
    u.uTime.value = this.t + this.seed * 13;
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      const a = this.flashT / this.flashDur;
      u.uFlash.value.set(this.flashC.r, this.flashC.g, this.flashC.b, a * a * 1.6);
    } else u.uFlash.value.w = 0;
    u.uCharge.value = damp(u.uCharge.value, this.charge, 14, dt);
    if (this.arcs) this._updateArcs(dt);
  }

  _makeArcs() {
    this.arcs = [];
    this.arcMat = new THREE.LineBasicMaterial({ color: 0x8ffcff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for (const side of ['L', 'R']) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(ARC_N * ARC_SEGS * 2 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      const ls = new THREE.LineSegments(geo, this.arcMat);
      ls.frustumCulled = false;
      ls.name = 'arcs' + side;
      ls.userData.sd = side === 'L' ? -1 : 1;
      this.b['hand' + side].add(ls);
      this.arcs.push(ls);
    }
    this.arcT = 0;
  }

  _updateArcs(dt) {
    this.arcT -= dt;
    const charge = this.mat.userData.u.uCharge.value;
    this.arcMat.opacity = clamp(0.3 + charge * 0.7 + (Math.random() < 0.12 ? 0.35 : 0), 0, 1);
    if (this.arcT > 0) return;
    this.arcT = 0.04 + Math.random() * 0.05;
    const sc = this.rig.scale;
    for (const ls of this.arcs) {
      const sd = ls.userData.sd;
      const pos = ls.geometry.attributes.position.array;
      const nA = charge > 0.3 ? ARC_N : 1 + ((Math.random() * 2.2) | 0);
      let k = 0;
      for (let a = 0; a < ARC_N; a++) {
        if (a >= nA) { for (let i = 0; i < ARC_SEGS * 6; i++) pos[k++] = 0; continue; }
        const r = (0.1 + charge * 0.06) * sc;
        const cx = -0.01 * sd * sc, cy = -0.13 * sc;
        let th = Math.random() * TAU, ph = (Math.random() - 0.5) * PI;
        const sx = cx + Math.cos(th) * Math.cos(ph) * r, sy = cy + Math.sin(ph) * r * 1.2, sz = Math.sin(th) * Math.cos(ph) * r;
        th += 1 + Math.random() * 2; ph = (Math.random() - 0.5) * PI;
        const ex = cx + Math.cos(th) * Math.cos(ph) * r, ey = cy + Math.sin(ph) * r * 1.2, ez = Math.sin(th) * Math.cos(ph) * r;
        let lx = sx, ly = sy, lz = sz;
        for (let i = 1; i <= ARC_SEGS; i++) {
          const f = i / ARC_SEGS;
          const j = i === ARC_SEGS ? 0 : 0.045 * sc * (1 + charge);
          const nx = lerp(sx, ex, f) * 1.15 + (Math.random() - 0.5) * j, ny = lerp(sy, ey, f) + (Math.random() - 0.5) * j, nz = lerp(sz, ez, f) * 1.15 + (Math.random() - 0.5) * j;
          pos[k++] = lx; pos[k++] = ly; pos[k++] = lz;
          pos[k++] = nx; pos[k++] = ny; pos[k++] = nz;
          lx = nx; ly = ny; lz = nz;
        }
      }
      ls.geometry.attributes.position.needsUpdate = true;
    }
  }
}

export function createCharacter({ kind = 'human', skin = 0, level = 1 } = {}) {
  const k = ['human', 'zombie', 'mother', 'terminator', 'hunter'].includes(kind) ? kind : 'human';
  const sk = clamp((skin | 0), 0, 3);
  const lv = clamp((level | 0) || 1, 1, 3);
  return new Character(k, k === 'human' ? sk : 0, k === 'zombie' ? lv : 1);
}
export { Character };

// ------------------------------------------------------------------------------------------------
// ZOMBIE (level 1..3) & MOTHER
// ------------------------------------------------------------------------------------------------
function raggedHem(seed, amp, from = 0.85) {
  return (v, t, th) => { if (t > from) v.y += (noise3(Math.cos(th) * 2.2 + seed, Math.sin(th) * 2.2, seed * 3) - 0.5) * amp * sstep(from, 1, t) * 2; };
}
function buildZombie(level, mother) {
  const L = mother ? 3 : level;
  const bk = mother ? 1.22 : 1 + 0.11 * (L - 1);
  const s = mother ? 1.05 : 1 + 0.02 * (L - 1);
  const pal = mother ? ZOMBIE_PALS.mother : ZOMBIE_PALS[L];
  const rig = {
    scale: s,
    hipsY: 1.03 * s, hip: [0.1 * s * Math.sqrt(bk), -0.05 * s, 0], thighLen: 0.49 * s, shinLen: 0.48 * s, ankleH: 0.075 * s,
    spine: [0, 0.11 * s, 0], chest: [0, 0.18 * s, 0], neck: [0, 0.27 * s, 0.012 * s], head: [0, 0.085 * s, -0.01 * s],
    shoulder: [0.19 * s * Math.sqrt(bk) * (mother ? 1.06 : 1), 0.21 * s, 0.012 * s], upperLen: 0.34 * s, foreLen: 0.32 * s,
    headCenter: [0, 0.09 * s, -0.018 * s], headRadius: 0.13 * s,
    footX: 0.13 * s, footZ: 0.07 * s, crouchDrop: 0.4 * s, liftWalk: 0.1 * s, liftRun: 0.24 * s,
    aimPivot: [0, 0.21 * s, 0], palm: [-0.03 * s, -0.12 * s, 0],
    walkSpeed: 2.0, runSpeed: 5.8, bodyThick: 0.12 * s * bk, strideK: 1.05, bobK: 1.4,
    hunch: mother ? 0.42 : 0.6, neckBaseQ: qE(mother ? -0.25 : -0.4, 0, 0), headDroop: 0.02,
  };
  const B = new Builder();
  const SK = M(PAT.ZSKIN, 0.62), BONE = M(PAT.BONE, 0.5), FL = M(PAT.FLESH, 0.3);
  const white = 0xffffff, boneC = 0xcbbb92, clawC = 0x3a3024, mouthC = 0x3a0907;
  const pantsMat = M(PAT.DENIM, 0.9);
  const seed = L * 7 + (mother ? 50 : 0);

  // ---- hips: torn pants + belt
  B.add('hips', loft([
    [0.12, 0.125 * bk, 0.09 * bk, 0, 0.0, 2.2], [0.06, 0.14 * bk, 0.1 * bk, 0, 0.004, 2.3], [0.0, 0.15 * bk, 0.105 * bk, 0, 0.012, 2.3],
    [-0.07, 0.146 * bk, 0.102 * bk, 0, 0.014, 2.2], [-0.12, 0.11 * bk, 0.085 * bk, 0, 0.006, 2], [-0.15, 0.055, 0.055, 0, 0, 2], [-0.16, 0, 0],
  ].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5] || 2]), { seg: 18 }), pal.pants, pantsMat);
  B.add('hips', loft([[0.05, 0.132 * bk, 0.096 * bk, 0, 0.005], [0.085, 0.13 * bk, 0.094 * bk, 0, 0.004]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s]), { seg: 20 }), 0x2a1f16, M(PAT.LEATHER, 0.6));
  B.add('hips', xf(rbox(0.04, 0.03, 0.01, 0.003), [0.03 * s, 0.068 * s, -0.1 * s * bk], [0, 0.3, 0.2]), 0x5a5040, M(PAT.METAL, 0.6, 0.6));

  // ---- spine: gaunt abdomen (or abs for mother)
  B.add('spine', loft([[-0.06, 0.13, 0.09], [0.02, 0.118, 0.078, 0, 0.006], [0.1, 0.122, 0.083, 0, 0.002], [0.2, 0.138, 0.094, 0, -0.004]]
    .map((r) => [r[0] * s, r[1] * s * bk, r[2] * s * bk, 0, (r[4] || 0) * s]), {
    seg: 20,
    deform: (v, t, th, c, sn) => {
      if (sn < -0.2) {
        const f = -sn;
        if (mother) { const bx = Math.abs(Math.abs(v.x) - 0.028 * s), by = (((v.y / s) + 0.02) % 0.05) - 0.025; v.z -= 0.008 * s * f * Math.exp(-(bx * bx) / 0.0004 - (by * by) / 0.0002); }
        v.z -= 0.004 * s * Math.exp(-(v.x * v.x) / 0.0004) * 0;
      }
      // vertebrae bumps on the back
      if (sn > 0.85) v.z += 0.006 * s * Math.max(0, Math.sin((v.y / s) * TAU / 0.045)) * Math.exp(-(v.x * v.x) / 0.0002);
    },
  }), white, SK);

  // ---- chest
  const tr = [[-0.06, 0.13, 0.09, 0, 0.0], [0.03, 0.14, 0.095, 0, -0.004], [0.11, 0.155, 0.1, 0, -0.008], [0.18, 0.165, 0.098, 0, -0.004], [0.23, 0.15, 0.088, 0, 0.004], [0.26, 0.1, 0.07, 0, 0.01], [0.285, 0.05, 0.048, 0, 0.012], [0.3, 0.045, 0.045, 0, 0.012]]
    .map((r) => [r[0] * s, r[1] * s * bk * (mother && r[0] > 0.05 && r[0] < 0.27 ? 1.08 : 1), r[2] * s * bk, 0, r[4] * s]);
  B.add('chest', loft(tr, {
    seg: 24, sub: 4,
    deform: (v, t, th, c, sn) => {
      const yy = v.y / s;
      if (!mother && sn < 0.4 && yy > -0.03 && yy < 0.19) {
        const rib = Math.pow(Math.max(0, Math.sin((yy + 0.01) * TAU / 0.036)), 0.6) * (1 - sstep(0.12, 0.19, yy));
        const k = 1 + 0.045 * rib * sstep(0.4, -0.2, sn) * (1 - Math.exp(-(v.x * v.x) / 0.0006));
        v.x *= k; v.z = v.z * k;
        if (sn < -0.5) v.z += 0.006 * s * Math.exp(-(v.x * v.x) / 0.00025);
      }
      if (sn > 0.85) v.z += 0.007 * s * Math.max(0, Math.sin(yy * TAU / 0.045)) * Math.exp(-(v.x * v.x) / 0.0002);
      if (mother && sn < 0) {
        // pectorals + sternum groove + traps
        const px = Math.abs(v.x) / (s * bk), pk = Math.exp(-(((px - 0.07) / 0.05) ** 2) - (((yy - 0.15) / 0.05) ** 2));
        v.z -= 0.02 * s * bk * pk * (-sn);
        v.z += 0.006 * s * Math.exp(-((v.x / (0.012 * s)) ** 2)) * (-sn) * sstep(0.05, 0.12, yy);
      }
      if (mother && yy > 0.22) { const k = 1 + 0.25 * sstep(0.22, 0.27, yy) * (1 - sstep(0.27, 0.3, yy)); v.x *= k; }
    },
  }), white, SK);
  // shoulder blades
  for (const sd of [-1, 1]) B.add('chest', xf(ell(0.07, 0.085, 0.022, 10, 8), [sd * 0.075 * s * bk, 0.16 * s, 0.083 * s * bk], [0.2, sd * 0.35, 0], [s * bk, s, s]), white, SK);
  if (!mother) {
    // exposed ribcage wound (left front)
    B.add('chest', xf(ell(0.055, 0.07, 0.03, 12, 8), [-0.07 * s * bk, 0.08 * s, -0.082 * s * bk], [0, -0.45, 0]), mouthC, FL);
    for (let i = 0; i < 3; i++) {
      const g = new THREE.TorusGeometry(0.1 * bk, 0.0065, 5, 12, 0.95);
      B.add('chest', xf(g, [-0.012 * s, (0.045 + i * 0.034) * s, 0.0], [PI / 2 + 0.25, 0, PI + 0.55 - i * 0.05], [s, s * 0.78, s]), boneC, BONE);
    }
    // torn shirt (less shirt at higher levels)
    if (L < 3) {
      const shirt = tr.map((r) => [r[0], r[1] * 1.08 + 0.006, r[2] * 1.1 + 0.006, 0, r[4]]);
      shirt[0][0] -= 0.04 * s;
      B.add('chest', loft(shirt.slice(0, 7), {
        seg: 24, sub: 3, capEnd: false, capStart: false,
        deform: tearDeform(1.6, 16, L === 1 ? 0.56 : 0.46, 0.16, seed, (v, t, th, c, sn) => {
          if (t < 0.12) v.y += (noise3(Math.cos(th) * 2 + seed, Math.sin(th) * 2, 1) - 0.5) * 0.08 * s;
          // big tear exposing the rib wound
          const dx = v.x + 0.07 * s, dy = v.y - 0.08 * s;
          if (sn < 0 && dx * dx + dy * dy < (0.075 * s) ** 2) { v.x *= 0.85; v.z *= 0.85; }
        }),
      }), pal.shirt, pantsMat);
    }
  }
  // bone spikes along the spine (level 2+)
  if (L >= 2) {
    const n = mother ? 5 : L === 2 ? 3 : 5;
    for (let i = 0; i < n; i++) {
      const y = (0.02 + i * (0.25 / n)) * s;
      const len = (L === 3 ? 0.11 : 0.07) * (1 - i * 0.08) * s * (mother ? 1.1 : 1);
      const z0 = 0.09 * s * bk;
      B.add('chest', coneAB([0, y, z0 - 0.01], [0, y + len * 0.6, z0 + len], 0.017 * s * (L === 3 ? 1.2 : 1), 7), 0xb7a47e, BONE);
    }
  }

  // ---- neck
  B.add('neck', loft([[-0.03, 0.05, 0.052], [0.04, 0.042, 0.045], [0.1, 0.044, 0.048], [0.13, 0, 0]].map((r) => [r[0] * s, r[1] * s * (mother ? 1.4 : 1), r[2] * s * (mother ? 1.35 : 1)]), { seg: 14 }), white, SK);
  for (const sd of [-1, 1]) B.add('neck', capsAB([sd * 0.03 * s, 0.1 * s, 0.01 * s], [sd * 0.012 * s, -0.02 * s, -0.045 * s], 0.009 * s * (mother ? 1.5 : 1), 6, 2), white, SK);

  // ---- head (gaunt skull, open jaw, glowing eyes)
  const hs = s * (mother ? 1.04 : 1);
  B.add('head', loft([
    [0.012, 0.0, 0.0, 0, -0.055], [0.016, 0.03, 0.03, 0, -0.058], [0.032, 0.052, 0.07, 0, -0.03], [0.058, 0.061, 0.092, 0, -0.012],
    [0.09, 0.07, 0.103, 0, 0.0], [0.125, 0.077, 0.108, 0, 0.012], [0.16, 0.073, 0.104, 0, 0.022], [0.19, 0.055, 0.08, 0, 0.026], [0.207, 0.0, 0.0, 0, 0.026],
  ].map((r) => [r[0] * hs, r[1] * hs, r[2] * hs, 0, r[4] * hs]), {
    seg: 22, sub: 3,
    deform: (v) => {
      const x = v.x / hs, y = v.y / hs;
      let z = v.z / hs;
      if (z < -0.06) z = -0.06 + (z + 0.06) * 0.85;
      if (z < 0.02 && Math.abs(x) > 0.035) v.x -= Math.sign(x) * 0.013 * hs * Math.exp(-(((y - 0.045) / 0.018) ** 2));
      for (const ex of [-0.031, 0.031]) { const d2 = ((x - ex) ** 2 + (y - 0.088) ** 2) / 0.00028; if (z < -0.04) z += 0.016 * Math.exp(-d2); }
      if (z < -0.06) z -= 0.008 * Math.exp(-(((y - 0.108) / 0.009) ** 2));
      if (z < -0.06) z += 0.012 * Math.exp(-((x / 0.012) ** 2) - (((y - 0.06) / 0.012) ** 2));
      v.z = z * hs;
    },
  }), white, SK);
  const jawXf = (g) => xf(xf(xf(g, [0, -0.04 * hs, -0.02 * hs]), [0, 0, 0], [-0.38, 0, 0]), [0, 0.04 * hs, 0.02 * hs]);
  B.add('head', jawXf(loft([[0.014, 0.05, 0.066, 0, -0.028], [0.0, 0.049, 0.064, 0, -0.03], [-0.02, 0.042, 0.056, 0, -0.036], [-0.034, 0.025, 0.034, 0, -0.046], [-0.038, 0, 0, 0, -0.048]]
    .map((r) => [r[0] * hs, r[1] * hs, r[2] * hs, 0, r[4] * hs]), { seg: 16 })), white, SK);
  B.add('head', xf(ell(0.04, 0.03, 0.05, 10, 8), [0, 0.01 * hs, -0.035 * hs], [0, 0, 0], [hs, hs, hs]), mouthC, M(PAT.FLESH, 0.25));
  for (let i = 0; i < 10; i++) {
    const a = -1.05 + i * 0.233;
    const tx = 0.043 * Math.sin(a) * hs, tz = (-0.024 - 0.058 * Math.cos(a)) * hs;
    const len = (i === 2 || i === 7 ? 0.024 : 0.015) * hs;
    B.add('head', coneAB([tx, 0.018 * hs, tz], [tx, 0.018 * hs - len, tz - 0.002], 0.0045 * hs, 5), boneC, BONE);
    B.add('head', jawXf(coneAB([tx * 0.93, 0.01 * hs, tz * 0.95 + 0.002], [tx * 0.93, 0.01 * hs + len * 0.85, tz * 0.95], 0.0042 * hs, 5)), boneC, BONE);
  }
  for (const sd of [-1, 1]) {
    B.add('head', xf(new THREE.SphereGeometry(0.0105 * hs, 10, 8), [sd * 0.031 * hs, 0.087 * hs, -0.079 * hs]), pal.eye, M(PAT.GLOW, 0.4, 0, 2.6));
    B.add('head', xf(ell(0.01, 0.026, 0.016, 8, 6), [sd * 0.075 * hs, 0.08 * hs, 0.016 * hs], [0.3, -sd * 0.35, sd * 0.2], [hs, hs, hs]), white, SK);
  }
  B.add('head', xf(ell(0.009, 0.013, 0.006, 8, 6), [0, 0.06 * hs, -0.093 * hs], [0, 0, 0], [hs, hs, hs]), 0x140606, M(PAT.PLAIN, 0.6));
  // sparse stringy hair
  B.add('head', loft([[0.07, 0.08, 0.108, 0, 0.014], [0.12, 0.083, 0.113, 0, 0.014], [0.16, 0.077, 0.108, 0, 0.022], [0.19, 0.058, 0.083, 0, 0.026], [0.212, 0, 0, 0, 0.026]]
    .map((r) => [r[0] * hs, r[1] * hs, r[2] * hs, 0, r[4] * hs]), { seg: 24, capStart: false, deform: tearDeform(3.4, 60, mother ? 0.3 : 0.36, 0.14, seed + 3, (v, t, th, c, sn) => { if (sn < -0.3 && v.y < 0.15 * hs) { v.x *= 0.9; v.z *= 0.9; } }) }), 0x1b1a14, M(PAT.HAIR, 0.8));
  if (mother) {
    const brain = xf(ell(0.058, 0.042, 0.07, 14, 10), [0.012 * hs, 0.178 * hs, 0.03 * hs], [0.2, 0.1, -0.15], [hs, hs, hs]);
    const bp = brain.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      const n = 1 + (noise3(x * 90, y * 90, z * 90) - 0.5) * 0.25 + Math.sin(z * 260 + Math.sin(x * 200) * 2) * 0.03;
      bp.setXYZ(i, 0.012 * hs + (x - 0.012 * hs) * n, 0.178 * hs + (y - 0.178 * hs) * n, 0.03 * hs + (z - 0.03 * hs) * n);
    }
    brain.computeVertexNormals();
    B.add('head', brain, 0xb86868, M(PAT.FLESH, 0.3));
  }

  // ---- arms
  for (const sd of [-1, 1]) {
    const S = sd < 0 ? 'L' : 'R';
    const ak = mother ? 1.45 : bk;
    B.add('upperArm' + S, loft([[0.07, 0, 0], [0.056, 0.036, 0.04], [0.025, 0.05, 0.054, 0, -0.004], [-0.06, 0.045 * (mother ? 1.12 : 1), 0.05, 0, -0.006], [-0.2, 0.036, 0.039], [-0.32, 0.036, 0.036], [-0.355, 0, 0]]
      .map((r) => [r[0] * s, r[1] * s * ak, r[2] * s * ak, 0, (r[4] || 0) * s]), { seg: 14 }), white, SK);
    B.add('foreArm' + S, loft([[0.03, 0, 0], [0.012, 0.036, 0.038], [-0.05, 0.04, 0.036], [-0.18, 0.031, 0.027], [-0.3, 0.025, 0.022], [-0.33, 0, 0]]
      .map((r) => [r[0] * s, r[1] * s * ak, r[2] * s * ak]), {
      seg: 12, deform: (v, t, th) => { const k = 1 + 0.06 * Math.pow(Math.max(0, Math.sin(th * 3)), 3) * (t > 0.25 && t < 0.8 ? 1 : 0); v.x *= k; v.z *= k; },
    }), white, SK);
    B.add('foreArm' + S, xf(new THREE.SphereGeometry(0.022 * s * ak, 8, 6), [0, 0.0, 0.028 * s * ak]), white, SK);
    if (L === 1 && sd > 0) B.add('upperArm' + S, loft([[0.06, 0.05, 0.054], [-0.02, 0.058, 0.062], [-0.1, 0.055, 0.058]].map((r) => [r[0] * s, r[1] * s * ak, r[2] * s * ak]), { seg: 14, capEnd: false, capStart: false, deform: raggedHem(seed + 5, 0.05 * s) }), pal.shirt, pantsMat);
    if (L >= 2) {
      const nsp = mother ? 3 : L;
      for (let i = 0; i < nsp; i++) {
        const a = (i - (nsp - 1) / 2) * 0.55;
        const base = [sd * 0.02 * s, 0.045 * s, (0.01 + a * 0.02) * s];
        const len = (L === 3 ? 0.12 : 0.08) * s * (1 - Math.abs(a) * 0.3);
        B.add('upperArm' + S, coneAB(base, [base[0] + sd * len * 0.45, base[1] + len, base[2] + a * len * 0.6 + len * 0.25], 0.016 * s, 7), 0xb7a47e, BONE);
      }
      if (L === 3 || mother) B.add('foreArm' + S, coneAB([0, -0.02 * s, 0.03 * s], [sd * 0.01 * s, 0.02 * s, 0.12 * s], 0.014 * s, 7), 0xb7a47e, BONE);
    }
    buildHand(B, 'hand' + S, sd, {
      k: s * (mother ? 1.15 : 1) * (1 + (bk - 1) * 0.5), color: white, mat: SK, palmL: 1.15, palmW: 0.95, palmT: 0.9, fingerR: 0.82,
      lens: [[0.056, 0.042, 0.034], [0.061, 0.046, 0.036], [0.058, 0.044, 0.034], [0.047, 0.036, 0.03]],
      curl: [0.35, 0.45, 0.55], spread: 0.14, claw: mother ? 0.05 : 0.034 + 0.006 * L, clawColor: clawC, thumbCurl: 0.6,
    });
    // legs
    B.add('thigh' + S, loft([[0.085, 0, 0], [0.065, 0.066, 0.07], [0.0, 0.085, 0.09, 0.004 * sd, 0.004], [-0.14, 0.078, 0.082], [-0.3, 0.064, 0.066], [-0.42, 0.055, 0.058], [-0.48, 0.05, 0.053], [-0.51, 0, 0]]
      .map((r) => [r[0] * s, r[1] * s * bk, r[2] * s * bk, (r[3] || 0) * s, (r[4] || 0) * s]), { seg: 16 }), white, SK);
    const hemY = sd < 0 ? -0.36 : -0.5;
    B.add('thigh' + S, loft([[0.07, 0.071, 0.075], [0.0, 0.091, 0.096, 0.004 * sd, 0.004], [-0.14, 0.085, 0.088], [-0.3, 0.071, 0.073], [hemY, 0.066, 0.068]]
      .map((r) => [r[0] * s, r[1] * s * bk, r[2] * s * bk, (r[3] || 0) * s, (r[4] || 0) * s]), { seg: 16, capEnd: false, capStart: false, deform: tearDeform(1.4, 14, 0.62, 0.12, seed + sd * 4, raggedHem(seed + sd, 0.09 * s)) }), pal.pants, pantsMat);
    if (sd > 0) B.add('shin' + S, loft([[0.05, 0.066, 0.07], [-0.05, 0.068, 0.072], [-0.2, 0.06, 0.063]].map((r) => [r[0] * s, r[1] * s * bk, r[2] * s * bk]), { seg: 14, capEnd: false, capStart: false, deform: raggedHem(seed + 9, 0.1 * s) }), pal.pants, pantsMat);
    B.add('shin' + S, loft([[0.04, 0, 0], [0.02, 0.05, 0.053], [-0.09, 0.052, 0.058, 0, 0.01], [-0.25, 0.04, 0.043, 0, 0.004], [-0.44, 0.03, 0.033], [-0.49, 0, 0]]
      .map((r) => [r[0] * s, r[1] * s * bk, r[2] * s * bk, 0, (r[4] || 0) * s]), {
      seg: 14, deform: (v, t, th, c, sn) => { if (sn < -0.7) v.z -= 0.006 * s * (1 - Math.abs(t - 0.5) * 2); },
    }), white, SK);
    // bare foot with toes and claws
    const fk = s * (1 + (bk - 1) * 0.5);
    B.add('foot' + S, loftZ([[-0.07, 0, 0, 0, -0.04], [-0.064, 0.028, 0.03, 0, -0.04], [-0.03, 0.036, 0.042, 0, -0.035], [0.03, 0.042, 0.032, 0, -0.048], [0.1, 0.048, 0.02, 0, -0.058], [0.13, 0.045, 0.016, 0, -0.06], [0.14, 0, 0, 0, -0.06]]
      .map((r) => [r[0] * fk, r[1] * fk, r[2] * fk, 0, r[4] * fk]), { seg: 12, sub: 2 }), white, SK);
    for (let t = 0; t < 5; t++) {
      const tx = (-0.03 + t * 0.015) * sd * fk, tl = (t === 0 ? 0.045 : 0.04 - t * 0.004) * fk;
      const a = [tx, -0.062 * fk, -0.125 * fk], b2 = [tx * 1.1, -0.066 * fk, -(0.125 + tl) * fk / fk * 1.0 * fk / fk];
      b2[2] = a[2] - tl;
      B.add('foot' + S, capsAB(a, b2, (t === 0 ? 0.011 : 0.008) * fk, 6, 2), white, SK);
      B.add('foot' + S, coneAB([b2[0], b2[1], b2[2] + 0.004], [b2[0], b2[1] - 0.008 * fk, b2[2] - 0.016 * fk], 0.006 * fk, 5), clawC, BONE);
    }
  }
  return { geos: B.build(), rig, pal: { skinA: pal.skinA, skinB: pal.skinB, vein: pal.vein, glow: pal.glow, veinGlow: pal.veinGlow } };
}

// ------------------------------------------------------------------------------------------------
// TERMINATOR (armored obsidian brute with cyan electric veins)
// ------------------------------------------------------------------------------------------------
function buildTerminator() {
  const rig = {
    scale: 1.3,
    hipsY: 1.17, hip: [0.17, -0.07, 0], thighLen: 0.52, shinLen: 0.52, ankleH: 0.12,
    spine: [0, 0.16, 0], chest: [0, 0.24, 0], neck: [0, 0.5, -0.02], head: [0, 0.08, -0.03],
    shoulder: [0.42, 0.4, 0.02], upperLen: 0.42, foreLen: 0.44,
    headCenter: [0, 0.1, -0.03], headRadius: 0.17,
    footX: 0.21, footZ: 0.08, crouchDrop: 0.36, liftWalk: 0.15, liftRun: 0.28,
    aimPivot: [0, 0.4, 0], palm: [-0.04, -0.14, 0],
    walkSpeed: 1.6, runSpeed: 4.6, bodyThick: 0.22, strideK: 1.08, bobK: 2.1,
    hunch: 0.35, neckBaseQ: qE(-0.3, 0, 0), headDroop: 0.0,
  };
  const B = new Builder();
  const skin = 0x262830, plate = 0x353843, spike = 0x17181c, horn = 0x1b1b20;
  const O = (g) => M(PAT.OBSID, 0.34, 0.1, g);
  const bone = 0xa89878;
  // hips
  B.add('hips', loft([[0.14, 0.22, 0.16], [0.06, 0.25, 0.18, 0, 0.01], [-0.04, 0.26, 0.185, 0, 0.02], [-0.12, 0.22, 0.16, 0, 0.01], [-0.18, 0.12, 0.1], [-0.2, 0, 0]], { seg: 20 }), skin, O(0.35));
  B.add('hips', loft([[0.05, 0.264, 0.192, 0, 0.012, 3], [0.12, 0.258, 0.188, 0, 0.01, 3]], { seg: 24 }), plate, O(0.35));
  B.add('hips', xf(rbox(0.22, 0.28, 0.045, 0.02), [0, -0.1, -0.19], [0.12, 0, 0]), plate, O(0.15));
  B.add('hips', xf(rbox(0.26, 0.24, 0.045, 0.02), [0, -0.08, 0.2], [-0.14, 0, 0]), plate, O(0.15));
  for (const sd of [-1, 1]) B.add('hips', xf(rbox(0.045, 0.22, 0.2, 0.02), [sd * 0.265, -0.06, 0.0], [0, 0, sd * 0.18]), plate, O(0.15));
  // spine / abdomen
  B.add('spine', loft([[-0.06, 0.24, 0.17], [0.06, 0.25, 0.18, 0, -0.01], [0.18, 0.3, 0.2, 0, -0.015], [0.27, 0.34, 0.22, 0, -0.02]], { seg: 22 }), skin, O(0.35));
  for (let r = 0; r < 3; r++) for (const sd of [-1, 1]) {
    B.add('spine', xf(rbox(0.1, 0.078, 0.045, 0.018), [sd * 0.058, 0.0 + r * 0.085, -0.19 - r * 0.008], [0.08, sd * 0.12, 0]), plate, O(0.18));
  }
  // chest
  B.add('chest', loft([[-0.06, 0.3, 0.21, 0, -0.01], [0.08, 0.36, 0.235, 0, -0.025], [0.22, 0.42, 0.25, 0, -0.03], [0.34, 0.43, 0.235, 0, -0.02], [0.43, 0.34, 0.2, 0, 0.0], [0.5, 0.2, 0.15, 0, 0.02], [0.56, 0.12, 0.11, 0, 0.03], [0.58, 0, 0, 0, 0.03]], { seg: 26, sub: 3 }), skin, O(0.35));
  for (const sd of [-1, 1]) {
    B.add('chest', xf(rbox(0.27, 0.21, 0.08, 0.035), [sd * 0.15, 0.25, -0.225], [0.15, sd * 0.32, sd * 0.1]), plate, O(0.15));
    B.add('chest', xf(ell(0.17, 0.13, 0.15, 12, 8), [sd * 0.17, 0.45, 0.03], [0, 0, -sd * 0.35]), skin, O(0.35));
    B.add('chest', xf(rbox(0.22, 0.26, 0.06, 0.03), [sd * 0.14, 0.26, 0.22], [-0.1, -sd * 0.3, 0]), plate, O(0.15));
  }
  for (let i = 0; i < 5; i++) {
    const y = 0.08 + i * 0.1, len = 0.2 - i * 0.02;
    B.add('chest', coneAB([0, y, 0.22], [0, y + len * 0.55, 0.22 + len], 0.04 - i * 0.004, 8), spike, O(0.3));
  }
  // neck & head
  B.add('neck', loft([[-0.06, 0.13, 0.13], [0.06, 0.105, 0.105], [0.12, 0, 0]], { seg: 16 }), skin, O(0.35));
  B.add('head', loft([[0.0, 0, 0, 0, -0.07], [0.006, 0.07, 0.06, 0, -0.07], [0.04, 0.1, 0.11, 0, -0.03], [0.09, 0.11, 0.13, 0, -0.005], [0.14, 0.105, 0.13, 0, 0.012], [0.18, 0.08, 0.11, 0, 0.022], [0.2, 0, 0, 0, 0.022]], {
    seg: 20, deform: (v) => { if (v.z < -0.07) v.z = -0.07 + (v.z + 0.07) * 0.8; },
  }), skin, O(0.3));
  B.add('head', xf(rbox(0.22, 0.05, 0.1, 0.02), [0, 0.128, -0.1], [0.35, 0, 0]), plate, O(0.15));
  B.add('head', xf(rbox(0.16, 0.06, 0.1, 0.025), [0, 0.02, -0.1], [-0.2, 0, 0]), plate, O(0.18));
  for (const sd of [-1, 1]) {
    B.add('head', xf(ell(0.024, 0.011, 0.012, 10, 6), [sd * 0.047, 0.1, -0.123], [0, 0, sd * 0.25]), 0x60fff4, M(PAT.GLOW, 0.3, 0, 7));
    B.add('head', coneAB([sd * 0.05, 0.035, -0.135], [sd * 0.062, 0.1, -0.15], 0.013, 6), bone, M(PAT.BONE, 0.45));
    B.add('head', tube([[sd * 0.08, 0.15, -0.02], [sd * 0.15, 0.2, 0.05], [sd * 0.19, 0.21, 0.17], [sd * 0.2, 0.16, 0.27]], 0.03, 0.004, 14, 8), horn, M(PAT.BONE, 0.4));
    B.add('head', xf(rbox(0.04, 0.1, 0.12, 0.015), [sd * 0.1, 0.06, -0.04], [0, sd * 0.2, sd * 0.1]), plate, O(0.15));
  }
  // limbs
  for (const sd of [-1, 1]) {
    const S = sd < 0 ? 'L' : 'R';
    B.add('upperArm' + S, loft([[0.1, 0, 0], [0.08, 0.1, 0.11], [0.0, 0.14, 0.145], [-0.12, 0.135, 0.132, 0, -0.01], [-0.3, 0.11, 0.11], [-0.42, 0.1, 0.1], [-0.45, 0, 0]], { seg: 16 }), skin, O(0.35));
    B.add('upperArm' + S, loft([[0.17, 0, 0, sd * 0.03], [0.15, 0.12, 0.13, sd * 0.03], [0.09, 0.2, 0.2, sd * 0.035], [0.0, 0.225, 0.215, sd * 0.04], [-0.07, 0.205, 0.2, sd * 0.04]], { seg: 20, capStart: false }), plate, O(0.2));
    B.add('upperArm' + S, loft([[-0.03, 0.2, 0.2, sd * 0.045], [-0.12, 0.19, 0.19, sd * 0.05]], { seg: 20, capStart: false }), plate, O(0.2));
    B.add('upperArm' + S, coneAB([sd * 0.07, 0.14, 0], [sd * 0.14, 0.4, 0.0], 0.05, 8), spike, O(0.3));
    B.add('upperArm' + S, coneAB([sd * 0.12, 0.1, -0.1], [sd * 0.24, 0.3, -0.12], 0.04, 8), spike, O(0.3));
    B.add('upperArm' + S, coneAB([sd * 0.12, 0.1, 0.1], [sd * 0.24, 0.3, 0.14], 0.04, 8), spike, O(0.3));
    B.add('foreArm' + S, loft([[0.06, 0, 0], [0.03, 0.12, 0.12], [-0.08, 0.16, 0.155], [-0.2, 0.178, 0.168], [-0.32, 0.168, 0.158], [-0.42, 0.13, 0.126], [-0.46, 0, 0]], {
      seg: 18, deform: (v, t, th) => { const k = 1 + 0.07 * Math.pow(Math.abs(Math.sin(th * 3)), 6) * (t > 0.2 && t < 0.85 ? 1 : 0); v.x *= k; v.z *= k; },
    }), skin, O(1.7));
    B.add('foreArm' + S, coneAB([0, 0.0, 0.1], [0, 0.06, 0.32], 0.045, 8), spike, O(0.15));
    for (let i = 0; i < 3; i++) B.add('foreArm' + S, coneAB([sd * 0.15, -0.1 - i * 0.1, 0.02], [sd * 0.25, -0.08 - i * 0.1, 0.05], 0.025, 6), spike, O(0.15));
    // fist
    B.add('hand' + S, xf(rbox(0.2, 0.24, 0.24, 0.07), [-0.015 * sd, -0.13, 0]), skin, O(2.2));
    for (let k = 0; k < 4; k++) {
      const z = (k - 1.5) * 0.06;
      B.add('hand' + S, xf(new THREE.SphereGeometry(0.045, 10, 8), [-0.025 * sd, -0.25, z]), plate, O(2.4));
      B.add('hand' + S, coneAB([-0.025 * sd, -0.28, z], [-0.025 * sd, -0.35, z], 0.022, 6), spike, O(1.0));
      B.add('hand' + S, capsAB([-0.08 * sd, -0.24, z], [-0.1 * sd, -0.14, z], 0.034, 6, 2), skin, O(2.2));
    }
    B.add('hand' + S, capsAB([-0.04 * sd, -0.07, -0.12], [-0.1 * sd, -0.17, -0.13], 0.042, 6, 2), skin, O(2.2));
    // legs
    B.add('thigh' + S, loft([[0.1, 0, 0], [0.07, 0.17, 0.18], [0.0, 0.205, 0.21, sd * 0.012], [-0.2, 0.185, 0.19], [-0.42, 0.145, 0.15], [-0.52, 0.125, 0.13], [-0.55, 0, 0]], { seg: 18 }), skin, O(0.35));
    B.add('thigh' + S, xf(rbox(0.2, 0.3, 0.06, 0.03), [sd * 0.01, -0.2, -0.16], [-0.06, 0, 0]), plate, O(0.15));
    B.add('shin' + S, loft([[0.05, 0, 0], [0.02, 0.135, 0.145], [-0.12, 0.15, 0.165, 0, 0.018], [-0.35, 0.115, 0.12], [-0.5, 0.1, 0.1], [-0.53, 0, 0]], { seg: 16 }), skin, O(0.35));
    B.add('shin' + S, xf(rbox(0.17, 0.15, 0.07, 0.03), [0, 0.0, -0.12], [0.2, 0, 0]), plate, O(0.15));
    B.add('shin' + S, coneAB([0, 0.0, -0.15], [0, 0.03, -0.27], 0.04, 7), spike, O(0.3));
    B.add('shin' + S, xf(rbox(0.13, 0.3, 0.045, 0.02), [0, -0.27, -0.1], [0.05, 0, 0]), plate, O(0.15));
    B.add('foot' + S, loftZ([[-0.12, 0, 0, 0, -0.06], [-0.11, 0.08, 0.07, 0, -0.06], [-0.04, 0.1, 0.09, 0, -0.04], [0.08, 0.11, 0.065, 0, -0.07], [0.2, 0.12, 0.045, 0, -0.08], [0.26, 0.1, 0.035, 0, -0.085], [0.28, 0, 0, 0, -0.085]], { seg: 16, sub: 2 }), skin, O(0.35));
    for (const x of [-0.065, 0, 0.065]) B.add('foot' + S, coneAB([x, -0.085, -0.25], [x * 1.1, -0.115, -0.37], 0.028, 7), bone, M(PAT.BONE, 0.4));
    B.add('foot' + S, coneAB([0, -0.07, 0.1], [0, -0.1, 0.2], 0.03, 6), bone, M(PAT.BONE, 0.4));
  }
  return { geos: B.build(), rig, pal: { glow: C(0x30fff0), skinA: C(0x222222), skinB: C(0x111111), vein: C(0x30fff0) } };
}

// ------------------------------------------------------------------------------------------------
// HUNTER (Ghost Hunter: gold + black heavy armor, glowing visor, energy blade)
// ------------------------------------------------------------------------------------------------
function buildHunter() {
  const s = 1.05;
  const rig = humanRig(false, s);
  rig.runSpeed = 5.2;
  const B = new Builder();
  const suit = 0x16161a, SU = M(PAT.FABRIC, 0.6);
  const gold = 0xd8a23a, G = M(PAT.METAL, 0.28, 0.95);
  const dark = 0x1e1e24, D = M(PAT.METAL, 0.38, 0.85);
  const glow = 0xff9a2e, GL = M(PAT.GLOW, 0.3, 0, 6);
  // hips
  B.add('hips', loft([[0.12, 0.13, 0.095, 0, 0.0, 2.2], [0.07, 0.15, 0.105, 0, 0.004, 2.3], [0.0, 0.162, 0.112, 0, 0.012, 2.3], [-0.07, 0.158, 0.11, 0, 0.014, 2.2], [-0.12, 0.12, 0.09, 0, 0.006, 2], [-0.15, 0.06, 0.06, 0, 0, 2], [-0.16, 0, 0]]
    .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s, r[5] || 2]), { seg: 18 }), suit, SU);
  B.add('hips', loft([[0.03, 0.172, 0.122, 0, 0.005, 2.6], [0.085, 0.168, 0.118, 0, 0.004, 2.6]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5]]), { seg: 24 }), gold, G);
  B.add('hips', xf(rbox(0.06, 0.045, 0.02, 0.008), [0, 0.058 * s, -0.128 * s]), dark, D);
  B.add('hips', xf(new THREE.CylinderGeometry(0.014, 0.014, 0.01, 12), [0, 0.058 * s, -0.139 * s], [PI / 2, 0, 0]), glow, GL);
  for (const sd of [-1, 1]) {
    B.add('hips', xf(rbox(0.12, 0.17, 0.018, 0.008), [sd * 0.075 * s, -0.06 * s, -0.125 * s], [0.16, sd * 0.2, 0]), gold, G);
    B.add('hips', xf(rbox(0.018, 0.17, 0.13, 0.008), [sd * 0.172 * s, -0.04 * s, 0.0], [0, 0, sd * 0.18]), gold, G);
  }
  // spine: abdominal lames
  B.add('spine', loft([[-0.06, 0.152, 0.105], [0.02, 0.148, 0.1, 0, -0.004], [0.1, 0.152, 0.102, 0, -0.006], [0.2, 0.16, 0.106, 0, -0.006]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s]), { seg: 18 }), suit, SU);
  for (let i = 0; i < 3; i++) {
    const y = (0.01 + i * 0.055) * s;
    B.add('spine', loft([[y, 0.158 + i * 0.004, 0.113 + i * 0.003, 0, -0.006, 2.5], [y + 0.042 * s, 0.162 + i * 0.004, 0.116 + i * 0.003, 0, -0.008, 2.5]].map((r, k) => [r[0], r[1] * s, r[2] * s, 0, r[4] * s, r[5]]), { seg: 22 }), gold, G);
  }
  // chest: cuirass
  B.add('chest', loft(torsoRings(s, false), { seg: 20 }), suit, SU);
  B.add('chest', loft([[-0.05, 0.168, 0.12, 0, -0.004, 2.6], [0.05, 0.178, 0.126, 0, -0.012, 2.7], [0.14, 0.192, 0.13, 0, -0.016, 2.7], [0.2, 0.19, 0.12, 0, -0.008, 2.6], [0.245, 0.15, 0.1, 0, 0.004, 2.4], [0.27, 0.09, 0.08, 0, 0.01, 2.2]]
    .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, r[5]]), {
    seg: 26, sub: 3,
    deform: (v, t, th, c, sn) => {
      if (sn < 0) v.z -= 0.014 * s * Math.exp(-((v.x / (0.03 * s)) ** 2)) * (-sn) * (1 - t * 0.6);
      if (t > 0.55) v.y -= 0.07 * s * Math.pow(Math.abs(c), 4) * sstep(0.55, 1, t);
    },
  }), gold, G);
  B.add('chest', xf(new THREE.CylinderGeometry(0.03, 0.034, 0.02, 6), [0, 0.125 * s, -0.153 * s], [PI / 2 + 0.1, 0, 0]), dark, D);
  B.add('chest', xf(new THREE.CylinderGeometry(0.022, 0.022, 0.024, 6), [0, 0.125 * s, -0.157 * s], [PI / 2 + 0.1, 0, 0]), glow, GL);
  for (const sd of [-1, 1]) {
    B.add('chest', xf(rbox(0.07, 0.006, 0.012, 0.002), [sd * 0.07 * s, 0.07 * s, -0.152 * s], [0, sd * 0.35, sd * 0.35]), glow, M(PAT.GLOW, 0.3, 0, 3));
    B.add('chest', xf(rbox(0.06, 0.2, 0.03, 0.012), [sd * 0.08 * s, 0.11 * s, 0.13 * s], [0.05, -sd * 0.25, 0]), gold, G);
  }
  // neck gorget
  B.add('neck', loft([[-0.035, 0.085, 0.085], [0.02, 0.078, 0.078], [0.06, 0.062, 0.064]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 18 }), gold, G);
  B.add('neck', loft([[0.0, 0.052, 0.055], [0.12, 0.05, 0.053]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 14 }), suit, SU);
  // helmet
  B.add('head', loft([[-0.045, 0, 0, 0, -0.05], [-0.04, 0.05, 0.045, 0, -0.05], [-0.01, 0.076, 0.085, 0, -0.03], [0.03, 0.087, 0.105, 0, -0.012], [0.08, 0.091, 0.114, 0, 0.0], [0.12, 0.093, 0.116, 0, 0.008], [0.16, 0.086, 0.108, 0, 0.012], [0.195, 0.064, 0.085, 0, 0.014], [0.22, 0.03, 0.045, 0, 0.014], [0.226, 0, 0, 0, 0.014]]
    .map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, r[4] * s, 2.3]), {
    seg: 26, sub: 3,
    deform: (v) => { if (v.z < -0.05 * s) v.z -= 0.013 * s * Math.exp(-((v.x / (0.02 * s)) ** 2)) * sstep(-0.03 * s, 0.02 * s, v.y); },
  }), gold, G);
  B.add('head', xf(new THREE.CylinderGeometry(0.1185, 0.1185, 0.024, 20, 1, true, PI - 0.95, 1.9), [0, 0.085 * s, 0.002 * s], [0, 0, 0], [s * 0.8, s, s]), glow, M(PAT.GLOW, 0.3, 0, 7));
  B.add('head', xf(new THREE.CylinderGeometry(0.117, 0.117, 0.04, 20, 1, true, PI - 1.05, 2.1), [0, 0.085 * s, 0.0], [0, 0, 0], [s * 0.8, s, s]), dark, D);
  B.add('head', xf(rbox(0.014, 0.05, 0.22, 0.006), [0, 0.225 * s, 0.015 * s], [0.12, 0, 0]), gold, G);
  for (const sd of [-1, 1]) {
    B.add('head', xf(rbox(0.012, 0.09, 0.07, 0.006), [sd * 0.095 * s, 0.02 * s, -0.035 * s], [0.2, sd * 0.25, sd * 0.08]), gold, G);
    B.add('head', xf(rbox(0.01, 0.02, 0.12, 0.004), [sd * 0.098 * s, 0.13 * s, 0.03 * s], [-0.3, 0, sd * 0.15]), dark, D);
    for (let i = 0; i < 3; i++) B.add('head', xf(rbox(0.018, 0.004, 0.006, 0.0015), [sd * 0.022 * s, (0.02 + i * 0.012) * s, -0.098 * s], [0, sd * 0.4, 0]), dark, D);
  }
  // limbs: black undersuit
  buildHumanLimbs(B, {
    s, fem: false, shirt: suit, shirtMat: SU, pants: suit, pantsMat: SU, gloves: dark, pad: gold, web: dark, gear: dark,
    boots: dark, sole: 0x0b0b0b, ankleH: rig.ankleH, holster: false, cargo: false, cuff: dark,
  });
  for (const sd of [-1, 1]) {
    const S = sd < 0 ? 'L' : 'R';
    // pauldrons (layered)
    B.add('upperArm' + S, loft([[0.105, 0, 0, sd * 0.012], [0.095, 0.07, 0.08, sd * 0.014], [0.055, 0.092, 0.098, sd * 0.018], [0.0, 0.097, 0.103, sd * 0.022], [-0.045, 0.088, 0.094, sd * 0.024]].map((r) => [r[0] * s, r[1] * s, r[2] * s, r[3] * s]), { seg: 20, capStart: false }), gold, G);
    B.add('upperArm' + S, loft([[-0.03, 0.084, 0.09, sd * 0.03], [-0.095, 0.078, 0.084, sd * 0.032]].map((r) => [r[0] * s, r[1] * s, r[2] * s, r[3] * s]), { seg: 20, capStart: false, capEnd: false }), gold, G);
    B.add('upperArm' + S, xf(rbox(0.012, 0.06, 0.14, 0.005), [sd * 0.06 * s, 0.105 * s, 0.0], [0, 0, -sd * 0.5]), dark, D);
    B.add('upperArm' + S, loft([[-0.12, 0.06, 0.063], [-0.24, 0.054, 0.056]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 16 }), gold, G);
    // couter + vambrace
    B.add('foreArm' + S, xf(ell(0.05, 0.05, 0.05, 12, 8), [0, 0.0, 0.02 * s], [0, 0, 0], [s, s, s]), gold, G);
    B.add('foreArm' + S, coneAB([0, 0.0, 0.06 * s], [0, 0.02 * s, 0.11 * s], 0.014 * s, 6), dark, D);
    B.add('foreArm' + S, loft([[-0.04, 0.052, 0.05], [-0.12, 0.05, 0.046], [-0.22, 0.043, 0.039]].map((r) => [r[0] * s, r[1] * s, r[2] * s]), { seg: 16 }), gold, G);
    B.add('foreArm' + S, xf(rbox(0.006, 0.12, 0.012, 0.002), [sd * 0.05 * s, -0.13 * s, 0], [0, 0, sd * 0.05]), glow, M(PAT.GLOW, 0.3, 0, 3));
    B.add('hand' + S, xf(rbox(0.014, 0.06, 0.07, 0.006), [sd * 0.021 * s, -0.052 * s, 0]), gold, G);
    // cuisses, poleyns, greaves, sabatons
    B.add('thigh' + S, xf(rbox(0.15, 0.28, 0.04, 0.02), [sd * 0.006 * s, -0.17 * s, -0.078 * s], [-0.04, 0, 0], [s, s, s]), gold, G);
    B.add('thigh' + S, xf(rbox(0.035, 0.24, 0.12, 0.012), [sd * 0.085 * s, -0.14 * s, 0.0], [0, 0, sd * 0.06], [s, s, s]), gold, G);
    B.add('shin' + S, xf(rbox(0.095, 0.1, 0.05, 0.022), [0, -0.01 * s, -0.064 * s], [0.12, 0, 0], [s, s, s]), gold, G);
    B.add('shin' + S, xf(rbox(0.012, 0.07, 0.08, 0.004), [sd * 0.058 * s, 0.0, -0.035 * s], [0.3, 0, sd * 0.3], [s, s, s]), gold, G);
    B.add('shin' + S, loft([[-0.06, 0.063, 0.068, 0, -0.004], [-0.2, 0.058, 0.064, 0, -0.002], [-0.33, 0.056, 0.06]].map((r) => [r[0] * s, r[1] * s, r[2] * s, 0, (r[4] || 0) * s]), { seg: 16 }), gold, G);
    B.add('foot' + S, xf(rbox(0.09, 0.04, 0.1, 0.018), [0, -0.035 * s, -0.16 * s], [0.25, 0, 0], [s, s, s]), gold, G);
  }
  return { geos: B.build(), rig, pal: { glow: C(0xff9a2e) } };
}

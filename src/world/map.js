// 新寂静村 / New Silent Village (a.k.a. Dawn Village): a Western ghost town at dawn.
// Layout (X east, Z south, Y up; meters):
//   Main street runs E–W (z -9..9). Central plaza/spawn at the origin.
//   North row (facing the street): Blue House · Gun Shop (stairway to roof) ·
//     Town Hall with Clock Tower + ladder-only Platform · Post Office (barricaded
//     room, Underpass below with two entrances) · Hotel · water tower & railway.
//   South row: Storage yard with containers · Saloon with ring ledge ·
//     plaza with well & gallows · Sheriff · General Store · station platform + boxcar.
//   Back alleys behind both rows, canyon cliffs all around.
import * as THREE from 'three';
import { WorldBuilder } from './builder.js';
import { createWorldMaterials } from './materials.js';
import { Tex } from '../engine/textures.js';

export const BOUNDS = { x0: -64, x1: 64, z0: -40, z1: 42 };

export function buildMap(scene, { quality = 'high' } = {}) {
  const b = new WorldBuilder();
  const M = createWorldMaterials(b);
  const footprints = [];   // minimap rectangles {x0,z0,x1,z1,h,kind}
  const lightSpots = [];   // {pos, color, intensity, distance, flicker}
  const spots = [];        // human holding spots (for AI + callouts)

  const rnd = mulberry(1337);

  // ------------------------------------------------------------------ helpers
  const panel = (mat, cx, cy, cz, w, h, facing, opts = {}) => {
    const ry = { '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[facing];
    const geo = new THREE.PlaneGeometry(w, h);
    b.add(mat, geo, [cx, cy, cz], [0, ry, 0], { collide: false, uv: 'keep', ...opts });
  };

  const crate = (x, y, z, s = 1.1, ry = 0) => {
    b.box('crate', x, y, z, s, s, s, ry);
    b.surface('wood', x - s / 2, y + s - 0.05, z - s / 2, x + s / 2, y + s + 0.3, z + s / 2);
  };
  const barrel = (x, y, z, kind = 'woodDark') => {
    b.cyl(kind, x, y, z, 0.29, 0.29, 0.92, 12);
    for (const hy of [0.12, 0.46, 0.8]) b.cyl('iron', x, y + hy - 0.02, z, 0.305, 0.305, 0.05, 12, { collide: false });
    b.cyl(kind, x, y + 0.92, z, 0.26, 0.26, 0.02, 12, { collide: false });
  };
  const hayBale = (x, y, z, ry = 0) => b.box('hay', x, y, z, 1.2, 0.55, 0.62, ry);
  const sandbags = (x0, z0, x1, z1, rows = 3) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 0.62));
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5 + (r % 2) * 0.5) / n;
        if (t > 1) continue;
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        const geo = new THREE.CapsuleGeometry(0.15, 0.36, 3, 8);
        geo.rotateZ(Math.PI / 2);
        geo.scale(1, 0.75, 1.25);
        b.add('sandbag', geo, [x, 0.12 + r * 0.22, z], [0, ang + Math.PI / 2 + (rnd() - 0.5) * 0.2, 0], { collide: false });
      }
    }
    // single collision slab
    const geo = new THREE.BoxGeometry(0.62, rows * 0.22 + 0.05, len);
    b.addCollider(geo, [(x0 + x1) / 2, (rows * 0.22 + 0.05) / 2, (z0 + z1) / 2], [0, ang, 0]);
  };
  const fence = (x0, z0, x1, z1, h = 1.2, mat = 'wood') => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.box(mat, x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t, 0.14, h + 0.1, 0.14, ang + (rnd() - 0.5) * 0.08, { collide: false });
    }
    for (const hh of [h * 0.45, h * 0.9]) {
      b.add(mat, new THREE.BoxGeometry(0.06, 0.12, len), [(x0 + x1) / 2, hh, (z0 + z1) / 2], [(rnd() - 0.5) * 0.03, ang, 0], { collide: false });
    }
    b.addCollider(new THREE.BoxGeometry(0.2, h, len), [(x0 + x1) / 2, h / 2, (z0 + z1) / 2], [0, ang, 0]);
  };
  const railing = (x0, z0, x1, z1, y, h = 1.0, mat = 'wood') => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 1.6));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      b.box(mat, x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, 0.09, h, 0.09, ang, { collide: false });
    }
    b.add(mat, new THREE.BoxGeometry(0.1, 0.08, len + 0.1), [(x0 + x1) / 2, y + h, (z0 + z1) / 2], [0, ang, 0], { collide: false });
    b.add(mat, new THREE.BoxGeometry(0.05, 0.06, len), [(x0 + x1) / 2, y + h * 0.5, (z0 + z1) / 2], [0, ang, 0], { collide: false });
    b.addCollider(new THREE.BoxGeometry(0.12, h + 0.04, len), [(x0 + x1) / 2, y + (h + 0.04) / 2, (z0 + z1) / 2], [0, ang, 0]);
  };
  const lantern = (x, y, z, light = true, intensity = 6, flicker = 0.25) => {
    b.box('iron', x, y, z, 0.24, 0.04, 0.24, 0, { collide: false });
    b.box('lampGlow', x, y + 0.04, z, 0.16, 0.26, 0.16, 0, { collide: false });
    b.box('iron', x, y + 0.3, z, 0.26, 0.05, 0.26, 0, { collide: false });
    b.cyl('iron', x, y + 0.35, z, 0.02, 0.1, 0.12, 6, { collide: false });
    if (light) lightSpots.push({ pos: new THREE.Vector3(x, y + 0.2, z), color: 0xffa85a, intensity, distance: 14, flicker });
  };
  const postLantern = (x, z) => {
    b.box('woodDark', x, 0, z, 0.16, 3.2, 0.16);
    b.box('woodDark', x + 0.3, 3.0, z, 0.7, 0.08, 0.08, 0, { collide: false });
    lantern(x + 0.55, 2.55, z, true, 5, 0.3);
    b.cyl('iron', x + 0.55, 2.85, z, 0.01, 0.01, 0.2, 4, { collide: false });
  };
  const trough = (x, z, ry = 0) => {
    b.box('woodDark', x, 0, z, 2.2, 0.6, 0.7, ry);
    const geo = new THREE.PlaneGeometry(2.0, 0.5); geo.rotateX(-Math.PI / 2);
    b.add('water', geo, [x, 0.52, z], [0, ry, 0], { collide: false, uv: 'keep' });
  };
  const wheel = (x, y, z, ry, r = 0.62) => {
    const tor = new THREE.TorusGeometry(r, 0.045, 6, 18);
    b.add('woodDark', tor, [x, y, z], [0, ry, 0], { collide: false });
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.CylinderGeometry(0.02, 0.02, r * 2, 5);
      b.add('woodDark', sp, [x, y, z], [0, ry, 0], { collide: false, uv: 'box' });
      // rotate spokes around the wheel axle
      const g = b.batches.get('woodDark');
      const last = g[g.length - 1];
      last.translate(-x, -y, -z);
      last.applyMatrix4(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(Math.cos(ry), 0, -Math.sin(ry)).normalize(), (i / 6) * Math.PI));
      last.translate(x, y, z);
    }
    b.cyl('iron', x, y - 0.1, z, 0.08, 0.08, 0.2, 8, { collide: false, rot: [Math.PI / 2, ry, 0] });
  };
  const wagon = (x, z, ry = 0, broken = false) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const L = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    b.box('planks', x, 0.85, z, 1.6, 0.14, 3.4, ry);
    for (const side of [-1, 1]) {
      const [sx, sz] = L(side * 0.78, 0);
      b.box('wood', sx, 0.99, sz, 0.08, 0.5, 3.4, ry);
    }
    for (const end of [-1, 1]) {
      const [ex, ez] = L(0, end * 1.66);
      b.box('wood', ex, 0.99, ez, 1.6, 0.5, 0.08, ry);
    }
    for (const [lx, lz] of [[-0.86, -1.1], [0.86, -1.1], [-0.86, 1.1], [0.86, 1.1]]) {
      if (broken && lx > 0 && lz > 0) continue;
      const [wx, wz] = L(lx, lz);
      wheel(wx, 0.62, wz, ry + Math.PI / 2);
    }
    const [tx, tz] = L(0, -2.6);
    b.add('wood', new THREE.BoxGeometry(0.1, 0.1, 2.2), [tx, 0.55, tz], [0.35, ry, 0], { collide: false });
    b.surface('wood', x - 1.8, 0.9, z - 1.8, x + 1.8, 1.4, z + 1.8);
  };
  const container = (x, y, z, ry, mat, { open = false } = {}) => {
    const L = 6.06, W = 2.44, H = 2.59;
    if (!open) {
      b.box(mat, x, y, z, W, H, L, ry);
      // corner castings / frame
      b.box('metalDark', x, y + H - 0.08, z, W + 0.04, 0.1, L + 0.04, ry, { collide: false });
      b.box('metalDark', x, y, z, W + 0.04, 0.1, L + 0.04, ry, { collide: false });
    } else {
      // hollow: floor, two sides, roof, closed back; open front (local -z end)
      const c = Math.cos(ry), s = Math.sin(ry);
      const P = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
      const t = 0.08;
      let [px, pz] = P(0, 0);
      b.box('metalDark', px, y, pz, W, 0.12, L, ry);
      b.box(mat, px, y + H - t, pz, W, t, L, ry);
      [px, pz] = P(-W / 2 + t / 2, 0); b.box(mat, px, y, pz, t, H, L, ry);
      [px, pz] = P(W / 2 - t / 2, 0); b.box(mat, px, y, pz, t, H, L, ry);
      [px, pz] = P(0, L / 2 - t / 2); b.box(mat, px, y, pz, W, H, t, ry);
      // swung-open doors
      [px, pz] = P(-W / 2 - 0.55, -L / 2 - 0.5); b.box(mat, px, y + 0.02, pz, 0.06, H - 0.05, 1.2, ry + 0.25, { collide: true });
      [px, pz] = P(W / 2 + 0.55, -L / 2 - 0.5); b.box(mat, px, y + 0.02, pz, 0.06, H - 0.05, 1.2, ry - 0.25, { collide: true });
    }
    b.surface('metal', x - 3.2, y + H - 0.1, z - 3.2, x + 3.2, y + H + 0.4, z + 3.2);
  };

  // A western false-front building. face 's' = front faces +z (north row), 'n' = front faces -z.
  const storefront = (o) => {
    const {
      x0, x1, zf, depth, face, h, siding, ff = 0, sign = null, signOpts = {}, porch = 2.4, porchH = 0.45,
      awningH = 3.1, awningMat = 'shingles', floors = 1, door = 0.5, roofMat = 'planksDark', parapet = 0.4,
      noParapet = [], balcony = false, balconyRails = true, sideWindows = true, kind = 'building', doorMat = 'door', winLit = [],
    } = o;
    const s = face === 's' ? 1 : -1;
    const Z = (w) => zf - s * w;
    const boxL = (mat, u0, u1, y0, y1, w0, w1, opts) => b.boxMM(mat, Math.min(u0, u1), y0, Math.min(Z(w0), Z(w1)), Math.max(u0, u1), y1, Math.max(Z(w0), Z(w1)), opts);
    const fwd = s > 0 ? '+z' : '-z';
    const W = x1 - x0, cx = (x0 + x1) / 2;
    footprints.push({ x0, x1, z0: Math.min(Z(0), Z(depth)), z1: Math.max(Z(0), Z(depth)), h, kind });

    boxL('stone', x0 - 0.06, x1 + 0.06, 0, porchH, 0.02, depth + 0.06);
    boxL(siding, x0, x1, porchH, h, 0, depth);
    boxL(roofMat, x0 - 0.05, x1 + 0.05, h, h + 0.12, -0.05, depth + 0.05);
    b.surface('wood', x0, h, Math.min(Z(0), Z(depth)), x1, h + 0.5, Math.max(Z(0), Z(depth)));
    // parapets (sides/back)
    const ph = h + 0.12 + parapet;
    if (parapet > 0) {
      if (!noParapet.includes('w')) boxL('woodDark', x0 - 0.05, x0 + 0.15, h, ph, 0, depth + 0.05);
      if (!noParapet.includes('e')) boxL('woodDark', x1 - 0.15, x1 + 0.05, h, ph, 0, depth + 0.05);
      if (!noParapet.includes('b')) boxL('woodDark', x0 - 0.05, x1 + 0.05, h, ph, depth - 0.15, depth + 0.05);
    }
    // corner & base trims
    for (const u of [x0 - 0.03, x1 + 0.03]) {
      for (const w of [0, depth]) boxL('woodDark', u - 0.09, u + 0.09, porchH, h, w - 0.09, w + 0.09, { collide: false });
    }
    boxL('woodDark', x0 - 0.04, x1 + 0.04, h - 0.25, h, -0.06, depth + 0.06, { collide: false });
    if (floors > 1) boxL('woodDark', x0 - 0.04, x1 + 0.04, h * 0.5 - 0.08, h * 0.5 + 0.06, -0.05, depth + 0.05, { collide: false });

    // false front
    if (ff > 0) {
      const top = h + ff;
      boxL(siding, x0 - 0.15, x1 + 0.15, h, top - 0.6, -0.12, 0.12);
      boxL(siding, x0 + W * 0.12, x1 - W * 0.12, top - 0.6, top, -0.12, 0.12);
      boxL(siding, x0 + W * 0.3, x1 - W * 0.3, top, top + 0.55, -0.12, 0.12);
      // cornices
      boxL('woodDark', x0 - 0.25, x1 + 0.25, top - 0.72, top - 0.6, -0.26, 0.14, { collide: false });
      boxL('woodDark', x0 + W * 0.12 - 0.1, x1 - W * 0.12 + 0.1, top - 0.08, top + 0.04, -0.24, 0.14, { collide: false });
      boxL('woodDark', x0 + W * 0.3 - 0.1, x1 - W * 0.3 + 0.1, top + 0.5, top + 0.62, -0.22, 0.14, { collide: false });
      // back bracing visible from roofs
      for (let u = x0 + 1; u < x1 - 0.5; u += 2.5) {
        b.add('wood', new THREE.BoxGeometry(0.1, 0.1, Math.hypot(1.4, ff - 0.6)), [u, h + (ff - 0.6) / 2, Z(0.8)], [s * Math.atan2(1.4, ff - 0.6), 0, 0], { collide: false });
      }
    } else {
      boxL('woodDark', x0 - 0.2, x1 + 0.2, h - 0.05, h + 0.25, -0.22, depth + 0.2, { collide: false });
    }
    if (sign) {
      const key = M.signMat(sign, signOpts);
      const sh = ff > 0 ? Math.min(1.5, ff * 0.5) : 0.9;
      const sw = Math.min(W * 0.72, sh * 4.2);
      const sy = ff > 0 ? h + ff * 0.4 : awningH + 0.75;
      boxL('woodDark', cx - sw / 2 - 0.08, cx + sw / 2 + 0.08, sy - sh / 2 - 0.08, sy + sh / 2 + 0.08, -0.2, -0.12, { collide: false });
      panel(key, cx, sy, Z(-0.205), sw, sh, fwd);
    }

    // front windows & door
    const doorU = x0 + W * door;
    const fy = porchH;
    panel(doorMat, doorU, fy + 1.2, Z(-0.015), 1.3, 2.4, fwd);
    boxL('woodDark', doorU - 0.78, doorU + 0.78, fy + 2.4, fy + 2.56, -0.08, 0, { collide: false });
    for (const du of [-0.72, 0.72]) boxL('woodDark', doorU + du - 0.07, doorU + du + 0.07, fy, fy + 2.45, -0.07, 0, { collide: false });
    const winSlots = [];
    for (let u = x0 + 1.4; u < x1 - 1.0; u += 2.4) if (Math.abs(u - doorU) > 1.6) winSlots.push(u);
    let wi = 0;
    for (const u of winSlots) {
      const lit = winLit.includes(wi++);
      panel(lit ? 'windowLit' : 'window', u, fy + 1.55, Z(-0.015), 1.2, 1.6, fwd);
      boxL('woodDark', u - 0.72, u + 0.72, fy + 2.35, fy + 2.5, -0.1, 0, { collide: false });
      boxL('woodDark', u - 0.7, u + 0.7, fy + 0.68, fy + 0.76, -0.12, 0, { collide: false });
    }
    if (floors > 1) {
      const uy = h * 0.5 + 1.5;
      for (let u = x0 + 1.5; u < x1 - 1.0; u += 2.6) {
        const lit = winLit.includes(wi++);
        panel(lit ? 'windowLit' : 'window', u, uy, Z(-0.015), 1.0, 1.5, fwd);
        boxL('woodDark', u - 0.62, u + 0.62, uy + 0.75, uy + 0.9, -0.1, 0, { collide: false });
        boxL('woodDark', u - 0.6, u + 0.6, uy - 0.83, uy - 0.75, -0.12, 0, { collide: false });
      }
    }
    if (sideWindows) {
      for (const side of [-1, 1]) {
        const ux = side < 0 ? x0 - 0.015 : x1 + 0.015;
        for (let w = 2.2; w < depth - 1.5; w += 3.4) {
          panel('window', ux, fy + 1.6, Z(w), 1.0, 1.4, side < 0 ? '-x' : '+x');
          if (floors > 1) panel('window', ux, h * 0.5 + 1.5, Z(w), 0.9, 1.3, side < 0 ? '-x' : '+x');
        }
      }
    }

    // porch
    if (porch > 0) {
      boxL('planks', x0, x1, porchH - 0.14, porchH, -porch, 0);
      boxL('woodDark', x0, x1, 0, porchH - 0.14, -porch + 0.05, -porch + 0.25, { collide: false });
      b.surface('wood', x0, porchH - 0.1, Math.min(Z(-porch), Z(0)), x1, porchH + 0.4, Math.max(Z(-porch), Z(0)));
      // full-width step ramp (collision) + two visible steps at the door
      const zA = Z(-porch - 0.7), zB = Z(-porch);
      b.rampCollider(x0 + 0.05, Math.min(zA, zB), x1 - 0.05, Math.max(zA, zB), 0, porchH, s > 0 ? '-z' : '+z');
      const st = porchH / 3;
      for (let i = 0; i < 2; i++) {
        boxL('planks', doorU - 1.2, doorU + 1.2, 0, st * (i + 1), -porch - 0.7 + i * 0.35, -porch - 0.35 + i * 0.35, { collide: false });
      }
      boxL('woodDark', x0 + 0.05, x1 - 0.05, 0, porchH - 0.14, -porch - 0.02, -porch + 0.05, { collide: false });
      // posts
      const np = Math.max(2, Math.round(W / 3.2) + 1);
      for (let i = 0; i < np; i++) {
        const u = x0 + 0.15 + (W - 0.3) * (i / (np - 1));
        boxL('wood', u - 0.09, u + 0.09, porchH, awningH, -porch + 0.06, -porch + 0.24);
        // corner braces
        if (i > 0) b.add('wood', new THREE.BoxGeometry(0.06, 0.06, 0.7), [u - 0.25, awningH - 0.3, Z(-porch + 0.15)], [0, Math.PI / 2, Math.PI / 4], { collide: false });
        if (i < np - 1) b.add('wood', new THREE.BoxGeometry(0.06, 0.06, 0.7), [u + 0.25, awningH - 0.3, Z(-porch + 0.15)], [0, Math.PI / 2, -Math.PI / 4], { collide: false });
      }
      boxL('woodDark', x0, x1, awningH - 0.14, awningH, -porch + 0.04, -porch + 0.26, { collide: false });
      if (balcony) {
        boxL('planks', x0, x1, awningH, awningH + 0.14, -porch, 0);
        b.surface('wood', x0, awningH, Math.min(Z(-porch), Z(0)), x1, awningH + 0.5, Math.max(Z(-porch), Z(0)));
        if (balconyRails) {
          const zr = Z(-porch + 0.08);
          railing(x0 + 0.1, zr, x1 - 0.1, zr, awningH + 0.14, 1.0);
          railing(x0 + 0.08, Z(-porch + 0.1), x0 + 0.08, Z(-0.1), awningH + 0.14, 1.0);
          railing(x1 - 0.08, Z(-porch + 0.1), x1 - 0.08, Z(-0.1), awningH + 0.14, 1.0);
        } else {
          boxL('woodDark', x0, x1, awningH + 0.14, awningH + 0.24, -porch, -porch + 0.12, { collide: false });
        }
        // upper-floor door onto balcony
        panel(doorMat, doorU, awningH + 1.25, Z(-0.015), 1.1, 2.2, fwd);
      } else {
        const L = porch + 0.3, drop = 0.38, ang = Math.atan2(drop, L);
        const geo = new THREE.BoxGeometry(W + 0.3, 0.09, Math.hypot(L, drop));
        b.add(awningMat, geo, [cx, awningH + drop / 2 + 0.05, Z(-L / 2 + 0.1)], [s * ang, 0, 0]);
        b.surface(awningMat === 'corrugated' ? 'metal' : 'wood', x0, awningH, Math.min(Z(-porch), Z(0)), x1, awningH + 0.9, Math.max(Z(-porch), Z(0)));
      }
      // hitching rail
      const zh = Z(-porch - 1.6);
      for (const u of [cx - 1.6, cx + 1.6]) b.box('wood', u, 0, zh, 0.14, 1.0, 0.14, rnd() * 0.1, { collide: false });
      b.box('wood', cx, 0.92, zh, 3.4, 0.1, 0.1, 0, { collide: false });
      b.addCollider(new THREE.BoxGeometry(3.4, 1.0, 0.2), [cx, 0.5, zh]);
    }
    return { Z, boxL, s, fwd };
  };

  // =================================================================== GROUND
  const holes = [
    { x0: 28.6, x1: 31.4, z0: -17.5, z1: -11 },   // east underpass stairwell
    { x0: 10.6, x1: 13.4, z0: -28, z1: -21 },     // west underpass stairwell
  ];
  groundWithHoles(b, -80, 80, -60, 62, holes);

  // ================================================================ NORTH ROW
  // --- Blue House (蓝房子): two storeys, rooftop spot via tricky jumps (west side)
  storefront({ x0: -46, x1: -34, zf: -11.5, depth: 12.5, face: 's', h: 5.9, siding: 'sidingBlue', floors: 2, noParapet: ['w'], kind: 'bluehouse', porch: 2.4, awningMat: 'corrugated', winLit: [3] });
  // rear extension (backup ledge) with generator
  b.boxMM('stone', -46, 0, -27.2, -34, 0.3, -24);
  b.boxMM('sidingBlue', -45.8, 0.3, -27, -34.2, 3.6, -24);
  b.boxMM('corrugatedRust', -46, 3.6, -27.3, -34, 3.72, -24);
  b.surface('metal', -46, 3.6, -27.3, -34, 4.1, -24);
  footprints.push({ x0: -46, x1: -34, z0: -27.2, z1: -24, h: 3.6, kind: 'ext' });
  b.box('metalRust', -38.5, 3.72, -25.6, 1.6, 0.9, 1.0);
  b.cyl('metalDark', -38.5, 4.62, -25.6, 0.08, 0.08, 0.7, 8, { collide: false });
  barrel(-36.2, 3.72, -26.2, 'metalRust');
  barrel(-35.5, 3.72, -25.5, 'metalRust');
  // west lean-to shed + jump route
  b.boxMM('sidingGray', -49, 0, -22, -46, 2.6, -14);
  footprints.push({ x0: -49.2, x1: -46, z0: -22, z1: -14, h: 3, kind: 'shed' });
  {
    const L = 3.3, drop = 0.85, ang = Math.atan2(drop, L);
    b.add('corrugated', new THREE.BoxGeometry(Math.hypot(L, drop), 0.08, 8.4), [-47.6, 2.62 + drop / 2 + 0.02, -18], [0, 0, ang]);
    b.boxMM('sidingGray', -47.2, 2.6, -22, -46, 3.25, -14, { collide: false });
    b.surface('metal', -49.3, 2.5, -22.2, -46, 3.8, -13.8);
  }
  barrel(-49.9, 0, -12.4);
  crate(-50.2, 0, -14.3, 1.0); crate(-50.2, 1.0, -14.3, 1.0, 0.1);
  crate(-47.0, 3.22, -19.4, 1.4, 0.05);
  crate(-51.4, 0, -13.2, 1.0, 0.3);
  spots.push({ name: '蓝房子屋顶', pos: new THREE.Vector3(-40, 6.0, -18), r: 4.5 });
  spots.push({ name: '蓝房子后台', pos: new THREE.Vector3(-41, 3.75, -25.5), r: 3 });

  // --- Gun Shop (枪店): stairway from the plaza side up to its roof, back ledge
  storefront({ x0: -28, x1: -16, zf: -11.5, depth: 12.5, face: 's', h: 5.2, siding: 'sidingRed', ff: 1.9, sign: 'GUN SHOP', signOpts: { bg: '#2c1d14', fg: '#e8c98a' }, kind: 'gunshop', noParapet: ['e'], winLit: [1] });
  b.stairs('planks', -15.9, -21.5, -14.5, -12.3, 0, 5.2, '-z', { stringer: 'woodDark' });
  b.boxMM('planks', -15.9, 5.02, -24, -14.5, 5.2, -21.5);
  b.surface('wood', -16, 0, -24, -14.4, 5.6, -12);
  for (let z = -12.6; z > -24; z -= 2.2) b.box('wood', -15.2, 0, z, 0.14, Math.max(0.2, 5.2 * (z - -12.3) / (-21.5 - -12.3)), 0.14, 0, { collide: false });
  // stair railing (outer, sloped)
  {
    const L = Math.hypot(9.2, 5.2), ang = Math.atan2(5.2, 9.2);
    b.add('wood', new THREE.BoxGeometry(0.08, 0.08, L), [-14.5, 2.6 + 0.95, -16.9], [ang, 0, 0], { collide: false });
    for (let i = 0; i <= 6; i++) { const t = i / 6; b.box('wood', -14.5, 5.2 * t, -12.3 - 9.2 * t, 0.07, 0.95, 0.07, 0, { collide: false }); }
    b.addCollider(new THREE.BoxGeometry(0.12, 1.0, L), [-14.45, 2.6 + 0.5, -16.9], [ang, 0, 0]);
  }
  railing(-14.5, -21.6, -14.5, -24, 5.2, 1.0);
  b.boxMM('stone', -28, 0, -27, -16, 0.3, -24);
  b.boxMM('sidingRed', -27.8, 0.3, -26.8, -16.2, 3.2, -24);
  b.boxMM('planksDark', -28, 3.2, -27.1, -16, 3.3, -24);
  b.surface('wood', -28, 3.2, -27.1, -16, 3.7, -24);
  footprints.push({ x0: -28, x1: -16, z0: -27, z1: -24, h: 3.2, kind: 'ext' });
  crate(-26.5, 3.3, -25.8, 0.9); barrel(-17.3, 3.3, -25.2);
  spots.push({ name: '枪店屋顶', pos: new THREE.Vector3(-22, 5.35, -18), r: 4.5 });
  spots.push({ name: '枪店后台', pos: new THREE.Vector3(-22, 3.35, -25.5), r: 3 });

  // --- Town Hall + Clock Tower + ladder-only Platform (钟楼平台)
  {
    const x0 = -10, x1 = 10, z0 = -27, z1 = -14, h = 7.5;
    footprints.push({ x0, x1, z0, z1, h, kind: 'townhall' });
    b.boxMM('stone', x0 - 0.1, 0, z0 - 0.1, x1 + 0.1, 0.6, z1 + 0.1);
    b.boxMM('sidingWhite', x0, 0.6, z0, x1, h, z1);
    b.boxMM('planksDark', x0 - 0.05, h, z0 - 0.05, x1 + 0.05, h + 0.12, z1 + 0.05);
    b.surface('wood', x0, h, z0, x1, h + 0.5, z1);
    b.boxMM('woodDark', x0 - 0.05, h, z0 - 0.05, x0 + 0.15, h + 0.5, z1);   // parapets W/E/back
    b.boxMM('woodDark', x1 - 0.15, h, z0 - 0.05, x1 + 0.05, h + 0.5, z1);
    b.boxMM('woodDark', x0, h, z0 - 0.05, x1, h + 0.5, z0 + 0.15);
    b.boxMM('woodDark', x0 - 0.25, h - 0.3, z1 - 0.1, x1 + 0.25, h + 0.2, z1 + 0.08);   // front cornice lip (low)
    for (const u of [x0, -3.2, 3.2, x1]) b.boxMM('woodDark', u - 0.14, 0.6, z1 - 0.02, u + 0.14, h - 0.3, z1 + 0.12, { collide: false });
    // windows: ground floor behind the platform, upper floor
    for (const u of [-7.5, -5.2, 5.2, 7.5]) {
      panel('window', u, 2.0, z1 + 0.015, 1.1, 1.8, '+z');
      panel('window', u, 5.6, z1 + 0.015, 1.0, 1.6, '+z');
      b.boxMM('woodDark', u - 0.66, 6.45, z1, u + 0.66, 6.6, z1 + 0.1, { collide: false });
    }
    panel('doorGreen', 0, 1.9, z1 + 0.015, 2.2, 2.6, '+z');
    b.boxMM('woodDark', -1.3, 3.2, z1, 1.3, 3.45, z1 + 0.12, { collide: false });
    const hallSign = M.signMat('TOWN HALL', { w: 512, h: 96, bg: '#1f2a24', fg: '#dcc995' });
    panel(hallSign, 0, 6.2, z1 + 0.03, 4.2, 0.8, '+z');
    for (const side of [-1, 1]) for (let z = z0 + 2.5; z < z1 - 1; z += 3.2) {
      panel('window', side < 0 ? x0 - 0.015 : x1 + 0.015, 2.0, z, 1.0, 1.6, side < 0 ? '-x' : '+x');
      panel('window', side < 0 ? x0 - 0.015 : x1 + 0.015, 5.6, z, 1.0, 1.5, side < 0 ? '-x' : '+x');
    }

    // Platform (deck at 4.2) with ladder as the only access
    const py = 4.2, pz0 = -14, pz1 = -10.8;
    b.boxMM('planks', -8, py - 0.2, pz0, 8, py, pz1);
    b.surface('wood', -8, py - 0.1, pz0, 8, py + 0.5, pz1);
    for (const u of [-7.85, -2.6, 2.6, 7.85]) b.boxMM('wood', u - 0.13, 0, pz1 - 0.3, u + 0.13, py - 0.2, pz1 - 0.04);
    for (const u of [-7.85, 7.85]) b.add('wood', new THREE.BoxGeometry(0.1, 0.1, 3.4), [u, 2.6, (pz0 + pz1) / 2], [Math.atan2(2.4, 2.9), 0, 0], { collide: false });
    railing(-7.95, pz1 - 0.06, -0.6, pz1 - 0.06, py, 1.0);
    railing(0.6, pz1 - 0.06, 7.95, pz1 - 0.06, py, 1.0);
    railing(-7.95, pz0 + 0.1, -7.95, pz1 - 0.1, py, 1.0);
    railing(7.95, pz0 + 0.1, 7.95, pz1 - 0.1, py, 1.0);
    b.ladder('woodDark', 0, pz1 + 0.18, 0, py, [0, 1]);
    // boxes at the back of the platform → climb to the upper roof
    crate(6.0, py, -13.3, 1.3, 0.02);
    crate(6.5, py + 1.3, -13.45, 0.95, -0.06);
    crate(-6.4, py, -13.4, 1.0, 0.1);
    barrel(-4.8, py, -13.5);
    // side crate stacks at ground (zombies boost from here)
    crate(9.2, 0, -11.6, 1.2); crate(9.25, 1.2, -11.6, 1.2, 0.08);
    crate(-9.2, 0, -11.6, 1.2, 0.05); crate(-9.1, 1.2, -11.7, 1.2, -0.06);
    crate(10.6, 0, -12.4, 1.0, 0.3);
    lantern(-3.2, py + 1.95, -13.85, true, 7, 0.2);
    lantern(3.2, py + 1.95, -13.85, false);
    spots.push({ name: '钟楼平台', pos: new THREE.Vector3(0, py + 0.05, -12.6), r: 5 });
    spots.push({ name: '钟楼屋顶', pos: new THREE.Vector3(-5, h + 0.15, -20), r: 5 });

    // Clock tower
    const tx0 = -2.6, tx1 = 2.6, tz0 = -22.6, tz1 = -17.4, th = 14.6;
    b.boxMM('sidingWhite', tx0, h, tz0, tx1, th, tz1);
    for (const [u, w] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) b.boxMM('woodDark', u - 0.16, h, w - 0.16, u + 0.16, th + 0.2, w + 0.16, { collide: false });
    b.boxMM('woodDark', tx0 - 0.3, th - 0.05, tz0 - 0.3, tx1 + 0.3, th + 0.3, tz1 + 0.3);
    const clockY = 12.2;
    const faces = [['+z', 0, tz1 + 0.03], ['-z', 0, tz0 - 0.03], ['+x', tx1 + 0.03, -20], ['-x', tx0 - 0.03, -20]];
    for (const [f, fx, fz] of faces) {
      const px = f.includes('x') ? fx : 0, pz = f.includes('z') ? fz : -20;
      const geo = new THREE.CircleGeometry(1.15, 40);
      const ry = { '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[f];
      b.add('clock', geo, [px, clockY, pz], [0, ry, 0], { collide: false, uv: 'keep' });
      const ring = new THREE.TorusGeometry(1.2, 0.08, 6, 40);
      b.add('brass', ring, [px, clockY, pz], [0, ry, 0], { collide: false });
      // hands (frozen at 5:47 — dawn)
      const dir = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      const hand = (len, wid, angle, off) => {
        const g = new THREE.BoxGeometry(wid, len, 0.03);
        g.translate(0, len / 2 - 0.1, 0);
        g.rotateZ(-angle);
        b.add('iron', g, [px + dir.x * off, clockY, pz + dir.z * off], [0, ry, 0], { collide: false, uv: 'keep' });
      };
      hand(0.62, 0.07, (5 + 47 / 60) / 12 * Math.PI * 2, 0.04);
      hand(0.95, 0.045, 47 / 60 * Math.PI * 2, 0.07);
    }
    // belfry
    const by0 = th + 0.3, by1 = by0 + 3.2;
    for (const [u, w] of [[tx0, tz0], [tx1, tz0], [tx0, tz1], [tx1, tz1]]) b.boxMM('woodDark', u - 0.22, by0, w - 0.22, u + 0.22, by1, w + 0.22);
    for (const [a0, a1, c0, c1] of [[tx0, tx1, tz0 - 0.2, tz0 + 0.2], [tx0, tx1, tz1 - 0.2, tz1 + 0.2], [tx0 - 0.2, tx0 + 0.2, tz0, tz1], [tx1 - 0.2, tx1 + 0.2, tz0, tz1]]) {
      b.boxMM('sidingWhite', a0, by1 - 0.7, c0, a1, by1, c1);
      b.boxMM('woodDark', a0, by0, c0, a1, by0 + 0.9, c1);
    }
    b.boxMM('woodDark', tx0 - 0.45, by1, tz0 - 0.45, tx1 + 0.45, by1 + 0.2, tz1 + 0.45);
    const roofGeo = new THREE.ConeGeometry(4.0, 3.6, 4, 1);
    b.add('shingles', roofGeo, [0, by1 + 0.2 + 1.8, -20], [0, Math.PI / 4, 0]);
    b.cyl('iron', 0, by1 + 3.9, -20, 0.03, 0.03, 1.4, 6, { collide: false });
    // bell + weather vane (animated extras)
    const bell = new THREE.Group();
    const bellGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0.02, 0), new THREE.Vector2(0.62, 0), new THREE.Vector2(0.58, 0.08), new THREE.Vector2(0.46, 0.3),
      new THREE.Vector2(0.4, 0.7), new THREE.Vector2(0.36, 0.95), new THREE.Vector2(0.2, 1.05), new THREE.Vector2(0.02, 1.08),
    ], 24);
    const bellMesh = new THREE.Mesh(bellGeo, M.brass);
    bellMesh.position.y = -1.08; bellMesh.castShadow = true;
    bell.add(bellMesh);
    bell.position.set(0, by1 - 0.4, -20);
    b.extras.add(bell);
    b.boxMM('woodDark', tx0, by1 - 0.5, -20.1, tx1, by1 - 0.3, -19.9, { collide: false });
    b.animated.push({ kind: 'bell', obj: bell, swing: 0, phase: 0 });
    const vane = new THREE.Group();
    const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.3), M.iron);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.35, 0.3), M.iron); tail.position.z = 0.6;
    const rooster = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.45, 0.45), M.iron); rooster.position.set(0, 0.28, -0.1);
    vane.add(arrow, tail, rooster);
    vane.position.set(0, by1 + 5.0, -20);
    b.extras.add(vane);
    b.animated.push({ kind: 'vane', obj: vane });
    b.solidMM(tx0, h, tz0, tx1, by1 + 3.8, tz1);
  }

  // --- Post Office (邮局): barricaded room with a sole entrance + Underpass below
  {
    const x0 = 14, x1 = 28, z0 = -24, z1 = -11.5, h = 6.0, fy = 0.3, ceil = 3.9, t = 0.4;
    footprints.push({ x0, x1, z0, z1, h, kind: 'postoffice' });
    b.boxMM('stone', x0 - 0.05, 0, z0 - 0.05, x1 + 0.05, fy, z1 + 0.05);
    // walls with door gap in front (x 20..22)
    b.boxMM('brick', x0, fy, z0, x0 + t, h, z1);
    b.boxMM('brick', x1 - t, fy, z0, x1, h, z1);
    b.boxMM('brick', x0, fy, z0, x1, h, z0 + t);
    b.boxMM('brick', x0, fy, z1 - t, 20, h, z1);
    b.boxMM('brick', 22, fy, z1 - t, x1, h, z1);
    b.boxMM('brick', 20, fy + 2.7, z1 - t, 22, h, z1);
    b.boxMM('planks', x0 + t, 0, z0 + t, x1 - t, fy, z1 - t);
    b.surface('wood', x0, 0, z0, x1, fy + 0.5, z1);
    b.boxMM('planksDark', x0 + t, ceil, z0 + t, x1 - t, ceil + 0.2, z1 - t);            // interior ceiling
    b.boxMM('planksDark', x0 - 0.05, h, z0 - 0.05, x1 + 0.05, h + 0.12, z1 + 0.05);       // roof
    b.surface('wood', x0, h, z0, x1, h + 0.5, z1);
    for (const u of [x0, x1]) b.boxMM('stone', u - 0.12, h - 0.1, z0 - 0.1, u + 0.12, h + 0.45, z1 + 0.1);
    b.boxMM('stone', x0 - 0.1, h - 0.1, z0 - 0.12, x1 + 0.1, h + 0.45, z0 + 0.12);
    // brick false front with stone cornice + sign
    b.boxMM('brick', x0 - 0.1, h, z1 - 0.2, x1 + 0.1, h + 1.3, z1 + 0.05);
    b.boxMM('brick', 17.5, h + 1.3, z1 - 0.2, 24.5, h + 1.9, z1 + 0.05);
    b.boxMM('stone', x0 - 0.25, h + 1.2, z1 - 0.25, x1 + 0.25, h + 1.35, z1 + 0.2, { collide: false });
    b.boxMM('stone', 17.3, h + 1.85, z1 - 0.25, 24.7, h + 2.0, z1 + 0.2, { collide: false });
    const poSign = M.signMat('POST OFFICE', { w: 512, h: 96, bg: '#2a2218', fg: '#e0c890', style: 'painted' });
    panel(poSign, 21, 4.75, z1 + 0.03, 5.6, 1.05, '+z');
    for (const u of [16.2, 18.4, 23.6, 25.8]) {
      // boarded windows
      panel('window', u, 2.0, z1 + 0.015, 1.1, 1.7, '+z');
      for (let k = 0; k < 3; k++) b.add('wood', new THREE.BoxGeometry(1.35, 0.14, 0.04), [u, 1.5 + k * 0.5, z1 + 0.05], [0, 0, (rnd() - 0.5) * 0.5], { collide: false });
      b.boxMM('stone', u - 0.7, 2.9, z1, u + 0.7, 3.05, z1 + 0.12, { collide: false });
    }
        b.add('door', new THREE.BoxGeometry(1.0, 2.3, 0.06), [19.2, fy + 1.15, z1 + 0.9], [0, 0.9, 0.05], { collide: true, uv: 'box' });
    // porch
    b.boxMM('planks', x0, 0, z1, x1, fy, z1 + 2.2);
    b.surface('wood', x0, 0, z1, x1, fy + 0.4, z1 + 2.2);
    b.rampCollider(x0, z1 + 2.2, x1, z1 + 2.8, 0, fy, '-z');
    // interior barricade: counter, sacks, crates, sandbags at the entrance
    b.boxMM('woodDark', x0 + 1.2, fy, -17.6, 19.4, fy + 1.1, -16.9);
    b.boxMM('planks', x0 + 1.1, fy + 1.1, -17.7, 19.5, fy + 1.18, -16.8);
    b.boxMM('woodDark', 22.8, fy, -17.6, x1 - 1.2, fy + 1.1, -16.9);
    b.boxMM('planks', 22.7, fy + 1.1, -17.7, x1 - 1.1, fy + 1.18, -16.8);
    b.boxMM('woodDark', x0 + 0.5, fy, z0 + 0.5, x1 - 0.5, fy + 2.4, z0 + 1.0); // back shelves
    for (let u = x0 + 0.8; u < x1 - 0.6; u += 0.9) b.boxMM('crate', u, fy + 1.0, z0 + 0.55, u + 0.7, fy + 1.4, z0 + 0.95, { collide: false });
    sandbags(19.0, -13.4, 19.0, -15.2, 4);
    sandbags(23.0, -13.4, 23.0, -15.2, 4);
    sandbags(19.6, -15.6, 22.4, -15.6, 3);
    crate(15.6, fy, -13.0, 1.0); crate(15.6, fy + 1.0, -13.0, 0.9, 0.2);
    crate(26.3, fy, -13.1, 1.1, 0.1);
    crate(16.2, fy, -21.2, 1.1); crate(25.8, fy, -21.5, 1.1, 0.3);
    barrel(24.8, fy, -19.8); barrel(17.3, fy, -19.6);
    for (let i = 0; i < 7; i++) b.box('cloth', 17 + rnd() * 8, fy, -22.5 + rnd() * 1.2, 0.6, 0.45, 0.45, rnd() * 3, { collide: false });
    lantern(21, ceil - 0.5, -19, true, 6, 0.35);
    b.cyl('iron', 21, ceil - 0.2, -19, 0.01, 0.01, 0.25, 4, { collide: false });
    spots.push({ name: '邮局', pos: new THREE.Vector3(21, fy + 0.05, -20.5), r: 4 });

    // ---- Underpass (地下通道): E–W tunnel under the post office, floor -3.4
    const uy = -3.4, uc = -0.5;
    const ux0 = 10.6, ux1 = 31.4, uz0 = -21, uz1 = -17.5;
    b.boxMM('stone', ux0 - 0.4, uy - 0.5, uz0 - 7.4, ux1 + 0.4, uy, uz1 + 6.9); // floor slab (under stairwells too)
    b.surface('dirt', ux0, uy - 0.1, uz0 - 7.4, ux1, uy + 0.4, uz1 + 6.9);
    // north wall with opening (west stairwell) at x 10.6..13.4
    b.boxMM('stone', 13.4, uy, uz0 - 0.4, ux1 + 0.4, uc, uz0);
    // south wall with opening (east stairwell) at x 28.6..31.4
    b.boxMM('stone', ux0 - 0.4, uy, uz1, 28.6, uc, uz1 + 0.4);
    b.boxMM('stone', ux0 - 0.4, uy, uz0 - 0.4, ux0, uc, uz1 + 0.4);   // west end
    b.boxMM('stone', ux1, uy, uz0 - 0.4, ux1 + 0.4, uc, uz1 + 0.4);   // east end
    b.boxMM('planksDark', ux0, uc - 0.12, uz0, ux1, uc, uz1, { collide: false }); // ceiling boards
    for (let x = ux0 + 1; x < ux1; x += 2.2) {
      b.boxMM('woodDark', x - 0.1, uc - 0.3, uz0, x + 0.1, uc - 0.1, uz1, { collide: false });
      b.boxMM('woodDark', x - 0.1, uy, uz0 + 0.01, x + 0.1, uc - 0.1, uz0 + 0.2, { collide: false });
      b.boxMM('woodDark', x - 0.1, uy, uz1 - 0.2, x + 0.1, uc - 0.1, uz1 - 0.01, { collide: false });
    }
    // east stairwell: descends from the street side (z -11, y 0) to the tunnel (z -17.5)
    b.stairs('stone', 28.6, -17.5, 31.4, -11, uy, 0, '+z');
    b.boxMM('stone', 28.2, uy, -17.5, 28.6, 0.35, -10.8);
    b.boxMM('stone', 31.4, uy, -17.5, 31.8, 0.35, -10.8);
    railing(28.4, -11.3, 28.4, -17.4, 0.35, 0.9, 'iron');
    railing(31.6, -11.3, 31.6, -17.4, 0.35, 0.9, 'iron');
    railing(28.5, -17.5, 31.5, -17.5, 0.0, 1.0, 'iron');
    // west stairwell: descends from the back alley (z -28, y 0) south to the tunnel (z -21)
    b.stairs('stone', 10.6, -28, 13.4, -21, uy, 0, '-z');
    b.boxMM('stone', 10.2, uy, -28.2, 10.6, 0.35, -21);
    b.boxMM('stone', 13.4, uy, -28.2, 13.8, 0.35, -21);
    railing(10.4, -21.1, 10.4, -27.9, 0.35, 0.9, 'iron');
    railing(13.6, -21.1, 13.6, -27.9, 0.35, 0.9, 'iron');
    railing(10.5, -21.0, 13.5, -21.0, 0.0, 1.0, 'iron');
    // clutter + lights in the tunnel
    crate(16, uy, -20.3, 1.0); crate(27, uy, -18.2, 1.0, 0.4); barrel(22.5, uy, -20.4); barrel(23.2, uy, -20.5);
    sandbags(19, -18.0, 19, -19.6, 3);
    lantern(15.5, uc - 0.55, -19.25, true, 5, 0.4);
    lantern(25.5, uc - 0.55, -19.25, true, 5, 0.5);
    spots.push({ name: '地下通道', pos: new THREE.Vector3(21, uy + 0.05, -19.2), r: 5 });
    spots.push({ name: '火车车厢', pos: new THREE.Vector3(60.2, 1.1, 4), r: 3 });
  }

  // --- Hotel (two storeys with balcony)
  storefront({ x0: 32, x1: 46, zf: -11.5, depth: 12.5, face: 's', h: 7.6, siding: 'sidingOchre', ff: 1.6, sign: 'HOTEL', signOpts: { bg: '#3a2616', fg: '#f0d8a0' }, floors: 2, balcony: true, awningH: 3.8, kind: 'hotel', winLit: [0, 5] });
  // north-east: water tower + windmill + railway
  waterTower(b, M, 54.5, -22, 9.5);
  windmill(b, M, 58, -33);
  railway(b, M, 59.5);

  // ================================================================ SOUTH ROW
  // --- Storage yard (仓库): enclosed with containers, open one in the corner
  {
    const x0 = -50, x1 = -32, z0 = 11.5, z1 = 36, fh = 3.3;
    footprints.push({ x0, x1, z0, z1, h: 0, kind: 'yard' });
    const wall = (ax, az, bx, bz) => {
      const geo = new THREE.BoxGeometry(Math.max(0.1, Math.abs(bx - ax)), fh, Math.max(0.1, Math.abs(bz - az)));
      b.add('corrugatedRust', geo, [(ax + bx) / 2, fh / 2, (az + bz) / 2]);
    };
    wall(x0, z0, -43.5, z0); wall(-38.5, z0, x1, z0);
    wall(x0, z0, x0, z1); wall(x1, z0, x1, z1); wall(x0, z1, x1, z1);
    for (let x = x0; x <= x1 + 0.1; x += 3) { b.box('woodDark', x, 0, z0, 0.16, fh + 0.2, 0.16, 0, { collide: false }); b.box('woodDark', x, 0, z1, 0.16, fh + 0.2, 0.16, 0, { collide: false }); }
    for (let z = z0; z <= z1 + 0.1; z += 3) { b.box('woodDark', x0, 0, z, 0.16, fh + 0.2, 0.16, 0, { collide: false }); b.box('woodDark', x1, 0, z, 0.16, fh + 0.2, 0.16, 0, { collide: false }); }
    // gate posts + sign
    for (const x of [-43.6, -38.4]) b.box('woodDark', x, 0, z0, 0.3, 4.6, 0.3);
    b.boxMM('woodDark', -43.8, 4.3, z0 - 0.15, -38.2, 4.6, z0 + 0.15);
    const stSign = M.signMat('STORAGE', { w: 512, h: 128, bg: '#2d2519', fg: '#d9c089' });
    panel(stSign, -41, 3.85, z0 - 0.17, 3.2, 0.8, '-z');
    b.add('corrugated', new THREE.BoxGeometry(2.5, fh - 0.2, 0.05), [-45.2, fh / 2, z0 - 1.0], [0, 0.6, 0]);   // swung gate leaves
    b.add('corrugated', new THREE.BoxGeometry(2.5, fh - 0.2, 0.05), [-36.8, fh / 2, z0 - 1.0], [0, -0.6, 0]);
    container(-46.2, 0, 17.2, 0, 'containerBlue');
    container(-46.2, 2.59, 17.4, 0.02, 'containerRed');
    container(-36.4, 0, 16.2, Math.PI / 2, 'containerGreen');
    container(-43.4, 0, 27.0, Math.PI / 2, 'containerOrange');
    container(-35.6, 0, 24.8, 0.04, 'containerRed');
    container(-35.3, 0, 33.9, Math.PI / 2, 'containerBlue', { open: true });  // the open one in the corner
    crate(-40.6, 0, 18.6, 1.2); crate(-40.6, 1.2, 18.6, 1.1, 0.15); crate(-39.3, 0, 19.2, 1.0, 0.4);
    crate(-38.2, 0, 22.4, 1.2, 0.2); crate(-47.8, 0, 31.2, 1.1); crate(-47.9, 1.1, 31.3, 1.0, -0.2);
    crate(-33.2, 0, 29.3, 1.2); crate(-33.1, 1.2, 29.2, 1.1, 0.1);
    barrel(-48.6, 0, 22.4); barrel(-48.2, 0, 23.1); barrel(-48.9, 0, 23.6, 'metalRust');
    // open-front warehouse shed along the south wall
    b.boxMM('corrugated', -49.9, 3.6, 30.0, -40.5, 3.7, 35.9);
    for (const [x, z] of [[-49.7, 30.2], [-45.2, 30.2], [-40.7, 30.2]]) b.box('woodDark', x, 0, z, 0.22, 3.6, 0.22);
    b.surface('metal', -50, 3.6, 30, -40.5, 4.1, 36);
    gatling(b, M, -45, 33.5);
    lantern(-45.2, 3.1, 30.5, true, 5, 0.3);
    spots.push({ name: '仓库集装箱', pos: new THREE.Vector3(-34.0, 0.14, 33.9), r: 2 });
    spots.push({ name: '仓库箱顶', pos: new THREE.Vector3(-36.4, 2.62, 16.2), r: 2.5 });
  }

  // --- Saloon (酒馆): ring ledge at 3.3 around the building, box stack access
  {
    const x0 = -26, x1 = -14, z0 = 11.5, z1 = 24, ly = 3.3;
    const sf = storefront({ x0, x1, zf: z0, depth: z1 - z0, face: 'n', h: 6.4, siding: 'sidingGreen', ff: 2.0, sign: 'SALOON', signOpts: { bg: '#3b1f14', fg: '#f3d9a0' }, porch: 2.5, awningH: ly - 0.14, balcony: true, balconyRails: false, kind: 'saloon', winLit: [0, 1, 3], doorMat: 'doorGreen' });
    // side + back ledges (1.0 m) with railings
    b.boxMM('planks', x0 - 1.0, ly - 0.14, z0 - 2.5, x0, ly, z1 + 1.0);
    b.boxMM('planks', x1, ly - 0.14, z0 - 2.5, x1 + 1.0, ly, z1 + 1.0);
    for (const x of [x0 - 0.92, x1 + 0.92]) b.box('wood', x, 0, z0 - 2.42, 0.16, ly - 0.14, 0.16);
    b.boxMM('planks', x0 - 1.0, ly - 0.14, z1, x1 + 1.0, ly, z1 + 1.0);
    b.surface('wood', x0 - 1.1, ly - 0.1, z0 - 2.6, x1 + 1.1, ly + 0.5, z1 + 1.1);
    for (const [x, z] of [[x0 - 0.95, z1 + 0.95], [x1 + 0.95, z1 + 0.95]]) b.box('wood', x, 0, z, 0.16, ly - 0.14, 0.16);
    for (let z = z0 + 3; z < z1; z += 3.5) { b.add('wood', new THREE.BoxGeometry(0.08, 0.08, 1.4), [x0 - 0.5, ly - 0.55, z], [0, Math.PI / 2, Math.PI / 4], { collide: false }); b.add('wood', new THREE.BoxGeometry(0.08, 0.08, 1.4), [x1 + 0.5, ly - 0.55, z], [0, Math.PI / 2, -Math.PI / 4], { collide: false }); }
    // only the back ledge gets a railing; the front/sides are an open ledge (CF flower-shop style)
    railing(x0 - 0.95, z1 + 0.95, x1 - 0.6, z1 + 0.95, ly, 0.95);
    // box stack at the back-east corner
    crate(-12.5, 0, 23.5, 1.15, 0.04); crate(-12.45, 1.15, 23.5, 1.1, -0.05); crate(-12.5, 0, 22.4, 1.1, 0.03);
    // hanging saloon sign at the NW corner + wagon (zombies can reach the ledge here)
    const vs = M.signMat('BAR', { w: 256, h: 512, bg: '#4a1d12', fg: '#f7dba1' });
    b.boxMM('woodDark', x0 - 1.6, ly + 0.9, 8.95, x0 + 0.3, ly + 1.0, 9.1, { collide: false });
    const hang = new THREE.Group();
    const hangMesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 0.8), [M.woodDark, M.woodDark, M.woodDark, M.woodDark, M[vs], M[vs]]);
    hangMesh.rotation.y = Math.PI / 2; hangMesh.position.y = -0.95; hangMesh.castShadow = true;
    hang.add(hangMesh); hang.position.set(x0 - 1.1, ly + 0.9, 9.0);
    b.extras.add(hang);
    b.animated.push({ kind: 'swing', obj: hang, amp: 0.06, speed: 1.3 });
    wagon(-28.3, 9.8, 0.08);
    trough(-20, 7.6, 0);
    barrel(-14.6, 0.45, 9.4); barrel(-15.3, 0.45, 9.3);
    for (const x of [-22.6, -17.4]) lantern(x, ly - 0.75, 9.3, x < -20, 5, 0.3);
    // swinging doors
    for (const sx of [-0.35, 0.35]) b.box('woodDark', x0 + 6 * 1 + sx, 1.0, z0 - 0.08, 0.66, 1.0, 0.05, 0, { collide: false });
    spots.push({ name: '酒馆窄台', pos: new THREE.Vector3(-20, ly + 0.05, 10.2), r: 5 });
    spots.push({ name: '酒馆后台', pos: new THREE.Vector3(-20, ly + 0.05, 24.5), r: 4 });
    void sf;
  }

  // --- Plaza south: well, gallows, water trough, hay, the bell-rope post
  well(b, M, 0, 16);
  gallows(b, M, -6.5, 25);
  trough(6.5, 12.2, 0.1);
  hayBale(8.5, 0, 17.5, 0.3); hayBale(8.9, 0.55, 17.4, 0.25); hayBale(9.3, 0, 18.4, 1.7);
  wagon(5.2, 23.5, 1.2, true);
  for (const [x, z] of [[-3.5, 10.4], [3.5, 10.4]]) postLantern(x, z);
  barrel(-8.6, 0, 12.2); barrel(-8.2, 0, 12.9); crate(-9.3, 0, 13.8, 1.0, 0.3);

  // --- Sheriff
  storefront({ x0: 14, x1: 26, zf: 11.5, depth: 11.5, face: 'n', h: 5.0, siding: 'sidingGray', ff: 1.6, sign: 'SHERIFF', signOpts: { bg: '#231a12', fg: '#e3c07a' }, kind: 'sheriff', winLit: [0] });
  panel('poster', 16.2, 2.0, 11.48, 0.5, 0.7, '-z');
  panel('poster2', 23.8, 2.0, 11.48, 0.5, 0.7, '-z');
  // --- General store
  storefront({ x0: 30, x1: 44, zf: 11.5, depth: 13.5, face: 'n', h: 5.5, siding: 'sidingWhite', ff: 1.9, sign: 'GENERAL STORE', signOpts: { bg: '#2a3326', fg: '#efe2b8' }, kind: 'store', awningMat: 'cloth', winLit: [2] });
  for (let i = 0; i < 5; i++) barrel(31 + i * 0.7, 0.45, 9.6 + (i % 2) * 0.3);
  crate(42.5, 0.45, 9.8, 0.8, 0.2); crate(42.5, 1.25, 9.8, 0.7, -0.1);
  hayBale(27.8, 0, 14, 1.57);

  // --- West end: town gate + corral
  {
    for (const z of [-7.2, 7.2]) { b.box('woodDark', -57, 0, z, 0.45, 7.2, 0.45); b.box('woodDark', -57, 0, z, 0.7, 0.8, 0.7); }
    b.boxMM('woodDark', -57.25, 6.5, -7.8, -56.75, 6.95, 7.8);
    const gs = M.signMat('SILENT VILLAGE', { w: 1024, h: 160, bg: '#2e2115', fg: '#e8cf98' });
    b.add(gs, new THREE.PlaneGeometry(8.4, 1.4), [-56.7, 5.55, 0], [0, Math.PI / 2, 0], { collide: false, uv: 'keep' });
    b.add(gs, new THREE.PlaneGeometry(8.4, 1.4), [-57.3, 5.55, 0], [0, -Math.PI / 2, 0], { collide: false, uv: 'keep' });
    b.boxMM('woodDark', -57.2, 4.8, -4.3, -56.8, 6.3, -4.1, { collide: false });
    b.boxMM('woodDark', -57.2, 4.8, 4.1, -56.8, 6.3, 4.3, { collide: false });
    fence(-62, -14, -52, -14); fence(-52, -14, -52, -26); fence(-52, -26, -62, -26);
    fence(-60, 14, -52, 14); fence(-52, 14, -52, 24);
    wagon(-60.5, 18.5, 2.2, true);
    hayBale(-55, 0, -19, 0.2); hayBale(-55.6, 0, -20.2, 1.4); trough(-58.5, -20, 1.57);
    stagecoach(b, M, -45, 3.8, 0.35);
  }
  // back alleys: sheds, outhouses, junk, graves, telegraph poles
  shed(b, M, -30.5, -33, 4.5, 3.5, 2.9);
  shed(b, M, 38, -32, 6, 4, 3.2);
  outhouse(b, M, -8, -33.5); outhouse(b, M, 6.5, -34, 0.3);
  outhouse(b, M, 20, 33, 3.3);
  for (let i = 0; i < 7; i++) grave(b, M, 28 + (i % 4) * 2.2, 34 + Math.floor(i / 4) * 2.4, rnd);
  fence(26, 31.5, 36, 31.5, 1.0); fence(26, 31.5, 26, 40); fence(36, 31.5, 36, 40);
  for (const [x, z, r] of [[-20, -31, 0.3], [-24, 32, 1.1], [12, 30, 0.2], [45, 33, 0.8], [2, -37, 1.3], [-60, -34, 0], [-60, 37, 0.6], [63, 38, 1]]) {
    crate(x, 0, z, 1.1, r); crate(x + 1.2, 0, z + 0.3, 1.0, r + 0.3);
  }
  for (const [x, z] of [[-16, 30], [18, -34], [-42, -34], [-2, 36.5], [50, 26], [-62, 0.5]]) barrel(x, 0, z);
  sandbags(-4, -31, 2, -31, 2);
  { const poles = [-50, -30.5, -12.5, 12, 31.5, 49]; poles.forEach((x, i) => telegraph(b, M, x, -8.3, poles[i + 1])); }
  deadTree(b, M, -61, -36, 0.9); deadTree(b, M, 61, 30, 1.2); deadTree(b, M, 46, -37, 0.8);
  for (const [x, z, s] of [[-62, 30, 1], [62, -12, 0.9], [-30, 40, 1.1], [30, -38.5, 0.8]]) cactus(b, M, x, z, s);
  for (const [x, z, s] of [[-54, -2, 1], [10, 38, 0.8], [52, 20, 1.1], [-28, -37, 0.9]]) skull(b, M, x, z, s);
  wagon(40, -34, 0.7, true);

  // ---- extra clutter: street edges, alleys, both ends
  const woodpile = (x, z, ry = 0) => {
    for (let r = 0; r < 3; r++) for (let i = 0; i < 4 - r; i++) {
      b.cyl('woodDark', x + (i - (3 - r) / 2) * 0.32 * Math.cos(ry), 0.16 + r * 0.28, z - (i - (3 - r) / 2) * 0.32 * Math.sin(ry), 0.15, 0.15, 1.6, 7, { rot: [Math.PI / 2, ry, 0], collide: false });
    }
    b.addCollider(new THREE.BoxGeometry(1.4, 0.9, 1.6), [x, 0.45, z], [0, ry, 0]);
  };
  const laundry = (x0, z0, x1, z1) => {
    for (const [x, z] of [[x0, z0], [x1, z1]]) b.box('woodDark', x, 0, z, 0.1, 2.3, 0.1, 0, { collide: false });
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
    b.add('rope', new THREE.BoxGeometry(0.015, 0.015, len), [(x0 + x1) / 2, 2.2, (z0 + z1) / 2], [0, ang, 0], { collide: false });
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      b.add(i % 2 ? 'cloth' : 'clothRed', new THREE.PlaneGeometry(0.7, 0.9), [x0 + (x1 - x0) * t, 1.72, z0 + (z1 - z0) * t], [0, ang + Math.PI / 2, 0], { collide: false, uv: 'keep' });
    }
  };
  // street edge cover (keeps the middle lane open for zombie rushes)
  for (const [x, z, r] of [[-31, -7.4, 0.2], [11.5, -7.2, 0.5], [29.5, 7.6, 0.1], [-11.8, 7.8, 0.3], [47.5, -6.5, 0.2]]) { crate(x, 0, z, 1.0, r); barrel(x + 1.1, 0, z + 0.2); }
  wagon(15, 5.8, 1.62);
  hayBale(-30, 0, 6.8, 0.1); hayBale(-29.4, 0.55, 6.9, 0.2);
  // north alley yards
  fence(-46, -30.5, -36, -30.5, 1.1); fence(-26, -31, -18, -31, 1.1); fence(30, -30, 44, -30, 1.1);
  woodpile(-44, -33, 0.3); woodpile(-12.5, -30.5, 1.4); woodpile(33, -33.5, 0.1);
  laundry(-38, -33, -33, -36); laundry(44, -33.5, 48, -37);
  shed(b, M, 24, -34.5, 5, 3.4, 2.8);
  for (const [x, z] of [[-35, -28.2], [16, -27.6], [46.5, -27]]) { barrel(x, 0, z); barrel(x + 0.7, 0, z + 0.2, 'metalRust'); }
  wagon(-3, -36.5, 1.4, true);
  crate(-16.5, 0, -28.5, 1.2, 0.2); crate(-16.4, 1.2, -28.4, 1.0, 0.5);
  // south alley: corral, barn-ish shed, junk
  fence(-24, 28, -12, 28, 1.2); fence(-12, 28, -12, 38, 1.2); fence(-24, 28, -24, 38, 1.2);
  hayBale(-18, 0, 33, 0.4); hayBale(-17.2, 0, 34.2, 1.2); hayBale(-17.6, 0.55, 33.6, 0.8); trough(-20.5, 36, 0);
  shed(b, M, 12, 34, 6, 4.5, 3.2);
  woodpile(46, 29, 1.2); laundry(2, 31, 7, 35);
  for (const [x, z] of [[27.5, 27.5], [-2.8, 29.3], [48.5, 18]]) { crate(x, 0, z, 1.1, 0.3); barrel(x - 0.9, 0, z + 0.5); }
  // east end: cargo by the station, handcar on the tracks
  crate(50.2, 0, 10.5, 1.2, 0.1); crate(50.3, 1.2, 10.6, 1.1, 0.35); crate(50.2, 0, 12, 1.1, -0.2);
  crate(53.2, 0.9, 13.5, 1.0, 0.2); barrel(52.2, 0.9, -6.5); barrel(52.8, 0.9, -6.9); hayBale(54.5, 0.9, -5.5, 0.2);
  b.box('planksDark', 59.5, 0.3, -20, 1.8, 0.25, 2.4); b.box('iron', 59.5, 0.55, -20, 0.1, 0.9, 0.1, 0, { collide: false });
  b.box('iron', 59.5, 1.45, -20, 1.4, 0.08, 0.08, 0, { collide: false });
  // west end
  crate(-60, 0, -8.5, 1.1, 0.2); crate(-61.1, 0, -8.2, 1.0, 0.6); barrel(-60.3, 1.1, -8.6);
  woodpile(-62, 9.5, 1.57); for (let i = 0; i < 4; i++) grave(b, M, -62 + i * 1.8, -31, rnd);

  // boundary walls (invisible) + cliffs
  const H = 40;
  b.solidMM(BOUNDS.x0 - 2, -5, BOUNDS.z0 - 2, BOUNDS.x0, H, BOUNDS.z1 + 2);
  b.solidMM(BOUNDS.x1, -5, BOUNDS.z0 - 2, BOUNDS.x1 + 2, H, BOUNDS.z1 + 2);
  b.solidMM(BOUNDS.x0 - 2, -5, BOUNDS.z0 - 2, BOUNDS.x1 + 2, H, BOUNDS.z0);
  b.solidMM(BOUNDS.x0 - 2, -5, BOUNDS.z1, BOUNDS.x1 + 2, H, BOUNDS.z1 + 2);
  const cliffs = buildCliffs(M, quality);
  scene.add(cliffs);
  const roads = buildRoads(M);
  scene.add(roads);

  const out = b.build(scene);

  // spawn points: everyone starts in the central plaza (CF style)
  const spawns = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2, r = 3 + (i % 3) * 2.2;
    spawns.push(new THREE.Vector3(Math.cos(a) * r * 1.3, 0.05, Math.sin(a) * r * 0.8 + 1));
  }
  const zombieSpawns = [
    new THREE.Vector3(0, 0.05, 2), new THREE.Vector3(-8, 0.05, -3), new THREE.Vector3(8, 0.05, 4),
    new THREE.Vector3(-54, 0.05, 0), new THREE.Vector3(56, 0.05, -2), new THREE.Vector3(2, 0.05, 30),
    new THREE.Vector3(-2, 0.05, -34), new THREE.Vector3(-30, 0.05, -30), new THREE.Vector3(30, 0.05, 36),
  ];
  const supply = [
    new THREE.Vector3(0, 0.05, 20), new THREE.Vector3(-41, 0.05, 22), new THREE.Vector3(20, 0.05, -30),
    new THREE.Vector3(-22, 0.05, -35), new THREE.Vector3(40, 0.05, 29), new THREE.Vector3(48, 0.05, 5),
  ];

  return {
    ...out,
    ladders: b.ladders,
    surfaces: b.surfaces,
    animated: b.animated,
    lightSpots,
    spots,
    spawns,
    zombieSpawns,
    supply,
    footprints,
    holes,
    bounds: BOUNDS,
  };
}

// ======================================================================== props
function waterTower(b, M, x, z, hb) {
  const r = 2.7, th = 4.0;
  for (const [dx, dz] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) {
    b.add('woodDark', new THREE.BoxGeometry(0.3, hb + 0.2, 0.3), [x + dx, hb / 2, z + dz], [dz * 0.025, 0, -dx * 0.025]);
  }
  for (const yy of [2.8, 6.0]) {
    b.boxMM('wood', x - 2.05, yy, z - 2.0, x + 2.05, yy + 0.15, z - 1.85, { collide: false });
    b.boxMM('wood', x - 2.05, yy, z + 1.85, x + 2.05, yy + 0.15, z + 2.0, { collide: false });
    b.boxMM('wood', x - 2.0, yy, z - 2.05, x - 1.85, yy + 0.15, z + 2.05, { collide: false });
    b.boxMM('wood', x + 1.85, yy, z - 2.05, x + 2.0, yy + 0.15, z + 2.05, { collide: false });
  }
  b.boxMM('planks', x - 2.6, hb - 0.2, z - 2.6, x + 2.6, hb, z + 2.6);
  b.cyl('sidingGray', x, hb, z, r, r, th, 24);
  for (const yy of [0.5, 1.9, 3.3]) b.cyl('iron', x, hb + yy, z, r + 0.03, r + 0.03, 0.08, 24, { collide: false });
  b.add('shingles', new THREE.ConeGeometry(r + 0.3, 1.6, 24), [x, hb + th + 0.8, z]);
  b.cyl('metalDark', x + 2.2, 1.8, z, 0.12, 0.12, hb - 1.8, 8, { collide: false });
}

function windmill(b, M, x, z) {
  const h = 11;
  for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
    b.add('woodDark', new THREE.BoxGeometry(0.14, h + 0.5, 0.14), [x + dx * 0.62, h / 2, z + dz * 0.62], [dz * 0.1, 0, -dx * 0.1]);
  }
  for (let yy = 1.5; yy < h; yy += 2.6) {
    const s = 1.2 * (1 - yy / h * 0.55);
    b.boxMM('wood', x - s, yy, z - 0.04, x + s, yy + 0.08, z + 0.04, { collide: false });
    b.boxMM('wood', x - 0.04, yy, z - s, x + 0.04, yy + 0.08, z + s, { collide: false });
  }
  b.box('metalDark', x, h, z, 0.5, 0.5, 1.2);
  const rotor = new THREE.Group();
  const bladeMat = M.metalRust;
  for (let i = 0; i < 16; i++) {
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 2.2, 0.02), bladeMat);
    bl.position.set(0, 1.4, 0); bl.rotation.y = 0.5;
    const arm = new THREE.Group(); arm.add(bl); arm.rotation.z = (i / 16) * Math.PI * 2;
    rotor.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 10), M.iron);
  hub.rotation.x = Math.PI / 2; rotor.add(hub);
  rotor.position.set(x, h + 0.25, z - 0.75);
  rotor.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  b.extras.add(rotor);
  b.animated.push({ kind: 'rotor', obj: rotor, speed: 0.6 });
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.1, 1.6), M.metalRust);
  tail.position.set(x, h + 0.35, z + 1.4); b.extras.add(tail);
}

function railway(b, M, x) {
  // tracks N–S, station platform + boxcar (enterable)
  for (let z = -40; z < 42; z += 0.7) b.boxMM('woodDark', x - 1.3, 0, z, x + 1.3, 0.14, z + 0.24, { collide: false });
  for (const dx of [-0.72, 0.72]) b.boxMM('rail', x + dx - 0.04, 0.14, -40, x + dx + 0.04, 0.26, 42, { collide: false });
  b.boxMM('planks', 51.2, 0, -8, 55.4, 0.9, 16);
  b.boxMM('stone', 51.15, 0, -8.05, 55.45, 0.35, 16.05, { collide: false });
  b.surface('wood', 51.2, 0.6, -8, 55.4, 1.4, 16);
  b.rampCollider(50.2, -8, 51.2, 16, 0, 0.9, '+x');
  for (const z of [-7.8, 15.8]) b.rampCollider(51.2, z < 0 ? -9 : 16, 55.4, z < 0 ? -8 : 17, 0, 0.9, z < 0 ? '+z' : '-z');
  // station shelter
  for (const z of [-2, 4, 10]) b.box('woodDark', 52, 0.9, z, 0.2, 3.0, 0.2);
  b.add('shingles', new THREE.BoxGeometry(2.6, 0.1, 14), [52.8, 4.05, 4], [0, 0, -0.18]);
  b.surface('wood', 51.4, 3.6, -3.2, 54.2, 4.6, 11.2);
  // boxcar: hollow with open side door facing the platform (west)
  const bx0 = x - 1.45, bx1 = x + 1.45, bz0 = -2, bz1 = 10, by = 1.0, bh = 3.0;
  b.boxMM('metalDark', bx0, 0.45, bz0, bx1, by, bz1);
  b.boxMM('planksDark', bx0, by, bz0, bx1, by + 0.08, bz1);
  b.surface('wood', bx0, by, bz0, bx1, by + 0.4, bz1);
  b.boxMM('sidingRed', bx1 - 0.1, by, bz0, bx1, by + bh, bz1);
  b.boxMM('sidingRed', bx0, by, bz0, bx1, by + bh, bz0 + 0.1);
  b.boxMM('sidingRed', bx0, by, bz1 - 0.1, bx1, by + bh, bz1);
  b.boxMM('sidingRed', bx0, by, bz0, bx0 + 0.1, by + bh, 2.5);
  b.boxMM('sidingRed', bx0, by, 5.5, bx0 + 0.1, by + bh, bz1);
  b.boxMM('sidingRed', bx0, by + 2.4, 2.5, bx0 + 0.1, by + bh, 5.5);
  b.add('corrugatedRust', new THREE.BoxGeometry(3.2, 0.1, 12.2), [x, by + bh + 0.15, 4], [0, 0, 0]);
  b.surface('metal', bx0, by + bh, bz0, bx1, by + bh + 0.6, bz1);
  b.boxMM('sidingRed', bx0 - 0.12, by, 5.5, bx0 - 0.04, by + 2.45, 8.6, { collide: true }); // slid-open door
  for (const zz of [0, 8]) for (const dx of [-0.72, 0.72]) {
    b.cyl('iron', x + dx, 0.45, zz, 0.42, 0.42, 0.12, 14, { collide: false, rot: [0, 0, Math.PI / 2] });
  }
  b.rampCollider(55.4, 2.6, bx0, 5.4, 0.9, by + 0.05, '+x');
  b.boxMM('planksDark', 55.4, 0.86, 2.6, bx0, 0.96, 5.4, { collide: false });
}

function gatling(b, M, x, z) {
  // decorative mounted gatling gun on a wheeled carriage
  const g = new THREE.Group();
  const barrelMat = M.iron;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6), barrelMat);
    br.rotation.x = Math.PI / 2; br.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, -0.55);
    g.add(br);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.5), M.brass); body.position.z = 0.15; g.add(body);
  const hopper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 0.2), M.brass); hopper.position.set(0, 0.25, 0.1); g.add(hopper);
  g.position.set(x, 1.05, z); g.rotation.y = Math.PI * 0.9;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  b.extras.add(g);
  b.box('woodDark', x, 0.4, z, 0.9, 0.5, 1.2, 0.3);
  for (const s of [-1, 1]) b.cyl('woodDark', x + s * 0.55, 0.05, z, 0.45, 0.45, 0.08, 12, { rot: [0, 0.3, Math.PI / 2], collide: false });
}

function well(b, M, x, z) {
  b.cyl('stone', x, 0, z, 1.25, 1.35, 0.95, 18);
  b.cyl('water', x, 0.6, z, 1.0, 1.0, 0.02, 18, { collide: false });
  for (const s of [-1, 1]) b.box('woodDark', x + s * 1.15, 0.95, z, 0.16, 1.9, 0.16);
  b.cyl('woodDark', x, 2.5, z, 0.08, 0.08, 2.5, 8, { rot: [0, 0, Math.PI / 2], collide: false });
  b.add('shingles', new THREE.BoxGeometry(3.0, 0.08, 1.4), [x, 3.2, z - 0.55], [0.5, 0, 0], { collide: false });
  b.add('shingles', new THREE.BoxGeometry(3.0, 0.08, 1.4), [x, 3.2, z + 0.55], [-0.5, 0, 0], { collide: false });
  b.cyl('rope', x, 1.4, z, 0.01, 0.01, 1.1, 4, { collide: false });
  b.cyl('woodDark', x, 1.1, z, 0.14, 0.12, 0.3, 10, { collide: false });
}

function gallows(b, M, x, z) {
  b.boxMM('planks', x - 2.2, 0, z - 1.6, x + 2.2, 2.2, z + 1.6);
  b.surface('wood', x - 2.2, 2.0, z - 1.6, x + 2.2, 2.6, z + 1.6);
  b.stairs('planks', x - 1.4, z - 4.4, x - 0.2, z - 1.6, 0, 2.2, '+z', { stringer: 'woodDark' });
  for (const s of [-1, 1]) b.box('woodDark', x + s * 1.6, 2.2, z + 0.9, 0.22, 3.3, 0.22);
  b.boxMM('woodDark', x - 1.8, 5.4, z + 0.8, x + 1.8, 5.62, z + 1.02);
  b.cyl('rope', x + 0.4, 4.1, z + 0.9, 0.02, 0.02, 1.35, 5, { collide: false });
  b.add('rope', new THREE.TorusGeometry(0.16, 0.025, 5, 12), [x + 0.4, 3.95, z + 0.9], [0, 0, 0], { collide: false });
  b.boxMM('woodDark', x - 0.2, 2.18, z + 0.4, x + 1.0, 2.22, z + 1.4, { collide: false });
}

function stagecoach(b, M, x, z, ry) {
  b.box('sidingRed', x, 1.0, z, 1.7, 1.6, 2.8, ry);
  b.box('woodDark', x, 2.6, z, 1.8, 0.1, 3.0, ry, { collide: false });
  b.box('woodDark', x, 0.75, z, 1.5, 0.25, 3.6, ry);
  const c = Math.cos(ry), s = Math.sin(ry);
  for (const [lx, lz, r] of [[-0.95, -1.2, 0.55], [0.95, -1.2, 0.55], [-0.95, 1.3, 0.75], [0.95, 1.3, 0.75]]) {
    const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
    const tor = new THREE.TorusGeometry(r, 0.05, 6, 18);
    b.add('woodDark', tor, [wx, r, wz], [0, ry + Math.PI / 2, 0], { collide: false });
  }
  b.surface('wood', x - 1.8, 2.5, z - 1.8, x + 1.8, 3.2, z + 1.8);
}

function shed(b, M, x, z, w, d, h) {
  b.boxMM('sidingGray', x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2);
  b.add('corrugatedRust', new THREE.BoxGeometry(w + 0.5, 0.08, d + 0.6), [x, h + 0.2, z], [0.12, 0, 0]);
  b.surface('metal', x - w / 2, h, z - d / 2, x + w / 2, h + 0.8, z + d / 2);
}

function outhouse(b, M, x, z, ry = 0) {
  b.box('wood', x, 0, z, 1.2, 2.3, 1.2, ry);
  b.box('woodDark', x, 2.3, z, 1.4, 0.1, 1.4, ry, { collide: false });
}

function grave(b, M, x, z, rnd) {
  b.box('woodDark', x, 0, z, 0.1, 1.1, 0.1, (rnd() - 0.5) * 0.3, { collide: false });
  b.box('woodDark', x, 0.7, z, 0.55, 0.09, 0.08, (rnd() - 0.5) * 0.3, { collide: false });
  b.box('ground', x, 0, z + 0.9, 0.7, 0.18, 1.6, 0, { collide: false });
}

function telegraph(b, M, x, z, nextX) {
  b.cyl('woodDark', x, 0, z, 0.12, 0.15, 8.5, 8, { collide: true });
  b.boxMM('woodDark', x - 1.0, 7.6, z - 0.06, x + 1.0, 7.75, z + 0.06, { collide: false });
  for (const dx of [-0.8, -0.3, 0.3, 0.8]) b.cyl('bone', x + dx, 7.75, z, 0.03, 0.03, 0.12, 5, { collide: false });
  if (nextX !== undefined) {
    // sagging wires to the next pole
    const span = nextX - x;
    for (const dx of [-0.8, 0.8]) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3(x + dx + span * t, 7.85 - Math.sin(t * Math.PI) * 0.8, z)); }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.012, 3, false);
      b.add('iron', geo, [0, 0, 0], [0, 0, 0], { collide: false, uv: 'keep' });
    }
  }
}

function deadTree(b, M, x, z, s) {
  const mat = 'woodDark';
  const branch = (x0, y0, z0, len, rx, rz, r, depth) => {
    const geo = new THREE.CylinderGeometry(r * 0.6, r, len, 6);
    geo.translate(0, len / 2, 0);
    const e = new THREE.Euler(rx, 0, rz);
    b.add(mat, geo, [x0, y0, z0], [rx, 0, rz], { collide: false });
    if (depth <= 0) return;
    const tip = new THREE.Vector3(0, len, 0).applyEuler(e);
    branch(x0 + tip.x, y0 + tip.y, z0 + tip.z, len * 0.7, rx + 0.5, rz - 0.4, r * 0.6, depth - 1);
    branch(x0 + tip.x, y0 + tip.y, z0 + tip.z, len * 0.65, rx - 0.45, rz + 0.55, r * 0.6, depth - 1);
  };
  branch(x, 0, z, 3.2 * s, 0.05, 0.1, 0.22 * s, 3);
  b.addCollider(new THREE.CylinderGeometry(0.25, 0.25, 3, 6), [x, 1.5, z]);
}

function cactus(b, M, x, z, s) {
  b.add('cactus', new THREE.CapsuleGeometry(0.28 * s, 3.2 * s, 4, 10), [x, 1.9 * s, z], [0, 0, 0]);
  b.add('cactus', new THREE.CapsuleGeometry(0.18 * s, 1.0 * s, 4, 8), [x + 0.55 * s, 2.3 * s, z], [0, 0, 0], { collide: false });
  b.add('cactus', new THREE.CapsuleGeometry(0.15 * s, 0.5 * s, 4, 8), [x + 0.35 * s, 1.75 * s, z], [0, 0, Math.PI / 2], { collide: false });
  b.add('cactus', new THREE.CapsuleGeometry(0.16 * s, 0.8 * s, 4, 8), [x - 0.5 * s, 2.8 * s, z], [0, 0, 0], { collide: false });
  b.add('cactus', new THREE.CapsuleGeometry(0.13 * s, 0.45 * s, 4, 8), [x - 0.33 * s, 2.4 * s, z], [0, 0, Math.PI / 2], { collide: false });
}

function skull(b, M, x, z, s) {
  b.add('bone', new THREE.SphereGeometry(0.2 * s, 10, 8), [x, 0.12 * s, z], [0, 0, 0], { collide: false });
  b.add('bone', new THREE.CylinderGeometry(0.03 * s, 0.05 * s, 0.9 * s, 5), [x + 0.25 * s, 0.1 * s, z], [0.3, 0.6, Math.PI / 2 - 0.3], { collide: false });
  b.add('bone', new THREE.CylinderGeometry(0.03 * s, 0.05 * s, 0.9 * s, 5), [x - 0.25 * s, 0.1 * s, z], [0.3, -0.6, Math.PI / 2 + 0.3], { collide: false });
}

// Ground: thick slab with rectangular holes (stairwells), split into strips.
function groundWithHoles(b, x0, x1, z0, z1, holes) {
  const xs = new Set([x0, x1]), zs = new Set([z0, z1]);
  for (const h of holes) { xs.add(h.x0); xs.add(h.x1); zs.add(h.z0); zs.add(h.z1); }
  const X = [...xs].sort((a, c) => a - c), Z = [...zs].sort((a, c) => a - c);
  for (let i = 0; i < X.length - 1; i++) {
    for (let j = 0; j < Z.length - 1; j++) {
      const cx = (X[i] + X[i + 1]) / 2, cz = (Z[j] + Z[j + 1]) / 2;
      if (holes.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1)) continue;
      // tile into <= 10 m pieces so the collision octree stays shallow
      const nx = Math.ceil((X[i + 1] - X[i]) / 10), nz = Math.ceil((Z[j + 1] - Z[j]) / 10);
      for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
        const ax = X[i] + (X[i + 1] - X[i]) * a / nx, bx = X[i] + (X[i + 1] - X[i]) * (a + 1) / nx;
        const az = Z[j] + (Z[j + 1] - Z[j]) * c / nz, bz = Z[j] + (Z[j + 1] - Z[j]) * (c + 1) / nz;
        b.boxMM('ground', ax, -0.5, az, bx, 0, bz);
      }
    }
  }
}

function roadAlpha(across) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 8;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 8);
  for (let x = 0; x < 256; x++) {
    const t = x / 255;
    const e = Math.min(t, 1 - t) / across;
    const a = Math.max(0, Math.min(1, e));
    for (let y = 0; y < 8; y++) {
      const i = (y * 256 + x) * 4;
      const v = Math.round(255 * a * a * (3 - 2 * a));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildRoads(M) {
  const group = new THREE.Group();
  const set = Tex.road({ seed: 12 });
  const mk = (x0, x1, z0, z1, alongX) => {
    const w = x1 - x0, d = z1 - z0;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const uv2 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (x0 + x1) / 2, z = pos.getZ(i) + (z0 + z1) / 2;
      // u across the road (0..1 for the alpha fade), v along it in meters/8
      if (alongX) { uv.setXY(i, (z - z0) / d, x / 8); uv2[i * 2] = (z - z0) / d; uv2[i * 2 + 1] = 0.5; }
      else { uv.setXY(i, (x - x0) / w, z / 8); uv2[i * 2] = (x - x0) / w; uv2[i * 2 + 1] = 0.5; }
    }
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv2, 2));
    const acrossM = alongX ? d : w;
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    mat.map = set.map.clone(); mat.map.repeat.set(acrossM / 8, 1);
    mat.normalMap = set.normalMap.clone(); mat.normalMap.repeat.set(acrossM / 8, 1);
    if (set.roughnessMap) { mat.roughnessMap = set.roughnessMap.clone(); mat.roughnessMap.repeat.set(acrossM / 8, 1); }
    mat.alphaMap = roadAlpha(0.18); mat.alphaMap.channel = 1;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((x0 + x1) / 2, 0.015, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1;
    group.add(mesh);
  };
  mk(-66, 66, -10.5, 10.5, true);
  mk(-11, 11, 7, 32, false);
  mk(-8, 8, -12, -7, false);
  return group;
}

// Canyon walls around the town (visual only; boundary is invisible walls).
function buildCliffs(M, quality) {
  const seg = quality === 'low' ? 110 : 190;
  const W = 420, D = 360;
  const geo = new THREE.PlaneGeometry(W, D, seg, Math.round(seg * D / W));
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const n2 = (x, z) => fbm(x * 0.03, z * 0.03);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const dx = Math.max(BOUNDS.x0 - x, x - BOUNDS.x1, 0), dz = Math.max(BOUNDS.z0 - z, z - BOUNDS.z1, 0);
    const d = Math.hypot(dx, dz);
    let y = -0.6;
    if (d > 0.5) {
      const n = n2(x, z);
      const base = Math.min(1, (d - 0.5) / 7);
      const tall = 18 + n * 26 + fbm(x * 0.008 + 5, z * 0.008) * 30;
      y = base * base * (3 - 2 * base) * tall;
      // irregular strata ledges blended with the raw slope, plus erosion noise
      const step = 3.1 + fbm(x * 0.02 + 9, z * 0.02) * 2.2;
      const terr = Math.floor(y / step) * step + smooth01((y % step) / step) * step;
      y = y + (terr - y) * (0.35 + 0.4 * fbm(x * 0.05, z * 0.05 + 3));
      y += (fbm(x * 0.18, z * 0.18) - 0.5) * 3.2 * base + (fbm(x * 0.6, z * 0.6) - 0.5) * 0.8 * base;
      // occasional buttes/spires on the rim
      const sp = fbm(x * 0.045 + 21, z * 0.045 - 7);
      if (sp > 0.62 && d > 10) y += (sp - 0.62) * 90 * Math.min(1, (d - 10) / 12);
      if (d > 60) y *= Math.max(0.35, 1 - (d - 60) / 120);
    }
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  // box-ish UVs in meters (use x/z on flats, blend along the dominant horizontal for walls)
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), nz = Math.abs(nor.getZ(i)), ny = Math.abs(nor.getY(i));
    if (ny > 0.8) uv.setXY(i, x, z);
    else if (nx > nz) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  const mat = M.rock;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'cliffs';
  return mesh;
}

function smooth01(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

// small value noise for terrain
function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b2 = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b2 - a) * u + (c - a) * v + (a - b2 - c + d) * u * v;
}
function fbm(x, z) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { s += vnoise(x * f, z * f) * a; f *= 2.03; a *= 0.5; }
  return s;
}

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

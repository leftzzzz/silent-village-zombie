// Static-world builder: accumulates geometry per material (merged into a handful of
// draw calls), a separate collision geometry list (for the Octree), ladder volumes
// and misc markers. All helper dimensions are in meters.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _n = new THREE.Vector3();

// Planar "box" UV projection in meters, computed in the geometry's local space
// (after any scaling is baked in). Keeps texel density constant everywhere.
export function applyBoxUV(geo, offset = 0) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z * Math.sign(nor.getX(i) || 1); v = y; }
    else { u = -x * Math.sign(nor.getZ(i) || 1); v = y; }
    uv[i * 2] = u + offset;
    uv[i * 2 + 1] = v + offset * 0.37;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

function prep(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  }
  g.clearGroups();
  return g;
}

export class WorldBuilder {
  constructor() {
    this.mats = new Map();       // key -> THREE.Material
    this.batches = new Map();    // key -> BufferGeometry[]
    this.noShadow = new Set();   // material keys that don't cast shadows
    this.colliders = [];         // world-space BufferGeometry[]
    this.ladders = [];           // {box: Box3, normal: Vector3 (points away from wall, toward climber), top}
    this.lights = [];
    this.animated = [];          // objects to animate each frame: {obj, update(t, dt)}
    this.extras = new THREE.Group(); // non-merged meshes (animated props)
    this.surfaces = [];          // {box: Box3, type: 'wood'|'metal'|'dirt'} footstep/impact material hints
  }

  defMat(key, mat, { castShadow = true } = {}) {
    this.mats.set(key, mat);
    if (!castShadow) this.noShadow.add(key);
    return mat;
  }

  // Add a geometry (local space) with transform. opts: {collide, uv:'box'|'keep', uvOffset}
  add(matKey, geo, pos = [0, 0, 0], rot = [0, 0, 0], opts = {}) {
    const { collide = true, uv = 'box', uvOffset = 0, visual = true } = opts;
    if (uv === 'box') applyBoxUV(geo, uvOffset);
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _p.set(pos[0], pos[1], pos[2]);
    _m.compose(_p, _q, _s);
    const g = prep(geo);
    g.applyMatrix4(_m);
    if (import.meta.env && import.meta.env.DEV) {
      const arr = g.attributes.position.array;
      for (let i = 0; i < arr.length; i++) if (Number.isNaN(arr[i])) { console.error('NaN geometry', matKey, JSON.stringify(pos), JSON.stringify(rot), new Error().stack.split('\n').slice(2, 5).join(' | ')); break; }
    }
    if (visual) {
      if (!this.batches.has(matKey)) this.batches.set(matKey, []);
      this.batches.get(matKey).push(g);
    }
    if (collide) this.colliders.push(g.clone());
    return g;
  }

  addCollider(geo, pos = [0, 0, 0], rot = [0, 0, 0]) {
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _p.set(pos[0], pos[1], pos[2]);
    _m.compose(_p, _q, _s);
    const g = prep(geo);
    g.applyMatrix4(_m);
    this.colliders.push(g);
  }

  // Axis-aligned box from min/max corners.
  boxMM(mat, x0, y0, z0, x1, y1, z1, opts = {}) {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
    if (w < 1e-4 || h < 1e-4 || d < 1e-4) return;
    const geo = new THREE.BoxGeometry(w, h, d);
    return this.add(mat, geo, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [0, 0, 0], opts);
  }

  // Box by center-bottom position, size and optional Y rotation.
  box(mat, x, y, z, w, h, d, ry = 0, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    return this.add(mat, geo, [x, y + h / 2, z], [0, ry, 0], opts);
  }

  // Invisible collision-only box (min/max)
  solidMM(x0, y0, z0, x1, y1, z1) {
    const geo = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
    this.addCollider(geo, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
  }

  // Wedge ramp between two heights. dir: '+x','-x','+z','-z' = direction of ascent.
  rampGeo(w, d, h0, h1, dir) {
    // local: x in [-w/2,w/2], z in [-d/2,d/2]; ascends along +z by default
    const hw = w / 2, hd = d / 2;
    const v = [
      // bottom
      [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd],
      // top
      [-hw, h0, -hd], [hw, h0, -hd], [hw, h1, hd], [-hw, h1, hd],
    ];
    const quads = [
      [4, 7, 6, 5], // top (normal up-ish)
      [0, 1, 2, 3], // bottom
      [0, 4, 5, 1], // -z face
      [3, 2, 6, 7], // +z face
      [0, 3, 7, 4], // -x
      [1, 5, 6, 2], // +x
    ];
    const pos = [];
    for (const q of quads) {
      const [a, b, c, dd] = q.map((i) => v[i]);
      pos.push(...a, ...b, ...c, ...a, ...c, ...dd);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const ry = { '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[dir] || 0;
    return { geo, ry };
  }

  // Collision ramp (invisible). x0..x1, z0..z1 footprint, ascending in dir from y0 to y1.
  rampCollider(x0, z0, x1, z1, y0, y1, dir) {
    const alongX = dir === '+x' || dir === '-x';
    const w = alongX ? Math.abs(z1 - z0) : Math.abs(x1 - x0);
    const d = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const { geo, ry } = this.rampGeo(w, d, 0, y1 - y0, dir);
    // flip handedness fix: build face winding with thickness so the octree sees a solid
    this.addCollider(geo, [(x0 + x1) / 2, y0, (z0 + z1) / 2], [0, ry, 0]);
  }

  // Visible stairs + invisible ramp collider. Ascends in `dir` from y0 to y1.
  stairs(mat, x0, z0, x1, z1, y0, y1, dir, { stringer = null, stepH = 0.2 } = {}) {
    const n = Math.max(2, Math.round((y1 - y0) / stepH));
    const alongX = dir === '+x' || dir === '-x';
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const run = len / n, rise = (y1 - y0) / n;
    for (let i = 0; i < n; i++) {
      const t0 = i * run, t1 = (i + 1) * run;
      const top = y0 + rise * (i + 1);
      let a0, a1;
      if (dir === '+z') { a0 = z0 + t0; a1 = z0 + t1; this.boxMM(mat, x0, top - 0.06, a0, x1, top, a1 + 0.02, { collide: false }); }
      if (dir === '-z') { a0 = z1 - t1; a1 = z1 - t0; this.boxMM(mat, x0, top - 0.06, a0 - 0.02, x1, top, a1, { collide: false }); }
      if (dir === '+x') { a0 = x0 + t0; a1 = x0 + t1; this.boxMM(mat, a0, top - 0.06, z0, a1 + 0.02, top, z1, { collide: false }); }
      if (dir === '-x') { a0 = x1 - t1; a1 = x1 - t0; this.boxMM(mat, a0 - 0.02, top - 0.06, z0, a1, top, z1, { collide: false }); }
    }
    if (stringer) {
      // two sloped side beams
      const L = Math.hypot(len, y1 - y0);
      const ang = Math.atan2(y1 - y0, len);
      const cy = (y0 + y1) / 2 - 0.12;
      if (alongX) {
        const cx = (x0 + x1) / 2, s = dir === '+x' ? 1 : -1;
        for (const zz of [Math.min(z0, z1) + 0.04, Math.max(z0, z1) - 0.04]) {
          this.add(stringer, new THREE.BoxGeometry(L, 0.28, 0.08), [cx, cy, zz], [0, 0, s * ang], { collide: false });
        }
      } else {
        const cz = (z0 + z1) / 2, s = dir === '+z' ? -1 : 1;
        for (const xx of [Math.min(x0, x1) + 0.04, Math.max(x0, x1) - 0.04]) {
          this.add(stringer, new THREE.BoxGeometry(0.08, 0.28, L), [xx, cy, cz], [s * ang, 0, 0], { collide: false });
        }
      }
    }
    this.rampCollider(x0, z0, x1, z1, y0, y1 + 0.02, dir);
  }

  cyl(mat, x, y, z, rTop, rBot, h, seg = 12, opts = {}) {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, opts.open || false);
    const { rot = [0, 0, 0] } = opts;
    return this.add(mat, geo, [x, y + h / 2, z], rot, opts);
  }

  // Ladder: rails + rungs visual; climb volume on the side the climber stands.
  // (x,z) = foot of ladder against a wall; facing = unit dir from wall toward climber.
  ladder(mat, x, z, y0, y1, facing = [0, 1], width = 0.55) {
    const [fx, fz] = facing;
    const px = -fz, pz = fx; // perpendicular (along wall)
    const h = y1 - y0 + 1.0;
    for (const s of [-1, 1]) {
      this.box(mat, x + px * s * width / 2, y0, z + pz * s * width / 2, 0.07, h, 0.07, 0, { collide: false });
    }
    const ry = Math.atan2(px, pz);
    for (let yy = y0 + 0.3; yy < y1 + 0.9; yy += 0.32) {
      this.add(mat, new THREE.CylinderGeometry(0.025, 0.025, width, 6), [x, yy, z], [0, ry, Math.PI / 2], { collide: false });
    }
    // thin collider (only up to the top landing so you can step off onto it)
    const ch = Math.max(0.2, y1 - y0 - 0.05);
    this.addCollider(new THREE.BoxGeometry(Math.abs(px) * width + 0.08, ch, Math.abs(pz) * width + 0.08), [x, y0 + ch / 2, z]);
    const box = new THREE.Box3(
      new THREE.Vector3(x - Math.abs(px) * width / 2 - 0.35 + Math.min(0, fx) * 0.9, y0 - 0.1, z - Math.abs(pz) * width / 2 - 0.35 + Math.min(0, fz) * 0.9),
      new THREE.Vector3(x + Math.abs(px) * width / 2 + 0.35 + Math.max(0, fx) * 0.9, y1 + 0.2, z + Math.abs(pz) * width / 2 + 0.35 + Math.max(0, fz) * 0.9),
    );
    this.ladders.push({ box, normal: new THREE.Vector3(fx, 0, fz), x, z, y0, y1 });
  }

  surface(type, x0, y0, z0, x1, y1, z1) {
    this.surfaces.push({ type, box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)) });
  }

  build(scene) {
    const meshes = [];
    for (const [key, geos] of this.batches) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this.mats.get(key));
      mesh.name = 'world:' + key;
      mesh.castShadow = !this.noShadow.has(key);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      scene.add(mesh);
      meshes.push(mesh);
      for (const g of geos) g.dispose();
    }
    scene.add(this.extras);
    for (const c of this.colliders) { c.deleteAttribute('normal'); c.deleteAttribute('uv'); }
    const colGeo = mergeGeometries(this.colliders, false);
    const colMesh = new THREE.Mesh(colGeo);
    const colGroup = new THREE.Group();
    colGroup.add(colMesh);
    colGroup.updateMatrixWorld(true);
    return { meshes, colGroup, colGeo };
  }
}

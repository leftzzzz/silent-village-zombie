// Collision world (Octree over static geometry) + capsule character bodies.
import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _stack = [];

export class CollisionWorld {
  constructor(colGroup, ladders = [], surfaces = []) {
    this.octree = new Octree();
    this.octree.fromGraphNode(colGroup);
    this.ladders = ladders;
    this.surfaces = surfaces;
  }

  // Closest hit along a ray within maxDist. Returns {dist, point, normal} or null.
  raycast(origin, dir, maxDist = 1000, out = null) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    let best = maxDist, bestTri = null;
    _stack.length = 0;
    _stack.push(this.octree);
    while (_stack.length) {
      const node = _stack.pop();
      if (node.box) {
        if (!node.box.containsPoint(origin)) {
          const p = _ray.intersectBox(node.box, _v);
          if (!p || p.distanceTo(origin) > best) continue;
        }
      }
      const tris = node.triangles;
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        const r = _ray.intersectTriangle(t.a, t.b, t.c, false, _hit);
        if (r) {
          const d = r.distanceTo(origin);
          if (d < best) { best = d; bestTri = t; }
        }
      }
      const subs = node.subTrees;
      for (let i = 0; i < subs.length; i++) _stack.push(subs[i]);
    }
    if (!bestTri) return null;
    const res = out || { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
    res.dist = best;
    res.point.copy(dir).multiplyScalar(best).add(origin);
    bestTri.getNormal(res.normal);
    res.backface = res.normal.dot(dir) > 0;
    if (res.backface) res.normal.negate();
    return res;
  }

  lineClear(a, b) {
    _v2.subVectors(b, a);
    const len = _v2.length();
    if (len < 1e-4) return true;
    _v2.divideScalar(len);
    return !this.raycast(a, _v2, len - 0.05);
  }

  surfaceAt(p) {
    for (const s of this.surfaces) if (s.box.containsPoint(p)) return s.type;
    return 'dirt';
  }

  ladderAt(p, radius) {
    for (const l of this.ladders) {
      if (p.x > l.box.min.x - radius && p.x < l.box.max.x + radius && p.z > l.box.min.z - radius && p.z < l.box.max.z + radius &&
        p.y > l.box.min.y - 0.2 && p.y < l.box.max.y) return l;
    }
    return null;
  }
}

// A capsule character body. `pos` is the feet position.
export class Body {
  constructor(world, { radius = 0.35, height = 1.8, crouchHeight = 1.2 } = {}) {
    this.world = world;
    this.radius = radius;
    this.standHeight = height;
    this.crouchHeight = crouchHeight;
    this.height = height;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.onGround = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.crouching = false;
    this.ladder = null;
    this.airTime = 0;
    this.lastLandSpeed = 0;
    this.justLanded = false;
    this.capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), radius);
    this.knock = new THREE.Vector3(); // external impulse velocity (decays)
    this.stagger = 0;                 // seconds of reduced acceleration after being shot
  }

  setScale(radius, height, crouchHeight) {
    this.radius = radius; this.standHeight = height; this.crouchHeight = crouchHeight;
    this.height = this.crouching ? crouchHeight : height;
    this.capsule.radius = radius;
  }

  teleport(p) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.onGround = false;
    this.ladder = null;
  }

  _syncCapsule() {
    const r = this.radius;
    this.capsule.radius = r;
    this.capsule.start.set(this.pos.x, this.pos.y + r, this.pos.z);
    this.capsule.end.set(this.pos.x, this.pos.y + Math.max(r * 2 + 0.01, this.height) - r, this.pos.z);
  }

  _fits(height) {
    const r = this.radius;
    this.capsule.start.set(this.pos.x, this.pos.y + r + 0.02, this.pos.z);
    this.capsule.end.set(this.pos.x, this.pos.y + height - r, this.pos.z);
    const res = this.world.octree.capsuleIntersect(this.capsule);
    return !res || res.depth < 0.01;
  }

  setCrouch(want) {
    if (want === this.crouching) return;
    const dh = this.standHeight - this.crouchHeight;
    if (want) {
      this.crouching = true;
      this.height = this.crouchHeight;
      if (!this.onGround && !this.ladder) this.pos.y += dh * 0.85; // crouch-jump: tuck the legs
    } else {
      // stand up only if there is headroom
      if (!this.onGround && !this.ladder) {
        const y0 = this.pos.y;
        this.pos.y -= dh * 0.85;
        if (!this._fits(this.standHeight)) { this.pos.y = y0; if (!this._fits(this.standHeight)) return; }
      } else if (!this._fits(this.standHeight)) return;
      this.crouching = false;
      this.height = this.standHeight;
    }
  }

  // wish: horizontal Vector3 (length 0..1). params: {speed, accel, airAccel, friction, gravity, jump, jumpVel, climbInput}
  step(dt, wish, p) {
    this.justLanded = false;
    const g = p.gravity ?? 20;
    // ladder handling
    const lad = this.world.ladderAt(this.pos, this.radius);
    if (lad && (p.climbInput || 0) !== 0 && !this.ladder) this.ladder = lad;
    if (this.ladder && (!lad || p.jump)) {
      if (p.jump) this.vel.addScaledVector(this.ladder.normal, 3.5);
      this.ladder = null;
    }

    if (this.ladder) {
      const climb = p.climbInput || 0;
      this.vel.set(wish.x * 1.2, climb * 3.2, wish.z * 1.2);
      // near the top: push onto the landing
      if (this.pos.y > this.ladder.y1 - 0.25 && climb > 0) {
        this.vel.y = Math.max(this.vel.y, 1.5);
        this.vel.addScaledVector(this.ladder.normal, -2.5);
      }
      if (this.pos.y > this.ladder.y1 + 0.35) this.ladder = null;
    } else {
      const speed = p.speed ?? 5;
      const tx = wish.x * speed, tz = wish.z * speed;
      this.stagger = Math.max(0, this.stagger - dt);
      if (this.onGround) {
        const accel = (p.accel ?? 55) * (this.stagger > 0 ? 0.3 : 1);
        const fr = p.friction ?? 10;
        // friction
        const hs = Math.hypot(this.vel.x, this.vel.z);
        if (hs > 0) {
          const drop = hs * fr * dt;
          const k = Math.max(0, hs - drop) / hs;
          this.vel.x *= k; this.vel.z *= k;
        }
        // accelerate toward wish velocity
        const dx = tx - this.vel.x, dz = tz - this.vel.z;
        const dl = Math.hypot(dx, dz);
        if (dl > 0) {
          const a = Math.min(dl, accel * dt);
          this.vel.x += dx / dl * a; this.vel.z += dz / dl * a;
        }
        if (p.jump) {
          this.vel.y = p.jumpVel ?? 7;
          this.onGround = false;
          this.jumped = true;
        }
      } else {
        const aa = (p.airAccel ?? 9) * dt;
        const dx = tx - this.vel.x, dz = tz - this.vel.z;
        const dl = Math.hypot(dx, dz);
        if (dl > 0 && (wish.x || wish.z)) {
          const a = Math.min(dl, aa);
          this.vel.x += dx / dl * a; this.vel.z += dz / dl * a;
        }
        this.vel.y -= g * dt;
      }
    }

    // knockback impulse
    if (this.knock.lengthSq() > 1e-4) {
      this.stagger = Math.max(this.stagger, 0.22);
      this.vel.x += this.knock.x; this.vel.z += this.knock.z;
      if (this.knock.y > 0) { this.vel.y = Math.max(this.vel.y, this.knock.y); this.onGround = false; }
      this.knock.set(0, 0, 0);
    }

    // integrate in substeps
    const n = Math.max(1, Math.ceil(dt / 0.012));
    const sdt = dt / n;
    const wasGround = this.onGround;
    const fallV = this.vel.y;
    let grounded = false;
    for (let i = 0; i < n; i++) {
      if (this.onGround && !this.ladder && this.vel.y <= 0) this.vel.y = -2; // stick to slopes/stairs
      this.pos.addScaledVector(this.vel, sdt);
      grounded = this._resolve() || grounded;
      this.onGround = grounded;
    }
    // ground snap when walking down stairs/ramps
    if (!grounded && wasGround && this.vel.y <= 0 && !this.ladder && !this.jumped) {
      const y0 = this.pos.y;
      this.pos.y -= 0.35;
      if (this._resolve()) grounded = true; else this.pos.y = y0;
    }
    this.jumped = false;
    if (grounded) {
      if (this.vel.y < 0) this.vel.y = 0;
      if (!wasGround) { this.justLanded = true; this.lastLandSpeed = -fallV; }
      this.airTime = 0;
    } else {
      this.airTime += dt;
    }
    this.onGround = grounded;
    if (this.pos.y < -30) { this.pos.y = 2; this.vel.set(0, 0, 0); }
  }

  _resolve() {
    let grounded = false;
    for (let it = 0; it < 3; it++) {
      this._syncCapsule();
      const res = this.world.octree.capsuleIntersect(this.capsule);
      if (!res) break;
      const nrm = res.normal, d = res.depth;
      if (nrm.y > 0.6) {
        grounded = true;
        this.groundNormal.copy(nrm);
        // resolve floors vertically to avoid sliding down slopes
        this.pos.y += d / nrm.y;
        if (this.vel.y < 0) this.vel.y = 0;
      } else {
        this.pos.addScaledVector(nrm, d + 1e-4);
        const vn = this.vel.dot(nrm);
        if (vn < 0) this.vel.addScaledVector(nrm, -vn);
        if (nrm.y < -0.5 && this.vel.y > 0) this.vel.y = 0; // head bump
      }
    }
    return grounded;
  }
}

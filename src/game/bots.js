// Bot AI (host only). Humans path to holding spots and defend; zombies hunt
// humans with a shared flow field; hunters chase zombies; terminators use shields.
import * as THREE from 'three';
import { EDGE } from './nav.js';
import { JUMP_CAPS, PRIMARIES, WEAPONS } from './config.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();

const DIFF = {
  easy: { react: 0.55, turn: 4.5, aimErr: 0.09, spread: 2.4, headChance: 0.05, burst: [0.25, 0.6] },
  normal: { react: 0.32, turn: 7, aimErr: 0.05, spread: 1.6, headChance: 0.15, burst: [0.35, 0.9] },
  hard: { react: 0.18, turn: 11, aimErr: 0.025, spread: 1.15, headChance: 0.35, burst: [0.6, 1.4] },
};

function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class BotManager {
  constructor(game) {
    this.game = game;
    this.brains = new Map();
    this.fieldT = 0;
    this.field = null;
    this.difficulty = 'normal';
  }

  add(actor) {
    const b = new BotBrain(this.game, actor, this);
    this.brains.set(actor.id, b);
    actor.primary = PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)];
    actor.botSpreadMul = DIFF[this.difficulty].spread;
    return b;
  }

  remove(id) { this.brains.delete(id); }

  onRound() { for (const b of this.brains.values()) b.reset(); }

  update(dt) {
    const g = this.game;
    if (!g.nav) return;
    this.fieldT -= dt;
    if (this.fieldT <= 0) {
      this.fieldT = 0.45;
      const targets = [];
      for (const a of g.actors.values()) {
        if (a.team === 'H' && a.alive) {
          const n = g.nav.nearest(a.pos, 3);
          if (n >= 0) targets.push(n);
        }
      }
      this.field = targets.length ? g.nav.flowField(targets, JUMP_CAPS.Z, this.field) : null;
    }
    this.pickBudget = 2;
    for (const b of this.brains.values()) b.update(dt);
  }
}

class BotBrain {
  constructor(game, actor, mgr) {
    this.game = game;
    this.a = actor;
    this.mgr = mgr;
    this.reset();
  }

  get d() { return DIFF[this.mgr.difficulty]; }

  reset() {
    this.path = null; this.pi = 0; this.spot = null; this.goal = null;
    this.target = null; this.seeT = 0; this.scanT = 0; this.repathT = 0;
    this.burstT = 0; this.pauseT = 0; this.aimErrX = 0; this.aimErrY = 0;
    this.stuckT = 0; this.lastPos = new THREE.Vector3(); this.unstickT = 0; this.unstickDir = 0;
    this.lookYaw = Math.random() * 6.28; this.hunterDelay = 1 + Math.random() * 3;
    this.jumpCd = 0; this.growlT = 2 + Math.random() * 6; this.skillT = 0;
    this.ladder = null;
  }

  update(dt) {
    const a = this.a, g = this.game;
    const inp = a.input;
    inp.fwd = 0; inp.strafe = 0; inp.fire = false; inp.fire2 = false; inp.jump = false; inp.climb = 0;
    if (!a.alive || g.mode.phase === 'end') { inp.crouch = false; return; }
    this.jumpCd -= dt;
    if (a.team === 'H') {
      if (a.cls === 'hunter') this.hunter(dt);
      else this.human(dt);
    } else this.zombie(dt);
    this.stuckCheck(dt);
  }

  // ------------------------------------------------------------- movement
  moveTo(p, dt, speedMul = 1) {
    const a = this.a;
    const dx = p.x - a.pos.x, dz = p.z - a.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return dist;
    const want = Math.atan2(-dx, -dz);
    // body faces movement when no target
    if (!this.target || a.team === 'Z') a.yaw += angDiff(a.yaw, want) * Math.min(1, dt * 10);
    const rel = angDiff(a.yaw, want);
    a.input.fwd = Math.cos(rel) * speedMul;
    a.input.strafe = -Math.sin(rel) * speedMul;
    return dist;
  }

  followPath(dt) {
    const a = this.a, g = this.game, nav = g.nav;
    if (!this.path || this.pi >= this.path.length) return false;
    // string pulling: skip ahead across walk edges when the line is clear
    while (this.pi + 1 < this.path.length) {
      const e = nav.edgeBetween(this.path[this.pi], this.path[this.pi + 1]);
      nav.pos(this.path[this.pi], _v);
      const near = Math.hypot(_v.x - a.pos.x, _v.z - a.pos.z) < 0.7 && Math.abs(_v.y - a.pos.y) < 0.8;
      if (near && (!e || e.type === EDGE.WALK)) this.pi++;
      else break;
    }
    const cur = this.path[this.pi];
    const prev = this.pi > 0 ? this.path[this.pi - 1] : -1;
    const e = prev >= 0 ? nav.edgeBetween(prev, cur) : null;
    nav.pos(cur, _v);
    const dist = this.moveTo(_v, dt);
    const dy = _v.y - a.pos.y;
    if (e && e.type === EDGE.LADDER) {
      a.input.climb = dy > 0 ? 1 : -1;
      if (a.climbing) { a.input.fwd = dy > 0.3 ? 0.3 : 1; }
      if (dist < 0.6 && Math.abs(dy) < 0.5) this.pi++;
      return true;
    }
    if (dy > 0.45 && a.onGround && this.jumpCd <= 0 && dist < (e && e.gap ? 2.3 : 1.35)) {
      a.input.jump = true; this.jumpCd = 0.5;
    }
    a.input.crouch = !a.onGround && dy > 0.7;
    if (dist < 0.45 && dy > -1.0 && dy < 0.7) this.pi++;
    else if (dist < 0.45 && dy <= -1.0) this.pi++; // dropping down
    return true;
  }

  stuckCheck(dt) {
    const a = this.a;
    const moving = Math.abs(a.input.fwd) + Math.abs(a.input.strafe) > 0.3;
    if (this.unstickT > 0) {
      this.unstickT -= dt;
      a.input.fwd = 0.6; a.input.strafe = this.unstickDir;
      if (a.onGround && Math.random() < dt * 2) a.input.jump = true;
      return;
    }
    if (moving) {
      this.stuckT += dt;
      if (this.stuckT > 1.2) {
        if (a.pos.distanceTo(this.lastPos) < 0.5) {
          if (a.onGround) a.input.jump = true;
          this.unstickT = 0.7; this.unstickDir = Math.random() < 0.5 ? -1 : 1;
          this.path = null; this.repathT = 0;
        }
        this.stuckT = 0; this.lastPos.copy(a.pos);
      }
    } else { this.stuckT = 0; this.lastPos.copy(a.pos); }
  }

  // ---------------------------------------------------------------- aiming
  aimAt(p, dt) {
    const a = this.a;
    a.eyePos(_eye);
    const dx = p.x - _eye.x, dy = p.y - _eye.y, dz = p.z - _eye.z;
    const wantYaw = Math.atan2(-dx, -dz) + this.aimErrX;
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz)) + this.aimErrY;
    const t = Math.min(1, dt * this.d.turn);
    a.yaw += angDiff(a.yaw, wantYaw) * t;
    a.pitch += (wantPitch - a.pitch) * t;
    // aim error shrinks while tracking
    this.aimErrX *= 1 - Math.min(1, dt * 2.5);
    this.aimErrY *= 1 - Math.min(1, dt * 2.5);
    return Math.abs(angDiff(a.yaw, wantYaw - this.aimErrX)) + Math.abs(wantPitch - this.aimErrY - a.pitch);
  }

  findTarget(teamWanted, maxDist) {
    const a = this.a, g = this.game;
    a.eyePos(_eye);
    let best = null, bd = maxDist;
    for (const t of g.actors.values()) {
      if (t.team !== teamWanted || !t.alive) continue;
      const d = t.pos.distanceTo(a.pos);
      if (d > bd) continue;
      t.chestPos(_tgt);
      if (!g.world.lineClear(_eye, _tgt)) {
        t.headPos(_tgt);
        if (!g.world.lineClear(_eye, _tgt)) continue;
      }
      bd = d; best = t;
    }
    return best;
  }

  // ----------------------------------------------------------------- human
  human(dt) {
    const a = this.a, g = this.game, nav = g.nav;
    if (a.hunterEligible) {
      this.hunterDelay -= dt;
      if (this.hunterDelay <= 0) { g.requestHunter(a); return; }
    }
    // weapon: stay on primary, reload when low and calm
    if (a.weapon !== a.primary && a.weapon !== 'deagle') a.equip(a.primary);
    const ammo = a.ammo[a.weapon];
    if (ammo && ammo.mag === 0 && ammo.reserve === 0 && a.weapon !== 'deagle') a.equip('deagle');

    // choose a holding spot once per round
    if (!this.spot && g.mode.phase !== 'end' && this.mgr.pickBudget > 0) { this.mgr.pickBudget--; this.pickSpot(); }
    this.repathT -= dt;
    let moving = false;
    if (this.goal) {
      const gd = Math.hypot(this.goal.x - a.pos.x, this.goal.z - a.pos.z) + Math.abs(this.goal.y - a.pos.y) * 1.5;
      if (gd > 1.2) {
        if ((!this.path || this.pi >= this.path.length) && this.repathT <= 0) {
          this.repathT = 1.5;
          const s = nav.nearest(a.pos, 3), t = nav.nearest(this.goal, 3);
          this.path = nav.path(s, t, JUMP_CAPS.H);
          this.pi = 0;
          if (!this.path) { this.failed = (this.failed || 0) + 1; if (this.failed > 2) { this.spot = null; this.failed = 0; } }
        }
        moving = this.followPath(dt);
        if (!moving && this.path === null) this.moveTo(this.goal, dt, 0.8);
      } else { this.path = null; a.input.crouch = false; }
    }

    // combat
    this.seeT -= dt;
    if (this.seeT <= 0) {
      this.seeT = 0.25;
      const t = this.findTarget('Z', 60);
      if (t !== this.target) {
        this.target = t;
        if (t) { this.aimErrX = (Math.random() - 0.5) * this.d.aimErr * 6; this.aimErrY = (Math.random() - 0.5) * this.d.aimErr * 4; this.reactT = this.d.react; }
      }
    }
    if (this.target && this.target.alive && this.target.team === 'Z') {
      const t = this.target;
      if (Math.random() < this.d.headChance) t.headPos(_tgt); else t.chestPos(_tgt);
      // lead a little
      const err = this.aimAt(_tgt, dt);
      this.reactT -= dt;
      if (this.reactT <= 0 && err < 0.12 + this.d.aimErr) {
        const w = WEAPONS[a.weapon];
        if (w && w.kind === 'gun') {
          if (this.pauseT > 0) this.pauseT -= dt;
          else {
            a.input.fire = w.auto ? true : Math.random() < 0.3;
            this.burstT += dt;
            const [b0, b1] = this.d.burst;
            if (a.weapon !== 'mg3' && this.burstT > b0 + Math.random() * (b1 - b0)) { this.burstT = 0; this.pauseT = 0.1 + Math.random() * 0.25; }
          }
        }
      }
      // back-pedal from very close zombies when not on a spot
      const dist = t.pos.distanceTo(a.pos);
      if (dist < 3 && !moving && !this.goal) a.input.fwd = -0.7;
    } else {
      this.target = null;
      // idle: look around, reload if needed
      this.scanT -= dt;
      if (this.scanT <= 0) { this.scanT = 1.5 + Math.random() * 2.5; this.lookYaw = this.spotYaw !== undefined ? this.spotYaw + (Math.random() - 0.5) * 2.4 : Math.random() * 6.28; }
      if (!moving) {
        a.yaw += angDiff(a.yaw, this.lookYaw) * Math.min(1, dt * 2);
        a.pitch += (-0.05 - a.pitch) * Math.min(1, dt * 2);
      }
      if (ammo && ammo.mag < WEAPONS[a.weapon].mag * 0.5 && ammo.reserve > 0) a.input.reload = true;
    }
  }

  pickSpot() {
    const g = this.game, nav = g.nav, a = this.a;
    const spots = g.map.spots.slice();
    // weight: prefer less crowded & closer
    const load = new Map();
    for (const b of this.mgr.brains.values()) if (b.spot) load.set(b.spot, (load.get(b.spot) || 0) + 1);
    spots.sort((s1, s2) => {
      const c1 = (load.get(s1) || 0) * 12 + s1.pos.distanceTo(a.pos) * 0.3 + Math.random() * 25;
      const c2 = (load.get(s2) || 0) * 12 + s2.pos.distanceTo(a.pos) * 0.3 + Math.random() * 25;
      return c1 - c2;
    });
    const start = nav.nearest(a.pos, 3);
    for (const s of spots.slice(0, 5)) {
      // random point within the spot that is a nav node
      _v.copy(s.pos).add(_v2.set((Math.random() - 0.5) * s.r, 0, (Math.random() - 0.5) * s.r));
      let n = nav.nearest(_v, 2.5);
      if (n < 0) n = nav.nearest(s.pos, 3);
      if (n < 0) continue;
      const p = nav.path(start, n, JUMP_CAPS.H);
      if (p) {
        this.spot = s; this.path = p; this.pi = 0;
        this.goal = nav.pos(n, new THREE.Vector3());
        // face away from the building center (toward the street)
        this.spotYaw = Math.atan2(-(0 - s.pos.x), -(0 - s.pos.z)) + Math.PI;
        return;
      }
    }
    this.spot = { pos: a.pos.clone(), r: 2 }; this.goal = a.pos.clone();
  }

  // ---------------------------------------------------------------- hunter
  hunter(dt) {
    const a = this.a, g = this.game, nav = g.nav;
    this.seeT -= dt;
    if (this.seeT <= 0) { this.seeT = 0.3; this.target = this.findTarget('Z', 40); }
    let chase = this.target;
    if (!chase) {
      let bd = Infinity;
      for (const t of g.actors.values()) if (t.team === 'Z' && t.alive) { const d = t.pos.distanceTo(a.pos); if (d < bd) { bd = d; chase = t; } }
    }
    if (!chase) return;
    const d = chase.pos.distanceTo(a.pos);
    if (this.target && d < 8 && Math.abs(chase.pos.y - a.pos.y) < 1.2) {
      chase.chestPos(_tgt);
      this.aimAt(_tgt, dt);
      this.moveTo(chase.pos, dt);
      if (d < 2.6) { a.input.fire = true; }
    } else {
      this.repathT -= dt;
      if (this.repathT <= 0 || !this.path) {
        this.repathT = 1.0;
        this.path = nav.path(nav.nearest(a.pos, 3), nav.nearest(chase.pos, 3), JUMP_CAPS.H + 0.3); this.pi = 0;
      }
      if (!this.followPath(dt)) this.moveTo(chase.pos, dt);
    }
  }

  // ---------------------------------------------------------------- zombie
  zombie(dt) {
    const a = this.a, g = this.game, nav = g.nav;
    this.growlT -= dt;
    if (this.growlT <= 0) { this.growlT = 4 + Math.random() * 8; g.playAt(a.cls === 'terminator' ? 'terminator_roar' : 'zombie_growl', a.pos, a.cls === 'terminator' ? 1.2 : 0.8); }
    this.seeT -= dt;
    if (this.seeT <= 0) {
      this.seeT = 0.2;
      this.target = this.findTarget('H', a.cls === 'terminator' ? 14 : 10);
    }
    // skills
    this.skillT -= dt;
    if (a.skillCd <= 0 && this.skillT <= 0) {
      this.skillT = 1;
      if (a.cls === 'terminator') {
        if (a.hp < a.maxHp * 0.75 && g.time - (a.lastHurt || 0) < 1) g.requestSkill(a);
      } else if (!this.target && Math.random() < 0.25) g.requestSkill(a);
      else if (this.target && this.target.pos.distanceTo(a.pos) > 5 && Math.random() < 0.5) g.requestSkill(a);
    }
    const t = this.target;
    if (t && t.alive && t.team === 'H') {
      const dist = t.pos.distanceTo(a.pos);
      const dy = t.pos.y - a.pos.y;
      t.chestPos(_tgt);
      this.aimAt(_tgt, dt * 1.5);
      if (Math.abs(dy) < 1.4 || dist < 2.8) {
        this.moveTo(t.pos, dt);
        const w = WEAPONS[a.weapon];
        if (w && w.kind === 'melee') {
          if (dist < w.light.range + 0.3) a.input.fire = true;
          else if (dist < w.heavy.range + 0.2) a.input.fire2 = true;
        }
        if (dy > 0.6 && dist < 2.2 && a.onGround && this.jumpCd <= 0) { a.input.jump = true; this.jumpCd = 0.6; }
        a.input.crouch = !a.onGround && dy > 0.6;
        return;
      }
    }
    // follow the flow field toward the nearest human
    const field = this.mgr.field;
    if (!field) { this.wander(dt); return; }
    this.edgeT = (this.edgeT || 0) - dt;
    if ((this.edgeT <= 0 || !this.edge) && (a.onGround || a.climbing)) {
      this.edgeT = 0.15;
      const n = nav.nearest(a.pos, 2.5);
      if (n < 0) { this.wander(dt); return; }
      this.edge = nav.flowNext(n, field, JUMP_CAPS.Z);
    }
    const e = this.edge;
    if (!e) {
      // at a local minimum (target unreachable from here): mill around under them
      let near = null, bd = Infinity;
      for (const h of g.actors.values()) if (h.team === 'H' && h.alive) { const d = h.pos.distanceTo(a.pos); if (d < bd) { bd = d; near = h; } }
      if (near) {
        this.moveTo(near.pos, dt);
        if (near.pos.y - a.pos.y > 0.8 && a.onGround && this.jumpCd <= 0 && Math.hypot(near.pos.x - a.pos.x, near.pos.z - a.pos.z) < 2.5) { a.input.jump = true; this.jumpCd = 0.8; }
        a.input.crouch = !a.onGround;
      }
      return;
    }
    nav.pos(e.to, _v);
    const dist = this.moveTo(_v, dt);
    const dy = _v.y - a.pos.y;
    if (e.type === EDGE.LADDER) {
      a.input.climb = e.dy > 0 ? 1 : -1;
      if (a.climbing) a.input.fwd = dy > 0.3 ? 0.3 : 1;
    } else if (e.type === EDGE.JUMP && dy > 0.35 && a.onGround && this.jumpCd <= 0 && dist < (e.gap ? 2.4 : 1.4)) {
      a.input.jump = true; this.jumpCd = 0.45;
    }
    a.input.crouch = !a.onGround && dy > 0.6;
    if (dist < 0.4 && Math.abs(dy) < 0.8) this.edge = null;
  }

  wander(dt) {
    const a = this.a;
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 2 + Math.random() * 3; this.lookYaw = Math.random() * 6.28; }
    a.yaw += angDiff(a.yaw, this.lookYaw) * Math.min(1, dt * 3);
    a.input.fwd = 0.7;
  }
}

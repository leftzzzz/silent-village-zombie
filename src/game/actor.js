// Actor = one combatant (local player, bot, or remote player). Simulated actors
// (local player + bots on the host) own a physics Body and run weapon logic;
// remote actors are interpolated from network snapshots.
import * as THREE from 'three';
import { Body } from './physics.js';
import { WEAPONS, CLASSES, ZOMBIE_LEVEL_SPEED, SKILLS } from './config.js';
import { createCharacter } from '../entities/characterModel.js';
import { audio } from '../engine/audio.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _hitRes = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };

export const WEAPON_IDS = ['ak47', 'm4a1', 'mg3', 'deagle', 'knife', 'grenade', 'claws', 'fists', 'blade'];

export class Actor {
  constructor(game, { id, name, isBot = false, isLocal = false, skin = 0 }) {
    this.game = game;
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.isLocal = isLocal;
    this.skin = skin;
    this.sim = false; // true when this client simulates the actor

    this.team = 'H';
    this.cls = 'human';
    this.lvl = 1;
    this.hp = 100; this.maxHp = 100;
    this.alive = true;
    this.perma = false;          // permanently dead this round (knifed zombie)
    this.stats = { kills: 0, infects: 0, deaths: 0, score: 0 };
    this.primary = 'ak47';
    this.infectCount = 0;
    this.hunterEligible = false;

    this.pos = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.speed = 0; this.strafe = 0; this.back = false;
    this.crouch = false; this.onGround = true; this.climbing = false;
    this.firingT = 0; this.reloading = false; this.attackSeq = 0; this.attackType = 0;
    this.weapon = 'ak47';
    this.hurtT = 0;
    this.shieldT = 0; this.sprintT = 0; this.skillCd = 0;

    this.input = { fwd: 0, strafe: 0, jump: false, crouch: false, walk: false, fire: false, fire2: false, reload: false, slot: 0, skill: false, climb: 0 };
    this.ammo = {};
    this.grenades = 1;
    this.cool = 0; this.reloadT = 0; this.switchT = 0; this.meleePending = null; this.lastSlot = 'knife';
    this.spread = 0; this.firedSinceRelease = false;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.stepAcc = 0;
    this.pendingShots = [];

    this.snaps = [];
    this.model = null;
    this.modelKey = '';
    this.nameTag = null;
    this.shield = null;
    this.body = null;
  }

  get classDef() { return CLASSES[this.cls]; }
  get isZombie() { return this.team === 'Z'; }
  get height() { return this.body ? this.body.height : (this.crouch ? this.classDef.crouch : this.classDef.height); }

  // ------------------------------------------------------------ class setup
  setClass(cls, lvl = 1) {
    const changed = cls !== this.cls || lvl !== this.lvl;
    this.cls = cls; this.lvl = lvl;
    this.team = CLASSES[cls].team;
    if (this.body) {
      const c = CLASSES[cls];
      this.body.setScale(c.radius, c.height, c.crouch);
    }
    if (cls === 'human') this.resetLoadout();
    else if (cls === 'hunter') this.equip('blade', true);
    else if (cls === 'terminator') this.equip('fists', true);
    else this.equip('claws', true);
    if (changed || !this.model) this.rebuildModel();
    this.game.onActorClassChanged && this.game.onActorClassChanged(this);
  }

  resetLoadout() {
    this.ammo = {};
    for (const id of ['ak47', 'm4a1', 'mg3', 'deagle']) this.ammo[id] = { mag: WEAPONS[id].mag, reserve: WEAPONS[id].reserve };
    this.grenades = 1;
    this.equip(this.primary, true);
  }

  rebuildModel() {
    const key = `${this.cls}:${this.skin}:${this.lvl}`;
    if (key === this.modelKey && this.model) return;
    const scene = this.game.scene;
    if (this.model) { scene.remove(this.model.root); this.model.dispose(); }
    const kind = this.cls;
    this.model = createCharacter({ kind, skin: this.skin, level: this.lvl });
    this.modelKey = key;
    if (this.weapon !== 'claws' && this.weapon !== 'fists') this.model.setWeapon(this.weapon);
    this.model.root.position.copy(this.pos);
    this.model.root.visible = !(this.isLocal && !this.game.thirdPerson);
    scene.add(this.model.root);
    if (this.shield) { this.shield.parent && this.shield.parent.remove(this.shield); this.shield = null; }
  }

  makeSim(world) {
    const c = CLASSES[this.cls];
    this.body = new Body(world, { radius: c.radius, height: c.height, crouchHeight: c.crouch });
    this.body.teleport(this.pos);
    this.sim = true;
  }

  dropSim() { this.body = null; this.sim = false; }

  spawnAt(p, yaw = Math.random() * Math.PI * 2) {
    this.pos.copy(p);
    this.yaw = yaw; this.pitch = 0;
    if (this.body) this.body.teleport(p);
    this.snaps.length = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
  }

  // ---------------------------------------------------------------- weapons
  equip(id, instant = false) {
    if (this.weapon === id && !instant) return;
    if (WEAPONS[this.weapon] && WEAPONS[this.weapon].slot !== 4) this.lastSlot = this.weapon;
    this.weapon = id;
    this.reloadT = 0; this.reloading = false;
    this.switchT = instant ? 0.2 : 0.45;
    this.meleePending = null;
    if (this.model && id !== 'claws' && id !== 'fists') this.model.setWeapon(id);
    if (this.isLocal && this.game.vm) this.game.vm.equip(id);
    if (this.isLocal && !instant) audio.play('draw');
  }

  selectSlot(slot) {
    if (this.team !== 'H' || this.cls === 'hunter') return;
    const id = slot === 1 ? this.primary : slot === 2 ? 'deagle' : slot === 3 ? 'knife' : slot === 4 && this.grenades > 0 ? 'grenade' : null;
    if (id) this.equip(id);
  }

  startReload() {
    const w = WEAPONS[this.weapon];
    if (!w || w.kind !== 'gun' || this.reloadT > 0) return;
    const a = this.ammo[this.weapon];
    if (!a || a.mag >= w.mag || a.reserve <= 0) return;
    this.reloadT = w.reload;
    this.reloading = true;
    if (this.isLocal) { this.game.vm && this.game.vm.reload(w.reload); audio.play(w.reloadSound); }
    else audio.play(w.reloadSound, { pos: this.pos, volume: 0.5 });
  }

  eyePos(out) {
    return out.set(this.pos.x, this.pos.y + this.height - (this.cls === 'terminator' ? 0.25 : 0.14), this.pos.z);
  }

  aimDir(out) {
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    return out.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }

  moraleMul() { return this.game.moraleActive && this.team === 'H' ? 1.1 : 1; }

  // ----------------------------------------------------------- simulation
  simulate(dt) {
    if (!this.body) return;
    const inp = this.input;
    const b = this.body;
    const c = CLASSES[this.cls];
    if (!this.alive) {
      // corpses still fall / settle
      _wish.set(0, 0, 0);
      b.step(dt, _wish, { speed: 0, jump: false, gravity: c.gravity });
      this.pos.copy(b.pos);
      this.speed = 0;
      return;
    }

    // skills
    this.skillCd = Math.max(0, this.skillCd - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.sprintT = Math.max(0, this.sprintT - dt);

    b.setCrouch(inp.crouch);
    this.crouch = b.crouching;
    let spd = c.speed;
    if (this.team === 'Z' && this.cls !== 'terminator') spd *= ZOMBIE_LEVEL_SPEED[this.lvl - 1] || 1;
    const w = WEAPONS[this.weapon];
    if (this.team === 'H' && w) spd *= w.speed || 1;
    if (this.sprintT > 0) spd *= SKILLS.sprint.speedMul;
    if (this.shieldT > 0) spd *= SKILLS.shield.speedMul;
    if (b.crouching && b.onGround) spd *= 0.48;
    else if (inp.walk) spd *= 0.55;

    // wish direction from yaw
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    _wish.set(-sy * inp.fwd + cy * inp.strafe, 0, -cy * inp.fwd - sy * inp.strafe);
    const wl = _wish.length();
    if (wl > 1) _wish.divideScalar(wl);

    b.step(dt, _wish, {
      speed: spd, jump: inp.jump && (b.onGround || b.ladder), jumpVel: c.jump, gravity: c.gravity,
      climbInput: inp.climb,
    });
    inp.jump = false;
    this.pos.copy(b.pos);
    this.onGround = b.onGround;
    this.climbing = !!b.ladder;
    const hs = Math.hypot(b.vel.x, b.vel.z);
    this.speed = hs;
    if (hs > 0.1) {
      const fx = -sy, fz = -cy;
      const dot = (b.vel.x * fx + b.vel.z * fz) / hs;
      this.back = dot < -0.3;
      this.strafe = (b.vel.x * cy - b.vel.z * sy) / hs;
    } else { this.back = false; this.strafe = 0; }

    // footsteps
    if (b.onGround && hs > 2.2 && !inp.walk && !b.crouching) {
      this.stepAcc += hs * dt;
      const stride = this.isZombie ? 1.9 : 2.1;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        const surf = this.game.world.surfaceAt(_v.copy(this.pos).setY(this.pos.y - 0.05));
        const name = surf === 'wood' ? 'step_wood' : surf === 'metal' ? 'step_metal' : 'step_dirt';
        audio.play(name, this.isLocal ? { volume: 0.55 } : { pos: this.pos, volume: this.cls === 'terminator' ? 1.6 : 0.9, rate: this.isZombie ? 0.8 : 1 });
      }
    }
    if (b.climbing) {
      this.stepAcc += dt;
      if (this.stepAcc > 0.4) { this.stepAcc = 0; audio.play('ladder', this.isLocal ? {} : { pos: this.pos }); }
    }
    if (b.justLanded && b.lastLandSpeed > 4) {
      audio.play('land', this.isLocal ? { volume: 0.7 } : { pos: this.pos, volume: 0.7 });
      if (this.isLocal && this.game.onLocalLand) this.game.onLocalLand(b.lastLandSpeed);
    }

    this.updateWeapon(dt);
  }

  updateWeapon(dt) {
    const inp = this.input;
    this.cool = Math.max(0, this.cool - dt);
    this.switchT = Math.max(0, this.switchT - dt);
    this.firingT = Math.max(0, this.firingT - dt);
    const w = WEAPONS[this.weapon];
    if (!w) return;
    // recoil recovery
    const rec = w.spread ? w.spread.recover : 8;
    this.recoilPitch -= this.recoilPitch * Math.min(1, dt * rec * (inp.fire ? 0.35 : 1));
    this.recoilYaw -= this.recoilYaw * Math.min(1, dt * rec);

    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const a = this.ammo[this.weapon];
        const need = w.mag - a.mag;
        const take = Math.min(need, a.reserve);
        a.mag += take; a.reserve -= take;
        this.reloading = false;
      }
    }
    if (!inp.fire) this.firedSinceRelease = false;

    if (this.meleePending) {
      this.meleePending.t -= dt;
      if (this.meleePending.t <= 0) { this.resolveMelee(this.meleePending.heavy); this.meleePending = null; }
    }
    if (this.switchT > 0) return;

    if (w.kind === 'gun') {
      const sp = w.spread;
      this.spread = Math.max(0, this.spread - dt * sp.max * 2.2);
      if (inp.reload) { inp.reload = false; this.startReload(); }
      const a = this.ammo[this.weapon];
      if (inp.fire && this.cool <= 0 && this.reloadT <= 0 && (w.auto || !this.firedSinceRelease)) {
        if (a.mag > 0) {
          this.fireGun(w);
          a.mag--;
          this.cool = 60 / w.rpm;
          this.firedSinceRelease = true;
          if (a.mag === 0 && a.reserve > 0) this.startReloadSoon = 0.25;
        } else {
          if (!this.firedSinceRelease) { audio.play('dryfire', this.isLocal ? {} : { pos: this.pos }); this.firedSinceRelease = true; }
          this.startReload();
        }
      }
      if (this.startReloadSoon !== undefined) {
        this.startReloadSoon -= dt;
        if (this.startReloadSoon <= 0 && !inp.fire) { this.startReloadSoon = undefined; this.startReload(); }
      }
    } else if (w.kind === 'melee') {
      if ((inp.fire || inp.fire2) && this.cool <= 0) {
        const heavy = !inp.fire && inp.fire2;
        const m = heavy ? w.heavy : w.light;
        this.cool = m.rate;
        this.attackSeq++; this.attackType = heavy ? 2 : 1;
        this.meleePending = { t: heavy ? 0.28 : 0.14, heavy };
        if (this.isLocal && this.game.vm) this.game.vm.melee(heavy);
        const snd = this.weapon === 'knife' ? (heavy ? 'knife_stab' : 'knife_slash') : this.weapon === 'blade' ? 'blade_slash' : this.weapon === 'fists' ? 'terminator_zap' : 'zombie_attack';
        audio.play(snd, this.isLocal ? {} : { pos: this.pos });
      }
    } else if (w.kind === 'grenade') {
      if (inp.fire && this.cool <= 0 && this.grenades > 0) {
        this.cool = 1.0;
        this.grenades--;
        if (this.isLocal && this.game.vm) this.game.vm.throwGrenade();
        audio.play('grenade_throw', this.isLocal ? {} : { pos: this.pos });
        setTimeout(() => {
          if (!this.alive) return;
          this.eyePos(_v); this.aimDir(_dir);
          this.game.throwGrenade(this, _v.clone().addScaledVector(_dir, 0.5), _dir.clone().multiplyScalar(17).add(new THREE.Vector3(0, 3.5, 0)));
          if (this.grenades <= 0) setTimeout(() => this.alive && this.weapon === 'grenade' && this.equip(this.lastSlot === 'grenade' ? 'knife' : this.lastSlot), 350);
        }, 260);
      }
    }
  }

  currentSpread(w) {
    const sp = w.spread;
    let s = sp.base + this.spread;
    if (!this.onGround && !this.climbing) s += sp.air;
    else if (this.speed > 1.5) s += sp.move * Math.min(1, this.speed / 5);
    if (this.crouch && this.onGround) s *= sp.crouch;
    return s;
  }

  fireGun(w) {
    const g = this.game;
    this.firingT = 0.12;
    this.eyePos(_eye);
    this.aimDir(_dir);
    const s = this.currentSpread(w) * (this.isBot ? this.botSpreadMul || 1 : 1);
    // random cone
    const r = Math.sqrt(Math.random()) * s, a = Math.random() * Math.PI * 2;
    _v.set(Math.cos(a) * r, Math.sin(a) * r, 0);
    const right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const up = _v3.crossVectors(right, _dir).normalize();
    _dir.addScaledVector(right, _v.x).addScaledVector(up, _v.y).normalize();

    // recoil & spread bloom
    this.spread = Math.min(w.spread.max, this.spread + w.spread.shot);
    this.recoilPitch += w.recoil.pitch * (0.8 + Math.random() * 0.4);
    this.recoilYaw += (Math.random() - 0.5) * 2 * w.recoil.yaw;

    const res = g.traceShot(this, _eye, _dir, w.range);
    const end = res.point;
    if (res.actor) {
      const dmg = w.dmg * (res.head ? w.head : 1) * this.moraleMul();
      g.reportHit(this, res.actor, dmg, res.head, this.weapon, _dir, end);
    } else if (res.hitWorld) {
      const surf = g.world.surfaceAt(_v.copy(end).addScaledVector(res.normal, 0.05));
      g.effects.impact(end, res.normal, surf);
      if (Math.random() < 0.3) audio.play(surf === 'metal' ? 'bullet_impact_metal' : surf === 'wood' ? 'bullet_impact_wood' : 'bullet_impact_dirt', { pos: end, volume: 0.6 });
    }
    // visuals & sound
    const muzzle = g.muzzleWorld(this, _v3);
    g.effects.tracer(muzzle, end);
    g.effects.muzzle(muzzle, _dir, this.weapon === 'deagle');
    if (this.isLocal) {
      audio.play(w.sound, { volume: 0.9 });
      g.vm && g.vm.fire();
      g.onLocalShot && g.onLocalShot(this.weapon);
      if (Math.random() < 0.5) setTimeout(() => audio.play('shell_casing', { volume: 0.35 }), 350 + Math.random() * 200);
    } else {
      audio.play(w.sound, { pos: _eye });
    }
    this.pendingShots.push(end.x, end.y, end.z);
  }

  resolveMelee(heavy) {
    const g = this.game;
    const w = WEAPONS[this.weapon];
    if (!w || w.kind !== 'melee' || !this.alive) return;
    const m = heavy ? w.heavy : w.light;
    this.eyePos(_eye);
    this.aimDir(_dir);
    let best = null, bd = Infinity;
    for (const t of g.actors.values()) {
      if (t === this || !t.alive || t.team === this.team) continue;
      t.chestPos(_v);
      const d = _v.distanceTo(_eye) - t.classDef.radius;
      if (d > m.range) continue;
      _v2.subVectors(_v, _eye).normalize();
      if (_v2.dot(_dir) < Math.cos(m.angle) && d > 0.6) continue;
      if (!g.world.lineClear(_eye, _v)) continue;
      if (d < bd) { bd = d; best = t; }
    }
    if (this.weapon === 'fists') {
      const tip = _v.copy(_eye).addScaledVector(_dir, best ? bd + 0.3 : m.range);
      const hand = g.muzzleWorld(this, _v2);
      g.effects.arc(hand, tip, 10, 0.15);
      g.effects.arc(hand, tip, 8, 0.1, 0xd0f4ff);
    }
    if (best) {
      best.chestPos(_v);
      g.reportHit(this, best, m.dmg * this.moraleMul(), false, this.weapon, _dir, _v.clone(), true);
      const snd = this.weapon === 'knife' ? 'knife_hit_flesh' : this.weapon === 'blade' ? 'blade_hit' : this.weapon === 'fists' ? 'terminator_zap' : 'zombie_hit';
      audio.play(snd, this.isLocal ? {} : { pos: _v });
    } else if (this.weapon === 'knife' || this.weapon === 'blade') {
      const hit = g.world.raycast(_eye, _dir, m.range, _hitRes);
      if (hit) {
        audio.play('knife_hit_wall', { pos: hit.point, volume: 0.7 });
        g.effects.impact(hit.point, hit.normal, 'metal');
      }
    }
  }

  chestPos(out) {
    return out.set(this.pos.x, this.pos.y + this.height * 0.62, this.pos.z);
  }

  headPos(out) {
    if (this.model) return this.model.getHeadWorldPos(out);
    return out.set(this.pos.x, this.pos.y + this.height - 0.15, this.pos.z);
  }

  // Ray vs this actor's hitboxes (head sphere + body cylinder). Returns distance and head flag.
  rayHit(origin, dir, maxDist) {
    if (!this.alive) return null;
    const c = this.classDef;
    // head sphere
    this.headPos(_v);
    const hr = this.model ? this.model.headRadius * 1.15 : 0.16;
    let headT = raySphere(origin, dir, _v, hr);
    // body: vertical capsule-ish cylinder
    const r = c.radius * 0.95;
    const top = this.pos.y + this.height * (this.crouch ? 0.78 : 0.82);
    const bodyT = rayCylinder(origin, dir, this.pos.x, this.pos.z, r, this.pos.y, top);
    let t = Infinity, head = false;
    if (headT !== null && headT < maxDist) { t = headT; head = true; }
    if (bodyT !== null && bodyT < t && bodyT < maxDist) { if (!(headT !== null && headT - bodyT < 0.25)) { t = bodyT; head = false; } }
    return t < Infinity ? { t, head } : null;
  }

  // --------------------------------------------------------- remote actors
  pushSnap(time, s) {
    this.snaps.push({ time, ...s });
    if (this.snaps.length > 30) this.snaps.shift();
  }

  interpolate(now) {
    const renderT = now - 0.11;
    const s = this.snaps;
    if (!s.length) return;
    let i = s.length - 1;
    while (i > 0 && s[i - 1].time > renderT) i--;
    const b = s[i], a = s[Math.max(0, i - 1)];
    let k = 1;
    if (b.time !== a.time) k = Math.min(1.2, Math.max(0, (renderT - a.time) / (b.time - a.time)));
    if (renderT >= b.time) { k = 1; }
    const A = k >= 1 ? b : a, B = b;
    const kk = k >= 1 ? 1 : k;
    this.pos.set(A.x + (B.x - A.x) * kk, A.y + (B.y - A.y) * kk, A.z + (B.z - A.z) * kk);
    let dy = B.yaw - A.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw = A.yaw + dy * kk;
    this.pitch = A.pitch + (B.pitch - A.pitch) * kk;
    this.speed = B.speed; this.strafe = B.strafe || 0; this.back = !!B.back;
    this.crouch = B.crouch; this.onGround = B.onGround; this.climbing = B.climbing;
    this.reloading = B.reloading;
  }

  // ----------------------------------------------------------------- visuals
  _animState(attack = 0) {
    const st = this._st || (this._st = {});
    st.speed = this.speed; st.strafe = this.strafe; st.back = this.back; st.onGround = this.onGround || this.climbing;
    st.crouch = this.crouch; st.pitch = this.pitch; st.firing = this.firingT > 0; st.reloading = this.reloading;
    st.attack = attack; st.dead = !this.alive; st.climbing = this.climbing; st.hurt = this.hurtT > 0;
    return st;
  }

  updateVisual(dt) {
    if (!this.model) return;
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.deadT = this.alive ? 0 : (this.deadT || 0) + dt;
    const root = this.model.root;
    root.position.copy(this.pos);
    root.rotation.y = this.yaw;
    let attack = 0;
    if (this._lastAttackSeq !== this.attackSeq) { attack = this.attackType || 1; this._lastAttackSeq = this.attackSeq; }
    this.model.update(dt, this._animState(attack));
    if (this.shieldT > 0) {
      if (!this.shield) { this.shield = this.game.effects.makeShield(1.7); this.game.scene.add(this.shield); }
      this.shield.visible = true;
      this.shield.position.set(this.pos.x, this.pos.y + 1.25, this.pos.z);
    } else if (this.shield) this.shield.visible = false;
    if (this.cls === 'hunter' && this.alive && Math.random() < 0.5) this.game.effects.hunterAura(this.pos);
  }

  dispose() {
    if (this.model) { this.game.scene.remove(this.model.root); this.model.dispose(); this.model = null; }
    if (this.shield) { this.game.scene.remove(this.shield); this.shield = null; }
    if (this.nameTag) { this.nameTag.remove(); this.nameTag = null; }
  }
}

function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

function rayCylinder(o, d, cx, cz, r, y0, y1) {
  const ox = o.x - cx, oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) {
    if (ox * ox + oz * oz > r * r) return null;
    const t = d.y > 0 ? (y0 - o.y) / d.y : (y1 - o.y) / d.y;
    return t >= 0 ? t : null;
  }
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / a;
  let y = o.y + d.y * t;
  if (t >= 0 && y >= y0 && y <= y1) return t;
  // caps
  if (d.y !== 0) {
    for (const yc of [y1, y0]) {
      const tc = (yc - o.y) / d.y;
      if (tc < 0) continue;
      const px = ox + d.x * tc, pz = oz + d.z * tc;
      if (px * px + pz * pz <= r * r) return tc;
    }
  }
  return null;
}

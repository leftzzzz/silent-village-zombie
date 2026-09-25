// Game orchestrator: world, actors, host authority, networking glue, camera.
import * as THREE from 'three';
import { buildMap } from '../world/map.js';
import { CollisionWorld } from './physics.js';
import { NavGraph } from './nav.js';
import { Actor, WEAPON_IDS } from './actor.js';
import { TerminatorMode } from './mode.js';
import { BotManager } from './bots.js';
import { WEAPONS, CLASSES, RULES, BOT_NAMES, HUMAN_SKINS } from './config.js';
import { Effects } from '../engine/effects.js';
import { audio } from '../engine/audio.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hit = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };

export class Game {
  constructor({ renderer, vm, hud, net, settings }) {
    this.r = renderer;
    this.scene = renderer.scene;
    this.camera = renderer.camera;
    this.vm = vm;
    this.hud = hud;
    this.net = net;
    this.settings = settings;
    this.actors = new Map();
    this.local = null;
    this.isHost = true;
    this.time = 0;
    this.thirdPerson = false;
    this.moraleActive = false;
    this.grenades = [];
    this.supplies = new Map();
    this.supplySeq = 0;
    this.botSeq = 0;
    this.sendT = 0; this.stateT = 0; this.botSendT = 0; this.hitBatch = [];
    this.camShake = 0; this.landDip = 0; this.eyeH = 1.66;
    this.deadCam = { yaw: 0, t: 0 };
    this.spectateId = null;
    this.targetInfo = null;
  }

  async load(onProgress = () => {}) {
    onProgress(0.05, '构建新寂静村…');
    await tick();
    const T0 = performance.now();
    this.map = buildMap(this.scene, { quality: this.settings.quality });
    const T1 = performance.now();
    onProgress(0.3, '生成碰撞体…');
    await tick();
    this.world = new CollisionWorld(this.map.colGroup, this.map.ladders, this.map.surfaces);
    const T2 = performance.now();
    this.effects = new Effects(this.scene, this.camera);
    this.effects.setWorld(this.world);
    this._setupLights();
    onProgress(0.4, '计算寻路网格…');
    await tick();
    this.nav = new NavGraph(this.world, this.map.bounds, 1.0);
    await this.nav.build((p) => onProgress(0.4 + p * 0.5, '计算寻路网格…'));
    const T3 = performance.now();
    console.log(`[load] map ${(T1 - T0).toFixed(0)}ms, octree ${(T2 - T1).toFixed(0)}ms, nav ${(T3 - T2).toFixed(0)}ms (${this.nav.count} nodes)`);
    this.mode = new TerminatorMode(this);
    this.bots = new BotManager(this);
    this.bots.difficulty = this.settings.difficulty || 'normal';
    this.r.bakeEnvironment();
    onProgress(1, '完成');
  }

  _setupLights() {
    this.lamps = [];
    const maxLights = this.settings.quality === 'low' ? 3 : this.settings.quality === 'medium' ? 6 : 9;
    const spots = this.map.lightSpots.slice(0, maxLights);
    for (const s of spots) {
      const l = new THREE.PointLight(s.color, s.intensity, s.distance, 1.6);
      l.position.copy(s.pos);
      l.userData = { base: s.intensity, flicker: s.flicker, seed: Math.random() * 100 };
      this.scene.add(l);
      this.lamps.push(l);
    }
  }

  // ------------------------------------------------------------------ actors
  addActor(opts) {
    const a = new Actor(this, opts);
    this.actors.set(a.id, a);
    a.setClass('human', 1);
    if (opts.isLocal) { this.local = a; a.makeSim(this.world); }
    if (opts.isBot && this.isHost) { a.makeSim(this.world); this.bots.add(a); }
    this.hud.addTag(a);
    return a;
  }

  removeActor(id) {
    const a = this.actors.get(id);
    if (!a) return;
    a.dispose();
    this.hud.removeTag(a);
    this.actors.delete(id);
    this.bots.remove(id);
  }

  addBot() {
    const used = new Set([...this.actors.values()].map((a) => a.name));
    const pool = BOT_NAMES.filter((n) => !used.has(n));
    const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 'Bot' + this.botSeq;
    const id = 'b' + (++this.botSeq) + '_' + Math.floor(Math.random() * 1e4);
    const a = this.addActor({ id, name, isBot: true, skin: Math.floor(Math.random() * HUMAN_SKINS) });
    return a;
  }

  // keep the room filled to targetCount with bots (host)
  balanceBots() {
    if (!this.isHost) return;
    const target = this.settings.botFill || 12;
    let total = this.actors.size;
    const bots = [...this.actors.values()].filter((a) => a.isBot);
    while (total < target) {
      const b = this.addBot();
      this.mode.onJoin(b);
      total++;
    }
    let i = bots.length - 1;
    while (total > target && i >= 0) { this.removeActor(bots[i].id); this.broadcastEvent({ k: 'leave', id: bots[i].id }); total--; i--; }
  }

  spawnActor(a, p, yaw) {
    a.spawnAt(p, yaw);
    if (a.sim) a.body.teleport(p);
    if (a === this.local) { this.vm.setVisible(true); this.syncViewmodel(); }
    // tell a remote owner to teleport
    if (this.isHost && !a.isBot && a !== this.local) this.net.sendTo(a.id, { k: 'spawn', x: p.x, y: p.y, z: p.z, yaw });
  }

  syncViewmodel() {
    const a = this.local;
    if (!a) return;
    const kind = a.cls === 'terminator' ? 'terminator' : a.cls === 'mother' ? 'mother' : a.cls === 'zombie' ? 'zombie' : a.cls === 'hunter' ? 'hunter' : 'human';
    if (this._vmKind !== kind) { this._vmKind = kind; this.vm.setKind(kind); }
    this.vm.equip(a.weapon);
    this.r.grade.zombie = a.team === 'Z' ? 1 : 0;
  }

  onActorClassChanged(a) {
    if (a === this.local) this.syncViewmodel();
  }

  clearRound() {
    for (const s of this.supplies.values()) this.scene.remove(s.mesh);
    this.supplies.clear();
    for (const g of this.grenades) this.scene.remove(g.mesh);
    this.grenades.length = 0;
    this.moraleActive = false;
    this.effects.clearDecals();
    this.bots.onRound();
  }

  // ------------------------------------------------------------ host role
  startOffline() {
    this.isHost = true;
    this.balanceBots();
    this.mode.start();
  }

  becomeHost() {
    if (this.isHost) return;
    this.isHost = true;
    // take over bots from their last interpolated positions
    for (const a of this.actors.values()) {
      if (a.isBot) { a.makeSim(this.world); a.body.teleport(a.pos); this.bots.add(a); a.primary = a.primary || 'ak47'; }
    }
    if (this.mode.phase === 'wait') this.mode.start();
    this.balanceBots();
    this.hud.toast('你已成为房主（主机）');
  }

  becomeClient() {
    if (!this.isHost) return;
    this.isHost = false;
    for (const a of this.actors.values()) if (a.isBot) { a.dropSim(); this.bots.remove(a.id); a.snaps.length = 0; }
  }

  // ------------------------------------------------------------- shooting
  traceShot(shooter, origin, dir, range) {
    const res = this._trace || (this._trace = { point: new THREE.Vector3(), normal: new THREE.Vector3(), actor: null, head: false, hitWorld: false, surface: 'dirt' });
    const wh = this.world.raycast(origin, dir, range, _hit);
    let maxD = wh ? wh.dist : range;
    res.actor = null; res.head = false; res.hitWorld = !!wh;
    for (const a of this.actors.values()) {
      if (a === shooter || !a.alive || a.team === shooter.team) continue;
      if (a.pos.distanceToSquared(origin) > (maxD + 3) * (maxD + 3)) continue;
      const h = a.rayHit(origin, dir, maxD);
      if (h && h.t < maxD) { maxD = h.t; res.actor = a; res.head = h.head; }
    }
    res.point.copy(dir).multiplyScalar(maxD).add(origin);
    if (res.actor) res.hitWorld = false;
    else if (wh) res.normal.copy(_hit.normal);
    return res;
  }

  // Local/bot hit report → host
  reportHit(attacker, target, dmg, head, weapon, dir, point, melee = false) {
    // immediate local feedback
    if (target.team === 'Z') {
      _v.copy(dir).negate();
      this.effects.bloodHit(point, _v, true, head ? 1.6 : 1);
      if (attacker === this.local) {
        this.hud.hitmarker(head);
        audio.play(head ? 'headshot' : 'hitmarker', { volume: head ? 0.8 : 0.4 });
        this.targetInfo = { a: target, t: 2.5 };
      }
      if (Math.random() < 0.25) audio.play('zombie_pain', { pos: point, volume: 0.6 });
      target.hurtT = 0.2;
      if (target.model && target.model.flash) target.model.flash(0xff2200, 0.08);
    } else {
      if (target === this.local) this.hud.damageFrom(attacker.pos, this.local);
    }
    const d = dir ? { x: dir.x, y: dir.y, z: dir.z } : null;
    if (this.isHost) this.mode.applyHit(attacker, target, dmg, head, weapon, dir, point, melee);
    else if (attacker === this.local) this.hitBatch.push({ v: target.id, d: Math.round(dmg), h: head ? 1 : 0, w: weapon, dir: d, m: melee ? 1 : 0 });
  }

  applyKnock(target, x, y, z) {
    if (target.sim && target.body) {
      target.body.knock.x += x; target.body.knock.y = Math.max(target.body.knock.y, y); target.body.knock.z += z;
    } else if (!target.isBot) {
      const k = this._knockAcc || (this._knockAcc = new Map());
      const acc = k.get(target.id) || { x: 0, y: 0, z: 0 };
      acc.x += x; acc.y = Math.max(acc.y, y); acc.z += z;
      k.set(target.id, acc);
    }
  }

  muzzleWorld(a, out) {
    if (a === this.local && !this.thirdPerson) {
      this.vm.getMuzzleOffset(out);
      out.applyQuaternion(this.camera.quaternion).add(this.camera.position);
      return out;
    }
    if (a.model) return a.model.getMuzzleWorldPos(out);
    return a.eyePos(out);
  }

  playAt(name, pos, volume = 1) { audio.play(name, { pos, volume }); }

  requestHunter(a) {
    if (this.isHost) this.mode.transformHunter(a);
    else this.net.sendHost({ k: 'hunter' });
  }

  requestSkill(a) {
    if (this.isHost) this.mode.useSkill(a);
    else this.net.sendHost({ k: 'skill' });
  }

  // --------------------------------------------------------------- grenades
  throwGrenade(owner, pos, vel, remote = false) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0x3a4a2a, roughness: 0.6, metalness: 0.4 }));
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.grenades.push({ owner, mesh, vel: vel.clone(), fuse: WEAPONS.grenade.fuse, remote });
    if (!remote && owner === this.local) this._pendingGrenade = [pos.x, pos.y, pos.z, vel.x, vel.y, vel.z];
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vel.y -= 15 * dt;
      const step = g.vel.length() * dt;
      if (step > 0) {
        _v.copy(g.vel).normalize();
        const hit = this.world.raycast(g.mesh.position, _v, step + 0.08, _hit);
        if (hit) {
          g.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.08);
          const vn = g.vel.dot(hit.normal);
          g.vel.addScaledVector(hit.normal, -1.6 * vn).multiplyScalar(0.55);
          if (Math.abs(vn) > 2) audio.play('grenade_bounce', { pos: g.mesh.position, volume: 0.6 });
        } else g.mesh.position.addScaledVector(g.vel, dt);
      }
      g.mesh.rotation.x += dt * 8;
      if (g.fuse <= 0) {
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
        this._explode(g.owner, g.mesh.position, g.remote);
      }
    }
  }

  _explode(owner, p, remote) {
    this.effects.explosion(p);
    audio.play('explosion', { pos: p, volume: 1.4 });
    const dl = this.camera.position.distanceTo(p);
    if (dl < 18) { this.camShake = Math.max(this.camShake, (1 - dl / 18) * 0.7); this.r.grade.flash = Math.max(this.r.grade.flash, (1 - dl / 18) * 0.35); this.r.grade.flashColor.set(1, 0.85, 0.6); }
    if (remote || !owner) return;
    // the thrower's client resolves damage (like bullets)
    const w = WEAPONS.grenade;
    for (const a of this.actors.values()) {
      if (!a.alive || a.team === owner.team) continue;
      a.chestPos(_v2);
      const d = _v2.distanceTo(p);
      if (d > w.radius) continue;
      if (!this.world.lineClear(_v.copy(p).setY(p.y + 0.3), _v2)) continue;
      const k = 1 - d / w.radius;
      const dir = _v2.clone().sub(p).setY(0).normalize();
      dir.y = 0.35;
      this.reportHit(owner, a, w.dmg * k, false, 'grenade', dir, _v2.clone(), false);
    }
  }

  // ---------------------------------------------------------------- supplies
  spawnSupply() {
    const pts = this.map.supply;
    const p = pts[Math.floor(Math.random() * pts.length)];
    const id = 's' + (++this.supplySeq);
    this.broadcastEvent({ k: 'supply', id, x: p.x, y: p.y, z: p.z });
  }

  _makeSupplyMesh(p) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.55), new THREE.MeshStandardMaterial({ color: 0x4a5a34, roughness: 0.7, metalness: 0.2 }));
    box.position.y = 0.25; box.castShadow = true;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.08, 0.57), new THREE.MeshStandardMaterial({ color: 0xd8b040, emissive: 0x6a4a00, emissiveIntensity: 1 }));
    band.position.y = 0.3;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 6, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 3;
    g.add(box, band, beam);
    g.position.copy(p);
    this.scene.add(g);
    return g;
  }

  _checkSupplies() {
    for (const [id, s] of this.supplies) {
      s.mesh.rotation.y += 0.02;
      if (this.isHost) {
        for (const a of this.actors.values()) {
          if (!a.alive || !(a.isBot || a === this.local)) continue;
          if (a.pos.distanceTo(s.pos) < 1.3) { this._grantSupply(id, a); break; }
        }
      } else if (this.local && this.local.alive && this.local.pos.distanceTo(s.pos) < 1.3 && !s.requested) {
        s.requested = true;
        this.net.sendHost({ k: 'pickup', id });
      }
    }
  }

  _grantSupply(id, a) {
    if (!this.supplies.has(id)) return;
    this.broadcastEvent({ k: 'picked', id, by: a.id });
  }

  _applySupply(a) {
    if (a.team === 'H') {
      for (const k of Object.keys(a.ammo)) { a.ammo[k].reserve = WEAPONS[k].reserve; a.ammo[k].mag = WEAPONS[k].mag; }
      a.grenades = Math.min(3, a.grenades + 1);
      if (a.cls === 'hunter') a.hp = Math.min(a.maxHp, a.hp + 800);
    } else {
      a.hp = a.maxHp;
      a.sprintT = 3;
    }
  }

  // ------------------------------------------------------------ networking
  broadcastEvent(ev) {
    (this.evlog || (this.evlog = [])).push(this.time.toFixed(1) + ' ' + JSON.stringify(ev));
    if (this.evlog.length > 200) this.evlog.shift();
    if (this.isHost) this.net.sendAll({ k: 'ev', ev });
    this.handleEvent(ev);
  }

  broadcastState(force = false) {
    if (!this.isHost) return;
    if (force) this.stateT = 0;
  }

  _buildState() {
    const ents = [];
    for (const a of this.actors.values()) {
      ents.push([a.id, a.name, a.isBot ? 1 : 0, a.skin, a.team, a.cls, a.lvl, Math.round(a.hp), a.maxHp, a.alive ? 1 : 0, a.perma ? 1 : 0,
        a.stats.kills, a.stats.infects, a.stats.deaths, a.stats.score, a.hunterEligible ? 1 : 0, a.primary, +(a.shieldT.toFixed(1)), +(a.skillCd.toFixed(1))]);
    }
    const m = this.mode;
    return { k: 'gs', ph: m.phase, t: +m.timer.toFixed(2), r: m.round, w: [m.wins.H, m.wins.Z], mo: this.moraleActive ? 1 : 0, ents };
  }

  applyState(s) {
    const m = this.mode;
    const prevPhase = m.phase;
    m.phase = s.ph; m.timer = s.t; m.round = s.r; m.wins.H = s.w[0]; m.wins.Z = s.w[1];
    this.moraleActive = !!s.mo;
    const seen = new Set();
    for (const e of s.ents) {
      const [id, name, isBot, skin, team, cls, lvl, hp, maxHp, alive, perma, kills, infects, deaths, score, elig, primary, shieldT, skillCd] = e;
      seen.add(id);
      let a = this.actors.get(id);
      if (!a) {
        if (id === this.net.id) continue;
        a = this.addActor({ id, name, isBot: !!isBot, skin });
      }
      if (a.cls !== cls || a.lvl !== lvl) { a.setClass(cls, lvl); this.onActorClassChanged(a); }
      a.hp = hp; a.maxHp = maxHp;
      const wasAlive = a.alive;
      a.alive = !!alive; a.perma = !!perma;
      if (a === this.local && wasAlive && !a.alive) this._onLocalDeath();
      a.stats.kills = kills; a.stats.infects = infects; a.stats.deaths = deaths; a.stats.score = score;
      a.hunterEligible = !!elig;
      if (a !== this.local) { a.primary = primary; a.shieldT = shieldT; a.skillCd = skillCd; }
      else { a.shieldT = Math.max(a.shieldT, shieldT > 0 ? shieldT : 0); a.skillCd = skillCd; }
    }
    for (const id of [...this.actors.keys()]) if (!seen.has(id) && id !== this.net.id) this.removeActor(id);
    if (prevPhase !== m.phase && m.phase === 'prep' && this.local) this.local.resetLoadout();
  }

  // Handle a host event (host applies feedback only; clients also mirror state).
  handleEvent(ev) {
    const A = (id) => this.actors.get(id);
    const me = this.local;
    const host = this.isHost;
    switch (ev.k) {
      case 'round': {
        if (!host) this.clearRound();
        this.hud.announce(`第 ${ev.round} 回合`, '生化幽灵即将出现 — 快寻找有利地形！', 3.5);
        audio.play('bell', { volume: 0.8 });
        this.ringBell();
        if (me) { me.resetLoadout(); this.syncViewmodel(); }
        break;
      }
      case 'tick': audio.play('countdown_tick', { volume: 0.6 }); this.hud.countdown(ev.n); break;
      case 'mutate': {
        const a = A(ev.id); if (!a) break;
        if (!host) { a.setClass(ev.cls, 1); this.onActorClassChanged(a); }
        this.effects.infectBurst(a.pos);
        if (a === me) {
          this.hud.announce(ev.cls === 'terminator' ? '你成为了终结者！' : '你成为了母体幽灵！', ev.cls === 'terminator' ? '按 G 开启能量护盾 · 你能看到所有人类的位置' : '感染所有人类！按 G 疾跑', 4);
          this.r.grade.flash = 0.6; this.r.grade.flashColor.set(0.6, 0.1, 0.05);
          audio.play(ev.cls === 'terminator' ? 'terminator_roar' : 'infect');
        }
        break;
      }
      case 'release': {
        audio.play('round_start', { volume: 0.9 });
        const t = ev.term ? A(ev.term) : null;
        if (me && me.team === 'H') this.hud.announce('生化幽灵出现了！', t ? `终结者「${t.name}」降临！` : '坚守阵地！', 3.5);
        this.hud.feed(`<span class="z">生化幽灵出现了</span>`);
        break;
      }
      case 'infect': {
        const a = A(ev.a), v = A(ev.v);
        if (!v) break;
        if (!host) { v.setClass('zombie', 1); this.onActorClassChanged(v); }
        this.effects.infectBurst(v.pos);
        audio.play('infect', v === me ? { volume: 1 } : { pos: v.pos, volume: 1 });
        this.hud.feed(`<span class="z">${esc(a ? a.name : '?')}</span> <i class="ico claw"></i> <span class="h">${esc(v.name)}</span>`);
        if (v === me) {
          this.hud.announce('你被感染了！', '去感染其他人类吧 · 左键攻击 右键重击 G 疾跑', 3.5);
          this.r.grade.flash = 0.7; this.r.grade.flashColor.set(0.35, 0.6, 0.1);
          this.camShake = 0.6;
          if (me.body) me.body.vel.set(0, 0, 0);
        }
        if (a === me) this.hud.popup('感染 +30');
        break;
      }
      case 'evolve': {
        const a = A(ev.id); if (!a) break;
        if (!host) { a.setClass(a.cls, ev.lvl); this.onActorClassChanged(a); }
        audio.play('evolve', a === me ? {} : { pos: a.pos });
        if (a === me) this.hud.announce(`进化 Lv.${ev.lvl}！`, '生命值与速度提升', 2.5);
        break;
      }
      case 'dmg': {
        const a = A(ev.id); if (!a) break;
        a.hp = ev.hp;
        if (a === me && a.team === 'H') { this.r.grade.damage = Math.min(1, this.r.grade.damage + 0.4); audio.play('human_pain', { volume: 0.7 }); const at = A(ev.a); if (at) this.hud.damageFrom(at.pos, me); }
        if (a === me && a.team === 'Z') { this.r.grade.damage = Math.min(0.6, this.r.grade.damage + 0.04); }
        break;
      }
      case 'kill': {
        const a = A(ev.a), v = A(ev.v);
        if (!v) break;
        if (!host) { v.alive = false; v.perma = !!ev.perma; }
        audio.play(v.cls === 'terminator' ? 'terminator_roar' : 'zombie_death', v === me ? {} : { pos: v.pos, volume: 1.1 });
        const w = ev.w;
        this.hud.feed(`<span class="h">${esc(a ? a.name : '?')}</span> <i class="ico w-${w}"></i>${ev.hs ? '<i class="ico hs"></i>' : ''}${ev.perma ? '<b class="perma">刀杀</b>' : ''} <span class="z">${esc(v.name)}</span>`);
        if (a === me) { this.hud.killmarker(ev.hs); audio.play('kill_confirm', { volume: 0.7 }); this.hud.popup(ev.perma ? '刀杀！+100' : ev.hs ? '爆头击杀 +100' : '击杀 +100'); }
        if (v === me) this._onLocalDeath(ev.perma);
        break;
      }
      case 'respawn': {
        const a = A(ev.id); if (!a) break;
        if (!host) { a.alive = true; a.hp = a.maxHp; }
        _v.set(ev.x, ev.y, ev.z);
        this.effects.spawnBurst(_v);
        audio.play('zombie_respawn', { pos: _v, volume: 0.8 });
        if (a === me && !host) { a.spawnAt(_v, Math.random() * 6.28); this.vm.setVisible(true); }
        if (a === me) this.hud.announce('', '已复活', 1.2);
        break;
      }
      case 'eligible': if (A(ev.id) === me) { this.hud.announce('按 E 变身幽灵猎手！', '你是最后的希望', 4); audio.play('low_hp'); } break;
      case 'hunter': {
        const a = A(ev.id); if (!a) break;
        if (!host) { a.setClass('hunter', 1); this.onActorClassChanged(a); }
        audio.play('hunter_transform', a === me ? {} : { pos: a.pos, volume: 1.2 });
        this.effects.spawnBurst(a.pos, [1, 0.8, 0.3]);
        this.hud.announce('', `${a.name} 变身为幽灵猎手！`, 2.5);
        if (a === me) { this.r.grade.flash = 0.5; this.r.grade.flashColor.set(1, 0.85, 0.4); }
        break;
      }
      case 'morale': this.hud.announce('', '士气提升！人类攻击力 +10%', 2.5); break;
      case 'skill': {
        const a = A(ev.id); if (!a) break;
        if (!host) { if (ev.s === 'shield') { a.shieldT = 4; } else a.sprintT = 3.5; a.skillCd = ev.s === 'shield' ? 22 : 16; }
        audio.play(ev.s === 'shield' ? 'shield_on' : 'zombie_growl', a === me ? {} : { pos: a.pos });
        break;
      }
      case 'supply': {
        const p = new THREE.Vector3(ev.x, ev.y, ev.z);
        this.supplies.set(ev.id, { pos: p, mesh: this._makeSupplyMesh(p) });
        audio.play('supply_drop', { pos: p, volume: 0.8 });
        this.hud.feed('<span class="sup">补给箱已投放</span>');
        break;
      }
      case 'picked': {
        const s = this.supplies.get(ev.id);
        if (s) { this.scene.remove(s.mesh); this.supplies.delete(ev.id); }
        const a = A(ev.by);
        if (a && (a === me || (host && a.isBot))) { this._applySupply(a); if (a === me) { audio.play('pickup'); this.hud.popup(a.team === 'H' ? '弹药补满 +手雷' : '生命恢复'); } }
        break;
      }
      case 'end': {
        const human = ev.w === 'H';
        this.hud.announce(human ? '人类胜利' : '生化幽灵胜利', ev.r, 5, human ? 'win-h' : 'win-z');
        audio.play(human ? 'win_human' : 'win_zombie');
        break;
      }
      case 'leave': if (!host) this.removeActor(ev.id); break;
      default: break;
    }
  }

  _onLocalDeath(perma) {
    const me = this.local;
    if (!me) return;
    this.deadCam.t = 0;
    this.deadCam.yaw = me.yaw;
    this.vm.setVisible(false);
    if (perma) this.hud.announce('你被刀杀了', '本回合无法复活 · 观战中', 3);
  }

  ringBell() {
    const b = this.map.animated.find((x) => x.kind === 'bell');
    if (b) b.swing = 1;
  }

  // Messages from the network
  onNet(msg, from) {
    const m = msg;
    if (m.k === 'ev' && !this.isHost) { this.handleEvent(m.ev); return; }
    if (m.k === 'gs' && !this.isHost) { this.applyState(m); return; }
    if (m.k === 'pose') { this._applyPose(from, m); return; }
    if (m.k === 'bots' && !this.isHost) { for (const p of m.list) this._applyPose(p.i, p); return; }
    if (m.k === 'spawn' && this.local) { _v.set(m.x, m.y, m.z); this.local.spawnAt(_v, m.yaw); this.vm.setVisible(true); return; }
    if (m.k === 'kb' && this.local && this.local.body) { this.local.body.knock.x += m.x; this.local.body.knock.y = Math.max(this.local.body.knock.y, m.y); this.local.body.knock.z += m.z; return; }
    if (!this.isHost) return;
    // host-only requests from peers
    const a = this.actors.get(from);
    if (!a) return;
    if (m.k === 'hits') {
      for (const h of m.list) {
        const t = this.actors.get(h.v);
        if (!t) continue;
        const dir = h.dir ? _v.set(h.dir.x, h.dir.y, h.dir.z) : null;
        const w = WEAPONS[h.w];
        let dmg = Math.min(h.d, w && w.kind === 'gun' ? w.dmg * w.head * 1.15 : 20000);
        this.mode.applyHit(a, t, dmg, !!h.h, h.w, dir, t.pos, !!h.m);
      }
    } else if (m.k === 'hunter') this.mode.transformHunter(a);
    else if (m.k === 'skill') this.mode.useSkill(a);
    else if (m.k === 'pickup') { if (a.alive && this.supplies.has(m.id)) this._grantSupply(m.id, a); }
  }

  _applyPose(id, p) {
    const a = this.actors.get(id);
    if (!a || a === this.local || a.sim) return;
    const f = p.f || 0;
    a.pushSnap(this.time, { x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.r[0], pitch: p.r[1], speed: p.s, strafe: p.st, back: !!(f & 64), crouch: !!(f & 1), onGround: !!(f & 2), climbing: !!(f & 16), reloading: !!(f & 8) });
    const wid = WEAPON_IDS[p.w];
    if (wid && wid !== a.weapon) { a.weapon = wid; if (a.model) a.model.setWeapon(wid); }
    if (p.a !== undefined && p.a !== a.attackSeq) {
      a.attackSeq = p.a; a.attackType = p.at || 1;
      const w = WEAPONS[a.weapon];
      const snd = a.weapon === 'knife' ? 'knife_slash' : a.weapon === 'blade' ? 'blade_slash' : a.weapon === 'fists' ? 'terminator_zap' : 'zombie_attack';
      if (w && w.kind === 'melee') audio.play(snd, { pos: a.pos });
    }
    if (f & 4) a.firingT = 0.12;
    if (p.sh && p.sh.length) {
      const w = WEAPONS[a.weapon];
      this.muzzleWorld(a, _v2);
      for (let i = 0; i < p.sh.length; i += 3) {
        _v.set(p.sh[i], p.sh[i + 1], p.sh[i + 2]);
        this.effects.tracer(_v2, _v);
        if (i === 0) {
          const dir = _v.clone().sub(_v2).normalize();
          this.effects.muzzle(_v2, dir, a.weapon === 'deagle');
        }
        const hit = this.world.raycast(_v2, _v.clone().sub(_v2).normalize(), _v2.distanceTo(_v) + 0.1, _hit);
        if (hit && hit.dist > _v2.distanceTo(_v) - 0.2) this.effects.impact(hit.point, hit.normal, this.world.surfaceAt(hit.point.clone().addScaledVector(hit.normal, 0.05)));
      }
      if (w && w.sound) audio.play(w.sound, { pos: a.pos });
    }
    if (p.gr) this.throwGrenade(a, new THREE.Vector3(p.gr[0], p.gr[1], p.gr[2]), new THREE.Vector3(p.gr[3], p.gr[4], p.gr[5]), true);
  }

  _poseOf(a) {
    let f = 0;
    if (a.crouch) f |= 1; if (a.onGround) f |= 2; if (a.firingT > 0) f |= 4; if (a.reloading) f |= 8; if (a.climbing) f |= 16; if (a.back) f |= 64;
    const p = {
      i: a.id, p: [r2(a.pos.x), r2(a.pos.y), r2(a.pos.z)], r: [r3(a.yaw), r3(a.pitch)], s: r2(a.speed), st: r2(a.strafe), f,
      w: WEAPON_IDS.indexOf(a.weapon), a: a.attackSeq, at: a.attackType,
    };
    if (a.pendingShots.length) { p.sh = a.pendingShots.map(r2); a.pendingShots.length = 0; }
    return p;
  }

  _netTick(dt) {
    if (!this.net.online) { for (const a of this.actors.values()) a.pendingShots.length = 0; return; }
    this.sendT -= dt;
    if (this.sendT <= 0 && this.local) {
      this.sendT = 1 / 15;
      const p = this._poseOf(this.local);
      p.k = 'pose';
      if (this._pendingGrenade) { p.gr = this._pendingGrenade.map(r2); this._pendingGrenade = null; }
      this.net.sendAll(p);
      if (this.hitBatch.length) { this.net.sendHost({ k: 'hits', list: this.hitBatch }); this.hitBatch = []; }
    }
    if (this.isHost) {
      this.botSendT -= dt;
      if (this.botSendT <= 0) {
        this.botSendT = 1 / 12;
        const list = [];
        for (const a of this.actors.values()) if (a.isBot) list.push(this._poseOf(a));
        if (list.length) this.net.sendAll({ k: 'bots', list });
        if (this._knockAcc && this._knockAcc.size) {
          for (const [id, k] of this._knockAcc) this.net.sendTo(id, { k: 'kb', x: r2(k.x), y: r2(k.y), z: r2(k.z) });
          this._knockAcc.clear();
        }
      }
      this.stateT -= dt;
      if (this.stateT <= 0) { this.stateT = 0.25; this.net.sendAll(this._buildState()); }
    } else {
      for (const a of this.actors.values()) if (a.isBot) a.pendingShots.length = 0;
    }
  }

  // ------------------------------------------------------------------- loop
  update(dt, input) {
    this.time += dt;
    const me = this.local;

    if (this.isHost) {
      this.mode.update(dt);
      this.bots.update(dt);
    } else this.mode.timer -= dt;
    // local input → actor
    if (me) {
      if (!me.alive) { const i = me.input; i.fwd = i.strafe = 0; i.fire = i.fire2 = i.jump = i.crouch = false; }
      if (me.alive && input) {
        Object.assign(me.input, input.state);
        if (input.consume('slot1')) me.selectSlot(1);
        if (input.consume('slot2')) me.selectSlot(2);
        if (input.consume('slot3')) me.selectSlot(3);
        if (input.consume('slot4')) me.selectSlot(4);
        if (input.consume('lastWeapon')) { if (me.team === 'H' && me.cls === 'human') me.equip(me.lastSlot || 'knife'); }
        if (input.consume('reload')) me.input.reload = true;
        if (input.consume('jump')) me.input.jump = true;
        if (input.consume('skill')) {
          if (me.team === 'Z') this.requestSkill(me);
          else if (me.cls === 'human' && me.grenades > 0) me.selectSlot(4);
        }
        if (input.consume('use')) { if (me.hunterEligible) this.requestHunter(me); }
        me.input.climb = input.state.fwd > 0 ? (me.pitch < -0.45 ? -1 : 1) : input.state.fwd < 0 ? -1 : 0;
      }
      if (input && input.consume('third')) { this.thirdPerson = !this.thirdPerson; }
    }
    // simulate owned actors
    for (const a of this.actors.values()) {
      if (a.sim) a.simulate(dt);
      else if (a !== me) a.interpolate(this.time);
    }
    this._updateGrenades(dt);
    this._checkSupplies();
    for (const a of this.actors.values()) {
      if (a.model) a.model.root.visible = !(a === me && !this.thirdPerson && a.alive) && !(a.perma && !a.alive && a.deadT > 5);
      a.updateVisual(dt);
    }
    this._updateCamera(dt);
    this._animateWorld(dt);
    this.effects.update(dt, this.camera.position);
    audio.setListener(this.camera.position, this.camera.rotation.y);
    if (me) this.vm.setVisible(me.alive && !this.thirdPerson);
    if (me) this.vm.update(dt, { speed: me.speed, onGround: me.onGround, crouch: me.crouch, sprint: me.sprintT > 0, lookDX: input ? input.lookDX : 0, lookDY: input ? input.lookDY : 0 });
    // grade decay
    const g = this.r.grade;
    g.damage = Math.max(0, g.damage - dt * 0.9);
    g.flash = Math.max(0, g.flash - dt * 1.6);
    g.lowHp = me && me.team === 'H' && me.cls === 'hunter' ? Math.max(0, 1 - me.hp / (me.maxHp * 0.35)) : 0;
    if (this.targetInfo) { this.targetInfo.t -= dt; if (this.targetInfo.t <= 0 || !this.targetInfo.a.alive) this.targetInfo = null; }
    this._netTick(dt);
    this.hud.update(dt, this);
  }

  look(dx, dy) {
    const me = this.local;
    if (!me) return;
    if (!me.alive) { this.deadCam.yaw -= dx; return; }
    me.yaw -= dx;
    me.pitch = Math.max(-1.52, Math.min(1.52, me.pitch - dy));
  }

  onLocalShot(wid) {
    this.camShake = Math.max(this.camShake, wid === 'deagle' ? 0.12 : 0.05);
  }

  onLocalLand(speed) { this.landDip = Math.min(0.25, speed * 0.02); }

  _updateCamera(dt) {
    const me = this.local;
    const cam = this.camera;
    if (!me) return;
    this.camShake = Math.max(0, this.camShake - dt * 2.5);
    this.landDip = Math.max(0, this.landDip - dt * 1.2);
    const shake = this.camShake * this.camShake;
    if (me.alive) {
      const targetEye = me.height - (me.cls === 'terminator' ? 0.25 : 0.14);
      this.eyeH += (targetEye - this.eyeH) * Math.min(1, dt * 14);
      if (this.thirdPerson) {
        me.eyePos(_v);
        const back = me.cls === 'terminator' ? 4.2 : 3.2;
        _v2.set(Math.sin(me.yaw) * back, 0.5, Math.cos(me.yaw) * back);
        const dir = _v2.clone().normalize();
        const hit = this.world.raycast(_v, dir, back + 0.2, _hit);
        const d = hit ? Math.max(0.5, hit.dist - 0.3) : back;
        cam.position.copy(_v).addScaledVector(dir, d);
        cam.rotation.set(me.pitch * 0.8 - 0.1, me.yaw, 0);
      } else {
        cam.position.set(me.pos.x, me.pos.y + this.eyeH - this.landDip, me.pos.z);
        cam.rotation.set(me.pitch + me.recoilPitch + (Math.random() - 0.5) * shake * 0.08, me.yaw + me.recoilYaw + (Math.random() - 0.5) * shake * 0.08, 0);
      }
    } else {
      // death / spectate cam: orbit a teammate or the corpse
      this.deadCam.t += dt;
      let focus = me;
      if (me.perma || this.deadCam.t > 3) {
        const mates = [...this.actors.values()].filter((a) => a.alive && a !== me);
        if (mates.length) {
          if (!this.spectateId || !this.actors.get(this.spectateId) || !this.actors.get(this.spectateId).alive) this.spectateId = mates[Math.floor(Math.random() * mates.length)].id;
          focus = this.actors.get(this.spectateId);
        }
      }
      focus.chestPos(_v);
      const yaw = this.deadCam.yaw;
      _v2.set(Math.sin(yaw) * 4, 1.6, Math.cos(yaw) * 4);
      const dir = _v2.clone().normalize();
      const hit = this.world.raycast(_v, dir, 4.5, _hit);
      const d = hit ? Math.max(0.6, hit.dist - 0.3) : 4.3;
      cam.position.copy(_v).addScaledVector(dir, d);
      cam.lookAt(_v);
      this.spectating = focus !== me ? focus : null;
    }
    const fov = this.settings.fov || 72;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  _animateWorld(dt) {
    const t = this.time;
    for (const l of this.lamps) {
      const u = l.userData;
      const f = 1 - u.flicker * (0.5 + 0.5 * Math.sin(t * 13 + u.seed) * Math.sin(t * 7.3 + u.seed * 2)) * (Math.random() < 0.02 ? 2 : 1);
      l.intensity = u.base * Math.max(0.2, f);
    }
    for (const o of this.map.animated) {
      if (o.kind === 'rotor') o.obj.rotation.z -= dt * o.speed * (1 + Math.sin(t * 0.2) * 0.5);
      else if (o.kind === 'swing') o.obj.rotation.x = Math.sin(t * o.speed) * o.amp + Math.sin(t * 2.7) * o.amp * 0.3;
      else if (o.kind === 'vane') o.obj.rotation.y = Math.sin(t * 0.13) * 0.6 + 2.2;
      else if (o.kind === 'bell') {
        o.phase += dt * 3.2;
        o.swing = Math.max(0, o.swing - dt * 0.12);
        o.obj.rotation.z = Math.sin(o.phase) * 0.55 * o.swing;
        if (o.swing > 0.05 && Math.sin(o.phase) > 0.98 && !o.rang) { o.rang = true; audio.play('bell', { pos: o.obj.position, volume: 1.2 * o.swing }); }
        if (Math.sin(o.phase) < 0.5) o.rang = false;
      }
    }
  }
}

function tick() { return new Promise((r) => setTimeout(r, 0)); }
function r2(x) { return Math.round(x * 100) / 100; }
function r3(x) { return Math.round(x * 1000) / 1000; }
export function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

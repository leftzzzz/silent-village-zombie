// 生化终结者模式 (Terminator mode) — authoritative rules, run only on the host.
import * as THREE from 'three';
import { RULES, CLASSES, WEAPONS, ZOMBIE_LEVEL_HP, SKILLS } from './config.js';

const _v = new THREE.Vector3();

export class TerminatorMode {
  constructor(game) {
    this.game = game;
    this.phase = 'wait';
    this.timer = 0;
    this.round = 0;
    this.wins = { H: 0, Z: 0 };
    this.supplyT = RULES.supplyInterval;
    this.startHumans = 0;
    this.lastWinner = null;
  }

  get actors() { return this.game.actors; }

  start() { this.newRound(); }

  newRound() {
    const g = this.game;
    this.round++;
    this.phase = 'prep';
    this.timer = RULES.prepTime;
    this.supplyT = RULES.supplyInterval;
    g.clearRound();
    const spawns = g.map.spawns.slice().sort(() => Math.random() - 0.5);
    let i = 0;
    for (const a of this.actors.values()) {
      a.alive = true; a.perma = false; a.infectCount = 0; a.hunterEligible = false; a.respawnAt = 0;
      a.shieldT = 0; a.sprintT = 0; a.skillCd = 0;
      a.setClass('human', 1);
      a.hp = a.maxHp = CLASSES.human.hp;
      const p = spawns[i++ % spawns.length];
      const yaw = Math.atan2(p.x, p.z) + (Math.random() - 0.5) * 0.6;
      g.spawnActor(a, p, yaw);
    }
    g.broadcastEvent({ k: 'round', round: this.round });
    g.broadcastState(true);
  }

  update(dt) {
    const g = this.game;
    this.timer -= dt;
    if (this.phase === 'prep') {
      const sec = Math.ceil(this.timer);
      if (sec !== this._lastSec) { this._lastSec = sec; if (sec <= 10 && sec > 0) g.broadcastEvent({ k: 'tick', n: sec }); }
      if (this.timer <= 0) this.releaseZombies();
    } else if (this.phase === 'play') {
      // zombie respawns
      const now = g.time;
      for (const a of this.actors.values()) {
        if (a.team === 'Z' && !a.alive && !a.perma && a.respawnAt && now >= a.respawnAt) this.respawnZombie(a);
        if (a.team === 'Z' && a.alive && a.hp < a.maxHp && now - (a.lastHurt || 0) > 4) a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.04 * dt);
      }
      this.updateHunterEligibility();
      this.supplyT -= dt;
      if (this.supplyT <= 0) { this.supplyT = RULES.supplyInterval; g.spawnSupply(); }
      if (this.timer <= 0) this.endRound('H', '坚守成功');
      else this.checkWin();
    } else if (this.phase === 'end') {
      if (this.timer <= 0) this.newRound();
    }
  }

  counts() {
    let h = 0, z = 0, zAlive = 0;
    for (const a of this.actors.values()) {
      if (a.team === 'H' && a.alive) h++;
      if (a.team === 'Z') { if (!a.perma) z++; if (a.alive) zAlive++; }
    }
    return { h, z, zAlive };
  }

  checkWin() {
    if (this.phase !== 'play') return;
    const c = this.counts();
    if (c.h === 0) this.endRound('Z', '人类全部被感染');
    else if (c.z === 0) this.endRound('H', '生化幽灵全灭');
  }

  releaseZombies() {
    const g = this.game;
    const humans = [...this.actors.values()].filter((a) => a.team === 'H' && a.alive);
    if (humans.length < 2) { this.timer = 5; return; }   // wait for players
    this.phase = 'play';
    this.timer = RULES.roundTime;
    this.startHumans = humans.length;
    humans.sort(() => Math.random() - 0.5);
    const n = humans.length;
    const mothers = Math.max(1, Math.round(n / 10));
    const term = n >= 4 ? 1 : 0;
    const picked = humans.slice(0, mothers + term);
    picked.forEach((a, i) => {
      const cls = i === 0 && term ? 'terminator' : 'mother';
      this.makeZombie(a, cls, 1);
      if (cls === 'terminator') a.hp = a.maxHp = Math.round(CLASSES.terminator.hp + n * 450);
      g.broadcastEvent({ k: 'mutate', id: a.id, cls });
    });
    g.broadcastEvent({ k: 'release', term: term ? picked[0].id : null });
    g.broadcastState(true);
  }

  makeZombie(a, cls = 'zombie', lvl = 1) {
    a.setClass(cls, lvl);
    const base = CLASSES[cls].hp;
    a.hp = a.maxHp = Math.round(base * (cls === 'terminator' ? 1 : ZOMBIE_LEVEL_HP[lvl - 1]));
    a.alive = true; a.perma = false;
    a.shieldT = 0; a.sprintT = 0; a.skillCd = 3;
    a.spawnProtect = this.game.time + 1.0;
  }

  // Unified hit entry point (bullets, melee, grenades)
  applyHit(attacker, target, dmg, head, weapon, dir, point, melee = false) {
    const g = this.game;
    if (this.phase !== 'play' || !attacker || !target || !target.alive || attacker.team === target.team) return;
    if (!attacker.alive && weapon !== 'grenade') return;
    if (target.spawnProtect && g.time < target.spawnProtect) return;
    if (attacker.team === 'H') {
      // human → zombie damage
      let d = dmg;
      if (target.shieldT > 0) d *= 0.04;
      target.hp -= d;
      target.lastHurt = g.time;
      attacker.stats.score += Math.round(d / 10);
      // knockback (CF signature): stronger while airborne
      const w = WEAPONS[weapon];
      if (w && w.knock && dir) {
        const air = target.onGround ? 1 : 1.9;
        const k = w.knock * air * (target.cls === 'terminator' ? 0.45 : 1) * (target.shieldT > 0 ? 0.2 : 1);
        g.applyKnock(target, dir.x * k, weapon === 'grenade' ? w.knock * 0.4 : 0.15 * k, dir.z * k);
      }
      g.broadcastEvent({ k: 'dmg', id: target.id, hp: Math.max(0, Math.round(target.hp)), a: attacker.id, h: head ? 1 : 0 });
      if (target.hp <= 0) this.killZombie(target, attacker, weapon, head, melee);
    } else {
      // zombie → human
      if (target.cls === 'hunter') {
        const d = weapon === 'fists' ? 650 : weapon === 'claws' ? 260 : 200;
        target.hp -= d;
        target.lastHurt = g.time;
        g.broadcastEvent({ k: 'dmg', id: target.id, hp: Math.max(0, Math.round(target.hp)), a: attacker.id });
        if (target.hp <= 0) this.infect(target, attacker);
      } else {
        this.infect(target, attacker);
      }
    }
  }

  infect(victim, attacker) {
    const g = this.game;
    victim.stats.deaths++;
    this.makeZombie(victim, 'zombie', 1);
    if (attacker) {
      attacker.stats.infects++;
      attacker.stats.score += 30;
      attacker.infectCount++;
      if (attacker.cls !== 'terminator') {
        const lvl = attacker.infectCount >= RULES.evolveAt[1] ? 3 : attacker.infectCount >= RULES.evolveAt[0] ? 2 : 1;
        if (lvl > attacker.lvl) {
          const ratio = attacker.hp / attacker.maxHp;
          attacker.setClass(attacker.cls, lvl);
          attacker.maxHp = Math.round(CLASSES[attacker.cls].hp * ZOMBIE_LEVEL_HP[lvl - 1]);
          attacker.hp = Math.max(attacker.maxHp * ratio, attacker.maxHp * 0.6);
          g.broadcastEvent({ k: 'evolve', id: attacker.id, lvl });
        }
      }
    }
    g.broadcastEvent({ k: 'infect', a: attacker ? attacker.id : null, v: victim.id });
    g.broadcastState(true);
    this.checkWin();
  }

  killZombie(z, killer, weapon, head, melee) {
    const g = this.game;
    z.alive = false;
    z.hp = 0;
    z.stats.deaths++;
    killer.stats.kills++;
    killer.stats.score += z.cls === 'terminator' ? 300 : z.cls === 'mother' ? 150 : 100;
    const permanent = melee && (weapon === 'knife' || weapon === 'blade');
    z.perma = permanent;
    z.respawnAt = permanent ? 0 : g.time + RULES.zombieRespawn;
    g.broadcastEvent({ k: 'kill', a: killer.id, v: z.id, w: weapon, hs: head ? 1 : 0, perma: permanent ? 1 : 0 });
    g.broadcastState(true);
    this.checkWin();
  }

  respawnZombie(a) {
    const g = this.game;
    // pick a zombie spawn away from humans but not too far
    const humans = [...this.actors.values()].filter((h) => h.team === 'H' && h.alive);
    const pts = g.map.zombieSpawns;
    let best = pts[0], bs = -Infinity;
    for (const p of pts) {
      let md = Infinity;
      for (const h of humans) md = Math.min(md, h.pos.distanceTo(p));
      const s = Math.min(md, 30) - (md > 45 ? (md - 45) * 0.5 : 0) + Math.random() * 8;
      if (s > bs) { bs = s; best = p; }
    }
    a.alive = true;
    a.hp = a.maxHp;
    a.spawnProtect = g.time + 1.2;
    a.shieldT = 0;
    g.spawnActor(a, best, Math.random() * Math.PI * 2);
    g.broadcastEvent({ k: 'respawn', id: a.id, x: best.x, y: best.y, z: best.z });
    g.broadcastState(true);
  }

  updateHunterEligibility() {
    const c = this.counts();
    const total = this.actors.size;
    const limit = Math.max(1, Math.round(total * RULES.hunterRatio));
    const g = this.game;
    const morale = c.h <= RULES.moraleThreshold && total >= 8;
    if (morale !== g.moraleActive) { g.moraleActive = morale; if (morale) g.broadcastEvent({ k: 'morale' }); }
    for (const a of this.actors.values()) {
      const el = a.team === 'H' && a.alive && a.cls === 'human' && c.h <= limit;
      if (el && !a.hunterEligible) { a.hunterEligible = true; g.broadcastEvent({ k: 'eligible', id: a.id }); }
      if (!el) a.hunterEligible = false;
    }
  }

  transformHunter(a) {
    const g = this.game;
    if (this.phase !== 'play' || !a.hunterEligible || a.cls !== 'human' || !a.alive) return;
    a.setClass('hunter', 1);
    a.hp = a.maxHp = CLASSES.hunter.hp;
    a.hunterEligible = false;
    g.broadcastEvent({ k: 'hunter', id: a.id });
    g.broadcastState(true);
  }

  useSkill(a) {
    const g = this.game;
    if (this.phase !== 'play' || a.team !== 'Z' || !a.alive || a.skillCd > 0) return;
    if (a.cls === 'terminator') {
      a.shieldT = SKILLS.shield.dur; a.skillCd = SKILLS.shield.cd;
      g.broadcastEvent({ k: 'skill', id: a.id, s: 'shield' });
    } else {
      a.sprintT = SKILLS.sprint.dur; a.skillCd = SKILLS.sprint.cd;
      g.broadcastEvent({ k: 'skill', id: a.id, s: 'sprint' });
    }
  }

  endRound(winner, reason) {
    if (this.phase === 'end') return;
    const g = this.game;
    this.phase = 'end';
    this.timer = RULES.endTime;
    this.wins[winner]++;
    this.lastWinner = winner;
    for (const a of this.actors.values()) if (a.team === winner && (a.alive || winner === 'Z')) a.stats.score += 50;
    g.broadcastEvent({ k: 'end', w: winner, r: reason });
    g.broadcastState(true);
  }

  // late joiners: become zombies if the round is live
  onJoin(a) {
    const g = this.game;
    if (this.phase === 'play') {
      this.makeZombie(a, 'zombie', 1);
      a.alive = false; a.respawnAt = g.time + 1;
    } else {
      a.setClass('human', 1);
      a.hp = a.maxHp = 100;
      a.alive = true;
      const p = g.map.spawns[Math.floor(Math.random() * g.map.spawns.length)];
      g.spawnActor(a, p, Math.random() * 6.28);
    }
  }
}

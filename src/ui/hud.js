// CrossFire-style HUD overlay (DOM + a canvas radar).
import * as THREE from 'three';
import { WEAPONS, CLASSES, SKILLS } from '../game/config.js';
import { esc } from '../game/game.js';

const _v = new THREE.Vector3();

export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div id="hud-top">
        <div class="team h"><i class="ico human"></i><b id="h-count">0</b></div>
        <div class="timer"><div id="timer">0:00</div><div id="phase">准备</div></div>
        <div class="team z"><b id="z-count">0</b><i class="ico zombie"></i></div>
        <div id="round-info"></div>
      </div>
      <canvas id="radar" width="200" height="200"></canvas>
      <div id="feed"></div>
      <div id="announce"><div class="big"></div><div class="sub"></div></div>
      <div id="countdown"></div>
      <div id="crosshair"><i class="l"></i><i class="r"></i><i class="t"></i><i class="b"></i><i class="dot"></i></div>
      <div id="hitmarker"></div>
      <div id="dmg-ind"></div>
      <div id="target-bar"><div class="name"></div><div class="bar"><i></i></div></div>
      <div id="hud-bl">
        <div class="cls" id="cls-label">佣兵</div>
        <div class="hp"><i class="ico cross"></i><b id="hp">100</b><span id="hp-max"></span></div>
        <div class="hpbar"><i id="hpbar"></i></div>
      </div>
      <div id="hud-br">
        <div class="wname" id="wname">AK-47</div>
        <div class="ammo"><b id="mag">30</b><span id="reserve">/ 90</span></div>
        <div class="nades" id="nades"></div>
      </div>
      <div id="skills"></div>
      <div id="popups"></div>
      <div id="tags"></div>
      <div id="spectate"></div>
      <div id="scoreboard" class="hidden"></div>
      <div id="chat"><div id="chat-log"></div><input id="chat-input" maxlength="80" placeholder="按 Enter 发送" /></div>
      <div id="toast"></div>
    `;
    const $ = (id) => root.querySelector('#' + id);
    this.el = {
      hCount: $('h-count'), zCount: $('z-count'), timer: $('timer'), phase: $('phase'), round: $('round-info'),
      feed: $('feed'), announce: $('announce'), countdown: $('countdown'), cross: $('crosshair'), hit: $('hitmarker'),
      dmg: $('dmg-ind'), target: $('target-bar'), cls: $('cls-label'), hp: $('hp'), hpMax: $('hp-max'), hpbar: $('hpbar'),
      wname: $('wname'), mag: $('mag'), reserve: $('reserve'), nades: $('nades'), skills: $('skills'), popups: $('popups'),
      tags: $('tags'), spectate: $('spectate'), score: $('scoreboard'), chat: $('chat'), chatLog: $('chat-log'), chatInput: $('chat-input'),
      toast: $('toast'), br: $('hud-br'), bl: $('hud-bl'),
    };
    this.radar = $('radar');
    this.rctx = this.radar.getContext('2d');
    this.tags = new Map();
    this.announceT = 0;
    this.scoreVisible = false;
    this._last = {};
  }

  set(key, el, val) {
    if (this._last[key] === val) return;
    this._last[key] = val;
    el.textContent = val;
  }

  // ------------------------------------------------------------- messages
  announce(big, sub = '', dur = 3, cls = '') {
    const a = this.el.announce;
    a.className = 'show ' + cls;
    a.querySelector('.big').textContent = big;
    a.querySelector('.sub').textContent = sub;
    this.announceT = dur;
  }

  countdown(n) {
    const c = this.el.countdown;
    c.textContent = n;
    c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
  }

  feed(html) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = html;
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 6) this.el.feed.lastChild.remove();
    setTimeout(() => d.classList.add('fade'), 6000);
    setTimeout(() => d.remove(), 7000);
  }

  popup(text) {
    const d = document.createElement('div');
    d.className = 'popup';
    d.textContent = text;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 1600);
  }

  toast(text) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 3000);
  }

  hitmarker(head) {
    const h = this.el.hit;
    h.className = head ? 'show head' : 'show';
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => (h.className = ''), 120);
  }

  killmarker(head) {
    const h = this.el.hit;
    h.className = 'show kill' + (head ? ' head' : '');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => (h.className = ''), 380);
  }

  damageFrom(pos, me) {
    const ang = Math.atan2(pos.x - me.pos.x, pos.z - me.pos.z);
    const rel = ang - (me.yaw + Math.PI);
    const d = document.createElement('i');
    d.style.transform = `translate(-50%,-50%) rotate(${-rel}rad)`;
    this.el.dmg.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  chatLine(name, text, team) {
    const d = document.createElement('div');
    d.innerHTML = `<b class="${team === 'Z' ? 'z' : 'h'}">${esc(name)}</b>: ${esc(text)}`;
    this.el.chatLog.appendChild(d);
    while (this.el.chatLog.children.length > 8) this.el.chatLog.firstChild.remove();
    this.el.chat.classList.add('active');
    clearTimeout(this._chatT);
    this._chatT = setTimeout(() => this.el.chat.classList.remove('active'), 8000);
  }

  // ------------------------------------------------------------- name tags
  addTag(a) {
    const d = document.createElement('div');
    d.className = 'tag';
    d.innerHTML = `<span class="n"></span><span class="bar"><i></i></span>`;
    this.el.tags.appendChild(d);
    this.tags.set(a.id, d);
  }
  removeTag(a) { const d = this.tags.get(a.id); if (d) d.remove(); this.tags.delete(a.id); }

  showScore(v) { this.scoreVisible = v; this.el.score.classList.toggle('hidden', !v); }

  // ----------------------------------------------------------------- update
  update(dt, g) {
    const me = g.local;
    if (!me) return;
    const m = g.mode;
    // announce fade
    if (this.announceT > 0) { this.announceT -= dt; if (this.announceT <= 0) this.el.announce.className = ''; }

    // top bar
    let h = 0, z = 0;
    for (const a of g.actors.values()) { if (a.team === 'H' && a.alive) h++; if (a.team === 'Z' && !a.perma) z++; }
    this.set('h', this.el.hCount, h);
    this.set('z', this.el.zCount, z);
    const t = Math.max(0, Math.ceil(m.timer));
    this.set('t', this.el.timer, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    this.set('ph', this.el.phase, m.phase === 'prep' ? '生化幽灵即将出现' : m.phase === 'play' ? (g.moraleActive ? '士气 +10%' : '生存') : m.phase === 'end' ? '回合结束' : '等待玩家');
    this.set('r', this.el.round, `第 ${m.round} 回合　人类 ${m.wins.H} : ${m.wins.Z} 生化`);
    this.el.timer.classList.toggle('urgent', m.phase === 'play' && t <= 30);

    // HP / class
    const cd = CLASSES[me.cls];
    this.set('cls', this.el.cls, (me.team === 'Z' && me.cls !== 'terminator' ? `${cd.label} Lv.${me.lvl}` : cd.label) + (me.alive ? '' : me.perma ? '（阵亡）' : '（复活中）'));
    this.set('hp', this.el.hp, Math.max(0, Math.ceil(me.hp)));
    this.el.hpbar.style.width = `${Math.max(0, Math.min(100, me.hp / me.maxHp * 100))}%`;
    this.el.bl.className = me.team === 'Z' ? 'z' : me.cls === 'hunter' ? 'gold' : '';

    // weapon / ammo
    const w = WEAPONS[me.weapon];
    const a = me.ammo[me.weapon];
    this.set('wn', this.el.wname, w ? w.name : '');
    if (w && w.kind === 'gun' && a) {
      this.set('mag', this.el.mag, a.mag);
      this.set('res', this.el.reserve, `/ ${a.reserve}`);
      this.el.mag.classList.toggle('low', a.mag <= Math.ceil(w.mag * 0.2));
    } else if (w && w.kind === 'grenade') {
      this.set('mag', this.el.mag, me.grenades); this.set('res', this.el.reserve, '');
    } else { this.set('mag', this.el.mag, '∞'); this.set('res', this.el.reserve, ''); }
    this.set('nd', this.el.nades, me.team === 'H' && me.cls === 'human' ? '●'.repeat(me.grenades) : '');
    this.el.br.classList.toggle('reloading', !!me.reloading);

    // skills
    let sk = '';
    if (me.team === 'Z' && me.alive) {
      const s = me.cls === 'terminator' ? SKILLS.shield : SKILLS.sprint;
      const ready = me.skillCd <= 0;
      sk += `<div class="skill ${ready ? 'ready' : ''}"><kbd>G</kbd>${s.name}${ready ? '' : ` ${Math.ceil(me.skillCd)}s`}</div>`;
    }
    if (me.hunterEligible) sk += `<div class="skill ready gold"><kbd>E</kbd>变身幽灵猎手</div>`;
    if (me.team === 'H' && me.cls === 'human' && me.grenades > 0) sk += `<div class="skill"><kbd>4</kbd>手雷 ×${me.grenades}</div>`;
    this.set('sk', this.el.skills, '');
    if (this._lastSk !== sk) { this._lastSk = sk; this.el.skills.innerHTML = sk; }

    // crosshair gap from spread
    let gap = 6;
    if (w && w.kind === 'gun') gap = 4 + me.currentSpread(w) * 520;
    else if (me.team === 'Z') gap = 10;
    this.el.cross.style.setProperty('--gap', `${Math.min(60, gap).toFixed(1)}px`);
    this.el.cross.className = (me.team === 'Z' ? 'z' : '') + (me.alive && !g.thirdPerson ? '' : ' hidden');

    // target zombie hp
    const ti = g.targetInfo;
    if (ti && ti.a.alive) {
      this.el.target.classList.add('show');
      this.set('tn', this.el.target.querySelector('.name'), `${ti.a.name} · ${CLASSES[ti.a.cls].label}`);
      this.el.target.querySelector('i').style.width = `${Math.max(0, ti.a.hp / ti.a.maxHp * 100)}%`;
    } else this.el.target.classList.remove('show');

    // spectate info
    this.set('spec', this.el.spectate, !me.alive ? (g.spectating ? `观战：${g.spectating.name}` : me.perma ? '已阵亡' : '等待复活…') : '');

    this._tags(g);
    this._radar(g);
    if (this.scoreVisible) this._scoreboard(g);
  }

  _tags(g) {
    const me = g.local, cam = g.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const seeAll = me.cls === 'terminator' && me.alive;
    for (const a of g.actors.values()) {
      const d = this.tags.get(a.id);
      if (!d) continue;
      let show = a !== me && a.alive && (a.team === me.team || (seeAll && a.team === 'H'));
      if (show) {
        const dist = a.pos.distanceTo(cam.position);
        if (dist > (seeAll ? 200 : 45)) show = false;
        else {
          _v.set(a.pos.x, a.pos.y + a.height + 0.35, a.pos.z).project(cam);
          if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) show = false;
          else {
            const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
            d.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
            const enemyMark = a.team !== me.team;
            const cls = 'tag ' + (a.team === 'Z' ? 'z' : a.cls === 'hunter' ? 'gold' : 'h') + (enemyMark ? ' mark' : '');
            if (d.className !== cls) d.className = cls;
            const n = d.firstChild;
            if (n.textContent !== a.name) n.textContent = a.name;
            d.lastChild.firstChild.style.width = `${Math.max(0, a.hp / a.maxHp * 100)}%`;
          }
        }
      }
      d.style.display = show ? '' : 'none';
    }
  }

  _radar(g) {
    const ctx = this.rctx, me = g.local;
    const S = 200, R = 100, scale = 2.1; // px per meter
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(20,16,10,0.62)'; ctx.fillRect(0, 0, S, S);
    ctx.translate(R, R);
    ctx.rotate(me.yaw);
    ctx.scale(scale, scale);
    ctx.translate(-me.pos.x, -me.pos.z);
    // street
    ctx.fillStyle = 'rgba(160,130,90,0.25)';
    ctx.fillRect(-64, -9, 128, 18);
    ctx.fillRect(-10, 9, 20, 22);
    for (const f of g.map.footprints) {
      ctx.fillStyle = f.kind === 'yard' ? 'rgba(120,110,95,0.25)' : f.h > 6 ? 'rgba(210,190,150,0.55)' : 'rgba(180,160,125,0.45)';
      ctx.fillRect(f.x0, f.z0, f.x1 - f.x0, f.z1 - f.z0);
    }
    for (const s of g.supplies.values()) { ctx.fillStyle = '#ffd24a'; ctx.fillRect(s.pos.x - 1.2, s.pos.z - 1.2, 2.4, 2.4); }
    const seeAll = me.cls === 'terminator' && me.alive;
    for (const a of g.actors.values()) {
      if (a === me || !a.alive) continue;
      const mate = a.team === me.team;
      if (!mate && !(seeAll && a.team === 'H')) {
        // enemies only show when firing (humans) nearby
        if (!(a.team === 'H' && a.firingT > 0 && a.pos.distanceTo(me.pos) < 40)) continue;
      }
      ctx.fillStyle = a.team === 'Z' ? '#ff4a3a' : a.cls === 'hunter' ? '#ffd24a' : '#5ab4ff';
      ctx.beginPath(); ctx.arc(a.pos.x, a.pos.z, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // self arrow
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(R, R - 7); ctx.lineTo(R - 5, R + 5); ctx.lineTo(R, R + 2); ctx.lineTo(R + 5, R + 5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,160,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(R, R, R - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,230,190,0.8)'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    const nx = Math.sin(me.yaw) * (R - 12), ny = -Math.cos(me.yaw) * (R - 12);
    ctx.fillText('N', R + nx, R + ny + 4);
  }

  _scoreboard(g) {
    const rows = (team) => [...g.actors.values()].filter((a) => a.team === team)
      .sort((a, b) => b.stats.score - a.stats.score)
      .map((a) => `<tr class="${a === g.local ? 'me' : ''} ${a.alive ? '' : 'dead'}"><td>${esc(a.name)}${a.isBot ? ' <small>BOT</small>' : ''}</td><td>${CLASSES[a.cls].label}</td><td>${a.stats.kills}</td><td>${a.stats.infects}</td><td>${a.stats.deaths}</td><td>${a.stats.score}</td></tr>`).join('');
    const html = `
      <div class="sb-title">新寂静村 · 生化终结者　<small>第 ${g.mode.round} 回合　人类 ${g.mode.wins.H} : ${g.mode.wins.Z} 生化</small></div>
      <div class="sb-cols">
        <table class="h"><thead><tr><th>人类佣兵</th><th>身份</th><th>击杀</th><th>感染</th><th>死亡</th><th>得分</th></tr></thead><tbody>${rows('H')}</tbody></table>
        <table class="z"><thead><tr><th>生化幽灵</th><th>身份</th><th>击杀</th><th>感染</th><th>死亡</th><th>得分</th></tr></thead><tbody>${rows('Z')}</tbody></table>
      </div>`;
    if (this._sbHtml !== html) { this._sbHtml = html; this.el.score.innerHTML = html; }
  }
}

// Entry point: boot, menus, input, main loop, multiplayer session glue.
import * as THREE from 'three';
import { Renderer } from './engine/renderer.js';
import { initTextures, setTextureQuality } from './engine/textures.js';
import { audio } from './engine/audio.js';
import { ViewModel } from './weapons/viewmodel.js';
import { createWeaponModel } from './weapons/models.js';
import { setWeaponFactory } from './entities/characterModel.js';
import { Game } from './game/game.js';
import { HUD } from './ui/hud.js';
import { OfflineNet, OnlineNet, listRooms } from './net/net.js';
import { WEAPONS, PRIMARIES } from './game/config.js';
import { isTouchDevice, setupTouch } from './ui/touch.js';

const $ = (id) => document.getElementById(id);
const SKINS = ['沙漠猎手', '黑色特警', '都市迷彩', '灵狐者'];

// ------------------------------------------------------------------ settings
const settings = Object.assign({
  name: '', skin: 0, primary: 'ak47', bots: 14, difficulty: 'normal', sens: 2.0, fov: 72, volume: 80,
  quality: guessQuality(),
}, loadSettings());
function loadSettings() { try { return JSON.parse(localStorage.getItem('sv-settings') || '{}'); } catch { return {}; } }
function saveSettings() { try { localStorage.setItem('sv-settings', JSON.stringify(settings)); } catch { /* ignore */ } }
function guessQuality() {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return mobile ? 'low' : (navigator.hardwareConcurrency || 4) >= 8 ? 'high' : 'medium';
}
if (!settings.name) settings.name = '佣兵' + Math.floor(1000 + Math.random() * 9000);

// --------------------------------------------------------------------- input
class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.events = new Set();
    this.state = { fwd: 0, strafe: 0, crouch: false, walk: false, fire: false, fire2: false };
    this.lookDX = 0; this.lookDY = 0;
    this.locked = false;
    this.enabled = false;
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => { this.keys.clear(); this.state.fire = this.state.fire2 = false; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.state.fire = true;
      if (e.button === 2) this.state.fire2 = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.state.fire = false;
      if (e.button === 2) this.state.fire2 = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mx = (this.mx || 0) + e.movementX;
      this.my = (this.my || 0) + e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.state.fire = this.state.fire2 = false; this.keys.clear(); }
      this.onLockChange && this.onLockChange(this.locked);
    });
  }

  onKey(e, down) {
    if (!this.enabled) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    const c = e.code;
    if (['Tab', 'Space', 'ControlLeft', 'ControlRight'].includes(c) || (e.ctrlKey && c === 'KeyW')) e.preventDefault();
    if (down) {
      if (!this.keys.has(c)) {
        const map = { Space: 'jump', Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', KeyQ: 'lastWeapon', KeyR: 'reload', KeyG: 'skill', KeyE: 'use', KeyV: 'third', KeyB: 'buy', Enter: 'chat', KeyF: 'inspect' };
        if (map[c]) this.events.add(map[c]);
      }
      this.keys.add(c);
    } else this.keys.delete(c);
    this.onRaw && this.onRaw(c, down);
  }

  consume(name) { if (this.events.has(name)) { this.events.delete(name); return true; } return false; }

  poll() {
    const k = this.keys;
    this.state.fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.state.strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.state.crouch = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC') || !!this.touchCrouch;
    if (this.touchMove) { this.state.fwd = Math.abs(this.touchMove.y) > 0.25 ? Math.sign(this.touchMove.y) * Math.min(1, Math.abs(this.touchMove.y) * 1.4) : 0; this.state.strafe = Math.abs(this.touchMove.x) > 0.25 ? Math.sign(this.touchMove.x) * Math.min(1, Math.abs(this.touchMove.x) * 1.4) : 0; }
    this.state.walk = k.has('ShiftLeft') || k.has('ShiftRight');
    const s = settings.sens * 0.0011;
    this.lookDX = (this.mx || 0) * s; this.lookDY = (this.my || 0) * s;
    this.mx = 0; this.my = 0;
  }
}

// ---------------------------------------------------------------------- boot
const canvas = $('game');
let renderer, vm, hud, game, input, net;
let running = false, inMenu = true, paused = false;
let menuT = 0;
const TOUCH = isTouchDevice();
if (TOUCH) document.body.classList.add('touch');
const TIMESCALE = Math.min(4, Math.max(0.1, parseFloat(new URLSearchParams(location.search).get('timescale')) || 1));
let touchUI = null;

async function boot() {
  const bar = $('load-bar'), txt = $('load-text');
  const progress = (p, t) => { bar.style.width = `${Math.round(p * 100)}%`; if (t) txt.textContent = t; };
  try {
    progress(0.02, '加载字体…');
    await Promise.race([document.fonts.load('48px Rye'), new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
    renderer = new Renderer(canvas, settings.quality);
    initTextures(renderer.renderer);
    setTextureQuality(settings.quality === 'low' ? 'medium' : 'high');
    setWeaponFactory(createWeaponModel);
    vm = new ViewModel();
    renderer.setViewModel(vm);
    vm.setVisible(false);
    hud = new HUD($('hud'));
    input = new Input(canvas);
    net = new OfflineNet();
    game = new Game({ renderer, vm, hud, net, settings });
    const TL = performance.now();
    await game.load((p, t) => progress(0.05 + p * 0.93, t));
    console.log(`[load] total game.load ${(performance.now() - TL).toFixed(0)}ms, since nav start ${performance.now().toFixed(0)}ms`);
    progress(1, '完成');
    addEventListener('resize', () => renderer.resize());
    setupMenu();
    setupSessionControls();
    $('loading').style.opacity = '0';
    setTimeout(() => $('loading').classList.add('hidden'), 800);
    showMenu();
    requestAnimationFrame(loop);
    window.__game = game; window.__input = input;
    const qp = new URLSearchParams(location.search);
    if (qp.get('autostart') === '1') startSolo();
    else if (qp.get('autojoin') === '1') startOnline(qp.get('room') || 'public');
  } catch (e) {
    console.error(e);
    txt.textContent = '加载失败：' + e.message;
    txt.style.color = '#ff6a5a';
  }
}

// --------------------------------------------------------------------- menu
function chips(el, items, get, set) {
  el.innerHTML = '';
  items.forEach(([val, label]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (get() === val ? ' on' : '');
    b.textContent = label;
    b.onclick = () => { set(val); [...el.children].forEach((c) => c.classList.remove('on')); b.classList.add('on'); audio.unlock(); audio.play('ui_click'); saveSettings(); };
    el.appendChild(b);
  });
}

function setupMenu() {
  const nick = $('nick');
  nick.value = settings.name;
  nick.oninput = () => { settings.name = nick.value.trim().slice(0, 14) || settings.name; saveSettings(); };
  chips($('skin-chips'), SKINS.map((s, i) => [i, s]), () => settings.skin, (v) => (settings.skin = v));
  chips($('gun-chips'), PRIMARIES.map((g) => [g, WEAPONS[g].name]), () => settings.primary, (v) => (settings.primary = v));
  chips($('diff-chips'), [['easy', '简单'], ['normal', '普通'], ['hard', '困难']], () => settings.difficulty, (v) => (settings.difficulty = v));
  chips($('q-chips'), [['low', '流畅'], ['medium', '均衡'], ['high', '极致']], () => settings.quality, (v) => { settings.quality = v; renderer.setQuality(v); });
  const range = (id, key, fmt) => {
    const r = $(id), v = $(id + '-v');
    r.value = settings[key];
    v.textContent = fmt(settings[key]);
    r.oninput = () => { settings[key] = parseFloat(r.value); v.textContent = fmt(settings[key]); if (key === 'volume') audio.setMasterVolume(settings.volume / 100); saveSettings(); };
  };
  range('sens', 'sens', (x) => x.toFixed(1));
  range('fov', 'fov', (x) => x + '°');
  range('vol', 'volume', (x) => x + '%');
  range('bot-count', 'bots', (x) => x + ' 人');
  $('btn-solo').onclick = () => startSolo();
  $('btn-quick').onclick = () => startOnline('public');
  $('btn-join').onclick = () => startOnline($('room-code').value.trim() || 'public');
  $('btn-refresh').onclick = refreshRooms;
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) { $('room-code').value = qRoom; $('net-status').textContent = `邀请房间：${qRoom} —— 点击「加入/创建」进入`; }
  refreshRooms();
  document.querySelectorAll('#menu button').forEach((b) => b.addEventListener('mouseenter', () => audio.play('ui_hover', { volume: 0.4 })));

  // buy menu
  const bg = $('buy-guns');
  PRIMARIES.forEach((g) => {
    const d = document.createElement('div');
    d.className = 'gun';
    const w = WEAPONS[g];
    d.innerHTML = `<b>${w.name}</b><span>伤害 ${w.dmg} · 射速 ${w.rpm} · 弹匣 ${w.mag}</span>`;
    d.onclick = () => { choosePrimary(g); $('buy').classList.add('hidden'); lock(); };
    bg.appendChild(d);
  });
}

async function refreshRooms() {
  const el = $('rooms');
  const list = await listRooms();
  el.innerHTML = list.length ? '' : '<div class="hint">暂无在线房间 —— 创建一个吧</div>';
  for (const r of list) {
    const d = document.createElement('div');
    d.className = 'room';
    d.innerHTML = `<span>🏠 ${escapeHtml(r.room)}</span><span>${r.count}/16 人 · 房主 ${escapeHtml(r.host || '')}</span>`;
    d.onclick = () => startOnline(r.room);
    el.appendChild(d);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function choosePrimary(g) {
  settings.primary = g; saveSettings();
  const me = game.local;
  if (me) {
    me.primary = g;
    if (me.team === 'H' && me.cls === 'human') { me.equip(g); }
  }
}

function showMenu() {
  inMenu = true; running = false;
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');
  if (touchUI) touchUI.classList.add('hidden');
  $('pause').classList.add('hidden');
  $('click-to-play').classList.add('hidden');
  input.enabled = false;
  vm.setVisible(false);
}

function hideMenu() {
  inMenu = false;
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
}

// ------------------------------------------------------------------ sessions
function resetGame() {
  for (const id of [...game.actors.keys()]) game.removeActor(id);
  game.local = null;
  game.clearRound();
  game.mode.phase = 'wait'; game.mode.round = 0; game.mode.wins = { H: 0, Z: 0 };
  game.botSeq = 0;
}

function startSolo() {
  audio.unlock();
  audio.setMasterVolume(settings.volume / 100);
  audio.startAmbient();
  if (net && net.online) net.close();
  net = new OfflineNet();
  game.net = net;
  resetGame();
  game.settings.botFill = settings.bots;
  game.bots.difficulty = settings.difficulty;
  game.isHost = true;
  const me = game.addActor({ id: net.id, name: settings.name, isLocal: true, skin: settings.skin });
  me.primary = settings.primary;
  game.startOffline();
  enterGame();
}

async function startOnline(room) {
  audio.unlock();
  audio.setMasterVolume(settings.volume / 100);
  const st = $('net-status');
  st.textContent = `正在连接房间「${room}」…`;
  if (net && net.online) net.close();
  const on = new OnlineNet();
  try {
    const welcome = await on.connect(room, settings.name, settings.skin);
    net = on;
    game.net = net;
    resetGame();
    game.settings.botFill = Math.max(settings.bots, 10);
    game.bots.difficulty = settings.difficulty;
    game.isHost = welcome.host === welcome.id;
    const me = game.addActor({ id: welcome.id, name: settings.name, isLocal: true, skin: settings.skin });
    me.primary = settings.primary;
    game.room = room;
    wireNet(on);
    if (game.isHost) {
      for (const p of welcome.peers) game.addActor({ id: p.id, name: p.name, skin: p.skin });
      game.startOffline();
    } else {
      me.alive = false;
      hud.toast('已加入房间，等待房主同步…');
    }
    st.textContent = '';
    history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
    audio.startAmbient();
    enterGame();
    hud.toast(`房间「${room}」 · ${game.isHost ? '你是房主' : '已连接'}`);
  } catch (e) {
    st.textContent = '联机失败：' + e.message + '（可先试试单人模式）';
  }
}

function wireNet(on) {
  on.on('msg', (m, from) => game.onNet(m, from));
  on.on('join', (p) => {
    hud.feed(`<span class="sup">${escapeHtml(p.name)} 加入了房间</span>`);
    if (game.isHost) {
      const a = game.addActor({ id: p.id, name: p.name, skin: p.skin });
      game.mode.onJoin(a);
      game.balanceBots();
      game.broadcastState(true);
    }
  });
  on.on('leave', (p) => {
    const a = game.actors.get(p.id);
    if (a) hud.feed(`<span class="sup">${escapeHtml(a.name)} 离开了房间</span>`);
    game.removeActor(p.id);
    if (game.isHost) { game.balanceBots(); game.mode.checkWin(); }
  });
  on.on('host', (id) => { if (id === on.id) game.becomeHost(); else game.becomeClient(); });
  on.on('chat', (from, text) => {
    const a = game.actors.get(from);
    hud.chatLine(a ? a.name : '?', text, a ? a.team : 'H');
  });
  on.on('close', () => { if (net === on) { hud.announce('连接已断开', '已切换为单机模式继续', 3); net = new OfflineNet(); game.net = net; game.becomeHost(); } });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && net && net.online && game && game.isHost) {
    const humans = [...game.actors.values()].filter((a) => !a.isBot).length;
    if (humans > 1) net.yieldHost();
  }
});

function enterGame() {
  hideMenu();
  running = true;
  input.enabled = true;
  if (TOUCH) {
    if (!touchUI) touchUI = setupTouch(input, () => { paused = true; input.locked = false; $('pause').classList.remove('hidden'); });
    touchUI.classList.remove('hidden');
  }
  game.syncViewmodel();
  vm.setVisible(true);
  lock();
}

function setupSessionControls() {
  input.onLockChange = (locked) => {
    if (inMenu) return;
    if (!locked && !chatting && $('buy').classList.contains('hidden')) { paused = true; $('pause').classList.remove('hidden'); $('click-to-play').classList.add('hidden'); }
    if (locked) { paused = false; $('pause').classList.add('hidden'); $('click-to-play').classList.add('hidden'); }
  };
  canvas.addEventListener('click', () => { if (!inMenu && !input.locked) lock(); });
  $('btn-resume').onclick = () => lock();
  $('btn-leave').onclick = () => {
    if (net && net.online) { net.close(); net = new OfflineNet(); game.net = net; }
    resetGame();
    history.replaceState(null, '', location.pathname);
    showMenu();
    refreshRooms();
  };
  $('btn-invite').onclick = async () => {
    const room = game.room || ('r' + Math.random().toString(36).slice(2, 7));
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    try { await navigator.clipboard.writeText(url); hud.toast('邀请链接已复制：' + url); } catch { hud.toast(url); }
    if (!game.room) hud.toast('当前是单机模式；此链接会创建联机房间：' + url);
  };
  input.onRaw = (code, down) => {
    if (!down) { if (code === 'Tab') hud.showScore(false); return; }
    if (code === 'Tab') hud.showScore(true);
  };
  const chatInput = hud.el.chatInput;
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const t = chatInput.value.trim();
      if (t) { if (net.online) net.chat(t); else hud.chatLine(settings.name, t, game.local ? game.local.team : 'H'); }
      endChat();
    } else if (e.key === 'Escape') endChat();
  });
}

let chatting = false;
function startChat() {
  chatting = true;
  hud.el.chat.classList.add('typing');
  document.exitPointerLock();
  setTimeout(() => hud.el.chatInput.focus(), 10);
}
function endChat() {
  chatting = false;
  hud.el.chatInput.value = '';
  hud.el.chatInput.blur();
  hud.el.chat.classList.remove('typing');
  lock();
}

function lock() {
  audio.unlock();
  if (TOUCH) { input.locked = true; paused = false; $('pause').classList.add('hidden'); $('buy').classList.add('hidden'); return; }
  try { const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()); } catch { canvas.requestPointerLock(); }
}

// ---------------------------------------------------------------------- loop
let last = performance.now(), fpsAcc = 0, fpsN = 0;
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  dt *= TIMESCALE;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { $('fps').textContent = `${Math.round(fpsN / fpsAcc)} FPS${net && net.online ? ` · ${Math.round(net.ping)}ms` : ''}`; fpsAcc = 0; fpsN = 0; }

  if (running) {
    input.poll();
    if (input.consume('chat') && net) startChat();
    if (input.consume('buy')) {
      const b = $('buy');
      const open = b.classList.contains('hidden');
      if (open && game.local && game.local.team === 'H') {
        [...$('buy-guns').children].forEach((c, i) => c.classList.toggle('on', PRIMARIES[i] === settings.primary));
        b.classList.remove('hidden'); document.exitPointerLock();
      } else { b.classList.add('hidden'); lock(); }
    }
    if (input.locked) game.look(input.lookDX, input.lookDY);
    if (!input.locked) { input.state.fwd = 0; input.state.strafe = 0; input.state.fire = false; input.state.fire2 = false; }
    game.update(dt, input);
    if (!TOUCH && !input.locked && !paused && !chatting && $('buy').classList.contains('hidden')) $('click-to-play').classList.remove('hidden');
  } else {
    // cinematic fly-over behind the menu
    menuT += dt;
    const cam = renderer.camera;
    const a = menuT * 0.045 + 0.6;
    cam.position.set(Math.cos(a) * 34, 13 + Math.sin(menuT * 0.1) * 3, Math.sin(a) * 26 + 4);
    cam.lookAt(0, 6, -12);
    game.time += dt;
    game._animateWorld(dt);
    for (const a2 of game.actors.values()) a2.updateVisual(dt);
    game.effects.update(dt, cam.position);
  }
  if (running) renderer.adapt(Math.min(0.2, (now - (loop.lastNow || now)) / 1000));
  loop.lastNow = now;
  renderer.render(dt, game ? game.time : now / 1000);
}

boot();

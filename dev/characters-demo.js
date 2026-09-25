// Character lineup viewer for src/entities/characterModel.js
// URL params:
//   anim=idle|walk|run|crouch|crouchwalk|strafe|strafeL|back|jump|attack|attack2|fire|reload|climb|death|deathF|hurt|aimup|aimdown
//   weapon=ak47|m4a1|mg3|deagle|knife|grenade    only=0,3,5 (lineup indices)   cam=front|far|fps|close|side|threeq|back|top
//   focus=<index> (for close/side/threeq/back)   freeze=<seconds to simulate, then stop>   hud=0   pitch=<rad>   speed=<m/s>
// window.demo = { chars, setAnim(name), setWeapon(id), setCam(name, focus), step(seconds), freeze(bool) }
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCharacter } from '../src/entities/characterModel.js';

const Q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = parseFloat(Q.get('exposure') || '1.0');
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SUN_DIR = new THREE.Vector3(-0.62, 0.36, -0.7).normalize();

// ---- dawn sky dome
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uSun: { value: SUN_DIR } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; }',
  fragmentShader: `varying vec3 vDir; uniform vec3 uSun;
    void main(){
      float h = clamp(vDir.y, -0.2, 1.0);
      vec3 zen = vec3(0.16, 0.24, 0.42), mid = vec3(0.62, 0.52, 0.52), hor = vec3(1.25, 0.72, 0.42), gnd = vec3(0.35, 0.26, 0.2);
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h));
      c = mix(c, zen, smoothstep(0.15, 0.75, h));
      c = mix(c, gnd, smoothstep(0.0, -0.15, h));
      float sd = max(dot(normalize(vDir), uSun), 0.0);
      c += vec3(1.6, 0.9, 0.45) * pow(sd, 18.0) * 0.8 + vec3(8.0, 5.0, 2.6) * pow(sd, 900.0);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat);
scene.add(sky);
// environment from the sky
{
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const m2 = skyMat.clone();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), m2));
  scene.environment = pm.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.6;
}
scene.fog = new THREE.Fog(0xb58a66, 35, 160);

const sun = new THREE.DirectionalLight(0xffb070, 3.4);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -14; sun.shadow.camera.right = 14; sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0x9db2d0, 0x6a4e36, 0.75);
scene.add(hemi);

// ---- ground (demo-only canvas dirt texture)
function dirtTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#9c8062'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512, r = Math.random() * 3 + 0.5;
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(70,52,36,${Math.random() * 0.25})` : `rgba(200,175,140,${Math.random() * 0.2})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const gr = g.createRadialGradient(x, y, 0, x, y, 40 + Math.random() * 60);
    gr.addColorStop(0, `rgba(90,68,48,${Math.random() * 0.25})`); gr.addColorStop(1, 'rgba(90,68,48,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(40, 40); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 0.97, metalness: 0 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// a couple of props for scale / context
{
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.9 });
  const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wood);
  crate.position.set(-9.5, 0.5, 2.5); crate.castShadow = crate.receiveShadow = true; scene.add(crate);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), wood);
  post.position.set(9.5, 1.2, 2.0); post.castShadow = true; scene.add(post);
}

// ---- lineup
const LINEUP = [
  { kind: 'human', skin: 0, label: 'desert' }, { kind: 'human', skin: 1, label: 'swat' }, { kind: 'human', skin: 2, label: 'urban' }, { kind: 'human', skin: 3, label: 'fox' },
  { kind: 'hunter', label: 'hunter' }, { kind: 'zombie', level: 1, label: 'zombie L1' }, { kind: 'zombie', level: 2, label: 'zombie L2' }, { kind: 'zombie', level: 3, label: 'zombie L3' },
  { kind: 'mother', label: 'mother' }, { kind: 'terminator', label: 'terminator' },
];
const only = Q.get('only') ? Q.get('only').split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n)) : null;
const STRIP = parseInt(Q.get('strip') || '0', 10);
const STRIP_DT = parseFloat(Q.get('stripDt') || '0.1');
const chars = [];
let x = 0;
const t0 = performance.now();
const list = [];
for (let i = 0; i < LINEUP.length; i++) {
  if (only && !only.includes(i)) continue;
  if (STRIP > 0) { for (let k = 0; k < STRIP; k++) list.push([i, k]); break; }
  list.push([i, 0]);
}
for (const [i, k] of list) {
  const d = LINEUP[i];
  const c = createCharacter(d);
  const w = STRIP > 0 ? parseFloat(Q.get('stripGap') || String(c.radius * 2 + 0.25)) : c.radius * 2 + 0.55;
  x += w / 2;
  c.root.position.set(x, 0, 0);
  c.root.rotation.y = parseFloat(Q.get('yaw') || '0');
  x += w / 2;
  c.label = d.label + (STRIP ? '#' + k : '');
  c.index = STRIP ? k : i;
  c._simT = 0; c._lastAtk = -10; c._stripK = k;
  scene.add(c.root);
  chars.push(c);
}
const cx = x / 2;
for (const c of chars) c.root.position.x -= cx;
console.log('[characters] built', chars.length, 'in', (performance.now() - t0).toFixed(0), 'ms; meshes/char:', chars.map((c) => { let n = 0; c.root.traverse((o) => { if (o.isMesh || o.isLine) n++; }); return c.label + ':' + n; }).join(' '));

// ---- camera
const camera = new THREE.PerspectiveCamera(parseFloat(Q.get('fov') || '40'), innerWidth / innerHeight, 0.05, 800);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
function setCam(name = 'front', focus) {
  const c = focus !== undefined ? chars.find((ch) => ch.index === +focus) || chars[0] : null;
  const h = c ? c.height : 1.8;
  const px = c ? c.root.position.x : 0;
  const dist = parseFloat(Q.get('dist') || '0');
  const span = Math.max(4, x);
  let pos, tgt;
  switch (name) {
    case 'far': pos = [0, 1.7, -(dist || 15)]; tgt = [0, 1.0, 0]; break;
    case 'fps': pos = [px + 1.5, 1.65, -(dist || 8)]; tgt = [px, 1.1, 0]; break;
    case 'close': pos = [px, h * 0.6, -(dist || h * 1.75)]; tgt = [px, h * 0.52, 0]; break;
    case 'face': pos = [px + 0.05, h * 0.9, -(dist || 0.75)]; tgt = [px, h * 0.88, 0]; break;
    case 'side': pos = [px + (dist || h * 1.75), h * 0.6, 0]; tgt = [px, h * 0.52, 0]; break;
    case 'threeq': pos = [px + (dist || h * 1.75) * 0.6, h * 0.7, -(dist || h * 1.75) * 0.8]; tgt = [px, h * 0.52, 0]; break;
    case 'back': pos = [px + 0.4, h * 0.7, dist || h * 1.75]; tgt = [px, h * 0.52, 0]; break;
    case 'upper': pos = [px + 0.5, h * 0.82, -(dist || 1.2)]; tgt = [px, h * 0.72, 0]; break;
    case 'upperside': pos = [px + (dist || 1.2), h * 0.8, -0.1]; tgt = [px, h * 0.72, -0.1]; break;
    case 'top': pos = [px, h * 2.2, -(dist || 1.2)]; tgt = [px, h * 0.4, 0]; break;
    case 'stripside': pos = [0, 1.0, (dist || span * 0.9 + 1.5)]; tgt = [0, 0.95, 0]; break;
    case 'stripfront': pos = [0, 1.2, -(dist || span * 0.9 + 1.5)]; tgt = [0, 0.95, 0]; break;
    default: pos = [0, 1.45, -(dist || span * 0.95 + 2)]; tgt = [0, 0.95, 0];
  }
  camera.position.fromArray(pos);
  controls.target.fromArray(tgt);
  controls.update();
  const sx = c ? px : 0;
  sun.position.copy(SUN_DIR).multiplyScalar(30).add(new THREE.Vector3(sx, 0, 0));
  sun.target.position.set(sx, 0, 0);
}

// ---- animation states
const state = { speed: 0, strafe: 0, back: false, onGround: true, crouch: false, pitch: 0, firing: false, reloading: false, attack: 0, dead: false, climbing: false, hurt: false };
let anim = Q.get('anim') || 'idle';
let simT = 0;
let lastAtk = -10;
function applyAnim(c, t) {
  const S = state;
  S.speed = 0; S.strafe = 0; S.back = false; S.onGround = true; S.crouch = false; S.firing = false; S.reloading = false; S.attack = 0; S.dead = false; S.climbing = false; S.hurt = false;
  S.pitch = Q.get('pitch') ? parseFloat(Q.get('pitch')) : 0;
  const zombie = c.kind === 'zombie' || c.kind === 'mother';
  const run = c.kind === 'terminator' ? 4.8 : zombie ? 6.2 : 5.4;
  switch (anim) {
    case 'walk': S.speed = c.kind === 'terminator' ? 1.8 : 1.7; break;
    case 'run': S.speed = run; break;
    case 'crouch': S.crouch = true; break;
    case 'crouchwalk': S.crouch = true; S.speed = 1.5; break;
    case 'strafe': S.speed = 3.2; S.strafe = 1; break;
    case 'strafeL': S.speed = 3.2; S.strafe = -1; break;
    case 'back': S.speed = 2.6; S.back = true; break;
    case 'jump': S.onGround = false; break;
    case 'attack': case 'attack2': if (t - c._lastAtk > 1.3) S.attack = anim === 'attack2' ? 2 : 1; break;
    case 'fire': S.firing = true; break;
    case 'reload': S.reloading = true; break;
    case 'climb': S.climbing = true; break;
    case 'death': case 'deathF': S.dead = t > 0.3; break;
    case 'hurt': S.hurt = (t % 1.0) < 0.1; break;
    case 'aimup': S.pitch = 0.9; break;
    case 'aimdown': S.pitch = -0.8; break;
    default: break;
  }
  if (Q.get('speed')) S.speed = parseFloat(Q.get('speed'));
  return S;
}
function setAnim(name) {
  anim = name; simT = 0; lastAtk = -10;
  for (const c of chars) { c._simT = 0; c._lastAtk = -10; }
  for (const c of chars) { c.update(0.016, { dead: false }); if (name === 'deathF') c._forceDeathVar = 1; else if (name === 'death' && Q.get('dvar')) c._forceDeathVar = +Q.get('dvar'); else delete c._forceDeathVar; }
}
function setWeapon(id) { for (const c of chars) if (c.kind === 'human') c.setWeapon(id); }
function stepChar(c, dt) {
  c._simT += dt;
  const s = applyAnim(c, c._simT);
  if (s.attack) c._lastAtk = c._simT;
  c.update(dt, s);
}
function step(dt) {
  simT += dt;
  for (const c of chars) stepChar(c, dt);
}
let frozen = false;
if (Q.get('weapon')) setWeapon(Q.get('weapon'));
setAnim(anim);
setCam(Q.get('cam') || 'front', Q.get('focus') !== null ? Q.get('focus') : undefined);
if (Q.get('freeze')) {
  const T = parseFloat(Q.get('freeze'));
  for (const c of chars) {
    const TT = T + (STRIP ? c._stripK * STRIP_DT : 0);
    const n = Math.round(TT * 60);
    for (let k = 0; k < n; k++) stepChar(c, 1 / 60);
  }
  frozen = true;
}

// ---- HUD
const hud = document.getElementById('hud');
if (Q.get('hud') === '0') hud.classList.add('hide');
const ANIMS = ['idle', 'walk', 'run', 'crouch', 'crouchwalk', 'strafe', 'strafeL', 'back', 'jump', 'attack', 'attack2', 'fire', 'reload', 'climb', 'death', 'deathF', 'hurt', 'aimup', 'aimdown'];
const WEAPONS = ['ak47', 'm4a1', 'mg3', 'deagle', 'knife', 'grenade'];
hud.innerHTML = `anim <select id=an>${ANIMS.map((a) => `<option${a === anim ? ' selected' : ''}>${a}</option>`).join('')}</select>
 weapon <select id=wp>${WEAPONS.map((a) => `<option${a === (Q.get('weapon') || 'ak47') ? ' selected' : ''}>${a}</option>`).join('')}</select>
 <button id=fl>flash</button> <button id=fz>freeze</button> <span id=info></span>`;
hud.querySelector('#an').onchange = (e) => setAnim(e.target.value);
hud.querySelector('#wp').onchange = (e) => setWeapon(e.target.value);
hud.querySelector('#fl').onclick = () => chars.forEach((c, i) => c.flash(i % 2 ? 0xffffff : 0xff2020, 0.25));
hud.querySelector('#fz').onclick = () => { frozen = !frozen; };
const info = hud.querySelector('#info');

// head markers (debug): ?heads=1 shows spheres at getHeadWorldPos / muzzle
const markers = [];
if (Q.get('heads') === '1') {
  const hm = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true });
  const mm = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  for (const c of chars) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(c.headRadius, 12, 8), hm);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), mm);
    scene.add(h, m); markers.push([c, h, m]);
  }
}

window.demo = { chars, scene, camera, renderer, setAnim, setWeapon, setCam, step, freeze: (b) => { frozen = b !== false; }, state };

const timer = new THREE.Timer();
let fcount = 0, facc = 0;
function frame() {
  requestAnimationFrame(frame);
  timer.update(); const dt = Math.min(0.05, timer.getDelta());
  if (!frozen) step(dt);
  for (const [c, h, m] of markers) { c.getHeadWorldPos(h.position); c.getMuzzleWorldPos(m.position); }
  controls.update();
  renderer.render(scene, camera);
  fcount++; facc += dt;
  if (facc > 0.5) { info.textContent = `${(fcount / facc).toFixed(0)} fps · calls ${renderer.info.render.calls} · tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`; fcount = 0; facc = 0; }
}
frame();
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

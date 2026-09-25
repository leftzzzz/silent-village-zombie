// Viewmodel / weapon model test bench.
// URL params:
//   w=ak47|m4a1|mg3|deagle|knife|grenade|blade|claws|fists   kind=human|hunter|zombie|mother|terminator
//   act=fire|reload|melee|meleeH|throw|draw  t=<sec after action to freeze>  dur=<reload seconds>
//   speed=<m/s> sprint=1 crouch=1 air=1  look=<rad/s yaw rate>
//   view=orbit&oyaw=deg&opitch=deg&odist=m   (debug: look at the rig from outside)
//   turntable=1&tyaw=deg&tpitch=deg&lod=fp|tp|both
//   bg=0 (flat backdrop)
// Keys: 1-6 human weapons, 7 hunter blade, 8 zombie, 9 mother, 0 terminator,
//   LMB fire (hold), R reload, F melee, V/RMB heavy melee, G throw, WASD move, Shift sprint, C crouch, Space jump, P pause
import * as THREE from 'three';
import { createWeaponModel, getDawnEnvironment, WEAPON_IDS, fbm } from '../src/weapons/models.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exp', 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const hud = document.getElementById('hud');

// ---------------------------------------------------------------------------
// Dawn backdrop world
// ---------------------------------------------------------------------------
function makeWorld() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd9a877, 25, 170);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: new THREE.Vector3(-0.62, 0.2, 0.76).normalize() } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 sunDir;
      void main(){
        float h = vDir.y;
        vec3 zen = vec3(0.20,0.32,0.55), hor = vec3(1.0,0.66,0.40), gnd = vec3(0.45,0.30,0.18);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(clamp(h,0.0,1.0), 0.55)) : mix(hor*0.8, gnd, clamp(-h*4.0,0.0,1.0));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0,0.75,0.45) * (pow(s, 700.0) * 18.0 + pow(s, 12.0) * 0.45);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat));
  const sun = new THREE.DirectionalLight(0xffc48a, 3.0);
  sun.position.set(-62, 20, 76);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xa9c3e8, 0x6b4a2c, 1.1));
  scene.environment = getDawnEnvironment();
  scene.environmentIntensity = 0.6;
  // ground
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(256, 256);
  const n = fbm(256, 256, 8, 8, 5, 3);
  for (let i = 0; i < 256 * 256; i++) { const v = 0.75 + n[i] * 0.4; img.data[i * 4] = 168 * v; img.data[i * 4 + 1] = 128 * v; img.data[i * 4 + 2] = 86 * v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const gt = new THREE.CanvasTexture(c); gt.wrapS = gt.wrapT = THREE.RepeatWrapping; gt.repeat.set(60, 60); gt.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: gt, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // simple western buildings
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5234, roughness: 0.9 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3120, roughness: 0.9 });
  const add = (x, z, w, h, d, m = woodMat) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, h / 2, z); scene.add(b); return b; };
  add(-9, -22, 8, 6, 7); add(-9, -22 + 0, 8.6, 0.4, 8, darkWood).position.y = 6.2;
  add(10, -26, 9, 7.5, 8); add(1, -44, 12, 5, 6, darkWood); add(-16, -40, 6, 9, 6);
  add(14, -8, 5, 4, 6, darkWood); add(-4, -14, 1.2, 1.1, 1.2, darkWood); add(4, -11, 0.9, 0.9, 0.9);
  for (let i = 0; i < 6; i++) add(-6 + i * 0.1, -30 - i * 3, 0.2, 2.5, 0.2, darkWood);
  return scene;
}

const world = makeWorld();
const worldCam = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 600);
worldCam.position.set(0, 1.65, 0);
let camYaw = num('cyaw', 0.25), camPitch = num('cpitch', -0.02);
if (Q.get('bg') === '0') { world.children.forEach((o) => { if (o.isMesh) o.visible = false; }); world.background = new THREE.Color(0x3a3330); world.fog = null; }

// ---------------------------------------------------------------------------
// Turntable mode
// ---------------------------------------------------------------------------
if (Q.get('handtest')) {
  handTest();
} else if (Q.get('turntable')) {
  document.getElementById('cross').style.display = 'none';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2e2a28);
  scene.environment = getDawnEnvironment();
  scene.environmentIntensity = 0.8;
  const key = new THREE.DirectionalLight(0xffc896, 2.4); key.position.set(3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fbfff, 1.0); rim.position.set(-4, 2, -5); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xbfd4f0, 0x5a4030, 0.6));
  const lodMode = Q.get('lod') || 'fp';
  const tyaw = THREE.MathUtils.degToRad(num('tyaw', 90)), tpitch = THREE.MathUtils.degToRad(num('tpitch', 12));
  const only = Q.get('only');
  const layout = {
    mg3: [0.0, 0.62], ak47: [-0.05, 0.3], m4a1: [0.02, 0.0], blade: [0.0, -0.3],
    deagle: [-0.42, -0.58], knife: [-0.02, -0.58], grenade: [0.38, -0.58],
  };
  const group = new THREE.Group();
  scene.add(group);
  const lods = lodMode === 'both' ? ['fp', 'tp'] : [lodMode];
  lods.forEach((lod, li) => {
    for (const id of WEAPON_IDS) {
      if (only && only !== id) continue;
      const m = createWeaponModel(id, { lod });
      const [x, y] = only ? [0, 0] : layout[id];
      const holder = new THREE.Group();
      holder.position.set((li - (lods.length - 1) / 2) * 1.5 + x, y, 0);
      holder.rotation.set(tpitch, tyaw, 0, 'YXZ');
      holder.add(m);
      if (id === 'grenade' || id === 'deagle' || id === 'knife') m.scale.setScalar(only ? 1 : 1.6);
      if (only) { const bb = new THREE.Box3().setFromObject(m); const c = bb.getCenter(new THREE.Vector3()); m.position.sub(c); if (Q.has('zoomz')) m.position.z -= num('zoomz', 0); }
      group.add(holder);
      if (Q.get('markers')) m.traverse((o) => { if (!o.isMesh && o.name) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.006), new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false })); o.add(s); } });
    }
  });
  const cam = new THREE.PerspectiveCamera(only ? 30 : 32, innerWidth / innerHeight, 0.01, 50);
  const dist = num('dist', only ? (['deagle', 'knife', 'grenade'].includes(only) ? 0.6 : 1.6) : lods.length * 1.6 + 1.4);
  cam.position.set(0, 0.05, dist);
  cam.lookAt(0, only ? 0 : 0.02, 0);
  let info = { tris: 0, calls: 0 };
  function loop() {
    if (Q.get('spin')) group.children.forEach((h) => (h.rotation.y += 0.01));
    renderer.render(scene, cam);
    info = { tris: renderer.info.render.triangles, calls: renderer.info.render.calls };
    hud.textContent = `turntable lod=${lodMode}  draw calls=${info.calls} tris=${info.tris}`;
    requestAnimationFrame(loop);
  }
  loop();
  window.addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); });
  window.__info = () => info;
} else {
  startViewmodel();
}

// ---------------------------------------------------------------------------
// Viewmodel mode
// ---------------------------------------------------------------------------
async function startViewmodel() {
  const { ViewModel } = await import('../src/weapons/viewmodel.js');
  const vm = new ViewModel();
  window.vm = vm;
  vm.setAspect(innerWidth / innerHeight);

  const kindFor = (w) => (w === 'blade' ? 'hunter' : w === 'claws' ? 'zombie' : w === 'fists' ? 'terminator' : 'human');
  let weapon = Q.get('w') || 'ak47';
  let kind = Q.get('kind') || kindFor(weapon);
  if (kind === 'mother' && weapon === 'ak47') weapon = 'claws';
  if ((kind === 'zombie' || kind === 'mother') && !Q.get('w')) weapon = 'claws';
  if (kind === 'terminator' && !Q.get('w')) weapon = 'fists';
  if (kind === 'hunter' && !Q.get('w')) weapon = 'blade';
  vm.setKind(kind);
  vm.equip(weapon);

  const input = { keys: new Set(), fire: false, lookDX: 0, lookDY: 0 };
  const state = { speed: num('speed', 0), onGround: !Q.get('air'), crouch: !!Q.get('crouch'), sprint: !!Q.get('sprint'), lookDX: 0, lookDY: 0, time: 0 };
  let paused = false;
  let fireCd = 0;
  let jumpT = 0;
  const RATE = { ak47: 0.1, m4a1: 0.08, mg3: 0.055, deagle: 0.28 };
  const lookRate = num('look', 0);

  function step(dt) {
    state.time += dt;
    // movement from keys (only when not driven by params)
    const k = input.keys;
    const moving = k.has('KeyW') || k.has('KeyA') || k.has('KeyS') || k.has('KeyD');
    if (k.size || !Q.has('speed')) {
      state.sprint = k.has('ShiftLeft') || !!Q.get('sprint');
      state.crouch = k.has('KeyC') || !!Q.get('crouch');
      const target = moving ? (state.sprint ? 7 : state.crouch ? 2.2 : 5) : num('speed', 0);
      state.speed += (target - state.speed) * Math.min(1, dt * 10);
    }
    if (jumpT > 0) { jumpT -= dt; state.onGround = jumpT <= 0; }
    state.lookDX = input.lookDX + lookRate * dt;
    state.lookDY = input.lookDY;
    camYaw -= input.lookDX; camPitch = THREE.MathUtils.clamp(camPitch - input.lookDY, -1.4, 1.4);
    input.lookDX = input.lookDY = 0;
    fireCd -= dt;
    if (input.fire && fireCd <= 0 && RATE[weapon]) { vm.fire(); fireCd = RATE[weapon]; if (weapon === 'deagle') input.fire = false; }
    vm.update(dt, state);
  }

  // orbit debug camera
  const orbit = Q.get('view') === 'orbit';
  const ocam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 20);
  function placeOrbit() {
    const yaw = THREE.MathUtils.degToRad(num('oyaw', 60)), pitch = THREE.MathUtils.degToRad(num('opitch', 15)), d = num('odist', 0.9);
    const tgt = new THREE.Vector3(num('ox', 0.06), num('oy', -0.12), num('oz', -0.35));
    ocam.position.set(tgt.x + Math.sin(yaw) * Math.cos(pitch) * d, tgt.y + Math.sin(pitch) * d, tgt.z + Math.cos(yaw) * Math.cos(pitch) * d);
    ocam.lookAt(tgt);
  }
  if (orbit) {
    placeOrbit();
    // show the viewmodel camera position
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.01), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    vm.scene.add(m);
    vm.scene.add(new THREE.AxesHelper(0.1));
  }

  function render() {
    worldCam.rotation.set(camPitch, camYaw, 0, 'YXZ');
    renderer.autoClear = false;
    renderer.clear();
    if (!orbit) renderer.render(world, worldCam);
    renderer.clearDepth();
    renderer.render(vm.scene, orbit ? ocam : vm.camera);
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) step(dt);
    render();
    const mo = vm.getMuzzleOffset(new THREE.Vector3());
    hud.textContent = `kind=${kind} weapon=${weapon}  speed=${state.speed.toFixed(1)} ${state.sprint ? 'SPRINT ' : ''}${state.crouch ? 'CROUCH ' : ''}${paused ? 'PAUSED' : ''}\n` +
      `muzzle(cam)=${mo.x.toFixed(3)},${mo.y.toFixed(3)},${mo.z.toFixed(3)}  calls=${renderer.info.render.calls}\n` +
      `1-6 human  7 hunter  8 zombie  9 mother  0 terminator | LMB fire  R reload  F melee  V heavy  G throw  WASD/Shift/C/Space  P pause`;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function equipKey(w) {
    weapon = w;
    const k = kindFor(w);
    if (k !== kind || w === 'claws') { kind = w === 'claws' && (kind === 'mother') ? 'mother' : k; vm.setKind(kind); }
    vm.equip(w);
  }
  addEventListener('keydown', (e) => {
    input.keys.add(e.code);
    const map = { Digit1: 'ak47', Digit2: 'm4a1', Digit3: 'mg3', Digit4: 'deagle', Digit5: 'knife', Digit6: 'grenade', Digit7: 'blade' };
    if (map[e.code]) equipKey(map[e.code]);
    if (e.code === 'Digit8') { kind = 'zombie'; vm.setKind(kind); weapon = 'claws'; vm.equip('claws'); }
    if (e.code === 'Digit9') { kind = 'mother'; vm.setKind(kind); weapon = 'claws'; vm.equip('claws'); }
    if (e.code === 'Digit0') { kind = 'terminator'; vm.setKind(kind); weapon = 'fists'; vm.equip('fists'); }
    if (e.code === 'KeyR') vm.reload(weapon === 'mg3' ? 4.5 : weapon === 'deagle' ? 2.0 : 2.5);
    if (e.code === 'KeyF') vm.melee(false);
    if (e.code === 'KeyV') vm.melee(true);
    if (e.code === 'KeyG') vm.throwGrenade();
    if (e.code === 'KeyP') paused = !paused;
    if (e.code === 'Space' && state.onGround) { state.onGround = false; jumpT = 0.55; }
  });
  addEventListener('keyup', (e) => input.keys.delete(e.code));
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.();
    if (e.button === 0) { input.fire = true; if (!RATE[weapon]) vm.melee(false); }
    if (e.button === 2) vm.melee(true);
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) input.fire = false; });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === renderer.domElement) { input.lookDX += e.movementX * 0.0022; input.lookDY += e.movementY * 0.0022; }
  });
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    worldCam.aspect = innerWidth / innerHeight; worldCam.updateProjectionMatrix();
    ocam.aspect = worldCam.aspect; ocam.updateProjectionMatrix();
    vm.setAspect(innerWidth / innerHeight);
  });

  // deterministic seek hooks for screenshots
  function advance(sec, h = 1 / 120) { let t = 0; while (t < sec - 1e-9) { const d = Math.min(h, sec - t); step(d); t += d; } }
  function doAct(act) {
    if (act === 'fire') vm.fire();
    else if (act === 'reload') vm.reload(num('dur', weapon === 'mg3' ? 4.5 : weapon === 'deagle' ? 2.0 : 2.5));
    else if (act === 'melee') vm.melee(false);
    else if (act === 'meleeH') vm.melee(true);
    else if (act === 'throw') vm.throwGrenade();
    else if (act === 'draw') vm.equip(weapon);
  }
  window.demo = {
    vm,
    advance,
    setPaused: (b) => { paused = b; },
    seek(act, t) { paused = true; advance(1.2); doAct(act); advance(t); render(); return vm.getMuzzleOffset(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)); },
    fireBurst(n, gap, t) { paused = true; advance(1.2); for (let i = 0; i < n; i++) { vm.fire(); advance(gap); } advance(t || 0); render(); },
  };
  if (Q.has('t')) {
    const act = Q.get('act') || 'none';
    paused = true;
    advance(1.2 + num('pre', 0));
    if (act !== 'none') doAct(act);
    if (act === 'fire' && Q.has('burst')) { const n = num('burst', 5); for (let i = 1; i < n; i++) { advance(RATE[weapon] || 0.1); vm.fire(); } }
    advance(num('t', 0));
  }
}

// ---------------------------------------------------------------------------
// Hand test: grid of posed hands
// ---------------------------------------------------------------------------
async function handTest() {
  const { createHandPreview, HAND_POSES } = await import('../src/weapons/viewmodel.js');
  document.getElementById('cross').style.display = 'none';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2e2a28);
  scene.environment = getDawnEnvironment();
  const key = new THREE.DirectionalLight(0xffc896, 2.4); key.position.set(-2, 4, 5); scene.add(key);
  scene.add(new THREE.HemisphereLight(0xbfd4f0, 0x5a4030, 0.8));
  const kind = Q.get('kind') || 'human';
  const poses = Q.get('pose') ? Q.get('pose').split(',') : HAND_POSES;
  const cols = Math.ceil(Math.sqrt(poses.length * 1.6));
  const yaw = THREE.MathUtils.degToRad(num('hyaw', 30)), pitch = THREE.MathUtils.degToRad(num('hpitch', 35));
  poses.forEach((p, i) => {
    const h = createHandPreview(kind, p);
    const g = new THREE.Group();
    g.add(h);
    h.position.z = 0.07;
    g.rotation.set(pitch, yaw, 0, 'YXZ');
    g.position.set((i % cols - (cols - 1) / 2) * 0.24, -(Math.floor(i / cols) - (Math.ceil(poses.length / cols) - 1) / 2) * 0.22, 0);
    scene.add(g);
  });
  const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 20);
  cam.position.set(0, 0, num('dist', 1.4));
  hud.textContent = poses.join('  ');
  renderer.setAnimationLoop(() => renderer.render(scene, cam));
}

// Texture gallery for src/engine/textures.js
//   ?view=grid (default)          every set on lit objects under warm dawn light
//   ?view=one&t=brick             close-up of one set (wall / ground + cube), grazing light
//   ?view=flat&t=brick&m=map,normalMap,roughnessMap&tile=2&crop=1   raw 2D maps
//   ?view=flatall&m=map           thumbnails of every map
//   &q=low|medium|high            texture quality
import * as THREE from 'three';
import { initTextures, setTextureQuality, Tex, TILE_METERS, withRepeat } from '../src/engine/textures.js';

const P = new URLSearchParams(location.search);
const view = P.get('view') || 'grid';
const q = P.get('q') || 'high';
const info = document.getElementById('info');

// ---- items -----------------------------------------------------------------
const ITEMS = [
  { n: 'woodSiding', f: () => Tex.woodSiding(), k: 'box' },
  { n: 'woodSiding red', f: () => Tex.woodSiding({ color: '#8a4436', peel: 0.35, seed: 3 }), k: 'box', tile: 'woodSiding' },
  { n: 'planks', f: () => Tex.planks(), k: 'ground' },
  { n: 'weatheredWood', f: () => Tex.weatheredWood(), k: 'box' },
  { n: 'crate', f: () => Tex.crate(), k: 'box', size: 1.1, tileM: 1.1 },
  { n: 'dirt', f: () => Tex.dirt(), k: 'ground' },
  { n: 'road', f: () => Tex.road(), k: 'ground', size: 2.0 },
  { n: 'rock', f: () => Tex.rock(), k: 'box', tileM: 4 },
  { n: 'shingles', f: () => Tex.shingles(), k: 'roof' },
  { n: 'corrugated', f: () => Tex.corrugated(), k: 'box' },
  { n: 'corrugated blue', f: () => Tex.corrugated({ color: '#4f6a7a', rust: 0.35, seed: 2 }), k: 'box', tile: 'corrugated' },
  { n: 'brick', f: () => Tex.brick(), k: 'box' },
  { n: 'stoneFoundation', f: () => Tex.stoneFoundation(), k: 'box' },
  { n: 'plaster', f: () => Tex.plaster(), k: 'box' },
  { n: 'metal', f: () => Tex.metal(), k: 'box', metal: true },
  { n: 'metalDark', f: () => Tex.metalDark(), k: 'cyl', metal: true },
  { n: 'container', f: () => Tex.container(), k: 'box', metal: true, tileM: 1.6 },
  { n: 'container blue', f: () => Tex.container({ color: '#2f4f6a', seed: 4 }), k: 'box', metal: true, tile: 'container', tileM: 1.6 },
  { n: 'sandbag', f: () => Tex.sandbag(), k: 'bag' },
  { n: 'hay', f: () => Tex.hay(), k: 'box' },
  { n: 'cloth', f: () => Tex.cloth(), k: 'awning' },
  { n: 'cloth stripes', f: () => Tex.cloth({ color: '#7a2f28', stripes: true, seed: 2 }), k: 'awning', tile: 'cloth' },
  { n: 'window', f: () => Tex.window(), k: 'panel', w: 1.0, h: 1.5 },
  { n: 'window lit', f: () => Tex.window({ lit: true, seed: 2 }), k: 'panel', w: 1.0, h: 1.5 },
  { n: 'door', f: () => Tex.door(), k: 'panel', w: 0.9, h: 1.8 },
  { n: 'sign carved', f: () => Tex.sign('SALOON', { style: 'carved' }), k: 'panel', w: 1.6, h: 0.4 },
  { n: 'sign painted', f: () => Tex.sign('GUN SHOP', { style: 'painted', bg: '#5a2a1e', fg: '#e8d7a2', seed: 2 }), k: 'panel', w: 1.6, h: 0.4 },
  { n: 'poster wanted', f: () => Tex.poster('wanted'), k: 'panel', w: 0.7, h: 1.05, alpha: true },
  { n: 'poster notice', f: () => Tex.poster('notice', { seed: 2 }), k: 'panel', w: 0.7, h: 1.05, alpha: true },
  { n: 'clockFace', f: () => Tex.clockFace(), k: 'panel', w: 1.1, h: 1.1 },
  { n: 'decals', f: () => ({ bullet: Tex.decalBulletHole(), blood: Tex.decalBlood(), blood2: Tex.decalBlood({ seed: 2 }), scorch: Tex.decalScorch() }), k: 'decals' },
  { n: 'particles', f: () => ({ soft: Tex.particleSoft(), spark: Tex.particleSpark() }), k: 'particles' },
];

async function waitFonts() {
  try {
    await Promise.race([
      (async () => { await document.fonts.ready; await document.fonts.load("40px 'Rye'"); })(),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* ignore */ }
}

function generateAll(items) {
  const times = [];
  let total = 0;
  for (const it of items) {
    const t0 = performance.now();
    it.set = it.f();
    const dt = performance.now() - t0;
    times.push([it.n, dt]); total += dt;
  }
  for (const [n, dt] of times) console.log(`[tex] ${n.padEnd(18)} ${dt.toFixed(1).padStart(7)} ms`);
  console.log(`[tex] TOTAL (${q}) ${total.toFixed(1)} ms for ${items.length} sets`);
  return { times, total };
}

function tileOf(it) { return TILE_METERS[it.tile || it.n] || 1; }

// ---- 3D -------------------------------------------------------------------
function makeRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.0;
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(r.domElement);
  return r;
}

function dawnLights(scene, dir, shadowSize = 14) {
  scene.background = new THREE.Color('#9a8a70');
  scene.fog = new THREE.Fog('#9a8a70', 30, 70);
  const hemi = new THREE.HemisphereLight('#b3bccb', '#6a5840', 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffcf9e', 2.8);
  sun.position.copy(dir).multiplyScalar(20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -shadowSize; c.right = shadowSize; c.top = shadowSize; c.bottom = -shadowSize; c.near = 1; c.far = 60;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  scene.add(sun);
  return sun;
}

function mat(set, it, rep = 1) {
  const s = withRepeat(set, rep, rep);
  const m = new THREE.MeshStandardMaterial({
    map: s.map, normalMap: s.normalMap || null, roughnessMap: s.roughnessMap || null,
    metalnessMap: s.metalnessMap || null, metalness: s.metalnessMap ? 1 : 0, roughness: 1,
    emissiveMap: s.emissiveMap || null, emissive: s.emissiveMap ? new THREE.Color(1, 1, 1) : new THREE.Color(0), emissiveIntensity: s.emissiveMap ? 1.4 : 0,
    transparent: !!it.alpha, alphaTest: it.alpha ? 0.5 : 0, side: it.alpha ? THREE.DoubleSide : THREE.FrontSide,
  });
  return m;
}

function buildItem(it, big = false) {
  const g = new THREE.Group();
  const size = it.size || (big ? 2.2 : 1.35);
  const set = it.set;
  const rep = (it.tileM || size) / tileOf(it);
  const sh = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  switch (it.k) {
    case 'box': case 'bag': {
      const geo = it.k === 'bag' ? new THREE.BoxGeometry(size, size * 0.45, size * 0.6) : new THREE.BoxGeometry(size, size, size);
      const m = sh(new THREE.Mesh(geo, mat(set, it, rep)));
      m.position.y = it.k === 'bag' ? size * 0.225 : size / 2; m.rotation.y = -0.6;
      g.add(m); break;
    }
    case 'cyl': {
      const m = sh(new THREE.Mesh(new THREE.CylinderGeometry(size * 0.4, size * 0.45, size, 40), mat(set, it, 2)));
      m.position.y = size / 2; g.add(m);
      const s2 = sh(new THREE.Mesh(new THREE.SphereGeometry(size * 0.3, 40, 24), mat(set, it, 1)));
      s2.position.set(0, size + size * 0.25, 0); g.add(s2); break;
    }
    case 'ground': {
      const s = it.size || (big ? 8 : 1.9);
      const m = sh(new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat(set, it, s / tileOf(it))));
      m.rotation.x = -Math.PI / 2; m.position.y = big ? 0.01 : 0.13; g.add(m);
      if (!big) { const base = sh(new THREE.Mesh(new THREE.BoxGeometry(s, 0.12, s), new THREE.MeshStandardMaterial({ color: '#3a2e24', roughness: 1 }))); base.position.y = 0.06; g.add(base); }
      break;
    }
    case 'roof': {
      const m = sh(new THREE.Mesh(new THREE.BoxGeometry(size * 1.2, 0.06, size), mat(set, it, size / tileOf(it))));
      m.rotation.x = 0.55; m.position.y = size * 0.3; m.rotation.order = 'YXZ'; m.rotation.y = 0.0; g.add(m); break;
    }
    case 'awning': {
      const m = sh(new THREE.Mesh(new THREE.PlaneGeometry(size * 1.1, size), mat(set, { ...it, alpha: false }, size / tileOf(it))));
      m.material.side = THREE.DoubleSide; m.rotation.x = -0.9; m.position.y = size * 0.55; g.add(m); break;
    }
    case 'panel': {
      const sc = big ? 1.6 : 1;
      const back = sh(new THREE.Mesh(new THREE.BoxGeometry(it.w * sc + 0.2, it.h * sc + 0.2, 0.1), new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 0.9 })));
      back.position.y = (it.h * sc + 0.2) / 2; g.add(back);
      const m = sh(new THREE.Mesh(new THREE.PlaneGeometry(it.w * sc, it.h * sc), mat(set, it, 1)));
      m.position.set(0, (it.h * sc + 0.2) / 2, 0.052); g.add(m);
      g.rotation.y = -0.35; break;
    }
    case 'decals': {
      const wall = sh(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 0.1), mat(Tex.plaster(), {}, 0.9)));
      wall.position.y = 0.7; g.add(wall);
      const put = (t, x, y, s) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap || null, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
        m.position.set(x, y, 0.051); g.add(m);
      };
      put(set.bullet, -0.55, 1.05, 0.22); put(set.bullet, -0.3, 0.95, 0.18); put(set.bullet, -0.45, 0.75, 0.2);
      put(set.blood, 0.35, 0.8, 0.8); put(set.blood2, -0.45, 0.35, 0.55); put(set.scorch, 0.4, 0.3, 0.6);
      g.rotation.y = -0.35; break;
    }
    case 'particles': {
      for (let i = 0; i < 14; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: set.soft.map, color: '#b9a582', transparent: true, opacity: 0.55, depthWrite: false }));
        sp.position.set((Math.sin(i * 2.1) * 0.5), 0.4 + i * 0.09, Math.cos(i * 1.7) * 0.4); sp.scale.setScalar(0.5 + (i % 4) * 0.2); g.add(sp);
      }
      for (let i = 0; i < 10; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: set.spark.map, color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        sp.position.set(0.6 + Math.sin(i * 3.3) * 0.3, 0.3 + (i % 5) * 0.25, Math.cos(i * 2.2) * 0.3); sp.scale.setScalar(0.15 + (i % 3) * 0.08); g.add(sp);
      }
      break;
    }
  }
  return g;
}

function runGrid(renderer) {
  const scene = new THREE.Scene();
  dawnLights(scene, new THREE.Vector3(-0.75, 0.33, 0.55).normalize(), 16);
  const floorSet = Tex.dirt();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat(floorSet, { n: 'dirt' }, 60 / TILE_METERS.dirt));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const COLS = 8;
  const labels = [];
  ITEMS.forEach((it, i) => {
    const c = i % COLS, r = Math.floor(i / COLS);
    const g = buildItem(it);
    g.position.set((c - (COLS - 1) / 2) * 2.7, 0, (r - 1.5) * 3.5);
    scene.add(g);
    labels.push([it.n, g.position.clone().add(new THREE.Vector3(0, 0, 1.15))]);
  });
  const cam = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 200);
  cam.position.set(0, 17, 13.5); cam.lookAt(0, 0, 0.9);
  renderer.render(scene, cam);
  const box = document.getElementById('labels');
  for (const [n, p] of labels) {
    const v = p.clone().project(cam);
    const d = document.createElement('div'); d.className = 'lab'; d.textContent = n;
    d.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px'; d.style.top = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    box.appendChild(d);
  }
  let t = 0;
  const loop = () => { renderer.render(scene, cam); t++; if (t < 600) requestAnimationFrame(loop); };
  loop();
}

function runOne(renderer, name) {
  const it = ITEMS.find((x) => x.n === name) || ITEMS[0];
  const scene = new THREE.Scene();
  const az = parseFloat(P.get('az') || '-0.9'), el = parseFloat(P.get('el') || '0.28');
  dawnLights(scene, new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)), 8);
  const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 100);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat(Tex.dirt(), { n: 'dirt' }, 10));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  if (it.k === 'ground') {
    scene.remove(floor);
    const s = it.n === 'road' ? 16 : 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat(it.set, it, s / tileOf(it)));
    m.rotation.x = -Math.PI / 2; m.receiveShadow = true; scene.add(m);
    cam.position.set(0, it.n === 'road' ? 5 : 2.2, it.n === 'road' ? 6 : 2.6); cam.lookAt(0, 0, -0.5);
  } else if (it.k === 'box' || it.k === 'bag' || it.k === 'cyl' || it.k === 'roof' || it.k === 'awning') {
    const wallW = 4, wallH = 3;
    const tm = tileOf(it);
    if (it.k !== 'cyl' && it.k !== 'bag') {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(wallW, wallH), mat(it.set, it, 1));
      const s = withRepeat(it.set, wallW / tm, wallH / tm);
      Object.assign(wall.material, { map: s.map, normalMap: s.normalMap || null, roughnessMap: s.roughnessMap || null, metalnessMap: s.metalnessMap || null });
      wall.position.set(0, wallH / 2, -1); wall.receiveShadow = true; scene.add(wall);
    }
    const g = buildItem({ ...it, size: it.k === 'bag' ? 1.4 : 1.1, tileM: it.tileM ? it.tileM * 0.7 : undefined }, true);
    g.position.set(0.6, 0, 0.3); scene.add(g);
    cam.position.set(-0.6, 1.5, 3.0); cam.lookAt(0.1, 1.0, -0.4);
  } else {
    const g = buildItem(it, true); g.rotation.y = -0.15; scene.add(g);
    const h = (it.h || 1.4) * 1.6;
    cam.position.set(0.3, h * 0.55 + 0.1, Math.max(1.6, h * 1.25)); cam.lookAt(0, h * 0.5, 0);
  }
  const loop = () => { renderer.render(scene, cam); requestAnimationFrame(loop); };
  loop();
}

// ---- flat 2D ------------------------------------------------------------------
function texCanvas(t, tile = 1) {
  const img = t.image, w = img.width, h = img.height;
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const d = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  const id = new ImageData(new Uint8ClampedArray(d), w, h);
  src.getContext('2d').putImageData(id, 0, 0);
  const c = document.createElement('canvas'); c.width = w * tile; c.height = h * tile;
  const ctx = c.getContext('2d');
  ctx.translate(0, h * tile); ctx.scale(1, -1); // data is GL (bottom-up) order
  for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) ctx.drawImage(src, x * w, y * h);
  return c;
}

function runFlat(names, maps, tile, crop, thumb) {
  const box = document.createElement('div'); box.id = 'flat'; document.body.appendChild(box);
  for (const name of names) {
    const it = ITEMS.find((x) => x.n === name);
    if (!it) continue;
    const sets = it.set.map ? { '': it.set } : it.set;
    for (const sk in sets) {
      for (const m of maps) {
        const t = sets[sk][m];
        if (!t) continue;
        const c = texCanvas(t, tile);
        const fig = document.createElement('figure');
        if (crop) {
          c.style.width = c.width + 'px'; c.style.height = c.height + 'px';
          const wrap = document.createElement('div'); wrap.style.cssText = `width:${Math.min(c.width, crop)}px;height:${Math.min(c.height, 700)}px;overflow:hidden`;
          wrap.appendChild(c); fig.appendChild(wrap);
        } else {
          const maxH = thumb ? 150 : 700, maxW = thumb ? 200 : Math.floor((innerWidth - 16) / Math.min(3, maps.length * names.length));
          const s = Math.min(maxW / c.width, maxH / c.height);
          c.style.width = Math.round(c.width * s) + 'px'; c.style.height = Math.round(c.height * s) + 'px';
          fig.appendChild(c);
        }
        const cap = document.createElement('figcaption'); cap.textContent = `${name}${sk ? '.' + sk : ''} ${m} ${t.image.width}×${t.image.height}`;
        fig.appendChild(cap); box.appendChild(fig);
      }
    }
  }
}

// ---- main -----------------------------------------------------------------------
(async () => {
  await waitFonts();
  setTextureQuality(q);
  let renderer = null;
  if (view === 'grid' || view === 'one') { renderer = makeRenderer(); initTextures(renderer); }
  const list = view === 'one' || view === 'flat' ? ITEMS.filter((x) => (P.get('t') || 'woodSiding').split(',').includes(x.n)) : ITEMS;
  const { total } = generateAll(view === 'grid' || view === 'flatall' ? ITEMS : list);
  info.textContent = `quality ${q} · ${ITEMS.length} sets · generation ${total.toFixed(0)} ms`;
  if (view === 'grid') runGrid(renderer);
  else if (view === 'one') runOne(renderer, P.get('t') || 'woodSiding');
  else if (view === 'flat') runFlat((P.get('t') || 'woodSiding').split(','), (P.get('m') || 'map,normalMap,roughnessMap').split(','), parseInt(P.get('tile') || '1'), parseInt(P.get('crop') || '0'), false);
  else if (view === 'flatall') runFlat(ITEMS.map((x) => x.n), (P.get('m') || 'map').split(','), 1, 0, true);
  window.__texReady = true;
})().catch((e) => { console.error(e); info.textContent = 'ERROR ' + e.message; });

// Map preview: ?cam=x,y,z&look=x,y,z  (or ?view=name)
import * as THREE from 'three';
import { Renderer } from '../src/engine/renderer.js';
import { initTextures, Tex } from '../src/engine/textures.js';
import { buildMap } from '../src/world/map.js';
import { CollisionWorld } from '../src/game/physics.js';
import { Effects } from '../src/engine/effects.js';

const VIEWS = {
  street: [[-40, 1.7, 2], [30, 4, -2]],
  plaza: [[0, 1.7, 8], [0, 5, -20]],
  clock: [[0, 3, 4], [0, 9, -18]],
  saloon: [[-20, 2.5, -4], [-20, 4, 16]],
  post: [[21, 1.7, -5], [21, 3, -14]],
  postin: [[21, 1.6, -21], [21, 1.4, -12]],
  tunnel: [[14, -1.8, -19.2], [30, -2, -19.2]],
  storage: [[-41, 2, 12], [-38, 1, 30]],
  blue: [[-52, 3, -6], [-42, 4, -18]],
  gun: [[-12, 2, -6], [-20, 5, -18]],
  aerial: [[0, 70, 55], [0, 0, 0]],
  top: [[0, 120, 1], [0, 0, 0]],
  east: [[40, 2, 3], [60, 3, 0]],
  roof: [[-40, 7.6, -18], [0, 5, 0]],
};
const q = new URLSearchParams(location.search);
await document.fonts.load('48px Rye').catch(() => {});
const r = new Renderer(document.getElementById('c'), q.get('q') || 'high');
initTextures(r.renderer);
for (const k of Object.keys(Tex)) { const f = Tex[k]; Tex[k] = (...a) => { try { return f(...a); } catch (e) { console.warn('tex fail', k, e.message); return Tex.plaster ? f === Tex.plaster ? null : Tex.plaster({ color: '#8a8070' }) : null; } }; }
const t0 = performance.now();
const map = buildMap(r.scene);
const t1 = performance.now();
const world = new CollisionWorld(map.colGroup, map.ladders, map.surfaces);
const t2 = performance.now();
const fx = new Effects(r.scene, r.camera);
r.bakeEnvironment();
for (const s of map.lightSpots.slice(0, 9)) { const l = new THREE.PointLight(s.color, s.intensity, s.distance, 1.6); l.position.copy(s.pos); r.scene.add(l); }
let cam, look;
if (q.get('view')) [cam, look] = VIEWS[q.get('view')];
else { cam = (q.get('cam') || '0,2,10').split(',').map(Number); look = (q.get('look') || '0,2,0').split(',').map(Number); }
r.camera.position.set(...cam);
r.camera.lookAt(...look);
if (q.get('fov')) { r.camera.fov = +q.get('fov'); r.camera.updateProjectionMatrix(); }
let tris = 0;
r.scene.traverse((o) => { if (o.isMesh && o.geometry.index) tris += o.geometry.index.count / 3; else if (o.isMesh) tris += o.geometry.attributes.position.count / 3; });
console.log(`map ${(t1 - t0).toFixed(0)}ms, octree ${(t2 - t1).toFixed(0)}ms, meshes ${map.meshes.length}, tris ${Math.round(tris)}, colliders tris ${map.colGeo.attributes.position.count / 3}`);
let last = performance.now(), frames = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  fx.update(dt, r.camera.position);
  r.render(dt, now / 1000);
  frames++;
  if (frames === 60) console.log('calls', r.renderer.info.render.calls, 'tris', r.renderer.info.render.triangles);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.__ok = true;

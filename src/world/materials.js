// World materials built on the procedural texture library. UVs are in meters
// (see builder.applyBoxUV), so each material's texture repeat = 1 / tile size.
import * as THREE from 'three';
import { Tex, TILE_METERS as T } from '../engine/textures.js';

function withRepeat(tex, rep) {
  if (!tex) return null;
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rep, rep);
  return t;
}

export function texMat(set, tile, params = {}) {
  const rep = tile ? 1 / tile : 1;
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, ...params });
  if (set.map) m.map = withRepeat(set.map, rep);
  if (set.normalMap) { m.normalMap = withRepeat(set.normalMap, rep); m.normalScale = new THREE.Vector2(1, 1).multiplyScalar(params.normalStrength ?? 1); }
  if (set.roughnessMap) m.roughnessMap = withRepeat(set.roughnessMap, rep);
  if (set.emissiveMap) { m.emissiveMap = withRepeat(set.emissiveMap, rep); }
  if (set.metalnessMap && params.metalness !== undefined) { m.metalnessMap = withRepeat(set.metalnessMap, rep); m.metalness = Math.min(1, params.metalness * 1.6); }
  delete m.normalStrength;
  return m;
}

// Material registry for the village.
export function createWorldMaterials(b) {
  const M = {};
  const def = (key, mat, opts) => { M[key] = mat; b.defMat(key, mat, opts); return mat; };

  def('ground', texMat(Tex.dirt({ seed: 11 }), T.dirt, { roughness: 1 }), { castShadow: false });
  def('road', texMat(Tex.road({ seed: 12 }), T.road, { roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { castShadow: false });
  def('rock', texMat(Tex.rock({ seed: 13 }), T.rock, { roughness: 0.95 }));
  def('sidingBlue', texMat(Tex.woodSiding({ color: '#4f7596', peel: 0.55, seed: 21 }), T.woodSiding));
  def('sidingRed', texMat(Tex.woodSiding({ color: '#7d3526', peel: 0.5, seed: 22 }), T.woodSiding));
  def('sidingWhite', texMat(Tex.woodSiding({ color: '#c9bfa5', peel: 0.6, seed: 23 }), T.woodSiding));
  def('sidingGreen', texMat(Tex.woodSiding({ color: '#4e6448', peel: 0.45, seed: 24 }), T.woodSiding));
  def('sidingOchre', texMat(Tex.woodSiding({ color: '#a4803f', peel: 0.5, seed: 25 }), T.woodSiding));
  def('sidingGray', texMat(Tex.woodSiding({ color: '#8c8478', peel: 0.8, seed: 26 }), T.woodSiding));
  def('planks', texMat(Tex.planks({ color: '#8a6a48', worn: 0.6, seed: 31 }), T.planks));
  def('planksDark', texMat(Tex.planks({ color: '#5a4430', worn: 0.7, seed: 32 }), T.planks));
  def('wood', texMat(Tex.weatheredWood({ seed: 33 }), T.weatheredWood));
  def('woodDark', texMat(Tex.weatheredWood({ seed: 34 }), T.weatheredWood, { color: 0x7a6a5a }));
  def('crate', texMat(Tex.crate({ seed: 35 }), 1.1));
  def('shingles', texMat(Tex.shingles({ color: '#5d4a3a', seed: 41 }), T.shingles));
  def('corrugated', texMat(Tex.corrugated({ color: '#8a8f93', rust: 0.6, seed: 42 }), T.corrugated, { metalness: 0.55, roughness: 0.75 }));
  def('corrugatedRust', texMat(Tex.corrugated({ color: '#8a6f5a', rust: 0.95, seed: 43 }), T.corrugated, { metalness: 0.4, roughness: 0.85 }));
  def('brick', texMat(Tex.brick({ color: '#8b4a36', seed: 44 }), T.brick));
  def('stone', texMat(Tex.stoneFoundation({ seed: 45 }), T.stoneFoundation));
  def('plaster', texMat(Tex.plaster({ color: '#b39a78', seed: 46 }), T.plaster));
  def('metalDark', texMat(Tex.metalDark(), T.metalDark, { metalness: 0.7, roughness: 0.55 }));
  def('metalRust', texMat(Tex.metal({ color: '#6b5a4c', rust: 0.8, seed: 47 }), T.metal, { metalness: 0.5, roughness: 0.8 }));
  def('containerRed', texMat(Tex.container({ color: '#8a3b2a', seed: 51 }), T.container, { metalness: 0.45, roughness: 0.7 }));
  def('containerBlue', texMat(Tex.container({ color: '#2f5670', seed: 52 }), T.container, { metalness: 0.45, roughness: 0.7 }));
  def('containerGreen', texMat(Tex.container({ color: '#4a6040', seed: 53 }), T.container, { metalness: 0.45, roughness: 0.7 }));
  def('containerOrange', texMat(Tex.container({ color: '#a8612a', seed: 54 }), T.container, { metalness: 0.45, roughness: 0.7 }));
  def('sandbag', texMat(Tex.sandbag({ seed: 55 }), T.sandbag));
  def('hay', texMat(Tex.hay({ seed: 56 }), T.hay));
  def('cloth', texMat(Tex.cloth({ color: '#8c6b4a', stripes: true, seed: 57 }), T.cloth, { side: THREE.DoubleSide }));
  def('clothRed', texMat(Tex.cloth({ color: '#7a2f28', stripes: false, seed: 58 }), T.cloth, { side: THREE.DoubleSide }));

  const win = Tex.window({ lit: false, seed: 61 });
  def('window', texMat(win, 0, { roughness: 0.4, metalness: 0.1, envMapIntensity: 1.4 }), { castShadow: false });
  const winLit = Tex.window({ lit: true, seed: 62 });
  def('windowLit', texMat(winLit, 0, { roughness: 0.4, emissive: 0xffa040, emissiveIntensity: 1.6 }), { castShadow: false });
  def('door', texMat(Tex.door({ color: '#4a3526', seed: 63 }), 0), { castShadow: false });
  def('doorGreen', texMat(Tex.door({ color: '#3a4a36', seed: 64 }), 0), { castShadow: false });
  def('poster', texMat(Tex.poster('wanted', { seed: 65 }), 0, { roughness: 0.9, alphaTest: 0.5 }), { castShadow: false });
  def('poster2', texMat(Tex.poster('wanted', { seed: 66 }), 0, { roughness: 0.9, alphaTest: 0.5 }), { castShadow: false });
  def('clock', texMat(Tex.clockFace(), 0, { roughness: 0.5, emissive: 0x3a2a10, emissiveIntensity: 0.6 }), { castShadow: false });

  def('lampGlow', new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffa24a, emissiveIntensity: 5, roughness: 0.5 }), { castShadow: false });
  def('iron', new THREE.MeshStandardMaterial({ color: 0x2a2826, metalness: 0.85, roughness: 0.45 }));
  def('brass', new THREE.MeshStandardMaterial({ color: 0x8a6a34, metalness: 0.9, roughness: 0.35 }));
  def('rail', new THREE.MeshStandardMaterial({ color: 0x4a4540, metalness: 0.9, roughness: 0.5 }));
  def('water', new THREE.MeshStandardMaterial({ color: 0x1d2a24, metalness: 0.2, roughness: 0.08 }), { castShadow: false });
  def('rope', new THREE.MeshStandardMaterial({ color: 0x7a6440, roughness: 1 }));
  def('cactus', new THREE.MeshStandardMaterial({ color: 0x4a5a36, roughness: 0.9 }));
  def('bone', new THREE.MeshStandardMaterial({ color: 0xcfc4a8, roughness: 0.8 }));

  M.signMat = (text, opts = {}) => {
    const key = 'sign:' + text;
    if (M[key]) return key;
    const set = Tex.sign(text, opts);
    def(key, texMat(set, 0, { roughness: 0.85 }), { castShadow: false });
    return key;
  };
  return M;
}

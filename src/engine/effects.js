// Visual effects: GPU point particles (sparks, dust, smoke, blood, fire), tracers,
// decals (bullet holes, blood, scorch), dynamic muzzle lights, electric arcs,
// shield bubbles, ambient dust motes and tumbleweeds.
import * as THREE from 'three';
import { Tex } from './textures.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

class Particles {
  constructor(scene, cap, additive, tex) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setAttribute('size', this.aSize);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: tex }, uScale: { value: 600 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float size; attribute vec4 color;
        varying vec4 vCol; varying float vFog;
        uniform float uScale; uniform float fogDensity;
        void main(){
          vCol = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          vFog = 1.0 - exp(-fogDensity * fogDensity * d * d);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; uniform vec3 fogColor;
        varying vec4 vCol; varying float vFog;
        void main(){
          vec4 t = texture2D(map, gl_PointCoord);
          vec4 c = vCol * t;
          ${additive ? 'c.rgb *= (1.0 - vFog); c.rgb *= c.a;' : 'c.rgb = mix(c.rgb, fogColor, vFog);'}
          if (c.a < 0.003) discard;
          gl_FragColor = c;
        }`,
    });
    this.mat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
    scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, size, r, g, b, a, grav = 0, drag = 0, grow = 0) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else i = (Math.random() * this.cap) | 0;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.a0[i] = a;
    this.size[i] = size; this.life[i] = life; this.max[i] = life;
    this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow;
  }

  update(dt, fog) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) this._copy(n, i);
        i--;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.max[i];
      this.col[i * 4 + 3] = this.a0[i] * Math.min(1, t * 2.2) * (t > 0.92 ? (1 - t) / 0.08 : 1);
    }
    this.n = n;
    this.points.geometry.setDrawRange(0, n);
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true;
    if (fog) { this.mat.uniforms.fogColor.value.copy(fog.color); this.mat.uniforms.fogDensity.value = fog.density; }
  }

  _copy(from, to) {
    for (let k = 0; k < 3; k++) { this.pos[to * 3 + k] = this.pos[from * 3 + k]; this.vel[to * 3 + k] = this.vel[from * 3 + k]; }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.size[to] = this.size[from]; this.life[to] = this.life[from]; this.max[to] = this.max[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from]; this.grow[to] = this.grow[from]; this.a0[to] = this.a0[from];
  }
}

class DecalPool {
  constructor(scene, cap, tex, size, opts = {}) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      roughness: 0.9, metalness: 0, ...opts,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.cap = cap; this.i = 0; this.size = size;
    scene.add(this.mesh);
  }
  add(p, n, scale = 1) {
    _q.setFromUnitVectors(Z, n);
    const rot = new THREE.Quaternion().setFromAxisAngle(Z, Math.random() * Math.PI * 2);
    _q.multiply(rot);
    const s = this.size * scale * (0.8 + Math.random() * 0.4);
    _s.set(s, s, s);
    _v.copy(n).multiplyScalar(0.012).add(p);
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(this.i, _m);
    this.i = (this.i + 1) % this.cap;
    this.mesh.count = Math.min(this.cap, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.mesh.count = 0; this.i = 0; }
}

export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    const soft = Tex.particleSoft().map;
    const spark = Tex.particleSpark().map;
    this.add = new Particles(scene, 3000, true, spark);
    this.glow = new Particles(scene, 1200, true, soft);
    this.smoke = new Particles(scene, 2500, false, soft);
    this.holes = new DecalPool(scene, 260, Tex.decalBulletHole().map, 0.14);
    this.blood = new DecalPool(scene, 90, Tex.decalBlood({ seed: 3 }).map, 1.1, { color: 0x9a9a9a });
    this.scorch = new DecalPool(scene, 16, Tex.decalScorch().map, 4.5);

    // tracers
    const tgeo = new THREE.BoxGeometry(1, 1, 1);
    tgeo.translate(0, 0, -0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.tracers = new THREE.InstancedMesh(tgeo, this.tracerMat, 96);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    this.tracerList = [];

    // pooled dynamic lights for muzzle flashes/explosions
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 9, 1.8);
      l.userData.t = 0;
      scene.add(l);
      this.lights.push(l);
    }
    this.lightIdx = 0;

    // electric arcs
    this.arcMat = new THREE.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.arcs = [];

    // shield bubble material (fresnel)
    this.shieldMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x4fd6ff) } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vP = position; vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          float hex = 0.5 + 0.5 * sin(vP.y * 18.0 + uTime * 6.0) * sin(vP.x * 18.0 - uTime * 3.0) * sin(vP.z * 18.0);
          gl_FragColor = vec4(uColor * (f * 1.6 + hex * 0.12), f * 0.9 + 0.05); }`,
    });

    this.motes = this._makeMotes();
    this.tumbleweeds = [];
    this.world = null;
    this.time = 0;
  }

  setWorld(world) { this.world = world; }

  _makeMotes() {
    const n = 700;
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - 0.5) * 40; p[i * 3 + 1] = Math.random() * 12; p[i * 3 + 2] = (Math.random() - 0.5) * 40; }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const mat = new THREE.PointsMaterial({ size: 0.045, color: 0xffe2b0, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, map: Tex.particleSoft().map });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return pts;
  }

  flashLight(pos, color = 0xffb060, intensity = 18, dist = 10, dur = 0.06) {
    const l = this.lights[this.lightIdx];
    this.lightIdx = (this.lightIdx + 1) % this.lights.length;
    l.position.copy(pos);
    l.color.set(color);
    l.intensity = intensity;
    l.distance = dist;
    l.userData.t = dur; l.userData.i0 = intensity; l.userData.d = dur;
  }

  muzzle(pos, dir, big = false) {
    const s = big ? 1.4 : 1;
    for (let i = 0; i < 4; i++) {
      const k = Math.random() * 0.25;
      this.glow.emit(pos.x + dir.x * k, pos.y + dir.y * k, pos.z + dir.z * k, dir.x * 2, dir.y * 2, dir.z * 2, 0.05, (0.35 - i * 0.05) * s, 1, 0.75, 0.4, 1);
    }
    this.smoke.emit(pos.x, pos.y, pos.z, dir.x * 0.8 + (Math.random() - 0.5) * 0.3, 0.3, dir.z * 0.8, 0.9, 0.18, 0.55, 0.5, 0.45, 0.18, -0.2, 1.5, 0.6);
    this.flashLight(pos, 0xffb060, big ? 30 : 18, 9, 0.05);
  }

  tracer(from, to, speed = 380) {
    const len = from.distanceTo(to);
    if (len < 1.5) return;
    this.tracerList.push({ from: from.clone(), to: to.clone(), len, t: 0, dur: len / speed });
    if (this.tracerList.length > 96) this.tracerList.shift();
  }

  impact(p, n, surface = 'dirt') {
    if (surface === 'flesh') return this.bloodHit(p, n);
    this.holes.add(p, n, surface === 'metal' ? 0.7 : 1);
    const sparks = surface === 'metal' ? 10 : 3;
    for (let i = 0; i < sparks; i++) {
      _v.set(n.x + (Math.random() - 0.5) * 1.4, n.y + (Math.random() - 0.3) * 1.4, n.z + (Math.random() - 0.5) * 1.4).normalize().multiplyScalar(3 + Math.random() * 5);
      this.add.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.18 + Math.random() * 0.25, 0.05, 1, 0.75, 0.35, 1, 9.8, 1);
    }
    const dustCol = surface === 'wood' ? [0.55, 0.42, 0.3] : surface === 'metal' ? [0.5, 0.48, 0.45] : [0.62, 0.5, 0.36];
    for (let i = 0; i < 5; i++) {
      _v.set(n.x + (Math.random() - 0.5), n.y + (Math.random() - 0.5), n.z + (Math.random() - 0.5)).multiplyScalar(0.8 + Math.random() * 1.2);
      this.smoke.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.6 + Math.random() * 0.6, 0.15 + Math.random() * 0.15, dustCol[0], dustCol[1], dustCol[2], 0.5, -0.3, 2.5, 0.9);
    }
    if (surface === 'wood') {
      for (let i = 0; i < 4; i++) {
        _v.set(n.x + (Math.random() - 0.5) * 1.5, n.y + Math.random(), n.z + (Math.random() - 0.5) * 1.5).multiplyScalar(2.5);
        this.smoke.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.5, 0.04, 0.4, 0.3, 0.2, 1, 9.8, 0.5);
      }
    }
  }

  bloodHit(p, n, zombie = true, amount = 1) {
    const c = zombie ? [0.35, 0.05, 0.03] : [0.5, 0.02, 0.02];
    for (let i = 0; i < 8 * amount; i++) {
      _v.set(n.x + (Math.random() - 0.5) * 1.6, n.y + Math.random() * 0.8, n.z + (Math.random() - 0.5) * 1.6).multiplyScalar(1 + Math.random() * 2.5);
      this.smoke.emit(p.x, p.y, p.z, _v.x, _v.y, _v.z, 0.35 + Math.random() * 0.4, 0.05 + Math.random() * 0.07, c[0], c[1], c[2], 0.95, 9.8, 0.8, 0.1);
    }
    this.smoke.emit(p.x, p.y, p.z, n.x * 0.5, 0.2, n.z * 0.5, 0.45, 0.25, c[0] * 0.8, c[1], c[2], 0.5, 0, 2, 1.2);
    if (this.world && Math.random() < 0.35) {
      const hit = this.world.raycast(_v2.copy(p), _v.set(0, -1, 0), 3);
      if (hit) this.blood.add(hit.point, hit.normal, 0.5 + Math.random() * 0.6);
    }
  }

  explosion(p) {
    for (let i = 0; i < 26; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 6);
      this.glow.emit(p.x, p.y + 0.3, p.z, _v.x, _v.y, _v.z, 0.35 + Math.random() * 0.3, 1.2 + Math.random() * 1.2, 1, 0.55 + Math.random() * 0.2, 0.2, 1, -1, 3, 2);
    }
    for (let i = 0; i < 40; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 1.2 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(5 + Math.random() * 14);
      this.add.emit(p.x, p.y + 0.2, p.z, _v.x, _v.y, _v.z, 0.5 + Math.random() * 0.6, 0.08, 1, 0.7, 0.3, 1, 12, 0.6);
    }
    for (let i = 0; i < 30; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).multiplyScalar(3 + Math.random() * 3);
      const g = 0.22 + Math.random() * 0.12;
      this.smoke.emit(p.x, p.y + 0.4, p.z, _v.x, _v.y, _v.z, 2.2 + Math.random() * 2, 1.2 + Math.random(), g, g * 0.92, g * 0.85, 0.75, -0.4, 1.4, 1.6);
    }
    this.flashLight(p, 0xff9040, 120, 26, 0.35);
    if (this.world) {
      const hit = this.world.raycast(_v2.copy(p).setY(p.y + 0.5), _v.set(0, -1, 0), 3);
      if (hit) this.scorch.add(hit.point, hit.normal, 1);
    }
  }

  infectBurst(p) {
    for (let i = 0; i < 26; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 1.5, Math.random() - 0.5).multiplyScalar(3);
      this.smoke.emit(p.x, p.y + 1, p.z, _v.x, _v.y, _v.z, 0.7 + Math.random() * 0.6, 0.18 + Math.random() * 0.2, 0.25, 0.4, 0.12, 0.32, -0.5, 1.8, 0.5);
    }
    for (let i = 0; i < 20; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 2, Math.random() - 0.5).multiplyScalar(4);
      this.glow.emit(p.x, p.y + 1, p.z, _v.x, _v.y, _v.z, 0.6, 0.3, 0.5, 1, 0.2, 1, 2, 1.5, 0.5);
    }
  }

  spawnBurst(p, color = [0.8, 0.15, 0.1]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this.glow.emit(p.x + Math.cos(a) * 0.8, p.y + 0.1, p.z + Math.sin(a) * 0.8, 0, 2 + Math.random() * 3, 0, 0.8, 0.35, color[0], color[1], color[2], 1, 0, 1);
    }
    for (let i = 0; i < 14; i++) {
      this.smoke.emit(p.x + (Math.random() - 0.5) * 1.2, p.y + 0.2, p.z + (Math.random() - 0.5) * 1.2, 0, 0.8, 0, 1.5, 0.6, 0.15, 0.1, 0.1, 0.6, -0.2, 1, 1);
    }
  }

  hunterAura(p) {
    for (let i = 0; i < 2; i++) {
      this.glow.emit(p.x + (Math.random() - 0.5) * 0.8, p.y + Math.random() * 1.8, p.z + (Math.random() - 0.5) * 0.8, 0, 0.8, 0, 0.6, 0.12, 1, 0.8, 0.3, 0.8, -0.5, 1);
    }
  }

  // Electric arc between two points (terminator attacks)
  arc(a, b, segs = 8, dur = 0.12, color = 0x9fe8ff) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = a.clone().lerp(b, t);
      if (i > 0 && i < segs) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4));
      pts.push(p);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = this.arcMat.clone();
    mat.color.set(color);
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.arcs.push({ line, t: dur, d: dur });
    this.glow.emit(b.x, b.y, b.z, 0, 0, 0, 0.12, 0.6, 0.6, 0.9, 1, 1);
  }

  makeShield(radius) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), this.shieldMat);
    m.renderOrder = 6;
    return m;
  }

  spawnTumbleweed() {
    if (!this.world) return;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a6440, roughness: 1, wireframe: true });
    const r = 0.35 + Math.random() * 0.25;
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r * (1 - i * 0.18), 1), mat);
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      g.add(m);
    }
    const west = Math.random() < 0.5;
    g.position.set(west ? -62 : 62, r, (Math.random() - 0.5) * 14);
    g.userData = { r, vx: (west ? 1 : -1) * (2.5 + Math.random() * 2.5), vy: 0, vz: (Math.random() - 0.5) * 0.8, life: 60 };
    g.castShadow = true;
    this.scene.add(g);
    this.tumbleweeds.push(g);
  }

  update(dt, camPos) {
    this.time += dt;
    const fog = this.scene.fog;
    this.add.update(dt, fog);
    this.glow.update(dt, fog);
    this.smoke.update(dt, fog);

    // tracers
    let n = 0;
    for (let i = this.tracerList.length - 1; i >= 0; i--) {
      const t = this.tracerList[i];
      t.t += dt;
      if (t.t > t.dur + 0.02) { this.tracerList.splice(i, 1); continue; }
      const k = Math.min(1, t.t / t.dur);
      const segLen = Math.min(t.len * 0.35, 6);
      _v.copy(t.from).lerp(t.to, k);
      _v2.subVectors(t.to, t.from).normalize();
      _q.setFromUnitVectors(Z, _v2.clone().negate());
      _s.set(0.025, 0.025, segLen);
      _m.compose(_v, _q, _s);
      this.tracers.setMatrixAt(n++, _m);
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;

    for (const l of this.lights) {
      if (l.userData.t > 0) {
        l.userData.t -= dt;
        l.intensity = Math.max(0, l.userData.i0 * (l.userData.t / l.userData.d));
      } else l.intensity = 0;
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.t -= dt;
      a.line.material.opacity = Math.max(0, a.t / a.d);
      if (a.t <= 0) { this.scene.remove(a.line); a.line.geometry.dispose(); a.line.material.dispose(); this.arcs.splice(i, 1); }
    }
    this.shieldMat.uniforms.uTime.value = this.time;

    // dust motes follow the camera in a wrapped volume
    const p = this.motes.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i) + dt * (0.35 + Math.sin(i) * 0.1), y = p.getY(i) + Math.sin(this.time * 0.5 + i) * dt * 0.05, z = p.getZ(i) + dt * 0.12;
      if (x - camPos.x > 20) x -= 40; if (x - camPos.x < -20) x += 40;
      if (z - camPos.z > 20) z -= 40; if (z - camPos.z < -20) z += 40;
      if (y - camPos.y > 8) y -= 12; if (y - camPos.y < -4) y += 12;
      p.setXYZ(i, x, y, z);
    }
    p.needsUpdate = true;

    // tumbleweeds bounce along the street
    if (Math.random() < dt * 0.05 && this.tumbleweeds.length < 3) this.spawnTumbleweed();
    for (let i = this.tumbleweeds.length - 1; i >= 0; i--) {
      const t = this.tumbleweeds[i], u = t.userData;
      u.life -= dt;
      u.vy -= 9.8 * dt;
      t.position.x += u.vx * dt; t.position.y += u.vy * dt; t.position.z += u.vz * dt;
      if (t.position.y < u.r) { t.position.y = u.r; u.vy = 1.5 + Math.random() * 2.5; }
      t.rotation.z -= u.vx * dt / u.r; t.rotation.x += u.vz * dt / u.r;
      if (u.life <= 0 || Math.abs(t.position.x) > 66) {
        this.scene.remove(t);
        t.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        this.tumbleweeds.splice(i, 1);
      }
    }
  }

  clearDecals() { this.holes.clear(); this.blood.clear(); this.scorch.clear(); }
}

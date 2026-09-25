// Rendering pipeline: dawn lighting, procedural sky, fog, shadows, environment
// lighting, a separate first-person viewmodel pass and post-processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const SUN_DIR = new THREE.Vector3(0.78, 0.36, 0.5).normalize(); // low, east-south-east
export const FOG_COLOR = new THREE.Color(0x8d7658);

const QUALITY = {
  low: { dpr: 0.8, shadow: 1024, bloom: false, msaa: 0, fogBoost: 1.1 },
  medium: { dpr: 1.25, shadow: 2048, bloom: true, msaa: 0, fogBoost: 1.0 },
  high: { dpr: 2, shadow: 4096, bloom: true, msaa: 4, fogBoost: 1.0 },
};

export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.quality = quality;
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0105);
    scene.background = FOG_COLOR.clone();
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 900);
    this.camera.rotation.order = 'YXZ';
    scene.add(this.camera);

    // lights
    this.hemi = new THREE.HemisphereLight(0xc6ae88, 0x4a3a28, 1.05);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffc68a, 2.55);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -88; sc.right = 88; sc.top = 72; sc.bottom = -72; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.045;
    this.sun.position.copy(SUN_DIR).multiplyScalar(180);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);

    this.sky = createSky();
    scene.add(this.sky);
    this.mesas = createDistantMesas();
    scene.add(this.mesas);

    this.grade = {
      damage: 0, zombie: 0, flash: 0, flashColor: new THREE.Color(1, 1, 1), lowHp: 0, blur: 0,
    };
    this._buildComposer();
    this.setQuality(quality);
    this.resize();
  }

  _buildComposer() {
    const q = QUALITY[this.quality] || QUALITY.high;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: q.msaa });
    if (this.composer) this.composer.dispose();
    this.composer = new EffectComposer(this.renderer, rt);
    this.worldPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.worldPass);
    this.vmPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.vmPass.clear = false;
    this.vmPass.clearDepth = true;
    this.composer.addPass(this.vmPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.92);
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);
  }

  setViewModel(vm) {
    this.vm = vm;
    this.vmPass.scene = vm.scene;
    this.vmPass.camera = vm.camera;
  }

  setQuality(q) {
    this.quality = q;
    const cfg = QUALITY[q] || QUALITY.high;
    this.dynScale = this.dynScale || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.dpr) * this.dynScale);
    this.sun.shadow.mapSize.set(cfg.shadow, cfg.shadow);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this._buildComposer();
    if (this.vm) this.setViewModel(this.vm);
    this.resize();
  }

  // Bake an environment map from the sky for image-based lighting.
  bakeEnvironment() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky = createSky();
    sky.material.uniforms.uEnv.value = 1;
    envScene.add(sky);
    // warm ground bounce disc so the lower hemisphere is dusty brown
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 32), new THREE.MeshBasicMaterial({ color: 0x5a4632, side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -20;
    envScene.add(ground);
    const rt = pm.fromScene(envScene, 0.02);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();
  }

  // Adaptive resolution: call every frame with the real frame time (seconds).
  adapt(frameDt) {
    this._ft = this._ft === undefined ? frameDt : this._ft * 0.95 + frameDt * 0.05;
    this._adaptT = (this._adaptT || 0) + frameDt;
    if (this._adaptT < 2.5) return;
    this._adaptT = 0;
    const cfg = QUALITY[this.quality] || QUALITY.high;
    let s = this.dynScale;
    if (this._ft > 1 / 42 && s > 0.55) s = Math.max(0.55, s * 0.85);
    else if (this._ft < 1 / 58 && s < 1) s = Math.min(1, s * 1.1);
    if (Math.abs(s - this.dynScale) > 0.01) {
      this.dynScale = s;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cfg.dpr) * s);
      this.resize();
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    if (this.vm) this.vm.setAspect(w / h);
    this.gradePass.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(dt, time) {
    this.sky.position.copy(this.camera.position);
    this.sky.material.uniforms.uTime.value = time;
    this.mesas.position.set(this.camera.position.x, 0, this.camera.position.z);
    const u = this.gradePass.uniforms;
    const g = this.grade;
    u.uTime.value = time;
    u.uDamage.value = g.damage;
    u.uZombie.value = g.zombie;
    u.uFlash.value = g.flash;
    u.uFlashColor.value.copy(g.flashColor);
    u.uLowHp.value = g.lowHp;
    this.composer.render(dt);
  }
}

// ------------------------------------------------------------------------ sky
function createSky() {
  const geo = new THREE.SphereGeometry(800, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uTime: { value: 0 },
      uEnv: { value: 0 },
      uFog: { value: FOG_COLOR.clone() },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w * 0.99999;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun; uniform float uTime; uniform float uEnv; uniform vec3 uFog;
      varying vec3 vDir;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
      float fbm(vec3 p){ float s=0.0; float a=0.5; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.07; a*=0.5; } return s; }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        // gloomy dawn gradient: dusty amber horizon → heavy brownish-gray overcast
        vec3 horizon = vec3(0.86, 0.62, 0.36);
        vec3 low = vec3(0.62, 0.47, 0.32);
        vec3 zenith = vec3(0.24, 0.22, 0.21);
        vec3 col = mix(horizon, low, smoothstep(0.0, 0.12, h));
        col = mix(col, zenith, smoothstep(0.1, 0.75, h));
        float sd = max(dot(d, normalize(uSun)), 0.0);
        // sun glow through haze
        col += vec3(1.0, 0.62, 0.3) * pow(sd, 6.0) * 0.55;
        col += vec3(1.0, 0.8, 0.55) * pow(sd, 64.0) * 1.2;
        col += vec3(1.0, 0.9, 0.75) * smoothstep(0.9975, 0.9992, sd) * 6.0;
        // clouds: layered overcast drifting slowly
        if (h > -0.02) {
          vec2 uv = d.xz / (h + 0.18);
          float t = uTime * 0.004;
          float c = fbm(vec3(uv * 1.3 + vec2(t, t * 0.4), t * 0.5));
          float c2 = fbm(vec3(uv * 3.1 - vec2(t * 1.7, 0.0), 3.0));
          float cov = smoothstep(0.38, 0.78, c * 0.75 + c2 * 0.35);
          vec3 cloudLit = mix(vec3(0.34, 0.29, 0.25), vec3(0.95, 0.66, 0.4), pow(sd, 3.0) * 0.9 + 0.12);
          vec3 cloudDark = vec3(0.2, 0.18, 0.17);
          vec3 cc = mix(cloudLit, cloudDark, smoothstep(0.5, 1.0, c2));
          col = mix(col, cc, cov * smoothstep(-0.02, 0.18, h) * 0.85);
        }
        // below horizon fade into fog color
        col = mix(col, uFog * 1.05, smoothstep(0.06, -0.08, h));
        // haze band at the horizon
        col = mix(col, uFog * 1.15, exp(-abs(h) * 14.0) * 0.55);
        if (uEnv > 0.5) col *= 1.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// Far mesa silhouettes (beyond the canyon walls) for depth.
function createDistantMesas() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x7a5f45, fog: true });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.2;
    const r = 330 + rnd() * 140;
    const w = 40 + rnd() * 90, h = 25 + rnd() * 55;
    const geo = new THREE.CylinderGeometry(w * 0.72, w, h, 7, 1);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * r, h / 2 - 4, Math.sin(a) * r);
    m.rotation.y = rnd() * 3;
    group.add(m);
  }
  return group;
}

// --------------------------------------------------------------------- grade
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uDamage: { value: 0 },
    uZombie: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uLowHp: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes;
    uniform float uDamage; uniform float uZombie; uniform float uFlash; uniform vec3 uFlashColor; uniform float uLowHp;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      // subtle chromatic aberration toward the edges (+ on damage)
      float ca = 0.0012 + uDamage * 0.004;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;
      // warm, slightly crushed "dawn" grade
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 0.92);
      col = col * vec3(1.03, 1.0, 0.94);
      col = pow(col, vec3(1.04));
      // zombie vision: red-tinted, brighter shadows
      if (uZombie > 0.0) {
        vec3 zc = vec3(l * 1.25 + 0.05, l * 0.72, l * 0.62);
        col = mix(col, zc, uZombie * 0.32);
      }
      // low HP desaturation
      col = mix(col, vec3(l), uLowHp * 0.5);
      // vignette
      float vig = smoothstep(0.85, 0.2, r2 * 1.6);
      col *= mix(0.62, 1.0, vig);
      // damage red edges
      col = mix(col, vec3(0.55, 0.02, 0.0), uDamage * smoothstep(0.08, 0.42, r2) * 0.85);
      // flash (explosion / infection)
      col = mix(col, uFlashColor, uFlash);
      // film grain
      float gr = rand(uv * uRes + fract(uTime * 7.13)) - 0.5;
      col += gr * 0.035;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

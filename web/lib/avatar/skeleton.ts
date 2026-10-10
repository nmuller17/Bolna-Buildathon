// P2: Three.js "hologram" avatar: glowing capsule bones, sharp hands with fingertip trails, a thin-line face.
// Files are y-down (CLAUDE.md 6.2), the renderer flips y. One world unit = one shoulder width.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { THEME } from "./theme";
import type { Brows, Frame } from "./types";

export type AvatarState = {
  frame: Frame;
  brows: Brows;
  browAmount: number; // 0..1, ramps in and out around the sentence
  idle: number; // 0..1, breathing strength
};

const BLOOM_LAYER = 1;

// MediaPipe z is noisy: pose z reaches -5 at the wrists, so it gets a smaller factor than hands and face.
const POSE_Z = 0.1;
const POSE_Z_MAX = 0.45;
const HAND_Z = 0.3;
const HAND_Z_MAX = 0.15;
const HAND_FORWARD = 0.06; // keeps the hands in front of the chest
const FACE_Z = 0.3;
const FACE_Z_MAX = 0.06;
const HAND_FADE_PER_S = 6; // a missing hand fades out (or back in) over ~5 frames at 30 fps

const FOV = 30;
const LOOK_AT = new THREE.Vector3(0, -0.2, 0);
const FRAME_HALF_HEIGHT = 1.45; // head top to hips, with a margin
const FRAME_HALF_WIDTH = 1.55; // arms stretched to the side
const FADE_TOP = -0.5; // the torso fades out below the waist (hips are at y ≈ -1.35)
const FADE_BOTTOM = -1.3;
const NO_FADE = -100;
const FLOOR_Y = -1.9;

const MAX_PIXELS = 2.6e6; // render budget: a 4K guest monitor renders at a lower resolution instead of dropping frames
const INTRO_S = 1.5;
const BREATH_PERIOD_S = 4.2;
const BREATH_AMPLITUDE = 0.014;
const TRAIL_SAMPLE_S = 1 / 30;
const CURVE_STEPS = 4;

const BODY_BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
const BODY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24];
const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [9, 10], [10, 11], [11, 12], // middle
  [13, 14], [14, 15], [15, 16], // ring
  [0, 17], [17, 18], [18, 19], [19, 20], // pinky
  [5, 9], [9, 13], [13, 17], // palm
];
const TIPS = [4, 8, 12, 16, 20];

// Face points, in the CLAUDE.md 6.1 order.
const BROWS = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]; // right brow outer -> inner, left brow inner -> outer
const BROW_INNER_WEIGHT = [0.35, 0.5, 0.7, 0.9, 1, 1, 0.9, 0.7, 0.5, 0.35];
const EYES = [[10, 12, 11, 13], [14, 16, 15, 17]]; // corner, upper lid, corner, lower lid
const UPPER_LIDS = [12, 16];
const MOUTH = [[18, 20, 19, 21], [18, 22, 19, 23]]; // outer lips, inner lips
const NOSE = 24;
const CHIN = 25;

const HOLO_VERT = /* glsl */ `
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vWorldY;
void main() {
  vec4 local = vec4(position, 1.0);
  vec3 n = normal;
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
  n = mat3(instanceMatrix) * n;
#endif
  vec4 world = modelMatrix * local;
  vWorldY = world.y;
  vec4 mv = viewMatrix * world;
  vNormalView = normalize(mat3(viewMatrix) * mat3(modelMatrix) * n);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

// Solid core with a bright rim, faded below uFadeTop.
const HOLO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRim;
uniform float uOpacity;
uniform float uFadeTop;
uniform float uFadeBottom;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vWorldY;
void main() {
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  float rim = pow(1.0 - facing, 2.0);
  vec3 color = mix(uColor * (0.7 + 0.3 * facing), uRim, rim * 0.7);
  gl_FragColor = vec4(color, uOpacity * smoothstep(uFadeBottom, uFadeTop, vWorldY));
}`;

// See-through shell: almost invisible facing the camera, glowing at the silhouette.
const SHELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vNormalView;
varying vec3 vViewDir;
void main() {
  float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
  gl_FragColor = vec4(uColor, (0.05 + 0.75 * pow(1.0 - facing, 2.5)) * uOpacity);
}`;

const PARTICLE_VERT = /* glsl */ `
uniform float uSize;
uniform float uPixelRatio;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * uPixelRatio * (6.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  float a = smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5)) * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}`;

// Final image = scene + bloom of the bloom layer, with a light vignette.
const MIX_FRAG = /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
  float vignette = smoothstep(0.95, 0.35, length(vUv - 0.5) * 1.25);
  gl_FragColor = vec4(color.rgb * mix(0.8, 1.0, vignette), 1.0);
}`;

const clampAbs = (v: number, max: number) => Math.max(-max, Math.min(max, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function holoMaterial(color: number, rim: number, fadeTop: number, fadeBottom: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uRim: { value: new THREE.Color(rim) },
      uOpacity: { value: 1 },
      uFadeTop: { value: fadeTop },
      uFadeBottom: { value: fadeBottom },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
  });
}

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Instanced bones (open cylinders) and joints (spheres). Joints cover the cylinder ends, so they read as capsules. */
class Sticks {
  readonly bones: THREE.InstancedMesh;
  readonly joints: THREE.InstancedMesh;

  constructor(
    cylinder: THREE.BufferGeometry,
    sphere: THREE.BufferGeometry,
    material: THREE.Material,
    boneCount: number,
    jointCount: number,
    private boneRadius: number,
  ) {
    this.bones = new THREE.InstancedMesh(cylinder, material, boneCount);
    this.joints = new THREE.InstancedMesh(sphere, material, jointCount);
    for (const mesh of [this.bones, this.joints]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }

  bone(i: number, a: THREE.Vector3, b: THREE.Vector3, radius = this.boneRadius) {
    _d.subVectors(b, a);
    const length = _d.length();
    if (length < 1e-6) _m.makeScale(0, 0, 0);
    else _m.compose(a, _q.setFromUnitVectors(UP, _d.divideScalar(length)), _s.set(radius, length, radius));
    this.bones.setMatrixAt(i, _m);
  }

  joint(i: number, p: THREE.Vector3, radius: number) {
    this.joints.setMatrixAt(i, _m.compose(p, _q.identity(), _s.setScalar(radius)));
  }

  commit() {
    this.bones.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
  }

  set visible(value: boolean) {
    for (const mesh of [...this.meshes, ...this.twins]) mesh.visible = value;
  }

  get meshes() {
    return [this.bones, this.joints];
  }

  /** Same instances drawn with another material (they share the instance matrices), e.g. black in the bloom pass. */
  readonly twins: THREE.InstancedMesh[] = [];
  makeTwins(material: THREE.Material, layer: number) {
    for (const mesh of this.meshes) {
      const twin = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
      twin.instanceMatrix = mesh.instanceMatrix;
      twin.frustumCulled = false;
      twin.layers.set(layer);
      this.twins.push(twin);
    }
    return this.twins;
  }
}

/** Screen-space line segments (constant pixel width) whose buffers are rewritten in place every frame. */
class Strokes {
  readonly line: LineSegments2;
  readonly positions: Float32Array;
  readonly colors: Float32Array | null;

  constructor(segments: number, material: LineMaterial, withColors = false) {
    const geometry = new LineSegmentsGeometry();
    this.positions = new Float32Array(segments * 6);
    geometry.setPositions(this.positions); // keeps this array as its buffer
    this.colors = withColors ? new Float32Array(segments * 6) : null;
    if (this.colors) geometry.setColors(this.colors);
    this.line = new LineSegments2(geometry, material);
    this.line.frustumCulled = false;
  }

  commit() {
    const g = this.line.geometry;
    (g.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    if (this.colors) (g.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
  }
}

function catmullRom(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: Float32Array, o: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  out[o] = f(p0.x, p1.x, p2.x, p3.x);
  out[o + 1] = f(p0.y, p1.y, p2.y, p3.y);
  out[o + 2] = f(p0.z, p1.z, p2.z, p3.z);
}

/** Smooth curve through the points, written as CURVE_STEPS segments per span. Returns the next offset. */
function writeCurve(out: Float32Array, offset: number, pts: THREE.Vector3[], closed: boolean): number {
  const n = pts.length;
  const spans = closed ? n : n - 1;
  for (let s = 0; s < spans; s++) {
    const p0 = pts[closed ? (s + n - 1) % n : Math.max(s - 1, 0)];
    const p1 = pts[s];
    const p2 = pts[(s + 1) % n];
    const p3 = pts[closed ? (s + 2) % n : Math.min(s + 2, n - 1)];
    for (let k = 0; k < CURVE_STEPS; k++) {
      catmullRom(p0, p1, p2, p3, k / CURVE_STEPS, out, offset);
      catmullRom(p0, p1, p2, p3, (k + 1) / CURVE_STEPS, out, offset + 3);
      offset += 6;
    }
  }
  return offset;
}

const curveSegments = (curves: number[][], closed: boolean) =>
  curves.reduce((sum, c) => sum + (closed ? c.length : c.length - 1) * CURVE_STEPS, 0);

const points = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());

type HandState = {
  pts: THREE.Vector3[]; // world positions
  rel: THREE.Vector3[]; // last known shape relative to the wrist, used while the hand fades out
  hasShape: boolean;
  opacity: number;
  history: Float32Array; // fingertip trails, newest sample first, per tip
  times: Float32Array; // time of each trail sample
  resetTrail: boolean;
};

export class AvatarScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  // Hands and trails are drawn last, over the bloomed image, so the glow never blurs or tints them.
  private readonly overlay = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly observer: ResizeObserver;
  private readonly background = new THREE.Color(THEME.background);
  private readonly black = new THREE.Color(0x000000);
  private readonly blackMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private camDist = 6;

  private readonly basePose = points(33);
  private readonly pose = points(33);
  private readonly baseFace = points(26);
  private readonly face = points(26);
  private readonly hands: HandState[];

  private readonly bodyMaterial = holoMaterial(THEME.body.color, THEME.body.rim, FADE_TOP, FADE_BOTTOM);
  private readonly handMaterials = [0, 1].map(() => holoMaterial(THEME.hands.color, THEME.hands.rim, NO_FADE + 1, NO_FADE));
  private readonly body: Sticks;
  private readonly handSticks: Sticks[];

  private readonly headMaterial: THREE.ShaderMaterial;
  private readonly head: THREE.Mesh;
  private readonly nose: THREE.Mesh;
  private readonly browLines: Strokes;
  private readonly featureLines: Strokes;
  private readonly faceMaterials: LineMaterial[];
  private readonly browCurves: THREE.Vector3[][];
  private readonly eyeCurves: THREE.Vector3[][];
  private readonly mouthCurves: THREE.Vector3[][];

  private readonly trails: Strokes;
  private readonly trailColor = new THREE.Color(THEME.trail.color);
  private trailClock = 0;

  private readonly particles: THREE.Points;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleStart: Float32Array;
  private readonly particleTarget: Float32Array;
  private readonly particleDelay: Float32Array;
  private particlesReady = false;
  private startTime: number | null = null;

  constructor(private readonly container: HTMLElement) {
    // Throws when WebGL is unavailable; the player catches it and falls back to captions only.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.NoToneMapping;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    container.appendChild(canvas);

    this.scene.background = this.background;
    this.scene.fog = new THREE.Fog(THEME.background, 8, 20);

    const grid = new THREE.GridHelper(THEME.grid.size, THEME.grid.divisions, THEME.grid.centerColor, THEME.grid.color);
    grid.position.y = FLOOR_Y;
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = THEME.grid.opacity;
    gridMaterial.depthWrite = false;
    this.scene.add(grid);

    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0);
    const sphere = new THREE.SphereGeometry(1, 18, 12);

    // Body: 8 pose bones + neck + spine, 8 pose joints + neck base.
    this.body = new Sticks(cylinder, sphere, this.bodyMaterial, BODY_BONES.length + 2, BODY_JOINTS.length + 1, THEME.body.boneRadius);
    for (const mesh of this.body.meshes) {
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
    }

    // Hands live in the overlay; their black twins mask the body glow behind them in the bloom pass.
    this.handSticks = this.handMaterials.map((material) => {
      const sticks = new Sticks(cylinder, sphere, material, HAND_BONES.length, 21, THEME.hands.boneRadius);
      this.overlay.add(...sticks.meshes);
      this.scene.add(...sticks.makeTwins(this.blackMaterial, BLOOM_LAYER));
      sticks.visible = false;
      return sticks;
    });
    this.hands = [0, 1].map(() => ({
      pts: points(21),
      rel: points(21),
      hasShape: false,
      opacity: 0,
      history: new Float32Array(TIPS.length * THEME.trail.samples * 3),
      times: new Float32Array(THEME.trail.samples),
      resetTrail: true,
    }));

    this.headMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(THEME.head.color) }, uOpacity: { value: 1 } },
      vertexShader: HOLO_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), this.headMaterial);
    this.head.renderOrder = 1;
    this.scene.add(this.head);

    const lineMaterial = (color: number, linewidth: number) =>
      new LineMaterial({ color, linewidth, transparent: true, alphaToCoverage: true });
    this.faceMaterials = [lineMaterial(THEME.face.browColor, THEME.face.browWidth), lineMaterial(THEME.face.color, THEME.face.lineWidth)];
    this.browLines = new Strokes(curveSegments(BROWS, false), this.faceMaterials[0]);
    this.featureLines = new Strokes(curveSegments([...EYES, ...MOUTH], true), this.faceMaterials[1]);
    this.browCurves = BROWS.map((idx) => idx.map((i) => this.face[i]));
    this.eyeCurves = EYES.map((idx) => idx.map((i) => this.face[i]));
    this.mouthCurves = MOUTH.map((idx) => idx.map((i) => this.face[i]));
    this.nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 12, 8),
      new THREE.MeshBasicMaterial({ color: THEME.face.color, transparent: true }),
    );
    for (const obj of [this.browLines.line, this.featureLines.line, this.nose]) {
      obj.renderOrder = 3;
      this.scene.add(obj);
    }

    this.trails = new Strokes(
      2 * TIPS.length * (THEME.trail.samples - 1),
      new LineMaterial({
        linewidth: THEME.trail.width,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      true,
    );
    this.trails.line.renderOrder = 1;
    this.overlay.add(this.trails.line);

    const count = THEME.particles.count;
    this.particleStart = new Float32Array(count * 3);
    this.particleTarget = new Float32Array(count * 3);
    this.particleDelay = new Float32Array(count);
    this.particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(THEME.body.color) },
        uOpacity: { value: 1 },
        uSize: { value: THEME.particles.size },
        uPixelRatio: { value: 1 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.particles = new THREE.Points(particleGeometry, this.particleMaterial);
    this.particles.frustumCulled = false;
    this.particles.layers.enable(BLOOM_LAYER);
    this.scene.add(this.particles);

    // Post-processing: a bloom pass that only sees the bloom layer, mixed over the full (multisampled) scene.
    const size = new THREE.Vector2(1, 1);
    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomComposer.addPass(new UnrealBloomPass(size, THEME.bloom.strength, THEME.bloom.radius, THEME.bloom.threshold));

    const mixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: MIX_FRAG,
        depthTest: false,
        depthWrite: false,
      }),
      "baseTexture",
    );
    mixPass.needsSwap = true;
    const overlayPass = new RenderPass(this.overlay, this.camera);
    overlayPass.clear = false; // draw over the mixed image
    overlayPass.clearDepth = true; // hands only depth-test against themselves
    this.finalComposer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
    );
    this.finalComposer.addPass(new RenderPass(this.scene, this.camera));
    this.finalComposer.addPass(mixPass);
    this.finalComposer.addPass(overlayPass);
    this.finalComposer.addPass(new OutputPass());

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75, Math.sqrt(MAX_PIXELS / (w * h)));
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.finalComposer.setPixelRatio(pixelRatio);
    this.finalComposer.setSize(w, h);
    this.bloomComposer.setPixelRatio(pixelRatio * 0.5); // half-resolution bloom is plenty for a soft glow
    this.bloomComposer.setSize(w, h);
    this.particleMaterial.uniforms.uPixelRatio.value = pixelRatio;

    // Frame head to hips whatever the screen shape.
    this.camera.aspect = w / h;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.camDist = Math.max(FRAME_HALF_HEIGHT / tan, FRAME_HALF_WIDTH / (tan * this.camera.aspect));
    this.camera.updateProjectionMatrix();
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.camDist + 1.5;
    fog.far = this.camDist + 16;
  }

  update(state: AvatarState, time: number, dt: number) {
    this.startTime ??= time;
    const elapsed = time - this.startTime;
    const appear = smoothstep(INTRO_S - 0.5, INTRO_S + 0.1, elapsed);
    const { frame } = state;

    // Pose (z relative to the shoulders), then breathing: shoulders and head rise, arms follow less, hips stay.
    if (frame.pose && frame.pose.length >= 25) {
      const zs = (frame.pose[11][2] + frame.pose[12][2]) / 2;
      for (let i = 0; i < 33 && i < frame.pose.length; i++) {
        const [x, y, z] = frame.pose[i];
        this.basePose[i].set(x, -y, clampAbs(-(z - zs) * POSE_Z, POSE_Z_MAX));
      }
    }
    const breath = state.idle * BREATH_AMPLITUDE * Math.sin((2 * Math.PI * time) / BREATH_PERIOD_S);
    for (let i = 0; i < 33; i++) {
      const k = i <= 12 ? 1 : i <= 14 ? 0.6 : i <= 22 ? 0.4 : 0;
      this.pose[i].copy(this.basePose[i]).setY(this.basePose[i].y + breath * k);
    }

    this.updateHand(0, frame.lh, dt);
    this.updateHand(1, frame.rh, dt);
    this.updateFace(state, breath);
    this.updateBody();
    this.updateTrails(time, dt, appear);
    this.updateParticles(elapsed);

    this.bodyMaterial.uniforms.uOpacity.value = appear;
    this.headMaterial.uniforms.uOpacity.value = appear;
    for (const m of this.faceMaterials) m.opacity = appear;
    (this.nose.material as THREE.MeshBasicMaterial).opacity = appear;

    // Slow sway for depth, small enough not to disturb reading.
    const phase = 2 * Math.PI * time;
    this.camera.position.set(
      LOOK_AT.x + Math.sin(phase / 16) * 0.22,
      LOOK_AT.y + 0.28 + Math.sin(phase / 21) * 0.04,
      this.camDist,
    );
    this.camera.lookAt(LOOK_AT);
  }

  private updateHand(h: 0 | 1, data: Frame["lh"], dt: number) {
    const st = this.hands[h];
    const wrist = this.pose[h === 0 ? 15 : 16];
    if (data && data.length >= 21) {
      // Hand z is relative to its own wrist: hang it on the pose wrist.
      const wz = wrist.z + HAND_FORWARD;
      const z0 = data[0][2];
      for (let i = 0; i < 21; i++) {
        const [x, y, z] = data[i];
        st.pts[i].set(x, -y, wz + clampAbs(-(z - z0) * HAND_Z, HAND_Z_MAX));
      }
      for (let i = 0; i < 21; i++) st.rel[i].subVectors(st.pts[i], st.pts[0]);
      if (st.opacity === 0) st.resetTrail = true;
      st.hasShape = true;
      st.opacity = Math.min(1, st.opacity + dt * HAND_FADE_PER_S);
      wrist.copy(st.pts[0]); // the forearm ends where the hand starts
    } else {
      // Missing hand: keep its last shape on the pose wrist while it fades out.
      if (st.hasShape) {
        _d.copy(wrist).setZ(wrist.z + HAND_FORWARD);
        for (let i = 0; i < 21; i++) st.pts[i].addVectors(_d, st.rel[i]);
      }
      st.opacity = Math.max(0, st.opacity - dt * HAND_FADE_PER_S);
    }

    const sticks = this.handSticks[h];
    const visible = st.hasShape && st.opacity > 0;
    sticks.visible = visible;
    this.handMaterials[h].uniforms.uOpacity.value = st.opacity;
    if (!visible) return;
    HAND_BONES.forEach(([a, b], i) => sticks.bone(i, st.pts[a], st.pts[b]));
    for (let i = 0; i < 21; i++) {
      sticks.joint(i, st.pts[i], TIPS.includes(i) ? THEME.hands.tipRadius : THEME.hands.jointRadius);
    }
    sticks.commit();
  }

  private updateFace(state: AvatarState, breath: number) {
    const raw = state.frame.face;
    if (raw && raw.length >= 26) {
      const zn = raw[NOSE][2];
      for (let i = 0; i < 26; i++) {
        const [x, y, z] = raw[i];
        this.baseFace[i].set(x, -y, clampAbs(-(z - zn) * FACE_Z, FACE_Z_MAX));
      }
    }
    const f = this.face;
    for (let i = 0; i < 26; i++) f[i].copy(this.baseFace[i]).setY(this.baseFace[i].y + breath);

    // Head: an ellipsoid shell sized from the face, at shoulder depth. Face lines sit on its front.
    let browY = 0;
    for (let i = 0; i < 10; i++) browY += f[i].y / 10;
    const faceHeight = Math.max(browY - f[CHIN].y, 0.2);
    const eyeSpan = Math.abs(f[15].x - f[10].x);
    const ry = 0.74 * faceHeight;
    const rx = Math.max(0.82 * eyeSpan, 0.62 * ry);
    const rz = 0.9 * rx;
    const cx = (f[10].x + f[15].x) / 2;
    const cz = (this.pose[11].z + this.pose[12].z) / 2;
    this.head.position.set(cx, f[CHIN].y + 0.72 * faceHeight, cz);
    this.head.scale.set(rx, ry, rz);
    const front = cz + 0.92 * rz;
    for (const p of f) p.z += front;

    // Facial marker for the whole sentence: brows raised (yes/no question) or lowered and drawn together (wh-question).
    const amount = state.brows ? state.browAmount : 0;
    if (amount > 0) {
      const { raise, lower, squeeze, lid } = THEME.brows;
      for (let i = 0; i < 10; i++) {
        const w = BROW_INNER_WEIGHT[i];
        if (state.brows === "up") f[i].y += raise * faceHeight * amount;
        else {
          f[i].y -= lower * faceHeight * amount * (0.6 + 0.4 * w);
          f[i].x += Math.sign(cx - f[i].x) * squeeze * eyeSpan * amount * w;
        }
      }
      for (const i of UPPER_LIDS) f[i].y += (state.brows === "up" ? 1 : -1) * lid * faceHeight * amount;
    }

    let o = 0;
    for (const c of this.browCurves) o = writeCurve(this.browLines.positions, o, c, false);
    this.browLines.commit();
    o = 0;
    for (const c of [...this.eyeCurves, ...this.mouthCurves]) o = writeCurve(this.featureLines.positions, o, c, true);
    this.featureLines.commit();
    this.nose.position.copy(f[NOSE]);
  }

  private neckBase = new THREE.Vector3();
  private neckTop = new THREE.Vector3();
  private hipMid = new THREE.Vector3();

  private updateBody() {
    const p = this.pose;
    this.neckBase.addVectors(p[11], p[12]).multiplyScalar(0.5);
    this.neckTop.set(this.head.position.x, this.head.position.y - this.head.scale.y * 0.85, this.head.position.z);
    this.hipMid.addVectors(p[23], p[24]).multiplyScalar(0.5);

    const { boneRadius, jointRadius } = THEME.body;
    BODY_BONES.forEach(([a, b], i) => this.body.bone(i, p[a], p[b]));
    this.body.bone(BODY_BONES.length, this.neckBase, this.neckTop, boneRadius * 0.9);
    this.body.bone(BODY_BONES.length + 1, this.neckBase, this.hipMid, boneRadius * 0.6);
    BODY_JOINTS.forEach((j, i) => {
      // Wrist joints shrink when a hand is shown, so they never cover the palm.
      const hand = j === 15 ? this.hands[0] : j === 16 ? this.hands[1] : null;
      this.body.joint(i, p[j], jointRadius * (hand ? 1 - 0.5 * hand.opacity : 1));
    });
    this.body.joint(BODY_JOINTS.length, this.neckBase, jointRadius * 0.8);
    this.body.commit();
  }

  private updateTrails(time: number, dt: number, appear: number) {
    const n = THEME.trail.samples;
    const life = n * TRAIL_SAMPLE_S;
    this.trailClock += dt;
    const sample = this.trailClock >= TRAIL_SAMPLE_S;
    if (sample) this.trailClock %= TRAIL_SAMPLE_S;

    const pos = this.trails.positions;
    const col = this.trails.colors!;
    const c = this.trailColor;
    let o = 0;
    for (const st of this.hands) {
      const strength = st.hasShape ? st.opacity * appear : 0;
      const times = st.times;
      if (st.resetTrail) times.fill(time);
      else if (sample) {
        times.copyWithin(1, 0, n - 1);
        times[0] = time;
      }
      // Fade by age, not by rank: at a low frame rate old samples vanish instead of drawing long streaks.
      const fade = (k: number) => strength * Math.pow(Math.max(0, 1 - (time - times[k]) / life), 1.5);
      TIPS.forEach((tipIndex, t) => {
        const tip = st.pts[tipIndex];
        const hist = st.history;
        const base = t * n * 3;
        if (st.resetTrail) {
          for (let k = 0; k < n; k++) hist.set([tip.x, tip.y, tip.z], base + k * 3);
        } else if (sample) {
          hist.copyWithin(base + 3, base, base + (n - 1) * 3);
          hist.set([tip.x, tip.y, tip.z], base);
        }
        // Live tip, then older samples, fading to black (additive blending makes black invisible).
        for (let k = 0; k < n - 1; k++) {
          const a = k === 0 ? null : base + (k - 1) * 3;
          const b = base + k * 3;
          pos[o] = a === null ? tip.x : hist[a];
          pos[o + 1] = a === null ? tip.y : hist[a + 1];
          pos[o + 2] = a === null ? tip.z : hist[a + 2];
          pos[o + 3] = hist[b];
          pos[o + 4] = hist[b + 1];
          pos[o + 5] = hist[b + 2];
          const fa = k === 0 ? strength : fade(k - 1);
          const fb = fade(k);
          col[o] = c.r * fa;
          col[o + 1] = c.g * fa;
          col[o + 2] = c.b * fa;
          col[o + 3] = c.r * fb;
          col[o + 4] = c.g * fb;
          col[o + 5] = c.b * fb;
          o += 6;
        }
      });
      st.resetTrail = false;
    }
    this.trails.commit();
    this.trails.line.visible = this.hands.some((st) => st.opacity > 0);
  }

  /** Intro: particles fly in and gather on the skeleton, then hand over to the body. */
  private updateParticles(elapsed: number) {
    if (!this.particles.visible) return;
    if (elapsed > INTRO_S + 0.6) {
      this.particles.visible = false;
      return;
    }
    if (!this.particlesReady) this.initParticles();

    const out = (this.particles.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    const start = this.particleStart;
    const target = this.particleTarget;
    for (let i = 0; i < this.particleDelay.length; i++) {
      const p = Math.min(1, Math.max(0, (elapsed - this.particleDelay[i]) / (INTRO_S - 0.4)));
      const rest = Math.pow(1 - p, 3); // ease-out cubic
      const angle = rest * 1.8; // swirl around the vertical axis on the way in
      const sx = start[i * 3] - LOOK_AT.x;
      const sz = start[i * 3 + 2];
      const x = LOOK_AT.x + sx * Math.cos(angle) - sz * Math.sin(angle);
      const z = sx * Math.sin(angle) + sz * Math.cos(angle);
      out[i * 3] = target[i * 3] + (x - target[i * 3]) * rest;
      out[i * 3 + 1] = target[i * 3 + 1] + (start[i * 3 + 1] - target[i * 3 + 1]) * rest;
      out[i * 3 + 2] = target[i * 3 + 2] + (z - target[i * 3 + 2]) * rest;
    }
    this.particles.geometry.getAttribute("position").needsUpdate = true;
    this.particleMaterial.uniforms.uOpacity.value = 1 - smoothstep(INTRO_S - 0.15, INTRO_S + 0.5, elapsed);
  }

  private initParticles() {
    this.particlesReady = true;
    const p = this.pose;
    const segments: [THREE.Vector3, THREE.Vector3][] = BODY_BONES.map(([a, b]) => [p[a], p[b]]);
    segments.push([this.neckBase, this.neckTop], [this.neckBase, this.hipMid]);
    // Head outline as a 24-sided ellipse.
    const ring = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return new THREE.Vector3(
        this.head.position.x + Math.cos(a) * this.head.scale.x,
        this.head.position.y + Math.sin(a) * this.head.scale.y,
        this.head.position.z,
      );
    });
    ring.forEach((v, i) => segments.push([v, ring[(i + 1) % ring.length]]));

    const lengths = segments.map(([a, b]) => a.distanceTo(b));
    const total = lengths.reduce((s, l) => s + l, 0);
    const v = new THREE.Vector3();
    for (let i = 0; i < this.particleDelay.length; i++) {
      let u = Math.random() * total;
      let s = 0;
      while (s < segments.length - 1 && u > lengths[s]) u -= lengths[s++];
      v.lerpVectors(segments[s][0], segments[s][1], lengths[s] > 0 ? u / lengths[s] : 0);
      const j = () => (Math.random() - 0.5) * 0.05;
      this.particleTarget.set([v.x + j(), v.y + j(), v.z + j()], i * 3);

      const dir = new THREE.Vector3().randomDirection().multiplyScalar(2.5 + Math.random() * 2);
      this.particleStart.set([LOOK_AT.x + dir.x, LOOK_AT.y + dir.y, LOOK_AT.z + dir.z], i * 3);
      this.particleDelay[i] = Math.random() * 0.4;
    }
  }

  render() {
    // 1. Bloom of the bloom layer only (body, particles, black hand twins).
    this.camera.layers.set(BLOOM_LAYER);
    this.scene.background = this.black;
    this.bloomComposer.render();
    // 2. Scene + bloom, then the hands and trails on top.
    this.camera.layers.set(0);
    this.scene.background = this.background;
    this.finalComposer.render();
  }

  dispose() {
    this.observer.disconnect();
    for (const root of [this.scene, this.overlay]) {
      root.traverse((obj) => {
        const { geometry, material } = obj as THREE.Mesh;
        geometry?.dispose();
        for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
      });
    }
    this.blackMaterial.dispose();
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

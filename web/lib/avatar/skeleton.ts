// P2: the avatar scene: camera, background, landmarks -> world solver, face strokes, fingertip trails, intro particles.
// The body itself is drawn by a Rig: "hologram" (hologram.ts) or "concierge", Sam the receptionist (concierge.ts).
// Files are y-down (CLAUDE.md 6.2), the renderer flips y. One world unit = one shoulder width.
// Nothing is allocated per frame: all vectors and buffers below are reused.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ConciergeRig } from "./concierge";
import { HologramRig } from "./hologram";
import {
  BLOOM_LAYER,
  BODY_BONES,
  BROWS,
  BROW_INNER_WEIGHT,
  CHIN,
  EYES,
  FOV,
  MOUTH,
  NOSE,
  TIPS,
  UPPER_LIDS,
  curveSegments,
  smoothstep,
  writeCurve,
  type HandPose,
  type Rig,
  type WorldPose,
} from "./rig";
import { THEME } from "./theme";
import type { AvatarStyle, Brows, Frame } from "./types";

export type AvatarState = {
  frame: Frame;
  brows: Brows;
  browAmount: number; // 0..1, ramps in and out around the sentence
  idle: number; // 0..1, breathing strength
};

// MediaPipe z is noisy: pose z reaches -5 at the wrists, so it gets a smaller factor than hands and face.
const POSE_Z = 0.1;
const POSE_Z_MAX = 0.45;
const HAND_Z = 0.3;
const HAND_Z_MAX = 0.15;
const HAND_FORWARD = 0.06; // keeps the hands in front of the chest
const FACE_Z = 0.3;
const FACE_Z_MAX = 0.06;
const HAND_FADE_PER_S = 6; // a missing hand fades out (or back in) over ~5 frames at 30 fps

const LOOK_AT = new THREE.Vector3(0, -0.2, 0);
const FRAME_HALF_HEIGHT = 1.45; // head top to hips, with a margin
const FRAME_HALF_WIDTH = 1.55; // arms stretched to the side
const FLOOR_Y = -1.9;
const MAX_PIXELS = 2.6e6; // render budget: a 4K guest monitor renders at a lower resolution instead of dropping frames

const INTRO_S = 1.5;
const BREATH_PERIOD_S = 4.2;
const BREATH_AMPLITUDE = 0.014;
const TRAIL_SAMPLE_S = 1 / 30;

// Head orientation from the face points (radians, clamped so a noisy frame never twists the head).
const NEUTRAL_NOSE_DROP = 0.33; // nose position between the eye line (0) and the chin (1) when facing the camera
const MAX_YAW = 0.45;
const MAX_PITCH = 0.25;

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

// Hologram final image = scene + bloom of the bloom layer.
const MIX_FRAG = /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(baseTexture, vUv).rgb + texture2D(bloomTexture, vUv).rgb, 1.0);
}`;

// Light vignette over the canvas, in CSS so it costs no GPU pass (same curve as the former shader version).
const VIGNETTE_CSS =
  "position:absolute;inset:0;pointer-events:none;" +
  "background:radial-gradient(ellipse farthest-corner at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.19) 100%)";

const clampAbs = (v: number, max: number) => Math.max(-max, Math.min(max, v));

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

/** One kind of face line (brows, eyes, lips...): smooth curves through face points, one color and width. */
type FaceStroke = { strokes: Strokes; material: LineMaterial; curves: THREE.Vector3[][]; closed: boolean };

const points = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());

type HandState = HandPose & {
  rel: THREE.Vector3[]; // last known shape relative to the wrist, used while the hand fades out
  history: Float32Array; // fingertip trails, newest sample first, per tip
  times: Float32Array; // time of each trail sample
  resetTrail: boolean;
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "ZYX");

export class AvatarScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  // Hands and trails are drawn last, over everything else, so nothing can hide or blur them.
  private readonly overlay = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly mixMaterial: THREE.ShaderMaterial;
  private readonly observer: ResizeObserver;
  private readonly vignette: HTMLDivElement;
  private readonly background = new THREE.Color(THEME.background);
  private readonly black = new THREE.Color(0x000000);
  private camDist = 6;

  private readonly rigs: Record<AvatarStyle, Rig>;
  private rig: Rig;

  // Solver state.
  private readonly basePose = points(33);
  private readonly baseFace = points(26);
  private readonly hands: HandState[];
  private readonly world: WorldPose;

  // Brows, eyes, outer lips, mouth opening.
  private readonly faceStrokes: FaceStroke[];

  private readonly trails: Strokes;
  private readonly trailMaterial: LineMaterial;
  private readonly trailColor = new THREE.Color();
  private trailClock = 0;

  private readonly particles: THREE.Points;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleStart: Float32Array;
  private readonly particleTarget: Float32Array;
  private readonly particleDelay: Float32Array;
  private particlesReady = false;
  private startTime: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    style: AvatarStyle,
  ) {
    // Throws when WebGL is unavailable; the player catches it and falls back to captions only.
    // antialias: the toon style renders straight to the canvas; the hologram uses its own multisampled targets.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.NoToneMapping;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    this.vignette = document.createElement("div");
    this.vignette.style.cssText = VIGNETTE_CSS;
    container.append(canvas, this.vignette);

    this.scene.background = this.background;
    this.scene.fog = new THREE.Fog(THEME.background, 8, 20);
    const grid = new THREE.GridHelper(THEME.grid.size, THEME.grid.divisions, THEME.grid.centerColor, THEME.grid.color);
    grid.position.y = FLOOR_Y;
    const gridMaterial = grid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = THEME.grid.opacity;
    gridMaterial.depthWrite = false;
    this.scene.add(grid);

    // Lights for the toon style (the hologram shaders ignore them): soft key from the front, a bit high, plus ambience.
    const { light } = THEME.concierge;
    for (const target of [this.scene, this.overlay]) {
      const key = new THREE.DirectionalLight(0xffffff, light.key);
      key.position.set(1.2, 2.6, 6);
      key.target.position.copy(LOOK_AT);
      target.add(key, key.target, new THREE.HemisphereLight(light.sky, light.ground, light.ambient));
    }

    this.world = {
      pose: points(33),
      hands: [],
      face: points(26),
      head: { center: new THREE.Vector3(), radii: new THREE.Vector3(1, 1, 1), rotation: new THREE.Quaternion() },
      neckBase: new THREE.Vector3(),
      neckTop: new THREE.Vector3(),
      hipMid: new THREE.Vector3(),
      appear: 0,
    };
    this.hands = [0, 1].map(() => ({
      pts: points(21),
      rel: points(21),
      hasShape: false,
      opacity: 0,
      history: new Float32Array(TIPS.length * THEME.trail.samples * 3),
      times: new Float32Array(THEME.trail.samples),
      resetTrail: true,
    }));
    this.world.hands = this.hands;

    this.rigs = { hologram: new HologramRig(), concierge: new ConciergeRig() };
    for (const rig of Object.values(this.rigs)) {
      this.scene.add(rig.root);
      this.overlay.add(rig.overlay);
    }

    const faceStroke = (curves: number[][], closed: boolean): FaceStroke => {
      const material = new LineMaterial({ linewidth: 2, transparent: true });
      const strokes = new Strokes(curveSegments(curves, closed), material);
      strokes.line.renderOrder = 4; // over the head, eye whites and pupils
      this.scene.add(strokes.line);
      return { strokes, material, closed, curves: curves.map((idx) => idx.map((i) => this.world.face[i])) };
    };
    this.faceStrokes = [faceStroke(BROWS, false), faceStroke(EYES, true), faceStroke([MOUTH[0]], true), faceStroke([MOUTH[1]], true)];

    this.trailMaterial = new LineMaterial({
      linewidth: THEME.trail.width,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trails = new Strokes(2 * TIPS.length * (THEME.trail.samples - 1), this.trailMaterial, true);
    this.trails.line.renderOrder = 10;
    this.overlay.add(this.trails.line);

    const count = THEME.particles.count;
    this.particleStart = new Float32Array(count * 3);
    this.particleTarget = new Float32Array(count * 3);
    this.particleDelay = new Float32Array(count);
    this.particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
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

    // Post-processing: a bloom pass that only sees the bloom layer (hologram), mixed over the multisampled scene,
    // then the overlay (hands, trails) on top.
    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomComposer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), THEME.bloom.strength, THEME.bloom.radius, THEME.bloom.threshold));

    this.mixMaterial = new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
      },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: MIX_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const mixPass = new ShaderPass(this.mixMaterial, "baseTexture");
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

    this.rig = this.rigs[style];
    this.setStyle(style);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  setStyle(style: AvatarStyle) {
    this.rig = this.rigs[style] ?? this.rigs.concierge;
    for (const rig of Object.values(this.rigs)) {
      rig.root.visible = rig === this.rig;
      rig.overlay.visible = rig === this.rig;
    }
    const { look } = this.rig;
    const [brows, eyes, lips, mouth] = this.faceStrokes;
    brows.material.color.set(look.browColor);
    brows.material.linewidth = look.browWidth;
    for (const s of [eyes, mouth]) {
      s.material.color.set(look.faceColor);
      s.material.linewidth = look.lineWidth;
    }
    lips.material.color.set(look.lipColor);
    lips.material.linewidth = look.lipWidth;
    this.trailColor.set(look.trailColor);
    this.trailMaterial.linewidth = look.trailWidth;
    this.particleMaterial.uniforms.uColor.value.set(look.particleColor);
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
    for (const rig of Object.values(this.rigs)) rig.resize(h);

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
    const world = this.world;
    world.appear = smoothstep(INTRO_S - 0.5, INTRO_S + 0.1, elapsed);
    const { frame } = state;

    // Pose (z relative to the shoulders), then breathing: shoulders and head rise, arms follow less, hips stay.
    if (frame.pose && frame.pose.length >= 25) {
      const zs = (frame.pose[11][2] + frame.pose[12][2]) / 2;
      for (let i = 0; i < 33 && i < frame.pose.length; i++) {
        const p = frame.pose[i];
        this.basePose[i].set(p[0], -p[1], clampAbs(-(p[2] - zs) * POSE_Z, POSE_Z_MAX));
      }
    }
    const breath = state.idle * BREATH_AMPLITUDE * Math.sin((2 * Math.PI * time) / BREATH_PERIOD_S);
    for (let i = 0; i < 33; i++) {
      const k = i <= 12 ? 1 : i <= 14 ? 0.6 : i <= 22 ? 0.4 : 0;
      world.pose[i].copy(this.basePose[i]).setY(this.basePose[i].y + breath * k);
    }

    this.solveHand(0, frame.lh, dt);
    this.solveHand(1, frame.rh, dt);
    this.solveFace(state, breath);
    world.neckBase.addVectors(world.pose[11], world.pose[12]).multiplyScalar(0.5);
    world.hipMid.addVectors(world.pose[23], world.pose[24]).multiplyScalar(0.5);
    const { center, radii } = world.head;
    world.neckTop.set(center.x, center.y - radii.y * 0.85, center.z);

    this.rig.update(world);
    this.updateStrokes(world.appear);
    this.updateTrails(time, dt, world.appear);
    this.updateParticles(elapsed);

    // Slow sway for depth, small enough not to disturb reading.
    const phase = 2 * Math.PI * time;
    this.camera.position.set(
      LOOK_AT.x + Math.sin(phase / 16) * 0.22,
      LOOK_AT.y + 0.28 + Math.sin(phase / 21) * 0.04,
      this.camDist,
    );
    this.camera.lookAt(LOOK_AT);
  }

  private solveHand(h: 0 | 1, data: Frame["lh"], dt: number) {
    const st = this.hands[h];
    const wrist = this.world.pose[h === 0 ? 15 : 16];
    if (data && data.length >= 21) {
      // Hand z is relative to its own wrist: hang it on the pose wrist.
      const wz = wrist.z + HAND_FORWARD;
      const z0 = data[0][2];
      for (let i = 0; i < 21; i++) {
        const p = data[i];
        st.pts[i].set(p[0], -p[1], wz + clampAbs(-(p[2] - z0) * HAND_Z, HAND_Z_MAX));
      }
      for (let i = 0; i < 21; i++) st.rel[i].subVectors(st.pts[i], st.pts[0]);
      if (st.opacity === 0) st.resetTrail = true;
      st.hasShape = true;
      st.opacity = Math.min(1, st.opacity + dt * HAND_FADE_PER_S);
      wrist.copy(st.pts[0]); // the forearm ends where the hand starts
    } else {
      // Missing hand: keep its last shape on the pose wrist while it fades out.
      if (st.hasShape) {
        _v.copy(wrist).setZ(wrist.z + HAND_FORWARD);
        for (let i = 0; i < 21; i++) st.pts[i].addVectors(_v, st.rel[i]);
      }
      st.opacity = Math.max(0, st.opacity - dt * HAND_FADE_PER_S);
    }
  }

  private solveFace(state: AvatarState, breath: number) {
    const raw = state.frame.face;
    if (raw && raw.length >= 26) {
      const zn = raw[NOSE][2];
      for (let i = 0; i < 26; i++) {
        const p = raw[i];
        this.baseFace[i].set(p[0], -p[1], clampAbs(-(p[2] - zn) * FACE_Z, FACE_Z_MAX));
      }
    }
    const f = this.world.face;
    for (let i = 0; i < 26; i++) f[i].copy(this.baseFace[i]).setY(this.baseFace[i].y + breath);

    // Head: an ellipsoid sized from the face, at shoulder depth, turned like the face.
    let browY = 0;
    for (let i = 0; i < 10; i++) browY += f[i].y / 10;
    const faceHeight = Math.max(browY - f[CHIN].y, 0.2);
    const eyeSpan = Math.max(Math.abs(f[15].x - f[10].x), 0.05);
    const ry = 0.74 * faceHeight;
    const rx = Math.max(0.82 * eyeSpan, 0.62 * ry);
    const rz = 0.9 * rx;
    const cx = (f[10].x + f[15].x) / 2;
    const cz = (this.world.pose[11].z + this.world.pose[12].z) / 2;
    const { head } = this.world;
    head.center.set(cx, f[CHIN].y + 0.72 * faceHeight, cz);
    head.radii.set(rx, ry, rz);

    // Roll from the eye line, yaw from the nose offset, pitch from the nose height between eyes and chin.
    _v.addVectors(f[10], f[15]).multiplyScalar(0.5); // eye midpoint
    const roll = Math.atan2(f[15].y - f[10].y, f[15].x - f[10].x);
    const yaw = clampAbs(((f[NOSE].x - _v.x) / (eyeSpan / 2)) * 0.8, MAX_YAW);
    const noseDrop = (_v.y - f[NOSE].y) / Math.max(_v.y - f[CHIN].y, 1e-3);
    const pitch = clampAbs((noseDrop - NEUTRAL_NOSE_DROP) * 1.6, MAX_PITCH);
    head.rotation.setFromEuler(_euler.set(pitch, yaw, roll, "ZYX"));

    const front = cz + this.rig.faceFront(head.radii);
    for (let i = 0; i < 26; i++) f[i].z += front;

    // Facial marker for the whole sentence: brows raised (yes/no question) or lowered and drawn together (wh-question).
    const amount = state.brows ? state.browAmount : 0;
    if (amount > 0) {
      const { raise, lower, squeeze, lid } = THEME.brows;
      for (let i = 0; i < 10; i++) {
        const w = BROW_INNER_WEIGHT[i];
        // Raised brows lift a bit more at the inner ends (an open, questioning look, not a frown).
        if (state.brows === "up") f[i].y += raise * faceHeight * amount * (0.75 + 0.35 * w);
        else {
          f[i].y -= lower * faceHeight * amount * (0.6 + 0.4 * w);
          f[i].x += Math.sign(cx - f[i].x) * squeeze * eyeSpan * amount * w;
        }
      }
      for (const i of UPPER_LIDS) f[i].y += (state.brows === "up" ? 1 : -1) * lid * faceHeight * amount;
    }
  }

  private updateStrokes(appear: number) {
    for (const s of this.faceStrokes) {
      let o = 0;
      for (const c of s.curves) o = writeCurve(s.strokes.positions, o, c, s.closed);
      s.strokes.commit();
      s.material.opacity = appear;
    }
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
      const strength = st.hasShape ? st.opacity * appear * this.rig.look.trailStrength : 0;
      const times = st.times;
      if (st.resetTrail) times.fill(time);
      else if (sample) {
        times.copyWithin(1, 0, n - 1);
        times[0] = time;
      }
      for (let t = 0; t < TIPS.length; t++) {
        const tip = st.pts[TIPS[t]];
        const hist = st.history;
        const base = t * n * 3;
        if (st.resetTrail || sample) {
          if (st.resetTrail) {
            for (let k = 0; k < n; k++) {
              hist[base + k * 3] = tip.x;
              hist[base + k * 3 + 1] = tip.y;
              hist[base + k * 3 + 2] = tip.z;
            }
          } else hist.copyWithin(base + 3, base, base + (n - 1) * 3);
          hist[base] = tip.x;
          hist[base + 1] = tip.y;
          hist[base + 2] = tip.z;
        }
        // Live tip, then older samples, fading to black (additive blending makes black invisible).
        // Faded by age, not rank: at a low frame rate old samples vanish instead of drawing long streaks.
        for (let k = 0; k < n - 1; k++) {
          const b = base + k * 3;
          if (k === 0) {
            pos[o] = tip.x;
            pos[o + 1] = tip.y;
            pos[o + 2] = tip.z;
          } else {
            pos[o] = hist[b - 3];
            pos[o + 1] = hist[b - 2];
            pos[o + 2] = hist[b - 1];
          }
          pos[o + 3] = hist[b];
          pos[o + 4] = hist[b + 1];
          pos[o + 5] = hist[b + 2];
          const fb = strength * Math.pow(Math.max(0, 1 - (time - times[k]) / life), 1.5);
          // A segment that ends on an expired sample is dropped whole (no long streak when frames are slow).
          const fa = fb <= 0 ? 0 : k === 0 ? strength : strength * Math.pow(Math.max(0, 1 - (time - times[k - 1]) / life), 1.5);
          col[o] = c.r * fa;
          col[o + 1] = c.g * fa;
          col[o + 2] = c.b * fa;
          col[o + 3] = c.r * fb;
          col[o + 4] = c.g * fb;
          col[o + 5] = c.b * fb;
          o += 6;
        }
      }
      st.resetTrail = false;
    }
    this.trails.commit();
    this.trails.line.visible = this.hands[0].opacity > 0 || this.hands[1].opacity > 0;
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
    const { pose, neckBase, neckTop, hipMid, head } = this.world;
    const segments: [THREE.Vector3, THREE.Vector3][] = BODY_BONES.map(([a, b]) => [pose[a].clone(), pose[b].clone()]);
    segments.push([neckBase.clone(), neckTop.clone()], [neckBase.clone(), hipMid.clone()]);
    // Head outline as a 24-sided ellipse.
    const ring = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return new THREE.Vector3(head.center.x + Math.cos(a) * head.radii.x, head.center.y + Math.sin(a) * head.radii.y, head.center.z);
    });
    ring.forEach((v, i) => segments.push([v, ring[(i + 1) % ring.length]]));

    const lengths = segments.map(([a, b]) => a.distanceTo(b));
    const total = lengths.reduce((s, l) => s + l, 0);
    for (let i = 0; i < this.particleDelay.length; i++) {
      let u = Math.random() * total;
      let s = 0;
      while (s < segments.length - 1 && u > lengths[s]) u -= lengths[s++];
      _v.lerpVectors(segments[s][0], segments[s][1], lengths[s] > 0 ? u / lengths[s] : 0);
      const j = () => (Math.random() - 0.5) * 0.05;
      this.particleTarget.set([_v.x + j(), _v.y + j(), _v.z + j()], i * 3);
      _w.randomDirection().multiplyScalar(2.5 + Math.random() * 2).add(LOOK_AT);
      this.particleStart.set([_w.x, _w.y, _w.z], i * 3);
      this.particleDelay[i] = Math.random() * 0.4;
    }
  }

  render() {
    if (!this.rig.bloom) {
      // Toon style: no post-processing. Scene straight to the multisampled canvas, then hands and trails on top.
      const r = this.renderer;
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlay, this.camera);
      r.autoClear = true;
      return;
    }
    // Hologram: 1. bloom of the bloom layer only (body, particles, black hand masks).
    this.camera.layers.set(BLOOM_LAYER);
    this.scene.background = this.black;
    this.bloomComposer.render();
    this.camera.layers.set(0);
    this.scene.background = this.background;
    // 2. Scene + bloom, then the hands and trails on top.
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
    for (const rig of Object.values(this.rigs)) rig.dispose();
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.vignette.remove();
  }
}

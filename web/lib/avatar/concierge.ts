// P2: the "concierge" style: Sam, the ConversAI hotel receptionist (an original character), soft 3D cartoon.
// Built only from Three.js geometry and dressed on the landmark skeleton every frame: all motion comes from the landmarks.
// Cartoon proportions: a big head resting on the shoulders. The face points turn it and drive the features
// (eyes, brows, mouth), which are laid out on the front of the head. Arms and fingers are continuous smooth tubes.
// Nothing is allocated per frame: every buffer and vector below is reused.
import * as THREE from "three";
import { REST_FRAME } from "./rest";
import {
  BROWS,
  CURVE_STEPS,
  EYES,
  FADE_BOTTOM,
  FADE_TOP,
  FOV,
  NO_FADE,
  catmullRom,
  smoothstep,
  writeCurve,
  type Rig,
  type RigLook,
  type WorldPose,
} from "./rig";
import { THEME } from "./theme";

const C = THEME.concierge;
const S = C.sizes;
const F = C.face;

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;
const rgba = (hex: number, a: number) => `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${a})`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FRONT = new THREE.Vector3(0, 0, 1);

// ---- Materials: soft toon with a waist fade and a rim band, inverted-hull outlines -------------------------------

type Shader = Parameters<THREE.Material["onBeforeCompile"]>[0];
type Fade = { top: number; bottom: number };
const WAIST: Fade = { top: FADE_TOP, bottom: FADE_BOTTOM };
const NEVER: Fade = { top: NO_FADE + 1, bottom: NO_FADE };

const FADE_VERTEX = /* glsl */ `
  vec4 fadeWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  fadeWorld = instanceMatrix * fadeWorld;
#endif
  vFadeY = (modelMatrix * fadeWorld).y;`;

// Inverted hull: back faces pushed out along the normal, by a constant size on screen.
const OUTLINE_VERTEX = /* glsl */ `
  vec3 hullNormal = normal;
#ifdef USE_INSTANCING
  hullNormal = mat3(instanceMatrix) * hullNormal;
#endif
  mvPosition.xyz += normalize(normalMatrix * hullNormal) * uOutline * -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;`;

// Rim light: a soft cool glow on the silhouette, to detach Sam from the dark background.
const RIM_FRAGMENT = /* glsl */ `
  float rimBand = smoothstep(0.45, 0.95, 1.0 - abs(dot(normalize(normal), normalize(vViewPosition))));
  outgoingLight += uRimColor * rimBand * uRimStrength;`;

const RIM_COLOR = { value: new THREE.Color(C.rim.color) };
const RIM_STRENGTH = { value: C.rim.strength };

function patchFade(shader: Shader, fade: Fade) {
  shader.uniforms.uFadeTop = { value: fade.top };
  shader.uniforms.uFadeBottom = { value: fade.bottom };
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying float vFadeY;")
    .replace("#include <project_vertex>", `#include <project_vertex>\n${FADE_VERTEX}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nuniform float uFadeTop;\nuniform float uFadeBottom;\nvarying float vFadeY;")
    .replace("#include <dithering_fragment>", "#include <dithering_fragment>\ngl_FragColor.a *= smoothstep(uFadeBottom, uFadeTop, vFadeY);");
}

function toonMaterial(color: number, gradient: THREE.Texture, fade: Fade, extra: THREE.MeshToonMaterialParameters = {}) {
  const material = new THREE.MeshToonMaterial({ color, gradientMap: gradient, transparent: true, ...extra });
  material.onBeforeCompile = (shader) => {
    patchFade(shader, fade);
    shader.uniforms.uRimColor = RIM_COLOR;
    shader.uniforms.uRimStrength = RIM_STRENGTH;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;")
      .replace("#include <opaque_fragment>", `${RIM_FRAGMENT}\n#include <opaque_fragment>`);
  };
  return material;
}

function outlineMaterial(thickness: { value: number }, fade: Fade) {
  const material = new THREE.MeshBasicMaterial({ color: C.outline, side: THREE.BackSide, transparent: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = thickness;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uOutline;")
      .replace("#include <project_vertex>", `#include <project_vertex>\n${OUTLINE_VERTEX}`);
    patchFade(shader, fade);
  };
  return material;
}

/** Soft shading: a few tones read with linear filtering, so light wraps smoothly instead of in hard bands. */
function gradientMap() {
  const tones = new Uint8Array(C.toneSteps);
  const texture = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// ---- Torso: a soft barrel between the shoulders and the hips ------------------------------------------------------
// Local frame: x across the shoulders (unit: shoulder width), y up the spine (unit: shoulder-to-hip length), z forward.
// t runs from the top of the torso (0) to below the hips (1).

const TORSO_TOP = 0.14; // above the shoulder line: the rounded top of the shoulders
const TORSO_SPAN = 1.22;
const REST_SPINE = 1.35; // shoulder-to-hip length at rest, in shoulder widths
const NECK_OPENING = 0.17;
const SHOULDER_T = 0.12;

function torsoHalfWidth(t: number) {
  if (t < SHOULDER_T) return NECK_OPENING + (0.52 - NECK_OPENING) * Math.sqrt(Math.max(0, 1 - (1 - t / SHOULDER_T) ** 2));
  return 0.52 - 0.11 * smoothstep(SHOULDER_T, 0.62, t) + 0.04 * smoothstep(0.62, 0.95, t); // round shoulders, waist
}

function torsoHalfDepth(t: number) {
  const chest = 0.03 * Math.exp(-(((t - 0.3) / 0.15) ** 2)) * Math.min(1, t / SHOULDER_T);
  return 0.58 * torsoHalfWidth(t) + chest;
}

/** Front of the torso surface at (x, t): position and yaw of its normal. */
function torsoSurface(x: number, t: number) {
  const w = torsoHalfWidth(t);
  const d = torsoHalfDepth(t);
  const z = d * Math.sqrt(Math.max(0, 1 - (x / w) ** 2));
  return { y: TORSO_TOP - t * TORSO_SPAN, z, yaw: Math.atan2(x / (w * w), z / (d * d)) };
}

function torsoGeometry() {
  const rings = 72;
  const segments = 96;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const w = torsoHalfWidth(t);
    const d = torsoHalfDepth(t);
    for (let j = 0; j <= segments; j++) {
      const a = (2 * Math.PI * j) / segments; // u = 0.5 is the front center
      positions.push(-Math.sin(a) * w, TORSO_TOP - t * TORSO_SPAN, -Math.cos(a) * d);
      uvs.push(j / segments, 1 - t);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** The blazer front painted on the torso: shirt and collar in the V, teal tie, lapels, gold buttons. */
function blazerTexture() {
  const W = 2048;
  const H = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  type P = [number, number]; // (x in shoulder widths, t)

  const toPixel = (x: number, t: number): P => {
    const s = clamp(x / torsoHalfWidth(t), -1, 1);
    return [(0.5 + Math.asin(s) / (2 * Math.PI)) * W, t * H];
  };
  // Edges are subdivided so they stay straight on the curved torso.
  const path = (pts: P[], close: boolean) => {
    g.beginPath();
    const edges = close ? pts.length : pts.length - 1;
    for (let i = 0; i < edges; i++) {
      const [x0, t0] = pts[i];
      const [x1, t1] = pts[(i + 1) % pts.length];
      for (let k = i === 0 ? 0 : 1; k <= 8; k++) {
        const [px, py] = toPixel(x0 + ((x1 - x0) * k) / 8, t0 + ((t1 - t0) * k) / 8);
        if (i === 0 && k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
    }
    if (close) g.closePath();
  };
  const shape = (pts: P[], fill: number, stroke?: number, width = 4) => {
    path(pts, true);
    g.fillStyle = css(fill);
    g.fill();
    if (stroke !== undefined) {
      g.strokeStyle = css(stroke);
      g.lineWidth = width;
      g.lineJoin = "round";
      g.stroke();
    }
  };
  const line = (pts: P[], stroke: number, width: number) => {
    path(pts, false);
    g.strokeStyle = css(stroke);
    g.lineWidth = width;
    g.lineCap = "round";
    g.stroke();
  };
  const mirror = (pts: P[]) => pts.map(([x, t]): P => [-x, t]);

  g.fillStyle = css(C.blazer);
  g.fillRect(0, 0, W, H);

  shape([[-0.135, 0.02], [0.135, 0.02], [0, 0.41]], C.shirt);
  const collar: P[] = [[-0.13, 0.015], [-0.012, 0.05], [-0.085, 0.13]];
  shape(collar, C.shirt, C.shirtShade, 4);
  shape(mirror(collar), C.shirt, C.shirtShade, 4);
  shape([[-0.027, 0.04], [0.027, 0.04], [0.019, 0.092], [-0.019, 0.092]], C.tie, C.tieShade, 3);
  shape([[-0.017, 0.092], [0.017, 0.092], [0.033, 0.36], [0, 0.41], [-0.033, 0.36]], C.tie, C.tieShade, 3);

  const lapel: P[] = [[-0.135, 0.02], [-0.004, 0.41], [-0.03, 0.48], [-0.27, 0.18], [-0.215, 0.14], [-0.24, 0.1], [-0.2, 0.02]];
  shape(lapel, C.lapel, C.seam, 4);
  shape(mirror(lapel), C.lapel, C.seam, 4);

  line([[0, 0.41], [0.012, 0.48], [0.012, 1]], C.seam, 5);
  line([[0.13, 0.82], [0.33, 0.82]], C.seam, 4);
  line([[-0.13, 0.82], [-0.33, 0.82]], C.seam, 4);

  for (const t of [0.54, 0.67]) {
    const [cx, cy] = toPixel(0.045, t);
    const rx = (0.022 * W) / (2 * Math.PI * torsoHalfWidth(t));
    const ry = (0.022 * H) / (TORSO_SPAN * REST_SPINE);
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.fillStyle = css(C.gold);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = css(C.goldShade);
    g.stroke();
    g.beginPath();
    g.ellipse(cx - rx * 0.3, cy - ry * 0.3, rx * 0.3, ry * 0.3, 0, 0, Math.PI * 2);
    g.fillStyle = "rgba(255, 255, 255, 0.55)";
    g.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Gold name badge: "SAM", and "ConversAI" below. */
function badgeTexture() {
  const W = 512;
  const H = 192;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const gradient = g.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "#f7de8a");
  gradient.addColorStop(1, css(C.gold));
  g.beginPath();
  g.roundRect(6, 6, W - 12, H - 12, 26);
  g.fillStyle = gradient;
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = css(C.goldShade);
  g.stroke();
  g.fillStyle = css(C.badgeText);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "800 104px system-ui, 'Segoe UI', Arial, sans-serif";
  g.fillText("SAM", W / 2, 84);
  g.font = "600 38px system-ui, 'Segoe UI', Arial, sans-serif";
  g.fillText("ConversAI", W / 2, 150);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Soft pink cheek: a radial gradient, transparent at the edge. */
function blushTexture() {
  const N = 128;
  const canvas = document.createElement("canvas");
  canvas.width = N;
  canvas.height = N;
  const g = canvas.getContext("2d")!;
  const gradient = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  gradient.addColorStop(0, rgba(C.blush, 0.5));
  gradient.addColorStop(1, rgba(C.blush, 0));
  g.fillStyle = gradient;
  g.fillRect(0, 0, N, N);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---- Smooth tubes: arms and fingers --------------------------------------------------------------------------------

/**
 * `count` smooth tubes with rounded ends, each through a few control points (Catmull-Rom) with a radius per point.
 * One geometry, rewritten in place every frame. Frames are rotation-minimizing, so the tube never twists.
 */
class Tubes {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly samples: number;
  private readonly rings: number;
  private readonly cosA: Float32Array;
  private readonly sinA: Float32Array;
  private readonly c: Float32Array; // sample centers
  private readonly r: Float32Array; // sample radii
  private readonly t: Float32Array; // tangents
  private readonly fn: Float32Array; // frame normals
  private readonly fb: Float32Array; // frame binormals

  constructor(
    count: number,
    private readonly controls: number,
    private readonly steps: number,
    private readonly radial: number,
    private readonly cap: number,
  ) {
    this.samples = (controls - 1) * steps + 1;
    this.rings = this.samples + 2 * cap;
    const vertices = count * this.rings * radial;
    this.pos = new Float32Array(vertices * 3);
    this.nor = new Float32Array(vertices * 3);
    this.cosA = new Float32Array(radial);
    this.sinA = new Float32Array(radial);
    for (let i = 0; i < radial; i++) {
      this.cosA[i] = Math.cos((2 * Math.PI * i) / radial);
      this.sinA[i] = Math.sin((2 * Math.PI * i) / radial);
    }
    this.c = new Float32Array(this.samples * 3);
    this.r = new Float32Array(this.samples);
    this.t = new Float32Array(this.samples * 3);
    this.fn = new Float32Array(this.samples * 3);
    this.fb = new Float32Array(this.samples * 3);

    const index: number[] = [];
    for (let k = 0; k < count; k++) {
      const base = k * this.rings * radial;
      for (let j = 0; j < this.rings - 1; j++) {
        for (let i = 0; i < radial; i++) {
          const a = base + j * radial + i;
          const a1 = base + j * radial + ((i + 1) % radial);
          index.push(a, a1, a + radial, a1, a1 + radial, a + radial);
        }
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
  }

  /** Tube k through `pts` (one per control point), with `radii` at those points. */
  set(k: number, pts: THREE.Vector3[], radii: readonly number[]) {
    const { samples, steps, controls, c, r, t, fn, fb } = this;
    let j = 0;
    for (let s = 0; s < controls - 1; s++) {
      const p0 = pts[Math.max(s - 1, 0)];
      const p3 = pts[Math.min(s + 2, controls - 1)];
      for (let q = s === 0 ? 0 : 1; q <= steps; q++, j++) {
        const u = q / steps;
        catmullRom(p0, pts[s], pts[s + 1], p3, u, c, j * 3);
        r[j] = radii[s] + (radii[s + 1] - radii[s]) * u * u * (3 - 2 * u);
      }
    }
    for (j = 0; j < samples; j++) {
      const a = Math.max(j - 1, 0) * 3;
      const b = Math.min(j + 1, samples - 1) * 3;
      let x = c[b] - c[a];
      let y = c[b + 1] - c[a + 1];
      let z = c[b + 2] - c[a + 2];
      const length = Math.hypot(x, y, z);
      if (length < 1e-9) {
        x = 0;
        y = 1;
        z = 0;
      } else {
        x /= length;
        y /= length;
        z /= length;
      }
      t[j * 3] = x;
      t[j * 3 + 1] = y;
      t[j * 3 + 2] = z;
    }
    // Parallel transport of a normal along the tube.
    const alongZ = Math.abs(t[2]) > 0.9; // seed with any axis not parallel to the first tangent
    let nx = alongZ ? 1 : 0;
    let ny = 0;
    let nz = alongZ ? 0 : 1;
    for (j = 0; j < samples; j++) {
      const tx = t[j * 3];
      const ty = t[j * 3 + 1];
      const tz = t[j * 3 + 2];
      const d = nx * tx + ny * ty + nz * tz;
      nx -= d * tx;
      ny -= d * ty;
      nz -= d * tz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      fn[j * 3] = nx;
      fn[j * 3 + 1] = ny;
      fn[j * 3 + 2] = nz;
      fb[j * 3] = ty * nz - tz * ny;
      fb[j * 3 + 1] = tz * nx - tx * nz;
      fb[j * 3 + 2] = tx * ny - ty * nx;
    }
    // Rings: start cap (tip -> equator), body, end cap (equator -> tip).
    let ring = k * this.rings;
    for (let m = this.cap; m >= 1; m--) this.ring(ring++, 0, m, -1);
    for (j = 0; j < samples; j++) this.ring(ring++, j, 0, 0);
    for (let m = 1; m <= this.cap; m++) this.ring(ring++, samples - 1, m, 1);
  }

  /** One ring around sample j. On a cap (m > 0) it shrinks along a quarter circle toward the rounded tip. */
  private ring(ring: number, j: number, m: number, side: number) {
    const phi = (Math.PI / 2) * (m / this.cap);
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi) * side;
    const j3 = j * 3;
    const radius = this.r[j];
    const { c, t, fn, fb, pos, nor, cosA, sinA } = this;
    const cx = c[j3] + t[j3] * radius * sinP;
    const cy = c[j3 + 1] + t[j3 + 1] * radius * sinP;
    const cz = c[j3 + 2] + t[j3 + 2] * radius * sinP;
    for (let i = 0; i < this.radial; i++) {
      const dx = cosA[i] * fn[j3] + sinA[i] * fb[j3];
      const dy = cosA[i] * fn[j3 + 1] + sinA[i] * fb[j3 + 1];
      const dz = cosA[i] * fn[j3 + 2] + sinA[i] * fb[j3 + 2];
      const v = (ring * this.radial + i) * 3;
      pos[v] = cx + dx * radius * cosP;
      pos[v + 1] = cy + dy * radius * cosP;
      pos[v + 2] = cz + dz * radius * cosP;
      nor[v] = dx * cosP + t[j3] * sinP;
      nor[v + 1] = dy * cosP + t[j3 + 1] * sinP;
      nor[v + 2] = dz * cosP + t[j3 + 2] * sinP;
    }
  }

  commit() {
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

// ---- Head and face ----------------------------------------------------------------------------------------------

const HEAD = new THREE.Vector3(C.head.radii.x, C.head.radii.y, C.head.radii.z).multiplyScalar(C.head.scale);

/** Soft oval head: a sphere, slightly narrower toward a round chin. */
function headGeometry() {
  const geometry = new THREE.SphereGeometry(1, 72, 54);
  const p = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y >= 0) continue;
    const k = Math.pow(-y, 1.6);
    p.setX(i, p.getX(i) * (1 - C.head.jaw * k));
    p.setZ(i, p.getZ(i) * (1 - 0.5 * C.head.jaw * k));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Point on the front of the head at head-local (x, y), `lift` out along the surface normal (written to pos, normal). */
function onHead(x: number, y: number, lift: number, pos: THREE.Vector3, normal = _n) {
  const yn = clamp(y / HEAD.y, -0.995, 0.995);
  const k = yn < 0 ? Math.pow(-yn, 1.6) : 0;
  const rx = HEAD.x * (1 - C.head.jaw * k);
  const rz = HEAD.z * (1 - 0.5 * C.head.jaw * k);
  const xn = clamp(x / rx, -0.995, 0.995);
  const z = rz * Math.sqrt(Math.max(0, 1 - xn * xn - yn * yn));
  normal.set(x / (rx * rx), y / (HEAD.y * HEAD.y), z / (rz * rz)).normalize();
  pos.set(x, y, z).addScaledVector(normal, lift);
}

/**
 * Face points (world x, y in `xy`) -> face coordinates in `uv`: origin between the outer eye corners, roll removed,
 * x in eye spans, y in brow-to-chin heights. Independent of the real face size and position.
 */
function normalizeFace(xy: Float32Array, uv: Float32Array) {
  const lx = xy[20];
  const ly = xy[21];
  const rx = xy[30];
  const ry = xy[31];
  const mx = (lx + rx) / 2;
  const my = (ly + ry) / 2;
  const span = Math.max(Math.hypot(rx - lx, ry - ly), 1e-3);
  const roll = Math.atan2(ry - ly, rx - lx);
  const c = Math.cos(-roll);
  const s = Math.sin(-roll);
  let brow = 0;
  for (let i = 0; i < 26; i++) {
    const dx = xy[i * 2] - mx;
    const dy = xy[i * 2 + 1] - my;
    uv[i * 2] = dx * c - dy * s;
    uv[i * 2 + 1] = dx * s + dy * c;
    if (i < 10) brow += uv[i * 2 + 1] / 10;
  }
  const height = Math.max(brow - uv[51], 1e-3); // 51: chin y
  for (let i = 0; i < 26; i++) {
    uv[i * 2] /= span;
    uv[i * 2 + 1] /= height;
  }
}

// Face layout on the head (head-local units).
const faceX = (uv: Float32Array, i: number) => uv[i * 2] * F.spanX * HEAD.x;
const faceY = (uv: Float32Array, i: number) => (F.eyeLine + uv[i * 2 + 1] * F.spanY) * HEAD.y;
const browY = (uv: Float32Array, i: number) => (F.eyeLine + uv[i * 2 + 1] * F.spanY * F.browLift) * HEAD.y;
const lidGap = (uv: Float32Array, e: number) => uv[EYES[e][1] * 2 + 1] - uv[EYES[e][3] * 2 + 1];
const mouthGap = (uv: Float32Array) => uv[22 * 2 + 1] - uv[23 * 2 + 1]; // inner lips

// Neutral face (first frame of HELLO), the reference for eye and mouth opening and for the head drift.
const REST = (() => {
  const face = REST_FRAME.face!;
  const xy = new Float32Array(52);
  face.forEach(([x, y], i) => {
    xy[i * 2] = x;
    xy[i * 2 + 1] = -y;
  });
  const uv = new Float32Array(52);
  normalizeFace(xy, uv);
  let brow = 0;
  for (let i = 0; i < 10; i++) brow += xy[i * 2 + 1] / 10;
  const chin = xy[51];
  return {
    eyeGap: [lidGap(uv, 0), lidGap(uv, 1)],
    mouthGap: mouthGap(uv),
    // Head center as the solver computes it, relative to the shoulder midpoint (which is the origin at rest).
    headX: (xy[20] + xy[30]) / 2,
    headY: chin + 0.72 * (brow - chin),
  };
})();

/** A flat strip on the head: brows, mouth line, mouth opening. Vertices come in pairs (one per side). */
class Strip {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;

  constructor(private readonly n: number) {
    this.pos = new Float32Array(n * 2 * 3);
    const index: number[] = [];
    for (let k = 0; k < n - 1; k++) index.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3);
    this.geometry.setIndex(index);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
  }

  /** Between two curves a and b (head-local x, y), laid on the head surface. */
  setPairs(ax: Float32Array, ay: Float32Array, bx: Float32Array, by: Float32Array, lift: number) {
    for (let k = 0; k < this.n; k++) {
      onHead(ax[k], ay[k], lift, _a);
      onHead(bx[k], by[k], lift, _b);
      this.pos[k * 6] = _a.x;
      this.pos[k * 6 + 1] = _a.y;
      this.pos[k * 6 + 2] = _a.z;
      this.pos[k * 6 + 3] = _b.x;
      this.pos[k * 6 + 4] = _b.y;
      this.pos[k * 6 + 5] = _b.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  /** A ribbon along one curve, with a width at each point. */
  setRibbon(xs: Float32Array, ys: Float32Array, widths: Float32Array, lift: number, ax: Float32Array, ay: Float32Array, bx: Float32Array, by: Float32Array) {
    const n = this.n;
    for (let k = 0; k < n; k++) {
      const p = Math.max(k - 1, 0);
      const q = Math.min(k + 1, n - 1);
      let tx = xs[q] - xs[p];
      let ty = ys[q] - ys[p];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
      const h = widths[k] / 2;
      ax[k] = xs[k] + ty * h;
      ay[k] = ys[k] - tx * h;
      bx[k] = xs[k] - ty * h;
      by[k] = ys[k] + tx * h;
    }
    this.setPairs(ax, ay, bx, by, lift);
  }
}

const SLEEVES = [[12, 14, 16], [11, 13, 15]]; // shoulder, elbow, wrist: Sam's right arm (screen left), then left
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const BROW_POINTS = 4 * CURVE_STEPS + 1; // 5 brow points -> 4 smooth spans
const MOUTH_POINTS = 13;
const EYE_RIM = 0.007;

// ---- Sam ------------------------------------------------------------------------------------------------------------

export class ConciergeRig implements Rig {
  readonly root = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly bloom = false;
  readonly look: RigLook = {
    faceColor: THEME.face.color,
    browColor: THEME.face.browColor,
    lipColor: THEME.face.color,
    lineWidth: THEME.face.lineWidth,
    browWidth: THEME.face.browWidth,
    lipWidth: THEME.face.lineWidth,
    trailColor: C.trail.color,
    trailStrength: C.trail.strength,
    trailWidth: C.trail.width,
    particleColor: C.particles,
    faceStrokes: false, // Sam draws his own eyes, brows and mouth
  };

  private readonly bodyOutline = { value: 0.002 };
  private readonly handOutline = { value: 0.0015 };
  private readonly textures: THREE.Texture[] = [];
  private readonly appearing: THREE.Material[] = []; // follow the intro fade-in

  private readonly torso = new THREE.Group();
  private readonly arms: Tubes;
  private readonly armPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly cuffs: THREE.Mesh[];
  private readonly neck: THREE.Mesh;
  private readonly collar: THREE.Mesh;

  private readonly head = new THREE.Group(); // position + rotation; the face features live in it
  private readonly nose: THREE.Mesh;
  private readonly eyes: { line: THREE.Mesh; white: THREE.Mesh; pupil: THREE.Mesh; glint: THREE.Mesh; glint2: THREE.Mesh }[];
  private readonly brows: Strip[];
  private readonly mouthFill = new Strip(MOUTH_POINTS);
  private readonly mouthLine = new Strip(MOUTH_POINTS);

  private readonly gloves: Tubes[];
  private readonly fingerPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly gloveMeshes: THREE.Mesh[];
  private readonly palms: THREE.Mesh[];
  private readonly gloveMaterials: THREE.Material[];
  private readonly gloveOutlines: THREE.Material[];

  // Per-frame scratch.
  private readonly faceXY = new Float32Array(52);
  private readonly faceUV = new Float32Array(52);
  private readonly browPts = [0, 1].map(() => [0, 1, 2, 3, 4].map(() => new THREE.Vector3()));
  private readonly curve = new Float32Array(BROW_POINTS * 6);
  private readonly sx = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly sy = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly sw = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly ax = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly ay = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly bx = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));
  private readonly by = new Float32Array(Math.max(BROW_POINTS, MOUTH_POINTS));

  constructor() {
    const gradient = gradientMap();
    const blazerMap = blazerTexture();
    const badgeMap = badgeTexture();
    const blushMap = blushTexture();
    this.textures.push(gradient, blazerMap, badgeMap, blushMap);

    const toon = (color: number, fade = WAIST, extra: THREE.MeshToonMaterialParameters = {}) => {
      const m = toonMaterial(color, gradient, fade, extra);
      this.appearing.push(m);
      return m;
    };
    const flat = (color: number, extra: THREE.MeshBasicMaterialParameters = {}) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, ...extra });
      this.appearing.push(m);
      return m;
    };
    const blazer = toon(C.blazer);
    const skin = toon(C.skin);
    const shirt = toon(C.shirt, WAIST, { side: THREE.DoubleSide });
    const hair = toon(C.hair, WAIST, { side: THREE.DoubleSide });
    const outline = outlineMaterial(this.bodyOutline, WAIST);
    this.appearing.push(outline);
    // A mesh with its outline (same geometry, drawn as an inflated back-face hull).
    const outlined = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geometry, material);
      const hull = new THREE.Mesh(geometry, outline);
      mesh.frustumCulled = hull.frustumCulled = false;
      mesh.add(hull);
      parent.add(mesh);
      return mesh;
    };
    const ball = new THREE.SphereGeometry(1, 48, 32);

    // Torso, with the blazer front painted on it, and the badge on Sam's left chest (screen right).
    outlined(torsoGeometry(), toon(0xffffff, WAIST, { map: blazerMap }), this.torso);
    const spot = torsoSurface(0.24, 0.27);
    const badgeMaterial = new THREE.MeshBasicMaterial({ map: badgeMap, transparent: true });
    this.appearing.push(badgeMaterial);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(C.badge.width, C.badge.height / REST_SPINE), badgeMaterial);
    badge.position.set(0.24, spot.y, spot.z + 0.012);
    badge.rotation.y = spot.yaw;
    this.torso.add(badge);
    this.root.add(this.torso);

    // Arms: one smooth tapered tube each (shoulder -> elbow -> sleeve end), white shirt cuffs.
    this.arms = new Tubes(2, 3, 14, 28, 6);
    outlined(this.arms.geometry, blazer, this.root);
    const cuff = new THREE.CapsuleGeometry(S.cuff, 0.035, 12, 36);
    this.cuffs = [0, 1].map(() => outlined(cuff, shirt, this.root));

    // Short wide neck, shirt collar up to the chin.
    this.neck = outlined(new THREE.CylinderGeometry(1, 1, 1, 48, 1, false).translate(0, 0.5, 0), skin, this.root);
    this.collar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true).translate(0, 0.5, 0), shirt);
    this.root.add(this.collar);

    // Head: soft oval, round hair volume with a swept quiff, round ears (all in the head mesh's unit space).
    const skull = outlined(headGeometry(), skin, this.head);
    skull.scale.copy(HEAD);
    outlined(new THREE.SphereGeometry(1.08, 72, 28, 0, Math.PI * 2, 0, 0.44 * Math.PI).rotateX(-0.55), hair, skull);
    const quiff = outlined(ball, hair, skull);
    quiff.position.set(0.12, 0.74, 0.45);
    quiff.scale.set(0.72, 0.3, 0.55);
    quiff.rotation.set(0.7, 0, -0.25);
    for (const side of [-1, 1]) {
      const ear = outlined(ball, skin, skull);
      ear.position.set(0.985 * side, -0.02, -0.05);
      ear.scale.set(0.15, 0.2, 0.11);
    }
    this.root.add(this.head);

    // Face features, on the front of the head (head group space, unscaled).
    const add = <T extends THREE.Object3D>(obj: T, order: number) => {
      obj.renderOrder = order;
      obj.frustumCulled = false;
      this.head.add(obj);
      return obj;
    };
    const disc = new THREE.CircleGeometry(1, 48);
    const blush = flat(0xffffff, { map: blushMap, depthWrite: false });
    for (const side of [-1, 1]) {
      const cheek = add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blush), 1);
      onHead(side * F.cheek.x * HEAD.x, F.cheek.y * HEAD.y, 0.0025, cheek.position, _n);
      cheek.quaternion.setFromUnitVectors(FRONT, _n);
      cheek.scale.set(F.cheek.w * HEAD.x, F.cheek.h * HEAD.y, 1);
    }
    this.nose = add(new THREE.Mesh(ball, toon(C.skinShade)), 1);
    const eyeLine = flat(C.eyeLine);
    const eyeWhite = flat(C.eyeWhite);
    const pupil = flat(C.pupil);
    const glint = flat(0xffffff);
    this.eyes = [0, 1].map(() => ({
      line: add(new THREE.Mesh(disc, eyeLine), 2),
      white: add(new THREE.Mesh(disc, eyeWhite), 3),
      pupil: add(new THREE.Mesh(disc, pupil), 4),
      glint: add(new THREE.Mesh(disc, glint), 5),
      glint2: add(new THREE.Mesh(disc, glint), 5),
    }));
    const brow = flat(C.brow);
    this.brows = [0, 1].map(() => {
      const strip = new Strip(BROW_POINTS);
      add(new THREE.Mesh(strip.geometry, brow), 3);
      return strip;
    });
    add(new THREE.Mesh(this.mouthFill.geometry, flat(C.mouthInside)), 2);
    add(new THREE.Mesh(this.mouthLine.geometry, flat(C.mouthLine)), 3);

    // Gloves (overlay, drawn over everything): one smooth tube per finger, a full rounded palm, thin outline.
    this.gloveMaterials = [0, 1].map(() => toonMaterial(C.gloves, gradient, NEVER));
    this.gloveOutlines = [0, 1].map(() => outlineMaterial(this.handOutline, NEVER));
    this.gloves = [0, 1].map(() => new Tubes(5, 4, 6, 18, 5));
    const glovePart = (geometry: THREE.BufferGeometry, h: number) => {
      const mesh = new THREE.Mesh(geometry, this.gloveMaterials[h]);
      const hull = new THREE.Mesh(geometry, this.gloveOutlines[h]);
      mesh.frustumCulled = hull.frustumCulled = false;
      mesh.add(hull);
      mesh.visible = false;
      this.overlay.add(mesh);
      return mesh;
    };
    this.gloveMeshes = this.gloves.map((tubes, h) => glovePart(tubes.geometry, h));
    this.palms = [0, 1].map((h) => glovePart(ball, h));
  }

  faceFront(radii: THREE.Vector3) {
    return radii.z; // unused: Sam lays out his own face
  }

  resize(height: number) {
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / height; // view-space size of a pixel at depth 1
    this.bodyOutline.value = C.outlinePx * pixel;
    this.handOutline.value = C.handOutlinePx * pixel;
  }

  update(p: WorldPose) {
    for (const m of this.appearing) m.opacity = p.appear;
    const { pose } = p;

    // Torso frame: x along the shoulders, y up the spine, scaled to the shoulder width and spine length.
    const mid = _a.addVectors(pose[11], pose[12]).multiplyScalar(0.5);
    _x.subVectors(pose[11], pose[12]);
    const sx = Math.max(_x.length(), 1e-3);
    _x.divideScalar(sx);
    _y.subVectors(mid, p.hipMid);
    const sy = Math.max(_y.length(), 1e-3);
    _y.addScaledVector(_x, -_y.dot(_x)).normalize();
    _z.crossVectors(_x, _y);
    this.torso.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    this.torso.position.copy(mid);
    this.torso.scale.set(sx, sy, sx);

    // Head on the shoulders (cartoon proportions), drifting a little with the real face, turned like it.
    const driftX = (p.head.center.x - mid.x - REST.headX) * C.head.follow;
    const driftY = (p.head.center.y - mid.y - REST.headY) * C.head.follow;
    this.head.position.copy(mid).addScaledVector(_y, C.head.lift + HEAD.y + driftY).addScaledVector(_x, driftX);
    this.head.quaternion.copy(p.head.rotation);
    p.head.center.copy(this.head.position); // the intro particles gather on this head
    p.head.radii.copy(HEAD);

    // Neck: from inside the torso into the head, barely visible. Collar up to just under the chin.
    const neckBase = _b.copy(mid).addScaledVector(_y, 0.04);
    _n.copy(UP).applyQuaternion(p.head.rotation).multiplyScalar(-0.55 * HEAD.y).add(this.head.position);
    placeSegment(this.neck, neckBase, _n, S.neck);
    _n.sub(neckBase).normalize();
    const collarFrom = this.armPts[0].copy(neckBase).addScaledVector(_n, 0.08);
    const collarTo = this.armPts[1].copy(neckBase).addScaledVector(_n, C.head.lift - 0.02);
    placeSegment(this.collar, collarFrom, collarTo, S.neck + 0.025);

    // Arms: a smooth tube from just inside the shoulder to a little before the wrist; the cuff fills the gap.
    for (let side = 0; side < 2; side++) {
      const shoulder = pose[SLEEVES[side][0]];
      const elbow = pose[SLEEVES[side][1]];
      const wrist = pose[SLEEVES[side][2]];
      const p0 = this.armPts[0];
      const p1 = this.armPts[1];
      const p2 = this.armPts[2];
      p0.copy(shoulder).lerp(mid, 0.12).addScaledVector(_y, -0.02);
      p1.copy(elbow);
      _n.subVectors(wrist, elbow);
      const length = _n.length();
      _n.divideScalar(length || 1);
      p2.copy(elbow).addScaledVector(_n, Math.max(0.05, length - 0.06));
      this.arms.set(side, this.armPts, S.sleeve);
      const cuff = this.cuffs[side];
      cuff.position.copy(p2).addScaledVector(_n, 0.015);
      cuff.quaternion.setFromUnitVectors(UP, _n);
    }
    this.arms.commit();

    this.updateFace(p);
    this.updateGloves(p);
  }

  private updateFace(p: WorldPose) {
    const xy = this.faceXY;
    const uv = this.faceUV;
    for (let i = 0; i < 26; i++) {
      xy[i * 2] = p.face[i].x;
      xy[i * 2 + 1] = p.face[i].y;
    }
    normalizeFace(xy, uv);

    // Eyes: big soft ovals, opened and closed by the eyelid points; big pupils with two highlights.
    for (let e = 0; e < 2; e++) {
      const idx = EYES[e];
      const cx = (faceX(uv, idx[0]) + faceX(uv, idx[1]) + faceX(uv, idx[2]) + faceX(uv, idx[3])) / 4;
      const cy = (faceY(uv, idx[0]) + faceY(uv, idx[1]) + faceY(uv, idx[2]) + faceY(uv, idx[3])) / 4;
      const open = clamp(lidGap(uv, e) / REST.eyeGap[e], 0.08, 1.3);
      const ex = F.eye.x * HEAD.x;
      const ey = F.eye.y * HEAD.y * open;
      const r = F.pupil * ex;
      const g = Math.min(1, open);
      const eye = this.eyes[e];
      placeDisc(eye.line, cx, cy, 0.003, ex + EYE_RIM, ey + EYE_RIM);
      placeDisc(eye.white, cx, cy, 0.0045, ex, ey);
      placeDisc(eye.pupil, cx, cy - ey * 0.05, 0.006, r, Math.min(r, ey * 0.92));
      placeDisc(eye.glint, cx - r * 0.32, cy + r * 0.34 * g, 0.0075, r * 0.36, r * 0.36 * g);
      placeDisc(eye.glint2, cx + r * 0.3, cy - r * 0.28 * g, 0.0078, r * 0.16, r * 0.16 * g);
    }

    // Brows: thick, rounded, soft ends; they follow BROWS-UP / BROWS-DOWN with an amplified lift.
    const { sx, sy, sw, ax, ay, bx, by, curve } = this;
    for (let b = 0; b < 2; b++) {
      const pts = this.browPts[b];
      for (let k = 0; k < 5; k++) pts[k].set(faceX(uv, BROWS[b][k]), browY(uv, BROWS[b][k]), 0);
      writeCurve(curve, 0, pts, false);
      for (let k = 0; k < BROW_POINTS; k++) {
        const o = k < BROW_POINTS - 1 ? k * 6 : (k - 1) * 6 + 3;
        sx[k] = curve[o];
        sy[k] = curve[o + 1];
        sw[k] = F.browWidth * HEAD.y * Math.pow(Math.sin(Math.PI * (0.06 + (0.88 * k) / (BROW_POINTS - 1))), 0.55);
      }
      this.brows[b].setRibbon(sx, sy, sw, 0.007, ax, ay, bx, by);
    }

    // Mouth: small, corners raised in a smile; the inner lips open it.
    const lx = faceX(uv, 18);
    const ly = faceY(uv, 18);
    const rx = faceX(uv, 19);
    const ry = faceY(uv, 19);
    const cx = (lx + rx) / 2;
    const cy = (ly + ry) / 2;
    const smile = F.smile * HEAD.y;
    const Lx = cx + (lx - cx) * F.mouthScale;
    const Ly = cy + (ly - cy) * F.mouthScale + smile;
    const Rx = cx + (rx - cx) * F.mouthScale;
    const Ry = cy + (ry - cy) * F.mouthScale + smile;
    const open = Math.max(0, mouthGap(uv) - REST.mouthGap) * F.spanY * HEAD.y * F.mouthOpen;
    const topMid = cy - 1.8 * smile + 0.7 * open; // quadratic control points: a smile curve,
    const lowMid = cy - 1.8 * smile - 1.3 * open; // the lower lip drops when the mouth opens
    for (let k = 0; k < MOUTH_POINTS; k++) {
      const s = k / (MOUTH_POINTS - 1);
      const w0 = (1 - s) * (1 - s);
      const w1 = 2 * (1 - s) * s;
      const w2 = s * s;
      const x = w0 * Lx + w1 * cx + w2 * Rx;
      ax[k] = bx[k] = x;
      ay[k] = w0 * Ly + w1 * topMid + w2 * Ry;
      by[k] = w0 * Ly + w1 * lowMid + w2 * Ry;
      sx[k] = x;
      sy[k] = ay[k];
      sw[k] = F.mouthLine * HEAD.y * (0.45 + 0.55 * Math.sin(Math.PI * s));
    }
    this.mouthFill.setPairs(ax, ay, bx, by, 0.004);
    // setRibbon reuses ax..by as scratch, so the fill is written first.
    this.mouthLine.setRibbon(sx, sy, sw, 0.0055, ax, ay, bx, by);

    // Nose: a small round button.
    const nr = F.nose * HEAD.x;
    onHead(faceX(uv, 24), faceY(uv, 24), nr * 0.3, this.nose.position, _n);
    this.nose.quaternion.setFromUnitVectors(FRONT, _n);
    this.nose.scale.set(nr, nr * 0.85, nr * 0.75);
  }

  private updateGloves(p: WorldPose) {
    for (let h = 0; h < 2; h++) {
      const hand = p.hands[h];
      const visible = hand.hasShape && hand.opacity > 0;
      this.gloveMeshes[h].visible = visible;
      this.palms[h].visible = visible;
      this.gloveMaterials[h].opacity = hand.opacity;
      this.gloveOutlines[h].opacity = hand.opacity;
      if (!visible) continue;
      const pts = hand.pts;
      const tubes = this.gloves[h];
      for (let f = 0; f < 5; f++) {
        for (let k = 0; k < 4; k++) this.fingerPts[k].copy(pts[FINGERS[f][k]]);
        tubes.set(f, this.fingerPts, S.fingers[f]);
      }
      tubes.commit();

      // Palm: a full rounded pad from the wrist to the knuckles, across the index and pinky knuckles.
      _y.subVectors(pts[9], pts[0]);
      const length = Math.max(_y.length(), 1e-3);
      _y.divideScalar(length);
      _x.subVectors(pts[5], pts[17]);
      const width = Math.max(_x.length(), 1e-3);
      _x.addScaledVector(_y, -_x.dot(_y)).normalize();
      _z.crossVectors(_x, _y);
      const palm = this.palms[h];
      palm.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
      palm.position.addVectors(pts[0], pts[9]).multiplyScalar(0.5).addScaledVector(_y, length * 0.04);
      palm.scale.set(width * 0.62, length * 0.6, S.palm);
    }
  }

  dispose() {
    for (const texture of this.textures) texture.dispose();
  }
}

/** Places a flat disc on the head surface at (x, y), facing out, with radii (rx, ry). */
function placeDisc(mesh: THREE.Mesh, x: number, y: number, lift: number, rx: number, ry: number) {
  onHead(x, y, lift, mesh.position, _n);
  mesh.quaternion.setFromUnitVectors(FRONT, _n);
  mesh.scale.set(rx, Math.max(ry, 1e-4), 1);
}

/** Places an object whose geometry spans y = 0..1 between a and b, with the given radius. */
function placeSegment(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz) || 1e-6;
  obj.position.copy(a);
  obj.quaternion.setFromUnitVectors(UP, _segment.set(dx / length, dy / length, dz / length));
  obj.scale.set(radius, length, radius);
}
const _segment = new THREE.Vector3();

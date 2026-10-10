// P2: the "concierge" style: Sam, the SignBridge hotel receptionist (an original character), in soft 3D toon.
// Built only from Three.js geometry and dressed on the landmark skeleton every frame: all motion comes from the landmarks.
import * as THREE from "three";
import {
  CURVE_STEPS,
  EYES,
  FADE_BOTTOM,
  FADE_TOP,
  FOV,
  HAND_BONES,
  NO_FADE,
  NOSE,
  PALM,
  Sticks,
  TIPS,
  placeSegment,
  smoothstep,
  writeCurve,
  type Rig,
  type RigLook,
  type WorldPose,
} from "./rig";
import { THEME } from "./theme";

const C = THEME.concierge;
const S = C.sizes;

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

// ---- Materials: toon with a waist fade and a rim band, inverted-hull outlines --------------------------------------

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

// Rim light: a soft cool band on the silhouette, to detach Sam from the dark background.
const RIM_FRAGMENT = /* glsl */ `
  float rimBand = smoothstep(0.55, 0.8, 1.0 - abs(dot(normalize(normal), normalize(vViewPosition))));
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

/** Soft toon shading: a few flat tones instead of a smooth gradient. */
function gradientMap() {
  const tones = new Uint8Array(C.toneSteps);
  const texture = new THREE.DataTexture(tones, tones.length, 1, THREE.RedFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// ---- Torso: a barrel between the shoulders and the hips ------------------------------------------------------------
// Local frame: x across the shoulders (unit: shoulder width), y up the spine (unit: shoulder-to-hip length), z forward.
// t runs from the top of the torso (0) to below the hips (1).

const TORSO_TOP = 0.14; // above the shoulder line: the rounded top of the shoulders
const TORSO_SPAN = 1.22;
const REST_SPINE = 1.35; // shoulder-to-hip length at rest, in shoulder widths
const NECK_OPENING = 0.16;

function torsoHalfWidth(t: number) {
  if (t < 0.1) return NECK_OPENING + (0.5 - NECK_OPENING) * Math.sqrt(Math.max(0, 1 - ((0.1 - t) / 0.1) ** 2));
  return 0.5 - 0.1 * smoothstep(0.1, 0.65, t) + 0.035 * smoothstep(0.65, 0.95, t);
}

function torsoHalfDepth(t: number) {
  const chest = 0.03 * Math.exp(-(((t - 0.3) / 0.15) ** 2)) * Math.min(1, t / 0.1);
  return 0.55 * torsoHalfWidth(t) + chest;
}

/** Front of the torso surface at (x, t): position and yaw of its normal. */
function torsoSurface(x: number, t: number) {
  const w = torsoHalfWidth(t);
  const d = torsoHalfDepth(t);
  const z = d * Math.sqrt(Math.max(0, 1 - (x / w) ** 2));
  return { y: TORSO_TOP - t * TORSO_SPAN, z, yaw: Math.atan2(x / (w * w), z / (d * d)) };
}

function torsoGeometry() {
  const rings = 40;
  const segments = 56;
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
    const s = Math.max(-1, Math.min(1, x / torsoHalfWidth(t)));
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

/** Gold name badge: "SAM", and "SignBridge" below. */
function badgeTexture() {
  const W = 512;
  const H = 192;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const gradient = g.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, "#f6dc85");
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
  g.fillText("SignBridge", W / 2, 150);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// ---- Head: a soft egg, hair cap and quiff, ears ---------------------------------------------------------------------

function eggGeometry() {
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  const p = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y >= 0) continue;
    const k = Math.pow(-y, 1.6); // narrower toward the chin
    p.setX(i, p.getX(i) * (1 - C.head.jaw * k));
    p.setZ(i, p.getZ(i) * (1 - 0.5 * C.head.jaw * k));
  }
  geometry.computeVertexNormals();
  return geometry;
}

// ---- Palm: a thin slab through the wrist and the four knuckles, rewritten in place every frame -------------------

function palmGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(30), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(30), 3).setUsage(THREE.DynamicDrawUsage));
  // Vertices 0-4: top face (PALM order), 5-9: bottom face. PALM runs counterclockwise around the palm normal.
  const index = [0, 1, 2, 0, 2, 3, 0, 3, 4, 5, 7, 6, 5, 8, 7, 5, 9, 8];
  for (let i = 0; i < 5; i++) {
    const j = (i + 1) % 5;
    index.push(5 + i, 5 + j, j, 5 + i, j, i);
  }
  geometry.setIndex(index);
  return geometry;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

function writePalmVertex(pos: Float32Array, nor: Float32Array, v: number, p: THREE.Vector3, side: number) {
  const h = (S.palmThickness / 2) * side;
  pos[v * 3] = p.x + _n.x * h;
  pos[v * 3 + 1] = p.y + _n.y * h;
  pos[v * 3 + 2] = p.z + _n.z * h;
  _b.copy(_n).multiplyScalar(side).add(_a).normalize(); // _a: outward, for rounded edges
  nor[v * 3] = _b.x;
  nor[v * 3 + 1] = _b.y;
  nor[v * 3 + 2] = _b.z;
}

function updatePalm(geometry: THREE.BufferGeometry, pts: THREE.Vector3[]) {
  const pos = geometry.attributes.position.array as Float32Array;
  const nor = geometry.attributes.normal.array as Float32Array;
  _a.subVectors(pts[5], pts[0]);
  _b.subVectors(pts[17], pts[0]);
  _n.crossVectors(_a, _b).normalize();
  _c.set(0, 0, 0);
  for (let k = 0; k < 5; k++) _c.add(pts[PALM[k]]);
  _c.multiplyScalar(1 / 5);
  for (let k = 0; k < 5; k++) {
    const p = pts[PALM[k]];
    _a.subVectors(p, _c).normalize().multiplyScalar(0.6);
    writePalmVertex(pos, nor, k, p, 1);
    writePalmVertex(pos, nor, k + 5, p, -1);
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
}

const SLEEVE_JOINTS = [[12, 14, 16], [11, 13, 15]]; // shoulder, elbow, wrist: Sam's right arm (screen left), then left

// ---- Eyes: white almond filled inside the eye line, pupil and highlight discs -------------------------------------

const EYE_RING = 4 * CURVE_STEPS; // points on the eye curve (4 face points, closed)

function eyeWhiteGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((EYE_RING + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const index: number[] = [];
  for (let i = 0; i < EYE_RING; i++) index.push(0, 1 + i, 1 + ((i + 1) % EYE_RING));
  geometry.setIndex(index);
  return geometry;
}

const eyeCurve = new Float32Array(EYE_RING * 6);

/** Fan from the eye center to the eye curve, a little behind the face strokes. */
function updateEyeWhite(geometry: THREE.BufferGeometry, eye: THREE.Vector3[], center: THREE.Vector3) {
  writeCurve(eyeCurve, 0, eye, true);
  const pos = geometry.attributes.position.array as Float32Array;
  pos[0] = center.x;
  pos[1] = center.y;
  pos[2] = center.z - 0.012;
  for (let i = 0; i < EYE_RING; i++) {
    pos[(i + 1) * 3] = eyeCurve[i * 6];
    pos[(i + 1) * 3 + 1] = eyeCurve[i * 6 + 1];
    pos[(i + 1) * 3 + 2] = eyeCurve[i * 6 + 2] - 0.012;
  }
  geometry.attributes.position.needsUpdate = true;
}

// ---- Sam ------------------------------------------------------------------------------------------------------------

export class ConciergeRig implements Rig {
  readonly root = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly bloom = false;
  readonly look: RigLook = {
    faceColor: C.features,
    browColor: C.features,
    lipColor: C.lips,
    lineWidth: C.face.lineWidth,
    browWidth: C.face.browWidth,
    lipWidth: C.face.lipWidth,
    trailColor: C.trail.color,
    trailStrength: C.trail.strength,
    trailWidth: C.trail.width,
    particleColor: C.particles,
  };

  private readonly bodyOutline = { value: 0.002 };
  private readonly handOutline = { value: 0.0015 };
  private readonly textures: THREE.Texture[] = [];
  private readonly appearing: THREE.Material[] = []; // follow the intro fade-in

  private readonly torso = new THREE.Group();
  private readonly sleeves: Sticks;
  private readonly cuffs: THREE.Mesh[];
  private readonly neck: THREE.Mesh;
  private readonly collar: THREE.Mesh;
  private readonly head = new THREE.Group();
  private readonly nose: THREE.Mesh;
  private readonly eyeWhites: THREE.Mesh[];
  private readonly pupils: THREE.Mesh[];
  private readonly highlights: THREE.Mesh[];
  private eyeCurves: THREE.Vector3[][] | null = null;
  private readonly gloves: Sticks[];
  private readonly palms: THREE.Mesh[];
  private readonly gloveMaterials: THREE.Material[];
  private readonly gloveOutlines: THREE.Material[];

  constructor() {
    const gradient = gradientMap();
    const blazerMap = blazerTexture();
    const badgeMap = badgeTexture();
    this.textures.push(gradient, blazerMap, badgeMap);

    const toon = (color: number, fade = WAIST, extra: THREE.MeshToonMaterialParameters = {}) => {
      const m = toonMaterial(color, gradient, fade, extra);
      this.appearing.push(m);
      return m;
    };
    const blazer = toon(C.blazer);
    const skin = toon(C.skin);
    const shirt = toon(C.shirt, WAIST, { side: THREE.DoubleSide });
    const hair = toon(C.hair, WAIST, { side: THREE.DoubleSide });
    const outline = outlineMaterial(this.bodyOutline, WAIST);
    this.appearing.push(outline);
    // Adds a mesh with its outline (same geometry, drawn as an inflated back-face hull).
    const outlined = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.add(new THREE.Mesh(geometry, outline));
      parent.add(mesh);
      return mesh;
    };

    const sphere = new THREE.SphereGeometry(1, 24, 16);
    const tube = new THREE.CylinderGeometry(1, 1, 1, 20, 1, false).translate(0, 0.5, 0);
    const taper = new THREE.CylinderGeometry(0.8, 1, 1, 20, 1, true).translate(0, 0.5, 0);
    const finger = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);

    // Torso, with the blazer front painted on it, and the badge on Sam's left chest (screen right).
    outlined(torsoGeometry(), toon(0xffffff, WAIST, { map: blazerMap }), this.torso);
    const { badge: B } = C;
    const spot = torsoSurface(0.24, 0.27);
    const badgeMaterial = new THREE.MeshBasicMaterial({ map: badgeMap, transparent: true });
    this.appearing.push(badgeMaterial);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(B.width, B.height / REST_SPINE), badgeMaterial);
    badge.position.set(0.24, spot.y, spot.z + 0.012);
    badge.rotation.y = spot.yaw;
    this.torso.add(badge);
    this.root.add(this.torso);

    // Sleeves: tapered tubes shoulder -> elbow -> wrist, round shoulders and elbows, white shirt cuffs.
    this.sleeves = new Sticks(taper, sphere, blazer, 4, 4, S.upperArm);
    this.root.add(...this.sleeves.meshes, ...this.sleeves.makeTwins(outline, 0));
    this.cuffs = [0, 1].map(() => outlined(tube, shirt, this.root));

    this.neck = outlined(tube, skin, this.root);
    this.collar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0), shirt);
    this.root.add(this.collar);

    // Head (unit sphere space, scaled to the face every frame): egg, hair cap tilted back, swept quiff, ears.
    outlined(eggGeometry(), skin, this.head);
    outlined(new THREE.SphereGeometry(1.08, 40, 16, 0, Math.PI * 2, 0, 0.44 * Math.PI).rotateX(-0.55), hair, this.head);
    const quiff = outlined(sphere, hair, this.head);
    quiff.position.set(0.1, 0.8, 0.45);
    quiff.scale.set(0.6, 0.2, 0.5);
    quiff.rotation.set(0.55, 0, -0.2);
    for (const side of [-1, 1]) {
      const ear = outlined(sphere, skin, this.head);
      ear.position.set(0.97 * side, 0.03, -0.05);
      ear.scale.set(0.13, 0.26, 0.11);
    }
    this.root.add(this.head);

    // Nose: a soft bump, slightly darker than the skin, no outline (an outline would read as a ring).
    this.nose = new THREE.Mesh(sphere, toon(C.skinShade));
    this.root.add(this.nose);

    // Eyes: whites behind the eye lines, pupils with a highlight. Face strokes (renderOrder 4) go on top.
    const flat = (color: number, side: THREE.Side = THREE.FrontSide) => {
      const m = new THREE.MeshBasicMaterial({ color, side, transparent: true });
      this.appearing.push(m);
      return m;
    };
    const white = flat(C.eyeWhite, THREE.DoubleSide);
    const pupilMaterial = flat(C.pupil);
    const glint = flat(0xffffff);
    const disc = new THREE.CircleGeometry(1, 24);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, order: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      return mesh;
    };
    this.eyeWhites = [0, 1].map(() => add(eyeWhiteGeometry(), white, 2));
    this.pupils = [0, 1].map(() => add(disc, pupilMaterial, 3));
    this.highlights = [0, 1].map(() => add(disc, glint, 3));

    // Gloves (overlay, drawn over everything): rounded finger capsules and a palm slab, thin outline.
    this.gloveMaterials = [0, 1].map(() => toonMaterial(C.gloves, gradient, NEVER));
    this.gloveOutlines = [0, 1].map(() => outlineMaterial(this.handOutline, NEVER));
    this.gloves = this.gloveMaterials.map((material, h) => {
      const sticks = new Sticks(finger, sphere, material, HAND_BONES.length, 21, S.finger);
      this.overlay.add(...sticks.meshes, ...sticks.makeTwins(this.gloveOutlines[h], 0));
      sticks.visible = false;
      return sticks;
    });
    this.palms = this.gloveMaterials.map((material, h) => {
      const geometry = palmGeometry();
      const palm = new THREE.Mesh(geometry, material);
      palm.add(new THREE.Mesh(geometry, this.gloveOutlines[h]));
      palm.frustumCulled = false;
      palm.children[0].frustumCulled = false;
      palm.visible = false;
      this.overlay.add(palm);
      return palm;
    });
  }

  faceFront(radii: THREE.Vector3) {
    // In front of the head surface even when it turns or nods.
    return 1.12 * Math.max(radii.x * C.head.width, radii.z * C.head.depth) + 0.01;
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
    const mid = _c.addVectors(pose[11], pose[12]).multiplyScalar(0.5);
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

    // Neck from inside the torso into the head, shirt collar around its base.
    _a.copy(mid).addScaledVector(_y, 0.04 * sy);
    _b.set(0, 1, 0).applyQuaternion(p.head.rotation).multiplyScalar(-0.45 * p.head.radii.y).add(p.head.center);
    placeSegment(this.neck, _a, _b, S.neck);
    _n.subVectors(_b, _a).normalize();
    _b.copy(_a).addScaledVector(_n, 0.19);
    _a.addScaledVector(_n, 0.09);
    placeSegment(this.collar, _a, _b, S.neck + 0.022);

    // Sleeves end a little before the wrist; the white cuff fills the gap up to the glove.
    for (let side = 0; side < 2; side++) {
      const shoulder = pose[SLEEVE_JOINTS[side][0]];
      const elbow = pose[SLEEVE_JOINTS[side][1]];
      const wrist = pose[SLEEVE_JOINTS[side][2]];
      this.sleeves.bone(side * 2, shoulder, elbow, S.upperArm);
      this.sleeves.joint(side * 2, shoulder, S.shoulder);
      this.sleeves.joint(side * 2 + 1, elbow, S.elbow);
      _n.subVectors(wrist, elbow);
      const length = _n.length();
      _n.divideScalar(length || 1);
      const sleeveLength = Math.max(0.05, length - 0.07);
      _a.copy(elbow).addScaledVector(_n, sleeveLength);
      this.sleeves.bone(side * 2 + 1, elbow, _a, S.forearm);
      _a.copy(elbow).addScaledVector(_n, sleeveLength - 0.015);
      _b.copy(elbow).addScaledVector(_n, Math.max(sleeveLength, length - 0.02));
      placeSegment(this.cuffs[side], _a, _b, S.cuff);
    }
    this.sleeves.commit();

    this.head.position.copy(p.head.center);
    this.head.quaternion.copy(p.head.rotation);
    this.head.scale.set(p.head.radii.x * C.head.width, p.head.radii.y * C.head.height, p.head.radii.z * C.head.depth);

    // Nose bump, eye whites, pupils and highlights follow the face points.
    const f = p.face;
    this.nose.position.copy(f[NOSE]).setZ(f[NOSE].z - 0.016);
    this.nose.scale.set(0.036, 0.034, 0.034);
    this.eyeCurves ??= EYES.map((idx) => idx.map((i) => f[i]));
    for (let e = 0; e < 2; e++) {
      const eye = EYES[e]; // corner, upper lid, corner, lower lid
      const center = _a.addVectors(f[eye[0]], f[eye[1]]).add(f[eye[2]]).add(f[eye[3]]).multiplyScalar(0.25);
      updateEyeWhite(this.eyeWhites[e].geometry, this.eyeCurves[e], center);
      const r = S.pupil;
      const ry = Math.min(r, f[eye[1]].distanceTo(f[eye[3]]) * 0.45); // the pupil shrinks as the eye closes
      this.pupils[e].position.set(center.x, center.y, center.z - 0.006);
      this.pupils[e].scale.set(r, ry, 1);
      this.highlights[e].position.set(center.x - r * 0.35, center.y + ry * 0.35, center.z - 0.004);
      this.highlights[e].scale.set(r * 0.32, ry * 0.32, 1);
    }

    // Gloves.
    for (let h = 0; h < 2; h++) {
      const hand = p.hands[h];
      const sticks = this.gloves[h];
      const visible = hand.hasShape && hand.opacity > 0;
      sticks.visible = visible;
      this.palms[h].visible = visible;
      this.gloveMaterials[h].opacity = hand.opacity;
      this.gloveOutlines[h].opacity = hand.opacity;
      if (!visible) continue;
      for (let i = 0; i < HAND_BONES.length; i++) {
        const b = HAND_BONES[i][1];
        sticks.bone(i, hand.pts[HAND_BONES[i][0]], hand.pts[b], b <= 4 ? S.thumb : S.finger);
      }
      for (let i = 0; i < 21; i++) sticks.joint(i, hand.pts[i], TIPS.includes(i) ? S.tip : S.knuckle);
      sticks.commit();
      updatePalm(this.palms[h].geometry, hand.pts);
    }
  }

  dispose() {
    for (const texture of this.textures) texture.dispose();
  }
}

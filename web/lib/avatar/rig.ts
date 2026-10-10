// P2: what the avatar styles share: the solved pose in world space, the Rig interface, landmark indices, Sticks.
// One world unit = one shoulder width, y up (the files are y-down, CLAUDE.md 6.2).
import * as THREE from "three";

export const BLOOM_LAYER = 1;
export const FOV = 30; // camera vertical field of view, degrees

// The torso fades out below the waist (hips are at y ≈ -1.35).
export const FADE_TOP = -0.5;
export const FADE_BOTTOM = -1.3;
export const NO_FADE = -100;

export const BODY_BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
export const BODY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24];
export const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [9, 10], [10, 11], [11, 12], // middle
  [13, 14], [14, 15], [15, 16], // ring
  [0, 17], [17, 18], [18, 19], [19, 20], // pinky
  [5, 9], [9, 13], [13, 17], // palm
];
export const TIPS = [4, 8, 12, 16, 20];
export const PALM = [0, 5, 9, 13, 17];

// Face points, in the CLAUDE.md 6.1 order.
export const BROWS = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]]; // right brow outer -> inner, left brow inner -> outer
export const BROW_INNER_WEIGHT = [0.35, 0.5, 0.7, 0.9, 1, 1, 0.9, 0.7, 0.5, 0.35];
export const EYES = [[10, 12, 11, 13], [14, 16, 15, 17]]; // corner, upper lid, corner, lower lid
export const UPPER_LIDS = [12, 16];
export const MOUTH = [[18, 20, 19, 21], [18, 22, 19, 23]]; // outer lips, inner lips
export const NOSE = 24;
export const CHIN = 25;

export type HandPose = {
  pts: THREE.Vector3[]; // 21 world points
  hasShape: boolean; // false until the hand has been seen once
  opacity: number; // fades a missing hand out (and back in)
};

/** The landmarks of the current frame, solved into world space. Rigs dress it; they never change it. */
export type WorldPose = {
  pose: THREE.Vector3[]; // 33, wrists moved onto the hand wrists
  hands: HandPose[]; // 0 = left (lh), 1 = right (rh)
  face: THREE.Vector3[]; // 26, brows already moved by BROWS-UP / BROWS-DOWN, z on the face front
  head: { center: THREE.Vector3; radii: THREE.Vector3; rotation: THREE.Quaternion };
  neckBase: THREE.Vector3;
  neckTop: THREE.Vector3;
  hipMid: THREE.Vector3;
  appear: number; // 0..1 during the intro
};

/** Shared elements (face strokes, trails, particles) take their look from the active rig. Widths in CSS pixels. */
export type RigLook = {
  faceColor: number; // eyes and mouth opening
  browColor: number;
  lipColor: number; // outer lip line
  lineWidth: number;
  browWidth: number;
  lipWidth: number;
  trailColor: number;
  trailStrength: number;
  trailWidth: number;
  particleColor: number;
  /** false when the rig draws its own face features: the shared face lines are hidden. Default true. */
  faceStrokes?: boolean;
};

export interface Rig {
  /** Added to the main scene. */
  readonly root: THREE.Object3D;
  /** Added to the overlay scene, drawn last over everything: the hands. */
  readonly overlay: THREE.Object3D;
  readonly bloom: boolean;
  readonly look: RigLook;
  /** Depth of the face strokes in front of the head center. */
  faceFront(radii: THREE.Vector3): number;
  /** Dresses the pose. May move p.head.center / p.head.radii to where it draws the head (the intro particles use them). */
  update(p: WorldPose): void;
  /** Called on resize with the canvas height in CSS pixels. */
  resize(height: number): void;
  /** Frees what scene traversal does not (textures). */
  dispose(): void;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Smooth curves through face points (Catmull-Rom), written as line segments into a flat buffer.
export const CURVE_STEPS = 4;

const catmull = (a: number, b: number, c: number, d: number, t: number, t2: number, t3: number) =>
  0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);

export function catmullRom(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: Float32Array, o: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  out[o] = catmull(p0.x, p1.x, p2.x, p3.x, t, t2, t3);
  out[o + 1] = catmull(p0.y, p1.y, p2.y, p3.y, t, t2, t3);
  out[o + 2] = catmull(p0.z, p1.z, p2.z, p3.z, t, t2, t3);
}

/** Writes CURVE_STEPS segments (start xyz, end xyz) per span into out. Returns the next offset. */
export function writeCurve(out: Float32Array, offset: number, pts: THREE.Vector3[], closed: boolean): number {
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

export const curveSegments = (curves: number[][], closed: boolean) =>
  curves.reduce((sum, c) => sum + (closed ? c.length : c.length - 1) * CURVE_STEPS, 0);

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Instanced bones (cylinders spanning y = 0..1) and joints (spheres). Joints cover the bone ends, so they read as capsules. */
export class Sticks {
  readonly bones: THREE.InstancedMesh;
  readonly joints: THREE.InstancedMesh;
  readonly meshes: THREE.InstancedMesh[];
  readonly twins: THREE.InstancedMesh[] = [];

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
    this.meshes = [this.bones, this.joints];
    for (const mesh of this.meshes) {
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
    for (const mesh of this.meshes) mesh.visible = value;
    for (const mesh of this.twins) mesh.visible = value;
  }

  /** The same instances drawn with another material (instance matrices are shared): outlines, bloom masks. */
  makeTwins(material: THREE.Material, layer: number): THREE.InstancedMesh[] {
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

/** Places an object whose geometry spans y = 0..1 between a and b, with the given radius. */
export function placeSegment(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  _d.subVectors(b, a);
  const length = _d.length();
  obj.position.copy(a);
  if (length < 1e-6) {
    obj.scale.setScalar(1e-6);
    return;
  }
  obj.quaternion.setFromUnitVectors(UP, _d.divideScalar(length));
  obj.scale.set(radius, length, radius);
}

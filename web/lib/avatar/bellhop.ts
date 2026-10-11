// P2: the "bellhop" style: a rigged 3D cartoon bellhop (web/public/avatar/bellhop.glb: Tripo mesh, Mixamo skeleton)
// that signs by retargeting the solved landmarks onto its bones every frame. Glossy toy look (clearcoat PBR).
// The cartoon body has short arms, big hands and a big head: arms are solved with two-bone IK toward targets scaled
// to its own reach and kept in front of its chest and face; hands and fingers copy the landmark orientations.
// Model units = the GLB's own (height ~0.98, facing +z, left arm on +x); world units = shoulder widths.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { HandPose, Rig, RigLook, WorldPose } from "./rig";
import { THEME } from "./theme";

const B = THEME.bellhop;
const deg = THREE.MathUtils.degToRad;

// Front of the body, measured on bellhop.glb (model units): height y -> half width, z of the front surface at x = 0.
// Chest, shoulders, collar, then the head. Hands are pushed in front of it.
const BODY_FRONT: [number, number, number][] = [
  [0.5, 0.06, 0.055],
  [0.54, 0.078, 0.072],
  [0.6, 0.075, 0.069],
  [0.66, 0.085, 0.066],
  [0.7, 0.091, 0.053],
  [0.74, 0.094, 0.04],
  [0.78, 0.045, 0.065],
  [0.82, 0.078, 0.093],
  [0.9, 0.104, 0.099],
  [0.94, 0.086, 0.083],
  [0.98, 0.056, 0.035],
];

function bodyFront(x: number, y: number): number {
  const first = BODY_FRONT[0];
  const last = BODY_FRONT[BODY_FRONT.length - 1];
  if (y < first[0] || y > last[0]) return -Infinity;
  let i = 0;
  while (i < BODY_FRONT.length - 2 && y > BODY_FRONT[i + 1][0]) i++;
  const [y0, w0, z0] = BODY_FRONT[i];
  const [y1, w1, z1] = BODY_FRONT[i + 1];
  const t = (y - y0) / (y1 - y0);
  const halfWidth = w0 + (w1 - w0) * t;
  if (Math.abs(x) >= halfWidth) return -Infinity;
  return (z0 + (z1 - z0) * t) * Math.sqrt(1 - (x / halfWidth) ** 2);
}

// Finger chains: landmark indices (base to tip) and joint limits per phalanx: flex min, flex max, sideways max.
const FINGERS = [
  { name: "Thumb", pts: [1, 2, 3, 4], limits: [[-30, 60, 40], [-10, 70, 10], [-10, 80, 10]] },
  { name: "Index", pts: [5, 6, 7, 8], limits: [[-20, 95, 20], [-5, 110, 0], [-5, 90, 0]] },
  { name: "Middle", pts: [9, 10, 11, 12], limits: [[-20, 95, 15], [-5, 110, 0], [-5, 90, 0]] },
  { name: "Ring", pts: [13, 14, 15, 16], limits: [[-20, 95, 15], [-5, 110, 0], [-5, 90, 0]] },
  { name: "Pinky", pts: [17, 18, 19, 20], limits: [[-20, 95, 25], [-5, 110, 0], [-5, 90, 0]] },
] as const;

type Phalanx = {
  bone: THREE.Object3D;
  rest: THREE.Quaternion; // rest local rotation
  axis: THREE.Vector3; // rest bone direction, in the parent's space
  flex: THREE.Vector3; // palm side, perpendicular to axis, in the parent's space
  side: THREE.Vector3; // axis x flex: sideways (abduction) direction
  relaxed: THREE.Quaternion; // relaxed local rotation
  from: number; // landmark indices
  to: number;
  limits: [number, number, number]; // radians
  target: THREE.Quaternion;
};

type Arm = {
  side: 0 | 1; // 0 = left (lh, pose 11/13), 1 = right (rh, pose 12/14)
  shoulderPt: number;
  elbowPt: number;
  sign: number; // +1 left, -1 right: palm normal = sign * (forward x side), and x of the arm's side
  arm: THREE.Object3D;
  forearm: THREE.Object3D;
  hand: THREE.Object3D;
  armRest: THREE.Quaternion;
  foreRest: THREE.Quaternion;
  handRest: THREE.Quaternion;
  armAxis: THREE.Vector3; // rest bone direction in the parent's space
  foreAxis: THREE.Vector3;
  foreTwistAxis: THREE.Vector3; // forearm direction in its own space (the twist axis)
  upper: number; // bone lengths (model units)
  lower: number;
  palm: number; // hand bone to middle knuckle
  mcp: THREE.Vector3; // middle knuckle in the hand bone's own space
  handRestWorld: THREE.Quaternion; // hand rotation in the model at rest
  restBasis: THREE.Quaternion; // knuckle basis at rest (see basis())
  fingers: Phalanx[];
  pts: THREE.Vector3[]; // landmarks with the hand depth restored
};

type Model = {
  scene: THREE.Object3D;
  materials: THREE.MeshPhysicalMaterial[];
  shoulderMid: THREE.Vector3; // model units
  shoulderWidth: number;
  reach: number; // shoulder to middle knuckle, arm stretched
  neck: THREE.Object3D;
  head: THREE.Object3D;
  neckRest: THREE.Quaternion;
  headRest: THREE.Quaternion;
  headRestWorld: THREE.Quaternion;
  headCenter: THREE.Vector3; // head center in the head bone's space
  arms: Arm[];
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _s = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _t = new THREE.Quaternion();
const _hand = new THREE.Quaternion(); // hand target, world
const _fore = new THREE.Quaternion(); // forearm target, local
const _foreW = new THREE.Quaternion(); // forearm target, world
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/** q becomes the rotation `t` of the way from no rotation to q. */
function partial(q: THREE.Quaternion, t: number) {
  return q.copy(_t.identity().slerp(q, t));
}

let gltfPromise: Promise<THREE.Object3D> | null = null;

/** Loads the GLB once per page; every rig instance clones it. */
function loadBellhop(): Promise<THREE.Object3D> {
  gltfPromise ??= new GLTFLoader().loadAsync(B.url).then((gltf) => gltf.scene);
  return gltfPromise;
}

/** Orthonormal basis from the knuckles: x = wrist -> middle knuckle, y = pinky -> index knuckle (made perpendicular), z = x * y. */
function basis(wrist: THREE.Vector3, index: THREE.Vector3, middle: THREE.Vector3, pinky: THREE.Vector3, out: THREE.Quaternion) {
  _x.subVectors(middle, wrist).normalize();
  _y.subVectors(index, pinky);
  _y.addScaledVector(_x, -_y.dot(_x)).normalize();
  _z.crossVectors(_x, _y);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

/** Local rotation that turns the bone (rest `rest`, rest direction `axis` in parent space) toward `dir` (world). Swing only. */
function aim(bone: THREE.Object3D, rest: THREE.Quaternion, axis: THREE.Vector3, dir: THREE.Vector3, out: THREE.Quaternion) {
  bone.parent!.getWorldQuaternion(_pq).invert();
  _d.copy(dir).applyQuaternion(_pq).normalize();
  return out.setFromUnitVectors(axis, _d).multiply(rest);
}

/** Two-bone IK: elbow position for shoulder s, target t, lengths a (upper) and b (lower), bending toward pole. */
function solveElbow(s: THREE.Vector3, t: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, out: THREE.Vector3) {
  _a.subVectors(t, s);
  const d = THREE.MathUtils.clamp(_a.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
  _a.normalize();
  _b.subVectors(pole, s);
  _b.addScaledVector(_a, -_b.dot(_a));
  if (_b.lengthSq() < 1e-8) _b.set(0, -1, 0).addScaledVector(_a, -_a.y);
  _b.normalize();
  const along = (a * a - b * b + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, a * a - along * along));
  return out.copy(s).addScaledVector(_a, along).addScaledVector(_b, height);
}

/** Keeps the part of `q` that twists around unit `axis`. */
function twistAround(q: THREE.Quaternion, axis: THREE.Vector3, out: THREE.Quaternion) {
  const dot = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  out.set(axis.x * dot, axis.y * dot, axis.z * dot, q.w);
  return out.lengthSq() < 1e-10 ? out.identity() : out.normalize();
}

function boneMap(root: THREE.Object3D) {
  const bones = new Map<string, THREE.Object3D>();
  // GLTFLoader strips the ":" from "mixamorig:LeftArm".
  root.traverse((o) => bones.set(o.name.replace(/[^A-Za-z0-9]/g, "").replace(/^mixamorig/, ""), o));
  return (name: string) => {
    const bone = bones.get(name);
    if (!bone) throw new Error(`bellhop.glb: no bone ${name}`);
    return bone;
  };
}

function worldPos(o: THREE.Object3D) {
  return o.getWorldPosition(new THREE.Vector3());
}

function worldQuat(o: THREE.Object3D) {
  return o.getWorldQuaternion(new THREE.Quaternion());
}

/** Rest data of one arm. The model must be at rest with an identity root. */
function setupArm(bone: (name: string) => THREE.Object3D, side: 0 | 1): Arm {
  const prefix = side === 0 ? "Left" : "Right";
  const sign = side === 0 ? 1 : -1;
  const arm = bone(`${prefix}Arm`);
  const forearm = bone(`${prefix}ForeArm`);
  const hand = bone(`${prefix}Hand`);
  const knuckle = (finger: string) => bone(`${prefix}Hand${finger}1`);
  const handRestWorld = worldQuat(hand);
  const restBasis = basis(worldPos(hand), worldPos(knuckle("Index")), worldPos(knuckle("Middle")), worldPos(knuckle("Pinky")), new THREE.Quaternion());
  const palmNormal = new THREE.Vector3(0, 0, sign).applyQuaternion(restBasis); // palm side of the hand, world

  const fingers: Phalanx[] = [];
  for (const finger of FINGERS) {
    for (let k = 0; k < 3; k++) {
      const b = bone(`${prefix}Hand${finger.name}${k + 1}`);
      const child = bone(`${prefix}Hand${finger.name}${k + 2}`);
      const rest = b.quaternion.clone();
      const axis = child.position.clone().normalize().applyQuaternion(rest);
      const parentInv = worldQuat(b.parent!).invert();
      const flex = palmNormal.clone().applyQuaternion(parentInv);
      flex.addScaledVector(axis, -flex.dot(axis)).normalize();
      const sideways = new THREE.Vector3().crossVectors(axis, flex);
      const curl = B.restCurl[k];
      const relaxedDir = axis.clone().multiplyScalar(Math.cos(curl)).addScaledVector(flex, Math.sin(curl));
      const [lo, hi, abd] = finger.limits[k];
      fingers.push({
        bone: b,
        rest,
        axis,
        flex,
        side: sideways,
        relaxed: new THREE.Quaternion().setFromUnitVectors(axis, relaxedDir).multiply(rest),
        from: finger.pts[k],
        to: finger.pts[k + 1],
        limits: [deg(lo), deg(hi), deg(abd)],
        target: new THREE.Quaternion(),
      });
    }
  }

  return {
    side,
    shoulderPt: side === 0 ? 11 : 12,
    elbowPt: side === 0 ? 13 : 14,
    sign,
    arm,
    forearm,
    hand,
    armRest: arm.quaternion.clone(),
    foreRest: forearm.quaternion.clone(),
    handRest: hand.quaternion.clone(),
    armAxis: forearm.position.clone().normalize().applyQuaternion(arm.quaternion),
    foreAxis: hand.position.clone().normalize().applyQuaternion(forearm.quaternion),
    foreTwistAxis: hand.position.clone().normalize(),
    upper: forearm.position.length(),
    lower: hand.position.length(),
    palm: knuckle("Middle").position.length(),
    mcp: knuckle("Middle").position.clone(),
    handRestWorld,
    restBasis,
    fingers,
    pts: Array.from({ length: 21 }, () => new THREE.Vector3()),
  };
}

/** Glossy toy material that keeps the model's textures. */
function glossy(src: THREE.MeshStandardMaterial, envMap: THREE.Texture) {
  const m = B.material;
  return new THREE.MeshPhysicalMaterial({
    name: src.name,
    color: src.color,
    map: src.map,
    normalMap: src.normalMap,
    normalScale: src.normalScale,
    roughnessMap: src.roughnessMap,
    metalnessMap: src.metalnessMap,
    roughness: src.roughness,
    metalness: src.metalness,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    sheen: m.sheen,
    sheenRoughness: m.sheenRoughness,
    envMap,
    envMapIntensity: m.envMapIntensity,
  });
}

export class BellhopRig implements Rig {
  readonly root = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly bloom = false;
  readonly frame = B.frame;
  readonly look: RigLook = {
    faceColor: 0x000000,
    browColor: 0x000000,
    lipColor: 0x000000,
    lineWidth: 0,
    browWidth: 0,
    lipWidth: 0,
    trailColor: B.particles,
    trailStrength: 0, // fingertip trails follow the landmarks, not this body's hands
    trailWidth: 0,
    particleColor: B.particles,
    faceStrokes: false, // no face blendshapes on this model; the shared lines would float off its face
  };

  private readonly body = new THREE.Group();
  private model: Model | null = null;
  private envMap: THREE.Texture | null = null;
  private disposed = false;
  private lastTime = -1;
  private opaque = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.body.visible = false;
    const rim = new THREE.DirectionalLight(B.rimLight.color, B.rimLight.intensity);
    rim.position.set(-3, 4, -5);
    this.root.add(this.body, rim, rim.target);
    loadBellhop()
      .then((scene) => {
        if (!this.disposed) this.setup(cloneSkinned(scene));
      })
      .catch((err) => console.warn("[avatar] bellhop.glb failed to load:", err));
  }

  private setup(scene: THREE.Object3D) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const materials: THREE.MeshPhysicalMaterial[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // skinned bounds do not follow the bones
      const material = glossy(mesh.material as THREE.MeshStandardMaterial, this.envMap!);
      mesh.material = material;
      materials.push(material);
    });

    scene.updateMatrixWorld(true);
    const bone = boneMap(scene);
    const left = worldPos(bone("LeftArm"));
    const right = worldPos(bone("RightArm"));
    const arms = [setupArm(bone, 0), setupArm(bone, 1)];
    const head = bone("Head");
    const headTop = worldPos(bone("HeadTopEnd"));
    const headPos = worldPos(head);
    this.model = {
      scene,
      materials,
      shoulderMid: left.clone().add(right).multiplyScalar(0.5),
      shoulderWidth: left.distanceTo(right),
      reach: arms[0].upper + arms[0].lower + arms[0].palm,
      neck: bone("Neck"),
      head,
      neckRest: bone("Neck").quaternion.clone(),
      headRest: head.quaternion.clone(),
      headRestWorld: worldQuat(head),
      headCenter: head.worldToLocal(headPos.clone().lerp(headTop, 0.45)),
      arms,
    };
    this.body.add(scene);
  }

  faceFront(radii: THREE.Vector3) {
    return 0.92 * radii.z;
  }

  update(p: WorldPose) {
    const model = this.model;
    if (!model) return;
    const now = performance.now() / 1000;
    const dt = this.lastTime < 0 ? 1 : Math.min(0.1, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    const alpha = 1 - Math.pow(1 - B.smoothing, dt * 30); // frame-rate independent smoothing

    this.body.visible = p.appear > 0;
    this.fade(model, p.appear);
    if (!this.body.visible) return;

    const scale = this.placeBody(model, p, alpha);
    this.solveHead(model, p, alpha);
    for (const arm of model.arms) this.solveArm(model, arm, p, scale, alpha);

    // The intro particles gather on the cartoon head.
    model.head.localToWorld(p.head.center.copy(model.headCenter));
    p.head.radii.set(0.11, 0.14, 0.11).multiplyScalar(scale);
  }

  private fade(model: Model, appear: number) {
    const opaque = appear >= 1;
    if (opaque === this.opaque && opaque) return;
    for (const m of model.materials) {
      m.opacity = appear;
      if (m.transparent === opaque) {
        m.transparent = !opaque;
        m.needsUpdate = true;
      }
    }
    this.opaque = opaque;
  }

  /** Root: shoulders on the landmark shoulders, scaled from the shoulder width, turned like the shoulder line. Returns the scale. */
  private placeBody(model: Model, p: WorldPose, alpha: number) {
    const { pose } = p;
    _x.subVectors(pose[11], pose[12]);
    const width = Math.max(_x.length(), 1e-3);
    _x.divideScalar(width);
    // Clamp yaw (shoulder line depth) and roll (shoulder line slope), so a noisy frame never spins the body.
    const yaw = THREE.MathUtils.clamp(Math.atan2(-_x.z, _x.x), -B.torso.maxYaw, B.torso.maxYaw);
    const roll = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(_x.y, -1, 1)), -B.torso.maxRoll, B.torso.maxRoll);
    _q.setFromAxisAngle(UP, yaw).multiply(_q2.setFromAxisAngle(FORWARD, roll));
    this.body.quaternion.slerp(_q, alpha);

    const scale = width / model.shoulderWidth;
    this.body.scale.setScalar(scale);
    _a.copy(model.shoulderMid).multiplyScalar(scale).applyQuaternion(this.body.quaternion);
    this.body.position.subVectors(p.neckBase, _a);
    this.body.updateMatrixWorld(true);
    return scale;
  }

  private solveHead(model: Model, p: WorldPose, alpha: number) {
    const { neck, head } = model;
    // Target head rotation in the world: the face rotation applied to the rest head.
    const target = _hand.copy(p.head.rotation).multiply(model.headRestWorld);
    // The rotation from the rest head (neck at rest) to the target is shared between the neck and the head.
    neck.parent!.getWorldQuaternion(_pq);
    _q.copy(_pq).multiply(model.neckRest); // neck, world, at rest
    _q2.copy(_q).multiply(model.headRest).invert().premultiply(target); // rest head -> target, world
    partial(_q2, B.neckShare);
    _q.premultiply(_q2).premultiply(_pq.invert()); // neck target, local
    neck.quaternion.slerp(_q, alpha);
    neck.getWorldQuaternion(_pq).invert();
    head.quaternion.slerp(_q.copy(_pq).multiply(target), alpha);
  }

  private solveArm(model: Model, arm: Arm, p: WorldPose, scale: number, alpha: number) {
    const hand = p.hands[arm.side];
    const w = hand.hasShape ? hand.opacity : 0; // 0: relaxed arm and hand
    const pts = this.restoreDepth(hand, arm.pts);
    const S = arm.arm.getWorldPosition(_s);

    if (w > 0) {
      // Hand rotation (world) from the knuckle basis: target basis * rest basis^-1, applied to the rest hand.
      basis(pts[0], pts[5], pts[9], pts[17], _q);
      _hand.copy(_q).multiply(_q2.copy(arm.restBasis).invert()).multiply(arm.handRestWorld);

      // Targets: the middle knuckle, as an offset from the shoulder scaled to the bellhop's reach.
      const k = (model.reach * scale) / B.humanReach;
      const shoulderPt = p.pose[arm.shoulderPt];
      _c.subVectors(pts[9], shoulderPt).multiplyScalar(k).add(S); // knuckle target
      // Wrist = knuckle target minus the bellhop's own palm, turned like the hand.
      _w.copy(arm.mcp).multiplyScalar(scale).applyQuaternion(_hand);
      _w.subVectors(_c, _w);
      this.pushOut(model, _w, pts, scale, arm.palm / Math.max(pts[9].distanceTo(pts[0]), 0.05));

      // Elbow from two-bone IK, bending toward the landmark elbow.
      _e.subVectors(p.pose[arm.elbowPt], shoulderPt).multiplyScalar(k).add(S);
      solveElbow(S, _w, arm.upper * scale, arm.lower * scale, _e, _e);
      _a.subVectors(_e, S).normalize();
      _b.subVectors(_w, _e).normalize();
    }

    // Directions, blended toward the relaxed arm while the hand is missing.
    if (w < 1) {
      const ra = B.restArm;
      _x.set(ra.upper[0] * arm.sign, ra.upper[1], ra.upper[2]).normalize().applyQuaternion(this.body.quaternion);
      _y.set(ra.fore[0] * arm.sign, ra.fore[1], ra.fore[2]).normalize().applyQuaternion(this.body.quaternion);
      if (w === 0) {
        _a.copy(_x);
        _b.copy(_y);
      } else {
        _a.multiplyScalar(w).addScaledVector(_x, 1 - w).normalize();
        _b.multiplyScalar(w).addScaledVector(_y, 1 - w).normalize();
      }
    }
    arm.arm.quaternion.slerp(aim(arm.arm, arm.armRest, arm.armAxis, _a, _q), alpha);

    // Forearm aim, plus part of the wrist twist (the forearm turns along its length, the hand carries the rest).
    aim(arm.forearm, arm.foreRest, arm.foreAxis, _b, _fore);
    arm.arm.getWorldQuaternion(_foreW).multiply(_fore);
    _hand.copy(this.relaxedHand(arm, _b, _q).slerp(_hand, w)); // hand target, world
    _q.copy(_hand);
    _q.premultiply(_pq.copy(_foreW).invert()); // hand target relative to the forearm target
    partial(twistAround(_q, arm.foreTwistAxis, _q2), B.forearmTwist);
    arm.forearm.quaternion.slerp(_fore.multiply(_q2), alpha);
    // The hand reaches its world target from wherever the smoothed forearm is.
    arm.forearm.getWorldQuaternion(_pq).invert();
    arm.hand.quaternion.slerp(_q.copy(_pq).multiply(_hand), alpha);

    // Fingers: each phalanx points at the next landmark, within natural limits.
    for (const f of arm.fingers) {
      _q.copy(f.relaxed);
      if (w > 0) {
        f.bone.parent!.getWorldQuaternion(_pq).invert();
        _d.subVectors(pts[f.to], pts[f.from]).applyQuaternion(_pq).normalize();
        const [lo, hi, abd] = f.limits;
        const flex = THREE.MathUtils.clamp(Math.atan2(_d.dot(f.flex), _d.dot(f.axis)), lo, hi);
        const sideways = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(_d.dot(f.side), -1, 1)), -abd, abd);
        _d.copy(f.axis).multiplyScalar(Math.cos(flex)).addScaledVector(f.flex, Math.sin(flex));
        _d.multiplyScalar(Math.cos(sideways)).addScaledVector(f.side, Math.sin(sideways));
        f.target.setFromUnitVectors(f.axis, _d).multiply(f.rest);
        _q.slerp(f.target, w);
      }
      f.bone.quaternion.slerp(_q, alpha);
    }
  }

  /** Relaxed hand (world): along the forearm, palm toward the thigh. */
  private relaxedHand(arm: Arm, fore: THREE.Vector3, out: THREE.Quaternion) {
    _x.copy(fore).normalize();
    // Palm toward the body's midline, a little forward; basis z = sign * palm (see basis()).
    _z.set(-1, 0, 0.2 * arm.sign).applyQuaternion(this.body.quaternion);
    _z.addScaledVector(_x, -_z.dot(_x)).normalize();
    _y.crossVectors(_z, _x);
    out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    return out.multiply(_q2.copy(arm.restBasis).invert()).multiply(arm.handRestWorld);
  }

  /** Hand landmarks with their depth (relative to the wrist) partly restored: the solver flattens it. */
  private restoreDepth(hand: HandPose, out: THREE.Vector3[]) {
    const z0 = hand.pts[0].z;
    for (let i = 0; i < 21; i++) {
      const v = hand.pts[i];
      out[i].set(v.x, v.y, z0 + (v.z - z0) * B.handDepth);
    }
    return out;
  }

  /** Moves the wrist target forward until the hand is in front of the chest and face. */
  private pushOut(model: Model, wrist: THREE.Vector3, pts: THREE.Vector3[], scale: number, handScale: number) {
    const inverse = _m.copy(this.body.matrixWorld).invert();
    let push = 0;
    for (const i of [0, 5, 9, 13, 17, 4, 8, 12, 16, 20]) {
      // Hand point on the bellhop: wrist + landmark offset scaled to its hand, in model units.
      _a.subVectors(pts[i], pts[0]).multiplyScalar(handScale * scale).add(wrist).applyMatrix4(inverse);
      const front = bodyFront(_a.x, _a.y);
      if (front > -Infinity) push = Math.max(push, front + B.bodyGap - _a.z);
    }
    if (push > 0) wrist.add(_a.set(0, 0, push * scale).applyQuaternion(this.body.quaternion));
  }

  resize() {}

  dispose() {
    this.disposed = true;
    this.envMap?.dispose();
    for (const m of this.model?.materials ?? []) {
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) t?.dispose();
    }
  }
}

// P2: the "hologram" style: glowing capsule bones (bloomed), a see-through head shell, sharp amber hands.
import * as THREE from "three";
import {
  BLOOM_LAYER,
  BODY_BONES,
  BODY_JOINTS,
  FADE_BOTTOM,
  FADE_TOP,
  HAND_BONES,
  NO_FADE,
  NOSE,
  Sticks,
  TIPS,
  type Rig,
  type RigLook,
  type WorldPose,
} from "./rig";
import { THEME } from "./theme";

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

export class HologramRig implements Rig {
  readonly root = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly bloom = true;
  readonly look: RigLook = {
    faceColor: THEME.face.color,
    browColor: THEME.face.browColor,
    lipColor: THEME.face.color,
    lineWidth: THEME.face.lineWidth,
    browWidth: THEME.face.browWidth,
    lipWidth: THEME.face.lineWidth,
    trailColor: THEME.trail.color,
    trailStrength: 1,
    trailWidth: THEME.trail.width,
    particleColor: THEME.body.color,
  };

  private readonly bodyMaterial = holoMaterial(THEME.body.color, THEME.body.rim, FADE_TOP, FADE_BOTTOM);
  private readonly handMaterials = [0, 1].map(() => holoMaterial(THEME.hands.color, THEME.hands.rim, NO_FADE + 1, NO_FADE));
  private readonly blackMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private readonly body: Sticks;
  private readonly hands: Sticks[];
  private readonly headMaterial: THREE.ShaderMaterial;
  private readonly head: THREE.Mesh;
  private readonly nose: THREE.Mesh;

  constructor() {
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0);
    const sphere = new THREE.SphereGeometry(1, 18, 12);

    // Body: 8 pose bones + neck + spine, 8 pose joints + neck base.
    this.body = new Sticks(cylinder, sphere, this.bodyMaterial, BODY_BONES.length + 2, BODY_JOINTS.length + 1, THEME.body.boneRadius);
    for (const mesh of this.body.meshes) {
      mesh.layers.enable(BLOOM_LAYER);
      this.root.add(mesh);
    }

    // Hands live in the overlay; their black twins mask the body glow behind them in the bloom pass.
    this.hands = this.handMaterials.map((material) => {
      const sticks = new Sticks(cylinder, sphere, material, HAND_BONES.length, 21, THEME.hands.boneRadius);
      this.overlay.add(...sticks.meshes);
      this.root.add(...sticks.makeTwins(this.blackMaterial, BLOOM_LAYER));
      sticks.visible = false;
      return sticks;
    });

    this.headMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(THEME.head.color) }, uOpacity: { value: 1 } },
      vertexShader: HOLO_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), this.headMaterial);
    this.head.renderOrder = 1;
    this.nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 12, 8),
      new THREE.MeshBasicMaterial({ color: THEME.face.color, transparent: true }),
    );
    this.nose.renderOrder = 3;
    this.root.add(this.head, this.nose);
  }

  faceFront(radii: THREE.Vector3) {
    return 0.92 * radii.z;
  }

  update(p: WorldPose) {
    const { pose, neckBase, neckTop, hipMid } = p;
    const { boneRadius, jointRadius } = THEME.body;
    for (let i = 0; i < BODY_BONES.length; i++) this.body.bone(i, pose[BODY_BONES[i][0]], pose[BODY_BONES[i][1]]);
    this.body.bone(BODY_BONES.length, neckBase, neckTop, boneRadius * 0.9);
    this.body.bone(BODY_BONES.length + 1, neckBase, hipMid, boneRadius * 0.6);
    for (let i = 0; i < BODY_JOINTS.length; i++) {
      const j = BODY_JOINTS[i];
      // Wrist joints shrink when a hand is shown, so they never cover the palm.
      const hand = j === 15 ? p.hands[0] : j === 16 ? p.hands[1] : null;
      this.body.joint(i, pose[j], jointRadius * (hand ? 1 - 0.5 * hand.opacity : 1));
    }
    this.body.joint(BODY_JOINTS.length, neckBase, jointRadius * 0.8);
    this.body.commit();

    this.head.position.copy(p.head.center);
    this.head.quaternion.copy(p.head.rotation);
    this.head.scale.copy(p.head.radii);
    this.nose.position.copy(p.face[NOSE]);

    for (let h = 0; h < 2; h++) {
      const hand = p.hands[h];
      const sticks = this.hands[h];
      const visible = hand.hasShape && hand.opacity > 0;
      sticks.visible = visible;
      this.handMaterials[h].uniforms.uOpacity.value = hand.opacity;
      if (!visible) continue;
      for (let i = 0; i < HAND_BONES.length; i++) sticks.bone(i, hand.pts[HAND_BONES[i][0]], hand.pts[HAND_BONES[i][1]]);
      for (let i = 0; i < 21; i++) {
        sticks.joint(i, hand.pts[i], TIPS.includes(i) ? THEME.hands.tipRadius : THEME.hands.jointRadius);
      }
      sticks.commit();
    }

    this.bodyMaterial.uniforms.uOpacity.value = p.appear;
    this.headMaterial.uniforms.uOpacity.value = p.appear;
    (this.nose.material as THREE.MeshBasicMaterial).opacity = p.appear;
  }

  resize() {}

  dispose() {}
}

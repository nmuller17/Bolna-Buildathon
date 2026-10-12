// P2: every visual setting of the avatar in one place, so the look can change without touching the renderer.
// Sizes are in shoulder widths (the normalization unit, CLAUDE.md 6.2).

export const THEME = {
  defaultStyle: "bellhop", // "hologram" | "concierge" | "bellhop"

  // Shared background (both styles).
  background: 0x050a14,
  grid: { color: 0x123a6b, centerColor: 0x1f6fb2, opacity: 0.55, size: 40, divisions: 80 },

  // Facial markers, as fractions of the brow-to-chin height (squeeze: of the eye span).
  brows: { raise: 0.14, lower: 0.09, squeeze: 0.12, lid: 0.035 },

  // ---- "hologram" style ----
  body: { color: 0x38bdf8, rim: 0xc9f1ff, boneRadius: 0.034, jointRadius: 0.052 },
  // Hands carry the meaning: brighter, warmer, thicker joints, and never bloomed.
  hands: { color: 0xffb02e, rim: 0xfff1cf, boneRadius: 0.013, jointRadius: 0.021, tipRadius: 0.024 },
  head: { color: 0x7dd3fc },
  face: { color: 0xeefaff, browColor: 0xffffff, lineWidth: 2.4, browWidth: 4 }, // widths in CSS pixels
  trail: { color: 0xffc061, width: 3, samples: 10 },
  particles: { count: 1800, size: 3.2 },
  bloom: { strength: 0.6, radius: 0.3, threshold: 0 },

  // ---- "concierge" style: Sam, the ConversAI receptionist (original character), soft 3D cartoon ----
  concierge: {
    skin: 0xeba57c,
    skinShade: 0xdb8e66, // nose
    blush: 0xff7f7a,
    hair: 0x4b2a1a,
    brow: 0x3a2116,
    eyeWhite: 0xfdfbf7,
    eyeLine: 0x3a2418,
    pupil: 0x2a170f,
    mouthLine: 0x6e2c25,
    mouthInside: 0x7c2532,
    blazer: 0x1c2f66,
    lapel: 0x16275a,
    seam: 0x101c40,
    shirt: 0xf7f9fc,
    shirtShade: 0xc9d2de,
    tie: 0x10a596, // ConversAI teal
    tieShade: 0x0b7a70,
    gold: 0xe3b53f,
    goldShade: 0xa27b1c,
    badgeText: 0x1c1917,
    gloves: 0xfbfaf5, // set to `skin` for bare hands
    outline: 0x2b2233, // dark navy-brown, softer than black

    // Soft shading: a 5-tone ramp read with linear filtering (smooth wrap lighting, no hard bands).
    toneSteps: [118, 152, 188, 224, 255],
    light: { key: 2.6, sky: 0xeef2ff, ground: 0x4a3a40, ambient: 1.15 },
    rim: { color: 0xb3dcff, strength: 0.22 },
    outlinePx: 1.3,
    handOutlinePx: 1.1,

    // Cartoon head: fixed size (radii in shoulder widths x scale), resting on the shoulders.
    head: {
      scale: 1.3, // 1.4+ needs a wider camera framing (the hair reaches the top of the frame)
      radii: { x: 0.26, y: 0.335, z: 0.25 },
      jaw: 0.08, // chin narrowing (0 = round)
      lift: 0.2, // height of the chin above the shoulder line
      follow: 0.35, // how much the head follows the real face position (0 = fixed on the shoulders)
    },

    // Face features, as fractions of the head radii (they grow with head.scale).
    face: {
      spanX: 1.15, // face point layout, horizontally (per eye span)
      spanY: 0.9, // vertically (per brow-to-chin height)
      eyeLine: 0.0, // height of the eye line on the head
      browLift: 1.3, // brows sit higher and move more than the raw points
      eye: { x: 0.155, y: 0.145 }, // eye white radii
      pupil: 0.62, // pupil radius, fraction of the eye width
      browWidth: 0.075,
      smile: 0.035, // mouth corners raised at rest
      mouthScale: 0.6, // mouth width, fraction of the real one
      mouthOpen: 1.0, // gain on the mouth opening
      mouthLine: 0.024,
      nose: 0.095,
      cheek: { x: 0.52, y: -0.3, w: 0.36, h: 0.18 },
    },

    sizes: {
      sleeve: [0.118, 0.097, 0.082], // radius at shoulder, elbow, sleeve end
      cuff: 0.07,
      neck: 0.17,
      palm: 0.034, // half thickness
      // Finger radius at each of the 4 points (base to tip): thumb, index, middle, ring, pinky.
      fingers: [
        [0.027, 0.025, 0.023, 0.022],
        [0.023, 0.022, 0.021, 0.02],
        [0.023, 0.022, 0.021, 0.02],
        [0.022, 0.021, 0.02, 0.019],
        [0.02, 0.019, 0.018, 0.017],
      ],
    },
    badge: { width: 0.24, height: 0.09 },

    trail: { color: 0x7fdcd2, strength: 0.4, width: 2.5 },
    particles: 0x5eead4,
  },

  // ---- "bellhop" style: rigged 3D cartoon bellhop (web/public/avatar/bellhop.glb), glossy toy look ----
  bellhop: {
    url: "/avatar/bellhop.glb",
    // Camera framing for this body (big cartoon head): look-at height and half sizes, in shoulder widths.
    frame: { lookAtY: 0.2, halfHeight: 1.85, halfWidth: 2.0 },
    humanReach: 1.7, // shoulder to middle knuckle of a stretched human arm; maps onto the bellhop's own reach
    handDepth: 3, // gain on hand z relative to the wrist (the solver damps it to 0.3 of the raw value)
    bodyGap: 0.035, // min gap (model units) between the hand bones and the chest / face front
    smoothing: 0.5, // per 30 fps frame: share of the way to the new bone rotations
    forearmTwist: 0.5, // share of the wrist twist carried by the forearm (the rest by the hand)
    neckShare: 0.4, // share of the head rotation carried by the neck
    torso: { maxYaw: 0.3, maxRoll: 0.15 }, // radians
    // Relaxed arm when its hand is missing (directions in the torso frame, x toward the side of that arm).
    restArm: { upper: [0.35, -1, 0.05], fore: [0.2, -1, 0.45] },
    restCurl: [0.2, 0.3, 0.2], // radians per phalanx, relaxed fingers
    material: { clearcoat: 1, clearcoatRoughness: 0.15, sheen: 0.25, sheenRoughness: 0.5, envMapIntensity: 0.9 },
    rimLight: { color: 0xbfe3ff, intensity: 2.2 },
    particles: 0xffc061,
  },
} as const;

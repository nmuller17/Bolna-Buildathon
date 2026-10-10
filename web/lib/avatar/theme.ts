// P2: every visual setting of the avatar in one place, so the look can change without touching the renderer.
// Sizes are in shoulder widths (the normalization unit, CLAUDE.md 6.2).

export const THEME = {
  defaultStyle: "concierge", // "hologram" | "concierge"

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

  // ---- "concierge" style: Sam, the SignBridge receptionist (original character), soft 3D toon ----
  concierge: {
    skin: 0xc98d5e,
    skinShade: 0xb3774c, // nose
    lips: 0x9a4e3e,
    eyeWhite: 0xf6f3ec,
    hair: 0x3b2417,
    blazer: 0x1f2d4f,
    lapel: 0x18233f,
    seam: 0x0d1427,
    shirt: 0xf5f7fa,
    shirtShade: 0xc7d0dc,
    tie: 0x0f9488, // SignBridge teal
    tieShade: 0x0b6e66,
    gold: 0xd9ad3c,
    goldShade: 0x9c7618,
    badgeText: 0x1c1917,
    gloves: 0xf7f5ef, // set to `skin` for bare hands
    outline: 0x0b1020,
    features: 0x2a1a12, // brows, eyes, mouth strokes
    pupil: 0x1c120c,

    toneSteps: [110, 165, 215, 255], // toon gradient, darkest to brightest
    light: { key: 2.6, sky: 0xe6eeff, ground: 0x3a3340, ambient: 1.1 },
    rim: { color: 0x9fd3ff, strength: 0.32 },
    outlinePx: 2.2,
    handOutlinePx: 1.6,

    // Head shape relative to the face measurements (rounder than the hologram shell), and chin narrowing.
    head: { width: 1.1, height: 1.0, depth: 1.05, jaw: 0.14 },

    sizes: {
      shoulder: 0.112, // sleeve radius at the shoulder joint
      upperArm: 0.11,
      elbow: 0.094,
      forearm: 0.092,
      cuff: 0.068,
      neck: 0.155,
      pupil: 0.016,
      finger: 0.02,
      thumb: 0.023,
      knuckle: 0.023,
      tip: 0.024,
      palmThickness: 0.05,
    },
    badge: { width: 0.24, height: 0.09 },

    face: { lineWidth: 2.4, browWidth: 4.5, lipWidth: 2 },
    trail: { color: 0x7fdcd2, strength: 0.45, width: 2.5 },
    particles: 0x5eead4,
  },
} as const;

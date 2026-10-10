// P2: every visual setting of the avatar in one place, so the look can change without touching the renderer.
// Sizes are in shoulder widths (the normalization unit, CLAUDE.md 6.2).

export const THEME = {
  background: 0x050a14,
  grid: { color: 0x123a6b, centerColor: 0x1f6fb2, opacity: 0.55, size: 40, divisions: 80 },

  body: { color: 0x38bdf8, rim: 0xc9f1ff, boneRadius: 0.034, jointRadius: 0.052 },
  // Hands carry the meaning: brighter, warmer, thicker joints, and never bloomed.
  hands: { color: 0xffb02e, rim: 0xfff1cf, boneRadius: 0.013, jointRadius: 0.021, tipRadius: 0.024 },
  head: { color: 0x7dd3fc },
  face: { color: 0xeefaff, browColor: 0xffffff, lineWidth: 2.4, browWidth: 4 }, // widths in CSS pixels
  trail: { color: 0xffc061, width: 3, samples: 10 },
  particles: { count: 1800, size: 3.2 },

  bloom: { strength: 0.6, radius: 0.3, threshold: 0 },

  // Facial markers, as fractions of the brow-to-chin height (squeeze: of the eye span).
  brows: { raise: 0.14, lower: 0.09, squeeze: 0.12, lid: 0.035 },
} as const;

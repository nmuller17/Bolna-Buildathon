// P2: data contracts from CLAUDE.md 6.1 and 6.3, plus the avatar's own types.

export type Point = [number, number, number]; // x, y, z after normalization (y-down)

export type Frame = {
  pose: Point[] | null; // 33 MediaPipe pose points
  lh: Point[] | null; // 21 left hand points
  rh: Point[] | null; // 21 right hand points
  face: Point[] | null; // 26 face points, order in CLAUDE.md 6.1
};

export type SignFile = {
  id: string;
  source: "team" | "public" | "alphabet";
  signer: string;
  fps: number;
  frames: Frame[];
};

/** Facial marker applied to the whole sentence (gloss starts with BROWS-UP or BROWS-DOWN). */
export type Brows = "up" | "down" | null;

export type PlayOptions = {
  /** Called with the gloss index of the token being signed, each time it changes. */
  onToken?: (index: number) => void;
};

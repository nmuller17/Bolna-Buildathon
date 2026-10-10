// P2: build one frame list from a gloss, 7 interpolated transition frames between signs (CLAUDE.md 6.6).
import { resolveToken } from "./lookup";
import type { Brows, Frame, Point, SignFile } from "./types";

export const FPS = 30;
export const TRANSITION_FRAMES = 7;

export type Sequence = {
  frames: Frame[];
  /** For each frame, the index in the gloss of the token it belongs to. */
  tokenIndex: number[];
  brows: Brows;
};

const MARKERS: Record<string, Brows> = { "BROWS-UP": "up", "BROWS-DOWN": "down" };

const lerp3 = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function lerpPart(a: Point[] | null, b: Point[] | null, t: number): Point[] | null {
  if (a && b) return a.map((p, i) => lerp3(p, b[i] ?? p, t));
  return a ?? b;
}

/** When only one side has the hand, keep its shape and carry it with the interpolated pose wrist. */
function lerpHand(a: Frame, b: Frame, key: "lh" | "rh", pose: Point[] | null, t: number): Point[] | null {
  const ha = a[key];
  const hb = b[key];
  if (ha && hb) return lerpPart(ha, hb, t);
  const hand = ha ?? hb;
  const from = ha ? a.pose : b.pose;
  if (!hand || !pose || !from) return hand;
  const wrist = key === "lh" ? 15 : 16;
  const dx = pose[wrist][0] - from[wrist][0];
  const dy = pose[wrist][1] - from[wrist][1];
  return hand.map(([x, y, z]) => [x + dx, y + dy, z] as Point);
}

export function lerpFrame(a: Frame, b: Frame, t: number): Frame {
  const pose = lerpPart(a.pose, b.pose, t);
  return {
    pose,
    lh: lerpHand(a, b, "lh", pose, t),
    rh: lerpHand(a, b, "rh", pose, t),
    face: lerpPart(a.face, b.face, t),
  };
}

/** `count` frames strictly between a and b. */
export function transition(a: Frame, b: Frame, count: number): Frame[] {
  return Array.from({ length: count }, (_, k) => lerpFrame(a, b, (k + 1) / (count + 1)));
}

/** Files recorded at another rate (public datasets) are resampled to 30 fps. */
function framesAt30(sign: SignFile): Frame[] {
  const fps = sign.fps > 0 ? sign.fps : FPS;
  if (fps === FPS) return sign.frames;
  const n = Math.max(1, Math.round((sign.frames.length * FPS) / fps));
  return Array.from({ length: n }, (_, i) => {
    const pos = Math.min((i * fps) / FPS, sign.frames.length - 1);
    const k = Math.floor(pos);
    return lerpFrame(sign.frames[k], sign.frames[Math.min(k + 1, sign.frames.length - 1)], pos - k);
  });
}

export async function buildSequence(gloss: string[]): Promise<Sequence> {
  const tokens = gloss.map((t) => t.trim().toUpperCase());
  const brows = MARKERS[tokens[0]] ?? null;

  const signsPerToken = await Promise.all(
    tokens.map((token, i) => {
      if (token in MARKERS) {
        if (i > 0) console.warn(`[avatar] ${token} is only allowed as the first token, skipped`);
        return [];
      }
      return token ? resolveToken(token) : [];
    }),
  );

  const frames: Frame[] = [];
  const tokenIndex: number[] = [];
  signsPerToken.forEach((signs, i) => {
    for (const sign of signs) {
      const signFrames = framesAt30(sign);
      if (frames.length > 0) {
        // Transition frames already belong to the next token, so captions move with the hands.
        for (const f of transition(frames[frames.length - 1], signFrames[0], TRANSITION_FRAMES)) {
          frames.push(f);
          tokenIndex.push(i);
        }
      }
      for (const f of signFrames) {
        frames.push(f);
        tokenIndex.push(i);
      }
    }
  });

  return { frames, tokenIndex, brows };
}

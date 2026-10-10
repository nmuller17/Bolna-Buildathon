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

const newPoints = (n: number): Point[] => Array.from({ length: n }, () => [0, 0, 0] as Point);

/** Fixed point arrays that lerpFrameInto writes into, so per-frame playback allocates nothing. */
export class FrameBuffer {
  private readonly pose = newPoints(33);
  private readonly lh = newPoints(21);
  private readonly rh = newPoints(21);
  private readonly face = newPoints(26);
  readonly frame: Frame = { pose: null, lh: null, rh: null, face: null };

  target(key: keyof Frame, length: number): Point[] | null {
    const out = this[key];
    return out.length === length ? out : null; // the contract sizes; anything else falls back to a fresh array
  }
}

/** a + (b - a) * t + shift, written into out (or a new array when out is null). */
function lerpPart(out: Point[] | null, a: Point[] | null, b: Point[] | null, t: number, dx = 0, dy = 0): Point[] | null {
  const src = a ?? b;
  if (!src) return null;
  const to = a && b ? b : src;
  const k = a && b ? t : 0;
  const res = out ?? newPoints(src.length);
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    const q = to[i] ?? p;
    const o = res[i];
    o[0] = p[0] + (q[0] - p[0]) * k + dx;
    o[1] = p[1] + (q[1] - p[1]) * k + dy;
    o[2] = p[2] + (q[2] - p[2]) * k;
  }
  return res;
}

/** When only one side has the hand, keep its shape and carry it with the interpolated pose wrist. */
function lerpHand(buf: FrameBuffer, a: Frame, b: Frame, key: "lh" | "rh", pose: Point[] | null, t: number): Point[] | null {
  const ha = a[key];
  const hb = b[key];
  const hand = ha ?? hb;
  if (!hand) return null;
  const out = buf.target(key, hand.length);
  const from = ha ? a.pose : b.pose;
  if ((ha && hb) || !pose || !from) return lerpPart(out, ha, hb, t);
  const wrist = key === "lh" ? 15 : 16;
  return lerpPart(out, hand, null, 0, pose[wrist][0] - from[wrist][0], pose[wrist][1] - from[wrist][1]);
}

/** Interpolated frame written into `buf` (its arrays are reused by the next call). */
export function lerpFrameInto(buf: FrameBuffer, a: Frame, b: Frame, t: number): Frame {
  const out = buf.frame;
  const poseSize = (a.pose ?? b.pose)?.length ?? 0;
  const faceSize = (a.face ?? b.face)?.length ?? 0;
  out.pose = lerpPart(buf.target("pose", poseSize), a.pose, b.pose, t);
  out.lh = lerpHand(buf, a, b, "lh", out.pose, t);
  out.rh = lerpHand(buf, a, b, "rh", out.pose, t);
  out.face = lerpPart(buf.target("face", faceSize), a.face, b.face, t);
  return out;
}

/** Interpolated frame with its own arrays (for sequences that are kept). */
export function lerpFrame(a: Frame, b: Frame, t: number): Frame {
  return { ...lerpFrameInto(new FrameBuffer(), a, b, t) };
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

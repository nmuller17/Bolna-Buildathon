// P2: playGloss(gloss: string[]): Promise<void>, 30 fps playback (CLAUDE.md 6.6).
// Data runs at 30 fps and is interpolated at display rate. Between sentences the avatar rests and breathes.
// Backward-compatible addition: playGloss(gloss, { onToken }) reports the gloss index being signed (karaoke captions).
import { REST_FRAME } from "./rest";
import { buildSequence, FPS, FrameBuffer, lerpFrameInto, transition } from "./sequence";
import { AvatarScene, type AvatarState } from "./skeleton";
import { THEME } from "./theme";
import type { AvatarStyle, Brows, Frame, PlayOptions } from "./types";

const LEAD_IN = 8; // frames from the current pose to the first sign (not part of the contract sequence)
const LEAD_OUT = 12; // frames from the last sign back to the rest pose
const BROWS_RAMP_S = 8 / FPS;
const IDLE_RAMP_S = 0.5;

type Playback = {
  frames: Frame[];
  tokenIndex: number[];
  signEnd: number; // first frame after the last sign
  brows: Brows;
  start: number;
  lastToken: number;
  onToken?: (index: number) => void;
  resolve: () => void;
  resolved: boolean;
};

let scene: AvatarScene | null = null;
let style: AvatarStyle = THEME.defaultStyle;
let playback: Playback | null = null;
const buffer = new FrameBuffer();
let current: Frame = REST_FRAME;
const state: AvatarState = { frame: REST_FRAME, brows: null, browAmount: 0, idle: 1 }; // reused every frame
let browMode: Brows = null;
let browAmount = 0;
let idle = 1;
let requestId = 0;
let rafId = 0;
let lastTime = 0;
let fps = 0;
let fpsFrames = 0;
let fpsSince = 0;

export type AvatarMount = { webgl: boolean; unmount: () => void };

/** Renders the avatar into `container` (it fills it and follows its size). Without WebGL, playGloss still runs. */
export function mountAvatar(container: HTMLElement, options: { style?: AvatarStyle } = {}): AvatarMount {
  if (options.style) style = options.style;
  scene?.dispose();
  scene = null;
  try {
    scene = new AvatarScene(container, style);
  } catch (err) {
    console.warn("[avatar] WebGL unavailable, captions only:", err);
  }
  const mine = scene;
  startLoop();
  return {
    webgl: mine !== null,
    unmount: () => {
      if (mine && scene === mine) {
        mine.dispose();
        scene = null;
      }
    },
  };
}

/** Plays the gloss and resolves when the last sign is done. A newer call interrupts this one (which then resolves). */
export async function playGloss(gloss: string[], options: PlayOptions = {}): Promise<void> {
  const id = ++requestId;
  const seq = await buildSequence(gloss);
  if (id !== requestId || seq.frames.length === 0) return; // superseded while loading, or nothing to sign

  if (playback) finish(playback);
  return new Promise((resolve) => {
    const lead = transition(current, seq.frames[0], LEAD_IN);
    const out = transition(seq.frames[seq.frames.length - 1], REST_FRAME, LEAD_OUT);
    playback = {
      frames: [...lead, ...seq.frames, ...out, REST_FRAME],
      tokenIndex: [...lead.map(() => -1), ...seq.tokenIndex, ...out.map(() => -1), -1],
      signEnd: lead.length + seq.frames.length,
      brows: seq.brows,
      start: performance.now(),
      lastToken: -1,
      onToken: options.onToken,
      resolve,
      resolved: false,
    };
    startLoop();
  });
}

/** Switches the look: "bellhop" (default), "concierge" (Sam) or "hologram". Applies now if mounted, and to later mounts. */
export function setAvatarStyle(next: AvatarStyle) {
  style = next;
  scene?.setStyle(next);
}

/** Display frames per second over the last half second (for a dev counter). */
export function getAvatarFps(): number {
  return fps;
}

function finish(p: Playback) {
  if (p.resolved) return;
  p.resolved = true;
  p.resolve();
}

const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step);

function advance(now: number, dt: number) {
  const p = playback;
  if (p) {
    const pos = Math.max(0, ((now - p.start) / 1000) * FPS);
    const i = Math.floor(pos);
    if (i >= p.frames.length - 1) {
      current = p.frames[p.frames.length - 1];
      finish(p);
      playback = null;
    } else {
      current = lerpFrameInto(buffer, p.frames[i], p.frames[i + 1], pos - i);
      const token = p.tokenIndex[i];
      if (token >= 0 && token !== p.lastToken) {
        p.lastToken = token;
        p.onToken?.(token);
      }
      if (i >= p.signEnd) finish(p);
    }
  }

  const signing = playback !== null && !playback.resolved;
  if (signing && playback?.brows) browMode = playback.brows; // kept while the brows ramp back down
  browAmount = approach(browAmount, signing && playback?.brows ? 1 : 0, dt / BROWS_RAMP_S);
  idle = approach(idle, signing ? 0 : 1, dt / IDLE_RAMP_S);
}

function tick(now: number) {
  rafId = 0;
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  advance(now, dt);

  if (scene) {
    state.frame = current;
    state.brows = browMode;
    state.browAmount = browAmount;
    state.idle = idle;
    scene.update(state, now / 1000, dt);
    scene.render();
  }

  fpsFrames++;
  if (now - fpsSince >= 500) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsFrames = 0;
    fpsSince = now;
  }

  // Keep running while there is something to draw (breathing) or to time (captions without WebGL).
  if (scene || playback) rafId = requestAnimationFrame(tick);
}

function startLoop() {
  if (rafId || typeof requestAnimationFrame === "undefined") return;
  lastTime = fpsSince = performance.now();
  rafId = requestAnimationFrame(tick);
}

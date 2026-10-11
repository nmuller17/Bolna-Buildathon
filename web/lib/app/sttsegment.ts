// SignBridge staff page (P4, builder S): the energy gate that cuts the receptionist's microphone into
// utterances for live captions (docs/features-plan.md F3, "Streaming"). Pure logic over 20 ms blocks of
// 16 kHz PCM with their loudness, so it can be unit-tested without a microphone.
//
// While the receptionist speaks, the utterance so far is offered as an INTERIM every
// FEATURE_LIMITS.sttInterimEveryMs; after FEATURE_LIMITS.sttSilenceEndMs of quiet, or at
// FEATURE_LIMITS.sttUtteranceMaxMs, the FINAL is offered with the time the voice stopped. The page then
// decides what to post (interim requests are skipped while one is in flight; finals never are).
// The threshold follows the room's noise floor, so a loud lobby raises it (and the page can say so).
import { FEATURE_LIMITS } from "./types.ts";

export const FRAME_MS = 20;
export const FRAME_SAMPLES = (FEATURE_LIMITS.sttSampleRate * FRAME_MS) / 1000;

export type SegmentOut =
  | { kind: "interim"; id: string; pcm: Int16Array }
  | { kind: "final"; id: string; pcm: Int16Array; speechEnd: number };

export type SegmenterOptions = {
  newId: () => string;
  /** Lowest loudness (RMS of samples in -1..1) that counts as speech, whatever the noise floor. */
  minThreshold?: number;
  preRollMs?: number;
  /** Shorter voiced stretches (a cough, a door) are dropped unless an interim was already shown. */
  minVoicedMs?: number;
};

/** Noise floor at or above this is a loud lobby (staff-only hint, features-plan R8). */
export const LOUD_LOBBY_RMS = 0.04;

export class Segmenter {
  noiseFloor = 0.003;
  private opts: Required<SegmenterOptions>;
  private preRoll: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private id: string | null = null;
  private startedAt = 0;
  private lastVoiceAt = 0;
  private lastInterimAt = 0;
  private voicedMs = 0;
  private interimSent = false;

  constructor(opts: SegmenterOptions) {
    this.opts = { minThreshold: 0.012, preRollMs: 300, minVoicedMs: 200, ...opts };
  }

  get threshold(): number {
    return Math.max(this.opts.minThreshold, this.noiseFloor * 3);
  }

  get speaking(): boolean {
    return this.id !== null;
  }

  get loudLobby(): boolean {
    return this.noiseFloor >= LOUD_LOBBY_RMS;
  }

  /** One 20 ms block. `t` = ms since epoch at the END of the block (same clock the server uses). */
  push(pcm: Int16Array, rms: number, t: number): SegmentOut[] {
    const out: SegmentOut[] = [];
    const thr = this.threshold;
    if (this.id === null) {
      // Idle: follow the noise floor slowly, keep a short pre-roll so the first word is not clipped.
      this.noiseFloor = this.noiseFloor * 0.98 + Math.min(rms, 0.2) * 0.02;
      this.preRoll.push(pcm);
      while (this.preRoll.length * FRAME_MS > this.opts.preRollMs) this.preRoll.shift();
      if (rms > thr) {
        this.id = this.opts.newId();
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.startedAt = t - FRAME_MS;
        this.lastVoiceAt = t;
        this.lastInterimAt = t;
        this.voicedMs = FRAME_MS;
        this.interimSent = false;
      }
      return out;
    }
    this.frames.push(pcm);
    const voiced = rms > thr * 0.7;
    if (voiced) {
      this.lastVoiceAt = t;
      this.voicedMs += FRAME_MS;
    }
    const id = this.id;
    if (t - this.lastVoiceAt >= FEATURE_LIMITS.sttSilenceEndMs || t - this.startedAt >= FEATURE_LIMITS.sttUtteranceMaxMs) {
      if (this.voicedMs >= this.opts.minVoicedMs || this.interimSent) {
        // Keep 200 ms after the last voiced block; drop the rest of the silence.
        const keep = this.frames.length - Math.max(0, Math.floor((t - this.lastVoiceAt - 200) / FRAME_MS));
        out.push({ kind: "final", id, pcm: concat(this.frames.slice(0, Math.max(1, keep))), speechEnd: this.lastVoiceAt });
      }
      this.reset();
      return out;
    }
    if (voiced && t - this.lastInterimAt >= FEATURE_LIMITS.sttInterimEveryMs && this.voicedMs >= this.opts.minVoicedMs) {
      this.lastInterimAt = t;
      this.interimSent = true;
      out.push({ kind: "interim", id, pcm: concat(this.frames) });
    }
    return out;
  }

  /** Stop listening: a running utterance is finished as final when it had speech. */
  flush(t: number): SegmentOut[] {
    if (this.id === null) return [];
    const out: SegmentOut[] = this.voicedMs >= this.opts.minVoicedMs || this.interimSent ? [{ kind: "final", id: this.id, pcm: concat(this.frames), speechEnd: Math.min(t, this.lastVoiceAt) }] : [];
    this.reset();
    return out;
  }

  private reset(): void {
    this.id = null;
    this.frames = [];
    this.preRoll = [];
    this.voicedMs = 0;
    this.interimSent = false;
  }
}

export function concat(parts: Int16Array[]): Int16Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A 16 kHz mono 16-bit WAV file around raw PCM (for the opt-in OpenAI path, which takes audio files). */
export function wavFromPcm(pcm: Int16Array): Uint8Array {
  const bytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, FEATURE_LIMITS.sttSampleRate, true);
  v.setUint32(28, FEATURE_LIMITS.sttSampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, bytes, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

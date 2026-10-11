// The live-caption energy gate (docs/features-plan.md F3 "Streaming"). `npm run test:unit`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_MS, FRAME_SAMPLES, Segmenter, wavFromPcm, type SegmentOut } from "./sttsegment.ts";
import { FEATURE_LIMITS } from "./types.ts";

function run(pattern: [number, number][], seg = new Segmenter({ newId: (() => { let i = 0; return () => `u${++i}`; })() })) {
  const out: (SegmentOut & { at: number })[] = [];
  let t = 1_000_000;
  for (const [ms, rms] of pattern) {
    for (let k = 0; k < ms / FRAME_MS; k++) {
      t += FRAME_MS;
      for (const o of seg.push(new Int16Array(FRAME_SAMPLES).fill(rms > 0.05 ? 3000 : 10), rms, t)) out.push({ ...o, at: t });
    }
  }
  return { out, seg, t };
}

test("speech then 600 ms of silence: interims every 700 ms while speaking, then one final with the time the voice stopped", () => {
  const { out } = run([[1000, 0.001], [2000, 0.1], [1000, 0.001]]);
  const interims = out.filter((o) => o.kind === "interim");
  const finals = out.filter((o) => o.kind === "final");
  assert.equal(finals.length, 1);
  assert.ok(interims.length >= 2 && interims.length <= 3, String(interims.length));
  const f = finals[0] as Extract<SegmentOut, { kind: "final" }> & { at: number };
  assert.equal(f.at - f.speechEnd, FEATURE_LIMITS.sttSilenceEndMs);
  assert.equal(new Set(out.map((o) => o.id)).size, 1, "one utterance id");
  // About 300 ms pre-roll + 2 s speech + 200 ms tail, at 16 kHz.
  const sec = f.pcm.length / FEATURE_LIMITS.sttSampleRate;
  assert.ok(sec > 2.3 && sec < 2.7, String(sec));
});

test("a cough (under 200 ms) is dropped; an utterance is cut at 15 s", () => {
  assert.equal(run([[500, 0.001], [100, 0.2], [1000, 0.001]]).out.length, 0);
  const { out } = run([[200, 0.001], [16_000, 0.1]]);
  const finals = out.filter((o) => o.kind === "final");
  assert.equal(finals.length, 1);
  assert.ok(finals[0].pcm.length / FEATURE_LIMITS.sttSampleRate <= 15.4);
});

test("a loud lobby raises the threshold and is reported; flush finishes a running utterance", () => {
  const { seg } = run([[3000, 0.06]].map(([a, b]) => [a, b] as [number, number]), new Segmenter({ newId: () => "x", minThreshold: 0.5 }));
  assert.ok(seg.loudLobby);
  const s2 = new Segmenter({ newId: () => "y" });
  let t = 0;
  for (let k = 0; k < 30; k++) s2.push(new Int16Array(FRAME_SAMPLES), 0.2, (t += FRAME_MS));
  const f = s2.flush(t);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "final");
});

test("wavFromPcm writes a 16 kHz mono 16-bit header", () => {
  const w = wavFromPcm(new Int16Array([1, -1]));
  assert.equal(new TextDecoder().decode(w.slice(0, 4)), "RIFF");
  const v = new DataView(w.buffer);
  assert.equal(v.getUint32(24, true), 16_000);
  assert.equal(v.getUint32(40, true), 4);
  assert.equal(w.length, 48);
});

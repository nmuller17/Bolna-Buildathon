// Unit tests for the staff Privacy and Latency panels (BN-2). Run from web/: node --test lib/app/trust.test.mjs
// Node 22.18+ runs the .ts modules directly (type stripping); they have no imports of their own.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  destinationOf,
  egressLedger,
  egressSnapshot,
  installEgressCounter,
  isLoopbackHost,
  noteRequest,
  resetSession,
} from "./egress.ts";
import { emptyLatency, latencyStages, median, recordLatency, recordSign } from "./latency.ts";
import { heldItems, publish, snapshot, subscribe, wipe } from "../../app/api/guest/bus.ts";

const LEDGER = Symbol.for("signbridge.egress");
const fresh = () => {
  delete globalThis[LEDGER];
};

test("loopback hosts are not counted, everything else is", () => {
  for (const h of ["localhost", "127.0.0.1", "127.9.8.7", "::1", "[::1]", "::ffff:127.0.0.1", "app.localhost"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["api.elevenlabs.io", "10.0.0.5", "192.168.1.20", "128.0.0.1", "localhost.evil.com", "::2"]) assert.equal(isLoopbackHost(h), false, h);
});

test("destinationOf reads strings, URLs and Request-like objects, and rejects relative URLs", () => {
  assert.equal(destinationOf("https://api.anthropic.com/v1/messages").host, "api.anthropic.com");
  assert.equal(destinationOf(new URL("https://api.openai.com/x")).host, "api.openai.com");
  assert.equal(destinationOf({ url: "https://api.elevenlabs.io/v1/tts" }).host, "api.elevenlabs.io");
  assert.equal(destinationOf("/api/english"), null);
  assert.equal(destinationOf(42), null);
});

test("the wrapped fetch counts each off-laptop request by host, before sending, and passes the call through", async () => {
  fresh();
  const seen = [];
  const target = {
    fetch: async (input, init) => {
      seen.push([String(input), init?.method]);
      if (String(input).includes("fail")) throw new Error("network down");
      return new Response("ok");
    },
  };
  let t = 1000;
  assert.equal(installEgressCounter(target, () => t), true);
  const wrapped = target.fetch;
  assert.equal(installEgressCounter(target, () => t), true, "second install is a no-op");
  assert.equal(target.fetch, wrapped, "not wrapped twice");

  await target.fetch("https://api.elevenlabs.io/v1/text-to-speech/voice?x=1", { method: "POST" });
  t = 2000;
  await target.fetch("https://api.elevenlabs.io/v1/text-to-speech/voice", { method: "POST" });
  await target.fetch("http://127.0.0.1:3000/api/english", { method: "POST" });
  await assert.rejects(target.fetch("https://api.anthropic.com/fail"));

  assert.equal(seen.length, 4, "every call reached the real fetch");
  const snap = egressSnapshot(target, () => t);
  assert.equal(snap.installed, true);
  assert.deepEqual(
    snap.session.map((e) => [e.destination, e.calls]),
    [["api.elevenlabs.io", 2], ["api.anthropic.com", 1]],
    "failed requests count too; loopback does not",
  );
  assert.equal(snap.session[0].firstAt, 1000);
  assert.equal(snap.session[0].lastAt, 2000);
  assert.ok(!JSON.stringify(snap).includes("text-to-speech"), "only the host is kept, never the path");

  // Next.js wraps fetch again on top of ours: still counted, still reported as installed, never wrapped twice.
  const ours = target.fetch;
  target.fetch = function nextPatched(input, init) {
    return ours.call(this, input, init);
  };
  assert.equal(installEgressCounter(target, () => t), true);
  await target.fetch("https://api.elevenlabs.io/v1/x");
  const after = egressSnapshot(target, () => t);
  assert.equal(after.installed, true);
  assert.equal(after.session.find((e) => e.destination === "api.elevenlabs.io").calls, 3, "one more call, counted once");
});

test("a counter that is not installed reports installed: false (the panel then shows no number)", () => {
  fresh();
  const snap = egressSnapshot({ fetch: async () => new Response("") });
  assert.equal(snap.installed, false);
  assert.deepEqual(snap.session, []);
});

test("resetSession zeroes the session counters, keeps the since-start ones and records the wipe", () => {
  fresh();
  let t = 10;
  noteRequest("https://api.openai.com/v1/audio/transcriptions", () => t);
  noteRequest("https://api.openai.com/v1/audio/transcriptions", () => t);
  t = 50;
  const record = resetSession(3, () => t);
  assert.deepEqual(record, { at: 50, itemsErased: 3 });
  const snap = egressSnapshot(undefined, () => t);
  assert.deepEqual(snap.session, []);
  assert.equal(snap.sinceStart[0].calls, 2);
  assert.equal(snap.sessionStartedAt, 50);
  assert.deepEqual(snap.lastWipe, { at: 50, itemsErased: 3 });
  assert.equal(egressLedger().startedAt, 10);
});

test("latency stages come only from the timestamps the event carries", () => {
  const d = emptyLatency();
  // live.py-style sign: sign end 100.000, predicted 100.250, app 100.300, painted 100.420
  const keys = recordSign(d, { t_sign_end: 100, t_predicted: 100.25, at: 100.3, shownAt: 100.42 });
  assert.deepEqual(keys, ["sign_end_to_prediction", "prediction_to_app", "app_to_staff_screen", "sign_end_to_staff_screen"]);
  const byKey = Object.fromEntries(latencyStages(d).map((s) => [s.key, s]));
  assert.equal(byKey.sign_end_to_prediction.lastMs, 250);
  assert.equal(byKey.prediction_to_app.lastMs, 50);
  assert.equal(byKey.app_to_staff_screen.lastMs, 120);
  assert.equal(byKey.sign_end_to_staff_screen.lastMs, 420);
});

test("live_key.py-style signs (no recognizer timestamps) fill only the app-to-screen stage", () => {
  const d = emptyLatency();
  const keys = recordSign(d, { at: 200, shownAt: 200.03 });
  assert.deepEqual(keys, ["app_to_staff_screen"]);
  const stages = latencyStages(d);
  assert.equal(stages.find((s) => s.key === "sign_end_to_staff_screen").lastMs, null, "no invented end-to-end value");
  assert.equal(stages.find((s) => s.key === "sign_end_to_staff_screen").count, 0);
});

test("negative, non-finite and over-60 s values are dropped; median is exact", () => {
  const d = emptyLatency();
  assert.equal(recordLatency(d, "app_to_staff_screen", -1), false);
  assert.equal(recordLatency(d, "app_to_staff_screen", Number.NaN), false);
  assert.equal(recordLatency(d, "app_to_staff_screen", 60_001), false);
  assert.equal(recordLatency(d, "nope", 5), false);
  for (const v of [30, 10, 20, 40]) recordLatency(d, "app_to_staff_screen", v);
  assert.equal(median(d.app_to_staff_screen), 25);
  assert.equal(median([]), null);
  // a replayed event whose shownAt is minutes later is dropped, not averaged in
  assert.deepEqual(recordSign(d, { at: 0, shownAt: 120 }), []);
});

test("wipe erases the guest data on the bus, keeps the recognizer state and tells the pages", () => {
  const got = [];
  const off = subscribe((e) => got.push(e.type));
  publish({ type: "recognizer", state: "ok", at: 1 });
  publish({ type: "framing", status: "OK", at: 1 });
  publish({ type: "sign", seq: 1, top: [{ label: "TOWEL", conf: 0.9 }], at: 2, t_sign_end: 1.5 });
  publish({ type: "utterance", id: 1, labels: ["TOWEL"], raw: ["TOWEL"], text: "Towels, please.", source: "recognizer", needsRepeat: false, mock: false, at: 3 });
  publish({ type: "sign", seq: 2, top: [{ label: "MORE", conf: 0.8 }], at: 4 });
  assert.equal(heldItems(), 3, "framing + last sentence + one sign in progress");
  assert.equal(wipe(5), 3);
  assert.equal(heldItems(), 0);
  assert.deepEqual(snapshot().map((e) => e.type), ["recognizer"], "a page connecting after the wipe sees no guest data");
  assert.equal(got.at(-1), "wiped");
  assert.equal(snapshot().find((e) => e.type === "wiped"), undefined, "the wipe itself is not replayed or stored as recognizer state");
  off();
});

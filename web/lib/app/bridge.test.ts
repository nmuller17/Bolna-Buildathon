// Shared recognizer contract (adopted 2026-10-11 from p4-app c335161 and p3-recognition ad90509):
// the events live.py and live_key.py really send must be accepted and must reach the same outcome
// screens as before. Run with `npm run test:unit` (node:test, Node type stripping; no browser).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestBridge } from "./ingest.ts";
import { applySentenceCorrection, decide, type JoinedSign } from "./match.ts";
import { Store, defaultConfig, type StoreDeps } from "./store.ts";
import { validateBridgeEvent } from "./validate.ts";

const T0 = 1_760_112_000_000;

function setup(opts: { status?: boolean; controlPort?: number } = { status: true }) {
  let now = T0;
  let n = 0;
  const deps: StoreDeps = { now: () => now, randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "0") };
  const store = new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: true, signControlPort: opts.controlPort ?? null }), deps);
  store.startNewGuest();
  const opened = store.openGuestWindow();
  const code = new URL(String(opened.body.guestUrl)).hash.slice(3);
  const joined = store.join(code, "this laptop");
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const token = joined.guestCookie as string;
  if (opts.status) assert.equal(ingestBridge(store, { type: "status", fps: 27.4, recognizer: "ok", t: now / 1000 }, "recognizer").status, 200);
  let nonce = 0;
  const act = (a: Record<string, unknown>) => store.guestAction(token, { ...a, n: `n${++nonce}`.padEnd(32, "0") } as never);
  return { store, act, tick: (ms: number) => (now += ms), send: (ev: unknown) => ingestBridge(store, ev, "recognizer") };
}

/* ---------------------------- validation ---------------------------- */

test("contract: the README live.py examples validate without t_sent", () => {
  const examples = [
    { type: "sign", seq: 3, top: [{ label: "TOWEL", conf: 0.82 }, { label: "MORE", conf: 0.09 }, { label: "NONE", conf: 0.04 }], t_sign_start: 1760112001.204, t_sign_end: 1760112001.951, t_closed: 1760112002.488, t_predicted: 1760112002.503 },
    { type: "utterance", signs: [{ label: "MORE", conf: 0.91 }, { label: "TOWEL", conf: 0.82 }, { label: "PLEASE", conf: 0.44 }], seqs: [2, 3, 4], needs_repeat: true, t_end: 1760112004.371 },
    { type: "framing", status: "STEP_BACK", since: 1760112010.12 },
    { type: "framing", status: "HANDS_OUT", since: 1760112012.003, rejected_seq: 5 },
    { type: "status", fps: 27.4, recognizer: "ok", t: 1760112013.0 },
  ];
  for (const ev of examples) assert.equal(validateBridgeEvent(ev).ok, true, JSON.stringify(ev));
});

test("contract: live_key.py sign, sentence utterance and capture events validate", () => {
  assert.equal(validateBridgeEvent({ type: "sign", seq: 1, top: [{ label: "TOWEL", conf: 0.82 }] }).ok, true);
  const u = validateBridgeEvent({ type: "utterance", raw: ["PARKING", "TOWEL", "PLEASE"], labels: ["MORE", "TOWEL", "PLEASE"], text: "Could I have more towels, please?", snapped: true });
  assert.equal(u.ok, true);
  if (u.ok && u.event.type === "utterance") {
    assert.equal(u.event.shape, "sentence");
    assert.deepEqual(u.event.labels, ["PARKING", "TOWEL", "PLEASE"]);
    assert.deepEqual(u.event.corrected, ["MORE", "TOWEL", "PLEASE"]);
    assert.equal(u.event.confs, null, "the sentence shape carries no score and none is invented");
  }
  assert.equal(validateBridgeEvent({ type: "utterance", raw: ["YES"], labels: ["YES"], text: null, snapped: false }).ok, true);
  assert.equal(validateBridgeEvent({ type: "capture", phase: "countdown", countdown: 1.5, duration: 2.0 }).ok, true);
  assert.equal(validateBridgeEvent({ type: "capture", phase: "processing" }).ok, true);
  // live_window.py: stream utterance without seqs.
  assert.equal(validateBridgeEvent({ type: "utterance", signs: [{ label: "YES", conf: 0.9 }], needs_repeat: false, t_end: 4.2 }).ok, true);
});

test("contract: still strict where it matters", () => {
  const face = validateBridgeEvent({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }], face: [[0, 0, 0]] });
  assert.equal(face.ok, false);
  if (!face.ok) assert.deepEqual(face.refusedKeys, ["face"]);
  assert.equal(validateBridgeEvent({ type: "utterance", raw: ["YES"], labels: ["DROP TABLE"] }).ok, false);
  assert.equal(validateBridgeEvent({ type: "utterance", labels: ["YES"], text: "x".repeat(301) }).ok, false);
  assert.equal(validateBridgeEvent({ type: "utterance", labels: Array(9).fill("YES") }).ok, false);
  assert.equal(validateBridgeEvent({ type: "sign", seq: 1, top: [{ label: "YES", conf: 1.5 }] }).ok, false);
  assert.equal(validateBridgeEvent({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }], t_sent: -1 }).ok, false);
  assert.equal(validateBridgeEvent({ type: "capture", phase: "recording" }).ok, false);
  const alias = validateBridgeEvent({ type: "utterance", labels: ["FS-CHECKOUT", "TIME"] });
  assert.equal(alias.ok && alias.event.type === "utterance" && alias.event.labels.join(" "), "LEAVE TIME");
});

/* ---------------------------- the gate ---------------------------- */

const sign = (label: string, conf: number, seq: number): JoinedSign => ({ seq, top: [{ label: label as never, conf }], joined: true, framingRejected: false });

test("sentence correction: offered as Did you mean, never over a framing or NONE repeat, never over a proposal", () => {
  const signs = [sign("PARKING", 0.9, 1), sign("TOWEL", 0.9, 2), sign("PLEASE", 0.9, 3)];
  signs[0].top.push({ label: "MORE", conf: 0.05 });
  const out = applySentenceCorrection(decide(signs), signs, ["MORE", "TOWEL", "PLEASE"]);
  assert.equal(out.kind, "did_you_mean");
  if (out.kind === "did_you_mean") {
    assert.equal(out.candidates[0].source, "sentence");
    assert.ok(Math.abs(out.candidates[0].score - 0.05 * 0.9 * 0.9) < 1e-9);
  }
  const framed = [{ ...sign("MORE", 0.9, 1), framingRejected: true }, sign("TOWEL", 0.9, 2), sign("PLEASE", 0.9, 3)];
  assert.equal(applySentenceCorrection(decide(framed), framed, ["MORE", "TOWEL", "PLEASE"]).kind, "repeat");
  const good = [sign("YES", 0.9, 1), sign("RESERVATION", 0.9, 2)];
  const kept = applySentenceCorrection(decide(good), good, ["NO", "THANK-YOU"]);
  assert.equal(kept.kind, "proposal");
});

/* ---------------------------- end to end ---------------------------- */

test("live_key end to end: signs, an undone sign, the snapped sentence -> Did you mean (guest confirms)", () => {
  const { store, act, send } = setup();
  assert.equal(act({ type: "guest_choice", choice: "sign" }).status, 200);
  assert.equal(send({ type: "capture", phase: "countdown", countdown: 1.5, duration: 2.0 }).body.outcome, "capture");
  assert.equal(send({ type: "sign", seq: 1, top: [{ label: "PARKING", conf: 0.71 }, { label: "MORE", conf: 0.2 }, { label: "TAXI", conf: 0.05 }] }).body.outcome, "stored");
  assert.equal(send({ type: "sign", seq: 2, top: [{ label: "ROOM", conf: 0.6 }, { label: "TOWEL", conf: 0.3 }] }).body.outcome, "stored"); // undone with BACKSPACE
  assert.equal(send({ type: "sign", seq: 3, top: [{ label: "TOWEL", conf: 0.88 }] }).body.outcome, "stored");
  assert.equal(send({ type: "sign", seq: 4, top: [{ label: "PLEASE", conf: 0.93 }] }).body.outcome, "stored");
  const r = send({ type: "utterance", raw: ["PARKING", "TOWEL", "PLEASE"], labels: ["MORE", "TOWEL", "PLEASE"], text: "Could I have more towels, please?", snapped: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "proposal");
  const p = store.session?.pending?.proposal;
  assert.ok(p);
  assert.equal(p.kind, "did_you_mean");
  assert.equal(p.candidates[0].source, "sentence");
  assert.equal(p.candidates[0].text, "Could I have more towels, please?");
  // The undone sign (seq 2) was skipped: the evidence shown is seqs 1, 3, 4.
  assert.deepEqual(store.session?.pending?.staffSigns.map((v) => v.seq), [1, 3, 4]);
});

test("live_key end to end: a clean sentence is a plain proposal from the fixed table", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  send({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.95 }] });
  send({ type: "sign", seq: 2, top: [{ label: "RESERVATION", conf: 0.9 }] });
  const r = send({ type: "utterance", raw: ["YES", "RESERVATION"], labels: ["YES", "RESERVATION"], text: "Yes, I have a reservation.", snapped: true });
  assert.equal(r.body.outcome, "proposal");
  const p = store.session?.pending?.proposal;
  assert.equal(p?.kind, "proposal");
  assert.equal(p?.candidates[0].source, "table");
});

test("live.py stream utterance with seqs still joins as before", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  send({ type: "sign", seq: 7, top: [{ label: "WHERE", conf: 0.9 }], t_sign_start: 1, t_sign_end: 2, t_closed: 2.1, t_predicted: T0 / 1000 });
  send({ type: "sign", seq: 8, top: [{ label: "ELEVATOR", conf: 0.85 }] });
  const r = send({ type: "utterance", signs: [{ label: "WHERE", conf: 0.9 }, { label: "ELEVATOR", conf: 0.85 }], seqs: [7, 8], needs_repeat: false, t_end: T0 / 1000 });
  assert.equal(r.body.outcome, "proposal");
  assert.deepEqual(store.session?.pending?.staffSigns.map((v) => v.joined), [true, true]);
});

test("consent gate unchanged: signs before the guest chose Sign get 409; framing and capture do not", () => {
  const { send } = setup();
  assert.equal(send({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }] }).status, 409);
  assert.equal(send({ type: "framing", status: "OK" }).status, 200);
  assert.equal(send({ type: "capture", phase: "processing" }).status, 200);
});

test("known gap: live_key.py sends no status event, so Sign is not offered until one arrives", () => {
  const { act } = setup({ status: false });
  assert.equal(act({ type: "guest_choice", choice: "sign" }).status, 409);
});

test("an utterance with no sign events at all is never spoken on invented confidence", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  const r = send({ type: "utterance", raw: ["YES", "RESERVATION"], labels: ["YES", "RESERVATION"], text: null, snapped: false });
  assert.equal(r.status, 200);
  // Both signs unjoined with no score: two weak signs, so a repeat, not a proposal.
  assert.equal(r.body.outcome, "repeat");
  assert.equal(store.session?.pending ?? null, null);
});

/* ------------- live_key.py driven through the app (control port) ------------- */

test("live_key control: an answering control port makes Sign available without a status event", () => {
  const { store, act, tick } = setup({ status: false, controlPort: 8765 });
  assert.equal(store.hello().signTrigger, "key");
  assert.equal(act({ type: "guest_choice", choice: "sign" }).status, 409);
  store.noteControlHealth(true);
  assert.equal(store.signingAvailable, true);
  assert.equal(act({ type: "guest_choice", choice: "sign" }).status, 200);
  // The probe stops answering: 5 s later signing is unavailable again.
  store.noteControlHealth(false);
  tick(5_001);
  store.updateSigningAvailable();
  assert.equal(store.signingAvailable, false);
});

test("live_key control: a status event still wins over the probe (mock is never ok)", () => {
  const { store, send } = setup({ status: false, controlPort: 8765 });
  assert.equal(send({ type: "status", fps: 0, recognizer: "mock", t: T0 / 1000 }).status, 200);
  store.noteControlHealth(true);
  assert.equal(store.recognizer.mode, "mock");
  assert.equal(store.signingAvailable, false);
});

test("live_key control: commands need the consent gate and no waiting sentence", () => {
  const { store, act, send } = setup({ status: false, controlPort: 8765 });
  store.noteControlHealth(true);
  assert.equal(act({ type: "sign_control", cmd: "record" }).status, 409, "not before the guest chose Sign");
  act({ type: "guest_choice", choice: "sign" });
  const r = act({ type: "sign_control", cmd: "record" });
  assert.equal(r.status, 200);
  assert.equal(r.body.forward, "record");
  send({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.93 }] });
  send({ type: "sign", seq: 2, top: [{ label: "RESERVATION", conf: 0.9 }] });
  assert.equal(send({ type: "utterance", raw: ["YES", "RESERVATION"], labels: ["YES", "RESERVATION"], text: null, snapped: false }).body.outcome, "proposal");
  assert.equal(act({ type: "sign_control", cmd: "record" }).status, 409, "a sentence is waiting for Say it / Text only / Fix");
});

test("live_key control: without a control port the command is refused", () => {
  const { act } = setup();
  act({ type: "guest_choice", choice: "sign" });
  assert.equal(act({ type: "sign_control", cmd: "record" }).status, 409);
});

test("live_key control: undo drops the newest sign from the sentence join", () => {
  const { store, act, send } = setup({ status: false, controlPort: 8765 });
  store.noteControlHealth(true);
  act({ type: "guest_choice", choice: "sign" });
  send({ type: "sign", seq: 1, top: [{ label: "MORE", conf: 0.9 }] });
  send({ type: "sign", seq: 2, top: [{ label: "TOWEL", conf: 0.91 }] });
  send({ type: "sign", seq: 3, top: [{ label: "TOWEL", conf: 0.4 }] });
  assert.equal(act({ type: "sign_control", cmd: "undo" }).status, 200);
  store.noteSignControl("undo", true);
  assert.deepEqual(store.runs.recognizer?.sentence, [1, 2]);
  send({ type: "sign", seq: 4, top: [{ label: "PLEASE", conf: 0.88 }] });
  const r = send({ type: "utterance", raw: ["MORE", "TOWEL", "PLEASE"], labels: ["MORE", "TOWEL", "PLEASE"], text: null, snapped: false });
  assert.equal(r.body.outcome, "proposal", "the strong TOWEL (#2) is joined, not the undone weak one (#3)");
});

test("live_key control: a failed forward marks the control port down and tells staff", () => {
  const { store } = setup({ status: false, controlPort: 8765 });
  store.noteControlHealth(true);
  store.noteSignControl("record", false);
  assert.equal(store.recognizer.controlUp, false);
  assert.ok(store.session?.log.some((e) => e.kind === "system" && /did not answer/.test(e.text)));
});

test("live_key control: the guest can only name one of three commands (no path, no host, no body)", async () => {
  const { validateGuestAction } = await import("./validate.ts");
  const n = "0".repeat(32);
  assert.equal(validateGuestAction({ n, type: "sign_control", cmd: "record" }).ok, true);
  for (const bad of [{ cmd: "../health" }, { cmd: "sign" }, { cmd: "record", port: 22 }, { cmd: "record", path: "/x" }, {}]) {
    assert.equal(validateGuestAction({ n, type: "sign_control", ...bad }).ok, false, JSON.stringify(bad));
  }
});

// Store-level tests (docs/app-plan.md 6.3, 9, 11): the session rules that do not need HTTP.
// Run with `npm run test:unit`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestBridge } from "./ingest.ts";
import { configFromEnv, vriFromEnv } from "./runtime.ts";
import { Store, defaultConfig, type StoreConfig } from "./store.ts";
import { LIMITS } from "./types.ts";

const T0 = 1_760_112_000_000;

function setup(cfg: Partial<StoreConfig> = {}) {
  let now = T0;
  let n = 0;
  const store = new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: true, ...cfg }), {
    now: () => now,
    randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "c"),
  });
  store.startNewGuest();
  const code = new URL(String(store.openGuestWindow().body.guestUrl)).hash.slice(3);
  const token = store.join(code, "this laptop", "ua").guestCookie as string;
  let nonce = 0;
  const act = (a: Record<string, unknown>) => store.guestAction(token, { ...a, n: (++nonce).toString(16).padStart(32, "0") } as never, "ua");
  const send = (ev: unknown) => ingestBridge(store, ev, "recognizer");
  send({ type: "status", recognizer: "ok" });
  return { store, act, send, tick: (ms: number) => (now += ms), token };
}

function signs(send: (ev: unknown) => unknown, start: number, list: [string, number][]) {
  list.forEach(([label, conf], i) => send({ type: "sign", seq: start + i, top: [{ label, conf }] }));
  return list.map((_, i) => start + i);
}

const utter = (labels: [string, number][], seqs: number[]) => ({ type: "utterance", signs: labels.map(([label, conf]) => ({ label, conf })), seqs, needs_repeat: false });

test("SES-14: the engagement profile ignores MODE0_GUEST_INPUT and is display-only; stage honours it", () => {
  assert.equal(new Store(defaultConfig({ profile: "engagement", mode0GuestInputRequested: true })).displayOnly, true);
  assert.equal(new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: true })).displayOnly, false);
  assert.equal(new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: false })).displayOnly, true);
  const c = configFromEnv({ SB_PROFILE: "stage", MODE0_GUEST_INPUT: "1", IDLE_WIPE_MS: "5000", BRIDGE_KEY: "x".repeat(32), OPENAI_API_KEY: "" }, new Set());
  assert.equal(c.idleWipeMs, 5000);
  assert.equal(c.sessionCapMs, 15 * 60_000);
  assert.equal(c.bridgeKeyConfigured, true);
  assert.deepEqual(c.vendorKeysConfigured, []);
  assert.equal(configFromEnv({ SB_PROFILE: "anything" }, new Set()).profile, "engagement");
  assert.equal(configFromEnv({ SB_PROFILE: "stage" }, new Set()).idleWipeMs, 600_000);
  assert.deepEqual(vriFromEnv({ VRI_URL: "http://plain.example", VRI_CONTACT: "555", VRI_CONTACT_KIND: "phone" }), { label: null, url: null, contact: null });
});

test("display-only Mode 0: the guest window cannot act; staff confirm for the guest", () => {
  const { store, act, send } = setup({ mode0GuestInputRequested: false });
  assert.equal(act({ type: "guest_choice", choice: "sign" }).status, 409);
  assert.equal(act({ type: "emergency" }).status, 200, "Help is never refused");
  assert.equal(store.staffAction({ type: "choice_for_guest", choice: "sign" }).status, 200);
  const seqs = signs(send, 1, [["YES", 0.95], ["RESERVATION", 0.9]]);
  send(utter([["YES", 0.95], ["RESERVATION", 0.9]], seqs));
  const p = store.session!.pending!.proposal;
  const r = store.staffAction({ type: "confirm_for_guest", proposalId: p.proposalId, candidateId: p.candidates[0].candidateId });
  assert.equal(r.status, 200);
  const line = store.session!.log.find((e) => e.kind === "guest");
  assert.equal(line?.kind === "guest" && line.confirmedBy, "staff_for_guest");
});

test("SES-15: heartbeats and acks update lastHeardAt, never lastActivityAt", () => {
  const { store, act, tick } = setup();
  const activity = store.session!.lastActivityAt;
  tick(3_000);
  act({ type: "heartbeat" });
  assert.equal(store.session!.lastActivityAt, activity);
  assert.equal(store.session!.lastHeardAt, T0 + 3_000);
  act({ type: "ack", seq: 99 });
  assert.equal(store.session!.lastActivityAt, activity);
});

test("SPK-8: a pending proposal survives a reach-to-tap NONE utterance; a replaced one is confirmable for 10 s", () => {
  const { store, act, send, tick } = setup();
  act({ type: "guest_choice", choice: "sign" });
  let seqs = signs(send, 1, [["WHERE", 0.9], ["ELEVATOR", 0.9]]);
  send(utter([["WHERE", 0.9], ["ELEVATOR", 0.9]], seqs));
  const first = store.session!.pending!.proposal;
  seqs = signs(send, 3, [["NONE", 0.9]]);
  assert.equal(send(utter([["NONE", 0.9]], seqs)).body.outcome, "ignored_pending");
  assert.equal(store.session!.pending!.proposal.proposalId, first.proposalId);
  seqs = signs(send, 4, [["TAXI", 0.9], ["PLEASE", 0.9]]);
  send(utter([["TAXI", 0.9], ["PLEASE", 0.9]], seqs));
  assert.notEqual(store.session!.pending!.proposal.proposalId, first.proposalId);
  tick(5_000);
  assert.equal(act({ type: "guest_confirm", proposalId: first.proposalId, candidateId: first.candidates[0].candidateId }).status, 200, "within the grace");
  // A second replaced proposal past the grace gets 409.
  const second = store.session!.pending!.proposal;
  seqs = signs(send, 6, [["YES", 0.95]]);
  send(utter([["YES", 0.95]], seqs));
  tick(LIMITS.proposalGraceMs + 1);
  assert.equal(act({ type: "guest_confirm", proposalId: second.proposalId, candidateId: second.candidates[0].candidateId }).status, 409);
});

test("SPK-9: WHERE then ELEVATOR 2 s later is merged into the elevator proposal; alone, unmatched after 4 s", () => {
  const { store, act, send, tick } = setup();
  act({ type: "guest_choice", choice: "sign" });
  let seqs = signs(send, 1, [["WHERE", 0.9]]);
  assert.equal(send(utter([["WHERE", 0.9]], seqs)).body.outcome, "held");
  tick(2_000);
  seqs = signs(send, 2, [["ELEVATOR", 0.9]]);
  assert.equal(send(utter([["ELEVATOR", 0.9]], seqs)).body.outcome, "proposal");
  assert.equal(store.session!.pending!.proposal.candidates[0].text, "Where is the elevator?");
  act({ type: "guest_fix", proposalId: store.session!.pending!.proposal.proposalId, action: "not_this" });
  seqs = signs(send, 3, [["TAXI", 0.9], ["WHERE", 0.9]]);
  assert.equal(send(utter([["TAXI", 0.9], ["WHERE", 0.9]], seqs)).body.outcome, "held");
  tick(LIMITS.unmatchedMergeMs + 1);
  store.tick();
  assert.equal(store.session!.pending!.proposal.kind, "unmatched");
});

test("SPK-3/BRG-8: one weak sign with a matching runner-up gives Did you mean; needs_repeat is only a hint", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  send({ type: "sign", seq: 1, top: [{ label: "MORE", conf: 0.91 }] });
  send({ type: "sign", seq: 2, top: [{ label: "TOWEL", conf: 0.82 }] });
  send({ type: "sign", seq: 3, top: [{ label: "TAXI", conf: 0.45 }, { label: "PLEASE", conf: 0.4 }, { label: "NONE", conf: 0.1 }] });
  const r = send({ type: "utterance", signs: [{ label: "MORE", conf: 0.91 }, { label: "TOWEL", conf: 0.82 }, { label: "TAXI", conf: 0.45 }], seqs: [1, 2, 3], needs_repeat: true });
  assert.equal(r.body.outcome, "proposal");
  assert.equal(store.session!.pending!.proposal.kind, "did_you_mean");
  assert.equal(store.session!.pending!.proposal.candidates[0].text, "Could I have more towels, please?");
});

test("BRG-5: a mock recognizer gives test-mode proposals that cannot be sent; no_model disables Sign", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  send({ type: "status", recognizer: "mock" });
  assert.equal(store.signingAvailable, false);
  send({ type: "status", recognizer: "ok" });
  const seqs = signs(send, 1, [["YES", 0.95]]);
  send({ type: "status", recognizer: "mock" });
  send(utter([["YES", 0.95]], seqs));
  const p = store.session!.pending!.proposal;
  assert.equal(p.testMode, true);
  assert.equal(act({ type: "guest_confirm", proposalId: p.proposalId, candidateId: p.candidates[0].candidateId }).status, 409);
  send({ type: "status", recognizer: "no_model" });
  assert.equal(store.signingAvailable, false);
});

test("C1-9: 5 s of recognizer silence makes signing unavailable", () => {
  const { store, tick } = setup();
  assert.equal(store.signingAvailable, true);
  tick(5_001);
  store.tick();
  assert.equal(store.signingAvailable, false);
});

test("DSH-2/GST-11: an item is shared only on the guest device's ack; a repair reply marks it needs_retry", () => {
  const { store, act } = setup();
  const r = store.staffAction({ type: "say_quick", intent: "room_number" });
  const item = () => store.session!.checklist.find((c) => c.key === "room_number")!;
  assert.equal(item().state, "sent");
  const seq = [...store.session!.sent.keys()].pop()!;
  act({ type: "ack", seq });
  assert.equal(item().state, "shared");
  act({ type: "guest_reply", reply: "dont_understand", captionId: r.body.captionId as string });
  assert.equal(item().state, "needs_retry");
});

test("GST-10/SPK-5: a phrase pick gives the same speak plan as a recognised proposal; text only and read-aloud off give none", () => {
  const { store, act } = setup();
  act({ type: "guest_choice", choice: "type" });
  act({ type: "guest_phrase", intentId: 6 });
  const last = () => store.session!.log.filter((e) => e.kind === "guest").pop() as { speak: unknown } | undefined;
  assert.deepEqual(last()?.speak, { mode: "tts", intentId: 6, fixedText: "Where is the elevator?" });
  act({ type: "prefs", speakAloud: false });
  act({ type: "guest_phrase", intentId: 6 });
  assert.deepEqual(last()?.speak, { mode: "none", why: "read_aloud_off" });
  act({ type: "guest_choice", choice: "text_only" });
  act({ type: "guest_phrase", intentId: 8 });
  assert.deepEqual(last()?.speak, { mode: "none", why: "text_only" });
});

test("BRG-7a: skeleton snapshots stay on the staff side and are erased at the wipe", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  const pt = (n: number) => Array.from({ length: n }, () => [0.1, 0.2]);
  const r = send({ type: "sign", seq: 1, top: [{ label: "YES", conf: 0.9 }], skeleton: { t: T0 / 1000, pose: pt(7), lh: pt(21), rh: null } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(store.thisGuest.skeletonsHeld, 1);
  store.staffAction({ type: "end_guest" });
  assert.equal(store.sinceStart.skeletonsHeld, 0);
  assert.equal(JSON.stringify(store).includes("skeleton\":{"), false);
});

test("BN-1: nothing is planned for speech and no checklist item moves before the guest confirms; Text only is never voiced", () => {
  const { store, act, send } = setup();
  act({ type: "guest_choice", choice: "sign" });
  const seqs = signs(send, 1, [["LATE", 0.9], ["LEAVE", 0.9], ["PLEASE", 0.9]]);
  send(utter([["LATE", 0.9], ["LEAVE", 0.9], ["PLEASE", 0.9]], seqs));
  const checkout = () => store.session!.checklist.find((c) => c.key === "checkout")!;
  assert.equal(checkout().guestAskedAt, null);
  assert.equal(store.session!.log.some((e) => e.kind === "guest"), false);
  const p = store.session!.pending!.proposal;
  assert.equal(act({ type: "guest_confirm", proposalId: p.proposalId, candidateId: p.candidates[0].candidateId, voice: false }).status, 200);
  const line = store.session!.log.find((e) => e.kind === "guest") as { speak: unknown };
  assert.deepEqual(line.speak, { mode: "none", why: "guest_chose_text" });
  assert.notEqual(checkout().guestAskedAt, null);
  act({ type: "guest_phrase", intentId: 5, voice: false });
  const last = store.session!.log.filter((e) => e.kind === "guest").pop() as { speak: unknown };
  assert.deepEqual(last.speak, { mode: "none", why: "guest_chose_text" });
});

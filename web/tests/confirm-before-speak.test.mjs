// Confirm before speaking (guest -> staff): nothing reaches /api/tts before the guest taps "Say it".
// Run: cd web && npm test   (Node >= 22.18 runs the .ts modules directly, no build step)
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  cleanGuestText,
  createSpeakGate,
  GUEST_TEXT_MAX,
  needsConfirm,
  signChips,
  topAlternatives,
} from "../components/confirmBeforeSpeak.ts";
import { INTENTS, LABELS } from "../app/api/english/intents.ts";
import { speakText } from "../components/speakSigns.ts";

// An utterance event as /api/guest/stream sends it (GuestEvent in app/api/guest/bus.ts).
const utterance = (over = {}) => ({
  type: "utterance",
  id: 7,
  labels: ["LATE", "LEAVE", "PLEASE"],
  raw: ["LATE", "LEAVE", "PLEASE"],
  text: "Could I have a late checkout?",
  source: "recognizer",
  needsRepeat: false,
  mock: false,
  at: 0,
  ...over,
});
const signs = [
  { type: "sign", seq: 1, top: [{ label: "LATE", conf: 0.82 }, { label: "TIME", conf: 0.1 }], at: 0 },
  { type: "sign", seq: 2, top: [{ label: "LEAVE", conf: 0.71 }, { label: "PARKING", conf: 0.2 }], at: 0 },
  { type: "sign", seq: 3, top: [{ label: "PLEASE", conf: 0.93 }, { label: "TAXI", conf: 0.04 }], at: 0 },
];

/* ---------- instrumented network and audio: every fetch is recorded, /api/tts answers with a tiny wav ---------- */
let calls = [];
const ttsCalls = () => calls.filter((c) => c.url.endsWith("/api/tts"));
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  return new Response(new Blob([new Uint8Array(44)], { type: "audio/wav" }), { status: 200 });
};
globalThis.Audio = class {
  play() {
    setTimeout(() => this.onended?.(), 0);
    return Promise.resolve();
  }
};
globalThis.window = globalThis; // speakWithBrowser looks for window.speechSynthesis (absent here)
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  calls = [];
});

describe("staff side: createSpeakGate wired to the real speakText", () => {
  test("a recognized sentence is not spoken until the guest taps Say it", async () => {
    const gate = createSpeakGate((text) => void speakText(text));
    assert.equal(gate.offer(utterance()), true);
    await settle();
    assert.equal(ttsCalls().length, 0, "no /api/tts call before the tap");

    const result = gate.decide({ id: 7, action: "say", text: "Could I have a late checkout?" });
    await settle();
    assert.deepEqual(result, { outcome: "spoken", text: "Could I have a late checkout?" });
    assert.equal(ttsCalls().length, 1);
    assert.deepEqual(ttsCalls()[0].body, { text: "Could I have a late checkout?" });
  });

  test("Text only never calls /api/tts", async () => {
    const gate = createSpeakGate((text) => void speakText(text));
    gate.offer(utterance());
    assert.equal(gate.decide({ id: 7, action: "text", text: "Could I have a late checkout?" }).outcome, "text_only");
    await settle();
    assert.equal(calls.length, 0);
  });

  test("a second Say it, a stale id or a cancelled sentence speaks nothing more", async () => {
    let spoken = 0;
    const gate = createSpeakGate(() => spoken++);
    gate.offer(utterance({ id: 1 }));
    gate.offer(utterance({ id: 2 })); // a newer sentence drops the older one
    assert.equal(gate.decide({ id: 1, action: "say", text: "Yes." }).outcome, "ignored");
    assert.equal(gate.decide({ id: 2, action: "say", text: "Yes." }).outcome, "spoken");
    assert.equal(gate.decide({ id: 2, action: "say", text: "Yes." }).outcome, "ignored");
    gate.offer(utterance({ id: 3 }));
    assert.equal(gate.decide({ id: 3, action: "cancel", text: "" }).outcome, "cancelled");
    assert.equal(gate.decide({ id: 3, action: "say", text: "Yes." }).outcome, "ignored");
    assert.equal(spoken, 1);
  });

  test("repeat requests, mock results and empty texts are never offered, so never spoken", () => {
    let spoken = 0;
    const gate = createSpeakGate(() => spoken++);
    for (const u of [utterance({ needsRepeat: true }), utterance({ mock: true }), utterance({ text: "  " })]) {
      assert.equal(needsConfirm(u), false);
      assert.equal(gate.offer(u), false);
      assert.equal(gate.decide({ id: u.id, action: "say", text: "Yes." }).outcome, "ignored");
    }
    assert.equal(spoken, 0);
  });

  test("a malformed decision is ignored", () => {
    let spoken = 0;
    const gate = createSpeakGate(() => spoken++);
    gate.offer(utterance());
    assert.equal(gate.decide({ id: "7", action: "say", text: "Yes." }).outcome, "ignored");
    assert.equal(gate.decide({ id: 7, action: "shout", text: "Yes." }).outcome, "ignored");
    assert.equal(gate.decide({ id: 7, action: "say", text: "x".repeat(GUEST_TEXT_MAX + 1) }).outcome, "ignored");
    assert.equal(gate.decide({ id: 7, action: "say", text: 42 }).outcome, "ignored");
    assert.equal(spoken, 0);
    assert.equal(gate.pending, 7, "still waiting for a valid choice");
  });

  test("a sentence fixed by the guest is spoken as fixed", () => {
    const said = [];
    const gate = createSpeakGate((text) => said.push(text));
    gate.offer(utterance());
    gate.decide({ id: 7, action: "say", text: "  What time is\ncheckout? " });
    assert.deepEqual(said, ["What time is checkout?"]);
  });
});

describe("guest side: what the confirmation card shows", () => {
  test("signs as words, with the confidence of this sentence's sign events", () => {
    assert.deepEqual(signChips(["LATE", "LEAVE", "PLEASE"], signs, LABELS), [
      { label: "LATE", word: "late", conf: 0.82 },
      { label: "LEAVE", word: "checkout", conf: 0.71 },
      { label: "PLEASE", word: "please", conf: 0.93 },
    ]);
    // a label no sign event carried (sentence correction, undo): no confidence shown
    assert.deepEqual(signChips(["TIME", "NEW-LABEL"], [], LABELS), [
      { label: "TIME", word: "time", conf: null },
      { label: "NEW-LABEL", word: "new label", conf: null },
    ]);
  });

  test("Fix offers up to three known sentences ranked from what was already recognized, without any request", () => {
    const picks = topAlternatives(utterance(), signs, INTENTS);
    assert.equal(picks.length, 3);
    assert.ok(!picks.includes("Could I have a late checkout?"), "the current sentence is not offered again");
    assert.equal(picks[0], "What time is checkout?", picks.join(" / ")); // shares the rare LEAVE, not just PLEASE
    for (const p of picks) assert.ok(INTENTS.some((i) => i.text === p));
    assert.equal(calls.length, 0, "no recognizer, english or tts request");
  });

  test("Fix still has picks when no sign events arrived (labels only)", () => {
    const picks = topAlternatives(utterance({ labels: ["WHERE", "ROOM"], raw: ["WHERE", "ROOM"], text: "Where is my room?" }), [], INTENTS);
    assert.ok(picks.length > 0 && picks.length <= 3);
    assert.ok(picks.every((p) => p !== "Where is my room?"));
  });

  test("typed text is cleaned and capped", () => {
    assert.equal(cleanGuestText("  hello\u0007 there  "), "hello there");
    assert.equal(cleanGuestText(""), null);
    assert.equal(cleanGuestText(null), null);
    assert.equal(cleanGuestText("a".repeat(GUEST_TEXT_MAX)), "a".repeat(GUEST_TEXT_MAX));
    assert.equal(cleanGuestText("a".repeat(GUEST_TEXT_MAX + 1)), null);
  });
});

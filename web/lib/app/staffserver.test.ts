// Builder S unit tests for the features plan (docs/features-plan.md section 5): facts (F1), live
// captions (F3), numbers (F7), desk alerts (F9), the interpreter card (F11), the tap mode (F12),
// equal-access counters and the privacy receipt (F16, F17), and POST /api/staff/stt.
// Real Store with a fake clock; guest and staff streams captured as plain callbacks. No server, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "./access.ts";
import { ingestBridge } from "./ingest.ts";
import { staffAction as staffActionRoute, staffStt, type RouteDeps } from "./routes.ts";
import { configFromEnv, propertyFactsFrom } from "./runtime.ts";
import { claimCapability, isStaffToken, issueCapability, resetStaffCapability } from "./staffcap.ts";
import { Store, defaultConfig, liveWords, type StoreConfig } from "./store.ts";
import { CAPTION_BACKEND_LABEL, FEATURE_LIMITS, type BusEnvelope, type GuestEvent, type StaffEvent } from "./types.ts";
import { validateGuestAction, validateStaffAction } from "./validate.ts";

const T0 = 1_760_112_000_000;
const NAME_CANARY = "Zqsevencanary";

function setup(cfg: Partial<StoreConfig> = {}) {
  let now = T0;
  let n = 0;
  const store = new Store(defaultConfig({ profile: "stage", mode0GuestInputRequested: true, localSttPort: 8790, ...cfg }), {
    now: () => now,
    randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "c"),
  });
  store.startNewGuest();
  const code = new URL(String(store.openGuestWindow().body.guestUrl)).hash.slice(3);
  const token = store.join(code, "this laptop", "ua").guestCookie as string;
  const guest: GuestEvent[] = [];
  const staff: StaffEvent[] = [];
  const parse = (chunk: string) => {
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    return line ? (JSON.parse(line.slice(6)) as BusEnvelope<GuestEvent | StaffEvent>).msg : null;
  };
  store.openGuestStream(token, (c) => {
    const m = parse(c);
    if (m) guest.push(m as GuestEvent);
    return true;
  }, () => {}, "ua");
  store.openStaffStream((c) => {
    const m = parse(c);
    if (m) staff.push(m as StaffEvent);
    return true;
  }, () => {});
  let nonce = 0;
  const act = (a: Record<string, unknown>) => {
    const v = validateGuestAction({ ...a, n: (++nonce).toString(16).padStart(32, "0") });
    if (!v.ok) return { status: 400, body: { ok: false, message: v.message, field: v.field } } as const;
    return store.guestAction(token, v.value, "ua");
  };
  const staffAct = (a: Record<string, unknown>) => {
    const v = validateStaffAction(a);
    if (!v.ok) return { status: 400, body: { ok: false, message: v.message } } as const;
    return store.staffAction(v.value);
  };
  ingestBridge(store, { type: "status", recognizer: "ok" }, "recognizer");
  return { store, act, staffAct, guest, staff, tick: (ms: number) => (now += ms), token };
}

const of = <T extends { type: string }, K extends T["type"]>(list: T[], type: K) => list.filter((m): m is Extract<T, { type: K }> => m.type === type);

/* ---------------- F1 facts ---------------- */

test("F1-1: with room 517 typed by staff, say_quick room_number captions 'You're in room 517.' and pins the room fact (staff_typed)", () => {
  const w = setup();
  assert.equal(w.staffAct({ type: "set_fact", key: "room", value: "517" }).status, 200);
  w.guest.length = 0;
  assert.equal(w.staffAct({ type: "say_quick", intent: "room_number" }).status, 200);
  const cap = of(w.guest, "staff_utterance")[0];
  assert.equal(cap.text, "You're in room 517.");
  assert.deepEqual(cap.gloss.slice(-3), ["5", "1", "7"]);
  const facts = of(w.guest, "fact");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact.key, "room");
  assert.equal(facts[0].fact.source, "staff_typed");
  // The value never appears in a system log line (the conversation line itself is the caption).
  assert.ok(w.store.session!.log.filter((e) => e.kind === "system").every((e) => !JSON.stringify(e).includes("517")));
});

test("F1-1b: without a typed room the fixed demo sentence is unchanged; a hotel value pins as 'property'", () => {
  const w = setup({ propertyFacts: { breakfast: "7 to 10 am, lobby" } });
  w.staffAct({ type: "say_quick", intent: "room_number" });
  assert.equal(of(w.guest, "staff_utterance")[0].text, "You're in room 412.");
  assert.equal(of(w.guest, "fact").length, 0);
  w.staffAct({ type: "say_quick", intent: "breakfast_time" });
  const f = of(w.guest, "fact")[0].fact;
  assert.deepEqual([f.key, f.value, f.source], ["breakfast", "7 to 10 am, lobby", "property"]);
});

test("F1-2: a final live caption with 'room fifteen' or '415' never creates a fact", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  for (const [i, text] of ["You're in room fifteen.", "Your room is 415."].entries()) {
    w.store.localSttResult(`u${i}`, true, { text, words: [], audioMs: 1000, decodeMs: 900 }, null);
  }
  assert.equal(of(w.guest, "fact").length, 0);
  assert.equal(w.store.session!.facts.size, 0);
});

test("F1-5: after End guest the store holds no facts, alerts, captions or card", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  w.staffAct({ type: "set_fact", key: "wifi_password", value: "Zq7Pass!" });
  w.staffAct({ type: "send_alert", code: "taxi_here" });
  w.store.localSttResult("u1", true, { text: "Hello there", words: [], audioMs: 900, decodeMs: 800 }, null);
  const s = w.store.session!;
  assert.equal(w.staffAct({ type: "end_guest" }).status, 200);
  assert.equal(w.store.session, null);
  assert.equal(s.facts.size + s.live.size + s.deskAlerts.length, 0);
  assert.ok(!JSON.stringify(w.store.staffSnapshot()).includes("Zq7Pass"));
  const end = of(w.guest, "session_end")[0];
  assert.ok(end.receipt);
});

test("F1: fact values are checked; resend_facts re-sends every tile; clear_fact removes one", () => {
  const w = setup();
  assert.equal(w.staffAct({ type: "set_fact", key: "room", value: "<b>1</b>" }).status, 400);
  assert.equal(w.staffAct({ type: "set_fact", key: "breakfast", value: "x".repeat(61) }).status, 400);
  assert.equal(w.staffAct({ type: "set_fact", key: "breakfast", value: "7​ to 10" }).status, 200);
  assert.equal(w.store.session!.facts.get("breakfast")!.value, "7 to 10");
  w.staffAct({ type: "set_fact", key: "checkout", value: "11 am" });
  w.guest.length = 0;
  assert.equal(w.staffAct({ type: "resend_facts" }).status, 200);
  assert.deepEqual(of(w.guest, "fact").map((f) => f.fact.key), ["breakfast", "checkout"]);
  w.staffAct({ type: "clear_fact", key: "checkout" });
  assert.equal(of(w.guest, "fact_cleared")[0].key, "checkout");
  // The guest snapshot stays AS-1: no facts in it.
  assert.ok(!("facts" in w.store.guestSnapshot(w.store.session!)));
  assert.deepEqual(propertyFactsFrom({ room: "12B", wifi_password: "", nonsense: "x", breakfast: 7 }), { room: "12B" });
});

/* ---------------- F3 live captions ---------------- */

test("F3: local captions word by word: interim revisions rise, the final joins the log; unsure words from probabilities", () => {
  const w = setup();
  assert.equal(w.store.captionLive(), "typed", "local process not up yet");
  w.store.noteLocalStt(true);
  assert.equal(w.store.captionLive(), "local");
  assert.deepEqual(of(w.guest, "caption_backend").at(-1), { type: "caption_backend", backend: "local" });
  w.store.localSttResult("utt1", false, { text: "Breakfast is", words: [{ w: "Breakfast", p: 0.9 }, { w: "is", p: 0.3 }], audioMs: 700, decodeMs: 1500 }, null);
  w.tick(1_000);
  w.store.localSttResult("utt1", true, { text: "Breakfast is from 7 to 10.", words: [{ w: "Breakfast", p: 0.9 }, { w: "is", p: 0.8 }, { w: "from", p: 0.95 }, { w: "7", p: 0.4 }, { w: "to", p: 0.9 }, { w: "10.", p: 0.9 }] , audioMs: 1700, decodeMs: 1500 }, T0 + 400);
  const live = of(w.guest, "live_caption");
  assert.deepEqual(live.map((l) => [l.rev, l.final]), [[1, false], [2, true]]);
  assert.equal(live[0].words[1].unsure, true);
  assert.deepEqual(live[1].words.map((x) => x.unsure), [false, false, false, true, false, false]);
  assert.equal(live[1].backend, "local");
  assert.ok(!("decodeMs" in live[1]), "no decode times on the guest stream (AS-1)");
  const st = of(w.staff, "live_caption").at(-1)!;
  assert.equal(st.decodeMs, 1500);
  assert.equal(st.speechEndToFinalMs, 600);
  assert.equal(w.store.session!.log.filter((e) => e.kind === "live_caption").length, 1);
  assert.deepEqual(w.store.captionStatus().localDecodeMs, { median: 1500, last: 1500 });
  assert.deepEqual(w.store.captionStatus().speechEndToFinalMs, { median: 600, last: 600 });
  // A late interim for a finished utterance is ignored.
  assert.equal(w.store.localSttResult("utt1", false, { text: "late", words: [], audioMs: 1, decodeMs: 1 }, null).body.published, false);
});

test("F3-9: live captions never reach the avatar (no staff_utterance) and never change the checklist", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  const before = JSON.stringify(w.store.session!.checklist);
  w.store.localSttResult("u", true, { text: "The Wi-Fi password is on your key card.", words: [], audioMs: 2000, decodeMs: 1500 }, null);
  assert.equal(of(w.guest, "staff_utterance").length, 0);
  assert.equal(JSON.stringify(w.store.session!.checklist), before);
});

test("F3-3: when the local process stops, captions fall back to Typed on both screens and never to a cloud backend", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  w.store.noteLocalStt(false);
  assert.equal(w.store.captionLive(), "typed");
  assert.deepEqual(of(w.guest, "caption_backend").at(-1), { type: "caption_backend", backend: "typed" });
  assert.equal(w.store.status().captions!.local, "down");
  assert.ok(w.store.session!.log.some((e) => e.kind === "system" && e.text.startsWith("Local captions are off")));
  assert.equal(w.store.sttCheck()!.status, 409);
  w.store.noteLocalStt(true);
  assert.equal(w.store.captionLive(), "local", "comes back to local by itself, the only automatic switch");
});

test("F3-5: the engagement profile refuses every cloud caption backend and browser captions", () => {
  const w = setup({ profile: "engagement", mode0GuestInputRequested: false, transcribeAvailable: true });
  for (const b of ["browser_google", "browser_apple", "browser_other", "cloud_openai"]) assert.equal(w.staffAct({ type: "caption_backend", backend: b }).status, 409, b);
  assert.equal(w.staffAct({ type: "live_caption", utteranceId: "b1", text: "hello", final: true, backend: "browser_google" }).status, 409);
  const st = w.store.status().captions!;
  assert.equal(st.browserAllowed, false);
  assert.equal(st.cloudOpenaiAvailable, false);
});

test("F3-4: browser speech in the stage profile: labelled, counted as a vendor, only for the chosen backend", () => {
  const w = setup();
  assert.equal(w.staffAct({ type: "live_caption", utteranceId: "b1", text: "hello", final: true, backend: "browser_google" }).status, 409, "not chosen yet");
  assert.equal(w.staffAct({ type: "caption_backend", backend: "browser_google" }).status, 200);
  assert.deepEqual(of(w.guest, "caption_backend").at(-1), { type: "caption_backend", backend: "browser_google" });
  assert.equal(CAPTION_BACKEND_LABEL.browser_google, "Cloud: Google (Chrome speech recognition)");
  assert.equal(w.staffAct({ type: "live_caption", utteranceId: "b1", text: "Your taxi", final: false, backend: "browser_google" }).status, 200);
  assert.equal(w.staffAct({ type: "live_caption", utteranceId: "b1", text: "Your taxi is here", final: true, backend: "browser_google" }).status, 200);
  assert.equal(w.staffAct({ type: "live_caption", utteranceId: "b2", text: "x", final: true, backend: "browser_apple" }).status, 409);
  const v = w.store.thisGuest.vendorCalls.find((c) => c.destination === "Google (Chrome speech recognition)");
  assert.equal(v?.count, 1);
  w.staffAct({ type: "end_guest" });
  const r = of(w.guest, "session_end")[0].receipt!;
  assert.deepEqual(r.captionBackends, ["browser_google"]);
  assert.ok(r.vendors.some((x) => x.startsWith("Google")));
});

test("F3-4 integration: a cloud caption choice ends with the guest; the next guest starts on local captions", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  assert.equal(w.staffAct({ type: "caption_backend", backend: "browser_google" }).status, 200);
  assert.equal(w.store.captionLive(), "browser_google");
  w.staffAct({ type: "end_guest" });
  assert.equal(w.store.captionLive(), "local");
  const st = of(w.staff, "status").at(-1) as { status?: { captions?: { live?: string } } } | undefined;
  assert.equal(st?.status?.captions?.live ?? w.store.captionStatus().live, "local");
  // A local or typed choice is a desk setting and stays.
  w.store.startNewGuest();
  assert.equal(w.staffAct({ type: "caption_backend", backend: "typed" }).status, 200);
  w.store.wipe("staff_ended");
  assert.equal(w.store.captionLive(), "typed");
});

test("F3-6: a spoken card number is hidden in the guest caption and the redaction is counted (kind only)", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  w.store.localSttResult("c", true, { text: "Your card 4111 1111 1111 1111 is fine", words: [], audioMs: 3000, decodeMs: 1600 }, null);
  const live = of(w.guest, "live_caption")[0];
  assert.equal(live.text, "Your card [number hidden] is fine");
  assert.ok(!JSON.stringify(w.guest).includes("4111"));
  assert.equal(w.store.thisGuest.redactions?.card_number, 1);
});

test("F3-7: Remove from guest screen strikes the line out on the guest page", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  w.store.localSttResult("r1", true, { text: "Wrong words", words: [], audioMs: 900, decodeMs: 900 }, null);
  assert.equal(w.staffAct({ type: "retract_caption", utteranceId: "r1" }).status, 200);
  const last = of(w.guest, "live_caption").at(-1)!;
  assert.equal(last.retracted, true);
  assert.ok(last.rev > 1);
  const e = w.store.session!.log.find((x) => x.kind === "live_caption");
  assert.equal(e?.kind === "live_caption" && e.retracted, true);
  assert.equal(w.staffAct({ type: "retract_caption", utteranceId: "nope" }).status, 404);
});

test("F3: interim captions are rate-limited (5 a second), finals never are; a guest repair reply may answer a live caption", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  let published = 0;
  for (let i = 0; i < 9; i++) if (w.store.localSttResult("rl", false, { text: `word ${i}`, words: [], audioMs: 100, decodeMs: 100 }, null).body.published) published++;
  assert.equal(published, FEATURE_LIMITS.liveCaptionsPerSecond);
  assert.equal(w.store.localSttResult("rl", true, { text: "done", words: [], audioMs: 100, decodeMs: 100 }, null).body.published, true);
  assert.equal(w.act({ type: "guest_reply", reply: "say_another_way", captionId: "rl" }).status, 200);
  assert.deepEqual(liveWords("a [number hidden] b", [{ w: "a", p: 0.1 }, { w: "b", p: 0.9 }], true).map((x) => x.unsure), [true, false, false, false]);
});

/* ---------------- F7 numbers ---------------- */

test("F7-1: guest_number accepts 1 to 6 digits only, with a reason for the field otherwise", () => {
  const w = setup();
  const ok = w.act({ type: "guest_number", about: "nights", value: "3" });
  assert.equal(ok.status, 200);
  assert.deepEqual(of(w.staff, "guest_number")[0], { type: "guest_number", about: "nights", value: "3", logSeq: ok.body.logSeq });
  for (const v of ["", "12a", "1234567", "٣", " 3"]) {
    const r = w.act({ type: "guest_number", about: "room", value: v });
    assert.equal(r.status, 400, JSON.stringify(v));
    assert.equal(r.body.field, "text");
  }
  assert.equal(w.act({ type: "guest_number", about: "age", value: "3" }).status, 400);
  // Never spoken: no speak plan anywhere for a number.
  assert.ok(!of(w.staff, "guest_utterance").length);
});

/* ---------------- F9 desk alerts ---------------- */

test("F9-1: send_alert takes the four codes only, no free text; >3 open or >6 a minute is 429; ack shows Seen", () => {
  const w = setup();
  assert.equal(w.staffAct({ type: "send_alert", code: "emergency" }).status, 400);
  assert.equal(w.staffAct({ type: "send_alert", code: "taxi_here", text: "Mr Smith" }).status, 400);
  const ids: string[] = [];
  for (const code of ["come_to_desk", "taxi_here", "room_ready"]) {
    const r = w.staffAct({ type: "send_alert", code });
    assert.equal(r.status, 200);
    ids.push(String(r.body.id));
  }
  assert.equal(w.staffAct({ type: "send_alert", code: "look_at_desk" }).status, 429, "3 open");
  const g = of(w.guest, "desk_alert");
  assert.deepEqual(Object.keys(g[0]).sort(), ["code", "id", "type"]);
  assert.equal(w.act({ type: "ack_alert", id: ids[0] }).status, 200);
  assert.ok(of(w.staff, "desk_alerts").at(-1)!.alerts.find((a) => a.id === ids[0])!.seenAt !== null);
  for (const id of ids.slice(1)) w.staffAct({ type: "cancel_alert", id });
  assert.equal(of(w.guest, "desk_alert_cleared").length, 2);
  for (let i = 0; i < 3; i++) {
    const r = w.staffAct({ type: "send_alert", code: "look_at_desk" });
    assert.equal(r.status, 200);
    w.act({ type: "ack_alert", id: String(r.body.id) });
  }
  assert.equal(w.staffAct({ type: "send_alert", code: "look_at_desk" }).status, 429, "6 a minute");
  w.tick(60_000);
  assert.equal(w.staffAct({ type: "send_alert", code: "look_at_desk" }).status, 200);
});

/* ---------------- F11 interpreter card ---------------- */

test("F11-2: the interpreter card holds only the ticked language, topic words and the last fixed request; never a name", () => {
  const w = setup();
  assert.equal(w.act({ type: "guest_phrase", intentId: 4, name: NAME_CANARY, via: "board" }).status, 200);
  assert.equal(w.act({ type: "guest_phrase", intentId: 7, via: "board" }).status, 200);
  assert.equal(w.act({ type: "guest_typed", text: "my sister Zq7Typed is coming" }).status, 200);
  assert.equal(w.act({ type: "interpreter_request" }).status, 200);
  assert.equal(of(w.staff, "interpreter_request")[0].context, null, "nothing ticked: no card");
  const r = w.act({ type: "interpreter_request", context: { language: "bfi", topics: true } });
  assert.equal(r.status, 200);
  const card = of(w.staff, "interpreter_request").at(-1)!.context!;
  assert.deepEqual(card, { language: "British Sign Language (BSL)", topics: ["Wi-Fi"], openRequest: "What's the Wi-Fi password?" });
  const all = JSON.stringify(w.staff) + JSON.stringify(w.store.staffSnapshot().interpreterCard);
  assert.ok(!JSON.stringify(card).includes(NAME_CANARY) && !JSON.stringify(card).includes("Zq7Typed"));
  assert.ok(all.includes("British Sign Language"));
  assert.equal(w.act({ type: "interpreter_request", context: { language: "xx", topics: true } }).status, 400);
});

/* ---------------- F12 tap mode, F2 via ---------------- */

test("F12-3 and F2: guest_choice tap is accepted; a board tap reaches staff labelled 'board'", () => {
  const w = setup();
  assert.equal(w.act({ type: "guest_choice", choice: "tap" }).status, 200);
  assert.equal(w.store.session!.guestMode, "tap");
  assert.equal(of(w.staff, "guest_choice").at(-1)!.guestMode, "tap");
  assert.equal(w.act({ type: "guest_phrase", intentId: 10, via: "board" }).status, 200);
  const u = of(w.staff, "guest_utterance").at(-1)!;
  assert.equal(u.via, "board");
  const e = w.store.session!.log.find((x) => x.kind === "guest");
  assert.equal(e?.kind === "guest" && e.via, "board");
  assert.equal(w.act({ type: "guest_phrase", intentId: 10, via: "camera" }).status, 400);
  assert.equal(w.act({ type: "guest_reply", reply: "write_number", captionId: null }).status, 200);
});

/* ---------------- F16 counters, F17 receipt ---------------- */

test("F16/F17: counters move with events; the receipt lists what was really used; offline no vendor", () => {
  const w = setup();
  w.store.noteLocalStt(true);
  const c0 = structuredClone(w.store.equalAccess);
  assert.equal(c0.sessions, 1);
  w.act({ type: "guest_choice", choice: "tap" });
  w.act({ type: "guest_phrase", intentId: 10, via: "board" });
  w.act({ type: "guest_typed", text: "hello" });
  w.act({ type: "guest_number", about: "people", value: "2" });
  w.act({ type: "card_shown" });
  w.staffAct({ type: "set_fact", key: "checkout", value: "11 am" });
  w.store.localSttResult("x", true, { text: "Hello", words: [], audioMs: 500, decodeMs: 900 }, null);
  const c = w.store.equalAccess;
  assert.equal(c.modeChosen.tap, 1);
  assert.equal(c.sentBy.board, 1);
  assert.equal(c.sentBy.typed, 2);
  assert.equal(c.cardsShown, 1);
  assert.equal(c.factsShown, 1);
  assert.equal(c.captionUtterances.local, 1);
  assert.ok(!JSON.stringify(c).match(/T0|176011/), "no timestamps");
  w.staffAct({ type: "end_guest" });
  const r = of(w.guest, "session_end")[0].receipt!;
  assert.deepEqual(r.used, ["Pictures", "Typing", "The number pad", "Take-home card"]);
  assert.deepEqual(r.captionBackends, ["local"]);
  assert.deepEqual(r.vendors, []);
  assert.equal(r.voice, "none");
  assert.ok(r.itemsErased > 0);
  assert.equal(w.store.equalAccess.sessions, 1, "counters survive the wipe (no personal data)");
  assert.equal(new Store(defaultConfig()).equalAccess.sessions, 0, "a restart resets them");
});

test("config: local captions need LOCAL_STT_PORT and a 32-character LOCAL_STT_KEY", () => {
  assert.equal(configFromEnv({ LOCAL_STT_PORT: "8790" }, new Set()).localSttPort, null);
  assert.equal(configFromEnv({ LOCAL_STT_PORT: "8790", LOCAL_STT_KEY: "k".repeat(32) }, new Set()).localSttPort, 8790);
  assert.equal(new Store(defaultConfig()).status().captions!.local, "off");
});

/* ---------------- POST /api/staff/stt ---------------- */

const PROOF = "proof-of-loopback-for-tests";

function routeWorld(stt?: RouteDeps["stt"]) {
  const w = setup();
  const limiters = new Map<string, RateLimiter>();
  const deps: RouteDeps = {
    store: w.store,
    port: 3000,
    proof: PROOF,
    bridgeKey: null,
    simulate: false,
    limit: (name, max, windowMs) => {
      let l = limiters.get(name);
      if (!l) limiters.set(name, (l = new RateLimiter(max, windowMs)));
      return l.take();
    },
    staff: { isToken: isStaffToken, claim: claimCapability },
    readBenchmark: () => null,
    stt,
  };
  resetStaffCapability();
  const r = claimCapability(issueCapability());
  assert.ok(r.ok);
  return { ...w, deps, cookie: `sb_staff=${r.token}` };
}

function sttReq(o: { cookie?: string; host?: string; ct?: string; len?: string | null; body?: Uint8Array; utt?: string; final?: string; end?: string }) {
  const host = o.host ?? "127.0.0.1:3000";
  const body = o.body ?? new Uint8Array(3200);
  const h: Record<string, string> = {
    host,
    origin: `http://${host}`,
    "sec-fetch-site": "same-origin",
    "x-sb-proof": PROOF,
    "x-sb-loopback": "1",
    "content-type": o.ct ?? "application/octet-stream",
    "x-stt-utterance": o.utt ?? "utt1",
    "x-stt-final": o.final ?? "0",
  };
  if (o.cookie) h.cookie = o.cookie;
  if (o.len !== null) h["content-length"] = o.len ?? String(body.byteLength);
  if (o.end) h["x-stt-speech-end"] = o.end;
  return new Request(`http://${host}/api/staff/stt`, { method: "POST", headers: h, body: body as unknown as BodyInit });
}

test("F3-10: POST /api/staff/stt: 401 without the staff cookie, 403 on the guest host, 411, 413, 415, 400, then 200", async () => {
  const calls: number[] = [];
  const w = routeWorld(async (pcm) => {
    calls.push(pcm.byteLength);
    return { ok: true, value: { text: "Welcome to the hotel", words: [{ w: "Welcome", p: 0.9 }], audioMs: 100, decodeMs: 1200 } };
  });
  w.store.noteLocalStt(true);
  assert.equal((await staffStt(sttReq({}), w.deps)).status, 401);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, host: "localhost:3000" }), w.deps)).status, 403);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, len: null }), w.deps)).status, 411);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, len: String(FEATURE_LIMITS.sttBodyMaxBytes + 2) }), w.deps)).status, 413);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, ct: "audio/webm" }), w.deps)).status, 415);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, utt: "bad id!" }), w.deps)).status, 400);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, body: new Uint8Array(3) }), w.deps)).status, 400);
  assert.equal(calls.length, 0);
  const ok = await staffStt(sttReq({ cookie: w.cookie, final: "1", end: String(T0 - 500) }), w.deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, [3200]);
  assert.equal(of(w.guest, "live_caption").at(-1)!.text, "Welcome to the hotel");
});

test("F3: /api/staff/stt is 409 when local captions are off, 503 when not set up, 502 when the process fails", async () => {
  const w = routeWorld(async () => ({ ok: false, why: "failed" }));
  assert.equal((await staffStt(sttReq({ cookie: w.cookie }), w.deps)).status, 409, "local not up");
  w.store.noteLocalStt(true);
  assert.equal((await staffStt(sttReq({ cookie: w.cookie, final: "1" }), w.deps)).status, 502);
  const w2 = routeWorld(undefined);
  w2.store.noteLocalStt(true);
  assert.equal((await staffStt(sttReq({ cookie: w2.cookie }), w2.deps)).status, 503);
});

test("F3: one request at a time: interim skipped while one runs, a final waits and is never dropped", async () => {
  let release: () => void = () => {};
  let n = 0;
  const w = routeWorld(async () => {
    n++;
    if (n === 1) await new Promise<void>((r) => (release = r));
    return { ok: true, value: { text: `t${n}`, words: [], audioMs: 100, decodeMs: 1000 } };
  });
  w.store.noteLocalStt(true);
  const first = staffStt(sttReq({ cookie: w.cookie, utt: "a" }), w.deps);
  await new Promise((r) => setTimeout(r, 5));
  const skipped = await staffStt(sttReq({ cookie: w.cookie, utt: "a" }), w.deps);
  assert.deepEqual(await skipped.json(), { ok: true, skipped: true });
  const fin = staffStt(sttReq({ cookie: w.cookie, utt: "a", final: "1" }), w.deps);
  await new Promise((r) => setTimeout(r, 5));
  release();
  assert.equal((await first).status, 200);
  assert.equal((await fin).status, 200);
  assert.equal(n, 2);
  assert.deepEqual(of(w.guest, "live_caption").map((l) => [l.text, l.final]), [["t1", false], ["t2", true]]);
});

test("staff action route: browser live captions have their own budget, buttons keep theirs", async () => {
  const w = routeWorld();
  const post = (body: unknown) =>
    staffActionRoute(
      new Request("http://127.0.0.1:3000/api/staff/action", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", "x-sb-proof": PROOF, "x-sb-loopback": "1", "content-type": "application/json", cookie: w.cookie },
        body: JSON.stringify(body),
      }),
      w.deps,
    );
  assert.equal((await post({ type: "caption_backend", backend: "browser_google" })).status, 200);
  for (let i = 0; i < 130; i++) await post({ type: "live_caption", utteranceId: `b${i}`, text: "hi", final: false, backend: "browser_google" });
  assert.equal((await post({ type: "touch" })).status, 200, "the button budget is untouched");
});

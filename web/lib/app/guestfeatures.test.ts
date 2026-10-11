// Guest-side feature logic (docs/features-plan.md section 5: F1/F4, F2 U1, F3, F6 U1, F7 U1, F9, F11 U2, F17).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESK_LINE_LABEL,
  GUEST_LINE_LABEL,
  addAlert,
  applyFact,
  applyLiveCaption,
  clearFact,
  factLines,
  interpreterCard,
  interpreterCardLines,
  numberLine,
  numberProblem,
  receiptLines,
  removeAlert,
  takeHomeText,
  topicsFromIntents,
  type DeskLineSource,
  type FactMap,
  type GuestSendVia,
} from "./guestfeatures.ts";
import { GUEST_INTENTS } from "./vocab.ts";
import {
  BOARD_TILES,
  FEATURE_LIMITS,
  TAKE_HOME_TITLE,
  type GuestLiveCaption,
  type LineSourceLabel,
} from "./types.ts";

const cap = (utteranceId: string, rev: number, text: string, extra: Partial<GuestLiveCaption> = {}): GuestLiveCaption => ({
  type: "live_caption",
  utteranceId,
  rev,
  final: false,
  text,
  words: text.split(" ").map((w) => ({ w, unsure: false })),
  backend: "local",
  ...extra,
});

/* F6 U1 */
test("F6: every desk and guest line kind has exactly one label", () => {
  const desk: DeskLineSource[] = ["quick_reply", "voice", "typed", "live_caption"];
  const guest: GuestSendVia[] = ["signs", "typed", "board", "phrase_list", "typed_match", "number"];
  assert.deepEqual(Object.keys(DESK_LINE_LABEL).sort(), [...desk].sort());
  assert.deepEqual(Object.keys(GUEST_LINE_LABEL).sort(), [...guest].sort());
  for (const k of desk) assert.equal(typeof DESK_LINE_LABEL[k], "string");
  for (const k of guest) assert.equal(typeof GUEST_LINE_LABEL[k], "string");
  // Machine output is never labelled as a person's, and the reverse.
  assert.equal(DESK_LINE_LABEL.live_caption, "Staff speech, machine captions" satisfies LineSourceLabel);
  assert.equal(GUEST_LINE_LABEL.board, "Tapped on board");
});

/* F2 U1 */
test("F2: the picture board covers all 20 guest intents exactly once, with no condition named", () => {
  const ids = BOARD_TILES.map((t) => t.intentId).sort((a, b) => a - b);
  assert.deepEqual(ids, GUEST_INTENTS.map((g) => g.id));
  assert.equal(new Set(BOARD_TILES.map((t) => t.icon)).size, 20);
  for (const t of BOARD_TILES) assert.doesNotMatch(t.label, /deaf|hearing|disab|impair/i);
});

/* F3 */
test("F3: interim revisions replace each other in place; older revisions are ignored", () => {
  let list = applyLiveCaption([], cap("u1", 1, "Your room"));
  list = applyLiveCaption(list, cap("u1", 2, "Your room is on"));
  list = applyLiveCaption(list, cap("u1", 1, "stale"));
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "Your room is on");
  list = applyLiveCaption(list, cap("u1", 3, "Your room is on the left.", { final: true }));
  list = applyLiveCaption(list, cap("u2", 1, "Anything else"));
  assert.deepEqual(list.map((c) => c.text), ["Your room is on the left.", "Anything else"]);
  assert.equal(list[0].final, true);
});

test("F3: a retracted line stays struck out and later revisions cannot restore it", () => {
  let list = applyLiveCaption([], cap("u1", 2, "wrong words", { final: true }));
  list = applyLiveCaption(list, cap("u1", 2, "wrong words", { retracted: true }));
  assert.equal(list[0].retracted, true);
  list = applyLiveCaption(list, cap("u1", 5, "new words"));
  assert.equal(list[0].retracted, true);
  assert.equal(list[0].text, "wrong words");
  // Retracting a line this page never saw adds nothing.
  assert.equal(applyLiveCaption(list, cap("zz", 1, "x", { retracted: true })).length, 1);
});

test("F3: the page keeps at most guestLiveCaptionsKept lines", () => {
  let list: GuestLiveCaption[] = [];
  for (let i = 0; i < FEATURE_LIMITS.guestLiveCaptionsKept + 4; i++) list = applyLiveCaption(list, cap(`u${i}`, 1, `line ${i}`));
  assert.equal(list.length, FEATURE_LIMITS.guestLiveCaptionsKept);
  assert.equal(list.at(-1)?.text, `line ${FEATURE_LIMITS.guestLiveCaptionsKept + 3}`);
});

/* F1 / F4 */
test("F1/F4: tiles in fixed order; the QR text is the title plus exactly the tile lines", () => {
  let facts: FactMap = {};
  facts = applyFact(facts, { key: "checkout", value: "11 am", source: "property", at: 1 });
  facts = applyFact(facts, { key: "room", value: "517", source: "staff_typed", at: 2 });
  facts = applyFact(facts, { key: "wifi_password", value: "blue-otter-42", source: "staff_typed", at: 3 });
  assert.deepEqual(factLines(facts), ["Room: 517", "Wi-Fi password: blue-otter-42", "Checkout: 11 am"]);
  assert.equal(takeHomeText(facts), [TAKE_HOME_TITLE, ...factLines(facts)].join("\n"));
  facts = clearFact(facts, "room");
  assert.deepEqual(factLines(facts), ["Wi-Fi password: blue-otter-42", "Checkout: 11 am"]);
  assert.equal(takeHomeText({}), null);
});

test("F1: values are capped and unknown keys are ignored", () => {
  const facts = applyFact({}, { key: "breakfast", value: "x".repeat(200), source: "property", at: 1 });
  assert.equal(facts.breakfast?.value.length, FEATURE_LIMITS.factValueMax);
  assert.deepEqual(applyFact({}, { key: "nope" as never, value: "1", source: "property", at: 1 }), {});
});

/* F7 U1 (guest-side mirror of the server check) */
test("F7: numbers are 1 to 6 digits only, with a reason otherwise", () => {
  assert.equal(numberProblem("3"), null);
  assert.equal(numberProblem("123456"), null);
  assert.match(numberProblem("") ?? "", /Type a number/);
  assert.match(numberProblem("1234567") ?? "", /up to 6/);
  assert.match(numberProblem("12a") ?? "", /digits only/);
  assert.match(numberProblem("-3") ?? "", /digits only/);
  assert.match(numberProblem("３") ?? "", /digits only/);
  assert.equal(numberLine("nights", "3"), "3 (nights)");
});

/* F9 */
test("F9: alerts are deduplicated by id, capped, and removed by id", () => {
  let list = addAlert([], { type: "desk_alert", id: "a1", code: "taxi_here" });
  list = addAlert(list, { type: "desk_alert", id: "a1", code: "taxi_here" });
  assert.equal(list.length, 1);
  for (let i = 2; i < 10; i++) list = addAlert(list, { type: "desk_alert", id: `a${i}`, code: "come_to_desk" });
  assert.equal(list.length, FEATURE_LIMITS.alertsOpenMax);
  assert.equal(removeAlert(list, "a9").length, FEATURE_LIMITS.alertsOpenMax - 1);
});

/* F11 U2 */
test("F11: the card holds only the ticked language, topic names and a fixed request", () => {
  const none = interpreterCard({ shareLanguage: false, language: "bfi", shareTopics: false, intents: [7, 4, 8], openRequest: "What time is breakfast?" });
  assert.deepEqual(interpreterCardLines(none), []);
  const both = interpreterCard({ shareLanguage: true, language: "bfi", shareTopics: true, intents: [4, 7, 8, 9, 1, 5], openRequest: "What time is breakfast?" });
  assert.deepEqual(interpreterCardLines(both), [
    "Sign language: British Sign Language (BSL)",
    "Topics so far: Wi-Fi, breakfast",
    "Last request: What time is breakfast?",
  ]);
  // Name, yes/no and thanks are never topics.
  assert.deepEqual(topicsFromIntents([4, 1, 2, 5, 20]), []);
});

/* F17 */
test("F17: offline receipt says nothing left the desk; vendors are named when used", () => {
  const hhmm = () => "10:42";
  const offline = receiptLines({ used: ["Pictures", "Typing"], captionBackends: ["local"], voice: "on_device", vendors: [], erasedAt: 0, itemsErased: 7 }, hhmm);
  assert.ok(offline.includes("No outside service received anything from this conversation."));
  assert.ok(offline.some((l) => l.includes("On this laptop")));
  assert.ok(offline.at(-1)?.startsWith("Erased at 10:42: 7 items."));
  const cloud = receiptLines({ used: [], captionBackends: ["browser_google"], voice: "cloud", vendors: ["Google (browser speech recognition)"], erasedAt: 0, itemsErased: 0 }, hhmm);
  assert.ok(cloud.some((l) => l.includes("Cloud: Google (Chrome speech recognition)")));
  assert.ok(cloud.some((l) => l.startsWith("Outside services that received data: Google")));
});

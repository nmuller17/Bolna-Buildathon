// node --test lib/voice/expectedAnswers.test.mjs   (Node strips the TypeScript types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapStaffTextToGloss } from "./intents.ts";
import { DEMO_SCRIPT, EXPECTED_AFTER, GUEST_ANSWERS, expectedAfter, scriptedExpected } from "./expectedAnswers.ts";

const root = new URL("../../../", import.meta.url);
const vocabulary = readFileSync(new URL("docs/vocabulary.md", root), "utf8");
const intentsOf = (text) =>
  // same split as components/speechToSigns.ts: one /api/gloss call per sentence
  (text.match(/[^.!?]+[.!?]*/g) ?? []).flatMap((s) => mapStaffTextToGloss(s.trim()).matches.map((m) => m.intentId));

test("the 20 guest answers are exactly docs/vocabulary.md section 2", () => {
  const section = vocabulary.split("## 2. Guest to staff")[1].split("## 3.")[0];
  const fromDoc = [...section.matchAll(/^\| \d+ \| `([^`]+)`/gm)].map((m) => m[1].replace(/ \+.*/, "").split(" "));
  assert.equal(fromDoc.length, 20);
  assert.deepEqual(new Set(Object.values(GUEST_ANSWERS).map((a) => a.join(" "))), new Set(fromDoc.map((a) => a.join(" "))));
});

test("the guest answers are the sentences the recognizer knows (recognition/intents.py)", () => {
  const py = readFileSync(new URL("recognition/intents.py", root), "utf8");
  const known = new Set([...py.matchAll(/\(\[([^\]]+)\],/g)].map((m) => m[1].replace(/"/g, "").split(", ").join(" ")));
  for (const answer of Object.values(GUEST_ANSWERS)) assert.ok(known.has(answer.join(" ")), answer.join(" "));
});

test("every receptionist intent has a rule", () => {
  for (const [id, rule] of Object.entries(EXPECTED_AFTER)) {
    assert.ok(rule === "any" || rule === "previous" || (Array.isArray(rule) && rule.length > 0), id);
    if (Array.isArray(rule)) for (const a of rule) assert.ok(a in GUEST_ANSWERS, `${id}: ${a}`);
  }
});

test("the question decides, not the greeting before it", () => {
  assert.deepEqual(expectedAfter(intentsOf("Welcome! Do you have a reservation?")), [["YES"], ["NO"], ["YES", "RESERVATION"]]);
  assert.deepEqual(expectedAfter(intentsOf("Welcome, what's your name?")), [["NAME"]]);
});

test("repeat keeps the previous answers, unknown and numbers do not restrict", () => {
  const before = [["YES"], ["NO"]];
  assert.deepEqual(expectedAfter(intentsOf("Sorry, can you repeat?"), before), before);
  assert.equal(expectedAfter(intentsOf("How many nights?")), null);
  assert.equal(expectedAfter(intentsOf("The pool is on the roof.")), null);
});

test("each demo script sentence triggers its step, and its answer is allowed after it", () => {
  let step = 0;
  for (const s of DEMO_SCRIPT) {
    const intents = intentsOf(s.staff);
    const r = scriptedExpected(step, intents);
    assert.ok(r.scripted, `"${s.staff}" -> ${intents.join(", ")} does not trigger step ${step + 1}`);
    assert.deepEqual(r.expected, [[...GUEST_ANSWERS[s.answer]]]);
    const allowed = EXPECTED_AFTER[intents.filter((i) => i !== "unknown").at(-1)];
    assert.ok(Array.isArray(allowed) && allowed.includes(s.answer), `${s.answer} not expected after "${s.staff}"`);
    step = r.nextStep;
  }
  assert.equal(step, DEMO_SCRIPT.length);
});

test("an off-script sentence falls back to the table and keeps the step", () => {
  const r = scriptedExpected(0, intentsOf("Parking is downstairs."));
  assert.equal(r.scripted, false);
  assert.equal(r.nextStep, 0);
  assert.deepEqual(r.expected, [["THANK-YOU"]]);
});

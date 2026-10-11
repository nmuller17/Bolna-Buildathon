// node --test lib/voice/expectedAnswers.test.mjs   (Node strips the TypeScript types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapStaffTextToGloss } from "./intents.ts";
import { DEMO_SCRIPT, EXPECTED_AFTER, GUEST_ANSWERS, afterScriptExpected, expectedAfter, scriptedExpected } from "./expectedAnswers.ts";

const root = new URL("../../../", import.meta.url);
const vocabulary = readFileSync(new URL("docs/vocabulary.md", root), "utf8");
const intentsOf = (text) =>
  // same split as components/speechToSigns.ts: one /api/gloss call per sentence
  (text.match(/[^.!?]+[.!?]*/g) ?? []).flatMap((s) => mapStaffTextToGloss(s.trim()).matches.map((m) => m.intentId));

test("the guest answers are exactly docs/vocabulary.md section 2", () => {
  const section = vocabulary.split("## 2. Guest to staff")[1].split("## 3.")[0];
  const fromDoc = [...section.matchAll(/^\| \d+ \| `([^`]+)`/gm)].map((m) => m[1].replace(/ \+.*/, "").split(" "));
  assert.equal(fromDoc.length, Object.keys(GUEST_ANSWERS).length);
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
  assert.deepEqual(expectedAfter(intentsOf("Welcome! Do you have a reservation?")),
    [["YES"], ["NO"], ["YES", "RESERVATION"], ["YES", "NAME"]]);
  assert.deepEqual(expectedAfter(intentsOf("Welcome, what's your name?")), [["NAME"], ["YES", "NAME"]]);
});

test("repeat keeps the previous answers, unknown and numbers do not restrict", () => {
  const before = [["YES"], ["NO"]];
  assert.deepEqual(expectedAfter(intentsOf("Sorry, can you repeat?"), before), before);
  assert.equal(expectedAfter(intentsOf("How many nights?")), null);
  assert.equal(expectedAfter(intentsOf("The pool is on the roof.")), null);
});

test("each demo script sentence carries its intent, and its answer is allowed after it", () => {
  for (const s of DEMO_SCRIPT) {
    const intents = intentsOf(s.staff).filter((i) => i !== "unknown");
    assert.ok(s.triggers.includes(intents.at(-1)), `"${s.staff}" -> ${intents.join(", ")}`);
    if (s.answer === null) continue;
    const allowed = EXPECTED_AFTER[intents.at(-1)];
    assert.ok(Array.isArray(allowed) && allowed.includes(s.answer), `${s.answer} not expected after "${s.staff}"`);
  }
});

test("script mode follows the steps whatever was transcribed, and skips steps without an answer", () => {
  let step = 0;
  for (const s of DEMO_SCRIPT) {
    const r = scriptedExpected(step, intentsOf("It's like a shampoo or something"));
    assert.ok(r.scripted);
    if (s.answer === null) {
      assert.ok(r.skip);
      assert.equal(r.expected, null);
    } else assert.deepEqual(r.expected, [[...GUEST_ANSWERS[s.answer]]]);
    step = r.nextStep;
  }
  assert.equal(step, DEMO_SCRIPT.length);
  const after = scriptedExpected(step, intentsOf("Parking is downstairs."));  // after the script
  assert.equal(after.scripted, false, "after the script: back to the table");
  assert.deepEqual(after.expected, [["THANK-YOU"]]);
});

test("classic answers after the script are the ones of the full demo, and allowed by the table", () => {
  const classic = [
    ["Can I see your ID?", ["YES"]],
    ["Breakfast is from 7 to 10.", ["LEAVE", "TIME"]],
    ["Checkout is at 11.", ["LATE", "LEAVE", "PLEASE"]],
    ["Late checkout is fine, until 1 PM.", ["MORE", "TOWEL", "PLEASE"]],
    ["I'll send towels to your room. Anything else?", ["NO", "THANK-YOU"]],
  ];
  for (const [staff, answer] of classic) {
    const r = afterScriptExpected(intentsOf(staff), staff);
    assert.deepEqual(r.expected, [answer], staff);
    const last = intentsOf(staff).filter((i) => i !== "unknown").at(-1);
    const id = Object.entries(GUEST_ANSWERS).find(([, a]) => a.join(" ") === answer.join(" "))[0];
    assert.ok(EXPECTED_AFTER[last].includes(id), `${staff}: ${id} not in the table`);
  }
  assert.equal(afterScriptExpected(intentsOf("Enjoy your stay!"), "Enjoy your stay!").skip, true);
  assert.deepEqual(afterScriptExpected(intentsOf("Did you like the hotel?"), "Did you like the hotel?").expected,
    [["YES"], ["NO"], ["THANK-YOU"]]);
});

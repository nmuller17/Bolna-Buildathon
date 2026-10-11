// Typed "Did you mean...?" matcher (docs/features-plan.md F8, acceptance test U3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchTyped, normaliseTyped } from "./typedmatch.ts";

const top = (t: string) => matchTyped(t)[0]?.intentId ?? null;

test("plan F8 U3: checkout questions and late checkout", () => {
  assert.equal(top("what time is check out"), 11);
  assert.equal(top("checkout?"), 11);
  assert.equal(top("late check out please"), 12);
});

test("plan F8 U3: an unrelated sentence has no match", () => {
  assert.deepEqual(matchTyped("my sister is coming"), []);
  assert.deepEqual(matchTyped(""), []);
  assert.deepEqual(matchTyped("   ?!  "), []);
});

test("common hotel requests reach the right fixed sentence", () => {
  assert.equal(top("Wi-Fi password?"), 7);
  assert.equal(top("whats the wifi"), 7);
  assert.equal(top("when is breakfast"), 8);
  assert.equal(top("where is breakfast served"), 9);
  assert.equal(top("can i get more towels"), 10);
  assert.equal(top("where can I park my car"), 13);
  assert.equal(top("I need a taxi to the airport"), 14);
  assert.equal(top("where is my room"), 16);
  assert.equal(top("my key card doesn't work"), 17);
  assert.equal(top("key"), 17);
  assert.equal(top("where is the elevator"), 6);
  assert.equal(top("restaurant hours?"), 19);
  assert.equal(top("where's the restaurant"), 18);
  assert.equal(top("I have a reservation"), 3);
  assert.equal(top("yes"), 1);
  assert.equal(top("thanks!"), 5);
  assert.equal(top("no thanks, that's all"), 20);
});

test("short-only answers never fire inside longer sentences", () => {
  assert.notEqual(top("no hot water in the shower"), 2);
  assert.equal(top("no hot water in the shower"), 17);
  assert.notEqual(top("yes I would like to know where the elevator is"), 1);
});

test("at most three choices, best first, ties in vocabulary order", () => {
  const m = matchTyped("breakfast");
  assert.ok(m.length <= 3);
  assert.deepEqual(matchTyped("breakfast where and when").map((x) => x.intentId).slice(0, 2).sort(), [8, 9]);
  for (let i = 1; i < m.length; i++) assert.ok(m[i - 1].score >= m[i].score);
  assert.ok(matchTyped("where is the room with breakfast and parking and the elevator and taxi").length <= 3);
});

test("normalisation: NFKC, full-width letters, apostrophes and spacing variants", () => {
  assert.equal(normaliseTyped("ＣＨＥＣＫ ＯＵＴ"), " checkout ");
  assert.equal(normaliseTyped("Wi fi"), " wifi ");
  assert.equal(top("ｗｈａｔ ｔｉｍｅ ｉｓ ｃｈｅｃｋｏｕｔ"), 11);
});

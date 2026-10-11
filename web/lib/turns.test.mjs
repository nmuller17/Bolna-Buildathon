// node --test lib/turns.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { GUEST_TURN_DELAY_MS, REQUEST_TIMEOUT_MS, guestTurnDue, initialTurns, nextExpected, turnsReducer } from "./turns.ts";

const run = (events, start = initialTurns(0)) => events.reduce(turnsReducer, start);

test("full cycle: receptionist, guest answer spoken, back to the receptionist", () => {
  let s = run([
    { type: "staffBusy", now: 0 },
    { type: "staffSigned", intents: ["welcome", "reservation_question"], now: 4000 },
    { type: "staffIdle", now: 4000 },
  ]);
  assert.equal(guestTurnDue(s, 4000 + GUEST_TURN_DELAY_MS - 1), false);
  assert.equal(guestTurnDue(s, 4000 + GUEST_TURN_DELAY_MS), true);
  const next = nextExpected(s, false);
  assert.deepEqual(next.expected, [["YES"], ["NO"], ["YES", "RESERVATION"], ["YES", "NAME"]]);
  s = run(
    [
      { type: "requested", ...next, now: 4600 },
      { type: "turnStart", now: 4700 },
      { type: "utterance", text: "Yes, my name is Sam.", now: 9000 },
      { type: "turnEnd", empty: false, now: 9010 },
    ],
    s,
  );
  assert.equal(s.phase, "speaking");
  assert.equal(s.said, "Yes, my name is Sam.");
  s = turnsReducer(s, { type: "spoken", now: 11000 });
  assert.equal(s.phase, "frontDesk");
  assert.equal(guestTurnDue(turnsReducer(s, { type: "staffIdle", now: 11000 }), 12000), false, "needs a new staff sentence");
});

test("no guest turn before the receptionist said anything", () => {
  const s = run([{ type: "staffIdle", now: 0 }]);
  assert.equal(guestTurnDue(s, 10000), false);
});

test("the receptionist talking again cancels the pending guest turn", () => {
  let s = run([
    { type: "staffSigned", intents: ["room_number"], now: 0 },
    { type: "staffIdle", now: 0 },
    { type: "staffBusy", now: 300 },
  ]);
  assert.equal(guestTurnDue(s, 2000), false);
  s = run([{ type: "staffSigned", intents: ["key_card"], now: 3000 }, { type: "staffIdle", now: 3000 }], s);
  assert.equal(guestTurnDue(s, 3000 + GUEST_TURN_DELAY_MS), true);
  assert.deepEqual(s.lastIntents, ["key_card"], "the last sentence decides");
});

test("empty guest turn goes straight back to the receptionist", () => {
  const s = run([
    { type: "staffSigned", intents: ["enjoy_stay"], now: 0 },
    { type: "requested", expected: [["THANK-YOU"]], scriptStep: 0, scripted: false, now: 600 },
    { type: "turnStart", now: 700 },
    { type: "turnEnd", empty: true, now: 9000 },
  ]);
  assert.equal(s.phase, "frontDesk");
});

test("recognizer down: back to the receptionist, marked offline", () => {
  let s = run([
    { type: "staffSigned", intents: ["welcome"], now: 0 },
    { type: "requested", expected: null, scriptStep: 0, scripted: false, now: 600 },
  ]);
  s = turnsReducer(s, { type: "tick", now: 600 + REQUEST_TIMEOUT_MS + 1 });
  assert.equal(s.phase, "frontDesk");
  assert.equal(s.offline, true);
});

test("what the mic hears during the guest's turn is ignored", () => {
  let s = run([
    { type: "staffSigned", intents: ["welcome"], now: 0 },
    { type: "requested", expected: null, scriptStep: 0, scripted: false, now: 600 },
    { type: "turnStart", now: 700 },
  ]);
  s = turnsReducer(s, { type: "staffSigned", intents: ["parking_downstairs"], now: 800 });
  assert.equal(s.phase, "guest");
  assert.deepEqual(s.lastIntents, ["welcome"]);
});

test("script mode: one expected answer per step, then the next step", () => {
  let s = run([{ type: "staffSigned", intents: ["welcome", "reservation_question"], now: 0 }]);
  let next = nextExpected(s, true);
  assert.deepEqual(next.expected, [["YES", "NAME"]]);
  assert.equal(next.scriptStep, 1);
  s = run(
    [
      { type: "requested", ...next, now: 600 },
      { type: "turnStart", now: 700 },
      { type: "utterance", text: "Yes, my name is Sam.", now: 5000 },
      { type: "spoken", now: 7000 },
      { type: "staffSigned", intents: ["room_number", "key_card"], now: 9000 },
    ],
    s,
  );
  next = nextExpected(s, true);
  assert.deepEqual(next.expected, [["WHERE", "ELEVATOR"]]);
  assert.equal(next.scriptStep, 2);
  assert.equal(turnsReducer(s, { type: "resetScript", now: 1 }).scriptStep, 0);
});

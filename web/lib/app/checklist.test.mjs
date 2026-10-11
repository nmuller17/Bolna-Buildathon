// Unit tests for the check-in co-pilot reducer (web/lib/app/checklist.ts).
// Run from web/: node --test lib/app/checklist.test.mjs   (Node >= 22.18 strips the TypeScript types)
// Staff sentences go through P1's real matcher (web/lib/voice/intents.ts), as on /staff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKIN_ITEMS, initChecklist, isTicked, notSharedBeforeGoodbye, onGuestSigned, onStaffSent } from "./checklist.ts";
import { mapStaffTextToGloss } from "../voice/intents.ts";

const intents = (text) => mapStaffTextToGloss(text).matches.map((m) => m.intentId);
const staff = (list, text, at = 1000) => onStaffSent(list, intents(text), text, at);
const item = (list, key) => list.find((s) => s.key === key);
const ticked = (list) => list.filter(isTicked).map((s) => s.key);

test("starts with every item not shared", () => {
  const list = initChecklist();
  assert.equal(list.length, CHECKIN_ITEMS.length);
  assert.deepEqual(ticked(list), []);
  assert.ok(list.every((s) => s.at === null && s.sentence === null && s.guestAskedAt === null));
});

test("each staff sentence of docs/vocabulary.md section 1 ticks its own item and nothing else", () => {
  const cases = [
    ["Welcome!", "greeting"],
    ["Do you have a reservation?", "reservation"],
    ["What's your name?", "guest_name"],
    ["Can I see your ID?", "id"],
    ["How many nights?", "nights"],
    ["You're in room 412.", "room_number"],
    ["Here is your key card.", "key_card"],
    ["The elevator is on your left.", "elevator"],
    ["Breakfast is from 7 to 10.", "breakfast"],
    ["The Wi-Fi password is on your key card.", "wifi"],
    ["Checkout is at 11.", "checkout"],
    ["Late checkout is fine, until 1 PM.", "checkout"],
    ["Anything else?", "anything_else"],
    ["Enjoy your stay!", "farewell"],
  ];
  for (const [text, key] of cases) {
    const list = staff(initChecklist(), text, 42);
    assert.deepEqual(ticked(list), [key], text);
    assert.deepEqual(item(list, key), { key, state: "sent", at: 42, sentence: text, guestAskedAt: null }, text);
  }
});

test("staff sentences outside the check-in items tick nothing", () => {
  for (const text of ["I'll send towels to your room.", "Parking is downstairs.", "One moment, please.", "Sorry, can you repeat?", "I'll call a taxi for you."]) {
    assert.deepEqual(ticked(staff(initChecklist(), text)), [], text);
  }
});

test("one spoken line with two intents ticks both (Whisper comma case)", () => {
  assert.deepEqual(ticked(staff(initChecklist(), "Welcome, do you have a reservation?")).sort(), ["greeting", "reservation"]);
});

test("the guest asking is a hint, not a tick; sharing the item clears the hint", () => {
  let list = onGuestSigned(initChecklist(), ["FS-WIFI", "PASSWORD"], "What's the Wi-Fi password?", 500);
  assert.deepEqual(ticked(list), []);
  assert.equal(item(list, "wifi").guestAskedAt, 500);
  // asking again keeps the first time
  list = onGuestSigned(list, ["FS-WIFI", "PASSWORD"], "What's the Wi-Fi password?", 900);
  assert.equal(item(list, "wifi").guestAskedAt, 500);
  list = staff(list, "The Wi-Fi password is on your key card.", 1200);
  assert.equal(item(list, "wifi").state, "sent");
  assert.equal(item(list, "wifi").guestAskedAt, null);
});

test("asking about an item that was already shared adds no hint", () => {
  let list = staff(initChecklist(), "Checkout is at 11.", 100);
  list = onGuestSigned(list, ["LEAVE", "TIME"], "What time is checkout?", 200);
  assert.equal(item(list, "checkout").guestAskedAt, null);
  assert.equal(item(list, "checkout").at, 100);
});

test("only the exact guest sign sequence confirms; a confirmed item stays confirmed", () => {
  let list = onGuestSigned(initChecklist(), ["RESERVATION", "YES"], "?", 10);
  assert.deepEqual(ticked(list), []);
  list = onGuestSigned(list, ["YES", "RESERVATION"], "Yes, I have a reservation.", 20);
  assert.deepEqual(item(list, "reservation"), { key: "reservation", state: "confirmed", at: 20, sentence: "Yes, I have a reservation.", guestAskedAt: null });
  list = staff(list, "Do you have a reservation?", 30);
  assert.equal(item(list, "reservation").state, "confirmed");
  assert.equal(item(list, "reservation").at, 20);
});

test("single YES or NO from the guest ticks nothing", () => {
  assert.deepEqual(ticked(onGuestSigned(initChecklist(), ["YES"], "Yes.", 1)), []);
  assert.deepEqual(ticked(onGuestSigned(initChecklist(), ["NO"], "No.", 1)), []);
});

test("gentle reminder appears only once the conversation wraps up, and lists what is still open", () => {
  let list = staff(initChecklist(), "Welcome!");
  list = staff(list, "Breakfast is from 7 to 10.");
  assert.deepEqual(notSharedBeforeGoodbye(list), []);
  list = onGuestSigned(list, ["NO", "THANK-YOU"], "No, that's all, thank you.", 2000);
  assert.equal(item(list, "anything_else").state, "confirmed");
  const open = notSharedBeforeGoodbye(list);
  assert.ok(open.includes("Wi-Fi password") && open.includes("Checkout time"));
  assert.ok(!open.includes("Breakfast") && !open.includes("Greeting") && !open.includes("Farewell"));
});

test("reducers never mutate their input", () => {
  const list = initChecklist();
  const copy = structuredClone(list);
  staff(list, "Welcome!");
  onGuestSigned(list, ["YES", "RESERVATION"], "Yes, I have a reservation.", 1);
  assert.deepEqual(list, copy);
});

// Guided recognition: which guest answers make sense after what the receptionist just said.
// The guest can only answer with the 20 sentences of docs/vocabulary.md section 2. The sign recognizer
// (recognition/live_key.py, POST /turn {"expected": [...]}) only considers the answers listed here, so a
// misread sign cannot become an unrelated sentence. The last intent of the receptionist's sentence decides
// ("Welcome! Do you have a reservation?" -> answers to the question, not to the greeting).
import type { StaffIntentId } from "./intents";

/** The 22 guest sentences (docs/vocabulary.md section 2), as classifier label lists. */
export const GUEST_ANSWERS = {
  yes: ["YES"],
  no: ["NO"],
  yes_reservation: ["YES", "RESERVATION"],
  name: ["NAME"],
  thank_you: ["THANK-YOU"],
  where_elevator: ["WHERE", "ELEVATOR"],
  wifi_password: ["FS-WIFI", "PASSWORD"],
  breakfast_time: ["BREAKFAST", "TIME"],
  where_breakfast: ["WHERE", "BREAKFAST"],
  more_towels: ["MORE", "TOWEL", "PLEASE"],
  checkout_time: ["LEAVE", "TIME"],
  late_checkout: ["LATE", "LEAVE", "PLEASE"],
  where_parking: ["WHERE", "PARKING"],
  taxi: ["TAXI", "PLEASE"],
  help: ["HELP", "PLEASE"],
  where_room: ["WHERE", "ROOM"],
  room_problem: ["ROOM", "HELP"],
  where_restaurant: ["WHERE", "RESTAURANT"],
  restaurant_time: ["RESTAURANT", "TIME"],
  no_thanks: ["NO", "THANK-YOU"],
  yes_name: ["YES", "NAME"], // "Yes, my name is Sam." (name fingerspelled after NAME)
  thanks_where_elevator: ["THANK-YOU", "WHERE", "ELEVATOR"], // "Thank you. Where is the elevator?"
} as const satisfies Record<string, readonly string[]>;

export type GuestAnswerId = keyof typeof GUEST_ANSWERS;

/** Every guest request a receptionist's "anything else?" can lead to. */
const REQUESTS: GuestAnswerId[] = [
  "no_thanks", "more_towels", "wifi_password", "breakfast_time", "where_breakfast", "checkout_time",
  "late_checkout", "where_parking", "taxi", "help", "where_room", "room_problem", "where_elevator",
  "where_restaurant", "restaurant_time",
];

/**
 * After each receptionist intent, the answers a guest would plausibly give right away.
 * "previous": keep the answers expected before (the receptionist asked the guest to repeat).
 * "any": no restriction (the answer is not in the guest vocabulary, e.g. a number of nights).
 */
export const EXPECTED_AFTER: Record<StaffIntentId, GuestAnswerId[] | "previous" | "any"> = {
  welcome: ["yes_reservation", "thank_you", "help"],                       // "Welcome!"
  reservation_question: ["yes", "no", "yes_reservation", "yes_name"],     // "Do you have a reservation?"
  name_question: ["name", "yes_name"],                                    // "What's your name?"
  id_please: ["yes", "no"],                                               // "Can I see your ID?"
  nights_question: "any",                                                 // "How many nights?" (a number: not signable)
  room_number: ["thank_you", "where_room", "where_elevator", "thanks_where_elevator"], // "You're in room 412."
  key_card: ["thank_you", "wifi_password", "where_room", "where_elevator", "thanks_where_elevator"], // "Here is your key card."
  elevator_left: ["thank_you", "wifi_password", "breakfast_time"],         // "The elevator is on your left."
  breakfast_time: ["thank_you", "where_breakfast", "checkout_time"],      // "Breakfast is from 7 to 10."
  wifi_password: ["thank_you", "breakfast_time"],                         // "The Wi-Fi password is on your key card."
  checkout_time: ["thank_you", "late_checkout"],                          // "Checkout is at 11."
  late_checkout: ["thank_you", "more_towels"],                            // "Late checkout is fine, until 1 PM."
  send_towels: ["thank_you"],                                             // "I'll send towels to your room."
  parking_downstairs: ["thank_you"],                                      // "Parking is downstairs."
  restaurant_hours: ["thank_you", "where_restaurant"],                    // "The restaurant is open until 10 PM."
  call_taxi: ["thank_you"],                                               // "I'll call a taxi for you."
  wait_please: ["thank_you", "yes"],                                      // "One moment, please."
  repeat_please: "previous",                                              // "Sorry, can you repeat?"
  anything_else: REQUESTS,                                                // "Anything else?"
  enjoy_stay: ["thank_you"],                                              // "Enjoy your stay!"
  unknown: "any",
};

/** Label lists for POST /turn {"expected": ...}; null = no restriction (all 20 sentences). */
export type Expected = string[][] | null;

const toLabels = (ids: GuestAnswerId[]): string[][] => ids.map((id) => [...GUEST_ANSWERS[id]]);

/**
 * Expected answers after a receptionist utterance, from its intents in spoken order. The last intent
 * that is not "unknown" decides. `previous` is what was expected before (used by "repeat").
 */
export function expectedAfter(intents: readonly StaffIntentId[], previous: Expected = null): Expected {
  const last = [...intents].reverse().find((id) => id !== "unknown");
  if (!last) return null;
  const rule = EXPECTED_AFTER[last];
  if (rule === "any") return null;
  if (rule === "previous") return previous;
  return toLabels(rule);
}

/**
 * One step of the scripted demo: what the receptionist says, the intent it is expected to carry (checked by the
 * tests only) and the single answer the guest gives (null: no guest turn, e.g. the closing sentence).
 */
export type ScriptStep = { staff: string; triggers: StaffIntentId[]; answer: GuestAnswerId | null };

/**
 * Scripted demo (?script=1): one expected answer per guest turn, so the translation cannot fail. The script
 * advances one step per receptionist turn whatever Whisper transcribed ("keycard" once blocked it). Each answer is
 * also allowed by EXPECTED_AFTER for that step's intent (checked by the tests).
 */
export const DEMO_SCRIPT: ScriptStep[] = [
  { staff: "Welcome! Do you have a reservation?", triggers: ["reservation_question"], answer: "yes_name" },
  { staff: "Can I see your ID?", triggers: ["id_please"], answer: "yes" },
  { staff: "Sam, you're in room 412. Here is your key card.", triggers: ["key_card"], answer: "thanks_where_elevator" },
  { staff: "The elevator is on your left.", triggers: ["elevator_left"], answer: "wifi_password" },
  { staff: "The Wi-Fi password is on your key card.", triggers: ["wifi_password"], answer: "breakfast_time" },
  { staff: "Breakfast is from 7 to 10.", triggers: ["breakfast_time"], answer: "checkout_time" },
  { staff: "Checkout is at 11.", triggers: ["checkout_time"], answer: "late_checkout" },
  { staff: "Late checkout is fine, until 1 PM.", triggers: ["late_checkout"], answer: "more_towels" },
  { staff: "I'll send towels to your room. Anything else?", triggers: ["anything_else"], answer: "no_thanks" },
  { staff: "Enjoy your stay!", triggers: ["enjoy_stay"], answer: null },
];

/**
 * Script mode: the current step decides, whatever the receptionist's intents were (skip: that step has no guest
 * answer, no guest turn). After the last step, fall back to expectedAfter.
 */
export function scriptedExpected(
  step: number,
  intents: readonly StaffIntentId[],
  previous: Expected = null,
): { expected: Expected; nextStep: number; scripted: boolean; skip: boolean } {
  const current = DEMO_SCRIPT[step];
  if (current) {
    return current.answer
      ? { expected: toLabels([current.answer]), nextStep: step + 1, scripted: true, skip: false }
      : { expected: null, nextStep: step + 1, scripted: true, skip: true };
  }
  return { expected: expectedAfter(intents, previous), nextStep: step, scripted: false, skip: false };
}

// ---- Q&A with the jury, after the script -------------------------------------------------------------------------
// A team member holds Space and says the juror's question; the bellhop signs it; the guest answers with a simple
// sentence made only of learned signs: always YES / NO / THANK-YOU, plus the guest sentences about a topic the
// question mentions ("Do you need a taxi?" -> TAXI PLEASE). A sentence that is not a question gets no guest turn.

const QUESTION_START = /^(do|does|did|is|are|was|were|can|could|would|will|have|has|had|should|shall|may|might|what|where|when|why|who|how|which)\b/i;

/** True for a question: a question mark, or a sentence starting like one (Whisper sometimes drops the "?"). */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || QUESTION_START.test(t);
}

const QA_ALWAYS: GuestAnswerId[] = ["yes", "no", "thank_you"];

// Topic words of the question -> guest sentences about that topic (all made of learned signs).
const QA_TOPICS: [RegExp, GuestAnswerId[]][] = [
  [/\bname\b/i, ["name", "yes_name"]],
  [/\b(reservation|booking|booked)\b/i, ["yes_reservation"]],
  [/\b(elevator|lift)\b/i, ["where_elevator"]],
  [/\b(wi-?fi|internet|password)\b/i, ["wifi_password"]],
  [/\bbreakfast\b/i, ["breakfast_time", "where_breakfast"]],
  [/\b(towel|towels)\b/i, ["more_towels"]],
  [/\b(checkout|check out|leave|leaving)\b/i, ["checkout_time", "late_checkout"]],
  [/\b(parking|park|car|garage)\b/i, ["where_parking"]],
  [/\b(taxi|cab|uber)\b/i, ["taxi"]],
  [/\bhelp\b/i, ["help"]],
  [/\broom\b/i, ["where_room", "room_problem"]],
  [/\b(restaurant|dinner|lunch|eat)\b/i, ["where_restaurant", "restaurant_time"]],
  [/\b(anything else|something else)\b/i, ["no_thanks"]],
];

/** Expected answers to a juror's question: null when it is not a question (no guest turn). */
export function qaExpected(question: string): Expected {
  if (!isQuestion(question)) return null;
  const ids = [...QA_ALWAYS];
  for (const [pattern, answers] of QA_TOPICS) {
    if (pattern.test(question)) for (const id of answers) if (!ids.includes(id)) ids.push(id);
  }
  return toLabels(ids);
}

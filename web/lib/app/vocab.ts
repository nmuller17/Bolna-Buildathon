// SignBridge app (P4, builder A): the two fixed tables of docs/vocabulary.md (sections 1 and 2).
//
// - STAFF_INTENTS: the 20 receptionist sentences with their fixed glosses (quick replies, CAP-1).
// - GUEST_INTENTS: the 20 guest requests with their sign multisets and fixed spoken sentences (SPK-4).
// vocab.test.ts parses docs/vocabulary.md and checks that both tables match it word for word, and
// that every fixed guest sentence is one Nath's /api/tts caches (so a confirmed sentence is never
// synthesized uncached). Erasable TypeScript, imports with ".ts" so node --test can load it.
import type { GuestIntent, GuestIntentId, SignLabel, StaffIntent, StaffIntentKey } from "./types.ts";

type StaffRow = [StaffIntentKey, string, string, string];

// [key, sentence, gloss, short button label] in vocabulary.md section 1 order.
const STAFF_ROWS: StaffRow[] = [
  ["welcome", "Welcome!", "HELLO WELCOME", "Welcome!"],
  ["reservation_question", "Do you have a reservation?", "BROWS-UP YOU HAVE RESERVATION", "Reservation?"],
  ["name_question", "What's your name?", "BROWS-DOWN YOUR NAME WHAT", "Your name?"],
  ["id_please", "Can I see your ID?", "FS:ID SHOW PLEASE", "See your ID?"],
  ["nights_question", "How many nights?", "BROWS-DOWN NIGHT HOW-MANY", "Nights?"],
  ["room_number", "You're in room 412.", "YOUR ROOM 4 1 2", "Room 412"],
  ["key_card", "Here is your key card.", "YOUR KEY CARD HERE", "Key card"],
  ["elevator_left", "The elevator is on your left.", "ELEVATOR THERE LEFT", "Elevator left"],
  ["breakfast_time", "Breakfast is from 7 to 10.", "BREAKFAST TIME 7 UNTIL 10", "Breakfast 7-10"],
  ["wifi_password", "The Wi-Fi password is on your key card.", "FS:WIFI PRIVATE WORD YOUR KEY CARD", "Wi-Fi"],
  ["checkout_time", "Checkout is at 11.", "LEAVE TIME 11", "Checkout 11"],
  ["late_checkout", "Late checkout is fine, until 1 PM.", "LATE LEAVE FINE UNTIL 1", "Late checkout"],
  ["send_towels", "I'll send towels to your room.", "TOWEL ME SEND YOUR ROOM", "Towels"],
  ["parking_downstairs", "Parking is downstairs.", "PARKING DOWN", "Parking"],
  ["restaurant_hours", "The restaurant is open until 10 PM.", "RESTAURANT OPEN UNTIL 10 NIGHT", "Restaurant"],
  ["call_taxi", "I'll call a taxi for you.", "TAXI ME CALL", "Taxi"],
  ["wait_please", "One moment, please.", "WAIT PLEASE", "One moment"],
  ["repeat_please", "Sorry, can you repeat?", "BROWS-UP SORRY AGAIN PLEASE", "Repeat?"],
  ["anything_else", "Anything else?", "BROWS-UP OTHER QUESTION", "Anything else?"],
  ["enjoy_stay", "Enjoy your stay!", "ENJOY YOUR STAY", "Enjoy stay"],
];

export const STAFF_INTENTS: readonly StaffIntent[] = STAFF_ROWS.map(([key, text, gloss, short], i) => {
  const tokens = gloss.split(" ");
  const marker = tokens[0] === "BROWS-UP" ? "brows-up" : tokens[0] === "BROWS-DOWN" ? "brows-down" : null;
  return { key, row: i + 1, text, gloss: tokens, marker, short };
});

const STAFF_BY_KEY = new Map(STAFF_INTENTS.map((s) => [s.key, s]));

export function staffIntent(key: string): StaffIntent | null {
  return STAFF_BY_KEY.get(key as StaffIntentKey) ?? null;
}

// [signs in documented order, sentence] in vocabulary.md section 2 order. Intent 4 is the NAME
// template: "My name is {name}." (the table's example name is John Smith).
const GUEST_ROWS: [string, string][] = [
  ["YES", "Yes."],
  ["NO", "No."],
  ["YES RESERVATION", "Yes, I have a reservation."],
  ["NAME", "My name is {name}."],
  ["THANK-YOU", "Thank you."],
  ["WHERE ELEVATOR", "Where is the elevator?"],
  ["FS-WIFI PASSWORD", "What's the Wi-Fi password?"],
  ["BREAKFAST TIME", "What time is breakfast?"],
  ["WHERE BREAKFAST", "Where is breakfast served?"],
  ["MORE TOWEL PLEASE", "Could I have more towels, please?"],
  ["LEAVE TIME", "What time is checkout?"],
  ["LATE LEAVE PLEASE", "Could I have a late checkout?"],
  ["WHERE PARKING", "Where can I park?"],
  ["TAXI PLEASE", "Could you call me a taxi?"],
  ["HELP PLEASE", "I need some help, please."],
  ["WHERE ROOM", "Where is my room?"],
  ["ROOM HELP", "There's a problem with my room."],
  ["WHERE RESTAURANT", "Where is the restaurant?"],
  ["RESTAURANT TIME", "When is the restaurant open?"],
  ["NO THANK-YOU", "No, that's all, thank you."],
];

export const NAME_TEMPLATE = "My name is {name}.";

export const GUEST_INTENTS: readonly GuestIntent[] = GUEST_ROWS.map(([signs, text], i) => ({
  id: (i + 1) as GuestIntentId,
  signs: signs.split(" ") as SignLabel[],
  text,
  needsName: text === NAME_TEMPLATE,
}));

export function guestIntent(id: number): GuestIntent | null {
  return Number.isInteger(id) && id >= 1 && id <= GUEST_INTENTS.length ? GUEST_INTENTS[id - 1] : null;
}

/** The sentence a confirmed guest intent produces. The name must already be sanitized. */
export function guestSentence(intent: GuestIntent, name?: string | null): string {
  return intent.needsName ? NAME_TEMPLATE.replace("{name}", name ?? "") : intent.text;
}

/** The fixed sentences that may be voiced through /api/tts (every guest intent except NAME). */
export const FIXED_GUEST_SENTENCES: ReadonlySet<string> = new Set(
  GUEST_INTENTS.filter((g) => !g.needsName).map((g) => g.text),
);

/** Fixed sentence for /api/tts { id } (RT5). Null for NAME and unknown ids: those are never sent to a TTS route. */
export function fixedSentenceForId(id: unknown): string | null {
  const g = typeof id === "number" ? guestIntent(id) : null;
  return g && !g.needsName ? g.text : null;
}

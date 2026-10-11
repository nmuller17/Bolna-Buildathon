// Typed "Did you mean...?" (docs/features-plan.md F8). Runs in the guest page only, on the guest's own
// typed text, before anything is sent: a pure function, no network, no storage, no logging.
//
// The guest typed free text. If it looks like one of the 20 fixed requests (docs/vocabulary.md
// section 2), the page offers up to three of them ("Did you mean: What time is checkout?") next to
// "Send my words as typed". A picked match is sent as the fixed sentence (guest_phrase with
// via "typed_match"), so the desk gets a sentence it can voice from the cache; the guest's own words
// are never changed or sent behind their back.
//
// Matching is keyword rules, not a model: each request has groups of words that must all appear
// (any word of a group counts) and optional words that add weight. Erasable TypeScript only.
import type { GuestIntentId } from "./types.ts";

type Rule = {
  id: GuestIntentId;
  /** Every group needs at least one hit. */
  all: readonly (readonly string[])[];
  /** Each hit adds one point. */
  bonus?: readonly string[];
  /** Only for very short messages ("yes", "no thanks"): avoids "no hot water" becoming "No.". */
  shortOnly?: number;
};

const WHERE = ["where", "wheres", "find", "location", "located", "which floor", "how do i get", "way to"];
const WHEN = ["time", "when", "what time", "hours", "open", "opens", "start", "starts", "until", "close", "closes"];
const CHECKOUT = ["checkout", "leave", "leaving", "check me out"];
const ROOM_TROUBLE = [
  "problem", "broken", "not working", "doesnt work", "does not work", "dirty", "key", "keycard", "key card",
  "locked out", "locked", "noisy", "noise", "cold", "too hot", "hot water", "shower", "toilet", "heating",
  "air conditioning", "ac", "tv", "light", "lights", "smell", "leak", "change room", "wrong room",
];

const RULES: readonly Rule[] = [
  { id: 1, all: [["yes", "yeah", "yep", "yup", "correct", "right", "sure", "ok", "okay"]], shortOnly: 3 },
  { id: 2, all: [["no", "nope", "not really"]], shortOnly: 2 },
  { id: 3, all: [["reservation", "booking", "booked", "reserved", "check in", "checking in"]], bonus: ["i have", "under", "yes"] },
  { id: 4, all: [["my name", "name is", "call me"]], bonus: ["name"] },
  { id: 5, all: [["thank", "thanks", "thank you", "thx", "appreciate"]], shortOnly: 4 },
  { id: 6, all: [["elevator", "elevators", "lift", "lifts"]], bonus: WHERE },
  { id: 7, all: [["wifi", "internet", "wireless", "network", "password"]], bonus: ["password", "code", "connect", "login"] },
  { id: 8, all: [["breakfast"], WHEN], bonus: ["breakfast"] },
  { id: 9, all: [["breakfast"], [...WHERE, "served", "room", "eat", "place"]], bonus: ["served"] },
  { id: 10, all: [["towel", "towels", "bath towel", "linen", "linens", "sheets"]], bonus: ["more", "extra", "another", "new", "clean"] },
  { id: 11, all: [CHECKOUT], bonus: WHEN },
  { id: 12, all: [["late", "later", "extend", "extra hour", "stay longer"], CHECKOUT], bonus: ["can i", "could i", "please", "possible"] },
  { id: 13, all: [["park", "parking", "car", "garage", "valet"]], bonus: WHERE },
  { id: 14, all: [["taxi", "cab", "uber", "lyft", "ride", "car to", "airport"]], bonus: ["call", "need", "get", "book"] },
  { id: 15, all: [["help", "assist", "assistance", "support", "urgent", "need someone"]], bonus: ["please", "need"] },
  { id: 16, all: [["room"], WHERE], bonus: ["my room", "find"] },
  { id: 17, all: [ROOM_TROUBLE], bonus: ["room", "my room"] },
  { id: 18, all: [["restaurant", "dinner", "lunch", "eat", "food", "bar"], WHERE] },
  { id: 19, all: [["restaurant", "dinner", "lunch", "kitchen", "bar"], WHEN] },
  { id: 20, all: [["thats all", "that is all", "nothing else", "no thanks", "no thank you", "all good", "im good", "im done", "done"]], bonus: ["no", "thats all", "nothing else", "all"], shortOnly: 6 },
];

/** Lower case, NFKC, apostrophes dropped, "check out" -> "checkout", "wi-fi" -> "wifi", punctuation to spaces. */
export function normaliseTyped(raw: string): string {
  return ` ${raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/\bwi[\s-]*fi\b/g, "wifi")
    .replace(/\bcheck[\s-]+out\b/g, "checkout")
    .replace(/\bcheck[\s-]+in\b/g, "check in")
    .replace(/\be[\s-]*mail\b/g, "email")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

const has = (text: string, term: string) => text.includes(` ${term} `);

export type TypedMatch = { intentId: GuestIntentId; score: number };

/**
 * Up to `max` fixed requests that the typed text looks like, best first (ties keep vocabulary
 * order). Empty when nothing matches: the page then sends the guest's words as typed.
 */
export function matchTyped(raw: string, max = 3): TypedMatch[] {
  const text = normaliseTyped(raw);
  const words = text.trim() ? text.trim().split(" ").length : 0;
  if (words === 0) return [];
  const out: TypedMatch[] = [];
  for (const r of RULES) {
    if (r.shortOnly !== undefined && words > r.shortOnly) continue;
    if (!r.all.every((group) => group.some((t) => has(text, t)))) continue;
    const bonus = (r.bonus ?? []).filter((t) => has(text, t)).length;
    out.push({ intentId: r.id, score: r.all.length * 2 + bonus });
  }
  // "late checkout" also satisfies "checkout": the more specific request (more required groups) wins.
  out.sort((a, b) => b.score - a.score || a.intentId - b.intentId);
  return out.slice(0, max);
}

export type StaffIntentId =
  | "welcome"
  | "reservation_question"
  | "name_question"
  | "id_please"
  | "nights_question"
  | "room_number"
  | "key_card"
  | "elevator_left"
  | "breakfast_time"
  | "wifi_password"
  | "checkout_time"
  | "late_checkout"
  | "send_towels"
  | "parking_downstairs"
  | "restaurant_hours"
  | "call_taxi"
  | "wait_please"
  | "repeat_please"
  | "anything_else"
  | "enjoy_stay"
  | "unknown";

type IntentRule = {
  id: Exclude<StaffIntentId, "unknown">;
  gloss: string[];
  patterns: RegExp[];
};

// Glosses from docs/vocabulary.md section 1. Order matters: on a tie, the earlier rule wins,
// so specific intents come before the generic ones they overlap with (Wi-Fi before key card,
// late checkout before checkout, towels before room number).
// Slots (room number, times) are filled by applySlots.
export const STAFF_INTENTS: IntentRule[] = [
  rule("welcome", ["HELLO", "WELCOME"], ["welcome", "hello", "good evening", "good morning"]),
  rule("reservation_question", ["BROWS-UP", "YOU", "HAVE", "RESERVATION"], ["reservation", "booking", "booked"]),
  rule("name_question", ["BROWS-DOWN", "YOUR", "NAME", "WHAT"], ["your name", "name please", "what is your name"]),
  rule("id_please", ["FS:ID", "SHOW", "PLEASE"], ["id", "passport", "identification", "license"]),
  rule("nights_question", ["BROWS-DOWN", "NIGHT", "HOW-MANY"], ["how many nights", "number of nights", "staying.*nights"]),
  rule("wifi_password", ["FS:WIFI", "PRIVATE", "WORD", "YOUR", "KEY", "CARD"], ["wi.?fi", "internet", "password"]),
  rule("send_towels", ["TOWEL", "ME", "SEND", "YOUR", "ROOM"], ["towel", "towels", "send"]),
  rule("room_number", ["YOUR", "ROOM"], ["room number", "your room", "room is", "in room", "room \\d+"]),
  rule("key_card", ["YOUR", "KEY", "CARD", "HERE"], ["key.?card", "room key", "your key"]),
  rule("elevator_left", ["ELEVATOR", "THERE", "LEFT"], ["elevator", "lift", "left"]),
  rule("breakfast_time", ["BREAKFAST", "TIME"], ["breakfast"]),
  rule("late_checkout", ["LATE", "LEAVE", "FINE"], ["late checkout", "late check out", "late"]),
  rule("checkout_time", ["LEAVE", "TIME"], ["checkout", "check out"]),
  rule("parking_downstairs", ["PARKING", "DOWN"], ["parking", "garage"]),
  rule("restaurant_hours", ["RESTAURANT", "OPEN"], ["restaurant", "dining"]),
  rule("call_taxi", ["TAXI", "ME", "CALL"], ["taxi", "cab", "uber", "car"]),
  rule("wait_please", ["WAIT", "PLEASE"], ["wait", "one moment", "hold on"]),
  rule("repeat_please", ["BROWS-UP", "SORRY", "AGAIN", "PLEASE"], ["repeat", "again", "say that again", "sorry"]),
  rule("anything_else", ["BROWS-UP", "OTHER", "QUESTION"], ["anything else", "other question"]),
  rule("enjoy_stay", ["ENJOY", "YOUR", "STAY"], ["enjoy", "good night", "have a nice"]),
];

export type Classification = {
  intentId: StaffIntentId;
  confidence: number;
  gloss: string[];
};

export function mapStaffTextToIntent(text: string, known?: Set<string>): Classification {
  const normalized = normalize(text);
  if (!normalized) return unknown(text, known);

  let best: Classification | null = null;
  for (const intent of STAFF_INTENTS) {
    const hits = intent.patterns.filter((pattern) => pattern.test(normalized)).length;
    if (!hits || !closeTo(intent.id, normalized)) continue;

    const confidence = Math.min(0.95, 0.62 + hits * 0.13);
    const gloss = applySlots(intent.id, intent.gloss, normalized);
    if (!best || confidence > best.confidence) {
      best = { intentId: intent.id, confidence, gloss };
    }
  }

  return best ?? unknown(text, known);
}

export function mapStaffTextToGloss(text: string, known?: Set<string>): { gloss: string[]; matches: Classification[] } {
  const parts = text
    .split(/[.;!?]|\bthen\b|\band then\b/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const matches = (parts.length ? parts : [text]).flatMap((part) => splitOnCommas(part, known));
  const gloss = matches.flatMap((match) => match.gloss);
  return { gloss, matches };
}

// Whisper often writes "Welcome, do you have a reservation?" for two sentences. A comma starts a
// new intent only when the piece after it is an intent of its own and a different one; otherwise
// it stays with the piece before ("Late checkout is fine, until 1 PM", "One moment, please",
// "Sorry, can you repeat?").
function splitOnCommas(sentence: string, known?: Set<string>): Classification[] {
  const pieces = sentence.split(",").map((piece) => piece.trim()).filter(Boolean);
  const groups: string[] = [];
  for (const piece of pieces) {
    const last = groups[groups.length - 1];
    if (last === undefined) {
      groups.push(piece);
      continue;
    }
    const before = mapStaffTextToIntent(last, known).intentId;
    const after = mapStaffTextToIntent(piece, known).intentId;
    if (after !== "unknown" && after !== before) groups.push(piece);
    else groups[groups.length - 1] = `${last}, ${piece}`;
  }
  return (groups.length ? groups : [sentence]).map((group) => mapStaffTextToIntent(group, known));
}

// Words with no sign of their own in a short ASL gloss.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "am", "be", "was", "to", "of", "on", "in", "at", "for", "and",
  "it", "its", "s", "re", "ll", "d", "m", "pm", "will", "can", "do", "does", "would", "could", "this", "that",
]);

// Multi-word expressions with a sign of their own, joined before the sentence is split into words.
const PHRASES: [RegExp, string][] = [
  [/\bthank you\b/g, "thank-you"],
  [/\bhow many\b/g, "how-many"],
  [/\bcheck ?out\b/g, "leave"],
  [/\bwi[- ]?fi\b/g, "wifi"],
];

// Words whose sign has another name in our vocabulary (docs/vocabulary.md), or is a fixed spelling.
const SYNONYMS: Record<string, string[]> = {
  i: ["ME"], // the pronoun: "I" is the letter sign
  hi: ["HELLO"],
  thanks: ["THANK-YOU"],
  wifi: ["FS:WIFI"],
  password: ["PRIVATE", "WORD"],
  id: ["FS:ID"],
  passport: ["FS:ID"],
  lift: ["ELEVATOR"],
  ok: ["FINE"],
  okay: ["FINE"],
};

/** A sign of our vocabulary for this word: as is, by synonym, or the singular of a plural ("towels"). */
function signFor(word: string, known: Set<string>): string[] | null {
  if (SYNONYMS[word]) return SYNONYMS[word];
  for (const candidate of [word, word.replace(/ies$/, "y"), word.replace(/e?s$/, "")]) {
    const upper = candidate.toUpperCase();
    if (candidate && known.has(upper) && !/^[A-Z]$/.test(upper)) return [upper];
  }
  return null;
}

/** Gloss for a sentence that matches no intent: known signs (with synonyms, phrases and plurals), numbers as
 *  number signs, other words fingerspelled. `known` = keys of signs/index.json. */
export function fallbackGlossFromText(text: string, known: Set<string> = new Set()): string[] {
  const joined = PHRASES.reduce((t, [pattern, joinedWord]) => t.replace(pattern, joinedWord), normalize(text));
  return joined
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .flatMap((word) => {
      if (/^\d+$/.test(word)) return numberTokens(word);
      const sign = signFor(word, known);
      if (sign) return sign;
      if (/^[a-z]+$/.test(word)) return [`FS:${word.toUpperCase()}`];
      return [];
    });
}

/** Number signs: 0 to 11 are single signs (signs/alphabet), bigger numbers are signed digit by digit. */
export function numberTokens(n: string): string[] {
  const value = Number(n);
  return Number.isInteger(value) && value >= 0 && value <= 11 ? [String(value)] : n.split("");
}

// The receptionist sentence of docs/vocabulary.md section 1 behind each intent. A keyword alone is not enough:
// "How many towels do you need?" is not "I'll send towels to your room." (closeTo).
const EXAMPLES: Record<Exclude<StaffIntentId, "unknown">, string> = {
  welcome: "Welcome! Hello, good morning, good evening.",
  reservation_question: "Do you have a reservation? A booking? Booked?",
  name_question: "What's your name, please?",
  id_please: "Can I see your ID, passport, identification or license, please?",
  nights_question: "How many nights are you staying?",
  room_number: "You're in room 412. Your room number is 412.",
  key_card: "Here is your key card, your room key.",
  elevator_left: "The elevator, the lift, is on your left.",
  breakfast_time: "Breakfast is from 7 to 10.",
  wifi_password: "The Wi-Fi internet password is on your key card.",
  checkout_time: "Checkout is at 11.",
  late_checkout: "Late checkout is fine, until 1 PM.",
  send_towels: "I'll send towels to your room.",
  parking_downstairs: "Parking, the garage, is downstairs.",
  restaurant_hours: "The restaurant, dining, is open until 10 PM.",
  call_taxi: "I'll call a taxi, a cab, an Uber, a car for you.",
  wait_please: "One moment, please. Wait, hold on.",
  repeat_please: "Sorry, can you repeat that again? Say that again.",
  anything_else: "Anything else? Any other question? Is there anything else I can help you with?",
  enjoy_stay: "Enjoy your stay! Good night, have a nice day.",
};

const contentWords = (text: string) =>
  normalize(text)
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    .map((w) => w.replace(/(?<=..)e?s$/, "")); // plurals: towels -> towel

const EXAMPLE_WORDS = Object.fromEntries(
  Object.entries(EXAMPLES).map(([id, sentence]) => [id, new Set(contentWords(sentence))]),
) as Record<Exclude<StaffIntentId, "unknown">, Set<string>>;

/** True when at least a third of the sentence's content words belong to the intent's example sentence. */
function closeTo(id: Exclude<StaffIntentId, "unknown">, normalized: string): boolean {
  const words = contentWords(normalized).map((w) => w.replace(/^keycard$/, "card"));
  if (words.length === 0) return true;
  const covered = words.filter((w) => EXAMPLE_WORDS[id].has(w)).length;
  return covered * 3 >= words.length;
}

function rule(id: Exclude<StaffIntentId, "unknown">, gloss: string[], words: string[]): IntentRule {
  return {
    id,
    gloss,
    patterns: words.map((word) => new RegExp(`\\b${word.replace(/\s+/g, "\\s+")}\\b`, "i")),
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9:\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function unknown(text: string, known?: Set<string>): Classification {
  return { intentId: "unknown", confidence: 0, gloss: fallbackGlossFromText(text, known) };
}

// Slots follow docs/vocabulary.md: "YOUR ROOM 4 1 2", "BREAKFAST TIME 7 UNTIL 10", "LEAVE TIME 11",
// "LATE LEAVE FINE UNTIL 1", "RESTAURANT OPEN UNTIL 10 NIGHT". Room numbers are signed digit by digit.
function applySlots(id: StaffIntentId, baseGloss: string[], text: string): string[] {
  const gloss = [...baseGloss];
  const times = extractTimes(text);

  if (id === "room_number") {
    const room = text.match(/\b(?:room\s*)?(\d{2,4})\b/)?.[1];
    if (room) gloss.push(...room.split(""));
  }

  if (id === "breakfast_time" && times.length) {
    gloss.push(...numberTokens(times[0]));
    if (times[1]) gloss.push("UNTIL", ...numberTokens(times[1]));
  }

  if (id === "checkout_time" && times.length) gloss.push(...numberTokens(times[0]));

  if (id === "late_checkout" && times.length) gloss.push("UNTIL", ...numberTokens(times[0]));

  if (id === "restaurant_hours" && times.length) {
    gloss.push("UNTIL", ...numberTokens(times[0]));
    if (/\bpm\b|\bnight\b|\bevening\b/.test(text)) gloss.push("NIGHT");
  }

  return gloss;
}

function extractTimes(text: string): string[] {
  const numeric = [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/g)]
    .map((match) => match[1])
    .slice(0, 2);
  if (numeric.length) return numeric;

  const words: Record<string, string> = {
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
  };
  return Object.entries(words)
    .filter(([word]) => new RegExp(`\\b${word}\\b`).test(text))
    .map(([, value]) => value)
    .slice(0, 2);
}

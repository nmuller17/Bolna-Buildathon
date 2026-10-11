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
  rule("key_card", ["YOUR", "KEY", "CARD", "HERE"], ["key card", "room key", "your key"]),
  rule("elevator_left", ["ELEVATOR", "THERE", "LEFT"], ["elevator", "lift", "left"]),
  rule("breakfast_time", ["BREAKFAST", "TIME"], ["breakfast"]),
  rule("late_checkout", ["LATE", "LEAVE", "FINE"], ["late checkout", "late check out", "late"]),
  rule("checkout_time", ["LEAVE", "TIME"], ["checkout", "check out"]),
  rule("parking_downstairs", ["PARKING", "DOWN"], ["parking", "garage"]),
  rule("restaurant_hours", ["RESTAURANT", "OPEN"], ["restaurant", "dining"]),
  rule("call_taxi", ["TAXI", "ME", "CALL"], ["taxi", "cab", "uber", "car"]),
  rule("wait_please", ["WAIT", "PLEASE"], ["wait", "one moment", "hold on"]),
  rule("repeat_please", ["BROWS-UP", "SORRY", "AGAIN", "PLEASE"], ["repeat", "again", "say that again", "sorry"]),
  rule("anything_else", ["BROWS-UP", "OTHER", "QUESTION"], ["anything else", "other question", "help you"]),
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
    if (!hits) continue;

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

  const matches = (parts.length ? parts : [text]).map((part) => mapStaffTextToIntent(part, known));
  const gloss = matches.flatMap((match) => match.gloss);
  return { gloss, matches };
}

// Words with no sign of their own in a short ASL gloss.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "am", "be", "was", "to", "of", "on", "in", "at", "for", "and",
  "it", "its", "s", "re", "ll", "d", "m", "pm", "will", "can", "do", "does", "would", "could", "this", "that",
]);

/** Gloss for a sentence that matches no intent: known signs as is, numbers as number signs,
 *  other words fingerspelled. `known` = keys of signs/index.json. */
export function fallbackGlossFromText(text: string, known: Set<string> = new Set()): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .flatMap((word) => {
      if (/^\d+$/.test(word)) return numberTokens(word);
      const upper = word.toUpperCase();
      if (known.has(upper) && !/^[A-Z]$/.test(upper)) return [upper];
      if (/^[a-z]+$/.test(word)) return [`FS:${upper}`];
      return [];
    });
}

/** Number signs: 0 to 11 are single signs (signs/alphabet), bigger numbers are signed digit by digit. */
export function numberTokens(n: string): string[] {
  const value = Number(n);
  return Number.isInteger(value) && value >= 0 && value <= 11 ? [String(value)] : n.split("");
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

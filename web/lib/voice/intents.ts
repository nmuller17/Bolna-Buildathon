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

export const STAFF_INTENTS: IntentRule[] = [
  rule("welcome", ["HELLO", "WELCOME"], ["welcome", "hello", "good evening", "good morning"]),
  rule("reservation_question", ["YOU", "HAVE", "RESERVATION"], ["reservation", "booking", "booked"]),
  rule("name_question", ["YOUR", "NAME", "WHAT"], ["your name", "name please", "what is your name"]),
  rule("id_please", ["ID", "SHOW", "PLEASE"], ["id", "passport", "identification", "license"]),
  rule("nights_question", ["NIGHT", "HOW-MANY"], ["how many nights", "number of nights", "staying.*nights"]),
  rule("room_number", ["YOUR", "ROOM"], ["room number", "your room", "room is"]),
  rule("key_card", ["YOUR", "KEY", "CARD", "HERE"], ["key card", "room key", "your key"]),
  rule("elevator_left", ["ELEVATOR", "THERE", "LEFT"], ["elevator", "lift", "left"]),
  rule("breakfast_time", ["BREAKFAST", "TIME"], ["breakfast"]),
  rule("wifi_password", ["WIFI", "PASSWORD", "ON", "KEY", "CARD"], ["wifi", "wi-fi", "internet", "password"]),
  rule("checkout_time", ["CHECKOUT", "TIME"], ["checkout", "check out"]),
  rule("late_checkout", ["LATE", "CHECKOUT", "FINE"], ["late checkout", "late check out"]),
  rule("send_towels", ["TOWEL", "I", "SEND", "YOUR", "ROOM"], ["towel", "towels"]),
  rule("parking_downstairs", ["PARKING", "DOWN"], ["parking", "garage"]),
  rule("restaurant_hours", ["RESTAURANT", "OPEN"], ["restaurant", "dining"]),
  rule("call_taxi", ["TAXI", "I", "CALL"], ["taxi", "cab", "uber", "car"]),
  rule("wait_please", ["WAIT", "PLEASE"], ["wait", "one moment", "hold on"]),
  rule("repeat_please", ["SORRY", "AGAIN", "PLEASE"], ["repeat", "again", "say that again", "sorry"]),
  rule("anything_else", ["OTHER", "QUESTION"], ["anything else", "other question", "help you"]),
  rule("enjoy_stay", ["ENJOY", "STAY"], ["enjoy", "good night", "have a nice"]),
];

export type Classification = {
  intentId: StaffIntentId;
  confidence: number;
  gloss: string[];
};

export function mapStaffTextToIntent(text: string): Classification {
  const normalized = normalize(text);
  if (!normalized) return unknown(text);

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

  return best ?? unknown(text);
}

export function mapStaffTextToGloss(text: string): { gloss: string[]; matches: Classification[] } {
  const parts = text
    .split(/[.;!?]|\bthen\b|\band then\b/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const matches = (parts.length ? parts : [text]).map(mapStaffTextToIntent);
  const gloss = matches.flatMap((match) => match.gloss);
  return { gloss, matches };
}

export function fallbackGlossFromText(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (/^\d+$/.test(word)) return word.split("");
      if (/^[a-z]+$/.test(word)) return [`FS:${word.toUpperCase()}`];
      return [];
    });
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

function unknown(text: string): Classification {
  return { intentId: "unknown", confidence: 0, gloss: fallbackGlossFromText(text) };
}

function applySlots(id: StaffIntentId, baseGloss: string[], text: string): string[] {
  const gloss = [...baseGloss];
  if (id === "room_number") {
    const room = text.match(/\b(?:room\s*)?(\d{2,4})\b/)?.[1];
    if (room) gloss.push(...room.split(""));
  }

  if (id === "breakfast_time") {
    const times = extractTimes(text);
    if (times.length) gloss.push(...times.flatMap((time) => ["TIME", ...time.split("")]));
  }

  if (id === "checkout_time" || id === "late_checkout" || id === "restaurant_hours") {
    const [time] = extractTimes(text);
    if (time) gloss.push(...time.split(""));
  }

  return gloss;
}

function extractTimes(text: string): string[] {
  const numeric = [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/g)]
    .map((match) => match[2] ? `${match[1]}:${match[2]}` : match[1])
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

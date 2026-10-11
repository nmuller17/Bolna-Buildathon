// Call-share view (P4): the 20 staff intents (docs/vocabulary.md section 1) and a deterministic
// typed-English -> intent matcher. No model, no network: plain keyword scores, so the same text always
// gives the same result and nothing leaves the laptop.

export type Intent = {
  id: number;
  text: string;
  gloss: string;
  /** Short label for the one-tap button. */
  short: string;
  /** Lower-case keywords or phrases, with a weight. The intent with the highest total wins. */
  keys: [string, number][];
};

export const INTENTS: Intent[] = [
  { id: 1, text: "Welcome!", gloss: "HELLO WELCOME", short: "Welcome",
    keys: [["welcome", 3], ["hello", 3], ["hi", 2], ["hey", 2], ["good morning", 3], ["good evening", 3], ["good afternoon", 3]] },
  { id: 2, text: "Do you have a reservation?", gloss: "BROWS-UP YOU HAVE RESERVATION", short: "Reservation?",
    keys: [["reservation", 3], ["booking", 3], ["booked", 3], ["reserved", 3], ["book", 1]] },
  { id: 3, text: "What's your name?", gloss: "BROWS-DOWN YOUR NAME WHAT", short: "Your name?",
    keys: [["name", 3], ["who", 1], ["surname", 3]] },
  { id: 4, text: "Can I see your ID?", gloss: "FS:ID SHOW PLEASE", short: "See your ID",
    keys: [["id", 3], ["identification", 3], ["passport", 3], ["license", 3], ["licence", 3], ["identity", 3]] },
  { id: 5, text: "How many nights?", gloss: "BROWS-DOWN NIGHT HOW-MANY", short: "How many nights?",
    keys: [["nights", 3], ["how many", 2], ["how long", 3], ["night", 1]] },
  { id: 6, text: "You're in room 412.", gloss: "YOUR ROOM 4 1 2", short: "Room 412",
    keys: [["room", 2], ["room number", 2]] },
  { id: 7, text: "Here is your key card.", gloss: "YOUR KEY CARD HERE", short: "Key card",
    keys: [["key", 2], ["card", 2], ["here", 1]] },
  { id: 8, text: "The elevator is on your left.", gloss: "ELEVATOR THERE LEFT", short: "Elevator left",
    keys: [["elevator", 3], ["lift", 3], ["elevators", 3], ["left", 1]] },
  { id: 9, text: "Breakfast is from 7 to 10.", gloss: "BREAKFAST TIME 7 UNTIL 10", short: "Breakfast 7-10",
    keys: [["breakfast", 4], ["morning meal", 3]] },
  { id: 10, text: "The Wi-Fi password is on your key card.", gloss: "FS:WIFI PRIVATE WORD YOUR KEY CARD", short: "Wi-Fi password",
    keys: [["wifi", 4], ["wi fi", 4], ["password", 4], ["internet", 3]] },
  { id: 11, text: "Checkout is at 11.", gloss: "LEAVE TIME 11", short: "Checkout 11",
    keys: [["checkout", 3], ["check out", 3]] },
  { id: 12, text: "Late checkout is fine, until 1 PM.", gloss: "LATE LEAVE FINE UNTIL 1", short: "Late checkout 1 PM",
    keys: [["late", 2], ["checkout", 2], ["check out", 2]] },
  { id: 13, text: "I'll send towels to your room.", gloss: "TOWEL ME SEND YOUR ROOM", short: "Send towels",
    keys: [["towel", 4], ["towels", 4]] },
  { id: 14, text: "Parking is downstairs.", gloss: "PARKING DOWN", short: "Parking",
    keys: [["parking", 4], ["park", 3], ["car", 2], ["garage", 3], ["downstairs", 1]] },
  { id: 15, text: "The restaurant is open until 10 PM.", gloss: "RESTAURANT OPEN UNTIL 10 NIGHT", short: "Restaurant 10 PM",
    keys: [["restaurant", 4], ["dinner", 3], ["eat", 2], ["food", 2]] },
  { id: 16, text: "I'll call a taxi for you.", gloss: "TAXI ME CALL", short: "Call a taxi",
    keys: [["taxi", 4], ["cab", 4], ["uber", 3], ["lyft", 3]] },
  { id: 17, text: "One moment, please.", gloss: "WAIT PLEASE", short: "One moment",
    keys: [["moment", 3], ["wait", 3], ["one second", 3], ["one minute", 3], ["hold on", 3]] },
  { id: 18, text: "Sorry, can you repeat?", gloss: "BROWS-UP SORRY AGAIN PLEASE", short: "Repeat?",
    keys: [["repeat", 4], ["again", 3], ["pardon", 3], ["sorry", 2], ["didn't understand", 3], ["did not understand", 3]] },
  { id: 19, text: "Anything else?", gloss: "BROWS-UP OTHER QUESTION", short: "Anything else?",
    keys: [["anything else", 4], ["else", 3], ["other question", 3], ["questions", 2], ["question", 2]] },
  { id: 20, text: "Enjoy your stay!", gloss: "ENJOY YOUR STAY", short: "Enjoy your stay",
    keys: [["enjoy", 4], ["have a nice", 2], ["have a good", 2], ["stay", 1]] },
];

export type Utterance = {
  /** English shown to the guest. */
  text: string;
  /** Gloss the avatar signs. Empty: captions only. */
  gloss: string[];
  /** Intent id, or null when nothing matched. */
  intent: number | null;
  /** One line for the receptionist describing what will happen. */
  note: string;
};

export const splitGloss = (gloss: string) => gloss.trim().toUpperCase().split(/\s+/).filter(Boolean);

/** Lower case, keep letters, digits and apostrophes, collapse spaces ("Wi-Fi" -> "wi fi", "check-out" -> "check out"). */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, " ").replace(/\s+/g, " ").trim()} `;
}

function score(norm: string, intent: Intent): number {
  let total = 0;
  for (const [key, weight] of intent.keys) if (norm.includes(` ${key} `)) total += weight;
  return total;
}

/** A plain number the avatar can sign digit by digit (digits 0-9 are in signs/index.json). */
const roomNumber = (norm: string) => norm.match(/ (\d{1,4}) /)?.[1] ?? null;

export function fromIntent(intent: Intent): Utterance {
  return { text: intent.text, gloss: splitGloss(intent.gloss), intent: intent.id, note: `#${intent.id} ${intent.text}` };
}

/**
 * Maps typed English to the closest fixed intent. Rules, in order:
 * 1. Highest keyword score wins (ties go to the lower intent number). A score below 2 is no match.
 * 2. Room intent with a number in the text signs that number ("room 518" -> YOUR ROOM 5 1 8).
 * 3. No match: captions only. With `fingerspell` on, one or two short words (a name, a code) are spelled with FS: tokens.
 */
export function matchTyped(typed: string, fingerspell: boolean): Utterance | null {
  const raw = typed.trim();
  if (!raw) return null;
  const norm = normalize(raw);

  let best: Intent | null = null;
  let bestScore = 0;
  for (const intent of INTENTS) {
    const s = score(norm, intent);
    if (s > bestScore) {
      best = intent;
      bestScore = s;
    }
  }

  if (best && bestScore >= 2) {
    if (best.id === 6) {
      const n = roomNumber(norm);
      if (n) {
        return {
          text: `You're in room ${n}.`,
          gloss: ["YOUR", "ROOM", ...n.split("")],
          intent: 6,
          note: `#6 You're in room ${n}.`,
        };
      }
    }
    return fromIntent(best);
  }

  const words = norm.trim().split(" ").filter(Boolean);
  const spellable = words.length <= 2 && words.every((w) => /^[a-z0-9]{1,12}$/.test(w));
  if (fingerspell && spellable) {
    const gloss = words.map((w) => `FS:${w.toUpperCase()}`);
    return { text: raw, gloss, intent: null, note: `No phrase matched: fingerspelling ${words.join(" ").toUpperCase()}` };
  }
  return { text: raw, gloss: [], intent: null, note: "No phrase matched: captions only (no signing)" };
}

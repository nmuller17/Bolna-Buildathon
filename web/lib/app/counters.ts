// SignBridge app (P4, builder S): anonymous equal-access counters and the guest privacy receipt
// (docs/features-plan.md F16 and F17).
//
// F16: counts only, since the server started, in memory only (the store holds one object; a restart
// resets it). No timestamps, no per-session rows, no device or guest details. Any count below
// FEATURE_LIMITS.equalAccessMinShown is shown as "fewer than 5", so a single guest's choices cannot
// be read off the panel.
// F17: the receipt the guest sees on the end screen, built from what this conversation really used.
// Pure functions, erasable TypeScript.
import {
  CAPTION_BACKEND_IS_CLOUD,
  FEATURE_LIMITS,
  type CaptionBackend,
  type EqualAccessCounters,
  type GuestMode,
  type GuestPrivacyReceipt,
  type PrivacyCounters,
} from "./types.ts";

export function emptyEqualAccess(): EqualAccessCounters {
  return {
    sessions: 0,
    modeChosen: { sign: 0, type: 0, tap: 0, interpreter: 0, text_only: 0 },
    sentBy: { signs: 0, board: 0, phraseList: 0, typed: 0, typedMatch: 0 },
    repairReplies: 0,
    interpreterRequests: 0,
    factsShown: 0,
    cardsShown: 0,
    alertsSent: 0,
    captionUtterances: { local: 0, cloud_openai: 0, browser_google: 0, browser_apple: 0, browser_other: 0, typed: 0 },
  };
}

export const FEWER_THAN = `fewer than ${FEATURE_LIMITS.equalAccessMinShown}`;

/** A count as shown on the staff panel: small counts (including zero) are never shown exactly. */
export function shownCount(n: number): string {
  return n < FEATURE_LIMITS.equalAccessMinShown ? FEWER_THAN : String(n);
}

const MODE_WORDS: Readonly<Record<Exclude<GuestMode, "choosing">, string>> = {
  sign: "Chose to sign",
  type: "Chose to read and type",
  tap: "Chose to tap pictures",
  interpreter: "Chose a human interpreter",
  text_only: "Chose read only",
};

/** The panel rows, every value through shownCount. */
export function equalAccessRows(c: EqualAccessCounters): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [{ label: "Conversations", value: shownCount(c.sessions) }];
  for (const [k, label] of Object.entries(MODE_WORDS) as [Exclude<GuestMode, "choosing">, string][]) rows.push({ label, value: shownCount(c.modeChosen[k]) });
  rows.push(
    { label: "Sentences sent by signing", value: shownCount(c.sentBy.signs) },
    { label: "Sentences tapped on the picture board", value: shownCount(c.sentBy.board) },
    { label: "Sentences picked from the list", value: shownCount(c.sentBy.phraseList) },
    { label: "Messages typed by guests", value: shownCount(c.sentBy.typed) },
    { label: "Typed messages matched to a request", value: shownCount(c.sentBy.typedMatch) },
    { label: "Repair requests (repeat, slower, type it)", value: shownCount(c.repairReplies) },
    { label: "Interpreter requests", value: shownCount(c.interpreterRequests) },
    { label: "Fact tiles shown", value: shownCount(c.factsShown) },
    { label: "Take-home cards shown", value: shownCount(c.cardsShown) },
    { label: "Desk alerts sent", value: shownCount(c.alertsSent) },
  );
  for (const [k, n] of Object.entries(c.captionUtterances) as [CaptionBackend, number][]) {
    if (k === "typed") continue;
    rows.push({ label: `Live caption lines (${k === "local" ? "on this laptop" : k.replace("_", " ")})`, value: shownCount(n) });
  }
  return rows;
}

/* ---------------- F17: the receipt ---------------- */

/** What one conversation used, collected by the store while it runs (wiped with the session). */
export type SessionUse = {
  /** Ways the guest used, in the order first used. */
  used: string[];
  captionBackends: CaptionBackend[];
  /** A guest sentence was voiced at the desk (fixed sentence through /api/tts, or the on-device voice). */
  voiced: boolean;
};

export const USED_WORDS = {
  signs: "Signs",
  board: "Pictures",
  phrase_list: "The phrase list",
  typed: "Typing",
  typed_match: "Typing",
  number: "The number pad",
  replies: "Repair buttons",
  interpreter: "Interpreter request",
  card: "Take-home card",
} as const;

export function emptyUse(): SessionUse {
  return { used: [], captionBackends: [], voiced: false };
}

export function noteUse(u: SessionUse, way: keyof typeof USED_WORDS): void {
  const w = USED_WORDS[way];
  if (!u.used.includes(w)) u.used.push(w);
}

export function noteCaptionBackend(u: SessionUse, b: CaptionBackend): void {
  if (!u.captionBackends.includes(b)) u.captionBackends.push(b);
}

/** Plain words for a vendor destination on the guest's receipt. */
const VENDOR_WORDS: Readonly<Record<string, string>> = {
  "api.openai.com": "OpenAI (speech-to-text of the desk's voice)",
  "api.elevenlabs.io": "ElevenLabs (voice for your fixed sentences)",
  "Google (Chrome speech recognition)": "Google (speech recognition of the desk's voice)",
  "Apple (Safari speech recognition)": "Apple (speech recognition of the desk's voice)",
  "browser speech service": "The browser maker (speech recognition of the desk's voice)",
};

/**
 * The receipt, from real data only: the ways used, the caption backends that produced a line, the
 * voice (cloud only when a vendor voice call was really counted), and every vendor destination with
 * at least one counted call in this conversation's privacy counters.
 */
export function buildReceipt(u: SessionUse, privacy: PrivacyCounters, erasedAt: number, itemsErased: number): GuestPrivacyReceipt {
  const calls = privacy.vendorCalls.filter((c) => c.count > 0);
  const cloudVoice = calls.some((c) => c.route === "/api/tts");
  const vendors: string[] = [];
  for (const c of calls) {
    const w = VENDOR_WORDS[c.destination] ?? c.destination;
    if (!vendors.includes(w)) vendors.push(w);
  }
  // A cloud caption backend that produced a line is a vendor even if no byte count was observed.
  for (const b of u.captionBackends) {
    if (!CAPTION_BACKEND_IS_CLOUD[b]) continue;
    const w = b === "cloud_openai" ? VENDOR_WORDS["api.openai.com"] : b === "browser_google" ? VENDOR_WORDS["Google (Chrome speech recognition)"] : b === "browser_apple" ? VENDOR_WORDS["Apple (Safari speech recognition)"] : VENDOR_WORDS["browser speech service"];
    if (!vendors.includes(w)) vendors.push(w);
  }
  return {
    used: [...u.used],
    captionBackends: [...u.captionBackends],
    voice: cloudVoice ? "cloud" : u.voiced ? "on_device" : "none",
    vendors,
    erasedAt,
    itemsErased,
  };
}

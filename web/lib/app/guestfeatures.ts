// Guest-side feature logic (docs/features-plan.md F1, F3, F4, F6, F7, F9, F11, F17), as pure functions
// so they can be unit-tested without a browser. The guest page keeps every result in React state
// only (AS-3): nothing here touches storage, the network or a log.
//
// Erasable TypeScript, imports with ".ts" so `node --test` can load it.
import {
  CAPTION_BACKEND_LABEL,
  FACT_KEYS,
  FACT_LABEL,
  FEATURE_LIMITS,
  NUMBER_ABOUT_LABEL,
  SIGN_LANGUAGES,
  TAKE_HOME_TITLE,
  type CaptionSource,
  type Fact,
  type FactKey,
  type GuestDeskAlert,
  type GuestIntentId,
  type GuestLiveCaption,
  type GuestPrivacyReceipt,
  type InterpreterContextCard,
  type LineSourceLabel,
  type NumberAbout,
  type SignLanguage,
} from "./types.ts";

/* ---------------- F6: one label per line ---------------- */

/** How a desk line reached the guest: the existing caption sources, plus machine live captions (F3). */
export type DeskLineSource = CaptionSource | "live_caption";

/** How the guest sent a line. "signs" = recognised and confirmed on the BN-1 card. */
export type GuestSendVia = "signs" | "typed" | "board" | "phrase_list" | "typed_match" | "number";

export const DESK_LINE_LABEL: Readonly<Record<DeskLineSource, LineSourceLabel>> = {
  quick_reply: "Staff quick reply",
  typed: "Typed by staff",
  // A voice caption reaches the guest only after staff pressed Send on it (C2-13): reviewed by staff.
  voice: "Staff speech, reviewed by staff",
  live_caption: "Staff speech, machine captions",
};

export const GUEST_LINE_LABEL: Readonly<Record<GuestSendVia, LineSourceLabel>> = {
  signs: "Signs recognised, confirmed by guest",
  typed: "Typed by guest",
  board: "Tapped on board",
  phrase_list: "Picked from the list",
  typed_match: "Typed, matched to a request",
  number: "Typed by guest",
};

/* ---------------- F3: live captions ---------------- */

/**
 * Applies one live_caption event to the list kept in page memory (oldest first). A revision replaces
 * the earlier one in place (same utteranceId, higher rev); an older or equal rev is ignored unless it
 * retracts the line. At most FEATURE_LIMITS.guestLiveCaptionsKept lines are kept.
 */
export function applyLiveCaption(list: readonly GuestLiveCaption[], msg: GuestLiveCaption): GuestLiveCaption[] {
  const i = list.findIndex((c) => c.utteranceId === msg.utteranceId);
  if (i >= 0) {
    const cur = list[i];
    if (msg.retracted) {
      const next = list.slice();
      next[i] = { ...cur, retracted: true };
      return next;
    }
    if (cur.retracted || msg.rev <= cur.rev) return list as GuestLiveCaption[];
    const next = list.slice();
    next[i] = msg;
    return next;
  }
  if (msg.retracted) return list as GuestLiveCaption[];
  return [...list, msg].slice(-FEATURE_LIMITS.guestLiveCaptionsKept);
}

/** The badge text for a backend; null = live captions are off. */
export const captionBadge = (b: keyof typeof CAPTION_BACKEND_LABEL | null): string | null => (b ? CAPTION_BACKEND_LABEL[b] : null);

/* ---------------- F1 / F4: facts and the take-home card ---------------- */

export type FactMap = Partial<Record<FactKey, Fact>>;

export function applyFact(facts: FactMap, fact: Fact): FactMap {
  if (!FACT_KEYS.includes(fact.key)) return facts;
  const value = String(fact.value).slice(0, FEATURE_LIMITS.factValueMax);
  return { ...facts, [fact.key]: { ...fact, value } };
}

export function clearFact(facts: FactMap, key: FactKey): FactMap {
  if (!(key in facts)) return facts;
  const next = { ...facts };
  delete next[key];
  return next;
}

/** Facts in the fixed tile order (FACT_KEYS), skipping empty values. */
export function orderedFacts(facts: FactMap): Fact[] {
  return FACT_KEYS.flatMap((k) => {
    const f = facts[k];
    return f && f.value.trim() ? [f] : [];
  });
}

/** The tile and card lines, "Label: value", in tile order. */
export function factLines(facts: FactMap): string[] {
  return orderedFacts(facts).map((f) => `${FACT_LABEL[f.key]}: ${f.value.trim()}`);
}

/**
 * The text the QR code holds: the card title, then exactly the tile lines. Plain text, not a link,
 * so a phone camera shows it without opening anything (F4). Null when there is nothing to keep.
 */
export function takeHomeText(facts: FactMap): string | null {
  const lines = factLines(facts);
  return lines.length ? [TAKE_HOME_TITLE, ...lines].join("\n") : null;
}

/* ---------------- F7: typed numbers ---------------- */

/** Mirrors the server check (digits only, 1 to 6): a reason to show next to the field, or null. */
export function numberProblem(value: string): string | null {
  if (value.length === 0) return "Type a number first.";
  if (!/^\d+$/.test(value)) return "Use digits only.";
  if (value.length > FEATURE_LIMITS.guestNumberMaxDigits) return `Numbers can be up to ${FEATURE_LIMITS.guestNumberMaxDigits} digits.`;
  return null;
}

/** The guest's own record line for a number they sent: "3 (nights)". */
export const numberLine = (about: NumberAbout, value: string): string => `${value} (${NUMBER_ABOUT_LABEL[about]})`;

/* ---------------- F9: desk alerts ---------------- */

export function addAlert(list: readonly GuestDeskAlert[], a: GuestDeskAlert): GuestDeskAlert[] {
  if (list.some((x) => x.id === a.id)) return list as GuestDeskAlert[];
  return [...list, a].slice(-FEATURE_LIMITS.alertsOpenMax);
}

export const removeAlert = (list: readonly GuestDeskAlert[], id: string): GuestDeskAlert[] => list.filter((x) => x.id !== id);

/* ---------------- F11: interpreter context card ---------------- */

/** Topic words for the fixed requests. Requests that say nothing about the stay (yes, no, thanks, name) have none. */
const TOPIC_OF_INTENT: Readonly<Partial<Record<GuestIntentId, string>>> = {
  3: "check-in",
  6: "elevator",
  7: "Wi-Fi",
  8: "breakfast",
  9: "breakfast",
  10: "towels",
  11: "checkout",
  12: "checkout",
  13: "parking",
  14: "taxi",
  15: "help",
  16: "room",
  17: "room",
  18: "restaurant",
  19: "restaurant",
};

/** Topics in first-mentioned order, without repeats. Never a name, typed text or a number. */
export function topicsFromIntents(ids: readonly GuestIntentId[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const t = TOPIC_OF_INTENT[id];
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function signLanguageName(code: SignLanguage): string {
  return SIGN_LANGUAGES.find((l) => l.code === code)?.name ?? "Another sign language";
}

/**
 * The card exactly as the guest sees it before agreeing (F11). `language` and `topics` are filled
 * only when ticked; `openRequest` is the guest's last fixed request, if any (never typed text or a name).
 */
export function interpreterCard(opts: {
  shareLanguage: boolean;
  language: SignLanguage;
  shareTopics: boolean;
  intents: readonly GuestIntentId[];
  openRequest: string | null;
}): InterpreterContextCard {
  return {
    language: opts.shareLanguage ? signLanguageName(opts.language) : null,
    topics: opts.shareTopics ? topicsFromIntents(opts.intents) : [],
    openRequest: opts.shareTopics ? opts.openRequest : null,
  };
}

/** The card's lines; empty when nothing is shared (then no card is sent at all). */
export function interpreterCardLines(card: InterpreterContextCard): string[] {
  const lines: string[] = [];
  if (card.language) lines.push(`Sign language: ${card.language}`);
  if (card.topics.length) lines.push(`Topics so far: ${card.topics.join(", ")}`);
  if (card.openRequest) lines.push(`Last request: ${card.openRequest}`);
  return lines;
}

/* ---------------- F17: privacy receipt ---------------- */

const VOICE_WORDS: Readonly<Record<GuestPrivacyReceipt["voice"], string>> = {
  none: "No voice was used.",
  on_device: "Your sentences were read aloud by the desk laptop's own voice.",
  cloud: "Your fixed sentences were read aloud by an outside voice service.",
};

/** The receipt as plain sentences for the end screen. Times are formatted by the caller's clock. */
export function receiptLines(r: GuestPrivacyReceipt, hhmm: (ms: number) => string): string[] {
  const lines: string[] = [];
  lines.push(r.used.length ? `You used: ${r.used.join(", ")}.` : "You did not send anything.");
  const caps = r.captionBackends.filter((b) => b !== "typed").map((b) => CAPTION_BACKEND_LABEL[b]);
  lines.push(caps.length ? `Live captions: ${caps.join("; ")}.` : "No live captions of speech were used.");
  lines.push(VOICE_WORDS[r.voice]);
  lines.push(r.vendors.length ? `Outside services that received data: ${r.vendors.join(", ")}.` : "No outside service received anything from this conversation.");
  lines.push(`Erased at ${hhmm(r.erasedAt)}${r.itemsErased > 0 ? `: ${r.itemsErased} ${r.itemsErased === 1 ? "item" : "items"}` : ""}. The hotel keeps no copy.`);
  return lines;
}

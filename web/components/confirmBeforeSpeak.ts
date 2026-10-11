// Guest -> staff: confirm before speaking. Nothing the guest signed is said aloud until the guest taps "Say it".
//
// /guest shows the English sentence with the recognized signs (word + confidence) and three equal buttons:
// "Say it", "Text only", "Fix". The choice goes to /staff as a `guest_decision` on the BroadcastChannel, and /staff
// speaks (/api/tts) only through createSpeakGate below, only for "say", and only once per sentence.
// "Fix" offers typing or a pick among the three closest known sentences; it never asks the recognizer again.
//
// Plain TypeScript with type-only imports, so Node runs the unit tests on it directly (web/tests/).

/** One alternative of a recognized sign, as in the recognizer's `sign` events. */
export type Pick = { label: string; conf: number };
/** The part of a `sign` event used here. */
export type SignLike = { top: Pick[] };
/** The part of an `utterance` event used here (see GuestEvent in app/api/guest/bus.ts). */
export type UtteranceLike = { id: number; labels: string[]; raw: string[]; text: string; needsRepeat: boolean; mock: boolean };
/** A known guest sentence (INTENTS in app/api/english/intents.ts). */
export type IntentLike = { signs: string[]; text: string };

export type GuestAction = "say" | "text" | "cancel";
/** BroadcastChannel message from /guest to /staff: what the guest chose for sentence `id`. */
export type GuestDecision = { type: "guest_decision"; id: number; action: GuestAction; text: string };

/** Longest sentence the guest can type in "Fix". */
export const GUEST_TEXT_MAX = 280;
/** Offered by "Fix" > "None of these" > interpreter. Goes back to Say it / Text only like any other sentence. */
export const INTERPRETER_TEXT = "I would like a sign language interpreter, please.";

/** True when the sentence may be offered to the guest for confirmation (never a repeat request, a mock or an empty text). */
export function needsConfirm(u: UtteranceLike): boolean {
  return !u.needsRepeat && !u.mock && typeof u.text === "string" && u.text.trim() !== "";
}

/** Typed or picked text, cleaned: control characters removed, spaces collapsed, at most GUEST_TEXT_MAX. Null if empty or not text. */
export function cleanGuestText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || [...clean].length > GUEST_TEXT_MAX) return null;
  return clean;
}

export type Chip = { label: string; word: string; conf: number | null };

/**
 * The recognized signs shown next to the sentence: each label as an English word, with the confidence the
 * recognizer gave it in this sentence's `sign` events (null when no sign event carried that label, e.g. after a
 * sentence correction or an undo).
 */
export function signChips(labels: string[], signs: SignLike[], words: Record<string, string>): Chip[] {
  return labels.map((label, i) => {
    const at = signs[i]?.top.find((p) => p.label === label);
    const anywhere = signs.flatMap((s) => s.top.filter((p) => p.label === label)).sort((a, b) => b.conf - a.conf)[0];
    const conf = (at ?? anywhere)?.conf ?? null;
    return { label, word: words[label] ?? label.toLowerCase().replace(/-/g, " "), conf };
  });
}

/**
 * Up to `k` known sentences close to what was recognized, best first, for "Fix". Ranked only from what the recognizer
 * already sent (each sign's alternatives and the sentence's labels): no new recognition. The current sentence is left out.
 * A sign's weight is its best confidence among the alternatives (0.5 if it only appears in the labels). Signs shared by
 * many sentences (PLEASE) count less than rare ones (LATE), by idf = ln((N + 1) / sentences containing the sign).
 * Score = sum of weight x idf over the sentence's signs / sum of idf over the sentence's signs and the recognized labels
 * it lacks (a weighted Jaccard similarity, 0 to 1).
 */
export function topAlternatives(u: UtteranceLike, signs: SignLike[], intents: IntentLike[], k = 3): string[] {
  const weight = new Map<string, number>();
  const bump = (label: string, w: number) => weight.set(label, Math.max(weight.get(label) ?? 0, w));
  for (const s of signs) for (const p of s.top) if (p.label !== "NONE") bump(p.label, p.conf);
  for (const label of [...u.labels, ...u.raw]) if (label !== "NONE") bump(label, 0.5);
  const df = new Map<string, number>();
  for (const intent of intents) for (const label of new Set(intent.signs)) df.set(label, (df.get(label) ?? 0) + 1);
  const idf = (label: string) => Math.log((intents.length + 1) / Math.max(df.get(label) ?? 0, 1));
  const recognized = new Set(u.labels.filter((l) => l !== "NONE"));
  const current = u.text.trim().toLowerCase();
  return intents
    .map((intent, order) => {
      const own = new Set(intent.signs);
      let shared = 0;
      let total = 0;
      for (const label of own) {
        shared += (weight.get(label) ?? 0) * idf(label);
        total += idf(label);
      }
      for (const label of recognized) if (!own.has(label)) total += idf(label);
      return { text: intent.text, order, score: total > 0 ? shared / total : 0 };
    })
    .filter((c) => c.score > 0 && c.text.trim().toLowerCase() !== current)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, k)
    .map((c) => c.text);
}

export type GateOutcome = "spoken" | "text_only" | "cancelled" | "ignored";

/**
 * /staff side. `offer` registers a recognized sentence and never speaks. `decide` speaks only for the guest's "say",
 * only for the latest offered sentence, and only once. Older sentences are dropped when a new one is offered.
 */
export function createSpeakGate(speak: (text: string) => void) {
  let pending: number | null = null;
  return {
    offer(u: UtteranceLike): boolean {
      pending = needsConfirm(u) ? u.id : null;
      return pending !== null;
    },
    decide(d: { id: unknown; action: unknown; text: unknown }): { outcome: GateOutcome; text: string } {
      if (pending === null || d.id !== pending) return { outcome: "ignored", text: "" };
      if (d.action === "cancel") {
        pending = null;
        return { outcome: "cancelled", text: "" };
      }
      const text = cleanGuestText(d.text);
      if (!text || (d.action !== "say" && d.action !== "text")) return { outcome: "ignored", text: "" };
      pending = null; // one decision per sentence: a second "say" is ignored
      if (d.action === "text") return { outcome: "text_only", text };
      speak(text);
      return { outcome: "spoken", text };
    },
    /** Id of the sentence waiting for the guest, or null. */
    get pending() {
      return pending;
    },
  };
}

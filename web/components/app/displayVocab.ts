// P4 (builder B): display helpers over builder A's vocab.ts (the two tables of docs/vocabulary.md).
//
// The server is the authority: a quick reply sends only its intent key (`say_quick`) and a phrase
// sends only its intent id (`guest_phrase`); the server looks the sentence and gloss up itself.
import { GUEST_INTENTS, STAFF_INTENTS } from "@/lib/app/vocab";

/** Quick replies in vocabulary.md section 1 order; `short` is the button label. */
export const QUICK_REPLIES = STAFF_INTENTS;

/** Guest requests in vocabulary.md section 2 order, with the NAME template shown as "My name is ...". */
export const GUEST_PHRASES = GUEST_INTENTS.map((g) => ({ ...g, text: g.needsName ? "My name is ..." : g.text }));

/** Gloss token as shown on a key tag: FS:WIFI -> "fs WIFI"; facial markers get words (plan 4.5 key). */
export function tagText(token: string): string {
  if (token === "BROWS-UP") return "eyebrows up";
  if (token === "BROWS-DOWN") return "eyebrows down";
  if (token.startsWith("FS:")) return `fs ${token.slice(3)}`;
  return token;
}

/**
 * Name check mirrored from the server's sanitizer (plan SPK-6): NFC, letters, marks, spaces,
 * hyphens and apostrophes, 1 to 40 code points. The server checks again; this only shows the
 * reason early, next to the field.
 */
export function nameProblem(raw: string): string | null {
  const s = raw.normalize("NFC").trim();
  if (s.length === 0) return "Type your name first.";
  if ([...s].length > 40) return "Names can be up to 40 characters.";
  if (!/^[\p{L}\p{M}' \-’]+$/u.test(s)) return "Names can use letters, spaces, hyphens and apostrophes.";
  return null;
}

/** Typed guest text check mirrored from the server (plan SPK-6): no control characters, at most 280. */
export function typedProblem(raw: string): string | null {
  const s = raw.normalize("NFC").trim();
  if (s.length === 0) return "Type a message first.";
  if ([...s].length > 280) return "Messages can be up to 280 characters.";
  if (/[\p{Cc}]/u.test(s.replace(/\n/g, " "))) return "Messages cannot contain control characters.";
  return null;
}

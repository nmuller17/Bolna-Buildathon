// P4: spoken English -> signs, with P1's routes. /api/transcribe (Whisper) for audio, /api/gloss for text.
// Used by the hands-free guest screen and the optional /staff console.

import type { StaffIntentId } from "@/lib/voice/intents";

/** intents: the receptionist intents recognized in this sentence (/api/gloss), for the guest's expected answers. */
export type SignedSentence = { text: string; gloss: string[]; intents?: StaffIntentId[] };

const TRANSCRIBE_TIMEOUT_MS = 8000;
const GLOSS_TIMEOUT_MS = 5000;

/** Whisper error, with the HTTP status (0 = network or timeout). 401/503: no usable key. */
export class TranscribeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** True when /api/transcribe has an OpenAI key. Costs nothing: the route answers 503 before reading any audio. */
export async function whisperAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/transcribe", { method: "POST" });
    return res.status !== 503;
  } catch {
    return false;
  }
}

/** Whisper transcript of an audio file (webm or wav). Throws if Whisper fails or takes too long. */
export async function transcribe(audio: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, filename);
  let res: Response;
  try {
    res = await fetch("/api/transcribe", { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
  } catch (err) {
    throw new TranscribeError(`Whisper unreachable: ${err instanceof Error ? err.message : err}`, 0);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: unknown; error?: string };
  if (res.ok && typeof data.text !== "string") throw new TranscribeError("Whisper answer unreadable (timed out while reading?)", 0);
  if (!res.ok || typeof data.text !== "string") throw new TranscribeError(data.error ?? `Whisper failed (${res.status})`, res.status);
  return data.text.trim();
}

/**
 * One gloss per sentence: a question's BROWS-UP / BROWS-DOWN must be the first token of its gloss
 * ("Welcome! Do you have a reservation?" is two sentences), and captions follow sentence by sentence.
 * A sentence that cannot be glossed is skipped; the others still go. Throws only if none could.
 */
export async function toSignedSentences(text: string): Promise<SignedSentence[]> {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter((s) => /[a-z0-9]/i.test(s)) ?? [];
  const results = await Promise.all(
    sentences.map(async (sentence): Promise<SignedSentence | null> => {
      try {
        const res = await fetch("/api/gloss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence }),
          signal: AbortSignal.timeout(GLOSS_TIMEOUT_MS),
        });
        const data = (await res.json().catch(() => ({}))) as { gloss?: unknown; intents?: unknown };
        const gloss = Array.isArray(data.gloss) ? data.gloss.filter((t): t is string => typeof t === "string") : [];
        const intents = Array.isArray(data.intents)
          ? data.intents.filter((t): t is StaffIntentId => typeof t === "string")
          : [];
        if (res.ok && gloss.length > 0) return { text: sentence, gloss, intents };
      } catch (err) {
        console.warn(`[signs] /api/gloss failed for "${sentence}":`, err);
      }
      console.warn(`[signs] no signs for "${sentence}", skipped`);
      return null;
    }),
  );
  const ok = results.filter((r): r is SignedSentence => r !== null).flatMap(splitAtMarkers);
  if (sentences.length > 0 && ok.length === 0) throw new Error(`Could not turn "${text}" into signs.`);
  return ok;
}

const MARKERS = new Set(["BROWS-UP", "BROWS-DOWN"]);

/**
 * /api/gloss can return two intents in one gloss ("Welcome, do you have a reservation?" ->
 * HELLO WELCOME BROWS-UP YOU HAVE RESERVATION), but the avatar only applies a marker in first position.
 * Split there; the caption is cut at the commas when there are enough, else each part keeps the whole sentence.
 */
function splitAtMarkers(sentence: SignedSentence): SignedSentence[] {
  const parts: string[][] = [];
  for (const token of sentence.gloss) {
    if (parts.length === 0 || (MARKERS.has(token) && parts[parts.length - 1].length > 0)) parts.push([]);
    parts[parts.length - 1].push(token);
  }
  if (parts.length < 2) return [sentence];
  const clauses = sentence.text.split(",").map((c) => c.trim()).filter(Boolean);
  const texts =
    clauses.length >= parts.length
      ? [...clauses.slice(0, parts.length - 1), clauses.slice(parts.length - 1).join(", ")]
      : parts.map(() => sentence.text);
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return parts.map((gloss, i) => ({ text: capital(texts[i]), gloss, intents: sentence.intents }));
}

// P4: spoken English -> signs, with P1's routes. /api/transcribe (Whisper) for audio, /api/gloss for text.
// Used by the hands-free guest screen and the optional /staff console.

export type SignedSentence = { text: string; gloss: string[] };

const TRANSCRIBE_TIMEOUT_MS = 8000;

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
  const res = await fetch("/api/transcribe", { method: "POST", body: form, signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) });
  const data = (await res.json().catch(() => ({}))) as { text?: unknown; error?: string };
  if (!res.ok || typeof data.text !== "string") throw new Error(data.error ?? `Whisper failed (${res.status})`);
  return data.text.trim();
}

/**
 * One gloss per sentence: a question's BROWS-UP / BROWS-DOWN must be the first token of its gloss
 * ("Welcome! Do you have a reservation?" is two sentences), and captions follow sentence by sentence.
 */
export async function toSignedSentences(text: string): Promise<SignedSentence[]> {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter((s) => /[a-z0-9]/i.test(s)) ?? [];
  return Promise.all(
    sentences.map(async (sentence) => {
      const res = await fetch("/api/gloss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence }),
      });
      const data = (await res.json().catch(() => ({}))) as { gloss?: unknown; error?: string };
      const gloss = Array.isArray(data.gloss) ? data.gloss.filter((t): t is string => typeof t === "string") : [];
      if (!res.ok || gloss.length === 0) throw new Error(data.error ?? `Could not turn "${sentence}" into signs.`);
      return { text: sentence, gloss };
    }),
  );
}

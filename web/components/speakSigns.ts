/**
 * Guest -> staff voice: speaks the sentence the guest signed.
 *
 *   import { speakSigns, warmUpVoice } from "@/components/speakSigns";
 *
 *   useEffect(() => { warmUpVoice(); }, []);           // once, when the guest page loads
 *   const sentence = await speakSigns(predictions);    // resolves when playback ends
 *
 * speakSigns calls /api/english then /api/tts (ElevenLabs, or Piper). If the audio is not back within 2.5 s,
 * or cannot play, it speaks with the browser's speechSynthesis instead. If the signs give no
 * text it stays silent and returns "". Browsers only play audio after the page got a click.
 */
import type { Prediction } from "@/app/api/english/intents";

const TTS_TIMEOUT_MS = 2500;

const postJson = (url: string, data: unknown, signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal,
  });

async function fetchWav(text: string): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await postJson("/api/tts", { text }, controller.signal);
    if (!res.ok) throw new Error(`/api/tts failed: ${res.status}`);
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

function playWav(wav: Blob): Promise<void> {
  const url = URL.createObjectURL(wav);
  const audio = new Audio(url);
  return new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Audio playback failed"));
    audio.play().catch(reject);
  }).finally(() => URL.revokeObjectURL(url));
}

function speakWithBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

/** Speaks an English sentence: /api/tts audio, or the browser's voice if it is late or cannot play. Resolves when done. */
export async function speakText(text: string): Promise<void> {
  if (!text) return;
  try {
    await playWav(await fetchWav(text));
  } catch {
    await speakWithBrowser(text);
  }
}

/** Turns recognized signs into a spoken English sentence. Resolves with the sentence when speech ends. */
export async function speakSigns(signs: Prediction[]): Promise<string> {
  const res = await postJson("/api/english", { signs });
  if (!res.ok) throw new Error(`/api/english failed: ${res.status}`);
  const { text } = (await res.json()) as { text: string };
  await speakText(text);
  return text;
}

/** Warms /api/tts up (route compiled, ElevenLabs connection open) so the first real sentence speaks without delay. Call once on page load. */
export async function warmUpVoice(): Promise<void> {
  try {
    await postJson("/api/tts", { text: "Yes." }); // any request starts the warm-up
  } catch {
    // Not critical: speakSigns falls back to the browser voice.
  }
}

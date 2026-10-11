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

/**
 * SECURITY (red-team D9, docs/app-plan.md "Red-team requirements"): the last-resort voice must be an
 * on-device voice (localService === true). A network voice would send the sentence to the browser
 * vendor; when no local English voice exists we stay silent (the caller still gets the text to show).
 */
function localEnglishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.localService);
  return voices.find((v) => v.lang === "en-US") ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
}

function speakWithBrowser(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const voice = localEnglishVoice();
    if (!voice) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

/** Turns recognized signs into a spoken English sentence. Resolves with the sentence when speech ends. */
export async function speakSigns(signs: Prediction[]): Promise<string> {
  const res = await postJson("/api/english", { signs });
  if (!res.ok) throw new Error(`/api/english failed: ${res.status}`);
  const { text } = (await res.json()) as { text: string };
  if (!text) return "";

  try {
    await playWav(await fetchWav(text));
  } catch {
    await speakWithBrowser(text);
  }
  return text;
}

/** Makes the server pre-generate the known guest sentences with Piper, the offline fallback (~7 s in the background). Call once on page load. */
export async function warmUpVoice(): Promise<void> {
  try {
    await postJson("/api/tts", { text: "Yes." }); // any request starts the warm-up
  } catch {
    // Not critical: speakSigns falls back to the browser voice.
  }
}

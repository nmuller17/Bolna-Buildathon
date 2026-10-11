"use client";
// P4 (builder B): the staff laptop's voice (docs/app-plan.md 5.2 G7, SPK-5, DSH-10).
//
// - One AudioContext, created and unlocked by the "Start desk" tap, plays every WAV from Nath's
//   /api/tts. Chrome then lets it play audio long after the gesture (C1-16); new Audio() would not.
// - /api/tts only ever receives the FIXED table sentence the server put in the speak plan; names and
//   typed text are voiced with an on-device voice (localService) after a staff tap, never sent anywhere.
// - When no on-device voice exists, nothing is spoken and the screen says so (red-team D9).

let ctx: AudioContext | null = null;

/** Call from the Start desk click handler only (it must run inside the user gesture). */
export function unlockAudio(): boolean {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx ??= new AC();
    void ctx.resume();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    return true;
  } catch {
    return false;
  }
}

export type Voiced = { how: "tts" | "local" | "none"; startedAt: number | null };

/** Fetches the fixed sentence's WAV from /api/tts and plays it. Resolves when playback has started. */
async function playTts(body: { id: number } | { text: string }, timeoutMs: number): Promise<number> {
  if (!ctx) throw new Error("audio locked");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(String(res.status));
    const audio = await ctx.decodeAudioData(await res.arrayBuffer());
    if (ctx.state !== "running") await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    src.start();
    return Date.now();
  } finally {
    clearTimeout(timer);
  }
}

/** An English voice that runs on this laptop. A network voice would send the text to the browser vendor. */
export function localVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices().filter((v) => v.localService);
  return voices.find((v) => v.lang === "en-US") ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
}

/** Speaks with the on-device voice. Resolves with the start time, or null when there is no such voice. */
export function speakLocal(text: string): Promise<number | null> {
  return new Promise((resolve) => {
    const voice = localVoice();
    if (!voice) return resolve(null);
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    let done = false;
    const finish = (v: number | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    u.onstart = () => finish(Date.now());
    u.onerror = () => finish(null);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setTimeout(() => finish(Date.now()), 3_000); // some engines never fire onstart
  });
}

/** Fixed sentence: /api/tts first (Piper or the vendor voice), then the on-device voice, else silence. */
export async function voiceFixed(text: string, useTts = true, intentId: number | null = null): Promise<Voiced> {
  if (!useTts) {
    // /api/tts has no voice configured (no ElevenLabs key, Piper off): go straight to the on-device voice.
    const started = await speakLocal(text);
    return started ? { how: "local", startedAt: started } : { how: "none", startedAt: null };
  }
  try {
    // The route prefers { id } (RT5): the server looks the fixed sentence up itself.
    return { how: "tts", startedAt: await playTts(intentId !== null ? { id: intentId } : { text }, 4_000) };
  } catch {
    const started = await speakLocal(text);
    return started ? { how: "local", startedAt: started } : { how: "none", startedAt: null };
  }
}

/** Short two-note tone for the Help banner. Never the only signal: the banner is always on screen. */
export function helpTone(): void {
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime;
  for (const [i, f] of [880, 660].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t + i * 0.22);
    gain.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + i * 0.22);
    osc.stop(t + i * 0.22 + 0.21);
  }
}

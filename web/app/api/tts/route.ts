// P4: { text } -> audio/wav with ElevenLabs. If it fails, a 500: the client speaks with the browser's voice.
// Piper (local) is off: set PIPER_FALLBACK=1 to use it when ElevenLabs fails. It takes ~7 s per run (mostly loading
// the voice), so it then also pre-generates every known guest sentence in one run. All audio is cached in memory.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INTENTS } from "../english/intents";

export const runtime = "nodejs";

const PIPER_TIMEOUT_MS = 30_000;
const PIPER_ON = process.env.PIPER_FALLBACK === "1";
const ELEVENLABS_TIMEOUT_MS = 2000; // the client gives up at 2.5 s and uses the browser's voice
const DEFAULT_ELEVENLABS_VOICE = "EXAVITQu4vr4xnSDxMaL"; // "Sarah", an ElevenLabs premade voice

// text -> WAV, per engine. Also holds in-flight runs so the same sentence is never synthesized twice at once.
const elevenLabsCache = new Map<string, Promise<Buffer>>();
const piperCache = new Map<string, Promise<Buffer>>();
let warmUpStarted = false;

async function synthesizeElevenLabs(text: string, apiKey: string): Promise<Buffer> {
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=wav_22050`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `python -m piper -m <voice> <args>` with `input` on stdin (one sentence per line). */
function runPiper(args: string[], input: string): Promise<void> {
  const voice = process.env.PIPER_VOICE;
  if (!voice) return Promise.reject(new Error("PIPER_VOICE is not set in web/.env.local"));

  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-m", "piper", "-m", path.resolve(voice), ...args], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), PIPER_TIMEOUT_MS);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {}); // reported by the close handler
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}: ${stderr.slice(-300)}`));
    });
    child.stdin.end(input);
  });
}

async function synthesizePiper(text: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "piper-"));
  try {
    const file = path.join(dir, "out.wav");
    await runPiper(["-f", file], text);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Piper names batch files after the text minus punctuation it can't use ("Where is the elevator.wav").
const fileKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** One Piper run for many sentences: the voice loads once, one WAV per line. */
async function synthesizePiperBatch(texts: string[]): Promise<Map<string, Buffer>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "piper-batch-"));
  try {
    await runPiper(["-d", dir, "--output-dir-naming", "text"], texts.join("\n"));
    const byKey = new Map(texts.map((t) => [fileKey(t), t]));
    const result = new Map<string, Buffer>();
    for (const name of await readdir(dir)) {
      const text = byKey.get(fileKey(name.replace(/\.wav$/i, "")));
      if (text) result.set(text, await readFile(path.join(dir, name)));
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cacheAudio(cache: Map<string, Promise<Buffer>>, text: string, audio: Promise<Buffer>) {
  cache.set(text, audio);
  audio.catch(() => cache.delete(text)); // failed runs are retried on the next request
}

function cached(cache: Map<string, Promise<Buffer>>, text: string, make: () => Promise<Buffer>) {
  if (!cache.has(text)) cacheAudio(cache, text, make());
  return cache.get(text)!;
}

/** Pre-generates every known guest sentence with Piper once, so the fallback plays them instantly. */
function startWarmUp() {
  if (warmUpStarted) return;
  warmUpStarted = true;
  const texts = [...new Set(INTENTS.map((i) => i.text))].filter((t) => !piperCache.has(t));
  if (texts.length === 0) return;
  const batch = synthesizePiperBatch(texts);
  batch.catch((err) => console.warn("[api/tts] Piper warm-up failed:", err));
  for (const text of texts) {
    cacheAudio(
      piperCache,
      text,
      batch.then((wavs) => {
        const wav = wavs.get(text);
        if (!wav) throw new Error(`warm-up produced no file for "${text}"`);
        return wav;
      }),
    );
  }
}

async function synthesize(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey) {
    try {
      return await cached(elevenLabsCache, text, () => synthesizeElevenLabs(text, apiKey));
    } catch (err) {
      if (!PIPER_ON) throw err;
      console.warn("[api/tts] ElevenLabs failed, using Piper:", err);
    }
  }
  if (!PIPER_ON) throw new Error("ELEVENLABS_API_KEY is not set (and PIPER_FALLBACK is off)");
  return cached(piperCache, text, () => synthesizePiper(text));
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = (body as { text?: unknown } | null)?.text;
  // Piper reads one sentence per line, so newlines would split the audio.
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return Response.json({ error: "Expected { text: non-empty string }" }, { status: 400 });

  if (PIPER_ON) startWarmUp();
  try {
    const wav = await synthesize(text);
    return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav" } });
  } catch (err) {
    console.error("[api/tts] TTS failed:", err);
    return Response.json({ error: "TTS failed" }, { status: 500 });
  }
}

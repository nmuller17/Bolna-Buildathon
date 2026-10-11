// P4: { text } -> audio/wav with ElevenLabs. If it fails, a 500: the client speaks with the browser's voice.
// Piper (local) is off: set PIPER_FALLBACK=1 to use it when ElevenLabs fails. It takes ~7 s per run (mostly loading
// the voice), so it then also pre-generates every known guest sentence in one run. All audio is cached in memory.
// (ElevenLabs-only default from p4-app 27e6b51, merged into talha/app-shell.)
// SECURITY (P4 red-team fixes B1/B3/B6/B9/C3/D2/D3/D5, 2026-10-10): see docs/requests.md "Red-team changes
// to teammate routes". Changes are marked "SECURITY:" below; synthesis itself is unchanged.
// APP (talha/app-shell builder A, 2026-10-11; docs/app-plan.md SPK-5, RT5, D8):
// - `{ id }` (a guest intent id, 1..20 except NAME) is accepted next to `{ text }`; the app's staff page
//   sends only `{ id }` from the server's speak plan, so names and typed text never reach this route;
// - no guest text to a vendor: ElevenLabs is used only for the fixed table sentences; any other text
//   goes to local Piper (PIPER_FALLBACK=1) or gets 500, and the staff page then uses an on-device voice;
// - each real ElevenLabs request is counted for the privacy panel (lib/app/taps.ts), byte count only;
// - the staff cookie is required (lib/app/guard.ts, SRV-10), and vendor error bodies are never logged.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INTENTS } from "../english/intents";
import { cleanSentence } from "@/lib/app/access";
import { guardLoopbackJsonPost } from "@/lib/app/guard";
import { recordVendorTap } from "@/lib/app/taps";
import { fixedSentenceForId } from "@/lib/app/vocab";

export const runtime = "nodejs";

const PIPER_TIMEOUT_MS = 30_000;
const PIPER_ON = process.env.PIPER_FALLBACK === "1";
const ELEVENLABS_TIMEOUT_MS = 2000; // the client gives up at 2.5 s and uses the browser's voice
const DEFAULT_ELEVENLABS_VOICE = "EXAVITQu4vr4xnSDxMaL"; // "Sarah", an ElevenLabs premade voice
// SECURITY: request limits (docs/app-plan.md section 7: 4 KB body, 20/min) and a text cap.
const MAX_BODY_BYTES = 4 * 1024;
const PER_MINUTE = 20;
const MAX_TEXT_CHARS = 300;
// SECURITY (B6/D3): only the fixed guest sentences are cached. Any other text is synthesized
// uncached (no unbounded memory, no "was this sentence said before?" timing oracle) and at most
// MAX_UNCACHED_IN_FLIGHT at a time (no Piper process flood).
const FIXED_TEXTS = new Set(INTENTS.map((i) => i.text));
const MAX_UNCACHED_IN_FLIGHT = 2;
let uncachedInFlight = 0;
class TtsBusy extends Error {}
// SECURITY (B9/C3/D5): the Piper child gets only these variables, never the API keys or BRIDGE_KEY.
const PIPER_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "USERPROFILE"];
let warnedBarePython = false;

/** SECURITY (B9/C3): an absolute interpreter: PIPER_PYTHON, else the repo's .venv, else (warned) PATH. */
function piperPython(): string {
  const configured = process.env.PIPER_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("PIPER_PYTHON must be an absolute path");
    return configured;
  }
  for (const venv of [path.resolve(process.cwd(), "..", ".venv"), path.resolve(process.cwd(), ".venv")]) {
    for (const exe of [path.join(venv, "bin", "python"), path.join(venv, "Scripts", "python.exe")]) {
      if (existsSync(/*turbopackIgnore: true*/ exe)) return exe;
    }
  }
  if (!warnedBarePython) {
    warnedBarePython = true;
    console.warn("[api/tts] PIPER_PYTHON is not set and no .venv was found; using `python` from PATH");
  }
  return "python";
}

/** APP (SRV-12): a short error type for the log; never Piper's stderr (it can echo the text) or a vendor body. */
function shortError(err: unknown): string {
  const m = err instanceof Error ? err.message : "error";
  return m.split(":")[0].slice(0, 120);
}

function piperEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = { PYTHONIOENCODING: "utf-8" };
  for (const key of PIPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as unknown as NodeJS.ProcessEnv;
}

// text -> WAV, per engine. Also holds in-flight runs so the same sentence is never synthesized twice at once.
const elevenLabsCache = new Map<string, Promise<Buffer>>();
const piperCache = new Map<string, Promise<Buffer>>();
let warmUpStarted = false;

async function synthesizeElevenLabs(text: string, apiKey: string): Promise<Buffer> {
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
  try {
    const payload = JSON.stringify({ text, model_id: "eleven_flash_v2_5" });
    // APP: counted before the request goes out (privacy panel: bytes sent off the laptop).
    recordVendorTap("/api/tts", Buffer.byteLength(payload));
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=wav_22050`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      },
    );
    // APP (SRV-12): the status only, never the vendor's response body.
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
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
    // SECURITY (B9/C3/D5): absolute interpreter and an allowlisted environment (was "python" + {...process.env}).
    const child = spawn(/*turbopackIgnore: true*/ piperPython(), ["-m", "piper", "-m", path.resolve(voice), ...args], {
      stdio: ["pipe", "ignore", "pipe"],
      env: piperEnv(),
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
  batch.catch((err) => console.warn("[api/tts] Piper warm-up failed:", shortError(err)));
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
  // SECURITY (B6/D3): cache fixed sentences only; free text is uncached and concurrency-limited.
  const fixed = FIXED_TEXTS.has(text);
  if (!fixed && uncachedInFlight >= MAX_UNCACHED_IN_FLIGHT) throw new TtsBusy("busy");
  const run = (cache: Map<string, Promise<Buffer>>, make: () => Promise<Buffer>) =>
    fixed ? cached(cache, text, make) : make();
  if (!fixed) uncachedInFlight++;
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    // APP (no guest text to vendors): only a fixed table sentence may go to ElevenLabs.
    if (apiKey && fixed) {
      try {
        return await run(elevenLabsCache, () => synthesizeElevenLabs(text, apiKey));
      } catch (err) {
        if (!PIPER_ON) throw err;
        console.warn("[api/tts] ElevenLabs failed, using Piper:", shortError(err));
      }
    }
    if (!PIPER_ON) throw new Error(apiKey ? "not a fixed sentence (never sent to a vendor) and PIPER_FALLBACK is off" : "ELEVENLABS_API_KEY is not set (and PIPER_FALLBACK is off)");
    return await run(piperCache, () => synthesizePiper(text));
  } finally {
    if (!fixed) uncachedInFlight--;
  }
}

export async function POST(req: Request) {
  // SECURITY (B1/B3/D2): loopback only (via web/server.mjs), Host allowlist, same-origin,
  // application/json, 4 KB capped read, 20 requests a minute. Replaces `await req.json()`.
  const guarded = await guardLoopbackJsonPost(req, { route: "tts", maxBytes: MAX_BODY_BYTES, perMinute: PER_MINUTE });
  if (!guarded.ok) return guarded.res;
  const body: unknown = guarded.body;
  // APP (RT5): { id } names a fixed guest sentence; it must be the only key.
  const obj = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (obj && "id" in obj) {
    const fixedText = Object.keys(obj).length === 1 ? fixedSentenceForId(obj.id) : null;
    if (!fixedText) {
      return Response.json({ error: "Expected { id: a guest intent number 1 to 20, not the NAME intent }" }, { status: 400 });
    }
    obj.text = fixedText;
    delete obj.id;
  }
  const raw = obj?.text;
  // Piper reads one sentence per line, so newlines would split the audio (cleanSentence collapses them).
  // SECURITY (B6/D2): at most MAX_TEXT_CHARS plain-sentence characters (no markup, no control characters).
  const text = cleanSentence(raw, MAX_TEXT_CHARS);
  if (!text) {
    return Response.json(
      { error: `Expected { text: one plain sentence of at most ${MAX_TEXT_CHARS} characters }` },
      { status: 400 },
    );
  }

  if (PIPER_ON) startWarmUp();
  try {
    const wav = await synthesize(text);
    return new Response(new Uint8Array(wav), { headers: { "Content-Type": "audio/wav" } });
  } catch (err) {
    if (err instanceof TtsBusy) return Response.json({ error: "TTS busy, retry" }, { status: 503 });
    console.error("[api/tts] TTS failed:", shortError(err));
    return Response.json({ error: "TTS failed" }, { status: 500 });
  }
}

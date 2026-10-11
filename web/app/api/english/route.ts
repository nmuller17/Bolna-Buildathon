// P4: { signs: Prediction[] } -> { text }. Known sign sequences come from intents.ts, anything else goes to Claude.
import { INTENTS, LABELS, lookupIntent, type Prediction } from "./intents";
// SECURITY (P4 red-team fixes B1/B3/B4/B5/D1/D6, 2026-10-10): see docs/requests.md "Red-team changes to
// teammate routes". Changes are marked "SECURITY:" below; the logic of the route is otherwise unchanged.
import { cleanSentence } from "@/lib/app/access";
import { guardLoopbackJsonPost } from "@/lib/app/guard";

export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 3000;
// SECURITY: request limits (docs/app-plan.md section 7: 8 KB body, 10/min, at most 8 signs).
const MAX_BODY_BYTES = 8 * 1024;
const PER_MINUTE = 10;
const MAX_SIGNS = 8;
const MAX_SENTENCE_CHARS = 200;

const SYSTEM_PROMPT = [
  "You work at a hotel front desk. A Deaf guest signed the ASL signs below, in this order.",
  "Write ONE short, natural, first-person English sentence that says what the guest means.",
  "Do not add facts the signs do not imply. Output only the sentence.",
  "",
  "Sign meanings:",
  ...Object.entries(LABELS).map(([label, meaning]) => `${label} = ${meaning}`),
  "",
  "Examples:",
  ...INTENTS.map((i) => `${i.signs.join(" ")} -> ${i.text}`),
].join("\n");

function isPredictionList(value: unknown): value is Prediction[] {
  // SECURITY: at most MAX_SIGNS entries, short labels, finite conf in [0, 1].
  return (
    Array.isArray(value) &&
    value.length <= MAX_SIGNS &&
    value.every(
      (p) =>
        typeof p?.label === "string" &&
        p.label.length <= 32 &&
        typeof p?.conf === "number" &&
        Number.isFinite(p.conf) &&
        p.conf >= 0 &&
        p.conf <= 1,
    )
  );
}

/** Labels in order, uppercased, NONE dropped, consecutive duplicates collapsed. */
function normalize(signs: Prediction[]): string[] {
  const labels: string[] = [];
  for (const { label } of signs) {
    const l = label.trim().toUpperCase();
    if (!l || l === "NONE" || l === labels[labels.length - 1]) continue;
    labels.push(l);
  }
  return labels;
}

async function askClaude(labels: string[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        // Haiku 5.5 rejects temperature 0 with a 400, so sampling stays at its default.
        // Thinking is off to stay well under the timeout.
        thinking: { type: "disabled" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: labels.join(" ") }],
      }),
      signal: controller.signal,
    });
    // SECURITY (D6): status only; the vendor's error body may echo the request and is never logged.
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data: { content?: { type: string; text?: string }[] } = await res.json();
    // SECURITY (B5/D1): Claude's reply is spoken aloud, so it must be one short plain sentence.
    const text = cleanSentence(data.content?.find((block) => block.type === "text")?.text, MAX_SENTENCE_CHARS);
    if (!text) throw new Error("No usable text block in Claude response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Labels as readable words: THANK-YOU -> "thank you", FS-WIFI -> "Wi-Fi". */
function fallbackSentence(labels: string[]): string {
  const words = labels.map((l) => LABELS[l] ?? l.toLowerCase().replace(/-/g, " ")).join(" ");
  const end = labels[0] === "WHERE" ? "?" : ".";
  return words.charAt(0).toUpperCase() + words.slice(1) + end;
}

export async function POST(req: Request) {
  // SECURITY (B1/B3/B4/D1): loopback only (via web/server.mjs), Host allowlist, same-origin,
  // application/json, 8 KB capped read, 10 requests a minute. Replaces `await req.json()`.
  const guarded = await guardLoopbackJsonPost(req, { route: "english", maxBytes: MAX_BODY_BYTES, perMinute: PER_MINUTE });
  if (!guarded.ok) return guarded.res;
  const body: unknown = guarded.body;
  const signs = (body as { signs?: unknown } | null)?.signs;
  if (!isPredictionList(signs)) {
    return Response.json({ error: "Expected { signs: Prediction[] }" }, { status: 400 });
  }

  const labels = normalize(signs);
  // SECURITY (B4/B5/D1): only the 22 classifier labels may reach Claude or the fallback sentence.
  if (labels.some((l) => !Object.prototype.hasOwnProperty.call(LABELS, l))) {
    return Response.json({ error: "Unknown sign label" }, { status: 400 });
  }
  if (labels.length === 0) return Response.json({ text: "" });

  const known = lookupIntent(labels);
  if (known) return Response.json({ text: known });

  try {
    return Response.json({ text: await askClaude(labels) });
  } catch (err) {
    // SECURITY (D6): log the short message only, never a vendor body or the request.
    console.warn("[api/english] Claude failed, using fallback:", err instanceof Error ? err.message : "error");
    return Response.json({ text: fallbackSentence(labels) });
  }
}

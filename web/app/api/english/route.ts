// P4: { signs: Prediction[] } -> { text }. Known sign sequences come from intents.ts, anything else goes to Claude.
import { INTENTS, LABELS, lookupIntent, type Prediction } from "./intents";

export const runtime = "nodejs";

const MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 3000;

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
  return (
    Array.isArray(value) &&
    value.every((p) => typeof p?.label === "string" && typeof p?.conf === "number")
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
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data: { content?: { type: string; text?: string }[] } = await res.json();
    const text = data.content?.find((block) => block.type === "text")?.text?.trim();
    if (!text) throw new Error("No text block in Claude response");
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const signs = (body as { signs?: unknown } | null)?.signs;
  if (!isPredictionList(signs)) {
    return Response.json({ error: "Expected { signs: Prediction[] }" }, { status: 400 });
  }

  const labels = normalize(signs);
  if (labels.length === 0) return Response.json({ text: "" });

  const known = lookupIntent(labels);
  if (known) return Response.json({ text: known });

  try {
    return Response.json({ text: await askClaude(labels) });
  } catch (err) {
    console.warn("[api/english] Claude failed, using fallback:", err);
    return Response.json({ text: fallbackSentence(labels) });
  }
}

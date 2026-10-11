// P4: receives the recognizer's events (recognition/live_key.py and live.py, --post) and pushes them to the pages.
// Loopback only; X-Bridge-Key must match when BRIDGE_KEY is set. Events: sign, utterance (two shapes), framing, status.
// For a real guarantee, also run the app bound to loopback (next dev -H 127.0.0.1) with a BRIDGE_KEY.
import { timingSafeEqual } from "node:crypto";
import { LABELS, type Prediction } from "../../english/intents";
import { fromLoopback, guestBus, publish, type GuestEvent } from "../bus";

export const runtime = "nodejs";

const ENGLISH_TIMEOUT_MS = 4000;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

function keyOk(request: Request) {
  const expected = process.env.BRIDGE_KEY;
  if (!expected) return true;
  const given = Buffer.from(request.headers.get("x-bridge-key") ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

const isLabel = (v: unknown): v is string => typeof v === "string" && /^[A-Z0-9][A-Z0-9-]{0,30}$/.test(v);
const isLabels = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 20 && v.every(isLabel);
const isPrediction = (v: unknown): v is Prediction =>
  typeof v === "object" && v !== null && isLabel((v as Prediction).label) && typeof (v as Prediction).conf === "number" &&
  (v as Prediction).conf >= 0 && (v as Prediction).conf <= 1;
const isPredictions = (v: unknown, max: number): v is Prediction[] => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(isPrediction);

/** Labels as readable words, if /api/english is unreachable: THANK-YOU -> "thank you". */
function words(labels: string[]) {
  const s = labels.map((l) => LABELS[l] ?? l.toLowerCase().replace(/-/g, " ")).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + (labels[0] === "WHERE" ? "?" : ".");
}

/** No known sentence from the recognizer: ask /api/english (intents table, then Claude, then words). */
async function english(request: Request, signs: Prediction[]): Promise<{ text: string; source: "english" | "words" }> {
  try {
    const res = await fetch(new URL("/api/english", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signs }),
      signal: AbortSignal.timeout(ENGLISH_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: unknown };
    if (res.ok && typeof data.text === "string" && data.text.trim()) return { text: data.text.trim(), source: "english" };
  } catch (err) {
    console.warn("[api/guest/signs] /api/english failed, using words:", err);
  }
  return { text: words(signs.map((s) => s.label)), source: "words" };
}

export async function POST(request: Request) {
  if (!fromLoopback(request)) return bad("Loopback only", 403);
  if (!keyOk(request)) return bad("Bad or missing X-Bridge-Key", 401);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("Expected a JSON event");
  const at = Date.now() / 1000;
  const bus = guestBus();

  switch (body.type) {
    case "sign": {
      if (!Number.isInteger(body.seq) || (body.seq as number) < 0 || !isPredictions(body.top, 5)) {
        return bad('Expected { type: "sign", seq: int, top: [{ label, conf }] }');
      }
      publish({ type: "sign", seq: body.seq as number, top: body.top, at });
      return Response.json({ ok: true });
    }

    case "utterance": {
      let labels: string[], raw: string[], confs: number[], text: string | null, needsRepeat: boolean;
      if (isLabels(body.labels) && body.labels.length > 0) {
        // live_key.py: { raw, labels, text, snapped }
        if (body.raw !== undefined && !isLabels(body.raw)) return bad("raw must be a list of labels");
        if (body.text !== null && body.text !== undefined && typeof body.text !== "string") return bad("text must be a string or null");
        labels = body.labels;
        raw = (body.raw as string[] | undefined) ?? labels;
        confs = labels.map(() => 1);
        text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : null;
        needsRepeat = body.needs_repeat === true;
      } else if (isPredictions(body.signs, 20)) {
        // live.py: { signs: [{ label, conf }], seqs, needs_repeat }
        labels = body.signs.map((s) => s.label);
        raw = labels;
        confs = body.signs.map((s) => s.conf);
        text = null;
        needsRepeat = body.needs_repeat === true;
      } else {
        return bad('Expected { type: "utterance", labels: [...], raw?, text? } or { type: "utterance", signs: [{ label, conf }] }');
      }
      needsRepeat ||= labels.includes("NONE");
      const mock = bus.recognizer?.type === "recognizer" && bus.recognizer.state === "mock";
      let source: "recognizer" | "english" | "words" = "recognizer";
      if (!text && !needsRepeat) ({ text, source } = await english(request, labels.map((label, i) => ({ label, conf: confs[i] }))));
      const event: GuestEvent = {
        type: "utterance",
        id: bus.nextId++,
        labels,
        raw,
        text: text ?? "",
        source,
        needsRepeat,
        mock,
        at,
      };
      publish(event);
      return Response.json({ ok: true, text: event.text, needsRepeat });
    }

    case "framing": {
      if (typeof body.status !== "string" || body.status.length > 40) return bad('Expected { type: "framing", status }');
      publish({ type: "framing", status: body.status, at });
      return Response.json({ ok: true });
    }

    case "status": {
      if (typeof body.recognizer !== "string" || body.recognizer.length > 20) return bad('Expected { type: "status", recognizer }');
      if (bus.recognizer?.type !== "recognizer" || bus.recognizer.state !== body.recognizer) {
        publish({ type: "recognizer", state: body.recognizer, at });
      }
      return Response.json({ ok: true });
    }

    default:
      return bad("Unknown event type");
  }
}

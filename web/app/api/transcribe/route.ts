// P4 MERGE FIX (2026-10-10, listed in docs/requests.md "P4 merge fixes to P1 routes"): loopback-only
// guard with a required Content-Length of at most 5 MB (red-team RT1/B1/B4), and the vendor's error
// body is no longer returned or logged (red-team D6/RT11). Marked "P4 MERGE FIX:"; Whisper use unchanged.
import { guardLoopbackRawPost } from "@/lib/app/guard";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // P4 MERGE FIX: same cap as web/server.mjs BODY_CAP_AUDIO
const PER_MINUTE = 20;

export async function POST(request: Request) {
  // P4 MERGE FIX: refuse non-loopback, cross-site, non-multipart, oversized or too frequent requests first.
  const guarded = guardLoopbackRawPost(request, {
    route: "transcribe",
    maxBytes: MAX_BODY_BYTES,
    perMinute: PER_MINUTE,
    contentType: /^multipart\/form-data;/i,
  });
  if (!guarded.ok) return guarded.res;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Missing OPENAI_API_KEY. Add it to web/.env.local to enable Whisper transcription." },
      { status: 503 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const audio = formData?.get("audio");
  if (!(audio instanceof File)) {
    return Response.json(
      { error: 'Expected multipart form data with an audio file field named "audio".' },
      { status: 400 },
    );
  }

  const whisperForm = new FormData();
  whisperForm.append("file", audio, audio.name || "speech.webm");
  whisperForm.append("model", "whisper-1");
  whisperForm.append("language", "en");
  whisperForm.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: whisperForm,
  }).catch(() => null);

  if (!response) {
    return Response.json({ error: "Could not reach the Whisper transcription service." }, { status: 502 });
  }

  if (!response.ok) {
    // P4 MERGE FIX: status only; the vendor body may echo the request and is never returned or logged.
    return Response.json({ error: `Whisper transcription failed (status ${response.status}).` }, { status: 502 });
  }

  const data = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) {
    return Response.json({ error: "Whisper returned an empty transcript." }, { status: 502 });
  }

  return Response.json({ text });
}

export const runtime = "nodejs";

export async function POST(request: Request) {
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
    const detail = await response.text().catch(() => "");
    return Response.json({ error: "Whisper transcription failed.", detail: detail.slice(0, 500) }, { status: response.status });
  }

  const data = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  if (!text) {
    return Response.json({ error: "Whisper returned an empty transcript." }, { status: 502 });
  }

  return Response.json({ text });
}

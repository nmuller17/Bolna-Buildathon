import { fallbackGlossFromText, mapStaffTextToGloss } from "@/lib/voice/intents";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return Response.json({ error: "Expected JSON body with non-empty text." }, { status: 400 });
  }

  const local = mapStaffTextToGloss(text);
  if (local.matches.some((match) => match.intentId !== "unknown")) {
    return Response.json({ gloss: local.gloss });
  }

  return Response.json({ gloss: fallbackGlossFromText(text) });
}

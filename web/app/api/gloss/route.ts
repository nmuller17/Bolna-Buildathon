import { readFile } from "node:fs/promises";
import path from "node:path";
import { fallbackGlossFromText, mapStaffTextToGloss } from "@/lib/voice/intents";

export const runtime = "nodejs";

// Keys of signs/index.json (served by web/app/signs/[...path]/route.ts): the signs the avatar can play.
let knownSigns: Promise<Set<string>> | null = null;
function loadKnownSigns(): Promise<Set<string>> {
  // Read from <repo>/signs: the web/public/signs symlink was replaced by the /signs route (security PR).
  knownSigns ??= readFile(path.join(process.cwd(), "..", "signs", "index.json"), "utf8")
    .then((json) => new Set(Object.keys(JSON.parse(json) as Record<string, string>)))
    .catch(() => {
      knownSigns = null;
      return new Set<string>();
    });
  return knownSigns;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return Response.json({ error: "Expected JSON body with non-empty text." }, { status: 400 });
  }

  const known = await loadKnownSigns();
  const local = mapStaffTextToGloss(text, known);
  if (local.matches.some((match) => match.intentId !== "unknown")) {
    return Response.json({ gloss: local.gloss });
  }

  return Response.json({ gloss: fallbackGlossFromText(text, known) });
}

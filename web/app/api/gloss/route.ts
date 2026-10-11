import { readFile } from "node:fs/promises";
import path from "node:path";
import { fallbackGlossFromText, mapStaffTextToGloss } from "@/lib/voice/intents";
// P4 MERGE FIX (2026-10-10, listed in docs/requests.md "P4 merge fixes to P1 routes"): the
// web/public/signs symlink was replaced by the /signs route (red-team B2), so the sign index is read
// from <repo>/signs directly; and the route now uses the shared loopback guard (red-team RT1/B1/B4).
// Changes are marked "P4 MERGE FIX:"; the intent mapping itself is unchanged.
import { guardLoopbackJsonPost } from "@/lib/app/guard";

export const runtime = "nodejs";

// Keys of signs/index.json (served to the browser by web/app/signs/[...path]/route.ts): the signs the avatar can play.
let knownSigns: Promise<Set<string>> | null = null;
function loadKnownSigns(): Promise<Set<string>> {
  knownSigns ??= readFile(path.join(process.cwd(), "..", "signs", "index.json"), "utf8") // P4 MERGE FIX: was public/signs (symlink removed)
    .then((json) => new Set(Object.keys(JSON.parse(json) as Record<string, string>)))
    .catch(() => {
      knownSigns = null;
      return new Set<string>();
    });
  return knownSigns;
}

// P4 MERGE FIX: limits (docs/app-plan.md section 7: 4 KB body, staff text at most 300 characters).
const MAX_BODY_BYTES = 4 * 1024;
const PER_MINUTE = 30;
const MAX_TEXT_CHARS = 300;

export async function POST(request: Request) {
  // P4 MERGE FIX: loopback only, Host allowlist, same-origin, JSON, capped read, rate limit (was request.json()).
  const guarded = await guardLoopbackJsonPost(request, { route: "gloss", maxBytes: MAX_BODY_BYTES, perMinute: PER_MINUTE });
  if (!guarded.ok) return guarded.res;
  const body = guarded.body as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return Response.json({ error: "Expected JSON body with non-empty text." }, { status: 400 });
  }
  if ([...text].length > MAX_TEXT_CHARS) {
    return Response.json({ error: `Text longer than ${MAX_TEXT_CHARS} characters.` }, { status: 400 });
  }

  const known = await loadKnownSigns();
  const local = mapStaffTextToGloss(text, known);
  if (local.matches.some((match) => match.intentId !== "unknown")) {
    return Response.json({ gloss: local.gloss });
  }

  return Response.json({ gloss: fallbackGlossFromText(text, known) });
}

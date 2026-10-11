// GET /signs/<file>.json and /signs/<dir>/<file>.json: the avatar's sign files (red-team fix B2, D7).
//
// Replaces the old web/public/signs -> ../../signs symlink, which served every file under signs/
// as-is, including the recorder's name in "signer", to anything that could reach the app.
// This route serves only *.json files one or two levels deep under signs/, refuses anything that
// resolves outside it (symlinks included), and drops the "signer" field, which the avatar never
// reads. URLs are unchanged, so web/lib/avatar/lookup.ts keeps fetching `/signs/index.json` etc.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNS_DIR = path.resolve(process.cwd(), "..", "signs");
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const notFound = () => Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const parts = (await ctx.params).path ?? [];
  if (parts.length < 1 || parts.length > 2) return notFound();
  const last = parts[parts.length - 1];
  if (!last.endsWith(".json")) return notFound();
  const names = [...parts.slice(0, -1), last.slice(0, -".json".length)];
  if (!names.every((n) => SEGMENT.test(n))) return notFound();

  let file: string;
  try {
    const root = await realpath(SIGNS_DIR);
    file = await realpath(path.join(root, ...parts));
    if (!file.startsWith(root + path.sep)) return notFound();
  } catch {
    return notFound();
  }

  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return notFound();
  }
  if (data && typeof data === "object" && !Array.isArray(data) && "signer" in data) {
    delete (data as Record<string, unknown>).signer;
  }
  return new Response(JSON.stringify(data), { headers: HEADERS });
}

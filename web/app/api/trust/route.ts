// P4: the staff privacy panel's data (BN-2). Loopback only, like the guest bridge.
// GET: real counters only. Requests this server sent off the laptop (destination host and count, this
// session and since the server started), guest items the server holds right now, and the last wipe.
// POST { "action": "wipe" }: erases the guest data the server holds (lib: guest bus), starts a new counting
// session and tells /staff and /guest to clear their guest views. JSON only and same-origin only, so another
// web page open in the same browser cannot trigger it.
import { egressSnapshot, resetSession } from "@/lib/app/egress";
import { fromLoopback, heldItems, wipe } from "../guest/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!fromLoopback(request)) return Response.json({ error: "Loopback only" }, { status: 403 });
  return Response.json({ egress: egressSnapshot(), heldItems: heldItems() }, { headers: NO_STORE });
}

/** A browser always sends Origin on a POST; when present it must be this page's own origin. */
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return true; // curl and scripts on the laptop (still loopback only)
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!fromLoopback(request)) return Response.json({ error: "Loopback only" }, { status: 403 });
  if (!sameOrigin(request)) return Response.json({ error: "Same origin only" }, { status: 403 });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "wipe") return Response.json({ error: 'Expected { "action": "wipe" }' }, { status: 400 });
  const erased = wipe();
  const record = resetSession(erased);
  return Response.json({ ok: true, wipe: record, egress: egressSnapshot(), heldItems: heldItems() }, { headers: NO_STORE });
}

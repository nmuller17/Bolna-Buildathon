// POST /api/guest/action (guest cookie): every guest action; Help first (GST-2a). Logic: lib/app/routes.ts.
import { guestAction } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return guestAction(req, routeDeps());
}

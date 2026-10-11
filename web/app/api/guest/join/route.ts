// POST /api/guest/join (Mode 0, Host localhost): pairing code -> sb_g cookie (SES-1a, SES-4a). Logic: lib/app/routes.ts.
import { guestJoin } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return guestJoin(req, routeDeps());
}

// POST /api/guest/leave: ends the guest session and expires sb_g, never Clear-Site-Data here (SES-10, SES-12). Logic: lib/app/routes.ts.
import { guestLeave } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return guestLeave(req, routeDeps());
}

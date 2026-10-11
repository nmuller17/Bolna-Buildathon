// POST /api/staff/claim: one-time staff capability -> sb_staff cookie (docs/app-plan.md 9.6, SRV-10). Logic: lib/app/routes.ts.
import { staffClaim } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return staffClaim(req, routeDeps());
}

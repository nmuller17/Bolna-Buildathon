// POST /api/staff/action (staff cookie): every receptionist action (docs/app-plan.md 8). Logic: lib/app/routes.ts.
import { staffAction } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return staffAction(req, routeDeps());
}

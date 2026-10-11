// GET /api/events?role=staff|guest: the server-sent-events bus (docs/app-plan.md 7, SES-7). Logic: lib/app/routes.ts.
import { events } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return events(req, routeDeps());
}

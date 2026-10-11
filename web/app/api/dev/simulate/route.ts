// POST /api/dev/simulate (staff cookie, SB_SIMULATE=1): rehearsal events, labelled SIMULATED (BRG-6). Logic: lib/app/routes.ts.
import { simulate } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return simulate(req, routeDeps());
}

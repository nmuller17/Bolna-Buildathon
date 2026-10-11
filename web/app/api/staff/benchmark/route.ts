// GET /api/staff/benchmark (staff cookie): audited figures only (DSH-6). Logic: lib/app/routes.ts.
import { staffBenchmark } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return staffBenchmark(req, routeDeps());
}

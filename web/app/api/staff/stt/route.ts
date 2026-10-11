// POST /api/staff/stt (staff cookie): live captions on this laptop (docs/features-plan.md F3). Raw PCM
// from the staff microphone is forwarded to web/stt/local_stt.py on 127.0.0.1. Logic: lib/app/routes.ts.
import { staffStt } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return staffStt(req, routeDeps());
}

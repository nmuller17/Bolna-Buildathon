// POST and GET /api/guest/signs: the recognizer bridge (loopback, X-Bridge-Key; BRG-1 to BRG-9). Logic: lib/app/routes.ts.
import { bridgeGet, bridgePost } from "@/lib/app/routes";
import { routeDeps } from "@/lib/app/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return bridgePost(req, routeDeps());
}

export function GET(req: Request) {
  return bridgeGet(req, routeDeps());
}

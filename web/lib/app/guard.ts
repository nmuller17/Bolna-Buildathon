// SignBridge route guard (red-team fixes B1, B3, B4, D1, D2): defence in depth inside each route
// handler, on top of web/server.mjs.
//
// web/server.mjs decides "loopback" from the TCP socket and passes it on as x-sb-loopback, with
// x-sb-proof = SB_PROOF, a random secret it creates at start-up (any client-sent x-sb-* header is
// deleted first). A route trusts x-sb-loopback only when the proof matches. When the app is
// started with plain `next dev` / `next start` (which bind every interface), SB_PROOF is absent
// and every loopback-only route fails closed with 403.
import {
  crossSiteReason,
  hostAllowed,
  isJsonContentType,
  RateLimiter,
  readCappedText,
  safeEqual,
} from "./access";

type GuardOk = { ok: true; body: unknown };
type GuardFail = { ok: false; res: Response };

const NO_STORE = { "Cache-Control": "no-store" };

const fail = (status: number, error: string): GuardFail => ({
  ok: false,
  res: Response.json({ error }, { status, headers: NO_STORE }),
});

// One limiter per route, kept across dev hot reloads.
const LIMITERS_KEY = Symbol.for("signbridge.ratelimiters.v1");
type LimiterStore = Map<string, RateLimiter>;
function limiterFor(route: string, perMinute: number): RateLimiter {
  const g = globalThis as unknown as Record<symbol, LimiterStore | undefined>;
  const store = (g[LIMITERS_KEY] ??= new Map());
  let lim = store.get(route);
  if (!lim) {
    lim = new RateLimiter(perMinute, 60_000);
    store.set(route, lim);
  }
  return lim;
}

/** True when web/server.mjs vouched that this request came from the laptop itself. */
export function fromLoopback(req: Request): boolean {
  const proof = process.env.SB_PROOF;
  if (!proof) return false; // plain `next dev`: fail closed
  return (
    safeEqual(req.headers.get("x-sb-proof") ?? "", proof) && req.headers.get("x-sb-loopback") === "1"
  );
}

/**
 * For loopback-only JSON POST routes. In order: loopback proof (403), Host allowlist (403),
 * same-origin (403), application/json (415), body cap (413), rate limit (429), JSON parse (400).
 */
export async function guardLoopbackJsonPost(
  req: Request,
  opts: { route: string; maxBytes: number; perMinute: number },
): Promise<GuardOk | GuardFail> {
  if (!fromLoopback(req)) {
    return fail(403, "only the front-desk laptop may call this (start the app with `npm run dev`, which runs web/server.mjs)");
  }
  const host = req.headers.get("host");
  const allowed = (process.env.SB_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);
  if (!hostAllowed(host, allowed)) return fail(403, "host not allowed");
  const why = crossSiteReason(req.headers.get("origin"), req.headers.get("sec-fetch-site"), host);
  if (why) return fail(403, why);
  if (!isJsonContentType(req.headers.get("content-type"))) return fail(415, "Content-Type must be application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > opts.maxBytes) return fail(413, "request body too large");
  if (!limiterFor(opts.route, opts.perMinute).take()) return fail(429, "too many requests, retry in a minute");
  const read = await readCappedText(req.body, opts.maxBytes);
  if (!read.ok) return fail(413, "request body too large");
  try {
    return { ok: true, body: JSON.parse(read.text) };
  } catch {
    return fail(400, "Invalid JSON");
  }
}

/**
 * For loopback-only routes whose body is not JSON (multipart audio for /api/transcribe). Same order
 * as guardLoopbackJsonPost, but the body is left unread for the caller. Because the caller parses it
 * with request.formData(), which has no size cap of its own, a Content-Length header is REQUIRED
 * (411 without it): Node's HTTP parser then never delivers more bytes than declared, and both
 * web/server.mjs and this guard refuse a declared size above maxBytes.
 */
export function guardLoopbackRawPost(
  req: Request,
  opts: { route: string; maxBytes: number; perMinute: number; contentType: RegExp },
): { ok: true } | GuardFail {
  if (!fromLoopback(req)) {
    return fail(403, "only the front-desk laptop may call this (start the app with `npm run dev`, which runs web/server.mjs)");
  }
  const host = req.headers.get("host");
  const allowed = (process.env.SB_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);
  if (!hostAllowed(host, allowed)) return fail(403, "host not allowed");
  const why = crossSiteReason(req.headers.get("origin"), req.headers.get("sec-fetch-site"), host);
  if (why) return fail(403, why);
  if (!opts.contentType.test(req.headers.get("content-type") ?? "")) return fail(415, "unsupported Content-Type");
  const raw = req.headers.get("content-length");
  if (raw === null) return fail(411, "Content-Length required");
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) return fail(400, "bad Content-Length");
  if (declared > opts.maxBytes) return fail(413, "request body too large");
  if (!limiterFor(opts.route, opts.perMinute).take()) return fail(429, "too many requests, retry in a minute");
  return { ok: true };
}

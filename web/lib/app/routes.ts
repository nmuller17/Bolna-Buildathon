// SignBridge app (P4, builder A): the Tier 0 route handlers (docs/app-plan.md 8, 9.6; SRV-4a, SRV-8a,
// SRV-10, SRV-11, SES-1a, SES-4a, SES-7, SES-13, BRG-1, BRG-4, BRG-6, GST-2a, GST-7a).
//
// Each app/api/**/route.ts file is a one-line wrapper around a handler here, so the handlers can be
// driven with plain Request objects by node --test (routes.test.ts) without a server.
//
// Listener rules on the staff listener (the only listener in Tier 0, Mode 0):
// - web/server.mjs vouches for loopback with x-sb-loopback and the per-start proof x-sb-proof;
// - staff routes answer only on Host 127.0.0.1:PORT with Origin http://127.0.0.1:PORT and need the
//   staff cookie `sb_staff` (loopback alone is never authentication, D6);
// - Mode 0 guest routes answer only on Host localhost:PORT with Origin http://localhost:PORT and use
//   the cookie `sb_g` (HttpOnly, SameSite=Strict, Path=/; only its SHA-256 is kept). The two hosts are
//   different cookie sites, so the guest window never holds the staff cookie (C1-3);
// - the recognizer bridge answers on loopback with X-Bridge-Key only (constant time, 503 when unset);
// - this listener NEVER sends Clear-Site-Data (it would delete the staff cookie, C1-3).
// Every response has Cache-Control: no-store. Nothing here logs: no URL, code, token, name or text.
import { createHash } from "node:crypto";
import { isJsonContentType, safeEqual } from "./access.ts";
import { benchmarkFromReport } from "./benchmark.ts";
import { accepting, ingestBridge } from "./ingest.ts";
import { STAFF_COOKIE, readCookie, type ClaimResult } from "./staffcap.ts";
import type { Store } from "./store.ts";
import { LIMITS, type Role } from "./types.ts";
import { validateGuestAction, validateStaffAction } from "./validate.ts";

export const GUEST_COOKIE = "sb_g";

export type RouteDeps = {
  store: Store;
  port: number;
  /** SB_PROOF from server.mjs; null under plain `next dev` (then every route fails closed). */
  proof: string | null;
  bridgeKey: string | null;
  simulate: boolean;
  /** Fixed-window limiter by name; true when the call is allowed. */
  limit: (name: string, max: number, windowMs: number) => boolean;
  staff: { isToken: (t: string | null) => boolean; claim: (k: unknown) => ClaimResult };
  /** Reads BENCHMARK_CLEARED_FILE (parsed JSON) or null. */
  readBenchmark: () => unknown;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...NO_STORE, ...headers } });
}

const CODE_FOR: Record<number, string> = {
  400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 410: "gone",
  413: "too_large", 415: "unsupported_type", 429: "rate_limited", 503: "not_configured",
};
export const apiError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json(status, { ok: false, error: CODE_FOR[status] ?? "bad_request", message }, headers);

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

const COOKIE_ATTRS = "HttpOnly; SameSite=Strict; Path=/";
export const setCookie = (name: string, value: string) => `${name}=${value}; ${COOKIE_ATTRS}`;
export const expireCookie = (name: string) => `${name}=; ${COOKIE_ATTRS}; Max-Age=0`;

const cookie = (req: Request, name: string) => readCookie(req.headers.get("cookie"), name);
const uaHash = (req: Request) => createHash("sha256").update(req.headers.get("user-agent") ?? "").digest("hex");

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

const staffHost = (d: RouteDeps) => `127.0.0.1:${d.port}`;
const guestHost = (d: RouteDeps) => `localhost:${d.port}`;

export function fromLoopback(req: Request, d: RouteDeps): boolean {
  return !!d.proof && safeEqual(req.headers.get("x-sb-proof") ?? "", d.proof) && req.headers.get("x-sb-loopback") === "1";
}

const hostIs = (req: Request, host: string) => (req.headers.get("host") ?? "").trim().toLowerCase() === host;

/** Same-origin check for one expected origin: a browser's Sec-Fetch-Site, and Origin when sent. */
function originOk(req: Request, origin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const o = req.headers.get("origin");
  return o === null || o.toLowerCase() === origin;
}

type Body = { ok: true; body: unknown } | { ok: false; res: Response };

/** Content type (415), declared and real size (413), JSON (400). An empty body parses as {} when allowed. */
async function readJson(req: Request, maxBytes: number, opts: { allowEmpty?: boolean; anyType?: boolean } = {}): Promise<Body> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, res: apiError(413, "Request body too large.") };
  const text = await readCapped(req, maxBytes);
  if (text === null) return { ok: false, res: apiError(413, "Request body too large.") };
  if (text.trim() === "" && opts.allowEmpty) return { ok: true, body: {} };
  if (!opts.anyType && !isJsonContentType(req.headers.get("content-type"))) return { ok: false, res: apiError(415, "Content-Type must be application/json.") };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: apiError(400, "Invalid JSON.") };
  }
}

async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(seen);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const notLoopback = () => apiError(403, "Only the front-desk laptop may call this.");

/** Loopback, Host 127.0.0.1:PORT, same origin, then the staff cookie (401). Null when the caller may proceed. */
function staffCheck(req: Request, d: RouteDeps, opts: { cookie: boolean } = { cookie: true }): Response | null {
  if (!fromLoopback(req, d)) return notLoopback();
  if (!hostIs(req, staffHost(d))) return apiError(403, `Staff functions answer only on http://${staffHost(d)}.`);
  if (!originOk(req, `http://${staffHost(d)}`)) return apiError(403, "Cross-origin request refused.");
  if (opts.cookie && !d.staff.isToken(cookie(req, STAFF_COOKIE))) return apiError(401, "Open the one-time staff link printed by the server first.");
  return null;
}

/** Loopback (Mode 0: the guest window runs on this laptop), Host localhost:PORT, same origin. */
function guestCheck(req: Request, d: RouteDeps, opts: { origin: boolean } = { origin: true }): Response | null {
  if (!fromLoopback(req, d)) return notLoopback();
  if (!hostIs(req, guestHost(d))) return apiError(403, `The guest window answers only on http://${guestHost(d)}.`);
  if (opts.origin && !originOk(req, `http://${guestHost(d)}`)) return apiError(403, "Cross-origin request refused.");
  return null;
}

/* ------------------------------------------------------------------ */
/* Staff                                                               */
/* ------------------------------------------------------------------ */

/** POST /api/staff/claim {k}: exchanges the one-time #k= capability for the staff cookie (SRV-10). */
export async function staffClaim(req: Request, d: RouteDeps): Promise<Response> {
  const bad = staffCheck(req, d, { cookie: false });
  if (bad) return bad;
  if (!d.limit("staff_claim", 10, 60_000)) return apiError(429, "Too many attempts. Wait a minute.");
  const b = await readJson(req, 1024);
  if (!b.ok) return b.res;
  const k = (b.body as { k?: unknown } | null)?.k;
  const r = d.staff.claim(k);
  if (!r.ok) return r.status === 410 ? apiError(410, "This staff link was already used. Send SIGUSR2 to the server for a new one.") : apiError(403, "This staff link is not valid.");
  return json(200, { ok: true }, { "Set-Cookie": setCookie(STAFF_COOKIE, r.token) });
}

/** POST /api/staff/action (staff cookie, 4 KB, 120 a minute). */
export async function staffAction(req: Request, d: RouteDeps): Promise<Response> {
  const bad = staffCheck(req, d);
  if (bad) return bad;
  const b = await readJson(req, LIMITS.bodySmallJson);
  if (!b.ok) return b.res;
  if (!d.limit("staff_action", 120, 60_000)) return apiError(429, "Too many requests. Wait a moment.");
  const v = validateStaffAction(b.body);
  if (!v.ok) return json(400, { ok: false, error: "bad_request", message: v.message, ...(v.field ? { field: v.field } : {}) });
  const r = d.store.staffAction(v.value);
  return json(r.status, r.body);
}

/** GET /api/staff/benchmark: "not yet audited" unless a cleared report file says otherwise (DSH-6). */
export function staffBenchmark(req: Request, d: RouteDeps): Response {
  const bad = staffCheck(req, d);
  if (bad) return bad;
  let raw: unknown = null;
  try {
    raw = d.readBenchmark();
  } catch {
    raw = null;
  }
  return json(200, benchmarkFromReport(raw) as unknown as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */
/* Event streams                                                       */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};
/** A stream whose reader stopped reading is dropped once this many chunks are queued. */
const MAX_QUEUED = 500;

/** GET /api/events?role=staff|guest (SES-7, SRV-19): retry, hello and snapshot, then live events and pings. */
export function events(req: Request, d: RouteDeps): Response {
  const role = new URL(req.url).searchParams.get("role") as Role | null;
  if (role !== "staff" && role !== "guest") return apiError(400, "role must be staff or guest.");
  let token: string | null = null;
  let ua = "";
  if (role === "staff") {
    const bad = staffCheck(req, d);
    if (bad) return bad;
  } else {
    // An EventSource or fetch GET may omit Origin; Sec-Fetch-Site still guards it.
    const bad = guestCheck(req, d);
    if (bad) return bad;
    token = cookie(req, GUEST_COOKIE);
    ua = uaHash(req);
    if (!d.store.guestSessionFor(token, ua)) {
      return apiError(401, "Ask the front desk to connect this screen.", token ? { "Set-Cookie": expireCookie(GUEST_COOKIE) } : {});
    }
  }
  const store = d.store;
  let id: number | null = null;
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (id !== null) store.closeStream(id);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): boolean => {
        if (closed) return false;
        if (controller.desiredSize !== null && controller.desiredSize < -MAX_QUEUED) return false;
        try {
          controller.enqueue(enc.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const close = () => {
        const was = closed;
        closed = true;
        if (!was) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };
      controller.enqueue(enc.encode(`retry: ${LIMITS.sseRetryMs}\n\n`));
      id = role === "staff" ? store.openStaffStream(send, close) : store.openGuestStream(token, send, close, ua);
      if (id === null) close();
    },
    cancel() {
      stop();
    },
  });
  req.signal?.addEventListener("abort", stop, { once: true });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/* ------------------------------------------------------------------ */
/* Guest (Mode 0, Host localhost)                                      */
/* ------------------------------------------------------------------ */

/** POST /api/guest/join {code}: the code from the #p= fragment; sets sb_g (never in the body). */
export async function guestJoin(req: Request, d: RouteDeps): Promise<Response> {
  const bad = guestCheck(req, d);
  if (bad) return bad;
  const b = await readJson(req, LIMITS.bodySmallJson);
  if (!b.ok) return b.res;
  const body = b.body as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== "code")) {
    return apiError(400, "This link is not complete. Ask the front desk to connect this screen.");
  }
  const r = d.store.join(body.code, "this laptop", uaHash(req));
  const headers: Record<string, string> = {};
  if (typeof r.guestCookie === "string") headers["Set-Cookie"] = setCookie(GUEST_COOKIE, r.guestCookie);
  return json(r.status, r.body, headers);
}

/**
 * POST /api/guest/action. `emergency` is dispatched before the content-type, origin, nonce, limiter and
 * state checks and is never refused with 409 or 429 (C1-15, GST-2a). It still needs the guest cookie,
 * which is SameSite=Strict, so a cross-site page cannot raise it.
 */
export async function guestAction(req: Request, d: RouteDeps): Promise<Response> {
  const bad = guestCheck(req, d, { origin: false });
  if (bad) return bad;
  const b = await readJson(req, LIMITS.bodySmallJson, { anyType: true });
  if (!b.ok) return b.res;
  const token = cookie(req, GUEST_COOKIE);
  const ua = uaHash(req);
  if (typeof b.body === "object" && b.body !== null && (b.body as { type?: unknown }).type === "emergency") {
    const r = d.store.emergency(token, ua);
    return json(r.status, r.body);
  }
  if (!originOk(req, `http://${guestHost(d)}`)) return apiError(403, "Cross-origin request refused.");
  if (!isJsonContentType(req.headers.get("content-type"))) return apiError(415, "Content-Type must be application/json.");
  const v = validateGuestAction(b.body);
  if (!v.ok) return json(400, { ok: false, error: "bad_request", message: v.message, ...(v.field ? { field: v.field } : {}) });
  const r = d.store.guestAction(token, v.value, ua);
  return json(r.status, r.body, r.status === 401 && token ? { "Set-Cookie": expireCookie(GUEST_COOKIE) } : {});
}

/** POST /api/guest/leave: "I'm finished", or the page after session_end. Expires sb_g; never Clear-Site-Data here. */
export async function guestLeave(req: Request, d: RouteDeps): Promise<Response> {
  const bad = guestCheck(req, d);
  if (bad) return bad;
  if (!d.limit("guest_leave", 10, 60_000)) return apiError(429, "Please wait a moment.");
  const b = await readJson(req, 1024, { allowEmpty: true });
  if (!b.ok) return b.res;
  const r = d.store.leave(cookie(req, GUEST_COOKIE), uaHash(req));
  return json(r.status, r.body, { "Set-Cookie": expireCookie(GUEST_COOKIE) });
}

/* ------------------------------------------------------------------ */
/* Recognizer bridge and simulator                                     */
/* ------------------------------------------------------------------ */

/** Loopback, a loopback Host, not cross-site, BRIDGE_KEY set (503) and matched (401). */
function bridgeCheck(req: Request, d: RouteDeps): Response | null {
  if (!fromLoopback(req, d)) return notLoopback();
  if (!hostIs(req, staffHost(d)) && !hostIs(req, guestHost(d))) return apiError(403, "Host not allowed.");
  const site = req.headers.get("sec-fetch-site");
  if ((site && site !== "same-origin" && site !== "none") || req.headers.get("origin") !== null) return apiError(403, "The recognizer bridge is not for browsers.");
  if (!d.bridgeKey || d.bridgeKey.length < LIMITS.bridgeKeyMinLen) return apiError(503, `BRIDGE_KEY is not set (at least ${LIMITS.bridgeKeyMinLen} characters).`);
  if (!safeEqual(req.headers.get("x-bridge-key") ?? "", d.bridgeKey)) {
    d.store.noteBridgeKeyFailure();
    return apiError(401, "Wrong or missing X-Bridge-Key.");
  }
  return null;
}

/** POST /api/guest/signs: the recognizer bridge (BRG-1 to BRG-9). 8 KB, 10 a second. */
export async function bridgePost(req: Request, d: RouteDeps): Promise<Response> {
  const bad = bridgeCheck(req, d);
  if (bad) return bad;
  if (!d.limit("bridge", LIMITS.bridgePerSecond, 1_000)) return apiError(429, "Too many events.");
  const b = await readJson(req, LIMITS.bodyBridgeJson);
  if (!b.ok) return b.res;
  const r = ingestBridge(d.store, b.body, "recognizer");
  return json(r.status, r.body);
}

/** GET /api/guest/signs: {accepting} so the recognizer may switch the camera off when nobody signs. */
export function bridgeGet(req: Request, d: RouteDeps): Response {
  const bad = bridgeCheck(req, d);
  if (bad) return bad;
  if (!d.limit("bridge_get", LIMITS.bridgePerSecond, 1_000)) return apiError(429, "Too many requests.");
  return json(200, { ok: true, accepting: accepting(d.store) });
}

/** POST /api/dev/simulate: the same events through the same ingest, marked SIMULATED (BRG-6). 404 unless SB_SIMULATE=1. */
export async function simulate(req: Request, d: RouteDeps): Promise<Response> {
  if (!d.simulate) return apiError(404, "The simulator is switched off.");
  const bad = staffCheck(req, d);
  if (bad) return bad;
  if (!d.limit("simulate", LIMITS.bridgePerSecond, 1_000)) return apiError(429, "Too many events.");
  const b = await readJson(req, LIMITS.bodyBridgeJson);
  if (!b.ok) return b.res;
  const r = ingestBridge(d.store, b.body, "simulated");
  return json(r.status, r.body);
}

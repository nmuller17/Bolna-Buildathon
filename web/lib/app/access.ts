// SignBridge app shell: pure access-control helpers (red-team fixes B1, B3, B4, B5, B7, D1, D2).
//
// Used by web/server.mjs (plain Node, through type stripping), by the route guard
// (web/lib/app/guard.ts) and by the node:test files in web/security-tests/.
// Rules: erasable TypeScript only and NO imports, so Node can run this file directly.
// The plan these implement is docs/app-plan.md sections 9 and 10 and "Red-team requirements".

/** Body caps in bytes (docs/app-plan.md section 7). */
export const BODY_CAP_DEFAULT = 8 * 1024;
export const BODY_CAP_AUDIO = 5 * 1024 * 1024;
/** POST /api/staff/stt: raw 16 kHz s16le PCM (FEATURE_LIMITS.sttBodyMaxBytes in types.ts; no imports here). */
export const BODY_CAP_STT = 960_000;

/**
 * True only for a socket address on this machine: 127.0.0.0/8, ::1, or IPv4-mapped ::ffff:127.x.
 * The address must come from the TCP socket (req.socket.remoteAddress), never from a header.
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/** Host header values the app answers to: loopback names on our port, plus the LAN address in GUEST_LAN mode. */
export function allowedHostsFor(port: number, lanIp?: string | null): string[] {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  if (lanIp) hosts.push(`${lanIp}:${port}`);
  return hosts;
}

/** Exact, case-insensitive Host allowlist check. Blocks DNS rebinding (attacker.example -> our IP). */
export function hostAllowed(host: string | undefined | null, allowed: readonly string[]): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return allowed.some((a) => a.toLowerCase() === h);
}

/**
 * Paths a NON-loopback client (the guest device on the LAN) may reach. Default deny.
 * Anything with an encoded character, a backslash, "..", or "//" is refused before matching,
 * so "/%2e%2e/staff" or "/guest/../staff" can never slip through.
 */
export function lanPathAllowed(method: string, rawUrl: string, dev: boolean): boolean {
  const pathname = (rawUrl || "").split("?")[0];
  if (!pathname.startsWith("/") || /%|\\|\/\/|(^|\/)\.\.?(\/|$)/.test(pathname)) return false;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    if (pathname === "/guest" || pathname === "/guest/" || pathname === "/favicon.ico") return true;
    if (pathname === "/api/events") return true;
    if (pathname.startsWith("/_next/static/")) return true;
    if (/^\/signs\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\.json$/.test(pathname)) return true; // avatar data (signer stripped)
    if (/^\/avatar\/[A-Za-z0-9_-]+\.glb$/.test(pathname)) return true; // avatar 3D model (web/public/avatar, P2 bellhop)
    if (dev && pathname.startsWith("/_next/")) return true; // dev HMR and chunks only
    return false;
  }
  if (m === "POST") return pathname === "/api/guest/join" || pathname === "/api/guest/action";
  return false;
}

/**
 * Same-origin check for state-changing requests (CSRF from a page open in the staff browser).
 * Returns a reason string when the request must be refused, or null when it may proceed.
 * A browser always sends Sec-Fetch-Site; non-browser clients are covered by the loopback rule.
 */
export function crossSiteReason(origin: string | null, secFetchSite: string | null, host: string | null): string | null {
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return "cross-site request";
  if (origin !== null) {
    if (!host) return "missing host";
    const h = host.toLowerCase();
    const o = origin.toLowerCase();
    if (o !== `http://${h}` && o !== `https://${h}`) return "cross-origin request";
  }
  return null;
}

/** application/json, optionally with parameters. text/plain (a CORS "simple" type) is refused. */
export function isJsonContentType(ct: string | null | undefined): boolean {
  return !!ct && /^application\/json\s*(;.*)?$/i.test(ct.trim());
}

/** Constant-time string compare (false on different lengths, never throws). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Reads a request body stream but stops as soon as it passes maxBytes (works for chunked bodies
 * that carry no Content-Length). Never buffers more than maxBytes + one chunk.
 */
export async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(seen);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** Fixed-window counter with an injectable clock. */
export class RateLimiter {
  limit: number;
  windowMs: number;
  now: () => number;
  start = 0;
  count = 0;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** True when this call is allowed; false when the window's budget is used up. */
  take(): boolean {
    const t = this.now();
    if (t - this.start >= this.windowMs) {
      this.start = t;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }
}

/**
 * Text that may be spoken or shown: NFC, control and format characters removed, whitespace
 * collapsed, at most maxLen code points, and only letters, digits, spaces and plain sentence
 * punctuation (no markup, braces or backticks). Returns null when the text does not qualify.
 */
export function cleanSentence(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || [...s].length > maxLen) return null;
  if (!/^[\p{L}\p{M}\p{N} ,.'’?!\-:;()"]+$/u.test(s)) return null;
  return s;
}

/** Security headers for every response (docs/app-plan.md section 10, row 22). No HSTS: the app has no HTTPS yet. */
export function securityHeaders(dev: boolean, pathname = "/"): Record<string, string> {
  const script = dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";
  const guest = pathname === "/guest" || pathname.startsWith("/guest/");
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      script,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      // blob: lets P2's GLTF loader read the textures embedded in the avatar model (same-origin blobs only).
      "connect-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": guest
      ? "camera=(), geolocation=(), microphone=()"
      : "camera=(), geolocation=(), microphone=(self)",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

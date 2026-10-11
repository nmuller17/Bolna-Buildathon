// SignBridge: pure access-control helpers (red-team fixes B1, B3, B4, B5, B7, D1, D2).
//
// Used by web/server.mjs (plain Node, through type stripping), by the route guard
// (web/lib/app/guard.ts) and by the node:test files in web/security-tests/.
// Rules: erasable TypeScript only and NO imports, so Node can run this file directly.
// What each one blocks is listed in docs/requests.md "Security hardening of the app".

/** Body caps in bytes, enforced by web/server.mjs before Next reads anything. */
export const BODY_CAP_DEFAULT = 8 * 1024;
export const BODY_CAP_AUDIO = 5 * 1024 * 1024;

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

/** Host header values the app answers to: the loopback names on our port. */
export function allowedHostsFor(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

/** Exact, case-insensitive Host allowlist check. Blocks DNS rebinding (attacker.example -> our IP). */
export function hostAllowed(host: string | undefined | null, allowed: readonly string[]): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return allowed.some((a) => a.toLowerCase() === h);
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

/**
 * Security headers for every response. No HSTS: the app has no HTTPS yet.
 * The CSP allows what the app itself uses: blob: scripts for the microphone AudioWorklet
 * (components/voiceListener.ts), blob: fetches and images for the avatar's GLB textures (three.js
 * GLTFLoader), blob: audio for /api/tts playback. Microphone (hands-free listening on /guest,
 * push-to-talk on /staff) and camera (the planned guest camera box) are allowed for this origin only.
 */
export function securityHeaders(dev: boolean): Record<string, string> {
  const script = dev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
    : "script-src 'self' 'unsafe-inline' blob:";
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      script,
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self' blob: data:",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

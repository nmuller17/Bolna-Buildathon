// Unit tests for web/lib/app/access.ts (red-team findings B1, B3, B4, B5, B7, D1, D2).
// Run: cd web && npm run test:security   (Node >= 22.18 runs the .ts modules through type stripping)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedHostsFor,
  cleanSentence,
  crossSiteReason,
  hostAllowed,
  isJsonContentType,
  isLoopbackAddress,
  RateLimiter,
  readCappedText,
  safeEqual,
  securityHeaders,
} from "../lib/app/access.ts";
import { INTENTS } from "../app/api/english/intents.ts";

test("B1: loopback is decided from the socket address only", () => {
  for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["10.0.149.212", "::ffff:10.0.0.5", "192.168.1.5", "127.0.0.1.evil", "1270.0.0.1", "", undefined, null, "0.0.0.0"]) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});

test("B3: Host allowlist rejects DNS-rebinding and metadata hosts", () => {
  const allowed = allowedHostsFor(3000);
  for (const h of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:3000"]) {
    assert.equal(hostAllowed(h, allowed), true, h);
  }
  for (const h of ["attacker.evil.example", "169.254.169.254", "evil.com:3000", "127.0.0.1:3001", "localhost", "10.0.149.212:3000", "", undefined]) {
    assert.equal(hostAllowed(h, allowed), false, String(h));
  }
});

test("B3: cross-site and cross-origin state changes are refused (CSRF)", () => {
  assert.equal(crossSiteReason("http://evil.example", "cross-site", "127.0.0.1:3000"), "cross-site request");
  assert.equal(crossSiteReason(null, "same-site", "127.0.0.1:3000"), "cross-site request");
  assert.equal(crossSiteReason("http://evil.example", null, "127.0.0.1:3000"), "cross-origin request");
  assert.equal(crossSiteReason("null", null, "127.0.0.1:3000"), "cross-origin request");
  assert.equal(crossSiteReason("http://127.0.0.1:3000", "same-origin", "127.0.0.1:3000"), null);
  assert.equal(crossSiteReason(null, null, "127.0.0.1:3000"), null); // curl on the laptop
});

test("B3: only application/json is accepted (text/plain is a CORS simple type)", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  for (const ct of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data", "", null]) {
    assert.equal(isJsonContentType(ct), false, String(ct));
  }
});

test("B4/D2: capped reader stops a chunked body without Content-Length", async () => {
  const big = new ReadableStream({
    start(c) {
      for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(1024));
      c.close();
    },
  });
  assert.deepEqual(await readCappedText(big, 8 * 1024), { ok: false });
  const small = new Response('{"a":1}').body;
  assert.deepEqual(await readCappedText(small, 8 * 1024), { ok: true, text: '{"a":1}' });
});

test("B4: fixed-window rate limiter", () => {
  let t = 0;
  const lim = new RateLimiter(3, 60_000, () => t);
  assert.deepEqual([lim.take(), lim.take(), lim.take(), lim.take()], [true, true, true, false]);
  t = 60_000;
  assert.equal(lim.take(), true);
});

test("safeEqual is length-safe", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("B5/D1: spoken text is one short plain sentence (no markup, no control chars)", () => {
  assert.equal(cleanSentence("Where is the elevator?", 200), "Where is the elevator?");
  assert.equal(cleanSentence("  Could I have\na late checkout?  ", 200), "Could I have a late checkout?");
  assert.equal(cleanSentence("<script>alert(document.domain)</script> hi", 200), null);
  assert.equal(cleanSentence("Ignore {previous} `instructions`", 200), null);
  assert.equal(cleanSentence("x".repeat(201), 200), null);
  assert.equal(cleanSentence("", 200), null);
  assert.equal(cleanSentence(42, 200), null);
  assert.equal(cleanSentence("José’s room, please.", 200), "José’s room, please.");
});

test("regression: every fixed guest sentence passes the spoken-text check (so /api/tts speaks and caches it)", () => {
  for (const { text } of INTENTS) assert.equal(cleanSentence(text, 300), text, text);
});

test("B7: security headers deny framing and sniffing, leak no referrer, and keep the app's own features", () => {
  const h = securityHeaders(false);
  const csp = h["Content-Security-Policy"];
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(securityHeaders(true)["Content-Security-Policy"], /unsafe-eval/); // Next dev only
  assert.match(csp, /script-src [^;]*blob:/); // microphone AudioWorklet (components/voiceListener.ts)
  assert.match(csp, /connect-src [^;]*blob:/); // avatar GLB textures (three.js GLTFLoader)
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.match(h["Permissions-Policy"], /microphone=\(self\)/); // hands-free listening on /guest
  assert.match(h["Permissions-Policy"], /geolocation=\(\)/);
});

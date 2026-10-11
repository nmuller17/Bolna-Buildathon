// SignBridge app (P4, builder A): the staff capability (docs/app-plan.md 9.6, SRV-10; decision record D6).
//
// Loopback alone is never authentication, because every local process shares it. At start, web/server.mjs
// calls issueCapability() and prints the one-time URL http://127.0.0.1:PORT/staff#k=<k> to its own
// terminal (never projected). The staff page posts k to /api/staff/claim, which exchanges it ONCE for a
// random staff token in the HttpOnly SameSite=Strict cookie `sb_staff`. Every staff route, the staff
// stream, the simulator and (through guard.ts) the P1 and Nath routes then need that cookie.
// SIGUSR2 makes server.mjs issue a new one-time capability; claiming it replaces the old staff cookie.
//
// The state lives on globalThis, because server.mjs (plain Node, type stripping) and the route handlers
// (Next bundles, one copy of this module per route chunk) run in one process and must share it.
// Only SHA-256 hashes are kept; the capability and the token are never stored or logged in clear.
// Erasable TypeScript only, so server.mjs can import this file directly.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const STAFF_COOKIE = "sb_staff";
const KEY = Symbol.for("signbridge.staffcap.v1");

type CapState = {
  /** Hash of the one-time capability still waiting to be claimed, or null once claimed. */
  capHash: Buffer | null;
  /** Hash of the current staff token (one browser at a time; a new claim replaces it). */
  tokenHash: Buffer | null;
  issuedAt: number;
  claims: number;
};

function state(): CapState {
  const g = globalThis as unknown as Record<symbol, CapState | undefined>;
  return (g[KEY] ??= { capHash: null, tokenHash: null, issuedAt: 0, claims: 0 });
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const same = (a: Buffer | null, b: Buffer): boolean => a !== null && a.length === b.length && timingSafeEqual(a, b);
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** Creates a new one-time capability (start-up and SIGUSR2). Returns it once, for the printed URL only. */
export function issueCapability(now: number = Date.now()): string {
  const k = randomBytes(32).toString("base64url");
  const s = state();
  s.capHash = sha256(k);
  s.issuedAt = now;
  return k;
}

export type ClaimResult = { ok: true; token: string } | { ok: false; status: 403 | 410; reason: "wrong_key" | "already_claimed" };

/** Exchanges the one-time capability for a staff token. 410 once claimed (until SIGUSR2), 403 for a wrong key. */
export function claimCapability(k: unknown): ClaimResult {
  const s = state();
  if (s.capHash === null) return { ok: false, status: 410, reason: "already_claimed" };
  if (typeof k !== "string" || !TOKEN_RE.test(k) || !same(s.capHash, sha256(k))) return { ok: false, status: 403, reason: "wrong_key" };
  const token = randomBytes(32).toString("base64url");
  s.capHash = null;
  s.tokenHash = sha256(token);
  s.claims++;
  return { ok: true, token };
}

/** True when the cookie value is the current staff token (constant time). */
export function isStaffToken(token: string | null | undefined): boolean {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  return same(state().tokenHash, sha256(token));
}

/** For tests only: forget every capability and token. */
export function resetStaffCapability(): void {
  const s = state();
  s.capHash = null;
  s.tokenHash = null;
  s.claims = 0;
}

/** Reads one cookie from a Cookie header (no decoding: our values are base64url). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

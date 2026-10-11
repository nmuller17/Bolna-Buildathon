// P4: counts the requests this app's server process sends off the laptop, for the staff privacy panel (BN-2).
//
// installEgressCounter() wraps the server's global fetch once (from web/instrumentation.ts, before any route
// runs). Every request to a host that is not this laptop (not localhost, 127.x or ::1) is counted under its
// destination host, before it is sent, so a request whose answer fails is still counted. Only the host, a
// count and the time are kept: no path, query, headers or body. The counters live on globalThis so the
// instrumentation bundle and the route bundles share one ledger, like the guest bus.
//
// Limits, shown on the panel: this sees fetch() in the Next.js server only. It does not see what the
// browsers do (for example the browser's own speech recognition), and it would not see a raw socket or a
// child process. Today the server reaches the network only through fetch (/api/english, /api/tts,
// /api/transcribe); Piper is a local child process.
//
// Erasable TypeScript only, no imports: the tests run this file directly with Node.

export type EgressEntry = { destination: string; calls: number; firstAt: number; lastAt: number };

export type WipeRecord = { at: number; itemsErased: number };

type Ledger = {
  startedAt: number;
  sessionStartedAt: number;
  sinceStart: Map<string, EgressEntry>;
  session: Map<string, EgressEntry>;
  lastWipe: WipeRecord | null;
  /** Fetch owners already wrapped (globalThis in the app). Next.js wraps fetch again on top of ours, so the
   * current globalThis.fetch is not ours any more: this set is what says the counter is running. */
  wrapped: WeakSet<object>;
};

/** What the staff panel receives from GET /api/trust (egress part). */
export type EgressSnapshot = {
  installed: boolean;
  startedAt: number;
  sessionStartedAt: number;
  session: EgressEntry[];
  sinceStart: EgressEntry[];
  lastWipe: WipeRecord | null;
};

const KEY = Symbol.for("signbridge.egress");
const MARK = Symbol.for("signbridge.egress.wrapped");

type FetchFn = typeof fetch;
type Target = { fetch: FetchFn };

export function egressLedger(now: () => number = Date.now): Ledger {
  const g = globalThis as unknown as Record<symbol, Ledger | undefined>;
  return (g[KEY] ??= { startedAt: now(), sessionStartedAt: now(), sinceStart: new Map(), session: new Map(), lastWipe: null, wrapped: new WeakSet() });
}

/** localhost, 127.0.0.0/8, ::1 and IPv4-mapped 127.x: this laptop, not counted. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

/** The destination of a fetch() argument (string, URL or Request), or null when it is not an absolute URL. */
export function destinationOf(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (typeof input === "object" && input !== null && typeof (input as { url?: unknown }).url === "string") {
      return new URL((input as { url: string }).url);
    }
  } catch {
    // relative or malformed: fetch itself will reject it, nothing leaves the laptop
  }
  return null;
}

function bump(map: Map<string, EgressEntry>, destination: string, at: number) {
  const entry = map.get(destination);
  if (entry) {
    entry.calls += 1;
    entry.lastAt = at;
  } else map.set(destination, { destination, calls: 1, firstAt: at, lastAt: at });
}

/** Counts one outbound request. Returns false (and counts nothing) for loopback or non-network URLs. */
export function noteRequest(input: unknown, now: () => number = Date.now): boolean {
  const url = destinationOf(input);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:")) return false;
  if (isLoopbackHost(url.hostname)) return false;
  const ledger = egressLedger(now);
  const at = now();
  bump(ledger.sinceStart, url.host, at);
  bump(ledger.session, url.host, at);
  return true;
}

/** Wraps target.fetch (globalThis by default) once; later calls are no-ops (dev hot reload, a second register). */
export function installEgressCounter(target: Target = globalThis as unknown as Target, now: () => number = Date.now): boolean {
  const current = target.fetch as FetchFn & { [MARK]?: true };
  if (typeof current !== "function") return false;
  const ledger = egressLedger(now);
  if (current[MARK] || ledger.wrapped.has(target)) return true;
  const counted = function (this: unknown, input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) {
    try {
      noteRequest(input, now);
    } catch {
      // counting must never break a request
    }
    return current.call(this, input, init);
  } as FetchFn & { [MARK]?: true };
  counted[MARK] = true;
  target.fetch = counted;
  ledger.wrapped.add(target);
  return true;
}

export function egressInstalled(target: Target = globalThis as unknown as Target): boolean {
  return egressLedger().wrapped.has(target);
}

/** Starts a new session: the session counters go back to zero; the since-start counters are kept. */
export function resetSession(itemsErased: number, now: () => number = Date.now): WipeRecord {
  const ledger = egressLedger(now);
  const record = { at: now(), itemsErased };
  ledger.session.clear();
  ledger.sessionStartedAt = record.at;
  ledger.lastWipe = record;
  return record;
}

const sorted = (map: Map<string, EgressEntry>) => [...map.values()].map((e) => ({ ...e })).sort((a, b) => b.calls - a.calls || a.destination.localeCompare(b.destination));

export function egressSnapshot(target: Target = globalThis as unknown as Target, now: () => number = Date.now): EgressSnapshot {
  const ledger = egressLedger(now);
  return {
    installed: egressInstalled(target),
    startedAt: ledger.startedAt,
    sessionStartedAt: ledger.sessionStartedAt,
    session: sorted(ledger.session),
    sinceStart: sorted(ledger.sinceStart),
    lastWipe: ledger.lastWipe ? { ...ledger.lastWipe } : null,
  };
}

// P4 (builder B): client side of the app's server bus (docs/app-plan.md sections 7 and 14 item 1).
//
// The screens used to sync through BroadcastChannel("signbridge") (CLAUDE.md 6.7). The guest window
// now runs on another origin (Mode 0: localhost vs 127.0.0.1) or another device (Mode C), so both
// screens talk to the server instead: one Server-Sent Events stream in, JSON POSTs out.
//
// The stream is read with fetch() rather than EventSource on purpose:
// - the server pings guest streams with SSE comments (": p") every 2 s, and EventSource hides
//   comments from JavaScript, so a watchdog built on EventSource could never see them;
// - fetch shows the HTTP status, so a 401 (no or dead cookie) can be told apart from a network drop.
// Cookies travel on their own (same-origin fetch); no token is ever put in a URL, a header or storage.
import type { BusEnvelope, GuestAction, Role } from "./app/types";

/**
 * "stale" = the stream is still open but no byte (event or ping) arrived for `staleMs`: the server may
 * be frozen or the network is gone. The next byte turns it back to "open".
 */
export type StreamState = "connecting" | "open" | "stale" | "retrying" | "unauthorized" | "closed";

export type StreamHandlers<M> = {
  onMessage: (env: BusEnvelope<M>) => void;
  onState?: (state: StreamState, httpStatus?: number) => void;
};

export type StreamOptions = {
  /** Reconnect when no byte (event or ping) arrived for this long. Guest 5 s (LIMITS.guestWatchdogMs). */
  watchdogMs: number;
  /** First delay before reconnecting after a drop (the server's `retry:` value wins when it sends one). */
  retryMs?: number;
  /** Longest delay between reconnect tries: each failed try waits 1.5x longer, up to this (default 5 s). */
  maxRetryMs?: number;
  /** Report "stale" when no byte arrived for this long while open (default: never). */
  staleMs?: number;
};

/**
 * Opens GET /api/events?role=<role> and keeps it open: reconnects after drops and after a silent
 * watchdog period, stops for good on 401/403 (the caller shows "Ask the desk to connect this screen").
 * Every (re)connect gets a fresh snapshot from the server, so no replay buffer is needed.
 */
export function openEventStream<M>(role: Role, handlers: StreamHandlers<M>, options: StreamOptions): { close: () => void } {
  let closed = false;
  let controller: AbortController | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = options.retryMs ?? 2_000;
  const maxRetryMs = Math.max(options.maxRetryMs ?? 5_000, retryMs);
  /** Failed tries since the last successful open (resets on open). */
  let failures = 0;
  let stale = false;

  const setState = (s: StreamState, status?: number) => handlers.onState?.(s, status);

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => controller?.abort(), options.watchdogMs);
  };

  /** Called on every byte while open: clears a "stale" report and restarts the stale timer. */
  const armStale = () => {
    if (stale) {
      stale = false;
      setState("open");
    }
    if (!options.staleMs) return;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (closed) return;
      stale = true;
      setState("stale");
    }, options.staleMs);
  };
  const clearStale = () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    stale = false;
  };

  const scheduleRetry = () => {
    if (closed) return;
    setState("retrying");
    // Backoff with jitter: 1x, 1.5x, 2.25x ... of the first delay, capped, so a dead server is not
    // hammered while a short drop still recovers within a couple of seconds.
    const delay = Math.min(maxRetryMs, retryMs * 1.5 ** failures) * (0.8 + Math.random() * 0.4);
    failures++;
    retryTimer = setTimeout(connect, Math.round(delay));
  };

  const handleBlock = (block: string) => {
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue; // comment ping
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "retry" && /^\d+$/.test(value)) retryMs = Math.min(Number(value), 30_000);
    }
    if (data.length === 0) return;
    try {
      handlers.onMessage(JSON.parse(data.join("\n")) as BusEnvelope<M>);
    } catch {
      // A malformed frame is dropped; the next snapshot repairs the screen.
    }
  };

  async function connect() {
    if (closed) return;
    controller = new AbortController();
    setState("connecting");
    armWatchdog();
    try {
      const res = await fetch(`/api/events?role=${role}`, {
        cache: "no-store",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        if (watchdog) clearTimeout(watchdog);
        setState("unauthorized", res.status);
        return;
      }
      if (!res.ok || !res.body) throw new Error(String(res.status));
      failures = 0;
      stale = false;
      setState("open");
      armStale();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog();
        armStale();
        buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          handleBlock(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch {
      // Network drop, abort by the watchdog, or a non-200 that is not an auth failure.
    }
    if (watchdog) clearTimeout(watchdog);
    clearStale();
    scheduleRetry();
  }

  connect();
  return {
    close: () => {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      clearStale();
      controller?.abort();
      setState("closed");
    },
  };
}

/** 16 random bytes as 32 hex characters: the client nonce every guest action carries (plan 9.5). */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type PostResult<T> = { status: number; data: T | null };

/** JSON POST to our own origin. Never throws: a network failure is status 0. */
export async function postJson<T>(url: string, body: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

/** Distributes Omit over a union, so each GuestAction variant keeps its own fields. */
type WithoutNonce<T> = T extends unknown ? Omit<T, "n"> : never;
export type GuestActionBody = WithoutNonce<GuestAction>;

/** POST /api/guest/action with a fresh nonce. */
export function sendGuestAction<T = unknown>(action: GuestActionBody): Promise<PostResult<T>> {
  return postJson<T>("/api/guest/action", { ...action, n: makeNonce() });
}

// SignBridge app (P4, builder A): vendor-call taps for the privacy panel (DSH-5, C1-13).
//
// A tap is recorded where a call to a vendor really happens: in /api/tts when ElevenLabs is actually
// contacted (not on a cache hit), and in web/server.mjs when /api/transcribe answered 200 with an
// OpenAI key configured. The store drains the queue on every sweeper tick, so the privacy counters
// come from real events only. Only the route and a byte count are kept, never content.
// The queue lives on globalThis because server.mjs and every route chunk share one process.
// Erasable TypeScript, no imports, so server.mjs can import it directly.

export type VendorTapRoute = "/api/transcribe" | "/api/tts";
export type VendorTapRecord = { route: VendorTapRoute; bytes: number };

const KEY = Symbol.for("signbridge.vendortaps.v1");
const MAX = 1000;

function queue(): VendorTapRecord[] {
  const g = globalThis as unknown as Record<symbol, VendorTapRecord[] | undefined>;
  return (g[KEY] ??= []);
}

export function recordVendorTap(route: VendorTapRoute, bytes: number): void {
  const q = queue();
  if (q.length >= MAX) q.shift();
  q.push({ route, bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0 });
}

export function drainVendorTaps(): VendorTapRecord[] {
  const q = queue();
  return q.splice(0, q.length);
}

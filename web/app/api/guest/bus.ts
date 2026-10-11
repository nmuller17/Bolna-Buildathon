// P4: in-memory bridge between the recognizer (POST /api/guest/signs) and the open pages (GET /api/guest/stream).
// Kept on globalThis so both routes, and every dev hot reload, share the same one (one Node process on the laptop).
import type { Prediction } from "../english/intents";

/** What the pages receive (one SSE message each). `replay` is set on the snapshot sent when a page (re)connects. */
export type GuestEvent =
  | { type: "sign"; seq: number; top: Prediction[]; at: number; t_sign_end?: number; t_predicted?: number } // t_*: recognizer clock, Unix s (live.py)
  | {
      type: "utterance";
      id: number;
      labels: string[]; // corrected (snapped to a known sentence) or as recognized
      raw: string[]; // as recognized, before the sentence correction
      text: string;
      source: "recognizer" | "english" | "words"; // who wrote the text
      needsRepeat: boolean; // never spoken: the guest is asked to sign again
      mock: boolean; // recognizer in mock mode: never spoken
      at: number;
    }
  | { type: "framing"; status: string; at: number }
  | { type: "recognizer"; state: string; at: number }
  | { type: "wiped"; at: number }; // staff wiped the session (POST /api/trust): pages clear their guest views

type Listener = (event: GuestEvent) => void;

type Bus = {
  listeners: Set<Listener>;
  sentence: GuestEvent[]; // signs of the sentence in progress
  lastUtterance: GuestEvent | null;
  framing: GuestEvent | null;
  recognizer: GuestEvent | null;
  nextId: number;
};

const KEY = Symbol.for("signbridge.guestBus");

export function guestBus(): Bus {
  const g = globalThis as unknown as Record<symbol, Bus | undefined>;
  return (g[KEY] ??= { listeners: new Set(), sentence: [], lastUtterance: null, framing: null, recognizer: null, nextId: 1 });
}

export function publish(event: GuestEvent) {
  const bus = guestBus();
  if (event.type === "sign") {
    if (bus.sentence.length >= 30) bus.sentence.shift();
    bus.sentence.push(event);
  } else if (event.type === "utterance") {
    bus.sentence = [];
    bus.lastUtterance = event;
  } else if (event.type === "framing") bus.framing = event;
  else if (event.type === "recognizer") bus.recognizer = event;
  for (const listener of bus.listeners) listener(event);
}

/** Current state for a page that just connected: recognizer, framing, last sentence, signs in progress. */
export function snapshot(): GuestEvent[] {
  const bus = guestBus();
  return [bus.recognizer, bus.framing, bus.lastUtterance, ...bus.sentence].filter((e): e is GuestEvent => e !== null);
}

/** Guest data the bus holds right now: signs in progress, last sentence, framing hint. */
export function heldItems() {
  const bus = guestBus();
  return bus.sentence.length + (bus.lastUtterance ? 1 : 0) + (bus.framing ? 1 : 0);
}

/** Erases the guest data from the bus (the recognizer state is kept) and tells the pages. Returns the count. */
export function wipe(at = Date.now() / 1000) {
  const bus = guestBus();
  const erased = heldItems();
  bus.sentence = [];
  bus.lastUtterance = null;
  bus.framing = null;
  publish({ type: "wiped", at });
  return erased;
}

export function subscribe(listener: Listener) {
  const bus = guestBus();
  bus.listeners.add(listener);
  return () => bus.listeners.delete(listener);
}

/** The bridge only talks to this laptop: loopback socket and Host. */
export function fromLoopback(request: Request) {
  const loopback = (host: string) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i.test(host.trim());
  // Next fills x-forwarded-for with the socket address when the client sent none.
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").filter(Boolean);
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return forwarded.length > 0 && forwarded.every(loopback) && loopback(host);
}

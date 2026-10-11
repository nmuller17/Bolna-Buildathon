// P4: in-memory bridge between the recognizer (POST /api/guest/signs) and the open pages (GET /api/guest/stream).
// Kept on globalThis so both routes, and every dev hot reload, share the same one (one Node process on the laptop).
import type { Prediction } from "../english/intents";

/** What the pages receive (one SSE message each). `replay` is set on the snapshot sent when a page (re)connects. */
export type GuestEvent =
  | { type: "sign"; seq: number; top: Prediction[]; at: number }
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
  // The guest's turn (recognition/live_key.py POST /turn): start (with the expected answers) and end.
  | { type: "turn"; phase: "start" | "end"; expected: string[][] | null; empty: boolean; at: number }
  // Where the guest is in their turn: waiting for the hands, signing, translating
  // (or, for one-sign capture windows, a countdown before a REC of `duration` s).
  | { type: "capture"; phase: CapturePhase; countdown: number | null; duration: number | null; at: number };

export type CapturePhase = "listening" | "signing" | "processing" | "countdown";

type Listener = (event: GuestEvent) => void;

type Bus = {
  listeners: Set<Listener>;
  sentence: GuestEvent[]; // signs of the sentence in progress
  lastUtterance: GuestEvent | null;
  framing: GuestEvent | null;
  recognizer: GuestEvent | null;
  turn: GuestEvent | null; // last turn start while the turn is open, else null
  capture: GuestEvent | null; // last capture phase of the open turn
  nextId: number;
};

const KEY = Symbol.for("signbridge.guestBus");

export function guestBus(): Bus {
  const g = globalThis as unknown as Record<symbol, Bus | undefined>;
  return (g[KEY] ??= {
    listeners: new Set(),
    sentence: [],
    lastUtterance: null,
    framing: null,
    recognizer: null,
    turn: null,
    capture: null,
    nextId: 1,
  });
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
  else if (event.type === "turn") {
    bus.turn = event.phase === "start" ? event : null;
    bus.capture = null;
  } else if (event.type === "capture") bus.capture = event;
  for (const listener of bus.listeners) listener(event);
}

/** Current state for a page that just connected: recognizer, framing, last sentence, open turn, signs in progress. */
export function snapshot(): GuestEvent[] {
  const bus = guestBus();
  return [bus.recognizer, bus.framing, bus.lastUtterance, bus.turn, bus.capture, ...bus.sentence].filter(
    (e): e is GuestEvent => e !== null,
  );
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

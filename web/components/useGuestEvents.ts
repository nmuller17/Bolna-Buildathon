// P4: the guest -> staff direction, client side. Subscribes to GET /api/guest/stream (Server-Sent Events) and keeps
// the signs of the sentence in progress, the last sentence, the framing hint and the recognizer state.
// Signs are provisional (an undo in live_key sends no event); the utterance's labels are what counts.
import { useEffect, useRef, useState } from "react";
import type { GuestEvent } from "@/app/api/guest/bus";

export type GuestSign = Extract<GuestEvent, { type: "sign" }>;
export type GuestUtterance = Extract<GuestEvent, { type: "utterance" }>;
type Received = GuestEvent & { replay: boolean };

/** Optional extra callbacks, live events only. onSign gets the sign and when it arrived on the page (Unix s). */
export type GuestEventHandlers = { onSign?: (sign: GuestSign, receivedAt: number) => void; onWiped?: () => void };

/** `onUtterance` is called for live sentences only, never for the state replayed when the page (re)connects. */
export function useGuestEvents(onUtterance?: (utterance: GuestUtterance) => void, handlers?: GuestEventHandlers) {
  const [signs, setSigns] = useState<GuestSign[]>([]);
  const [utterance, setUtterance] = useState<GuestUtterance | null>(null);
  const [framing, setFraming] = useState<string | null>(null);
  const [recognizer, setRecognizer] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const callback = useRef(onUtterance);
  const extra = useRef(handlers);
  useEffect(() => {
    callback.current = onUtterance;
    extra.current = handlers;
  });

  useEffect(() => {
    const source = new EventSource("/api/guest/stream");
    let sentenceDone = true; // the next sign starts a new sentence
    source.onopen = () => {
      setConnected(true);
      // The server replays its state right after: start from scratch so nothing is doubled (or kept after a wipe).
      setSigns([]);
      setUtterance(null);
      setFraming(null);
      sentenceDone = true;
    };
    source.onerror = () => setConnected(false); // EventSource reconnects by itself
    source.onmessage = (message: MessageEvent<string>) => {
      let event: Received;
      try {
        event = JSON.parse(message.data) as Received;
      } catch {
        return;
      }
      if (event.type === "sign") {
        const sign = event;
        setSigns((current) => (sentenceDone ? [sign] : [...current, sign]));
        sentenceDone = false;
        if (!event.replay) extra.current?.onSign?.(sign, Date.now() / 1000);
      } else if (event.type === "utterance") {
        setUtterance(event);
        setSigns([]);
        sentenceDone = true;
        if (!event.replay) callback.current?.(event);
      } else if (event.type === "framing") setFraming(event.status);
      else if (event.type === "recognizer") setRecognizer(event.state);
      else if (event.type === "wiped") {
        setSigns([]);
        setUtterance(null);
        setFraming(null);
        sentenceDone = true;
        extra.current?.onWiped?.();
      }
    };
    return () => source.close();
  }, []);

  return { signs, utterance, framing, recognizer, connected };
}

// P4: the guest -> staff direction, client side. Subscribes to GET /api/guest/stream (Server-Sent Events) and keeps
// the signs of the sentence in progress, the last sentence, the framing hint and the recognizer state.
// Signs are provisional (an undo in live_key sends no event); the utterance's labels are what counts.
import { useEffect, useRef, useState } from "react";
import type { GuestEvent } from "@/app/api/guest/bus";

export type GuestSign = Extract<GuestEvent, { type: "sign" }>;
export type GuestUtterance = Extract<GuestEvent, { type: "utterance" }>;
export type GuestTurnEvent = Extract<GuestEvent, { type: "turn" }>;
export type GuestCapture = Extract<GuestEvent, { type: "capture" }>;
type Received = GuestEvent & { replay: boolean };

/**
 * `onUtterance` and `onTurnEnd` are called for live events only, never for the state replayed when the page
 * (re)connects. `turn` is the open guest turn (null outside one), `capture` its current phase.
 */
export function useGuestEvents(
  onUtterance?: (utterance: GuestUtterance) => void,
  onTurnEnd?: (end: GuestTurnEvent) => void,
) {
  const [signs, setSigns] = useState<GuestSign[]>([]);
  const [utterance, setUtterance] = useState<GuestUtterance | null>(null);
  const [framing, setFraming] = useState<string | null>(null);
  const [recognizer, setRecognizer] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [turn, setTurn] = useState<GuestTurnEvent | null>(null);
  const [capture, setCapture] = useState<GuestCapture | null>(null);
  const callback = useRef(onUtterance);
  const turnEndCallback = useRef(onTurnEnd);
  useEffect(() => {
    callback.current = onUtterance;
    turnEndCallback.current = onTurnEnd;
  });

  useEffect(() => {
    const source = new EventSource("/api/guest/stream");
    let sentenceDone = true; // the next sign starts a new sentence
    source.onopen = () => {
      setConnected(true);
      // The server replays its state right after: start from scratch so nothing is doubled.
      setSigns([]);
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
      } else if (event.type === "utterance") {
        setUtterance(event);
        setSigns([]);
        sentenceDone = true;
        if (!event.replay) callback.current?.(event);
      } else if (event.type === "framing") setFraming(event.status);
      else if (event.type === "recognizer") setRecognizer(event.state);
      else if (event.type === "turn") {
        setTurn(event.phase === "start" ? event : null);
        setCapture(null);
        if (event.phase === "end" && !event.replay) turnEndCallback.current?.(event);
      } else if (event.type === "capture") setCapture(event);
    };
    return () => source.close();
  }, []);

  return { signs, utterance, framing, recognizer, connected, turn, capture };
}

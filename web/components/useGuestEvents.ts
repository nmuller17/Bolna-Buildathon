// P4: the guest -> staff direction, client side. Subscribes to GET /api/guest/stream (Server-Sent Events) and keeps
// the signs of the sentence in progress, the last sentence, the framing hint and the recognizer state.
// Signs are provisional (an undo in live_key sends no event); the utterance's labels are what counts.
import { useEffect, useRef, useState } from "react";
import type { GuestEvent } from "@/app/api/guest/bus";

export type GuestSign = Extract<GuestEvent, { type: "sign" }>;
export type GuestUtterance = Extract<GuestEvent, { type: "utterance" }>;
type Received = GuestEvent & { replay: boolean };

/**
 * `onUtterance` is called for live sentences only, never for the state replayed when the page (re)connects.
 * Its second argument is the sentence's `sign` events (alternatives and confidences), as received.
 */
export function useGuestEvents(onUtterance?: (utterance: GuestUtterance, signs: GuestSign[]) => void) {
  const [signs, setSigns] = useState<GuestSign[]>([]);
  const [utterance, setUtterance] = useState<GuestUtterance | null>(null);
  const [framing, setFraming] = useState<string | null>(null);
  const [recognizer, setRecognizer] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const callback = useRef(onUtterance);
  useEffect(() => {
    callback.current = onUtterance;
  });

  useEffect(() => {
    const source = new EventSource("/api/guest/stream");
    let sentenceDone = true; // the next sign starts a new sentence
    let sentence: GuestSign[] = []; // signs of the sentence in progress, for onUtterance
    source.onopen = () => {
      setConnected(true);
      // The server replays its state right after: start from scratch so nothing is doubled.
      setSigns([]);
      sentenceDone = true;
      sentence = [];
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
        sentence = sentenceDone ? [sign] : [...sentence, sign];
        sentenceDone = false;
      } else if (event.type === "utterance") {
        const signsOfSentence = sentenceDone ? [] : sentence;
        setUtterance(event);
        setSigns([]);
        sentenceDone = true;
        if (!event.replay) callback.current?.(event, signsOfSentence);
      } else if (event.type === "framing") setFraming(event.status);
      else if (event.type === "recognizer") setRecognizer(event.state);
    };
    return () => source.close();
  }, []);

  return { signs, utterance, framing, recognizer, connected };
}

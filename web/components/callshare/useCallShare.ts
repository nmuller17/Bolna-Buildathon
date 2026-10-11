"use client";
// Call-share view (P4): playback state for the shared area, kept in step between the control page and the
// optional pop-out window through a BroadcastChannel (same browser, same machine; nothing goes on the network).
// Typed text is never logged or stored: it lives only in React state and in the channel message.
import { useCallback, useEffect, useRef, useState } from "react";
import { playGloss } from "@/lib/avatar/player";
import { INITIAL_SHARE_STATE, type ShareState } from "./ShareRegion";

const CHANNEL = "signbridge-callshare"; // separate from the app's "signbridge" channel

type Message =
  | { type: "say"; text: string; gloss: string[] }
  | { type: "consent"; show: boolean }
  | { type: "hello" } // a pop-out window asking for the current caption and consent state
  | { type: "sync"; text: string; gloss: string[]; consent: boolean };

export function useCallShare(role: "controller" | "window") {
  const [state, setState] = useState<ShareState>(INITIAL_SHARE_STATE);
  const playId = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const playLocal = useCallback(async (text: string, gloss: string[]) => {
    const id = ++playId.current;
    if (gloss.length === 0) {
      setState((s) => ({ ...s, text, gloss, active: null, status: "captions" }));
      return;
    }
    setState((s) => ({ ...s, text, gloss, active: null, status: "signing" }));
    await playGloss(gloss, { onToken: (i) => playId.current === id && setState((s) => ({ ...s, active: i })) });
    if (playId.current !== id) return; // a newer message took over
    setState((s) => ({ ...s, active: null, status: "your-turn" }));
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    channel.current = ch;
    ch.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === "say") void playLocal(m.text, m.gloss);
      else if (m.type === "consent") setState((s) => ({ ...s, consent: m.show }));
      else if (m.type === "hello" && role === "controller") {
        const s = stateRef.current;
        ch.postMessage({ type: "sync", text: s.text, gloss: s.gloss, consent: s.consent } satisfies Message);
      } else if (m.type === "sync" && role === "window") {
        setState((s) => ({
          ...s,
          text: m.text,
          gloss: m.gloss,
          consent: m.consent,
          status: m.text || m.gloss.length ? "your-turn" : "waiting",
        }));
      }
    };
    if (role === "window") ch.postMessage({ type: "hello" } satisfies Message);
    return () => {
      ch.close();
      channel.current = null;
      playId.current++; // ignore the end of a sentence that was playing
    };
  }, [playLocal, role]);

  /** Signs (or captions) here and in the pop-out window. */
  const say = useCallback(
    (text: string, gloss: string[]) => {
      channel.current?.postMessage({ type: "say", text, gloss } satisfies Message);
      void playLocal(text, gloss);
    },
    [playLocal],
  );

  const setConsent = useCallback((show: boolean) => {
    channel.current?.postMessage({ type: "consent", show } satisfies Message);
    setState((s) => ({ ...s, consent: show }));
  }, []);

  return { state, say, setConsent };
}

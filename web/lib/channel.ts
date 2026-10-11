// P4: BroadcastChannel("signbridge") helpers, messages from CLAUDE.md 6.7.
// /staff (laptop) and /guest (monitor facing the guest) are two windows on the same machine.
// Backward-compatible addition (docs/requests.md): staff_status, so the guest screen can show that the receptionist talks.
import { useCallback, useEffect, useRef } from "react";
import type { Prediction } from "@/app/api/english/intents";

export type { Prediction };

export const CHANNEL_NAME = "signbridge";

export type StaffState = "idle" | "listening" | "processing";

export type ChannelMessage =
  | { type: "staff_utterance"; text: string; gloss: string[] } // staff spoke, guest screen plays the avatar
  | { type: "guest_utterance"; signs: Prediction[]; text: string } // guest signed, staff screen shows the text
  | { type: "repeat_request" } // low confidence, guest screen asks to repeat
  | { type: "staff_status"; state: StaffState } // addition: receptionist talking / being processed
  | { type: "voice_output"; playing: boolean }; // addition: /staff is speaking the guest aloud, /guest mutes its mic

/** One turn of the conversation, whichever side it comes from. */
export type ConversationTurn = {
  from: "staff" | "guest";
  text: string;
  gloss?: string[];
  signs?: Prediction[];
  at: number; // Date.now()
};

const TYPES = new Set(["staff_utterance", "guest_utterance", "repeat_request", "staff_status", "voice_output"]);

function isMessage(data: unknown): data is ChannelMessage {
  return typeof data === "object" && data !== null && TYPES.has((data as { type?: unknown }).type as string);
}

/** Opens the channel (outside React). Messages from other windows go to onMessage; call close() when done. */
export function openChannel(onMessage?: (message: ChannelMessage) => void) {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  if (onMessage) channel.onmessage = (event: MessageEvent) => isMessage(event.data) && onMessage(event.data);
  return {
    send: (message: ChannelMessage) => channel.postMessage(message),
    close: () => channel.close(),
  };
}

/**
 * Listens on the channel while the component is mounted (closed on unmount) and returns a stable send().
 * The handler may change between renders; the latest one is always called.
 */
export function useSignbridgeChannel(onMessage?: (message: ChannelMessage) => void) {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });
  const channel = useRef<ReturnType<typeof openChannel> | null>(null);
  useEffect(() => {
    const opened = openChannel((message) => handler.current?.(message));
    channel.current = opened;
    return () => {
      opened.close();
      if (channel.current === opened) channel.current = null;
    };
  }, []);
  return useCallback((message: ChannelMessage) => channel.current?.send(message), []);
}

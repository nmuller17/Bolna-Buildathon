"use client";
// P4 (builder B): guest screen state. Joins with the pairing code from the URL fragment, keeps one
// event stream open, and turns guest events into what the screen shows (docs/app-plan.md 4.4-4.6).
//
// Memory only: no localStorage, sessionStorage, IndexedDB, Cache API or service worker (SES-11).
// The page keeps the last three staff sentences in memory; the server's snapshot holds only the
// last one (AS-1, GST-12).
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { openEventStream, postJson, sendGuestAction, type GuestActionBody } from "@/lib/channel";
import {
  LIMITS,
  type ApiError,
  type BusEnvelope,
  type FramingStatus,
  type GuestEvent,
  type GuestHello,
  type GuestJoinResponse,
  type GuestLiveSign,
  type GuestProposal,
  type GuestRepeatRequest,
  type GuestSettings,
  type GuestStaffUtterance,
  type GuestUtteranceEcho,
  type SessionEndReason,
} from "@/lib/app/types";

export type GuestConn = "connecting" | "no_session" | "link_used" | "live" | "lost" | "ended";

export type CaptionItem = { cap: GuestStaffUtterance; seq: number; isNew: boolean };

export type GuestUi = {
  conn: GuestConn;
  hello: GuestHello | null;
  settings: GuestSettings;
  /** Newest first, at most LIMITS.guestCaptionsKept. */
  captions: CaptionItem[];
  /** Signs of the current utterance, shown the moment each is recognised (GST-5). */
  live: GuestLiveSign[];
  /** The next live sign starts a new row (set after a proposal, repeat or echo). */
  liveClosed: boolean;
  framing: FramingStatus | null;
  pending: GuestProposal | null;
  repeat: GuestRepeatRequest | null;
  echo: GuestUtteranceEcho | null;
  /** "failed" = the alert did not reach the server; the screen says to wave or knock (OPS-1). */
  help: { state: "none" | "sent" | "acked" | "failed"; at: number | null };
  interpreter: "none" | "sent" | "acked";
  warning: { kind: "idle" | "cap"; until: number; canAskForTime: boolean } | null;
  signingAvailable: boolean;
  paused: boolean;
  pairedWith: string | null;
  end: { reason: SessionEndReason; pendingLost: boolean } | null;
  /** The guest's own screen confirms every mode or setting change (C2-7). */
  notice: { text: string; at: number } | null;
};

const DEFAULT_SETTINGS: GuestSettings = { type: "settings", guestMode: "choosing", speakAloud: true, showAvatar: true };

const INITIAL: GuestUi = {
  conn: "connecting",
  hello: null,
  settings: DEFAULT_SETTINGS,
  captions: [],
  live: [],
  liveClosed: true,
  framing: null,
  pending: null,
  repeat: null,
  echo: null,
  help: { state: "none", at: null },
  interpreter: "none",
  warning: null,
  signingAvailable: false,
  paused: false,
  pairedWith: null,
  end: null,
  notice: null,
};

type Act =
  | { t: "env"; env: BusEnvelope<GuestEvent> }
  | { t: "conn"; conn: GuestConn }
  | { t: "hello"; hello: GuestHello }
  | { t: "help_sent" }
  | { t: "help_failed" }
  | { t: "interpreter_sent" }
  | { t: "captions_seen" }
  | { t: "local_end"; reason: SessionEndReason; pendingLost: boolean };

function settingsNotice(prev: GuestSettings, next: GuestSettings): string | null {
  const parts: string[] = [];
  if (prev.guestMode !== next.guestMode) {
    const m: Record<GuestSettings["guestMode"], string | null> = {
      choosing: null,
      sign: "Signing is now on.",
      type: "Typing is now on.",
      interpreter: "Interpreter request is on.",
      text_only: "Text only is now on.",
    };
    if (m[next.guestMode]) parts.push(m[next.guestMode]!);
    if (prev.guestMode === "sign" && next.guestMode !== "sign") parts.push("Signing is now off.");
  }
  if (prev.speakAloud !== next.speakAloud) parts.push(next.speakAloud ? "Reading aloud is now on." : "Reading aloud is now off.");
  if (prev.showAvatar !== next.showAvatar) parts.push(next.showAvatar ? "The avatar is now shown." : "The avatar is now hidden.");
  return parts.length ? parts.join(" ") : null;
}

function pushCaption(list: CaptionItem[], cap: GuestStaffUtterance, seq: number): CaptionItem[] {
  const rest = list.filter((c) => c.cap.id !== cap.id);
  return [{ cap, seq, isNew: true }, ...rest].slice(0, LIMITS.guestCaptionsKept);
}

function reduce(ui: GuestUi, a: Act): GuestUi {
  switch (a.t) {
    case "conn":
      if (ui.conn === "ended") return ui;
      return { ...ui, conn: a.conn };
    case "hello":
      return { ...ui, hello: a.hello, signingAvailable: a.hello.signingAvailable, conn: ui.conn === "ended" ? ui.conn : "live" };
    case "help_sent":
      return { ...ui, help: { state: ui.help.state === "acked" ? "acked" : "sent", at: ui.help.at ?? Date.now() } };
    case "help_failed":
      return ui.help.state === "acked" ? ui : { ...ui, help: { state: "failed", at: ui.help.at ?? Date.now() } };
    case "interpreter_sent":
      return { ...ui, interpreter: ui.interpreter === "acked" ? "acked" : "sent" };
    case "captions_seen":
      return ui.captions.some((c) => c.isNew) ? { ...ui, captions: ui.captions.map((c) => ({ ...c, isNew: false })) } : ui;
    case "local_end":
      return { ...INITIAL, conn: "ended", hello: ui.hello, end: { reason: a.reason, pendingLost: a.pendingLost } };
    case "env":
      break;
  }
  const { msg, seq, at } = a.env;
  switch (msg.type) {
    case "hello":
      return { ...ui, hello: msg, signingAvailable: msg.signingAvailable, conn: "live" };
    case "snapshot": {
      const captions =
        msg.lastCaption && !ui.captions.some((c) => c.cap.id === msg.lastCaption!.id)
          ? pushCaption(ui.captions, msg.lastCaption, seq)
          : ui.captions;
      return {
        ...ui,
        conn: "live",
        settings: msg.settings,
        captions,
        pending: msg.pending,
        framing: msg.framing,
        signingAvailable: msg.signingAvailable,
        help: msg.emergencyPending ? { state: "sent", at: ui.help.at ?? at } : ui.help.state === "sent" ? { state: "none", at: null } : ui.help,
      };
    }
    case "settings": {
      const text = settingsNotice(ui.settings, msg);
      return { ...ui, settings: msg, notice: text ? { text, at } : ui.notice };
    }
    case "pair_confirmed":
      return { ...ui, pairedWith: msg.deskShows, paused: false };
    case "staff_utterance":
      // A staff action resets the idle timer on the server, so an idle warning is over.
      return { ...ui, captions: pushCaption(ui.captions, msg, seq), warning: ui.warning?.kind === "idle" ? null : ui.warning };
    case "live_sign": {
      const live = ui.liveClosed ? [msg] : [...ui.live, msg].slice(-LIMITS.maxSigns);
      // A new utterance has started: the previous echo or repeat is finished with.
      return ui.pending ? ui : { ...ui, live, liveClosed: false, echo: ui.liveClosed ? null : ui.echo, repeat: ui.liveClosed ? null : ui.repeat };
    }
    case "framing":
      return { ...ui, framing: msg.status };
    case "repeat_request":
      return { ...ui, repeat: msg, pending: null, echo: null, liveClosed: true };
    case "guest_proposal":
      return { ...ui, pending: msg, repeat: null, echo: null, liveClosed: true };
    case "guest_utterance":
      return { ...ui, echo: msg, pending: null, repeat: null, liveClosed: true };
    case "staff_ack":
      if (msg.about === "emergency") return { ...ui, help: { state: "acked", at: ui.help.at } };
      if (msg.about === "interpreter") return { ...ui, interpreter: "acked" };
      return ui;
    case "idle_warning":
      return { ...ui, warning: { kind: "idle", until: at + msg.secondsLeft * 1000, canAskForTime: msg.canAskForTime } };
    case "cap_warning":
      return { ...ui, warning: { kind: "cap", until: at + msg.secondsLeft * 1000, canAskForTime: msg.canAskForTime } };
    case "session_paused":
      return { ...ui, paused: true };
    case "signing_available":
      return { ...ui, signingAvailable: msg.available };
    case "session_end":
      return { ...INITIAL, conn: "ended", hello: ui.hello, end: { reason: msg.reason, pendingLost: msg.pendingLost } };
  }
  return ui;
}

export type ActionOutcome = { ok: true } | { ok: false; message: string; field?: "name" | "text" };

function outcomeOf(status: number, data: unknown): ActionOutcome {
  if (status === 200) return { ok: true };
  const err = (data ?? null) as ApiError | null;
  if (status === 0) return { ok: false, message: "This screen lost its connection to the desk. Wave to the desk." };
  if (status === 429) return { ok: false, message: "Please wait a moment, then try again." };
  if (status === 409) return { ok: false, message: "That choice is no longer waiting. Please sign again or type." };
  if (status === 401) return { ok: false, message: "This screen is no longer connected. Ask the desk to reconnect." };
  return { ok: false, message: err?.message || "That did not go through. Please try again.", field: err?.field };
}

/** The whole guest session: state, actions and the side effects (join, stream, acks, heartbeat). */
export function useGuestSession() {
  const [ui, dispatch] = useReducer(reduce, INITIAL);
  const [hidden, setHidden] = useState(false);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  /** Set by the page while a typed draft or a local phrase confirmation is open (C2-18). */
  const unsentRef = useRef(false);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const endedRef = useRef(false);

  const finishLocally = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    streamRef.current?.close();
    // Expires the guest cookie on the server; never sends Clear-Site-Data on the staff listener (plan 9.6).
    void postJson("/api/guest/leave", {});
    // Back must not show the conversation (AS-6, AS-7).
    try {
      history.replaceState(null, "", "/guest");
    } catch {}
  }, []);

  const onEnvelope = useCallback(
    (env: BusEnvelope<GuestEvent>) => {
      if (endedRef.current) return;
      if (env.msg.type === "session_end") {
        const lost = env.msg.pendingLost || unsentRef.current;
        dispatch({ t: "env", env: { ...env, msg: { ...env.msg, pendingLost: lost } } });
        finishLocally();
        return;
      }
      dispatch({ t: "env", env });
      // Render acknowledgement for captions and proposals: feeds the checklist and latency (plan 5.1 S9).
      if (env.msg.type === "staff_utterance" || env.msg.type === "guest_proposal") {
        const seq = env.seq;
        requestAnimationFrame(() => void sendGuestAction({ type: "ack", seq }));
      }
    },
    [finishLocally],
  );

  // Join (code from the fragment, removed before any request), then the stream.
  useEffect(() => {
    let cancelled = false;
    const startStream = () => {
      if (cancelled) return;
      streamRef.current = openEventStream<GuestEvent>(
        "guest",
        {
          onMessage: onEnvelope,
          onState: (state) => {
            if (state !== "unauthorized" || endedRef.current) return;
            // A 401 that was not preceded by session_end (plan 9.4).
            dispatch({ t: "conn", conn: uiRef.current.hello ? "lost" : "no_session" });
          },
        },
        { watchdogMs: LIMITS.guestWatchdogMs, retryMs: LIMITS.sseRetryMs },
      );
    };

    const m = /(?:^#|&)p=([A-Za-z0-9_-]{8,128})/.exec(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname);
    if (!m) {
      startStream();
    } else {
      void postJson<GuestJoinResponse>("/api/guest/join", { code: m[1] }).then(({ status, data }) => {
        if (cancelled) return;
        if (status === 200 && data && data.ok) {
          dispatch({ t: "hello", hello: data.hello });
          startStream();
        } else if (status === 410) {
          dispatch({ t: "conn", conn: "link_used" });
        } else {
          // The cookie from an earlier join may still be valid (a reload): try the stream.
          startStream();
        }
      });
    }
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, [onEnvelope]);

  // Heartbeat every 5 s while connected (SES-15). Never counts as activity on the server.
  useEffect(() => {
    if (ui.conn !== "live") return;
    const id = setInterval(() => void sendGuestAction({ type: "heartbeat" }), LIMITS.guestHeartbeatMs);
    return () => clearInterval(id);
  }, [ui.conn]);

  // Neutral screen while hidden; restored from memory when visible again (AS-7, SES-11).
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === "hidden");
    const onHide = () => setHidden(true);
    const onShow = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  const act = useCallback(async (action: GuestActionBody): Promise<ActionOutcome> => {
    const { status, data } = await sendGuestAction(action);
    return outcomeOf(status, data);
  }, []);

  const emergency = useCallback(async () => {
    dispatch({ t: "help_sent" });
    // Retried once: the button is a convenience, the printed card is the independent path (plan 9.5).
    const first = await sendGuestAction({ type: "emergency" });
    if (first.status === 200) return;
    const second = await sendGuestAction({ type: "emergency" });
    if (second.status !== 200) dispatch({ t: "help_failed" });
  }, []);

  const requestInterpreter = useCallback(async () => {
    dispatch({ t: "interpreter_sent" });
    return act({ type: "interpreter_request" });
  }, [act]);

  const finish = useCallback(async () => {
    const lost = unsentRef.current || uiRef.current.pending !== null;
    dispatch({ t: "local_end", reason: "guest_left", pendingLost: lost });
    finishLocally();
  }, [finishLocally]);

  const captionsSeen = useCallback(() => dispatch({ t: "captions_seen" }), []);

  return { ui, hidden, act, emergency, requestInterpreter, finish, captionsSeen, unsentRef };
}

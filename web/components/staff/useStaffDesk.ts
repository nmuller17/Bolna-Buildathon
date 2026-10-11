"use client";
// P4 (builder B): staff dashboard state (docs/app-plan.md 4.2). Claims the staff capability from the
// one-time #k= URL, keeps the staff event stream open, rebuilds the in-memory conversation log from
// events, and runs the speak plan through the one unlocked AudioContext.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { openEventStream, postJson } from "@/lib/channel";
import type {
  AlertKind,
  BusEnvelope,
  CapturePhase,
  CheckinItemStatus,
  GuestMode,
  GuestProposal,
  GuestReplyKind,
  LogEntry,
  PairingInfo,
  SafetyWarning,
  SessionState,
  SignsSource,
  StaffAction,
  StaffActionResponse,
  StaffEvent,
  StaffSignView,
  StaffStatus,
  VriInfo,
  WipeReceipt,
} from "@/lib/app/types";
import { helpTone, speakLocal, unlockAudio, voiceFixed } from "./audio";

export type DeskConn = "idle" | "connecting" | "open" | "retrying" | "unauthorized";

export type EvidenceItem = { sign: StaffSignView; simulated: boolean; undone?: boolean };

export type StaffUi = {
  started: boolean;
  conn: DeskConn;
  claimError: string | null;
  /** "local" = /api/tts has no voice configured, so fixed sentences use the on-device voice. */
  voice: "off" | "warming" | "ready" | "failed" | "local";
  status: StaffStatus | null;
  sessionState: SessionState;
  log: LogEntry[];
  pairing: PairingInfo | null;
  checklist: CheckinItemStatus[];
  evidence: EvidenceItem[];
  /** Signs of the utterance in progress, shown the moment each is recognised. */
  live: EvidenceItem[];
  liveClosed: boolean;
  /** live_key.py recording phase (key-triggered signing), with the local time it arrived. */
  capture: (CapturePhase & { at: number }) | null;
  warnings: SafetyWarning[];
  pending: (GuestProposal & { simulatedSource?: boolean }) | null;
  emergency: { count: number; at: number } | null;
  interpreter: { vri: VriInfo; at: number } | null;
  typed: { text: string; logSeq: number; at: number }[];
  replies: { reply: GuestReplyKind; at: number; key: number }[];
  moreTime: { on: "idle" | "cap"; at: number } | null;
  idleWarnUntil: number | null;
  capWarnUntil: number | null;
  repeats: { count: number; streak: number };
  receipt: WipeReceipt | null;
  /** Voicing results per guest line (log seq): when it started and how, or why not. */
  spoken: Record<number, { at: number | null; how: "tts" | "local" | "none" }>;
  lastError: string | null;
};

const INITIAL: StaffUi = {
  started: false,
  conn: "idle",
  claimError: null,
  voice: "off",
  status: null,
  sessionState: "NO_SESSION",
  log: [],
  pairing: null,
  checklist: [],
  evidence: [],
  live: [],
  liveClosed: true,
  capture: null,
  warnings: [],
  pending: null,
  emergency: null,
  interpreter: null,
  typed: [],
  replies: [],
  moreTime: null,
  idleWarnUntil: null,
  capWarnUntil: null,
  repeats: { count: 0, streak: 0 },
  receipt: null,
  spoken: {},
  lastError: null,
};

type Act =
  | { t: "env"; env: BusEnvelope<StaffEvent> }
  | { t: "set"; patch: Partial<StaffUi> }
  | { t: "spoken"; seq: number; at: number | null; how: "tts" | "local" | "none" }
  | { t: "dismiss_typed"; logSeq: number }
  | { t: "dismiss_reply"; key: number }
  | { t: "ack"; about: AlertKind };

const MODE_WORDS: Record<GuestMode, string> = {
  choosing: "Guest is back on the first screen",
  sign: "Guest chose to sign",
  type: "Guest chose to type",
  interpreter: "Guest asked for a human interpreter",
  text_only: "Guest chose text only",
};

function choiceLine(prev: StaffStatus["guest"]["settings"] | undefined, next: { guestMode: GuestMode; speakAloud: boolean; showAvatar: boolean }): string {
  const parts: string[] = [];
  if (!prev || prev.guestMode !== next.guestMode) parts.push(MODE_WORDS[next.guestMode]);
  if (prev && prev.speakAloud !== next.speakAloud) parts.push(next.speakAloud ? "Guest turned on reading aloud" : "Guest turned off reading aloud");
  if (prev && prev.showAvatar !== next.showAvatar) parts.push(next.showAvatar ? "Guest turned on the avatar" : "Guest turned off the avatar");
  return parts.join(". ") || "Guest changed a setting";
}

const FIX_WORDS = { sign_again: "sign again", type: "type instead", interpreter: "ask for an interpreter", not_this: "not this" } as const;

function upsertEvidence(list: EvidenceItem[], item: EvidenceItem): EvidenceItem[] {
  if (item.sign.seq === null) return [...list, item].slice(-60);
  const i = list.findIndex((e) => e.sign.seq === item.sign.seq && e.sign.receivedAt === item.sign.receivedAt);
  if (i === -1) return [...list, item].slice(-60);
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(ui: StaffUi, a: Act): StaffUi {
  switch (a.t) {
    case "set":
      return { ...ui, ...a.patch };
    case "spoken":
      return { ...ui, spoken: { ...ui.spoken, [a.seq]: { at: a.at, how: a.how } } };
    case "dismiss_typed":
      return { ...ui, typed: ui.typed.filter((t) => t.logSeq !== a.logSeq) };
    case "dismiss_reply":
      return { ...ui, replies: ui.replies.filter((r) => r.key !== a.key) };
    case "ack":
      if (a.about === "emergency") return { ...ui, emergency: null };
      if (a.about === "interpreter") return { ...ui, interpreter: null };
      if (a.about === "more_time") return { ...ui, moreTime: null };
      return ui;
    case "env":
      break;
  }
  const { msg, seq, at } = a.env;
  const sys = (text: string): LogEntry => ({ kind: "system", seq, at, text });
  switch (msg.type) {
    case "snapshot":
      return {
        ...ui,
        status: msg.status,
        sessionState: msg.status.session.state,
        log: msg.log,
        pairing: msg.pairing,
        checklist: msg.checklist,
        evidence: msg.evidence.map((sign) => ({ sign, simulated: false })),
        warnings: msg.warnings,
        pending: msg.pending,
      };
    case "status": {
      const prev = ui.status;
      const log =
        prev && msg.status.recognizer.restarts > prev.recognizer.restarts ? [...ui.log, sys("The recognizer restarted.")] : ui.log;
      return { ...ui, status: msg.status, sessionState: msg.status.session.state, log };
    }
    case "session_state":
      return { ...ui, sessionState: msg.state, pairing: msg.pairing };
    case "pair_confirmed":
      return { ...ui, log: [...ui.log, sys(`Paired with ${msg.check}.`)] };
    case "staff_utterance":
      return {
        ...ui,
        idleWarnUntil: null,
        log: [
          ...ui.log,
          {
            kind: "staff",
            seq,
            at,
            id: msg.id,
            text: msg.text,
            gloss: msg.gloss,
            captionSource: msg.captionSource,
            glossSource: msg.glossSource,
            intent: msg.intent,
            shownOnDeviceAt: null,
            guestReply: null,
          },
        ],
      };
    case "delivered": {
      // The guest device rendered a caption. The staff and guest copies of an event have different bus
      // seqs, so the server names the caption (captionId); without it the next snapshot fills it in.
      const id = msg.captionId ?? null;
      if (!id) return ui;
      return {
        ...ui,
        log: ui.log.map((e) => (e.kind === "staff" && e.id === id && e.shownOnDeviceAt === null ? { ...e, shownOnDeviceAt: at } : e)),
      };
    }
    case "live_sign": {
      const item = { sign: msg.sign, simulated: msg.source === "simulated" };
      return {
        ...ui,
        evidence: upsertEvidence(ui.evidence, item),
        live: ui.liveClosed ? [item] : [...ui.live, item].slice(-8),
        liveClosed: false,
        capture: null,
      };
    }
    case "live_sign_undone":
      return {
        ...ui,
        live: ui.live.filter((l) => l.sign.seq !== msg.seq),
        // Only the newest sign with that number: numbers restart when the recognizer restarts.
        evidence: ((last) => ui.evidence.map((e, i) => (i === last ? { ...e, undone: true } : e)))(ui.evidence.findLastIndex((e) => e.sign.seq === msg.seq && !e.simulated)),
      };
    case "capture":
      return { ...ui, capture: { phase: msg.phase, countdown: msg.countdown, duration: msg.duration, at: Date.now() } };
    case "framing": {
      // The header's Framing cell updates on the event itself, not on the next status push (up to 2 s later).
      const status = ui.status
        ? { ...ui.status, recognizer: { ...ui.status.recognizer, framing: msg.status, framingNotOkSince: msg.notOkSince } }
        : ui.status;
      const log = msg.rejectedSeq !== null ? [...ui.log, sys(`Sign #${msg.rejectedSeq}: camera missed it (framing).`)] : ui.log;
      return { ...ui, status, log };
    }
    case "recognition": {
      const simulated = msg.source === "simulated";
      let evidence = ui.evidence;
      for (const sign of msg.signs) evidence = upsertEvidence(evidence, { sign, simulated });
      const base = { ...ui, evidence, live: msg.signs.map((sign) => ({ sign, simulated })), liveClosed: true, capture: null };
      if (msg.outcome === "ignored_pending") return { ...base, live: ui.live, log: [...ui.log, sys("Camera saw a movement while the guest was choosing; ignored.")] };
      if (msg.outcome === "held") return { ...base, liveClosed: false, live: ui.live };
      if (msg.outcome === "repeat")
        return { ...base, log: [...ui.log, { kind: "repeat", seq, at, reason: msg.repeatReason ?? "low_confidence", recognizerSaidRepeat: msg.recognizerSaidRepeat }] };
      // A proposal of some kind is now waiting for the guest.
      const pending: StaffUi["pending"] = msg.proposalId
        ? {
            type: "guest_proposal",
            proposalId: msg.proposalId,
            kind: msg.outcome,
            signs: msg.signs.map((s) => ({ seq: s.seq, label: s.top[0]?.label ?? "NONE", light: s.light, red: s.red })),
            candidates: msg.candidates,
            testMode: msg.testMode,
            simulated,
          }
        : ui.pending;
      const hint = msg.recognizerSaidRepeat ? " (recognizer suggested a repeat)" : "";
      return { ...base, pending, log: [...ui.log, sys(`Waiting for the guest to confirm${hint}.`)] };
    }
    case "repeat_request":
      return { ...ui, repeats: { count: msg.count, streak: msg.streak } };
    case "guest_utterance": {
      const simulated = ui.pending?.proposalId === msg.proposalId ? ui.pending.simulated : false;
      return {
        ...ui,
        pending: ui.pending?.proposalId === msg.proposalId ? null : ui.pending,
        log: [
          ...ui.log,
          {
            kind: "guest",
            seq,
            at,
            proposalId: msg.proposalId,
            text: msg.text,
            signs: msg.signs,
            intentId: msg.intentId,
            source: msg.source,
            speak: msg.speak,
            spokenAt: null,
            confirmedBy: msg.confirmedBy,
            simulated,
          },
        ],
      };
    }
    case "guest_fix":
      return {
        ...ui,
        pending: ui.pending?.proposalId === msg.proposalId ? null : ui.pending,
        log: [...ui.log, { kind: "guest_setting", seq, at, text: `Guest tapped Fix: ${FIX_WORDS[msg.action]}` }],
      };
    case "guest_typed":
      return {
        ...ui,
        typed: [...ui.typed, { text: msg.text, logSeq: seq, at }],
        log: [...ui.log, { kind: "guest_typed", seq, at, text: msg.text, readAloudAt: null }],
      };
    case "guest_reply":
      return {
        ...ui,
        replies: [...ui.replies, { reply: msg.reply, at, key: seq }].slice(-3),
        log: [
          ...ui.log.map((e) => (e.kind === "staff" && msg.captionId !== null && e.id === msg.captionId ? { ...e, guestReply: msg.reply } : e)),
          { kind: "guest_reply", seq, at, reply: msg.reply, captionId: msg.captionId },
        ],
      };
    case "guest_choice":
      return { ...ui, log: [...ui.log, { kind: "guest_setting", seq, at, text: choiceLine(ui.status?.guest.settings, msg) }] };
    case "interpreter_request":
      return { ...ui, interpreter: { vri: msg.vri, at } };
    case "emergency":
      return { ...ui, emergency: { count: msg.count, at: ui.emergency?.at ?? at } };
    case "more_time":
      return { ...ui, moreTime: { on: msg.on, at } };
    case "staff_ack":
      return reduce(ui, { t: "ack", about: msg.about });
    case "warning": {
      const rest = ui.warnings.filter((w) => w.id !== msg.warning.id);
      return { ...ui, warnings: [...rest, msg.warning] };
    }
    case "checklist":
      return { ...ui, checklist: msg.items };
    case "idle_warning":
      return { ...ui, idleWarnUntil: at + msg.secondsLeft * 1000 };
    case "cap_warning":
      return { ...ui, capWarnUntil: at + msg.secondsLeft * 1000 };
    case "session_paused":
      return { ...ui, log: [...ui.log, sys("The guest device changed. Only Help works until it is checked again.")] };
    case "session_end":
      return {
        ...ui,
        sessionState: "NO_SESSION",
        log: [],
        pairing: null,
        checklist: [],
        evidence: [],
        live: [],
        liveClosed: true,
        pending: null,
        emergency: null,
        interpreter: null,
        typed: [],
        replies: [],
        moreTime: null,
        idleWarnUntil: null,
        capWarnUntil: null,
        repeats: { count: 0, streak: 0 },
        receipt: msg.receipt,
        spoken: {},
      };
    case "device_health":
    case "vlm_proposal":
      return ui;
  }
  return ui;
}

const ERROR_WORDS: Record<number, string> = {
  0: "The desk server did not answer. Check that it is running.",
  401: "This screen is not signed in. Open the one-time link printed by the server.",
  403: "This screen is not allowed to do that. Use http://127.0.0.1:3000/staff.",
  409: "That cannot be done in the current state.",
  429: "Too many requests; wait a moment.",
};

export function useStaffDesk() {
  const [ui, dispatch] = useReducer(reduce, INITIAL);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const streamRef = useRef<{ close: () => void } | null>(null);
  const ttsRef = useRef(true);

  const staffAction = useCallback(async (action: StaffAction): Promise<StaffActionResponse | null> => {
    const { status, data } = await postJson<StaffActionResponse>("/api/staff/action", action);
    if (status === 200 && data && data.ok) {
      dispatch({ t: "set", patch: { lastError: null } });
      return data;
    }
    const msg = (data && !data.ok && data.message) || ERROR_WORDS[status] || `The desk server answered ${status}.`;
    dispatch({ t: "set", patch: { lastError: msg } });
    return data;
  }, []);

  /** Runs a guest line's speak plan (fixed sentences only go to /api/tts). */
  const voiceLine = useCallback(
    async (entry: Extract<LogEntry, { kind: "guest" }>, force = false) => {
      const plan = entry.speak;
      if (plan.mode === "tts") {
        const v = await voiceFixed(plan.fixedText, ttsRef.current, plan.intentId);
        dispatch({ t: "spoken", seq: entry.seq, at: v.startedAt, how: v.how });
        if (!force && v.startedAt) void staffAction({ type: "speak_done", ref: entry.proposalId, how: v.how, startedAt: v.startedAt });
        return;
      }
      if (plan.mode === "local_after_tap") {
        const res = await staffAction(
          plan.tap === "speak_name" ? { type: "speak_name", proposalId: entry.proposalId } : { type: "read_aloud", logSeq: entry.seq },
        );
        const text = res && res.ok ? res.speakText : undefined;
        if (!text) return;
        const started = await speakLocal(text);
        dispatch({ t: "spoken", seq: entry.seq, at: started, how: started ? "local" : "none" });
        if (started) void staffAction({ type: "speak_done", ref: entry.proposalId, how: "local", startedAt: started });
      }
    },
    [staffAction],
  );

  const readAloudTyped = useCallback(
    async (logSeq: number) => {
      const res = await staffAction({ type: "read_aloud", logSeq });
      const text = res && res.ok ? res.speakText : undefined;
      if (!text) return;
      const started = await speakLocal(text);
      dispatch({ t: "spoken", seq: logSeq, at: started, how: started ? "local" : "none" });
      if (started) void staffAction({ type: "speak_done", ref: String(logSeq), how: "local", startedAt: started });
    },
    [staffAction],
  );

  const onEnvelope = useCallback(
    (env: BusEnvelope<StaffEvent>) => {
      dispatch({ t: "env", env });
      const m = env.msg;
      // A confirmed fixed sentence is voiced at once; names and typed text wait for a staff tap (AS-13).
      if (m.type === "guest_utterance" && m.speak.mode === "tts") {
        const entry = {
          kind: "guest",
          seq: env.seq,
          at: env.at,
          proposalId: m.proposalId,
          text: m.text,
          signs: m.signs,
          intentId: m.intentId,
          source: m.source,
          speak: m.speak,
          spokenAt: null,
          confirmedBy: m.confirmedBy,
          simulated: false,
        } as const;
        void voiceLine(entry);
      }
      if (m.type === "emergency") helpTone();
    },
    [voiceLine],
  );

  /** The "Start desk" tap: unlock audio, claim the capability, open the stream, warm the voice. */
  const start = useCallback(async () => {
    const audioOk = unlockAudio();
    dispatch({ t: "set", patch: { started: true, conn: "connecting", voice: "warming", claimError: audioOk ? null : "This browser could not start audio. Use Chrome." } });

    const m = /(?:^#|&)k=([A-Za-z0-9_-]{16,256})/.exec(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname);
    if (m) {
      const { status } = await postJson("/api/staff/claim", { k: m[1] });
      if (status === 410) dispatch({ t: "set", patch: { claimError: "This sign-in link was already used. If this screen is not signed in, ask for a new link (kill -USR2 <server pid>)." } });
      else if (status !== 200) dispatch({ t: "set", patch: { claimError: `Sign-in failed (${status}). Use the one-time link printed by the server.` } });
    }

    streamRef.current?.close();
    streamRef.current = openEventStream<StaffEvent>(
      "staff",
      {
        onMessage: onEnvelope,
        onState: (state) => {
          if (state === "open") dispatch({ t: "set", patch: { conn: "open" } });
          else if (state === "retrying") dispatch({ t: "set", patch: { conn: "retrying" } });
          else if (state === "unauthorized") dispatch({ t: "set", patch: { conn: "unauthorized" } });
        },
      },
      { watchdogMs: 15_000, retryMs: 2_000 },
    );

  }, [onEnvelope]);

  // Nath's warm-up (C1-16), once the server said whether /api/tts has a voice at all. Without one the
  // header says so instead of "ready", and fixed sentences go straight to the on-device voice.
  const ttsFlag = ui.status ? ui.status.flags.ttsAvailable !== false : null;
  ttsRef.current = ttsFlag !== false;
  useEffect(() => {
    if (ttsFlag === null || ui.voice !== "warming") return;
    if (!ttsFlag) {
      dispatch({ t: "set", patch: { voice: "local" } });
      return;
    }
    void (async () => {
      try {
        const { warmUpVoice } = await import("@/components/speakSigns");
        await warmUpVoice();
        dispatch({ t: "set", patch: { voice: "ready" } });
      } catch {
        dispatch({ t: "set", patch: { voice: "failed" } });
      }
    })();
  }, [ttsFlag, ui.voice]);

  useEffect(() => () => streamRef.current?.close(), []);

  // Repeat the Help tone every 4 s until someone taps "I'm coming".
  useEffect(() => {
    if (!ui.emergency) return;
    const id = setInterval(helpTone, 4_000);
    return () => clearInterval(id);
  }, [ui.emergency]);

  const ack = useCallback(
    async (about: AlertKind) => {
      dispatch({ t: "ack", about });
      if (about === "more_time") return void staffAction({ type: "touch" });
      await staffAction({ type: "ack", about });
    },
    [staffAction],
  );

  return {
    ui,
    start,
    staffAction,
    voiceLine,
    readAloudTyped,
    ack,
    dismissTyped: (logSeq: number) => dispatch({ t: "dismiss_typed", logSeq }),
    dismissReply: (key: number) => dispatch({ t: "dismiss_reply", key }),
    setError: (lastError: string | null) => dispatch({ t: "set", patch: { lastError } }),
  };
}

export type Desk = ReturnType<typeof useStaffDesk>;
export type SignSourceLabel = SignsSource;

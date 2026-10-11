// SignBridge app (P4, builder A): the in-memory session store (docs/app-plan.md sections 5, 6, 9).
//
// One store per process, on globalThis (runtime.ts), so every route chunk and a dev hot reload see
// the same session (SRV-19). Nothing here touches the disk, the network or process.env: the clock,
// the random source and the configuration are injected, so node --test can drive whole sessions
// (store.test.ts, including the Zq7Canary wipe test and confirm-before-speaking).
//
// What the store guarantees (each with its requirement id):
// - at most one session; Mode 0 states NO_SESSION -> WAITING_FOR_GUEST -> AWAITING_PAIR -> ACTIVE -> wiped;
// - the idle timer moves only on staff actions and accepted sign batches (AS-16, SES-8); hard cap with
//   staff-only Extend (SES-9); warnings to both screens;
// - nothing reaches a speak plan before the guest (or, display-only, staff for the guest) confirms (SPK-1);
// - `emergency` is handled before any nonce, limiter or state check and is never refused (GST-2a);
// - per-session, per-kind limits and nonce replay refusal (GST-8);
// - the wipe erases everything about the guest and keeps only counters with no personal data (SES-10);
// - guest messages carry no score, no skeleton, no counters (AS-1).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./access.ts";
import { Bus } from "./bus.ts";
import { initChecklist, onDelivered, onGuestAsked, onGuestReply, onSeen, onStaffSent } from "./checklist.ts";
import { emptyLatency, latencyStages, recordLatency, type LatencyData } from "./latency.ts";
import { barFor, lightFor, nearestIntents, type GateCandidate, type JoinedSign } from "./match.ts";
import { sanitizeGuestText, sanitizeName, sanitizeStaffText, validateGloss } from "./validate.ts";
import { guestIntent, guestSentence, staffIntent } from "./vocab.ts";
import { mapStaffTextToGloss, mapStaffTextToIntent } from "../voice/intents.ts";
import {
  FRAMING_GUIDANCE,
  GUEST_REPLY_TEXT,
  HELP_INTENT_ID,
  LIMITS,
  SESSION_PROFILES,
  type AlertKind,
  type Candidate,
  type CandidateSource,
  type CaptionSource,
  type CheckinItemStatus,
  type DeviceHealth,
  type FramingStatus,
  type GlossSource,
  type GuestAction,
  type SignControlCmd,
  type GuestEvent,
  type GuestHello,
  type GuestIntentId,
  type GuestMode,
  type GuestProposal,
  type GuestSignView,
  type GuestSnapshot,
  type GuestStaffUtterance,
  type LogEntry,
  type PairingInfo,
  type PrivacyCounters,
  type ProposalKind,
  type RecognizerMode,
  type RepeatReason,
  type SafetyWarning,
  type SafetyWarningKind,
  type SessionEndReason,
  type SessionProfile,
  type SessionState,
  type SignsSource,
  type SpeakPlan,
  type StaffAction,
  type StaffEvent,
  type StaffIntentKey,
  type StaffSignView,
  type StaffSnapshot,
  type StaffStatus,
  type VendorCall,
  type VriInfo,
  type WipeReceipt,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Configuration and results                                           */
/* ------------------------------------------------------------------ */

export type StoreConfig = {
  profile: SessionProfile;
  /** MODE0_GUEST_INPUT=1 asked for guest input; honoured only when the profile allows it (SES-14). */
  mode0GuestInputRequested: boolean;
  idleWipeMs: number;
  idleWipeUnconfirmedMs: number;
  sessionCapMs: number;
  port: number;
  simulate: boolean;
  vlmFallback: boolean;
  englishFallback: boolean;
  bridgeKeyConfigured: boolean;
  transcribeAvailable: boolean;
  /** /api/tts can make audio: ELEVENLABS_API_KEY is set, or PIPER_FALLBACK=1. Otherwise it answers 500. */
  ttsAvailable: boolean;
  /** Names only, e.g. ["OPENAI_API_KEY"]. Empty during the engagement window (D8). */
  vendorKeysConfigured: string[];
  vri: VriInfo;
  emergencyNote: string;
  /** Keys of signs/index.json: the gloss tokens the avatar can play (CAP-2). */
  knownSigns: ReadonlySet<string>;
  /**
   * LIVE_KEY_CONTROL_PORT: live_key.py --control-port on 127.0.0.1. When set, the guest's "Record a
   * sign", "Undo last sign" and "Done" go through the app server to it (consent gate and limits here),
   * and its GET /health keeps the recognizer marked as up (live_key.py sends no status event).
   */
  signControlPort: number | null;
};

export function defaultConfig(over: Partial<StoreConfig> = {}): StoreConfig {
  const profile = over.profile ?? "engagement";
  const p = SESSION_PROFILES[profile];
  return {
    profile,
    mode0GuestInputRequested: false,
    idleWipeMs: p.idleWipeMs,
    idleWipeUnconfirmedMs: p.idleWipeUnconfirmedMs,
    sessionCapMs: p.sessionCapMs,
    port: 3000,
    simulate: false,
    vlmFallback: false,
    englishFallback: false,
    bridgeKeyConfigured: false,
    transcribeAvailable: false,
    ttsAvailable: false,
    vendorKeysConfigured: [],
    vri: { label: null, url: null, contact: null },
    emergencyNote: "This app does not call 911.",
    knownSigns: new Set(),
    signControlPort: null,
    ...over,
  };
}

export type StoreDeps = { now: () => number; randomHex: (bytes: number) => string };

export const realDeps: StoreDeps = { now: () => Date.now(), randomHex: (n) => randomBytes(n).toString("hex") };

/** What a route turns into an HTTP response. `guestCookie`: a token to set, or null to expire `sb_g`. */
export type Result = { status: number; body: Record<string, unknown>; guestCookie?: string | null };

const ok = (body: Record<string, unknown> = {}): Result => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: { ok: false, error, message, ...extra },
});

const sha256 = (s: string) => createHash("sha256").update(s).digest();
function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Session data                                                        */
/* ------------------------------------------------------------------ */

type Pending = {
  proposal: GuestProposal;
  staffSigns: StaffSignView[];
  createdAt: number;
  /** Recognizer t_end in seconds, for the "utterance end to proposal shown" stage. */
  tEnd: number | null;
};

type Held = { signs: JoinedSign[]; at: number; expiresAt: number; tEnd: number; source: SignsSource; saidRepeat: boolean };

type Sent = { kind: "caption" | "proposal"; sentAt: number; captionId?: string; proposalId?: string; tEnd?: number | null };

type Caption = { id: string; text: string; intent: StaffIntentKey | null; logSeq: number };

type StoredSign = StaffSignView & { framingRejected: boolean };

type Session = {
  id: string;
  state: SessionState;
  createdAt: number;
  activeSince: number | null;
  lastActivityAt: number | null;
  capAt: number | null;
  extensions: number;
  idleWarned: boolean;
  capWarned: boolean;
  pairCodes: { hash: Buffer; expiresAt: number }[];
  burnedCodes: Buffer[];
  tokenHash: Buffer | null;
  guestMode: GuestMode;
  speakAloud: boolean;
  showAvatar: boolean;
  log: LogEntry[];
  logSeq: number;
  captions: Map<string, Caption>;
  lastCaption: GuestStaffUtterance | null;
  pending: Pending | null;
  previous: (Pending & { replacedAt: number }) | null;
  held: Held | null;
  signEvents: Map<string, StoredSign>;
  /** Utterances already processed (run, seqs, t_end), so a retried POST is a duplicate. */
  seenUtterances: Set<string>;
  evidence: StaffSignView[];
  sent: Map<number, Sent>;
  confirmedAt: Map<string, number>;
  nonces: Set<string>;
  limiters: Map<string, RateLimiter>;
  emergency: { count: number; since: number } | null;
  interpreterAt: number | null;
  moreTimeAt: number | null;
  repeatStreak: number;
  counters: StaffStatus["counters"];
  checklist: CheckinItemStatus[];
  lastHeardAt: number | null;
  heartbeatWarned: boolean;
  device: StaffStatus["guest"]["device"];
  failedJoins: number;
  /** SHA-256 (hex) of the guest window's User-Agent at join; a different one is a "device changed" signal. */
  uaHash: string | null;
  deviceChangedWarned: boolean;
};

/**
 * Per recognizer run. `sentence` = seqs of the sign events since the last utterance, for joining an
 * utterance that carries no seqs (live_key.py, live_window.py; shared contract 2026-10-11).
 */
type RunTrack = { run: string; fromRecognizer: boolean; lastSeq: number; seen: Set<number>; rejected: Set<number>; sentence: number[] };

function emptyPrivacy(keys: string[]): PrivacyCounters {
  return {
    vendorKeysConfigured: [...keys],
    vendorCalls: [],
    guestBytesOffLaptop: 0,
    messagesToGuest: 0,
    bytesToGuest: 0,
    bridgeEvents: 0,
    refusedBodyKeys: { face: 0, frames: 0, pose: 0, video: 0 },
    skeletonsHeld: 0,
    ttsFixedSentences: 0,
  };
}

/** A vendor call observed by server.mjs (only when the matching key is configured and the route answered 200). */
export type VendorTap = { route: "/api/transcribe" | "/api/tts"; bytes: number };

const VENDOR_FOR_ROUTE: Record<VendorTap["route"], Omit<VendorCall, "count" | "bytesSent">> = {
  "/api/transcribe": { destination: "api.openai.com", purpose: "Speech to text for the receptionist", route: "/api/transcribe", guestData: false, observedBy: "server_wrapper" },
  "/api/tts": {
    destination: "api.elevenlabs.io",
    purpose: "Voice for a fixed guest sentence (ElevenLabs is tried first when its key is set; Piper otherwise)",
    route: "/api/tts",
    guestData: true,
    observedBy: "server_wrapper",
  },
};

const WARNING_TEXT: Record<SafetyWarningKind, string> = {
  second_device: "Another device tried to join this conversation.",
  device_changed: "The guest device changed address or browser. Check the device and type its new number.",
  repeated_request: "A request was sent twice. This can be a network retry.",
  unusual_rate: "The guest device is sending requests unusually fast.",
  failed_pairing: "Failed pairing attempts.",
  heartbeat: "The guest screen has not been heard from for a while. Check on the guest.",
  recognizer_event: "The recognizer sent an unexpected event.",
};

/** Per-kind guest limits (plan 9.5): [count, window ms, what happens above it]. Emergency has none. */
const GUEST_LIMITS: Record<string, [number, number, "429" | "ignore" | "merge"]> = {
  guest_typed: [6, 60_000, "429"],
  guest_reply: [10, 60_000, "429"],
  guest_phrase: [10, 60_000, "429"],
  prefs: [10, 60_000, "429"],
  guest_choice: [10, 60_000, "429"],
  stop_signing: [10, 60_000, "429"],
  sign_control: [40, 60_000, "429"],
  guest_confirm: [30, 60_000, "429"],
  guest_fix: [30, 60_000, "429"],
  ack: [120, 60_000, "ignore"],
  heartbeat: [1, 2_000, "ignore"],
  more_time: [1, 30_000, "merge"],
  device_health: [1, LIMITS.deviceHealthMinIntervalMs, "ignore"],
  interpreter_request: [1, 60_000, "merge"],
};

const SETTING_TEXT: Record<GuestMode, string> = {
  choosing: "Guest is choosing how to talk",
  sign: "Guest chose to sign",
  type: "Guest chose to type",
  tap: "Guest chose to tap pictures",
  interpreter: "Guest asked for a human interpreter",
  text_only: "Guest chose text only",
};

const MAX_LOG = 500;
const MAX_EVIDENCE = 100;
const MAX_SIGN_EVENTS = 128;
const MAX_SENT = 400;
const MAX_NONCES = 4000;
const HOUSEKEEPING_MS = 2_000;
const STAFF_PING_MS = 15_000;

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export class Store {
  config: StoreConfig;
  deps: StoreDeps;
  bus = new Bus();
  session: Session | null = null;
  recognizer = {
    mode: null as RecognizerMode | null,
    fps: null as number | null,
    lastEventAt: null as number | null,
    source: null as SignsSource | null,
    framing: null as FramingStatus | null,
    framingNotOkSince: null as number | null,
    restarts: 0,
    run: null as string | null,
    /** live_key.py recording phase (shared contract 2026-10-11); not shown on a screen yet. */
    capture: null as { phase: "countdown" | "processing"; at: number; countdown: number | null; duration: number | null } | null,
    /** live_key.py control port answered GET /health at the last probe; null without a control port. */
    controlUp: null as boolean | null,
  };
  runs: Record<SignsSource, RunTrack | null> = { recognizer: null, simulated: null };
  signingAvailable = false;
  thisGuest: PrivacyCounters;
  sinceStart: PrivacyCounters;
  latency: LatencyData = emptyLatency();
  lastWipe: WipeReceipt | null = null;
  warnings: SafetyWarning[] = [];
  deviceHealth: DeviceHealth = { guest: { state: null, at: null }, staff: { state: null, at: null } };
  lastStatusAt = 0;
  lastGuestPingAt = 0;
  lastStaffPingAt = 0;
  bridgeKeyFailures = 0;
  localRuns = 0;

  constructor(config: StoreConfig, deps: StoreDeps = realDeps) {
    this.config = config;
    this.deps = deps;
    this.thisGuest = emptyPrivacy(config.vendorKeysConfigured);
    this.sinceStart = emptyPrivacy(config.vendorKeysConfigured);
  }

  /* ---------------- small helpers ---------------- */

  now(): number {
    return this.deps.now();
  }

  id(prefix: string): string {
    return prefix + this.deps.randomHex(8);
  }

  /** Mode 0 guest input is a stage compromise: only the stage profile may turn it on (D3, SES-14). */
  get displayOnly(): boolean {
    return !(SESSION_PROFILES[this.config.profile].mode0GuestInputAllowed && this.config.mode0GuestInputRequested);
  }

  bothPrivacy(f: (p: PrivacyCounters) => void): void {
    f(this.thisGuest);
    f(this.sinceStart);
  }

  toStaff(msg: StaffEvent): void {
    this.bus.toStaff(msg, this.now());
  }

  /** Sends to the guest streams of the current session and counts it on the privacy panel. Returns the seq. */
  toGuest(msg: GuestEvent): number {
    const s = this.session;
    if (!s) return 0;
    const d = this.bus.toGuest(s.id, msg, this.now());
    if (d.delivered > 0) {
      this.bothPrivacy((p) => {
        p.messagesToGuest += d.delivered;
        p.bytesToGuest += d.bytes;
      });
    }
    return d.seq;
  }

  touch(s: Session): void {
    s.lastActivityAt = this.now();
    // The idle warning is over: tell the guest so its "will end soon" line goes away (BN-5).
    if (s.idleWarned && s.state === "ACTIVE") this.toGuest({ type: "warning_cleared", kind: "idle" });
    s.idleWarned = false;
  }

  limiter(s: Session, kind: string): RateLimiter | null {
    const spec = GUEST_LIMITS[kind];
    if (!spec) return null;
    let l = s.limiters.get(kind);
    if (!l) {
      l = new RateLimiter(spec[0], spec[1], () => this.now());
      s.limiters.set(kind, l);
    }
    return l;
  }

  pushLog(s: Session, entry: LogEntry): void {
    s.log.push(entry);
    if (s.log.length > MAX_LOG) s.log.shift();
  }

  nextLogSeq(s: Session): number {
    return ++s.logSeq;
  }

  systemLine(text: string): void {
    const s = this.session;
    if (!s) return;
    this.pushLog(s, { kind: "system", seq: this.nextLogSeq(s), at: this.now(), text });
  }

  raiseWarning(kind: SafetyWarningKind, text?: string): void {
    const at = this.now();
    let w = this.warnings.find((x) => x.kind === kind && x.open);
    if (w) {
      w.count++;
      w.at = at;
      if (text) w.text = text;
    } else {
      w = { id: this.id("w"), kind, text: text ?? WARNING_TEXT[kind], at, count: 1, open: true };
      this.warnings.push(w);
      if (this.warnings.length > 50) this.warnings.shift();
    }
    this.toStaff({ type: "warning", warning: { ...w } });
  }

  /* ---------------- views ---------------- */

  idleMsInForce(): number {
    const s = this.session;
    return s && s.state === "PAIRED_UNCONFIRMED" ? this.config.idleWipeUnconfirmedMs : this.config.idleWipeMs;
  }

  hello(): GuestHello {
    return {
      type: "hello",
      mode: "mode0",
      profile: this.config.profile,
      vri: this.config.vri,
      kiosk: true,
      idleWipeMs: this.config.idleWipeMs,
      sessionCapMs: this.config.sessionCapMs,
      confirmBeforeSpeaking: true,
      emergencyNote: this.config.emergencyNote,
      check: null,
      displayOnly: this.displayOnly,
      signingAvailable: this.signingAvailable,
      signTrigger: this.config.signControlPort !== null ? "key" : "auto",
    };
  }

  guestSettings(s: Session) {
    return { type: "settings" as const, guestMode: s.guestMode, speakAloud: s.speakAloud, showAvatar: s.showAvatar };
  }

  guestSnapshot(s: Session): GuestSnapshot {
    return {
      type: "snapshot",
      state: s.state,
      settings: this.guestSettings(s),
      lastCaption: s.lastCaption,
      pending: s.pending ? s.pending.proposal : null,
      framing: this.recognizer.framing,
      signingAvailable: this.signingAvailable,
      emergencyPending: s.emergency !== null,
      warnings: this.warningsLeft(s),
    };
  }

  /** Seconds left on the idle and cap warnings that were already sent (null when not warned). */
  warningsLeft(s: Session): GuestSnapshot["warnings"] {
    const now = this.now();
    const left = (at: number) => Math.max(1, Math.round((at - now) / 1000));
    return {
      idleSecondsLeft: s.idleWarned && s.lastActivityAt !== null ? left(s.lastActivityAt + this.idleMsInForce()) : null,
      capSecondsLeft: s.capWarned && s.capAt !== null ? left(s.capAt) : null,
    };
  }

  status(): StaffStatus {
    const s = this.session;
    const r = this.recognizer;
    const now = this.now();
    const silent = r.lastEventAt === null || (r.source === "recognizer" && now - r.lastEventAt > 5_000);
    return {
      mode: "mode0",
      profile: this.config.profile,
      mode0GuestInput: !this.displayOnly,
      recognizer: {
        state: r.lastEventAt === null ? "unknown" : silent ? "down" : "up",
        mode: r.mode,
        fps: r.fps,
        lastEventAt: r.lastEventAt,
        run: r.run,
        restarts: r.restarts,
        framing: r.framing,
        framingNotOkSince: r.framingNotOkSince,
        source: r.source,
        signingAvailable: this.signingAvailable,
        trigger: this.config.signControlPort !== null ? "key" : "auto",
        controlUp: r.controlUp,
      },
      session: {
        state: s ? s.state : "NO_SESSION",
        startedAt: s ? s.activeSince : null,
        lastActivityAt: s ? s.lastActivityAt : null,
        idleWipeAt: s && s.lastActivityAt !== null && (s.state === "ACTIVE" || s.state === "PAIRED_UNCONFIRMED") ? s.lastActivityAt + this.idleMsInForce() : null,
        idleWipeMs: this.idleMsInForce(),
        capAt: s ? s.capAt : null,
        extensions: s ? s.extensions : 0,
      },
      guest: {
        device: s ? s.device : null,
        confirmedCheck: null,
        confirmTriesLeft: null,
        streams: s ? this.bus.count("guest", s.id) : 0,
        lastHeardAt: s ? s.lastHeardAt : null,
        settings: s ? { guestMode: s.guestMode, speakAloud: s.speakAloud, showAvatar: s.showAvatar } : { guestMode: "choosing", speakAloud: true, showAvatar: true },
        failedJoins: s ? s.failedJoins : 0,
      },
      counters: s ? { ...s.counters } : { repeats: 0, proposals: 0, confirmed: 0, fixed: 0, ignoredWhilePending: 0 },
      privacy: { thisGuest: structuredClone(this.thisGuest), sinceStart: structuredClone(this.sinceStart), lastWipe: this.lastWipe },
      latency: latencyStages(this.latency),
      deviceHealth: structuredClone(this.deviceHealth),
      openWarnings: this.warnings.filter((w) => w.open).length,
      flags: {
        simulateEnabled: this.config.simulate,
        vlmFallback: this.config.vlmFallback,
        englishFallback: this.config.englishFallback,
        bridgeKeyConfigured: this.config.bridgeKeyConfigured,
        transcribeAvailable: this.config.transcribeAvailable,
        ttsAvailable: this.config.ttsAvailable,
      },
      alerts: s
        ? { emergency: s.emergency ? { ...s.emergency } : null, interpreterAt: s.interpreterAt, moreTimeAt: s.moreTimeAt }
        : { emergency: null, interpreterAt: null, moreTimeAt: null },
      staffStreams: this.bus.count("staff"),
    };
  }

  staffSnapshot(): StaffSnapshot {
    const s = this.session;
    return {
      type: "snapshot",
      status: this.status(),
      log: s ? s.log.map((e) => ({ ...e })) : [],
      pairing: this.pairingInfo(),
      checklist: s ? s.checklist.map((c) => ({ ...c })) : initChecklist(),
      evidence: s ? s.evidence.map((e) => ({ ...e })) : [],
      warnings: this.warnings.map((w) => ({ ...w })),
      pending: s && s.pending ? s.pending.proposal : null,
    };
  }

  pairingInfo(): PairingInfo | null {
    // Mode 0 never shows a pairing overlay: the code exists only inside the guest window URL that
    // open_guest_window returns once. The staff snapshot therefore carries no code (it is not replayed).
    return null;
  }

  sendStatus(): void {
    this.lastStatusAt = this.now();
    this.toStaff({ type: "status", status: this.status() });
  }

  /* ---------------- streams ---------------- */

  /** A staff stream opened (the route already checked the staff cookie). */
  openStaffStream(send: (chunk: string) => boolean, close: () => void): number {
    const id = this.bus.add({ role: "staff", sessionId: null, send, close, openedAt: this.now() });
    this.bus.toOne(id, this.staffSnapshot(), this.now());
    this.sendStatus();
    return id;
  }

  /** A guest stream opened. Null when the cookie does not belong to the current session (route answers 401). */
  openGuestStream(token: string | null, send: (chunk: string) => boolean, close: () => void, ua?: string | null): number | null {
    const s = this.guestSessionFor(token, ua);
    if (!s) return null;
    const id = this.bus.add({ role: "guest", sessionId: s.id, send, close, openedAt: this.now() });
    for (const msg of [this.hello(), this.guestSnapshot(s)] as GuestEvent[]) {
      const d = this.bus.toOne(id, msg, this.now());
      this.bothPrivacy((p) => {
        p.messagesToGuest += d.delivered;
        p.bytesToGuest += d.bytes;
      });
      // A caption sent while no guest stream was open reaches the screen only in this snapshot. The
      // screen acknowledges the snapshot's seq, which then marks the caption as shown on the device.
      if (msg.type === "snapshot" && msg.lastCaption && d.delivered > 0) {
        const captionId = msg.lastCaption.id;
        const e = s.log.find((x) => x.kind === "staff" && x.id === captionId);
        if (e && e.kind === "staff" && e.shownOnDeviceAt === null) this.remember(s, d.seq, { kind: "caption", sentAt: this.now(), captionId });
      }
    }
    s.lastHeardAt = this.now();
    this.sendStatus();
    return id;
  }

  closeStream(id: number): void {
    const had = this.bus.subs.get(id);
    this.bus.drop(id);
    if (had) this.sendStatus();
  }

  /** The session whose guest token hashes to the cookie value, or null. Constant-time compare. */
  sessionForToken(token: string | null): Session | null {
    const s = this.session;
    if (!s || !s.tokenHash || !token || token.length > 200) return null;
    return sameHash(sha256(token), s.tokenHash) ? s : null;
  }

  /**
   * The session for a guest cookie, checked against the browser it was issued to. `ua` is the SHA-256
   * of the User-Agent (routes always pass it; unit tests may omit it). A valid cookie from a different
   * browser is refused and raises "device changed" once on the staff screen (a hijacked cookie; Tier 1
   * adds the address binding and the new check code). Binding to the User-Agent is a speed bump, not a
   * protection (plan 10.1).
   */
  guestSessionFor(token: string | null, ua?: string | null): Session | null {
    const s = this.sessionForToken(token);
    if (!s) return null;
    if (ua !== undefined && ua !== null && s.uaHash !== null && ua !== s.uaHash) {
      this.noteDeviceChanged(s);
      return null;
    }
    return s;
  }

  noteDeviceChanged(s: Session): void {
    if (s.deviceChangedWarned) return;
    s.deviceChangedWarned = true;
    this.systemLine("A request with this guest's cookie came from a different browser; it was refused");
    this.raiseWarning("device_changed", "A request with the guest window's cookie came from a different browser. Check the guest window; if in doubt, press End guest.");
  }

  /* ---------------- lifecycle ---------------- */

  newSession(): Session {
    return {
      id: this.id("s"),
      state: "WAITING_FOR_GUEST",
      createdAt: this.now(),
      activeSince: null,
      lastActivityAt: null,
      capAt: null,
      extensions: 0,
      idleWarned: false,
      capWarned: false,
      pairCodes: [],
      burnedCodes: [],
      tokenHash: null,
      guestMode: "choosing",
      speakAloud: true,
      showAvatar: true,
      log: [],
      logSeq: 0,
      captions: new Map(),
      lastCaption: null,
      pending: null,
      previous: null,
      held: null,
      signEvents: new Map(),
      seenUtterances: new Set(),
      evidence: [],
      sent: new Map(),
      confirmedAt: new Map(),
      nonces: new Set(),
      limiters: new Map(),
      emergency: null,
      interpreterAt: null,
      moreTimeAt: null,
      repeatStreak: 0,
      counters: { repeats: 0, proposals: 0, confirmed: 0, fixed: 0, ignoredWhilePending: 0 },
      checklist: initChecklist(),
      lastHeardAt: null,
      heartbeatWarned: false,
      device: null,
      failedJoins: 0,
      uaHash: null,
      deviceChangedWarned: false,
    };
  }

  sessionState(): void {
    const s = this.session;
    this.toStaff({ type: "session_state", state: s ? s.state : "NO_SESSION", pairing: null, device: s ? s.device : null, confirmTriesLeft: null });
  }

  /** Erases everything about the guest (SES-10). Counters with no personal data stay in sinceStart. */
  wipe(reason: SessionEndReason): WipeReceipt | null {
    const s = this.session;
    if (!s) return null;
    const pendingLost = s.pending !== null || s.held !== null;
    this.toGuest({ type: "session_end", reason, pendingLost });
    this.bus.closeGuests(s.id);
    const itemsErased =
      s.log.length + s.evidence.length + s.signEvents.size + s.captions.size + (s.pending ? 1 : 0) + (s.previous ? 1 : 0) + (s.held ? 1 : 0) +
      (s.tokenHash ? 1 : 0) + s.pairCodes.length + s.nonces.size;
    const receipt: WipeReceipt = { at: this.now(), reason, itemsErased };
    // Drop every reference first, then clear the containers, so nothing about the guest is reachable.
    s.log.length = 0;
    s.evidence.length = 0;
    s.signEvents.clear();
    s.seenUtterances.clear();
    s.captions.clear();
    s.sent.clear();
    s.confirmedAt.clear();
    s.nonces.clear();
    s.limiters.clear();
    s.pairCodes.length = 0;
    s.burnedCodes.length = 0;
    s.pending = null;
    s.previous = null;
    s.held = null;
    s.lastCaption = null;
    s.tokenHash = null;
    s.uaHash = null;
    s.device = null;
    s.emergency = null;
    s.checklist = initChecklist();
    this.session = null;
    this.lastWipe = receipt;
    this.thisGuest = emptyPrivacy(this.config.vendorKeysConfigured);
    this.latency = emptyLatency();
    this.deviceHealth.guest = { state: null, at: null };
    for (const w of this.warnings) w.open = false;
    this.warnings = [];
    this.sinceStart.skeletonsHeld = 0;
    this.toStaff({ type: "session_end", reason, receipt });
    this.sendStatus();
    return receipt;
  }

  /** Staff "New guest": ends any old session, starts WAITING_FOR_GUEST. */
  startNewGuest(): Result {
    if (this.session) this.wipe("staff_ended");
    this.session = this.newSession();
    this.sessionState();
    this.sendStatus();
    return ok();
  }

  /** Mode 0: a fresh 128-bit code inside http://localhost:PORT/guest#p=<code> (SES-1a). At most two live codes. */
  openGuestWindow(): Result {
    const s = this.session;
    if (!s) return fail(409, "conflict", "Press New guest first.");
    if (s.state !== "WAITING_FOR_GUEST" && s.state !== "AWAITING_PAIR") {
      return fail(409, "conflict", "A guest window is already connected. Use Reconnect guest window or End guest.");
    }
    const code = Buffer.from(this.deps.randomHex(LIMITS.pairCodeBytes), "hex").toString("base64url");
    const now = this.now();
    s.pairCodes = s.pairCodes.filter((c) => c.expiresAt > now);
    while (s.pairCodes.length >= LIMITS.pairCodesLive) s.pairCodes.shift();
    s.pairCodes.push({ hash: sha256(code), expiresAt: now + LIMITS.pairCodeTtlMs });
    s.state = "AWAITING_PAIR";
    this.sessionState();
    this.sendStatus();
    return ok({ guestUrl: `http://localhost:${this.config.port}/guest#p=${code}` });
  }

  /** POST /api/guest/join on the loopback listener with Host localhost (Mode 0): confirmed at once. */
  join(code: unknown, address: string, ua: string | null = null): Result {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return fail(400, "bad_request", "This link is not complete. Ask the front desk to connect this screen.");
    const s = this.session;
    const now = this.now();
    const h = sha256(code);
    const live = s ? s.pairCodes.filter((c) => c.expiresAt > now) : [];
    if (s && s.state === "AWAITING_PAIR" && live.some((c) => sameHash(h, c.hash))) {
      const token = Buffer.from(this.deps.randomHex(LIMITS.guestTokenBytes), "hex").toString("base64url");
      s.burnedCodes.push(...s.pairCodes.map((c) => c.hash));
      s.pairCodes = [];
      s.tokenHash = sha256(token);
      s.uaHash = ua;
      s.deviceChangedWarned = false;
      s.state = "ACTIVE";
      s.activeSince = now;
      s.lastActivityAt = now;
      s.capAt = now + this.config.sessionCapMs;
      s.idleWarned = false;
      s.capWarned = false;
      s.device = { deviceClass: "Guest window on this laptop (Mode 0)", address: "this laptop", joinedAt: now };
      s.lastHeardAt = now;
      this.systemLine(this.displayOnly ? "Guest window connected on this laptop (display only)" : "Guest window connected on this laptop (guest input on)");
      this.sessionState();
      this.sendStatus();
      return { ...ok({ check: null, hello: this.hello() }), guestCookie: token };
    }
    // Failure: a used code is a second-device signal; every failure counts against the address.
    if (s && s.burnedCodes.some((b) => sameHash(h, b))) this.raiseWarning("second_device");
    if (s) s.failedJoins++;
    const lim = this.joinFailLimiter(address);
    if (!lim.take()) return fail(429, "rate_limited", "Too many attempts from this device. Wait a minute.");
    return fail(410, "gone", "This link has expired or was already used. Ask the front desk to connect this screen.");
  }

  joinLimiters = new Map<string, RateLimiter>();
  joinFailLimiter(address: string): RateLimiter {
    let l = this.joinLimiters.get(address);
    if (!l) {
      if (this.joinLimiters.size > 256) this.joinLimiters.clear();
      l = new RateLimiter(LIMITS.joinFailsPerAddressPerMin, 60_000, () => this.now());
      this.joinLimiters.set(address, l);
    }
    return l;
  }

  /** POST /api/guest/leave: "I'm finished" (or the page after session_end). Always expires the cookie. */
  leave(token: string | null, ua?: string | null): Result {
    const s = this.guestSessionFor(token, ua);
    if (s) this.wipe("guest_left");
    return { ...ok(), guestCookie: null };
  }

  /* ---------------- staff actions ---------------- */

  staffAction(a: StaffAction): Result {
    const s = this.session;
    const needActive = (): Result | null => (s && s.state === "ACTIVE" ? null : fail(409, "conflict", "No guest window is connected yet."));
    const r = (() => {
      switch (a.type) {
        case "new_guest":
          return this.startNewGuest();
        case "open_guest_window":
          return this.openGuestWindow();
        case "guest_is_here":
        case "refresh_code":
        case "confirm_pair":
          return fail(409, "conflict", "Pairing a separate guest device is not part of this build (Mode 0 only; Mode C is Tier 1).");
        case "repair":
          return this.repair();
        case "end_guest":
          if (!s) return fail(409, "conflict", "There is no guest to end.");
          this.wipe("staff_ended");
          return ok({ receipt: this.lastWipe });
        case "extend": {
          if (!s || s.capAt === null) return fail(409, "conflict", "There is no conversation to extend.");
          if (s.capAt - this.now() > LIMITS.capWarnBeforeMs) return fail(409, "conflict", "Extend is offered in the last 2 minutes.");
          s.capAt += LIMITS.extendMs;
          s.extensions++;
          s.capWarned = false;
          this.toGuest({ type: "warning_cleared", kind: "cap" });
          this.systemLine("Staff extended the conversation by 5 minutes");
          return ok();
        }
        case "touch":
          return s ? ok() : fail(409, "conflict", "There is no conversation.");
        case "say_quick":
          return needActive() ?? this.sayQuick(a.intent);
        case "say_text":
          return needActive() ?? this.sayText(a.text, a.gloss, a.source);
        case "ack":
          return s ? this.staffAck(a.about) : fail(409, "conflict", "There is no conversation.");
        case "speak_name":
          return s ? this.speakName(a.proposalId) : fail(409, "conflict", "There is no conversation.");
        case "read_aloud":
          return s ? this.readAloud(a.logSeq) : fail(409, "conflict", "There is no conversation.");
        case "speak_done":
          return s ? this.speakDone(a.ref, a.how, a.startedAt) : ok();
        case "confirm_for_guest":
          if (!this.displayOnly) return fail(409, "conflict", "The guest confirms on their own screen in this mode.");
          return needActive() ?? this.confirm(a.proposalId, a.candidateId, undefined, "staff_for_guest");
        case "reject_for_guest":
          if (!this.displayOnly) return fail(409, "conflict", "The guest confirms on their own screen in this mode.");
          return needActive() ?? this.fix(a.proposalId, "not_this");
        case "choice_for_guest":
          if (!this.displayOnly) return fail(409, "conflict", "The guest chooses on their own screen in this mode.");
          return needActive() ?? this.choose(a.choice);
        case "checklist_seen":
          if (!s) return fail(409, "conflict", "There is no conversation.");
          s.checklist = onSeen(s.checklist, a.item, this.now());
          this.toStaff({ type: "checklist", items: s.checklist.map((c) => ({ ...c })) });
          return ok();
        case "dismiss_warning": {
          const w = this.warnings.find((x) => x.id === a.id);
          if (w) w.open = false;
          return ok();
        }
        case "device_health":
          this.deviceHealth.staff = { state: a.state, at: this.now() };
          this.toStaff({ type: "device_health", who: "staff", state: a.state });
          return ok();
        case "note_vendor":
          this.noteVendorCall({ destination: a.destination, purpose: "Browser speech recognition used by the receptionist (staff voice only)", route: "staff page", guestData: false, observedBy: "staff_browser" }, 0);
          return ok();
        default:
          // docs/features-plan.md: caption_backend, live_caption, retract_caption, set_fact, clear_fact,
          // resend_facts, send_alert and cancel_alert are typed but not built yet (Builder S).
          return fail(404, "not_found", "This feature is not built yet.");
      }
    })();
    // Every successful staff action is activity (AS-16), except a report from the staff page itself.
    if (r.status === 200 && this.session && this.session.state === "ACTIVE" && a.type !== "speak_done" && a.type !== "device_health" && a.type !== "note_vendor") {
      this.touch(this.session);
    }
    if (r.status === 200) this.sendStatus();
    return r;
  }

  repair(): Result {
    const s = this.session;
    if (!s) return fail(409, "conflict", "Press New guest first.");
    if (s.state === "ACTIVE") {
      this.toGuest({ type: "session_end", reason: "repaired", pendingLost: s.pending !== null });
      this.bus.closeGuests(s.id);
      s.tokenHash = null;
      s.pending = null;
      s.previous = null;
      s.held = null;
      s.state = "AWAITING_PAIR";
      this.systemLine("Staff reconnected the guest window");
    }
    return this.openGuestWindow();
  }

  caption(s: Session, text: string, gloss: string[], glossSource: GlossSource, captionSource: CaptionSource, intent: StaffIntentKey | null): Result {
    const now = this.now();
    const id = this.id("c");
    const msg: GuestStaffUtterance = { type: "staff_utterance", id, text, gloss, glossSource, captionSource };
    s.lastCaption = msg;
    const logSeq = this.nextLogSeq(s);
    s.captions.set(id, { id, text, intent, logSeq });
    if (s.captions.size > 100) s.captions.delete(s.captions.keys().next().value as string);
    this.pushLog(s, { kind: "staff", seq: logSeq, at: now, id, text, gloss, captionSource, glossSource, intent, shownOnDeviceAt: null, guestReply: null });
    const seq = this.toGuest(msg);
    this.remember(s, seq, { kind: "caption", sentAt: now, captionId: id });
    s.checklist = onStaffSent(s.checklist, intent, text, now);
    this.toStaff({ type: "staff_utterance", id, text, gloss, glossSource, captionSource, intent });
    this.toStaff({ type: "checklist", items: s.checklist.map((c) => ({ ...c })) });
    return ok({ captionId: id });
  }

  remember(s: Session, seq: number, rec: Sent): void {
    s.sent.set(seq, rec);
    if (s.sent.size > MAX_SENT) s.sent.delete(s.sent.keys().next().value as number);
  }

  sayQuick(key: StaffIntentKey): Result {
    const s = this.session as Session;
    const intent = staffIntent(key);
    if (!intent) return fail(400, "bad_request", "Unknown quick reply.");
    return this.caption(s, intent.text, [...intent.gloss], "fixed_intent", "quick_reply", key);
  }

  /** Typed or reviewed voice text (CAP-2): client gloss if every token is valid, else P1's local mapping, else captions only. */
  sayText(raw: string, clientGloss: string[] | null, source: "voice" | "typed"): Result {
    const s = this.session as Session;
    const t = sanitizeStaffText(raw);
    if (!t.ok) return fail(400, "bad_request", t.message, { field: "text" });
    const known = this.config.knownSigns;
    let gloss = clientGloss ? validateGloss(clientGloss, known) : null;
    let glossSource: GlossSource = gloss ? "p1_gloss" : "none";
    if (!gloss) {
      gloss = validateGloss(mapStaffTextToGloss(t.value, new Set(known)).gloss, known);
      if (gloss) glossSource = "p1_local_match";
    }
    const m = mapStaffTextToIntent(t.value, new Set(known));
    const intent = m.intentId !== "unknown" ? (m.intentId as StaffIntentKey) : null;
    return this.caption(s, t.value, gloss ?? [], gloss ? glossSource : "none", source, intent);
  }

  staffAck(about: AlertKind): Result {
    const s = this.session as Session;
    if (about === "emergency") s.emergency = null;
    if (about === "interpreter") this.systemLine("Staff are arranging an interpreter");
    if (about === "more_time") s.moreTimeAt = null;
    if (about === "emergency" || about === "interpreter") this.toGuest({ type: "staff_ack", about });
    this.toStaff({ type: "staff_ack", about });
    return ok();
  }

  speakName(proposalId: string): Result {
    const s = this.session as Session;
    const e = s.log.find((x) => x.kind === "guest" && x.proposalId === proposalId);
    if (!e || e.kind !== "guest" || e.speak.mode !== "local_after_tap" || e.speak.tap !== "speak_name") return fail(404, "not_found", "No name is waiting to be spoken.");
    if (!s.speakAloud) return fail(409, "conflict", "The guest turned off reading aloud.");
    return ok({ speakText: e.text });
  }

  readAloud(logSeq: number): Result {
    const s = this.session as Session;
    const e = s.log.find((x) => x.seq === logSeq);
    if (!e || e.kind !== "guest_typed") return fail(404, "not_found", "No typed message with that number.");
    if (!s.speakAloud || s.guestMode === "text_only") return fail(409, "conflict", "The guest turned off reading aloud.");
    return ok({ speakText: e.text });
  }

  /** The staff page reports how and when it voiced a sentence (latency "Send to speech", privacy TTS count). */
  speakDone(ref: string, how: "tts" | "local" | "none", startedAt: number): Result {
    const s = this.session as Session;
    const now = this.now();
    const typed = /^typed-(\d+)$/.exec(ref);
    const e = typed ? s.log.find((x) => x.seq === Number(typed[1])) : s.log.find((x) => x.kind === "guest" && x.proposalId === ref);
    if (!e) return ok();
    if (e.kind === "guest") {
      if (how !== "none") e.spokenAt = startedAt;
      const at = s.confirmedAt.get(ref);
      if (at !== undefined && how !== "none" && e.speak.mode === "tts") recordLatency(this.latency, "say_it_to_speech", startedAt - at);
      if (how === "tts") {
        if (e.speak.mode !== "tts") return fail(409, "conflict", "Only fixed sentences go to the voice route.");
        this.bothPrivacy((p) => p.ttsFixedSentences++);
      }
    } else if (e.kind === "guest_typed" && how === "local") {
      e.readAloudAt = startedAt;
    }
    void now;
    return ok();
  }

  noteVendorCall(v: Omit<VendorCall, "count" | "bytesSent">, bytes: number): void {
    this.bothPrivacy((p) => {
      let c = p.vendorCalls.find((x) => x.destination === v.destination && x.route === v.route);
      if (!c) {
        c = { ...v, count: 0, bytesSent: 0 };
        p.vendorCalls.push(c);
      }
      c.count++;
      c.bytesSent += bytes;
      if (v.guestData) p.guestBytesOffLaptop += bytes;
    });
  }

  /** Drains the vendor-call taps that server.mjs records (runtime.ts passes them in). */
  noteVendorTaps(taps: VendorTap[]): void {
    for (const t of taps) {
      const v = VENDOR_FOR_ROUTE[t.route];
      if (v) this.noteVendorCall(v, Math.max(0, Math.floor(t.bytes)));
    }
  }

  noteBridgeKeyFailure(): void {
    this.bridgeKeyFailures++;
    this.raiseWarning("recognizer_event", "The recognizer (or another program on this laptop) sent events with a wrong key.");
  }

  /* ---------------- guest actions ---------------- */

  /** Help: before any nonce, limiter or state check; never refused (C1-15, GST-2a). Merged with a count. */
  emergency(token: string | null, ua?: string | null): Result {
    // Help is accepted even from a changed browser (plan 4.3 step 7: Help works while paused); the
    // change is still reported to staff.
    const s = this.sessionForToken(token);
    if (!s) return fail(401, "unauthorized", "This screen is not connected. Wave or knock at the desk.");
    if (ua !== undefined && ua !== null && s.uaHash !== null && ua !== s.uaHash) this.noteDeviceChanged(s);
    const now = this.now();
    if (s.emergency) s.emergency.count++;
    else s.emergency = { count: 1, since: now };
    s.lastHeardAt = now;
    this.systemLine(s.emergency.count === 1 ? "Guest pressed Get staff now" : `Guest pressed Get staff now (${s.emergency.count} times)`);
    this.toStaff({ type: "emergency", count: s.emergency.count });
    return ok();
  }

  guestAction(token: string | null, a: GuestAction, ua?: string | null): Result {
    if (a.type === "emergency") return this.emergency(token, ua);
    const s = this.guestSessionFor(token, ua);
    if (!s) return fail(401, "unauthorized", "This screen is not connected. Ask the front desk to connect it.");
    const now = this.now();
    // Nonce: catches retries, not a compromised device (C1-21).
    if (s.nonces.has(a.n)) {
      this.raiseWarning("repeated_request");
      return fail(409, "conflict", "This request was already received.");
    }
    s.nonces.add(a.n);
    if (s.nonces.size > MAX_NONCES) s.nonces.delete(s.nonces.values().next().value as string);
    // Per-kind limiter (one kind never uses another's budget).
    const spec = GUEST_LIMITS[a.type];
    const lim = this.limiter(s, a.type);
    if (spec && lim && !lim.take()) {
      if (spec[2] === "429") {
        this.raiseWarning("unusual_rate");
        return fail(429, "rate_limited", "Please wait a moment.");
      }
      return ok({ merged: true });
    }
    if (a.type === "ack") return this.ack(s, a.seq);
    if (a.type === "heartbeat") {
      s.lastHeardAt = now;
      s.heartbeatWarned = false;
      return ok();
    }
    if (a.type === "device_health") {
      // Mode 0 windows are team-owned (kiosk); reports only, never "spyware detection" (GST-6).
      this.deviceHealth.guest = { state: a.state, at: now };
      this.toStaff({ type: "device_health", who: "guest", state: a.state });
      return ok();
    }
    if (s.state !== "ACTIVE") return fail(409, "conflict", "Please wait, the desk is connecting this screen.");
    if (this.displayOnly) return fail(409, "conflict", "This screen is display only. Point to the card on the counter.");
    s.lastHeardAt = now;
    switch (a.type) {
      case "guest_choice":
        return this.choose(a.choice);
      case "stop_signing":
        return this.setMode(s, "choosing");
      case "sign_control":
        return this.signControl(s, a.cmd);
      case "guest_confirm":
        return this.confirm(a.proposalId, a.candidateId, a.name, "guest", a.voice !== false);
      case "guest_fix":
        return this.fix(a.proposalId, a.action);
      case "guest_phrase":
        return this.phrase(a.intentId, a.name, a.voice !== false);
      case "guest_typed":
        return this.typed(a.text);
      case "guest_reply":
        return this.reply(a.reply, a.captionId);
      case "interpreter_request":
        return this.interpreter();
      case "prefs":
        return this.prefs(a.speakAloud, a.showAvatar);
      case "more_time":
        s.moreTimeAt = now;
        this.toStaff({ type: "more_time", on: a.on });
        return ok();
    }
    return fail(400, "bad_request", "Unknown action.");
  }

  ack(s: Session, seq: number): Result {
    const now = this.now();
    s.lastHeardAt = now;
    s.heartbeatWarned = false;
    const rec = s.sent.get(seq);
    if (!rec) return ok();
    s.sent.delete(seq);
    const rt = now - rec.sentAt;
    const kept = recordLatency(this.latency, "app_to_guest_screen", rt);
    if (rec.kind === "caption" && rec.captionId) {
      const c = s.captions.get(rec.captionId);
      const e = s.log.find((x) => x.kind === "staff" && x.id === rec.captionId);
      if (e && e.kind === "staff" && e.shownOnDeviceAt === null) e.shownOnDeviceAt = now;
      if (c) {
        s.checklist = onDelivered(s.checklist, c.intent, c.text, now);
        this.toStaff({ type: "checklist", items: s.checklist.map((x) => ({ ...x })) });
      }
    }
    if (rec.kind === "proposal" && typeof rec.tEnd === "number") {
      recordLatency(this.latency, "utterance_to_proposal_shown", now - rec.tEnd * 1000);
    }
    this.toStaff({ type: "delivered", eventSeq: seq, roundTripMs: kept ? rt : null, captionId: rec.captionId ?? null });
    return ok();
  }

  setMode(s: Session, mode: GuestMode): Result {
    if (s.guestMode === mode) {
      this.toGuest(this.guestSettings(s));
      return ok();
    }
    s.guestMode = mode;
    if (mode !== "sign") s.held = null;
    const at = this.now();
    this.pushLog(s, { kind: "guest_setting", seq: this.nextLogSeq(s), at, text: SETTING_TEXT[mode] });
    this.toGuest(this.guestSettings(s));
    this.toStaff({ type: "guest_choice", guestMode: s.guestMode, speakAloud: s.speakAloud, showAvatar: s.showAvatar });
    if (mode === "sign" && this.recognizer.framing) this.toGuest({ type: "framing", status: this.recognizer.framing, text: FRAMING_GUIDANCE[this.recognizer.framing] });
    return ok();
  }

  /**
   * live_key.py control (shared contract 2026-10-11). The store only decides; the route forwards an
   * accepted command to 127.0.0.1:LIVE_KEY_CONTROL_PORT and reports back with noteSignControl.
   * Recording needs the consent gate (the guest chose Sign) and no sentence waiting for confirmation.
   */
  signControl(s: Session, cmd: SignControlCmd): Result {
    if (this.config.signControlPort === null) return fail(409, "conflict", "The desk camera starts by itself here. Just sign.");
    if (s.guestMode !== "sign") return fail(409, "conflict", "Choose Sign first.");
    if (!this.signingAvailable) return fail(409, "conflict", "Signing is not available right now. Please type or ask for an interpreter.");
    if (s.pending) return fail(409, "conflict", "Choose Say it, Text only or Fix for the sentence on screen first.");
    return ok({ forward: cmd });
  }

  /** After the route forwarded a sign_control command: undo bookkeeping, or a staff line when it failed. */
  noteSignControl(cmd: SignControlCmd, delivered: boolean): void {
    const s = this.session;
    if (!delivered) {
      this.recognizer.controlUp = false;
      this.updateSigningAvailable();
      if (s) this.systemLine("The camera program did not answer the guest's button. Check that live_key.py is running");
      this.sendStatus();
      return;
    }
    if (!s) return;
    // No touch here: a sign_control tap is guest-device input, and only staff actions and accepted
    // desk-camera signs move the idle timer (AS-16, SES-8). The sign the tap produces touches in ingest.
    if (cmd !== "undo") return;
    const t = this.runs.recognizer;
    const seq = t?.sentence.pop();
    if (seq === undefined) return;
    this.systemLine("Guest undid the last sign");
    this.toGuest({ type: "live_sign_undone", seq });
    this.toStaff({ type: "live_sign_undone", seq });
  }

  /** The runtime probes live_key.py's GET /health every second (only with a control port). */
  noteControlHealth(up: boolean): void {
    const r = this.recognizer;
    const changed = r.controlUp !== up;
    r.controlUp = up;
    if (up) {
      // live_key.py sends no status event; an answering control port is its heartbeat. A status event,
      // if one ever arrives, still sets the mode (mock, no_model) and wins.
      r.lastEventAt = this.now();
      r.source = "recognizer";
      if (r.mode === null) r.mode = "ok";
    }
    this.updateSigningAvailable();
    if (changed) this.sendStatus();
  }

  choose(choice: "sign" | "type" | "tap" | "interpreter" | "text_only"): Result {
    const s = this.session as Session;
    if (choice === "sign" && !this.signingAvailable) {
      return fail(409, "conflict", "Signing is not available right now. Please type or ask for an interpreter.");
    }
    const r = this.setMode(s, choice);
    if (choice === "interpreter") this.interpreter();
    return r;
  }

  interpreter(): Result {
    const s = this.session as Session;
    const now = this.now();
    if (s.interpreterAt !== null && now - s.interpreterAt < 60_000) return ok({ merged: true });
    s.interpreterAt = now;
    this.systemLine("Guest asked for a human interpreter");
    this.toStaff({ type: "interpreter_request", vri: this.config.vri });
    return ok();
  }

  prefs(speakAloud?: boolean, showAvatar?: boolean): Result {
    const s = this.session as Session;
    const at = this.now();
    const lines: string[] = [];
    if (speakAloud !== undefined && speakAloud !== s.speakAloud) {
      s.speakAloud = speakAloud;
      lines.push(speakAloud ? "Guest turned on reading aloud" : "Guest turned off reading aloud");
    }
    if (showAvatar !== undefined && showAvatar !== s.showAvatar) {
      s.showAvatar = showAvatar;
      lines.push(showAvatar ? "Guest turned on the avatar" : "Guest turned off the avatar");
    }
    for (const text of lines) this.pushLog(s, { kind: "guest_setting", seq: this.nextLogSeq(s), at, text });
    this.toGuest(this.guestSettings(s));
    this.toStaff({ type: "guest_choice", guestMode: s.guestMode, speakAloud: s.speakAloud, showAvatar: s.showAvatar });
    return ok();
  }

  typed(raw: string): Result {
    const s = this.session as Session;
    const t = sanitizeGuestText(raw);
    if (!t.ok) return fail(400, "bad_request", t.message, { field: "text" });
    const at = this.now();
    this.pushLog(s, { kind: "guest_typed", seq: this.nextLogSeq(s), at, text: t.value, readAloudAt: null });
    this.toStaff({ type: "guest_typed", text: t.value });
    this.toGuest({ type: "guest_utterance", proposalId: null, text: t.value, delivery: s.speakAloud && s.guestMode !== "text_only" ? "waiting_for_staff" : "shown" });
    return ok({ logSeq: s.logSeq });
  }

  reply(kind: keyof typeof GUEST_REPLY_TEXT, captionId: string | null): Result {
    const s = this.session as Session;
    const at = this.now();
    const c = captionId ? s.captions.get(captionId) : undefined;
    if (captionId && !c) return fail(409, "conflict", "That message is no longer on screen.");
    if (c) {
      const e = s.log.find((x) => x.kind === "staff" && x.id === c.id);
      if (e && e.kind === "staff") e.guestReply = kind;
      s.checklist = onGuestReply(s.checklist, c.intent, kind, at);
      this.toStaff({ type: "checklist", items: s.checklist.map((x) => ({ ...x })) });
    }
    this.pushLog(s, { kind: "guest_reply", seq: this.nextLogSeq(s), at, reply: kind, captionId });
    this.toStaff({ type: "guest_reply", reply: kind, captionId });
    return ok();
  }

  /* ---------------- proposals and confirm-before-speaking ---------------- */

  /** `voice` false = the guest's own "Text only" for this sentence (BN-1): shown at the desk, never voiced. */
  planSpeak(needsName: boolean, intentId: GuestIntentId, fixedText: string, testMode: boolean, voice = true): SpeakPlan {
    const s = this.session as Session;
    if (testMode) return { mode: "none", why: "test_mode" };
    if (!voice) return { mode: "none", why: "guest_chose_text" };
    if (s.guestMode === "text_only") return { mode: "none", why: "text_only" };
    if (!s.speakAloud) return { mode: "none", why: "read_aloud_off" };
    if (needsName) return { mode: "local_after_tap", tap: "speak_name" };
    return { mode: "tts", intentId, fixedText };
  }

  findProposal(s: Session, proposalId: string): Pending | null {
    if (s.pending && s.pending.proposal.proposalId === proposalId) return s.pending;
    if (s.previous && s.previous.proposal.proposalId === proposalId && this.now() - s.previous.replacedAt <= LIMITS.proposalGraceMs) return s.previous;
    return null;
  }

  /**
   * A confirm or fix for a proposal that is no longer pending and past its grace period (plan 6.6,
   * "Repeated request"). A proposal the guest already answered is remembered in confirmedAt / closed,
   * so a double tap is reported as a possible retry, gently.
   */
  staleProposal(_s: Session, _proposalId: string): void {
    this.raiseWarning("repeated_request");
  }

  clearProposal(s: Session, p: Pending): void {
    if (s.pending === p) s.pending = null;
    if (s.previous === p) s.previous = null;
  }

  confirm(proposalId: string, candidateId: string, rawName: string | undefined, by: "guest" | "staff_for_guest", voice = true): Result {
    const s = this.session as Session;
    const p = this.findProposal(s, proposalId);
    if (!p) {
      this.staleProposal(s, proposalId);
      return fail(409, "conflict", "This suggestion is no longer waiting. Please sign again or type.");
    }
    if (p.proposal.testMode) return fail(409, "conflict", "Test mode: these signs were invented by a test program and will not be spoken.");
    const cand = p.proposal.candidates.find((c) => c.candidateId === candidateId);
    if (!cand || cand.intentId === null) return fail(400, "bad_request", "Unknown choice.");
    let name: string | null = null;
    if (cand.needsName) {
      if (by !== "guest") return fail(409, "conflict", "The guest needs to type the name on their own screen.");
      const n = sanitizeName(rawName);
      if (!n.ok) return fail(400, "bad_request", n.message, { field: "name" });
      name = n.value;
    }
    this.clearProposal(s, p);
    return this.finishUtterance(s, {
      proposalId: p.proposal.proposalId,
      echoProposalId: p.proposal.proposalId,
      signs: p.staffSigns,
      intentId: cand.intentId,
      name,
      source: cand.source,
      by,
      simulated: p.proposal.simulated,
      testMode: p.proposal.testMode,
      voice,
    });
  }

  /** A request picked from the phrase list, already confirmed on the guest screen (GST-10). */
  phrase(intentId: GuestIntentId, rawName: string | undefined, voice = true): Result {
    const s = this.session as Session;
    const g = guestIntent(intentId);
    if (!g) return fail(400, "bad_request", "Unknown request.");
    let name: string | null = null;
    if (g.needsName) {
      const n = sanitizeName(rawName);
      if (!n.ok) return fail(400, "bad_request", n.message, { field: "name" });
      name = n.value;
    }
    return this.finishUtterance(s, { proposalId: this.id("ph"), echoProposalId: null, signs: [], intentId, name, source: "phrase", by: "guest", simulated: false, testMode: false, voice });
  }

  finishUtterance(
    s: Session,
    u: { proposalId: string; echoProposalId: string | null; signs: StaffSignView[]; intentId: GuestIntentId; name: string | null; source: CandidateSource; by: "guest" | "staff_for_guest"; simulated: boolean; testMode: boolean; voice?: boolean },
  ): Result {
    const g = guestIntent(u.intentId);
    if (!g) return fail(400, "bad_request", "Unknown request.");
    const at = this.now();
    const text = guestSentence(g, u.name);
    const speak = this.planSpeak(g.needsName, g.id, g.text, u.testMode, u.voice !== false);
    this.pushLog(s, {
      kind: "guest", seq: this.nextLogSeq(s), at, proposalId: u.proposalId, text, signs: u.signs, intentId: g.id, source: u.source,
      speak, spokenAt: null, confirmedBy: u.by, simulated: u.simulated,
    });
    s.confirmedAt.set(u.proposalId, at);
    s.counters.confirmed++;
    s.repeatStreak = 0;
    s.checklist = onGuestAsked(s.checklist, g.id, at);
    this.toStaff({ type: "guest_utterance", proposalId: u.proposalId, signs: u.signs, text, intentId: g.id, source: u.source, speak, confirmedBy: u.by });
    this.toStaff({ type: "checklist", items: s.checklist.map((x) => ({ ...x })) });
    const delivery = speak.mode === "tts" ? "spoken" : speak.mode === "local_after_tap" ? "waiting_for_staff" : "shown";
    this.toGuest({ type: "guest_utterance", proposalId: u.echoProposalId, text, delivery });
    // "I need some help, please." confirmed by the guest is also the Help alert ("Yes, get staff").
    if (g.id === HELP_INTENT_ID && u.by === "guest") this.emergencyFor(s);
    return ok({ proposalId: u.proposalId });
  }

  emergencyFor(s: Session): void {
    if (s.emergency) s.emergency.count++;
    else s.emergency = { count: 1, since: this.now() };
    this.toStaff({ type: "emergency", count: s.emergency.count });
  }

  fix(proposalId: string, action: "sign_again" | "type" | "interpreter" | "not_this"): Result {
    const s = this.session as Session;
    const p = this.findProposal(s, proposalId);
    if (!p) {
      this.staleProposal(s, proposalId);
      return fail(409, "conflict", "This suggestion is no longer waiting.");
    }
    this.clearProposal(s, p);
    s.counters.fixed++;
    this.toStaff({ type: "guest_fix", proposalId, action });
    if (action === "type") return this.setMode(s, "type");
    if (action === "interpreter") {
      this.setMode(s, "interpreter");
      return this.interpreter();
    }
    if (action === "sign_again" && s.guestMode !== "sign" && this.signingAvailable) return this.setMode(s, "sign");
    return ok();
  }

  /** Creates and sends a proposal (gate outcome or unmatched). Callers handle pending protection. */
  propose(kind: ProposalKind, cands: GateCandidate[] | { intentId: GuestIntentId; source: CandidateSource }[], staffSigns: StaffSignView[], tEnd: number | null, source: SignsSource): string {
    const s = this.session as Session;
    const proposalId = this.id("p");
    const candidates: Candidate[] = cands.map((c, i) => {
      const g = guestIntent(c.intentId);
      return {
        candidateId: `${proposalId}-${i}`,
        intentId: c.intentId,
        text: g ? (g.needsName ? "My name is ..." : g.text) : "",
        needsName: g ? g.needsName : false,
        source: c.source,
      };
    });
    const proposal: GuestProposal = {
      type: "guest_proposal",
      proposalId,
      kind,
      signs: staffSigns.map(guestView),
      candidates,
      testMode: this.recognizer.mode === "mock",
      simulated: source === "simulated",
    };
    const now = this.now();
    if (s.pending) s.previous = { ...s.pending, replacedAt: now };
    s.pending = { proposal, staffSigns, createdAt: now, tEnd };
    s.counters.proposals++;
    s.repeatStreak = 0;
    const seq = this.toGuest(proposal);
    this.remember(s, seq, { kind: "proposal", sentAt: now, proposalId, tEnd });
    return proposalId;
  }

  /* ---------------- sweeper ---------------- */

  /** Called every 500 ms by the runtime sweeper (and by tests with a fake clock). */
  tick(): void {
    const now = this.now();
    const s = this.session;
    if (s) {
      s.pairCodes = s.pairCodes.filter((c) => c.expiresAt > now);
      if (s.state === "ACTIVE" && s.lastActivityAt !== null) {
        const idleAt = s.lastActivityAt + this.idleMsInForce();
        if (now >= idleAt) {
          this.wipe("idle");
          return this.housekeeping(now);
        }
        // BN-5: two minutes before the wipe, but never earlier than halfway, so a short idle limit
        // (engagement, 2 min) does not show the warning on every activity.
        const warnBefore = Math.min(LIMITS.idleWarnBeforeMs, Math.floor(this.idleMsInForce() / 2));
        if (!s.idleWarned && now >= idleAt - warnBefore) {
          s.idleWarned = true;
          const secondsLeft = Math.max(1, Math.round((idleAt - now) / 1000));
          this.toGuest({ type: "idle_warning", secondsLeft, canAskForTime: false });
          this.toStaff({ type: "idle_warning", secondsLeft });
        }
      }
      if (s.capAt !== null) {
        if (now >= s.capAt) {
          this.wipe("cap");
          return this.housekeeping(now);
        }
        if (!s.capWarned && now >= s.capAt - LIMITS.capWarnBeforeMs) {
          s.capWarned = true;
          const secondsLeft = Math.max(1, Math.round((s.capAt - now) / 1000));
          this.toGuest({ type: "cap_warning", secondsLeft, canAskForTime: false });
          this.toStaff({ type: "cap_warning", secondsLeft });
        }
      }
      if (s.held && now >= s.held.expiresAt) finalizeHeld(this);
      if (s.state === "ACTIVE" && s.lastHeardAt !== null && !s.heartbeatWarned && now - s.lastHeardAt >= LIMITS.heartbeatRedMs) {
        s.heartbeatWarned = true;
        this.raiseWarning("heartbeat", `The guest screen was last heard ${Math.round((now - s.lastHeardAt) / 1000)} s ago. Check on the guest.`);
      }
    }
    this.housekeeping(now);
  }

  housekeeping(now: number): void {
    // Recognizer silence: 5 s without an event from the real recognizer makes signing unavailable (C1-9).
    this.updateSigningAvailable();
    if (now - this.lastGuestPingAt >= LIMITS.guestPingMs) {
      this.lastGuestPingAt = now;
      this.bus.ping("guest");
    }
    if (now - this.lastStaffPingAt >= STAFF_PING_MS) {
      this.lastStaffPingAt = now;
      this.bus.ping("staff");
    }
    if (now - this.lastStatusAt >= HOUSEKEEPING_MS && this.bus.count("staff") > 0) this.sendStatus();
  }

  updateSigningAvailable(): void {
    const r = this.recognizer;
    const now = this.now();
    const fresh = r.lastEventAt !== null && (r.source === "simulated" || now - r.lastEventAt <= 5_000);
    const avail = fresh && r.mode === "ok";
    if (avail !== this.signingAvailable) {
      this.signingAvailable = avail;
      if (this.session) this.toGuest({ type: "signing_available", available: avail });
      this.sendStatus();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Bridge ingest (plan 6.1 to 6.3, BRG-1 to BRG-9, SPK-8, SPK-9)       */
/* ------------------------------------------------------------------ */

export function guestView(v: StaffSignView): GuestSignView {
  return { seq: v.seq, label: v.top[0].label, light: v.light, red: v.red };
}

function staffView(j: JoinedSign, extra: { tSignStart: number | null; tSignEnd: number | null; tPredicted: number | null; receivedAt: number; skeleton: StaffSignView["skeleton"] }): StaffSignView {
  const l = lightFor(j);
  return { seq: j.seq, top: j.top, joined: j.joined, light: l.light, red: l.red, bar: barFor(j.top[0].label), ...extra };
}

/** Turns a held (unmatched) utterance into "Not a request we know" with up to three nearest requests. */
export function finalizeHeld(store: Store): void {
  const s = store.session;
  if (!s || !s.held) return;
  const h = s.held;
  s.held = null;
  const labels = h.signs.map((j) => j.top[0].label);
  const near = nearestIntents(labels).map((g) => ({ intentId: g.id, source: "nearest" as const }));
  const views = h.signs.map((j) => staffView(j, { tSignStart: null, tSignEnd: null, tPredicted: null, receivedAt: h.at, skeleton: null }));
  const proposalId = store.propose("unmatched", near, views, h.tEnd, h.source);
  store.toStaff({
    type: "recognition", source: h.source, receivedAt: store.now(), signs: views, outcome: "unmatched", repeatReason: null,
    recognizerSaidRepeat: h.saidRepeat, candidates: s.pending ? s.pending.proposal.candidates : [], proposalId, testMode: store.recognizer.mode === "mock",
  });
}

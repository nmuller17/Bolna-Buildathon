// ConversAI app (P4): shared types for the server, the staff screen and the guest screen.
//
// Rules for this file:
// - Erasable TypeScript only (no enums, no namespaces, no parameter properties), so that
//   Node 22 type stripping can run the unit tests that import it.
// - No imports. Every other module in web/lib/app/** may import from here; nothing here
//   imports from anywhere else.
// - Runtime values are limited to constants that both sides must agree on (labels, limits).
// - The plan that explains every type is docs/app-plan.md.

/* ------------------------------------------------------------------ */
/* Recognition vocabulary (docs/vocabulary.md section 3)              */
/* ------------------------------------------------------------------ */

/** The 22 classifier labels, in the order of docs/vocabulary.md section 3. */
export const SIGN_LABELS = [
  "YES",
  "NO",
  "RESERVATION",
  "NAME",
  "THANK-YOU",
  "WHERE",
  "ELEVATOR",
  "FS-WIFI",
  "PASSWORD",
  "BREAKFAST",
  "TIME",
  "TOWEL",
  "MORE",
  "FS-CHECKOUT",
  "LATE",
  "PLEASE",
  "PARKING",
  "TAXI",
  "HELP",
  "ROOM",
  "RESTAURANT",
  "NONE",
] as const;

export type SignLabel = (typeof SIGN_LABELS)[number];

/** Top-1 confidence must be at least this value (0.6 passes, 0.5999 fails). CLAUDE.md 7.2 step 4. */
export const CONF_THRESHOLD = 0.6;

/* ------------------------------------------------------------------ */
/* Limits shared by validators, UI and tests                           */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** Signs per recognizer POST. */
  minSigns: 1,
  maxSigns: 8,
  /** Alternatives per sign in the top-k payload shape. */
  maxTop: 5,
  /** Guest name, after normalization, in Unicode code points. */
  nameMin: 1,
  nameMax: 40,
  /** Free text typed by the guest. */
  guestTypedMax: 280,
  /** Free text typed or transcribed for the staff side. */
  staffTextMax: 300,
  /** Gloss tokens accepted from /api/gloss or the client. */
  glossMaxTokens: 40,
  glossTokenMaxLen: 32,
  /** Request body caps in bytes. */
  bodySmallJson: 4 * 1024,
  bodySignsJson: 8 * 1024,
  bodyAudio: 5 * 1024 * 1024,
  /** Session timing defaults in milliseconds (overridable by env, see the plan). */
  idleWipeMs: 120_000,
  idleWarnBeforeMs: 30_000,
  pairCodeTtlMs: 300_000,
  sseHeartbeatMs: 15_000,
  recognizerPollMs: 5_000,
  /** Secrets: random bytes before base64url encoding (>= 16 bytes = 128 bits). */
  pairCodeBytes: 16,
  guestTokenBytes: 32,
  /** Minimum length of BRIDGE_KEY in characters; shorter keys disable /api/guest/signs. */
  bridgeKeyMinLen: 32,
  /** Concurrent SSE streams per role. */
  maxGuestStreams: 3,
  maxStaffStreams: 4,
} as const;

/* ------------------------------------------------------------------ */
/* Predictions and recognizer payloads                                 */
/* ------------------------------------------------------------------ */

/** Wire shape from CLAUDE.md 6.5 before validation. Never trust it. */
export type RawPrediction = { label: string; conf: number };

/** A validated prediction: label is in SIGN_LABELS, conf is finite and within [0, 1]. */
export type Prediction = { label: SignLabel; conf: number };

/**
 * One recognized sign after validation. `top` is sorted by conf, highest first,
 * so `top[0]` is the top-1 prediction. Length 1..LIMITS.maxTop.
 */
export type SignResult = { top: Prediction[] };

/** Recognizer payload, shape A: top-1 per sign. */
export type SignsPayloadTop1 = { signs: RawPrediction[] };
/** Recognizer payload, shape B: top-k per sign (P3 /predict returns top 3). */
export type SignsPayloadTopK = { signs: { top: RawPrediction[] }[] };
/** Body of POST /api/guest/signs and POST /api/dev/simulate. */
export type SignsPayload = SignsPayloadTop1 | SignsPayloadTopK;

/** Where a batch of signs came from. Simulated batches are labelled on the staff screen. */
export type SignsSource = "recognizer" | "simulated";

/** Result of the confidence gate. `weak` holds the indexes of the signs that failed. */
export type GateResult =
  | { ok: true; labels: SignLabel[] }
  | { ok: false; reason: RepeatReason; weak: number[] };

export type RepeatReason = "low_confidence" | "none_sign";

/* ------------------------------------------------------------------ */
/* Intents (docs/vocabulary.md sections 1 and 2)                       */
/* ------------------------------------------------------------------ */

export type IntentNumber =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

export type StaffIntentId = IntentNumber;
export type GuestIntentId = IntentNumber;

export type FacialMarker = "brows-up" | "brows-down";

/** A receptionist sentence with its fixed gloss (vocabulary.md section 1). */
export type StaffIntent = {
  id: StaffIntentId;
  /** Exact sentence from the table, e.g. "Do you have a reservation?" */
  text: string;
  /** Exact gloss tokens, including a leading BROWS-UP / BROWS-DOWN marker when present. */
  gloss: string[];
  marker: FacialMarker | null;
  /** Short button label for the quick-reply grid, e.g. "Reservation?" */
  short: string;
};

/** A guest request with its sign multiset and fixed sentence (vocabulary.md section 2). */
export type GuestIntent = {
  id: GuestIntentId;
  /** Signs in the documented order. Matching ignores order (multiset equality). */
  signs: SignLabel[];
  /** Fixed spoken sentence. For the NAME intent this is the template "My name is {name}." */
  text: string;
  /** True only for intent 4 (NAME): the guest types a name before "Say it". */
  needsName: boolean;
};

/** The guest intent id that takes a typed name. */
export const NAME_INTENT_ID: GuestIntentId = 4;

/** Result of matching gated labels against the 20 guest intents. */
export type MatchResult =
  | { kind: "intent"; intentId: GuestIntentId; text: string; needsName: boolean; source: "table" }
  | { kind: "llm"; text: string; source: "llm" }
  | { kind: "unmatched" };

/* ------------------------------------------------------------------ */
/* Small shared value types                                            */
/* ------------------------------------------------------------------ */

/** Where a staff sentence came from. */
export type CaptionSource = "quick_reply" | "voice" | "typed";

/** How the gloss for a staff sentence was produced. "none" = captions only. */
export type GlossSource = "fixed_intent" | "p1_gloss" | "app_match" | "none";

/** What the guest chose on the first screen. */
export type GuestMode = "choosing" | "sign" | "type" | "interpreter";

export type AlertKind = "emergency" | "interpreter" | "typed";

export type SessionEndReason = "staff_ended" | "idle" | "repaired" | "server_restart";

/** Human interpreter (VRI) details shown to the guest. Configured by env, not secret. */
export type VriInfo = { label: string; url: string | null; phone: string | null };

/**
 * How the staff laptop should voice a confirmed guest sentence.
 * - "tts": fixed intent sentence, ElevenLabs configured: POST /api/tts { id }.
 * - "local": speechSynthesis with a voice whose localService === true (always for NAME).
 * - "none": the guest chose text only, or no local voice exists; show the text only.
 */
export type SpeakPlan =
  | { mode: "tts"; ttsId: GuestIntentId }
  | { mode: "local" }
  | { mode: "none" };

/** Top-1 view of a sign, the only recognition detail the guest device receives. */
export type GuestSignView = { label: SignLabel; conf: number };

/* ------------------------------------------------------------------ */
/* Event bus: envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every SSE `data:` line is one JSON envelope. `seq` is per session and monotonic;
 * it is also the SSE `id:`. `at` is server time in ms since epoch.
 */
export type BusEnvelope<M> = { seq: number; at: number; msg: M };

/* ------------------------------------------------------------------ */
/* Event bus: messages the GUEST device receives                       */
/* ------------------------------------------------------------------ */
// Guest messages carry no counters, no keys, no top-3 alternatives, no other guests,
// no privacy or recognizer status. The two unions are separate on purpose: the server
// builds a guest message from GuestEvent only, so staff-only fields cannot leak by accident.

export type GuestHello = {
  type: "hello";
  vri: VriInfo;
  idleWipeMs: number;
  /** Always true in this build; shown on the data notice. */
  confirmBeforeSpeaking: true;
  /** Text-to-911 note, configurable per site. */
  emergencyNote: string;
};

export type GuestSnapshot = {
  type: "snapshot";
  mode: GuestMode;
  speakAloud: boolean;
  lastCaption: GuestStaffUtterance | null;
  pending: GuestProposal | null;
};

/** CLAUDE.md 6.7 staff_utterance, extended with id and glossSource. */
export type GuestStaffUtterance = {
  type: "staff_utterance";
  id: string;
  text: string;
  /** May be empty: then the guest sees captions only. */
  gloss: string[];
  glossSource: GlossSource;
};

/** CLAUDE.md 6.7 repeat_request, extended. Guest sees "Please sign that again." */
export type GuestRepeatRequest = {
  type: "repeat_request";
  reason: RepeatReason;
  /** Top-1 words that were seen, so the guest can tell which sign was unclear. */
  signs: GuestSignView[];
  weak: number[];
  /** Consecutive repeats in this session; at 3+ the guest screen promotes "Type instead". */
  streak: number;
};

/** Recognized signs offered to the guest for confirmation. `match` null = unmatched. */
export type GuestProposal = {
  type: "guest_proposal";
  proposalId: string;
  signs: GuestSignView[];
  match:
    | { intentId: GuestIntentId; text: string; needsName: boolean; source: "table" }
    | { intentId: null; text: string; needsName: false; source: "llm" }
    | null;
};

/** Echo after "Say it": the sentence was sent to the desk. */
export type GuestUtteranceEcho = {
  type: "guest_utterance";
  proposalId: string | null;
  text: string;
  spokenAloud: boolean;
};

export type GuestStaffAck = { type: "staff_ack"; about: AlertKind };

export type GuestIdleWarning = { type: "idle_warning"; secondsLeft: number };

export type GuestSessionEnd = { type: "session_end"; reason: SessionEndReason };

export type GuestEvent =
  | GuestHello
  | GuestSnapshot
  | GuestStaffUtterance
  | GuestRepeatRequest
  | GuestProposal
  | GuestUtteranceEcho
  | GuestStaffAck
  | GuestIdleWarning
  | GuestSessionEnd;

/* ------------------------------------------------------------------ */
/* Event bus: messages the STAFF screen receives                       */
/* ------------------------------------------------------------------ */

export type VendorCall = {
  /** Host name, e.g. "api.openai.com", or "browser speech service" for Web Speech. */
  destination: string;
  /** Plain words, e.g. "Speech to text for the receptionist". */
  purpose: string;
  /** App route that made or relayed the call, e.g. "/api/transcribe". */
  route: string;
  count: number;
  bytesSent: number;
  /** True when the bytes were derived from the guest (labels, a guest sentence). */
  guestData: boolean;
  /** Who counted it: our own route code, the server.mjs wrapper, or the staff browser. */
  observedBy: "app_route" | "server_wrapper" | "staff_browser";
};

export type PrivacyCounters = {
  vendorCalls: VendorCall[];
  /** Bytes of guest-derived data sent off the laptop. 0 unless /api/english or /api/tts called a vendor. */
  guestBytesOffLaptop: number;
  /** Bus messages delivered to the guest device or the staff screen. */
  messagesRelayed: number;
  /** Always 0: the app has no file-writing code (checked by a test). */
  filesWritten: 0;
  /** Always 0: the app never receives or sends video. */
  videoFrames: 0;
};

export type RecognizerState = "up" | "down" | "unknown";

export type StaffStatus = {
  recognizer: {
    state: RecognizerState;
    url: string;
    lastCheckAt: number | null;
    /** Last accepted POST /api/guest/signs, from the recognizer or the simulator. */
    lastPostAt: number | null;
  };
  guest: {
    paired: boolean;
    connected: boolean;
    streams: number;
    lastSeenAt: number | null;
    mode: GuestMode;
    speakAloud: boolean;
  };
  session: {
    active: boolean;
    startedAt: number | null;
    lastActivityAt: number | null;
    idleWipeMs: number;
    /** Pairing code expiry when a code is waiting to be scanned, else null. */
    pairExpiresAt: number | null;
  };
  counters: {
    repeatRequests: number;
    proposals: number;
    confirmed: number;
    fixed: number;
  };
  /** Counters for the current guest and since the app started. */
  privacy: { thisGuest: PrivacyCounters; sinceStart: PrivacyCounters };
  latency: {
    /** Recognizer POST received -> guest device rendered the proposal (includes the ack trip). */
    signToProposalMs: number | null;
    /** Staff send -> guest device rendered the caption (includes the ack trip). */
    staffToCaptionMs: number | null;
  };
  flags: {
    englishFallback: boolean;
    ttsAvailable: boolean;
    simulateEnabled: boolean;
    guestLan: boolean;
    bridgeKeyConfigured: boolean;
  };
};

/** One line of the in-memory conversation log on the staff screen. */
export type LogEntry =
  | { kind: "staff"; seq: number; at: number; text: string; gloss: string[]; captionSource: CaptionSource; glossSource: GlossSource }
  | { kind: "guest"; seq: number; at: number; text: string; signs: SignResult[]; intentId: GuestIntentId | null; source: "table" | "llm" }
  | { kind: "guest_typed"; seq: number; at: number; text: string }
  | { kind: "repeat"; seq: number; at: number; reason: RepeatReason }
  | { kind: "system"; seq: number; at: number; text: string };

export type StaffSnapshot = {
  type: "snapshot";
  status: StaffStatus;
  log: LogEntry[];
  pairing: PairingInfo | null;
  lastRecognition: StaffRecognition | null;
};

export type StaffSessionStart = { type: "session_start"; pairing: PairingInfo };

export type StaffStaffUtterance = {
  type: "staff_utterance";
  id: string;
  text: string;
  gloss: string[];
  glossSource: GlossSource;
  captionSource: CaptionSource;
  intentId: StaffIntentId | null;
};

/** Full recognition detail for the dashboard: top-3 bars, gate result, match. */
export type StaffRecognition = {
  type: "recognition";
  source: SignsSource;
  receivedAt: number;
  signs: SignResult[];
  gate: "pass" | RepeatReason;
  match: { intentId: GuestIntentId | null; text: string | null; source: "table" | "llm" } | null;
  proposalId: string | null;
};

export type StaffRepeatRequest = { type: "repeat_request"; reason: RepeatReason; count: number; streak: number };

export type StaffGuestUtterance = {
  type: "guest_utterance";
  proposalId: string;
  signs: SignResult[];
  text: string;
  intentId: GuestIntentId | null;
  source: "table" | "llm";
  speak: SpeakPlan;
};

export type StaffGuestFix = { type: "guest_fix"; proposalId: string; action: "sign_again" | "type" };
export type StaffGuestTyped = { type: "guest_typed"; text: string };
export type StaffGuestChoice = { type: "guest_choice"; choice: GuestMode; speakAloud: boolean };
export type StaffInterpreterRequest = { type: "interpreter_request"; vri: VriInfo };
export type StaffEmergency = { type: "emergency" };
export type StaffStaffAck = { type: "staff_ack"; about: AlertKind };
export type StaffIdleWarning = { type: "idle_warning"; secondsLeft: number };
export type StaffSessionEnd = { type: "session_end"; reason: SessionEndReason };
export type StaffStatusEvent = { type: "status"; status: StaffStatus };

export type StaffEvent =
  | StaffSnapshot
  | StaffSessionStart
  | StaffStaffUtterance
  | StaffRecognition
  | StaffRepeatRequest
  | StaffGuestUtterance
  | StaffGuestFix
  | StaffGuestTyped
  | StaffGuestChoice
  | StaffInterpreterRequest
  | StaffEmergency
  | StaffStaffAck
  | StaffIdleWarning
  | StaffSessionEnd
  | StaffStatusEvent;

export type Role = "guest" | "staff";

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

export type PairingInfo = {
  /** Single-use code, base64url of LIMITS.pairCodeBytes random bytes. Only ever shown on the staff screen. */
  code: string;
  /** http://<host>:<port>/guest?s=<code>; the host is LAN_IP when GUEST_LAN=1, else 127.0.0.1. */
  guestUrl: string;
  /** Same URL broken into groups of 4 characters for typing on a second laptop. */
  displayUrl: string;
  expiresAt: number;
  lan: boolean;
};

/* ------------------------------------------------------------------ */
/* Actions (request bodies)                                            */
/* ------------------------------------------------------------------ */

/** POST /api/guest/join body. */
export type GuestJoinRequest = { code: string };

/** POST /api/guest/action body; header X-Session-Token carries the guest token. */
export type GuestAction =
  | { type: "guest_choice"; choice: "sign" | "type" | "interpreter" }
  | { type: "stop_signing" }
  | { type: "guest_confirm"; proposalId: string; name?: string }
  | { type: "guest_fix"; proposalId: string; action: "sign_again" | "type" }
  | { type: "guest_typed"; text: string }
  | { type: "interpreter_request" }
  | { type: "emergency" }
  | { type: "prefs"; speakAloud: boolean }
  /** Render acknowledgement used only for latency; does not count as activity. */
  | { type: "ack"; seq: number };

/** POST /api/staff/action body (loopback only). */
export type StaffAction =
  | { type: "new_guest" }
  | { type: "repair" }
  | { type: "end_guest" }
  | { type: "say_quick"; intentId: StaffIntentId }
  | { type: "say_text"; text: string; gloss: string[] | null; source: "voice" | "typed" }
  | { type: "ack"; about: AlertKind }
  | { type: "touch" }
  | { type: "note_vendor"; destination: "browser speech service" }
  | { type: "prewarm_tts" };

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "bad_request"          // 400: body failed validation
  | "unauthorized"         // 401: missing or wrong token / X-Bridge-Key
  | "forbidden"            // 403: not loopback, bad Host, bad Origin, or not a fixed TTS id
  | "not_found"            // 404: feature switched off (english fallback, tts without key)
  | "conflict"             // 409: no session, proposal not pending, guest not signing
  | "gone"                 // 410: pairing code used or expired
  | "too_large"            // 413
  | "unsupported_type"     // 415
  | "rate_limited"         // 429
  | "upstream_failed"      // 502: vendor call failed
  | "not_configured";      // 503: BRIDGE_KEY missing or too short

export type ApiError = { ok: false; error: ErrorCode; message: string };

export type GuestJoinResponse = { ok: true; guestToken: string; hello: GuestHello } | ApiError;

export type GuestActionResponse = { ok: true } | ApiError;

export type StaffActionResponse =
  | { ok: true; pairing?: PairingInfo }
  | ApiError;

/** POST /api/guest/signs and POST /api/dev/simulate. */
export type SignsIngestResponse =
  | { ok: true; outcome: "proposal" | "repeat" | "unmatched"; proposalId: string | null }
  | ApiError;

/** GET /api/staff/benchmark. Numbers are copied from files, never invented. */
export type BenchmarkFile = {
  name: string;
  modifiedAt: number;
  synthetic: boolean;
  /** Only keys found in the file; missing keys stay undefined. */
  summary: {
    n?: number;
    accuracy?: number;
    openSetFalseAccept?: number;
    signerType?: string;
    modelHash?: string;
  };
  recognized: boolean;
};

export type BenchmarkResponse = {
  ok: true;
  dir: string;
  files: BenchmarkFile[];
  /** False when no non-synthetic report exists: the card says "No real-data benchmark yet". */
  realDataAvailable: boolean;
};

/* ------------------------------------------------------------------ */
/* Teammate contracts (CLAUDE.md 6.5), for typing the fallbacks        */
/* ------------------------------------------------------------------ */

/** P1 POST /api/transcribe response. */
export type TranscribeResponse = { text: string };
/** P1 POST /api/gloss request and response. */
export type GlossRequest = { text: string };
export type GlossResponse = { gloss: string[] };
/** P4 POST /api/english (behind ENGLISH_FALLBACK=1). Labels only. */
export type EnglishRequest = { signs: RawPrediction[] };
export type EnglishResponse = { text: string };
/** P4 POST /api/tts: fixed guest intent id only, never free text. Response is audio/mpeg. */
export type TtsRequest = { id: GuestIntentId };
/** P2 avatar player (CLAUDE.md 6.6), detected at runtime by the sign-output swap point. */
export type PlayGloss = (gloss: string[]) => Promise<void>;

// SignBridge app (P4): shared types for the server, the staff screen and the guest screen.
//
// Rules for this file:
// - Erasable TypeScript only (no enums, no namespaces, no parameter properties), so that
//   Node 22 type stripping can run the unit tests that import it.
// - No imports. Every other module in web/lib/app/** may import from here; nothing here
//   imports from anywhere else.
// - Runtime values are limited to constants that both sides must agree on (labels, limits,
//   tables). Logic lives in the pure modules listed in docs/app-plan.md section 10.
// - The plan that explains every type is docs/app-plan.md (sections cited as "plan N").
// - Precedence: engagement/decision_record.md, then docs/app-plan.md, then everything else.

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
  "LEAVE",
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

/**
 * Old classifier labels still emitted by an older recognizer build, mapped to the current label.
 * LEAVE replaced FS-CHECKOUT on 2026-10-10 (docs/vocabulary.md); recognition/labels.py on
 * p3-recognition still says FS-CHECKOUT until the model is retrained.
 */
export const SIGN_LABEL_ALIASES: Readonly<Record<string, SignLabel>> = { "FS-CHECKOUT": "LEAVE" };

/* ------------------------------------------------------------------ */
/* Confidence gate and traffic lights (plan 6.3)                       */
/* ------------------------------------------------------------------ */

/** Default bar for a sign's top-1 confidence (0.6 passes, 0.5999 fails). CLAUDE.md 7.2 step 4. */
export const CONF_THRESHOLD = 0.6;

/**
 * Harm-weighted bars: a wrong YES/NO, NAME, ROOM or HELP does more harm, so these labels need more
 * confidence. PROVISIONAL values; P3 sets the final ones from audited calibration (plan 15 q2).
 */
export const HARM_THRESHOLDS: Readonly<Partial<Record<SignLabel, number>>> = {
  YES: 0.75,
  NO: 0.75,
  NAME: 0.75,
  ROOM: 0.75,
  HELP: 0.75,
};

/** Green "sure" at or above this (and at or above the label's bar). */
export const LIGHT_GREEN_MIN = 0.8;

/**
 * Traffic light for one recognised sign. Always shown with a word and a shape, never colour alone:
 * green = "sure" (filled), amber = "fairly sure" (half), red = "unclear" (hollow).
 */
export type TrafficLight = "green" | "amber" | "red";

/** Why a sign is red. "framing" = the recognizer rejected it because the guest was not framed. */
export type RedReason = "below_bar" | "none_sign" | "framing";

/* ------------------------------------------------------------------ */
/* Limits shared by validators, UI and tests                           */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** Signs per utterance (bridge contract: 1..8). */
  minSigns: 1,
  maxSigns: 8,
  /** Alternatives accepted per sign (the bridge sends 3). */
  maxTop: 5,
  /** Guest name, after normalization, in Unicode code points. */
  nameMin: 1,
  nameMax: 40,
  /** Free text typed by the guest. */
  guestTypedMax: 280,
  /** Free text typed or transcribed for the staff side, in characters, and the caption cap in UTF-8 bytes. */
  staffTextMax: 300,
  captionMaxBytes: 600,
  /** Gloss tokens accepted from /api/gloss or the client (RT8). */
  glossMaxTokens: 40,
  glossFingerspellMaxLen: 32,
  /** Request body caps in bytes. */
  bodySmallJson: 4 * 1024,
  bodyBridgeJson: 8 * 1024,
  bodyAudio: 5 * 1024 * 1024,
  /** Skeleton snapshot on a bridge sign event: at most this many bytes of JSON (plan 6.2). */
  skeletonMaxBytes: 2 * 1024,
  /** Session timing (overridable by env). */
  idleWipeMs: 120_000,
  idleWipeUnconfirmedMs: 60_000,
  idleWarnBeforeMs: 30_000,
  sessionCapMs: 15 * 60_000,
  capWarnBeforeMs: 2 * 60_000,
  extendMs: 5 * 60_000,
  /** Pairing (decision record D6). */
  pairCodeTtlMs: 120_000,
  pairQrRefreshMs: 60_000,
  pairCodeBytes: 16,
  guestTokenBytes: 32,
  checkDigits: 6,
  confirmTries: 3,
  joinFailsPerAddressPerMin: 5,
  staffCapabilityBytes: 32,
  /** Bridge (recognition/README.md "App bridge"). */
  bridgeKeyMinLen: 32,
  bridgeMaxAgeMs: 5_000,
  bridgePerSecond: 10,
  /** Streams and connections. Guest streams: newest wins. */
  maxGuestStreams: 2,
  maxStaffStreams: 4,
  maxConnPerAddress: 8,
  sseRetryMs: 2_000,
  staffHeartbeatMs: 15_000,
  guestWatchdogMs: 5_000,
  /** Guest heartbeat on the staff header (AS-21): amber after, red after. */
  heartbeatAmberMs: 20_000,
  heartbeatRedMs: 45_000,
  /** Guest-reported latency outside 0..this is dropped (AS-22). */
  guestLatencyMaxMs: 10_000,
  /** Device-health reports from the guest device, at most one per this interval. */
  deviceHealthMinIntervalMs: 10_000,
  /** LATER (OPS-5, Mode W only): constant-size guest frames. */
  sseSlotMs: 250,
  sseFrameBytes: 2048,
  /** Recognizer health poll (optional /health on the recognizer server). */
  recognizerPollMs: 5_000,
  /** Help presses merged above this count raise an "unusual rate" warning. */
  emergencyWarnCount: 5,
} as const;

/* ------------------------------------------------------------------ */
/* Deployment (decision record D3, plan 2)                             */
/* ------------------------------------------------------------------ */

/**
 * mode0 = guest window on a wired second display, loopback only, staff confirms for the guest.
 * modeC = one Ethernet cable, guest listener HTTPS on LAN_IP:3443.
 * modeW = travel router, only if gate G2 passed. There is no plain-HTTP LAN mode.
 */
export type DeploymentMode = "mode0" | "modeC" | "modeW";

/** Which listener a request arrived on. The listener decides the role, never the socket address. */
export type Listener = "staff" | "guest";

/* ------------------------------------------------------------------ */
/* Predictions                                                         */
/* ------------------------------------------------------------------ */

/** Wire shape from CLAUDE.md 6.5 before validation. Never trust it. */
export type RawPrediction = { label: string; conf: number };

/** A validated prediction: label is in SIGN_LABELS (after aliases), conf is finite and within [0, 1]. */
export type Prediction = { label: SignLabel; conf: number };

/* ------------------------------------------------------------------ */
/* Recognizer bridge events (recognition/README.md "App bridge")      */
/* ------------------------------------------------------------------ */
// live.py --post sends each event as its own POST to /api/guest/signs with X-Bridge-Key.
// Times are Unix seconds (float) from the laptop's clock, comparable with Date.now() / 1000.
// The app checks `type`, ignores unknown keys, and validates every known key strictly.
// Keys face, frames, pose, video are refused outright (only the optional skeleton carries points).

export type FramingStatus = "OK" | "STEP_BACK" | "MOVE_CAMERA_DOWN" | "COME_CLOSER" | "CENTER" | "HANDS_OUT" | "NO_PERSON";

/** Guest-screen wording for each framing status (plan 6.4; the app's copy of framing.GUIDANCE). */
export const FRAMING_GUIDANCE: Readonly<Record<FramingStatus, string>> = {
  OK: "Ready: sign when you like",
  STEP_BACK: "Please step back: your head to your waist should be in the picture",
  MOVE_CAMERA_DOWN: "Your waist is below the picture. Staff will tilt the camera down",
  COME_CLOSER: "Please come a little closer",
  CENTER: "Please move to the middle of the picture",
  HANDS_OUT: "Keep your hands inside the picture",
  NO_PERSON: "Please stand in front of the desk camera",
};

/** Staff-screen wording where it differs from the guest's. */
export const FRAMING_STAFF_HINT: Readonly<Partial<Record<FramingStatus, string>>> = {
  MOVE_CAMERA_DOWN: "Tilt the desk camera down",
};

/** A 2-D point in the model's normalized coordinates, rounded to 3 decimals. */
export type Point2 = [number, number];

/**
 * OPTIONAL skeleton snapshot on a sign event (contract change requested from P3, plan 6.2).
 * One frame from the middle of the sign, no face. Staff only, memory only, wiped with the session.
 */
export type SkeletonSnapshot = {
  /** Capture time of the frame, Unix seconds. */
  t: number;
  /** Exactly 7 points: pose 0 (nose), 11, 12 (shoulders), 13, 14 (elbows), 15, 16 (wrists). */
  pose: Point2[];
  /** 21 points each, or null when the hand was not seen. */
  lh: Point2[] | null;
  rh: Point2[] | null;
};

export type BridgeSign = {
  type: "sign";
  /** Counts signs from 1 for the recognizer process; a fall back to 1 means a restart. */
  seq: number;
  /** Top 3, best first (re-sorted on the server). */
  top: RawPrediction[];
  t_sign_start: number;
  t_sign_end: number;
  t_closed: number;
  t_predicted: number;
  t_sent: number;
  skeleton?: SkeletonSnapshot;
};

export type BridgeUtterance = {
  type: "utterance";
  /** Top-1 of each sign, in order, 1..8. */
  signs: RawPrediction[];
  seqs: number[];
  /** recognizer.needs_repeat: any sign NONE or below 0.6. The app repeats if either side says so. */
  needs_repeat: boolean;
  t_end: number;
  t_sent: number;
};

export type BridgeFraming = {
  type: "framing";
  status: FramingStatus;
  since: number;
  /** Present when a sign was not classified because under 80% of its frames were framed OK. */
  rejected_seq?: number;
  t_sent: number;
};

export type RecognizerMode = "ok" | "mock" | "no_model";

export type BridgeStatus = {
  type: "status";
  fps: number;
  /** "mock" = invented answers: proposals become test mode and are never spoken. */
  recognizer: RecognizerMode;
  t: number;
  t_sent: number;
};

/**
 * RESERVED (plan 6.8): a local vision-model suggestion from P3's process. Ignored with 404 unless
 * VLM_FALLBACK=1, and even then only ever a candidate the guest must confirm.
 */
export type BridgeVlmSuggestion = {
  type: "vlm_suggestion";
  seq: number;
  label: string;
  conf: number;
  model: string;
  t_sent: number;
};

export type BridgeEvent = BridgeSign | BridgeUtterance | BridgeFraming | BridgeStatus | BridgeVlmSuggestion;

/** Where an event came from. Simulated events are labelled on the staff screen. */
export type SignsSource = "recognizer" | "simulated";

/** Response of POST /api/guest/signs and POST /api/dev/simulate. */
export type BridgeIngestResponse =
  | {
      ok: true;
      outcome: "stored" | "proposal" | "repeat" | "status" | "stale" | "duplicate";
      proposalId: string | null;
    }
  | ApiError;

/** GET /api/guest/signs: whether the app currently accepts signs (guest chose Sign, session active). */
export type BridgeAcceptingResponse = { ok: true; accepting: boolean };

/* ------------------------------------------------------------------ */
/* Intents (docs/vocabulary.md sections 1 and 2)                       */
/* ------------------------------------------------------------------ */

/**
 * The 20 receptionist intents, in vocabulary.md section 1 order, using the string ids of P1's
 * web/lib/voice/intents.ts STAFF_INTENTS so quick replies, P1's matcher and the checklist agree.
 */
export const STAFF_INTENT_KEYS = [
  "welcome",
  "reservation_question",
  "name_question",
  "id_please",
  "nights_question",
  "room_number",
  "key_card",
  "elevator_left",
  "breakfast_time",
  "wifi_password",
  "checkout_time",
  "late_checkout",
  "send_towels",
  "parking_downstairs",
  "restaurant_hours",
  "call_taxi",
  "wait_please",
  "repeat_please",
  "anything_else",
  "enjoy_stay",
] as const;

export type StaffIntentKey = (typeof STAFF_INTENT_KEYS)[number];

export type GuestIntentId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

export type FacialMarker = "brows-up" | "brows-down";

/** A receptionist sentence with its fixed gloss (vocabulary.md section 1). Built in vocab.ts. */
export type StaffIntent = {
  key: StaffIntentKey;
  /** Row number in vocabulary.md section 1 (1..20). */
  row: number;
  /** Exact sentence from the table, e.g. "Do you have a reservation?" */
  text: string;
  /** Exact gloss tokens, including a leading BROWS-UP / BROWS-DOWN marker when present. */
  gloss: string[];
  marker: FacialMarker | null;
  /** Short button label for the quick-reply grid, e.g. "Reservation?" */
  short: string;
};

/** A guest request with its sign multiset and fixed sentence (vocabulary.md section 2). Built in vocab.ts. */
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
/** The guest intent "I need some help, please." (HELP PLEASE). */
export const HELP_INTENT_ID: GuestIntentId = 15;

/* ------------------------------------------------------------------ */
/* Check-in co-pilot checklist (plan 4.2, DSH-2)                       */
/* ------------------------------------------------------------------ */

export type CheckinItemKey =
  | "greeting"
  | "reservation"
  | "guest_name"
  | "id_checked"
  | "nights"
  | "room_number"
  | "key_card"
  | "elevator"
  | "wifi"
  | "breakfast"
  | "checkout"
  | "anything_else"
  | "farewell";

export type CheckinItemDef = {
  key: CheckinItemKey;
  label: string;
  /** Staff intents that share this item with the guest. */
  staffIntents: readonly StaffIntentKey[];
  /** Guest intents that count as "the guest asked about this". */
  guestAsks: readonly GuestIntentId[];
  /** Ticked by hand ("I saw it") because it happens on paper. */
  manual: boolean;
};

/** The standard check-in items, in display order. Gentle reminders only; nothing blocks. */
export const CHECKIN_ITEMS: readonly CheckinItemDef[] = [
  { key: "greeting", label: "Greeting", staffIntents: ["welcome"], guestAsks: [], manual: false },
  { key: "reservation", label: "Reservation", staffIntents: ["reservation_question"], guestAsks: [3], manual: false },
  { key: "guest_name", label: "Guest name", staffIntents: ["name_question"], guestAsks: [4], manual: false },
  { key: "id_checked", label: "ID checked", staffIntents: ["id_please"], guestAsks: [], manual: true },
  { key: "nights", label: "Number of nights", staffIntents: ["nights_question"], guestAsks: [], manual: false },
  { key: "room_number", label: "Room number", staffIntents: ["room_number"], guestAsks: [16], manual: false },
  { key: "key_card", label: "Key card", staffIntents: ["key_card"], guestAsks: [], manual: false },
  { key: "elevator", label: "Elevator", staffIntents: ["elevator_left"], guestAsks: [6], manual: false },
  { key: "wifi", label: "Wi-Fi", staffIntents: ["wifi_password"], guestAsks: [7], manual: false },
  { key: "breakfast", label: "Breakfast", staffIntents: ["breakfast_time"], guestAsks: [8, 9], manual: false },
  { key: "checkout", label: "Checkout time", staffIntents: ["checkout_time", "late_checkout"], guestAsks: [11, 12], manual: false },
  { key: "anything_else", label: "Anything else?", staffIntents: ["anything_else"], guestAsks: [], manual: false },
  { key: "farewell", label: "Farewell", staffIntents: ["enjoy_stay"], guestAsks: [], manual: false },
];

/** "shared" only after the guest device acknowledged rendering a line that carries the item. */
export type CheckinItemState = "not_shared" | "sent" | "shared";

export type CheckinItemStatus = {
  key: CheckinItemKey;
  state: CheckinItemState;
  /** Server time of the acknowledgement (shared) or the send (sent). */
  at: number | null;
  /** The staff sentence that shared it, as evidence. */
  sentence: string | null;
  /** When the guest asked about it before it was shared ("guest asked; not answered yet"). */
  guestAskedAt: number | null;
  /** Manual items: ticked by staff ("I saw it"). */
  seenByStaff: boolean;
};

/* ------------------------------------------------------------------ */
/* Small shared value types                                            */
/* ------------------------------------------------------------------ */

/** Where a staff sentence came from. */
export type CaptionSource = "quick_reply" | "voice" | "typed";

/** How the gloss for a staff sentence was produced. "none" = captions only. */
export type GlossSource = "fixed_intent" | "p1_gloss" | "p1_local_match" | "none";

/** What the guest chose on the first screen. */
export type GuestMode = "choosing" | "sign" | "type" | "interpreter" | "text_only";

export type AlertKind = "emergency" | "interpreter" | "typed";

export type SessionState =
  | "NO_SESSION"
  | "WAITING_FOR_GUEST"
  | "AWAITING_PAIR"
  | "PAIRED_UNCONFIRMED"
  | "ACTIVE"
  | "PAUSED";

export type SessionEndReason =
  | "staff_ended"
  | "idle"
  | "cap"
  | "guest_left"
  | "pair_failed"
  | "repaired"
  | "server_restart";

/** Human interpreter (VRI) details shown to the guest. Configured by env, not secret. */
export type VriInfo = { label: string; url: string | null; phone: string | null };

/**
 * How the staff laptop voices a confirmed guest sentence (plan 5.2, SPK-5).
 * - "tts": fixed table sentence: POST /api/tts { text: fixedText } (Nath's route; { id } requested, RT5).
 * - "local_after_tap": NAME or typed text: shown first; spoken only after staff tap, with a voice whose
 *   localService === true; never sent to any network service.
 * - "none": text only (guest chose text only or turned read-aloud off, recognizer in mock mode,
 *   or no on-device voice exists).
 */
export type SpeakPlan =
  | { mode: "tts"; intentId: GuestIntentId; fixedText: string }
  | { mode: "local_after_tap"; tap: "speak_name" | "read_aloud" }
  | { mode: "none"; why: "text_only" | "read_aloud_off" | "test_mode" | "no_local_voice" };

/** Top-1 view of a sign, the only recognition detail the guest device receives. */
export type GuestSignView = { seq: number | null; label: SignLabel; conf: number; light: TrafficLight; red: RedReason | null };

/** Full view of a sign for the staff screen (evidence panel). */
export type StaffSignView = {
  seq: number | null;
  top: Prediction[];
  light: TrafficLight;
  red: RedReason | null;
  /** Bar this label had to reach (CONF_THRESHOLD or its HARM_THRESHOLDS value). */
  bar: number;
  tSignStart: number | null;
  tSignEnd: number | null;
  tPredicted: number | null;
  receivedAt: number;
  skeleton: SkeletonSnapshot | null;
};

/** Where a candidate sentence came from. "local_vlm" is reserved (stub, plan 6.8). */
export type CandidateSource = "table" | "runner_up" | "nearest" | "local_vlm" | "llm";

/** One sentence the guest can confirm. */
export type Candidate = {
  candidateId: string;
  intentId: GuestIntentId | null;
  text: string;
  needsName: boolean;
  source: CandidateSource;
};

/** Gate outcome kinds (plan 6.3). */
export type ProposalKind = "proposal" | "did_you_mean" | "did_you_mean_help" | "pick" | "unmatched";

export type RepeatReason = "none_sign" | "framing" | "low_confidence" | "no_candidate";

/* ------------------------------------------------------------------ */
/* Event bus: envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every SSE `data:` line is one JSON envelope. `seq` is per session and monotonic;
 * it is also the SSE `id:`. `at` is server time in ms since epoch.
 */
export type BusEnvelope<M> = { seq: number; at: number; msg: M };

/* ------------------------------------------------------------------ */
/* Event bus: messages the GUEST device receives (AS-1)                */
/* ------------------------------------------------------------------ */
// Guest messages carry no counters, no keys, no top-3 alternatives, no skeletons, no timestamps
// from the recognizer, no other guests, no privacy or recognizer status, no device addresses.
// The two unions are separate on purpose: the server builds a guest message from GuestEvent only.

export type GuestHello = {
  type: "hello";
  mode: DeploymentMode;
  vri: VriInfo;
  /** Kiosk device (team iPad, Mode 0 window): the interpreter screen shows name and phone, no link (AS-25). */
  kiosk: boolean;
  idleWipeMs: number;
  sessionCapMs: number;
  /** Always true in this build; shown on the data notice. */
  confirmBeforeSpeaking: true;
  /** Text-to-911 note, configurable per site. */
  emergencyNote: string;
  /** The 6-digit check code while the session is PAIRED_UNCONFIRMED, else null. */
  check: string | null;
  /** Mode 0 guest window: display-only, staff confirm for the guest. */
  displayOnly: boolean;
};

export type GuestPairConfirmed = { type: "pair_confirmed"; deskShows: string };

export type GuestSnapshot = {
  type: "snapshot";
  state: SessionState;
  guestMode: GuestMode;
  speakAloud: boolean;
  /** Last caption only; no scrollback (AS-1). */
  lastCaption: GuestStaffUtterance | null;
  pending: GuestProposal | null;
};

/** CLAUDE.md 6.7 staff_utterance, extended. */
export type GuestStaffUtterance = {
  type: "staff_utterance";
  id: string;
  text: string;
  /** May be empty: then the guest sees captions only. */
  gloss: string[];
  glossSource: GlossSource;
};

export type GuestLiveSign = { type: "live_sign"; sign: GuestSignView };

export type GuestFraming = { type: "framing"; status: FramingStatus; text: string };

/** CLAUDE.md 6.7 repeat_request, extended. Guest sees "Please sign that again." */
export type GuestRepeatRequest = {
  type: "repeat_request";
  reason: RepeatReason;
  signs: GuestSignView[];
  weak: number[];
  /** Framing hint when framing caused the repeat. */
  framingText: string | null;
  /** Consecutive repeats; at 3+ the guest screen promotes "Type instead". */
  streak: number;
};

/** Signs offered to the guest for confirmation (plan 4.5 and 6.3). */
export type GuestProposal = {
  type: "guest_proposal";
  proposalId: string;
  kind: ProposalKind;
  signs: GuestSignView[];
  /** 1 candidate for proposal / did_you_mean / did_you_mean_help, 2..3 for pick, 0..3 for unmatched. */
  candidates: Candidate[];
  /** The recognizer reported "mock": shown as test mode, "Say it" disabled, never spoken. */
  testMode: boolean;
};

/** Echo after "Say it": the sentence was sent to the desk. */
export type GuestUtteranceEcho = {
  type: "guest_utterance";
  proposalId: string | null;
  text: string;
  /** "spoken" = read aloud at the desk; "shown" = text only; "waiting_for_staff" = name or typed text. */
  delivery: "spoken" | "shown" | "waiting_for_staff";
};

export type GuestStaffAck = { type: "staff_ack"; about: AlertKind };

export type GuestIdleWarning = { type: "idle_warning"; secondsLeft: number };

export type GuestSessionPaused = { type: "session_paused"; reason: "device_changed" };

export type GuestSessionEnd = { type: "session_end"; reason: SessionEndReason };

export type GuestEvent =
  | GuestHello
  | GuestPairConfirmed
  | GuestSnapshot
  | GuestStaffUtterance
  | GuestLiveSign
  | GuestFraming
  | GuestRepeatRequest
  | GuestProposal
  | GuestUtteranceEcho
  | GuestStaffAck
  | GuestIdleWarning
  | GuestSessionPaused
  | GuestSessionEnd;

/* ------------------------------------------------------------------ */
/* Staff panels: privacy, latency, safety, device health, benchmark    */
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
  /** True when the bytes were derived from the guest. */
  guestData: boolean;
  /** Who counted it: our own route code, the server.mjs wrapper, or the staff browser. */
  observedBy: "app_route" | "server_wrapper" | "staff_browser";
};

export type PrivacyCounters = {
  /** Which vendor keys exist on this laptop (names only). Empty during the engagement window (D8). */
  vendorKeysConfigured: string[];
  vendorCalls: VendorCall[];
  /** Bytes of guest-derived data sent off the laptop. */
  guestBytesOffLaptop: number;
  /** Bus messages delivered to the guest device, and their bytes. */
  messagesToGuest: number;
  bytesToGuest: number;
  /** Bridge events received from the recognizer (labels and timestamps only). */
  bridgeEvents: number;
  /** Skeleton snapshots held in memory right now (wiped with the session). */
  skeletonsHeld: number;
  /** Always 0: the validator refuses face points. */
  facePointsReceived: 0;
  /** Always 0: no route accepts video. */
  videoFramesReceived: 0;
  /** Always 0: the app has no file-writing code (checked by the hygiene test). */
  filesWritten: 0;
};

export type WipeReceipt = { at: number; reason: SessionEndReason; itemsErased: number };

export type LatencyStageKey =
  | "movement_to_prediction"
  | "prediction_to_app"
  | "app_to_guest_screen"
  | "utterance_to_proposal_shown"
  | "say_it_to_speech";

export type LatencyStage = {
  key: LatencyStageKey;
  label: string;
  lastMs: number | null;
  medianMs: number | null;
  count: number;
  /** "laptop" when measured on the laptop; "guest_device" when it includes a guest acknowledgement. */
  measuredBy: "laptop" | "guest_device";
};

export type SafetyWarningKind =
  | "second_device"
  | "device_changed"
  | "repeated_request"
  | "unusual_rate"
  | "failed_pairing"
  | "silent_change"
  | "heartbeat"
  | "recognizer_event";

export type SafetyWarning = {
  id: string;
  kind: SafetyWarningKind;
  /** Plain, gentle wording (plan 6.6). Never claims an attack or spyware. */
  text: string;
  at: number;
  count: number;
  open: boolean;
};

/** Compute Pressure states as reported by the browser; shown only where supported. */
export type PressureState = "nominal" | "fair" | "serious" | "critical";

export type DeviceHealth = {
  /** null = this browser has no Compute Pressure API ("Not available on this browser"). */
  guest: { state: PressureState | null; at: number | null };
  staff: { state: PressureState | null; at: number | null };
};

/** GET /api/staff/benchmark. Only a cleared, audited file may show numbers (DSH-6). */
export type BenchmarkResponse =
  | { ok: true; status: "not_yet_audited" }
  | {
      ok: true;
      status: "cleared";
      auditRef: string;
      clearedAt: string;
      /** Only keys present in the cleared file; nothing is computed or invented. */
      figures: { label: string; value: string; n?: number; scope?: string }[];
    };

/* ------------------------------------------------------------------ */
/* Event bus: messages the STAFF screen receives                       */
/* ------------------------------------------------------------------ */

export type RecognizerState = "up" | "down" | "unknown";

export type PairingInfo = {
  /** Single-use code, base64url of LIMITS.pairCodeBytes random bytes. Shown only in the staff overlay. */
  code: string;
  /** https://<LAN_IP or DESK_NAME>:3443/guest#p=<code> (Mode C/W) or http://127.0.0.1:3000/guest#p=<code> (Mode 0). */
  guestUrl: string;
  expiresAt: number;
};

export type GuestDeviceInfo = {
  /** Parsed device class such as "iPad, Safari"; never the raw User-Agent. */
  deviceClass: string;
  address: string;
  joinedAt: number;
};

export type StaffStatus = {
  mode: DeploymentMode;
  recognizer: {
    state: RecognizerState;
    mode: RecognizerMode | null;
    fps: number | null;
    lastEventAt: number | null;
  };
  session: {
    state: SessionState;
    startedAt: number | null;
    lastActivityAt: number | null;
    idleWipeAt: number | null;
    capAt: number | null;
    extensions: number;
  };
  guest: {
    device: GuestDeviceInfo | null;
    /** Check code once confirmed ("Paired with 960 792"); null before. */
    confirmedCheck: string | null;
    confirmTriesLeft: number | null;
    streams: number;
    lastHeardAt: number | null;
    guestMode: GuestMode;
    speakAloud: boolean;
    failedJoins: number;
  };
  counters: { repeats: number; proposals: number; confirmed: number; fixed: number };
  privacy: { thisGuest: PrivacyCounters; sinceStart: PrivacyCounters; lastWipe: WipeReceipt | null };
  latency: LatencyStage[];
  deviceHealth: DeviceHealth;
  openWarnings: number;
  flags: {
    simulateEnabled: boolean;
    vlmFallback: boolean;
    englishFallback: boolean;
    bridgeKeyConfigured: boolean;
    transcribeAvailable: boolean;
  };
};

/** One line of the in-memory conversation log on the staff screen. */
export type LogEntry =
  | { kind: "staff"; seq: number; at: number; id: string; text: string; gloss: string[]; captionSource: CaptionSource; glossSource: GlossSource; intent: StaffIntentKey | null; shownOnDeviceAt: number | null }
  | { kind: "guest"; seq: number; at: number; proposalId: string; text: string; signs: StaffSignView[]; intentId: GuestIntentId | null; source: CandidateSource; speak: SpeakPlan; spokenAt: number | null; confirmedBy: "guest" | "staff_for_guest" }
  | { kind: "guest_typed"; seq: number; at: number; text: string; readAloudAt: number | null }
  | { kind: "repeat"; seq: number; at: number; reason: RepeatReason }
  | { kind: "system"; seq: number; at: number; text: string };

export type StaffSnapshot = {
  type: "snapshot";
  status: StaffStatus;
  log: LogEntry[];
  pairing: PairingInfo | null;
  checklist: CheckinItemStatus[];
  evidence: StaffSignView[];
  warnings: SafetyWarning[];
  pending: GuestProposal | null;
};

export type StaffSessionState = { type: "session_state"; state: SessionState; pairing: PairingInfo | null; device: GuestDeviceInfo | null; confirmTriesLeft: number | null };

export type StaffPairConfirmed = { type: "pair_confirmed"; check: string };

export type StaffStaffUtterance = {
  type: "staff_utterance";
  id: string;
  text: string;
  gloss: string[];
  glossSource: GlossSource;
  captionSource: CaptionSource;
  intent: StaffIntentKey | null;
};

/** The guest device acknowledged rendering a caption or a proposal. */
export type StaffDelivered = { type: "delivered"; eventSeq: number; roundTripMs: number | null };

export type StaffLiveSign = { type: "live_sign"; sign: StaffSignView; source: SignsSource };

export type StaffFraming = { type: "framing"; status: FramingStatus; hint: string; rejectedSeq: number | null };

/** Utterance outcome for the dashboard. */
export type StaffRecognition = {
  type: "recognition";
  source: SignsSource;
  receivedAt: number;
  signs: StaffSignView[];
  outcome: ProposalKind | "repeat";
  repeatReason: RepeatReason | null;
  candidates: Candidate[];
  proposalId: string | null;
  testMode: boolean;
};

export type StaffRepeatRequest = { type: "repeat_request"; reason: RepeatReason; count: number; streak: number };

export type StaffGuestUtterance = {
  type: "guest_utterance";
  proposalId: string;
  signs: StaffSignView[];
  text: string;
  intentId: GuestIntentId | null;
  source: CandidateSource;
  speak: SpeakPlan;
  confirmedBy: "guest" | "staff_for_guest";
};

export type StaffGuestFix = { type: "guest_fix"; proposalId: string; action: GuestFixAction };
export type StaffGuestTyped = { type: "guest_typed"; text: string };
export type StaffGuestChoice = { type: "guest_choice"; guestMode: GuestMode; speakAloud: boolean };
export type StaffInterpreterRequest = { type: "interpreter_request"; vri: VriInfo };
/** Help pressed; `count` merges repeats until staff acknowledge. */
export type StaffEmergency = { type: "emergency"; count: number };
export type StaffStaffAck = { type: "staff_ack"; about: AlertKind };
export type StaffWarning = { type: "warning"; warning: SafetyWarning };
export type StaffDeviceHealth = { type: "device_health"; who: "guest" | "staff"; state: PressureState | null };
export type StaffChecklist = { type: "checklist"; items: CheckinItemStatus[] };
export type StaffIdleWarning = { type: "idle_warning"; secondsLeft: number };
export type StaffCapWarning = { type: "cap_warning"; secondsLeft: number };
export type StaffSessionPaused = { type: "session_paused"; reason: "device_changed"; device: GuestDeviceInfo };
/** RESERVED (plan 6.8): a local vision-model suggestion became a candidate. Stub only. */
export type StaffVlmProposal = { type: "vlm_proposal"; proposalId: string; candidate: Candidate; model: string };
export type StaffSessionEnd = { type: "session_end"; reason: SessionEndReason; receipt: WipeReceipt };
export type StaffStatusEvent = { type: "status"; status: StaffStatus };

export type StaffEvent =
  | StaffSnapshot
  | StaffSessionState
  | StaffPairConfirmed
  | StaffStaffUtterance
  | StaffDelivered
  | StaffLiveSign
  | StaffFraming
  | StaffRecognition
  | StaffRepeatRequest
  | StaffGuestUtterance
  | StaffGuestFix
  | StaffGuestTyped
  | StaffGuestChoice
  | StaffInterpreterRequest
  | StaffEmergency
  | StaffStaffAck
  | StaffWarning
  | StaffDeviceHealth
  | StaffChecklist
  | StaffIdleWarning
  | StaffCapWarning
  | StaffSessionPaused
  | StaffVlmProposal
  | StaffSessionEnd
  | StaffStatusEvent;

export type Role = "guest" | "staff";

/* ------------------------------------------------------------------ */
/* Actions (request bodies)                                            */
/* ------------------------------------------------------------------ */

/** POST /api/guest/join body. The code comes from the URL fragment (#p=), never a query string. */
export type GuestJoinRequest = { code: string };

export type GuestFixAction = "sign_again" | "type" | "interpreter" | "not_this";

/**
 * POST /api/guest/action body (guest cookie, same origin). Every action carries `n`, a client nonce
 * (16 random bytes as 32 hex characters); a nonce seen before in this session gets 409.
 * Rate limits per kind: plan 9.5.
 */
export type GuestAction = { n: string } & (
  | { type: "guest_choice"; choice: "sign" | "type" | "interpreter" | "text_only" }
  | { type: "stop_signing" }
  | { type: "guest_confirm"; proposalId: string; candidateId: string; name?: string }
  | { type: "guest_fix"; proposalId: string; action: GuestFixAction }
  | { type: "guest_typed"; text: string }
  | { type: "interpreter_request" }
  /** Never refused with 429 or 409; accepted before confirmation and while paused. */
  | { type: "emergency" }
  | { type: "prefs"; speakAloud: boolean }
  /** Render acknowledgement (latency, checklist, heartbeat); never counts as activity. */
  | { type: "ack"; seq: number }
  /** Compute Pressure state; sent only where the browser supports it, at most every 10 s. */
  | { type: "device_health"; state: PressureState }
);

/** POST /api/staff/claim body: the one-time capability from the #k= URL printed at start. */
export type StaffClaimRequest = { k: string };

/** POST /api/staff/action body (staff listener, staff cookie, same origin). */
export type StaffAction =
  | { type: "new_guest" }
  | { type: "guest_is_here" }
  | { type: "refresh_code" }
  /** Mode 0: returns the loopback guest URL for the second-display window. */
  | { type: "open_guest_window" }
  | { type: "confirm_pair"; check: string }
  /** New code for the same guest (keeps the log, revokes the old cookie). */
  | { type: "repair" }
  | { type: "end_guest" }
  | { type: "extend" }
  /** "Keep open": resets the idle timer. */
  | { type: "touch" }
  | { type: "say_quick"; intent: StaffIntentKey }
  | { type: "say_text"; text: string; gloss: string[] | null; source: "voice" | "typed" }
  | { type: "ack"; about: AlertKind }
  /** Staff tapped "Speak name" or "Read aloud" (AS-13); the server answers with the text to voice locally. */
  | { type: "speak_name"; proposalId: string }
  | { type: "read_aloud"; logSeq: number }
  /** The staff page reports how and when it voiced a sentence (latency and privacy panels). */
  | { type: "speak_done"; ref: string; how: "tts" | "local" | "none"; startedAt: number }
  /** Mode 0 only: the receptionist confirms for the guest after the guest nods or points. */
  | { type: "confirm_for_guest"; proposalId: string; candidateId: string }
  | { type: "reject_for_guest"; proposalId: string }
  /** Mode 0 only: the receptionist records the guest's choice after asking. */
  | { type: "choice_for_guest"; choice: "sign" | "type" | "interpreter" | "text_only" }
  | { type: "checklist_seen"; item: CheckinItemKey }
  | { type: "dismiss_warning"; id: string }
  | { type: "device_health"; state: PressureState }
  /** The staff browser used the Web Speech fallback after its disclosure; counted on the privacy panel. */
  | { type: "note_vendor"; destination: "browser speech service" };

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "bad_request"          // 400: body failed validation (wrong check code carries triesLeft)
  | "unauthorized"         // 401: missing or dead cookie, wrong X-Bridge-Key
  | "forbidden"            // 403: wrong listener, not loopback, bad Host, bad Origin, address not in GUEST_IPS
  | "not_found"            // 404: feature switched off (simulator, VLM fallback, english fallback)
  | "conflict"             // 409: wrong state, proposal not pending, guest not signing, reused nonce
  | "gone"                 // 410: pairing code or staff capability used or expired
  | "length_required"      // 411: raw upload without Content-Length
  | "too_large"            // 413
  | "unsupported_type"     // 415
  | "rate_limited"         // 429 (never for emergency)
  | "upstream_failed"      // 502: vendor call failed (status number only)
  | "not_configured";      // 503: BRIDGE_KEY missing or too short, TTS busy

export type ApiError = { ok: false; error: ErrorCode; message: string; triesLeft?: number };

/** The guest token is NOT in this body: it travels only in Set-Cookie (__Host-sb_g). */
export type GuestJoinResponse = { ok: true; check: string | null; hello: GuestHello } | ApiError;

export type GuestActionResponse = { ok: true } | ApiError;

export type StaffClaimResponse = { ok: true } | ApiError;

export type StaffActionResponse =
  | {
      ok: true;
      pairing?: PairingInfo;
      /** Mode 0 open_guest_window. */
      guestUrl?: string;
      /** speak_name / read_aloud: the text the staff page voices with an on-device voice. */
      speakText?: string;
    }
  | ApiError;

/* ------------------------------------------------------------------ */
/* Teammate contracts, as merged on p4-app (plan 3)                    */
/* ------------------------------------------------------------------ */

/** P1 POST /api/transcribe: multipart field "audio"; 503 without OPENAI_API_KEY. */
export type TranscribeResponse = { text: string } | { error: string };
/** P1 POST /api/gloss (local mapping, no vendor call). */
export type GlossRequest = { text: string };
export type GlossResponse = { gloss: string[] };
/** Nath POST /api/english: fixed table first, Claude for other sequences (not on the scripted path). */
export type EnglishRequest = { signs: RawPrediction[] };
export type EnglishResponse = { text: string };
/** Nath POST /api/tts today: one plain sentence (<= 300 chars) -> audio/wav. The app sends fixed sentences only. */
export type TtsTextRequest = { text: string };
/** Requested contract (RT5, OPS-8): fixed guest intent id only. */
export type TtsIdRequest = { id: GuestIntentId };
/** P2 avatar (web/lib/avatar/player.ts). */
export type AvatarStyle = "hologram" | "concierge" | "bellhop";
export type MountAvatar = (container: HTMLElement, options?: { style?: AvatarStyle }) => { webgl: boolean; unmount: () => void };
export type PlayGloss = (gloss: string[], options?: { onToken?: (index: number) => void }) => Promise<void>;
/** P2 request (plan 8): lookup.ts preloadSigns(bundle) so the guest listener needs no per-gloss fetch. */
export type SignBundle = { index: Record<string, string>; files: Record<string, unknown>; padding: string };

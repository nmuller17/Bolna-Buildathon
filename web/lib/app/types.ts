// SignBridge app (P4): shared types for the server, the staff screen and the guest screen.
//
// Rules for this file:
// - Erasable TypeScript only (no enums, no namespaces, no parameter properties), so that
//   Node 22 type stripping can run the unit tests that import it.
// - No imports. Every other module in web/lib/app/** may import from here; nothing here
//   imports from anywhere else. Modules import each other with explicit ".ts" extensions
//   (tsconfig "allowImportingTsExtensions", build step 0), so they load under Next and node --test.
// - Runtime values are limited to constants that both sides must agree on (labels, limits,
//   tables, guest-facing copy that a test checks word for word). Logic lives in the pure
//   modules listed in docs/app-plan.md section 10.
// - The plan that explains every type is docs/app-plan.md (sections cited as "plan N").
//   Revision 2 (2026-10-10, 22:00) folds in the two critique passes; plan section 16 is the
//   critique log, and "C1-n" / "C2-n" in comments below point to its rows.
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

/** Default bar for a sign's top-1 model score (0.6 passes, 0.5999 fails). CLAUDE.md 7.2 step 4. */
export const CONF_THRESHOLD = 0.6;

/**
 * Harm-weighted bars: a wrong YES/NO, NAME, ROOM or HELP does more harm, so these labels need a
 * higher score. PROVISIONAL values; P3 sets the final ones from audited calibration (plan 15 q3).
 */
export const HARM_THRESHOLDS: Readonly<Partial<Record<SignLabel, number>>> = {
  YES: 0.75,
  NO: 0.75,
  NAME: 0.75,
  ROOM: 0.75,
  HELP: 0.75,
};

/** Green at or above this (and at or above the label's bar). */
export const LIGHT_GREEN_MIN = 0.8;

/**
 * Traffic light for one recognised sign. Always shown with a word and a shape, never colour alone:
 * green = filled, amber = half, red = hollow. Scores are uncalibrated model outputs, never "confidence"
 * or "accuracy" (C2-4).
 */
export type TrafficLight = "green" | "amber" | "red";

/** Why a sign is red. "framing" = the recognizer rejected it because the guest was not framed. */
export type RedReason = "below_bar" | "none_sign" | "framing";

/**
 * Guest-facing words for a light (C2-4, C2-5): no percentages, never "sure" or "unclear", and the
 * system is the subject of every miss. The guest screen never receives the score itself.
 */
export const LIGHT_WORDS_GUEST: Readonly<Record<TrafficLight, string>> = {
  green: "clear",
  amber: "not certain",
  red: "missed",
};

/** Staff-facing words. The number next to them is labelled "model score (uncalibrated)". */
export const LIGHT_WORDS_STAFF: Readonly<Record<TrafficLight, string>> = {
  green: "high model score",
  amber: "borderline model score",
  red: "low model score",
};

/** Staff wording for each red reason (never "unclear" as a property of the guest, C2-5). */
export const RED_REASON_STAFF: Readonly<Record<RedReason, string>> = {
  below_bar: "low model score",
  none_sign: "camera saw no known sign",
  framing: "camera missed it (framing)",
};

/* ------------------------------------------------------------------ */
/* Limits shared by validators, UI and tests                           */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  /** Signs per utterance (bridge contract: 1..8). Also the cap for a merged utterance (plan 6.3). */
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
  /** Staff captions the guest page keeps in memory (C2-12). The snapshot still holds only the last one (AS-1). */
  guestCaptionsKept: 3,
  /** Gloss tokens accepted from /api/gloss or the client (RT8). */
  glossMaxTokens: 40,
  glossFingerspellMaxLen: 32,
  /** Request body caps in bytes. */
  bodySmallJson: 4 * 1024,
  bodyBridgeJson: 8 * 1024,
  bodyAudio: 5 * 1024 * 1024,
  /** Skeleton snapshot on a bridge sign event: at most this many bytes of JSON (plan 6.2). */
  skeletonMaxBytes: 2 * 1024,
  /** Session timing for the "engagement" profile; SESSION_PROFILES overrides per profile, env overrides both. */
  idleWipeMs: 120_000,
  idleWipeUnconfirmedMs: 60_000,
  /** BN-5: two minutes before the idle wipe, capped at half the idle limit (store.tick). */
  idleWarnBeforeMs: 2 * 60_000,
  sessionCapMs: 15 * 60_000,
  capWarnBeforeMs: 2 * 60_000,
  extendMs: 5 * 60_000,
  /** Pairing (decision record D6). Tier 1 (gate G1). */
  pairCodeTtlMs: 120_000,
  pairQrRefreshMs: 60_000,
  /** At most this many pairing codes are valid at once: a refreshed code does not kill the previous one (C1-17). */
  pairCodesLive: 2,
  pairCodeBytes: 16,
  guestTokenBytes: 32,
  /** Tier 2: after a token rotation the previous token stays valid this long (C1-6). */
  tokenRotationGraceMs: 30_000,
  checkDigits: 6,
  confirmTries: 3,
  joinFailsPerAddressPerMin: 5,
  staffCapabilityBytes: 32,
  /** Bridge (recognition/README.md "App bridge"). */
  bridgeKeyMinLen: 32,
  bridgeMaxAgeMs: 5_000,
  bridgePerSecond: 10,
  /** Gate behaviour (plan 6.3). */
  proposalGraceMs: 10_000,
  unmatchedMergeMs: 4_000,
  /** Streams and connections. Guest streams: newest wins. */
  maxGuestStreams: 2,
  maxStaffStreams: 4,
  /** Tier 1: per-address connection cap on the guest listener for an address in GUEST_IPS (C1-14); others get 8. */
  maxConnPerGuestAddress: 24,
  maxConnPerOtherAddress: 8,
  sseRetryMs: 2_000,
  /** SSE comment ping to the guest stream, well under the 5 s client watchdog (C1-6). */
  guestPingMs: 2_000,
  staffHeartbeatMs: 15_000,
  guestWatchdogMs: 5_000,
  /** Guest heartbeat POST interval (C1-7); never counts as activity. */
  guestHeartbeatMs: 5_000,
  /** Guest heartbeat on the staff header (AS-21): amber after, red after. */
  heartbeatAmberMs: 20_000,
  heartbeatRedMs: 45_000,
  /** Help not acknowledged after this: the guest screen adds "No reply yet. Wave or knock at the desk." (C2-14). */
  emergencyNoAckMs: 20_000,
  /** Guest-reported latency outside 0..this is dropped (AS-22). */
  guestLatencyMaxMs: 10_000,
  /** Tier 2: device-health reports from a kiosk guest device, at most one per this interval. */
  deviceHealthMinIntervalMs: 10_000,
  /** LATER (OPS-5, Mode W only): constant-size guest frames. */
  sseSlotMs: 250,
  sseFrameBytes: 2048,
  /** Staff header shows "framing not OK for N s" with the runbook hint after this (C1-10). */
  framingStuckHintMs: 10_000,
} as const;

/* ------------------------------------------------------------------ */
/* Profiles and deployment (decision record D3, plan 2 and 9.2)        */
/* ------------------------------------------------------------------ */

/**
 * "stage" = the hackathon demo on loopback (Mode 0): long idle wipe, optional guest input on the
 * second display. "engagement" = the security test on the wiped loaner: strict values, Mode 0 is
 * display-only exactly as decision record D3 says. Chosen with SB_PROFILE; default "engagement".
 */
export type SessionProfile = "stage" | "engagement";

export type ProfileSettings = {
  idleWipeMs: number;
  idleWipeUnconfirmedMs: number;
  sessionCapMs: number;
  /** Whether MODE0_GUEST_INPUT=1 may turn on taps and typing in the Mode 0 guest window. */
  mode0GuestInputAllowed: boolean;
};

export const SESSION_PROFILES: Readonly<Record<SessionProfile, ProfileSettings>> = {
  stage: { idleWipeMs: 600_000, idleWipeUnconfirmedMs: 600_000, sessionCapMs: 15 * 60_000, mode0GuestInputAllowed: true },
  engagement: { idleWipeMs: 120_000, idleWipeUnconfirmedMs: 60_000, sessionCapMs: 15 * 60_000, mode0GuestInputAllowed: false },
};

/**
 * mode0 = guest window on a wired second display, loopback only. Display-only unless the stage
 *         profile and MODE0_GUEST_INPUT=1 give the guest window its own input (a stage compromise).
 * modeC = one Ethernet cable, guest listener HTTPS on LAN_IP:3443 (Tier 1, gate G1, never on the dev Mac).
 * modeW = travel router, only if gate G2 passed. There is no plain-HTTP LAN mode.
 */
export type DeploymentMode = "mode0" | "modeC" | "modeW";

/** Which listener a request arrived on. The listener decides the role, never the socket address. */
export type Listener = "staff" | "guest";

/**
 * Mode 0 origins (C1-3): staff and guest windows are different cookie sites, so the guest window
 * never shares the staff cookie and a guest-side cookie clear cannot touch it.
 */
export const STAFF_ORIGIN = "http://127.0.0.1:3000";
export const MODE0_GUEST_ORIGIN = "http://localhost:3000";

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
// live.py and live_key.py --post send each event as its own POST to /api/guest/signs with X-Bridge-Key.
// Times are Unix seconds (float) from the laptop's clock, comparable with Date.now() / 1000.
// The app checks `type`, ignores unknown keys, and validates every known key strictly.
// Keys face, frames, pose, video are refused outright and counted (only the optional skeleton carries points).
//
// SHARED CONTRACT (adopted 2026-10-11 from p4-app c335161 and p3-recognition ad90509, so this app and
// the p4-app screens consume the same recognizer events): the recognizers as shipped send no `t_sent`,
// live_key.py sends `sign` with `seq` and `top` only, a sentence-shaped `utterance` {raw, labels, text,
// snapped} with no seqs, and a `capture` event; live_window.py sends stream utterances without seqs.
// Every field this app wished for (t_sent, sign timestamps, seqs, since, fps, run, skeleton) is
// therefore OPTIONAL here; when a time is missing the app uses the time the event arrived.

/**
 * CENTER_LEFT and CENTER_RIGHT are requested from P3 (direction from the guest's point of view, C2-16);
 * accepted now so the app is ready, never required.
 */
export type FramingStatus =
  | "OK"
  | "STEP_BACK"
  | "MOVE_CAMERA_DOWN"
  | "COME_CLOSER"
  | "CENTER"
  | "CENTER_LEFT"
  | "CENTER_RIGHT"
  | "HANDS_OUT"
  | "NO_PERSON";

/**
 * Guest-screen wording for each framing status (plan 6.4). There is no camera preview, so the text
 * refers to the desk camera and the guest's own body, not to "the picture" (C2-16).
 */
export const FRAMING_GUIDANCE: Readonly<Record<FramingStatus, string>> = {
  OK: "Ready: sign when you like",
  STEP_BACK: "Please take a step back from the desk camera",
  MOVE_CAMERA_DOWN: "The camera cannot see your waist. Staff will tilt it down",
  COME_CLOSER: "Please come a little closer to the desk camera",
  CENTER: "Please stand in front of the desk camera, on the floor marker",
  CENTER_LEFT: "Please move a little to your left",
  CENTER_RIGHT: "Please move a little to your right",
  HANDS_OUT: "Please keep your hands a little closer to your body",
  NO_PERSON: "Please stand in front of the desk camera",
};

/** Staff-screen wording where it differs from the guest's, with the runbook hint (C1-10). */
export const FRAMING_STAFF_HINT: Readonly<Partial<Record<FramingStatus, string>>> = {
  MOVE_CAMERA_DOWN: "Tilt the desk camera down. If the counter hides the hips, restart the recognizer with --waist none",
  STEP_BACK: "Ask the guest to step back. If the counter hides the hips, restart the recognizer with --waist none",
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

/**
 * Fields every bridge event may carry. `run` is requested from P3 (a random id per recognizer
 * process, C1-11); until it exists, a seq lower than the last one seen is treated as a restart.
 */
type BridgeCommon = { t_sent?: number; run?: string };

export type BridgeSign = BridgeCommon & {
  type: "sign";
  /** Counts signs from 1 for the recognizer process. */
  seq: number;
  /** Top 3, best first (re-sorted on the server). */
  top: RawPrediction[];
  /** live.py only; live_key.py sends none of the four. */
  t_sign_start?: number;
  t_sign_end?: number;
  t_closed?: number;
  t_predicted?: number;
  skeleton?: SkeletonSnapshot;
};

/** live.py / live_window.py utterance: the top-1 of each sign with its score. */
export type BridgeStreamUtterance = BridgeCommon & {
  type: "utterance";
  /** Top-1 of each sign, in order, 1..8. Used for any sign whose `sign` event is missing (C1-11). */
  signs: RawPrediction[];
  /** live.py sends them; live_window.py does not (the app then joins with the sentence's sign events). */
  seqs?: number[];
  /**
   * recognizer.needs_repeat (any sign NONE or below 0.6). A HINT only, shown on the staff log; the app
   * recomputes the gate itself and never repeats because of this flag alone (C1-4).
   */
  needs_repeat?: boolean;
  t_end?: number;
};

/**
 * live_key.py utterance (recognition/README.md "Demo path"): `raw` = the best non-NONE label of each
 * sign; `labels` = the sentence snapped to the closest guest sentence of the same length by
 * recognition/intents.py (`snapped`), else `raw`; `text` = that sentence's English, or null.
 * The app validates `text` but never speaks or shows it: guest sentences come only from the fixed table.
 */
export type BridgeSentenceUtterance = BridgeCommon & {
  type: "utterance";
  raw?: string[];
  labels: string[];
  text?: string | null;
  snapped?: boolean;
  needs_repeat?: boolean;
};

export type BridgeUtterance = BridgeStreamUtterance | BridgeSentenceUtterance;

/**
 * live_key.py: a sign recording starts (`countdown`: REC begins after `countdown` seconds and lasts
 * `duration`), then `processing` when it stops. No personal data, so accepted outside the consent gate.
 */
export type BridgeCapture = BridgeCommon & {
  type: "capture";
  phase: "countdown" | "processing";
  countdown?: number;
  duration?: number;
};

export type BridgeFraming = BridgeCommon & {
  type: "framing";
  status: FramingStatus;
  /** When the status started (live.py); the arrival time when missing. */
  since?: number;
  /** Present when a sign was not classified because under 80% of its frames were framed OK. */
  rejected_seq?: number;
};

export type RecognizerMode = "ok" | "mock" | "no_model";

export type BridgeStatus = BridgeCommon & {
  type: "status";
  fps?: number;
  /** "mock" = invented answers (never spoken); "no_model" = no sign events will come. */
  recognizer: RecognizerMode;
  t?: number;
};

/**
 * RESERVED (plan 6.8): a local vision-model suggestion from P3's process. Ignored with 404 unless
 * VLM_FALLBACK=1, and even then only ever a candidate the guest must confirm. UI is Tier 2.
 */
export type BridgeVlmSuggestion = BridgeCommon & {
  type: "vlm_suggestion";
  seq: number;
  label: string;
  conf: number;
  model: string;
};

export type BridgeEvent = BridgeSign | BridgeUtterance | BridgeFraming | BridgeStatus | BridgeCapture | BridgeVlmSuggestion;

/** Where an event came from. Simulated events are labelled on both screens. */
export type SignsSource = "recognizer" | "simulated";

/** Response of POST /api/guest/signs and POST /api/dev/simulate. */
export type BridgeIngestResponse =
  | {
      ok: true;
      /**
       * "ignored_pending" = a repeat or NONE-only utterance arrived while a proposal was waiting (C1-5);
       * "held" = an unmatched utterance is waiting up to LIMITS.unmatchedMergeMs for the next one (C1-17);
       * "framing" = framing stored (accepted outside the consent gate, C1-10);
       * "capture" = a live_key recording phase stored (accepted outside the consent gate).
       */
      outcome: "stored" | "proposal" | "repeat" | "status" | "framing" | "capture" | "stale" | "duplicate" | "ignored_pending" | "held";
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

/** Fixed note at the top of the co-pilot panel (C2-26). */
export const CHECKLIST_NOTE = "Shown on the guest screen does not mean understood. Pause and check with the guest.";

/**
 * "shared" only after the guest device acknowledged rendering a line that carries the item.
 * "needs_retry" when the guest tapped "I don't understand" or "Please repeat" on that line (C2-26).
 * The checklist tracks staff actions only; it never shows guest response times or repeat counts.
 */
export type CheckinItemState = "not_shared" | "sent" | "shared" | "needs_retry";

export type CheckinItemStatus = {
  key: CheckinItemKey;
  state: CheckinItemState;
  /** Server time of the acknowledgement (shared), the send (sent) or the guest's reply (needs_retry). */
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

/** Where a staff sentence came from. "voice" captions are marked on the guest screen (C2-13). */
export type CaptionSource = "quick_reply" | "voice" | "typed";

/** How the gloss for a staff sentence was produced. "none" = captions only. */
export type GlossSource = "fixed_intent" | "p1_gloss" | "p1_local_match" | "none";

/**
 * What the guest chose on the first screen. "type" also offers the 20 requests as phrase buttons (C2-3).
 * "tap" = the picture request board (docs/features-plan.md F2): the same 20 fixed guest intents as large
 * pictures with two-word labels, through the same confirm step (BN-1).
 */
export type GuestMode = "choosing" | "sign" | "type" | "tap" | "interpreter" | "text_only";

/** Staff alert kinds. "more_time" = the guest asked for more time on an idle or cap warning (Tier 1, C2-10). */
export type AlertKind = "emergency" | "interpreter" | "typed" | "more_time";

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

/** Guest-screen wording for each end reason (C2-18). */
export const END_REASON_GUEST: Readonly<Record<SessionEndReason, string>> = {
  staff_ended: "The desk ended the conversation.",
  idle: "It ended because no one used it for a while.",
  cap: "It reached the time limit for one conversation.",
  guest_left: "You ended the conversation.",
  pair_failed: "The desk could not connect this screen.",
  repaired: "The desk is connecting this screen again.",
  server_restart: "The desk system restarted.",
};

/** Honest end-screen sentence (C2-18): the page saved nothing, the browser may keep history. */
export const END_SCREEN_STORAGE_NOTE = "This page did not save the conversation. Your browser may keep its own history.";
/** Added when a proposal or unsent typed text was pending at the end (C2-18). */
export const END_SCREEN_PENDING_NOTE = "Your unsent message was not sent. Wave to the desk if you still need something.";

/**
 * Human interpreter (VRI) details shown to the guest. Configured by env, not secret. When nothing
 * is configured, label and contact are null and the card says so honestly (C2-15): never an empty
 * or invented provider. A contact is always labelled by its kind, never shown as a bare number.
 */
export type VriInfo = {
  label: string | null;
  /** Shown only on a device that is not a kiosk (AS-25). */
  url: string | null;
  contact: { kind: "videophone" | "text"; value: string } | null;
};

/** Interpreter card text when VRI_* is unset (C2-15). */
export const VRI_UNSET_TEXT = "Ask the desk to arrange a sign language interpreter. This may take time.";

/**
 * How the staff laptop voices a confirmed guest sentence (plan 5.2, SPK-5).
 * - "tts": fixed table sentence: POST /api/tts { text: fixedText } (Nath's route; { id } requested, RT5),
 *   played through the staff page's one unlocked AudioContext (C1-16).
 * - "local_after_tap": NAME or typed text: shown first; spoken only after staff tap, with a voice whose
 *   localService === true; never sent to any network service.
 * - "none": text only (guest chose "Send as text", recognizer in mock mode, or no on-device voice).
 */
export type SpeakPlan =
  | { mode: "tts"; intentId: GuestIntentId; fixedText: string }
  | { mode: "local_after_tap"; tap: "speak_name" | "read_aloud" }
  | { mode: "none"; why: "text_only" | "read_aloud_off" | "test_mode" | "no_local_voice" | "guest_chose_text" };

/**
 * Top-1 view of a sign: the only recognition detail the guest device receives. No score (C2-4):
 * the guest sees the light's shape and LIGHT_WORDS_GUEST only.
 */
export type GuestSignView = { seq: number | null; label: SignLabel; light: TrafficLight; red: RedReason | null };

/** Full view of a sign for the staff screen (evidence panel). */
export type StaffSignView = {
  seq: number | null;
  /** Top 3 when the sign event was joined; only the top-1 from the utterance when it was not (C1-11). */
  top: Prediction[];
  joined: boolean;
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

/**
 * Where a candidate sentence came from. "phrase" = the guest picked it from the phrase list without
 * recognition (C2-3). "sentence" = the recognizer's own sentence correction (live_key.py `snapped`
 * labels), offered as "Did you mean...?" and never spoken without the guest's confirmation.
 * "local_vlm" is reserved (stub, plan 6.8). "llm" is LATER (OPS-7).
 */
export type CandidateSource = "table" | "runner_up" | "nearest" | "phrase" | "sentence" | "local_vlm" | "llm";

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

/** Guest repair replies under the latest caption (C2-11). Shown to staff; never spoken unless staff choose. */
export type GuestReplyKind =
  | "please_repeat"
  | "dont_understand"
  | "please_type"
  | "wait_please"
  | "slower"
  | "show_on_paper"
  /** FEATURE_STRATEGY feature 3 (features-plan F5): two more repair requests. */
  | "say_another_way"
  | "write_number";

export const GUEST_REPLY_TEXT: Readonly<Record<GuestReplyKind, string>> = {
  please_repeat: "Please repeat that.",
  dont_understand: "I don't understand.",
  please_type: "Please type it.",
  wait_please: "Wait, please.",
  // BN-3 (BIGTECH_TO_PRODUCT.md): two more requests aimed at staff, shown as prompts on the dashboard.
  slower: "Slower, please.",
  show_on_paper: "Please show me on paper.",
  say_another_way: "Please say it another way.",
  write_number: "Please write the number.",
};

/* ------------------------------------------------------------------ */
/* Guest-facing copy that tests check word for word                    */
/* ------------------------------------------------------------------ */

/** The Help button's one name, used everywhere (C2-14). */
export const HELP_LABEL = "Get staff now";

/**
 * AS-23 notice. Identical to compromised_device.md section 2.4 except one substitution, requested in
 * docs/requests.md: "The Emergency button" -> "The Get staff now button" (C2-14). The GST-1 test
 * compares against the document text with exactly that substitution.
 */
export const GUEST_NOTICE =
  "This page shows only this conversation. It stores nothing about the conversation on your device, though your browser may keep the page address in its history. The conversation ends when the desk taps End, or after 15 minutes. We will never ask you for a password, card number or ID on this screen. The Get staff now button is not the only way to get help: you can always wave to the staff. If you think your phone may be monitored, please use the hotel tablet.";

/** Sentences shown after the AS-23 notice (plan 4.4; C2-8 adds what the desk sees). */
export const GUEST_NOTICE_EXTRA = [
  "Video from the desk camera stays on the desk laptop. Nothing you send is read aloud until you choose to send it.",
  "The desk sees which signs the camera read, how certain the computer was, and, when the camera program provides one, a stick-figure drawing of your arms and hands (no face) for each sign. The desk also sees when a message has appeared on this screen. All of it is erased when the conversation ends.",
] as const;

/**
 * BN-2 (BIGTECH_TO_PRODUCT.md): honest guest-facing lines, each scoped to SignBridge. Line (c) names
 * the Help button by its one name (C2-14). Line (d) sits next to "Say it". Remove a line, never reword
 * it, if its BN-2 check fails.
 */
export const GUEST_HONEST_LINES = {
  camera: "The camera picture stays on this laptop. Only body and hand points are used for recognition, and nothing is sent anywhere for recognition.",
  keeps: "SignBridge keeps nothing after you finish.",
  mistakes: "This tool can make mistakes. For anything urgent, press Get staff now or wave, and staff will come to you.",
  face: "It cannot read facial expressions, so a headshake for 'not' can be missed. Check the sentence before you tap Say it.",
} as const;

/** BN-5: the guest keeps their own record in this screen's memory only. */
export const GUEST_SCROLLBACK_HINT = "You may photograph this screen. It is erased when the conversation ends.";

/** Sign choice card (C2-3): no claim that the system understands ASL. */
export const SIGN_CARD_TEXT =
  "The desk camera can recognise about 20 hotel requests, one sign at a time. It does not understand full ASL.";

/** Under the avatar (C2-17). */
export const AVATAR_DISCLAIMER = "Computer avatar. It signs word by word and may look unnatural. The English sentence above is exact.";

/** Marker on captions that came from speech-to-text (C2-13). */
export const SPEECH_CAPTION_NOTE = "From speech recognition, may contain mistakes.";

/** Repeat request wording: the system is the subject (C2-5). */
export const REPEAT_TEXT = "Sorry, the camera missed that sign. Could you sign it again, or type it?";

/** Note at the top of the staff Evidence tab (C2-5). */
export const EVIDENCE_NOTE = "Low scores usually mean camera position or a sign the model learned poorly, not how the guest signs.";

/* ------------------------------------------------------------------ */
/* Event bus: envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every SSE `data:` line is one JSON envelope. `seq` is per session and monotonic;
 * it is also the SSE `id:`. `at` is server time in ms since epoch. Pings are SSE comments
 * (": p"), not envelopes, sent every LIMITS.guestPingMs on guest streams.
 */
export type BusEnvelope<M> = { seq: number; at: number; msg: M };

/* ------------------------------------------------------------------ */
/* Event bus: messages the GUEST device receives (AS-1)                */
/* ------------------------------------------------------------------ */
// Guest messages carry no scores, no counters, no keys, no top-3 alternatives, no skeletons, no
// recognizer timestamps, no other guests, no privacy or recognizer details, no device addresses.
// The two unions are separate on purpose: the server builds a guest message from GuestEvent only.

export type GuestHello = {
  type: "hello";
  mode: DeploymentMode;
  profile: SessionProfile;
  vri: VriInfo;
  /** Team-owned device (team iPad, wiped laptop, Mode 0 window): no VRI link (AS-25), AS-8 input attributes. */
  kiosk: boolean;
  idleWipeMs: number;
  sessionCapMs: number;
  /** Always true in this build; shown on the data notice. */
  confirmBeforeSpeaking: true;
  /** Text-to-911 note, configurable per site; shown separately from Help (C2-14). */
  emergencyNote: string;
  /** The 6-digit check code while the session is PAIRED_UNCONFIRMED, else null (Tier 1). */
  check: string | null;
  /**
   * Mode 0 without guest input: the page renders no tappable controls at all, only instructions
   * ("Point to YES or NO on the card") (C2-1). False in Mode C/W and in Mode 0 with MODE0_GUEST_INPUT.
   */
  displayOnly: boolean;
  /** False when the recognizer is down, in mock mode or has no model (C2-23). No personal data. */
  signingAvailable: boolean;
  /**
   * How a sign is captured. "auto" = live.py cuts signs from continuous movement. "key" = live_key.py
   * records one sign per "Record a sign" tap, driven through the app server (LIVE_KEY_CONTROL_PORT).
   */
  signTrigger: SignTrigger;
};

/** See GuestHello.signTrigger. */
export type SignTrigger = "auto" | "key";

/** live_key.py recording phase, relayed while the guest is signing (no personal data). */
export type CapturePhase = { phase: "countdown" | "processing"; countdown: number | null; duration: number | null };

export type GuestPairConfirmed = { type: "pair_confirmed"; deskShows: string };

export type GuestSettings = {
  /** Echo of every mode or setting change, so the guest's own screen confirms it (C2-7). */
  type: "settings";
  guestMode: GuestMode;
  /** "Read my sentences aloud at the desk" (C2-22). */
  speakAloud: boolean;
  /** "Show avatar" (C2-22). */
  showAvatar: boolean;
};

export type GuestSnapshot = {
  type: "snapshot";
  state: SessionState;
  settings: GuestSettings;
  /** Last caption only; no scrollback (AS-1). The page itself keeps up to LIMITS.guestCaptionsKept in memory. */
  lastCaption: GuestStaffUtterance | null;
  pending: GuestProposal | null;
  /** Latest framing status, kept even outside Sign mode (C1-10); shown only in Sign mode. */
  framing: FramingStatus | null;
  signingAvailable: boolean;
  /** Help pressed and not yet acknowledged, so a reconnect keeps "Staff has been alerted". */
  emergencyPending: boolean;
  /**
   * Warnings already sent and still running, so a guest window that (re)connects after the
   * idle_warning / cap_warning event still shows "This session will end soon" (BN-5).
   */
  warnings: { idleSecondsLeft: number | null; capSecondsLeft: number | null };
};

/** CLAUDE.md 6.7 staff_utterance, extended. */
export type GuestStaffUtterance = {
  type: "staff_utterance";
  id: string;
  text: string;
  /** May be empty: then the guest sees captions only. */
  gloss: string[];
  glossSource: GlossSource;
  /** "voice" adds SPEECH_CAPTION_NOTE under the caption (C2-13). */
  captionSource: CaptionSource;
};

export type GuestLiveSign = { type: "live_sign"; sign: GuestSignView; simulated: boolean };

/** live_key.py: a recording started ("countdown") or stopped ("processing"). Shown as a countdown. */
export type GuestCapture = { type: "capture" } & CapturePhase;

/** The guest's "Undo last sign" reached live_key.py: this sign is no longer part of the sentence. */
export type GuestLiveSignUndone = { type: "live_sign_undone"; seq: number };

export type GuestFraming = { type: "framing"; status: FramingStatus; text: string };

/** CLAUDE.md 6.7 repeat_request, extended. Guest sees REPEAT_TEXT. Never sent while a proposal is pending (C1-5). */
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
  /** The recognizer reported "mock": shown as test mode, the send button disabled, never spoken. */
  testMode: boolean;
  simulated: boolean;
};

/** Echo after the guest sent a sentence: exactly what the desk received. */
export type GuestUtteranceEcho = {
  type: "guest_utterance";
  proposalId: string | null;
  text: string;
  /** "spoken" = read aloud at the desk; "shown" = text only; "waiting_for_staff" = name or typed text. */
  delivery: "spoken" | "shown" | "waiting_for_staff";
};

export type GuestStaffAck = { type: "staff_ack"; about: AlertKind };

/** Both warnings reach the guest (C2-10). `canAskForTime` shows "I need more time" (Tier 1). */
export type GuestIdleWarning = { type: "idle_warning"; secondsLeft: number; canAskForTime: boolean };
export type GuestCapWarning = { type: "cap_warning"; secondsLeft: number; canAskForTime: boolean };
/** The idle warning ended (a staff action or an accepted sign), or staff extended past the cap warning. */
export type GuestWarningCleared = { type: "warning_cleared"; kind: "idle" | "cap" };

export type GuestSessionPaused = { type: "session_paused"; reason: "device_changed" };

/** Recognizer availability changed (C2-23). */
export type GuestSigningAvailable = { type: "signing_available"; available: boolean };

export type GuestSessionEnd = {
  type: "session_end";
  reason: SessionEndReason;
  /** A proposal or a confirm in flight was discarded (C2-18). The page adds its own unsent-draft check. */
  pendingLost: boolean;
  /** features-plan F17: what this conversation used and that it was erased; built from real counters. */
  receipt?: GuestPrivacyReceipt;
};

export type GuestEvent =
  | GuestHello
  | GuestPairConfirmed
  | GuestSettings
  | GuestSnapshot
  | GuestStaffUtterance
  | GuestLiveSign
  | GuestCapture
  | GuestLiveSignUndone
  | GuestFraming
  | GuestRepeatRequest
  | GuestProposal
  | GuestUtteranceEcho
  | GuestStaffAck
  | GuestIdleWarning
  | GuestCapWarning
  | GuestWarningCleared
  | GuestSessionPaused
  | GuestSigningAvailable
  | GuestSessionEnd
  // features-plan.md additions (2026-10-11):
  | GuestLiveCaption
  | GuestCaptionBackendEvent
  | GuestFact
  | GuestFactCleared
  | GuestDeskAlert
  | GuestDeskAlertCleared;

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

/**
 * Every number here is a real counter incremented where the event happens (C1-13). Nothing is a
 * hard-coded zero: refused body-point keys are counted as refusals, and the disk statement is a
 * fixed honest sentence, not a "files written: 0" claim.
 */
export type PrivacyCounters = {
  /** Which vendor keys exist on this laptop (names only). Empty during the engagement window (D8). */
  vendorKeysConfigured: string[];
  vendorCalls: VendorCall[];
  /** Bytes of guest-derived data sent off the laptop. */
  guestBytesOffLaptop: number;
  /** Bus messages delivered to the guest device, and their bytes. */
  messagesToGuest: number;
  bytesToGuest: number;
  /** Bridge events accepted from the recognizer (labels and timestamps only). */
  bridgeEvents: number;
  /** Bridge events refused because they carried face, frames, pose or video keys, per key. */
  refusedBodyKeys: { face: number; frames: number; pose: number; video: number };
  /** Skeleton snapshots held in memory right now (wiped with the session). */
  skeletonsHeld: number;
  /** Fixed table sentences sent to /api/tts (Piper renders each into a temporary file, see diskNote). */
  ttsFixedSentences: number;
};

/**
 * Shown under the counters instead of a "files written" figure (C1-13). The app code has no file
 * writes (hygiene test); Nath's /api/tts runs Piper in a temporary folder and deletes it.
 */
export const PRIVACY_DISK_NOTE =
  "Guest names and typed text are never written to disk by the app. Piper writes temporary audio of the fixed sentences to the system temporary folder and deletes it. Next.js may write its own build cache.";

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

/**
 * Tier 2 (full set). Help presses and the guest's own consent choices are NEVER safety warnings
 * (C2-6, C2-7): Help raises the count on the Help banner, and mode or read-aloud changes are
 * neutral log lines.
 */
export type SafetyWarningKind =
  | "second_device"
  | "device_changed"
  | "repeated_request"
  | "unusual_rate"
  | "failed_pairing"
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

/** Compute Pressure states as reported by the browser; shown only where supported (Tier 2). */
export type PressureState = "nominal" | "fair" | "serious" | "critical";

export type DeviceHealth = {
  /** null = no Compute Pressure API, or not a kiosk device (reports only from team devices, C2-8). */
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
  /** https://<LAN_IP or DESK_NAME>:3443/guest#p=<code> (Mode C/W) or http://localhost:3000/guest#p=<code> (Mode 0). */
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
  profile: SessionProfile;
  /** Mode 0 guest window has its own input (stage only). */
  mode0GuestInput: boolean;
  recognizer: {
    state: RecognizerState;
    mode: RecognizerMode | null;
    fps: number | null;
    lastEventAt: number | null;
    /** Run id from P3 when present, else a local counter of detected restarts. */
    run: string | null;
    restarts: number;
    /** Latest framing status and since when it has not been OK (C1-10). */
    framing: FramingStatus | null;
    framingNotOkSince: number | null;
    /** Builder A addition (2026-10-10): who sent the latest event; the simulator is labelled (BRG-6). */
    source?: SignsSource | null;
    /** Builder A addition: the value the guest screen currently has (C2-23), for the staff fallback band. */
    signingAvailable?: boolean;
    /** "key" when live_key.py is driven through LIVE_KEY_CONTROL_PORT; "auto" for live.py. */
    trigger?: SignTrigger;
    /** live_key.py: true while its control port answers GET /health. Null without a control port. */
    controlUp?: boolean | null;
  };
  session: {
    state: SessionState;
    startedAt: number | null;
    lastActivityAt: number | null;
    idleWipeAt: number | null;
    /** The idle value in force, shown in the header (C1-8). */
    idleWipeMs: number;
    capAt: number | null;
    extensions: number;
  };
  guest: {
    device: GuestDeviceInfo | null;
    /** Check code once confirmed ("Paired with 960 792"); null before. */
    confirmedCheck: string | null;
    confirmTriesLeft: number | null;
    streams: number;
    /** From guest heartbeats and acknowledgements (C1-7). */
    lastHeardAt: number | null;
    settings: { guestMode: GuestMode; speakAloud: boolean; showAvatar: boolean };
    failedJoins: number;
  };
  counters: { repeats: number; proposals: number; confirmed: number; fixed: number; ignoredWhilePending: number };
  privacy: { thisGuest: PrivacyCounters; sinceStart: PrivacyCounters; lastWipe: WipeReceipt | null };
  latency: LatencyStage[];
  deviceHealth: DeviceHealth;
  openWarnings: number;
  /**
   * Builder A addition (2026-10-10): alerts still open, so a reconnecting staff screen keeps the Help
   * banner and its count (GST-2a), the interpreter banner and "Guest needs more time".
   */
  alerts?: { emergency: { count: number; since: number } | null; interpreterAt: number | null; moreTimeAt: number | null };
  /** Builder A addition: open staff streams (SRV-19 test). */
  staffStreams?: number;
  flags: {
    simulateEnabled: boolean;
    vlmFallback: boolean;
    englishFallback: boolean;
    bridgeKeyConfigured: boolean;
    transcribeAvailable: boolean;
    /** Builder B addition: /api/tts can make audio (ElevenLabs key, or PIPER_FALLBACK=1). Optional for older servers. */
    ttsAvailable?: boolean;
  };
  /** features-plan F3: live caption backends and which one is live. Optional until Builder S fills it. */
  captions?: CaptionStatus;
  /** features-plan F16: anonymous equal-access counts since the server started (memory only). */
  equalAccess?: EqualAccessCounters;
};

/** One line of the in-memory conversation log on the staff screen. */
export type LogEntry =
  | { kind: "staff"; seq: number; at: number; id: string; text: string; gloss: string[]; captionSource: CaptionSource; glossSource: GlossSource; intent: StaffIntentKey | null; shownOnDeviceAt: number | null; guestReply: GuestReplyKind | null }
  | { kind: "guest"; seq: number; at: number; proposalId: string; text: string; signs: StaffSignView[]; intentId: GuestIntentId | null; source: CandidateSource; speak: SpeakPlan; spokenAt: number | null; confirmedBy: "guest" | "staff_for_guest"; simulated: boolean }
  | { kind: "guest_typed"; seq: number; at: number; text: string; readAloudAt: number | null }
  | { kind: "guest_reply"; seq: number; at: number; reply: GuestReplyKind; captionId: string | null }
  | { kind: "guest_setting"; seq: number; at: number; text: string }
  | { kind: "repeat"; seq: number; at: number; reason: RepeatReason; recognizerSaidRepeat: boolean }
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
export type StaffDelivered = {
  type: "delivered";
  eventSeq: number;
  roundTripMs: number | null;
  /** Builder B addition: the caption the guest device rendered, so the staff log can mark "shown on device". */
  captionId?: string | null;
};

export type StaffLiveSign = { type: "live_sign"; sign: StaffSignView; source: SignsSource };
/** live_key.py recording phase, for the staff live-sign strip. */
export type StaffCapture = { type: "capture" } & CapturePhase;
/** The guest undid this sign (live_key.py); it is left out of the sentence. */
export type StaffLiveSignUndone = { type: "live_sign_undone"; seq: number };

export type StaffFraming = { type: "framing"; status: FramingStatus; hint: string; rejectedSeq: number | null; notOkSince: number | null };

/** Utterance outcome for the dashboard. */
export type StaffRecognition = {
  type: "recognition";
  source: SignsSource;
  receivedAt: number;
  signs: StaffSignView[];
  outcome: ProposalKind | "repeat" | "ignored_pending" | "held";
  repeatReason: RepeatReason | null;
  /** The recognizer's needs_repeat hint, for the log only (C1-4). */
  recognizerSaidRepeat: boolean;
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
  /** features-plan F2/F6: how a non-recognised sentence was picked (staff label "Tapped on board"). */
  via?: PhraseVia;
};

export type StaffGuestFix = { type: "guest_fix"; proposalId: string; action: GuestFixAction };
export type StaffGuestTyped = { type: "guest_typed"; text: string };
/** Guest tapped a repair reply under a caption (C2-11); marks that caption "Guest did not understand". */
export type StaffGuestReply = { type: "guest_reply"; reply: GuestReplyKind; captionId: string | null };
/** A neutral log line, never a safety warning (C2-7). */
export type StaffGuestChoice = { type: "guest_choice"; guestMode: GuestMode; speakAloud: boolean; showAvatar: boolean };
/** `context` only when the guest ticked "Share this card with the interpreter" (features-plan F11). */
export type StaffInterpreterRequest = { type: "interpreter_request"; vri: VriInfo; context?: InterpreterContextCard | null };
/** Help pressed; `count` merges repeats until staff acknowledge; the banner says "Help pressed N times: go now". */
export type StaffEmergency = { type: "emergency"; count: number };
/** Tier 1: the guest asked for more time on an idle or cap warning; banner "Guest needs more time: Keep open". */
export type StaffMoreTime = { type: "more_time"; on: "idle" | "cap" };
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
  | StaffCapture
  | StaffLiveSignUndone
  | StaffFraming
  | StaffRecognition
  | StaffRepeatRequest
  | StaffGuestUtterance
  | StaffGuestFix
  | StaffGuestTyped
  | StaffGuestReply
  | StaffGuestChoice
  | StaffInterpreterRequest
  | StaffEmergency
  | StaffMoreTime
  | StaffStaffAck
  | StaffWarning
  | StaffDeviceHealth
  | StaffChecklist
  | StaffIdleWarning
  | StaffCapWarning
  | StaffSessionPaused
  | StaffVlmProposal
  | StaffSessionEnd
  | StaffStatusEvent
  // features-plan.md additions (2026-10-11):
  | StaffLiveCaption
  | StaffFacts
  | StaffGuestNumber
  | StaffDeskAlertState;

export type Role = "guest" | "staff";

/* ------------------------------------------------------------------ */
/* Actions (request bodies)                                            */
/* ------------------------------------------------------------------ */

/** POST /api/guest/join body. The code comes from the URL fragment (#p=), never a query string. */
export type GuestJoinRequest = { code: string };

export type SignControlCmd = "record" | "undo" | "end";

export type GuestFixAction = "sign_again" | "type" | "interpreter" | "not_this";

/**
 * POST /api/guest/action body (guest cookie, same origin). Every action carries `n`, a client nonce
 * (16 random bytes as 32 hex characters); a nonce seen before in this session gets 409 (it catches
 * retries, not a compromised device, C1-21). `emergency` is dispatched before any limiter or nonce
 * check (C1-15). Limits are keyed per session and action kind: plan 9.5.
 */
export type GuestAction = { n: string } & (
  | { type: "guest_choice"; choice: "sign" | "type" | "tap" | "interpreter" | "text_only" }
  | { type: "stop_signing" }
  /** live_key.py through the app server: "record" one sign, "undo" the last one, "end" the sentence. */
  | { type: "sign_control"; cmd: SignControlCmd }
  /** Also accepted for the previous proposal within LIMITS.proposalGraceMs after it was replaced (C1-5). */
  /** BN-1: `voice: false` is the guest's "Text only" (shown at the desk, never voiced); omitted or true is "Say it". */
  | { type: "guest_confirm"; proposalId: string; candidateId: string; name?: string; voice?: boolean }
  | { type: "guest_fix"; proposalId: string; action: GuestFixAction }
  /** A request picked from the phrase list, confirmed on the guest screen first (C2-3). */
  | { type: "guest_phrase"; intentId: GuestIntentId; name?: string; voice?: boolean; via?: PhraseVia }
  | { type: "guest_typed"; text: string }
  /** Repair reply under a caption (C2-11). */
  | { type: "guest_reply"; reply: GuestReplyKind; captionId: string | null }
  /** features-plan F11: `context` is sent only after the guest ticked the consent box on their own screen. */
  | { type: "interpreter_request"; context?: InterpreterContextConsent }
  /** features-plan F7: a number typed on the guest number pad (digits only); shown to staff, never spoken without a staff tap. */
  | { type: "guest_number"; about: NumberAbout; value: string }
  /** features-plan F9: the guest saw a desk alert and tapped "OK". */
  | { type: "ack_alert"; id: string }
  /** Never refused with 429 or 409; accepted before confirmation and while paused. */
  | { type: "emergency" }
  | { type: "prefs"; speakAloud?: boolean; showAvatar?: boolean }
  /** Render acknowledgement (latency, checklist, heartbeat); never counts as activity. */
  | { type: "ack"; seq: number }
  /** Every LIMITS.guestHeartbeatMs (C1-7); rate-limited, never counts as activity. */
  | { type: "heartbeat" }
  /** Tier 1: "I need more time" on an idle or cap warning (C2-10); never resets a timer itself. */
  | { type: "more_time"; on: "idle" | "cap" }
  /** Tier 2: Compute Pressure state; sent only from kiosk devices whose browser supports it (C2-8). */
  | { type: "device_health"; state: PressureState }
);

/** POST /api/staff/claim body: the one-time capability from the #k= URL printed at start (or after SIGUSR2). */
export type StaffClaimRequest = { k: string };

/** POST /api/staff/action body (staff listener, Host 127.0.0.1:3000, staff cookie, same origin). */
export type StaffAction =
  | { type: "new_guest" }
  | { type: "guest_is_here" }
  | { type: "refresh_code" }
  /** Mode 0: returns the http://localhost:3000/guest#p=<code> URL for the second-display window. */
  | { type: "open_guest_window" }
  | { type: "confirm_pair"; check: string }
  /** New code for the same guest (keeps the log, revokes the old cookie). */
  | { type: "repair" }
  | { type: "end_guest" }
  | { type: "extend" }
  /** "Keep open": resets the idle timer. */
  | { type: "touch" }
  | { type: "say_quick"; intent: StaffIntentKey }
  /** Voice text is reviewed in the free-text box before it is sent (C2-13). */
  | { type: "say_text"; text: string; gloss: string[] | null; source: "voice" | "typed" }
  | { type: "ack"; about: AlertKind }
  /** Staff tapped "Speak name" or "Read aloud" (AS-13); the server answers with the text to voice locally. */
  | { type: "speak_name"; proposalId: string }
  | { type: "read_aloud"; logSeq: number }
  /** The staff page reports how and when it voiced a sentence (latency and privacy panels). */
  | { type: "speak_done"; ref: string; how: "tts" | "local" | "none"; startedAt: number }
  /** Mode 0 display-only: the receptionist confirms for the guest after the guest points at the card. */
  | { type: "confirm_for_guest"; proposalId: string; candidateId: string }
  | { type: "reject_for_guest"; proposalId: string }
  /** Mode 0 display-only: the receptionist records the guest's choice after the guest points at it. */
  | { type: "choice_for_guest"; choice: "sign" | "type" | "tap" | "interpreter" | "text_only" }
  | { type: "checklist_seen"; item: CheckinItemKey }
  | { type: "dismiss_warning"; id: string }
  | { type: "device_health"; state: PressureState }
  /** The staff browser used the Web Speech fallback after its disclosure; counted on the privacy panel. */
  | { type: "note_vendor"; destination: "browser speech service" }
  // features-plan.md additions (2026-10-11):
  /** Choose the live-caption backend. Cloud backends are refused in the engagement profile (D8). */
  | { type: "caption_backend"; backend: CaptionBackend }
  /** Browser speech (Web Speech API) runs in the staff page; its text comes in here. Local STT does not use this. */
  | { type: "live_caption"; utteranceId: string; text: string; final: boolean; backend: BrowserCaptionBackend }
  /** Staff withdraw a live caption that was wrong ("Remove from guest screen"). */
  | { type: "retract_caption"; utteranceId: string }
  /** Facts typed by staff (never from speech recognition), shown as tiles and on the take-home card. */
  | { type: "set_fact"; key: FactKey; value: string }
  | { type: "clear_fact"; key: FactKey }
  /** Re-sends every fact event after a guest reconnect (the snapshot keeps AS-1: last caption only). */
  | { type: "resend_facts" }
  /** Generic visual alert to the guest device, from the fixed code list only. */
  | { type: "send_alert"; code: DeskAlertCode }
  | { type: "cancel_alert"; id: string };

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "bad_request"          // 400: body failed validation (wrong check code carries triesLeft; name/text carry `field`)
  | "unauthorized"         // 401: missing or dead cookie, wrong X-Bridge-Key
  | "forbidden"            // 403: wrong listener, not loopback, bad Host, bad Origin, address not in GUEST_IPS
  | "not_found"            // 404: feature switched off (simulator, VLM fallback, english fallback)
  | "conflict"             // 409: wrong state, proposal not pending (after the grace), guest not signing, reused nonce
  | "gone"                 // 410: pairing code or staff capability used or expired
  | "length_required"      // 411: raw upload without Content-Length
  | "too_large"            // 413
  | "unsupported_type"     // 415
  | "rate_limited"         // 429 (never for emergency)
  | "upstream_failed"      // 502: vendor call failed (status number only)
  | "not_configured";      // 503: BRIDGE_KEY missing or too short, TTS busy

/**
 * `field` and `message` let the guest page show the specific reason next to the field ("Names can
 * use letters, spaces, hyphens and apostrophes") instead of only disabling the button (C2-25).
 */
export type ApiError = { ok: false; error: ErrorCode; message: string; triesLeft?: number; field?: "name" | "text" };

/** The guest token is NOT in this body: it travels only in Set-Cookie (__Host-sb_g, or sb_g on Mode 0 localhost). */
export type GuestJoinResponse = { ok: true; check: string | null; hello: GuestHello } | ApiError;

/** `merged`: a merged or ignored-above-limit action (interpreter, more_time, ack, heartbeat). `logSeq`: typed text's log line. */
export type GuestActionResponse = { ok: true; merged?: boolean; proposalId?: string; logSeq?: number } | ApiError;

export type StaffClaimResponse = { ok: true } | ApiError;

export type StaffActionResponse =
  | {
      ok: true;
      pairing?: PairingInfo;
      /** Mode 0 open_guest_window. */
      guestUrl?: string;
      /** speak_name / read_aloud: the text the staff page voices with an on-device voice. */
      speakText?: string;
      /** Builder A additions: say_quick / say_text caption id; end_guest wipe receipt. */
      captionId?: string;
      receipt?: WipeReceipt | null;
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
/** P2 request (plan 8, Tier 1): lookup.ts preloadSigns(bundle) so the guest listener needs no per-gloss fetch. */
export type SignBundle = { index: Record<string, string>; files: Record<string, unknown>; padding: string };

/* ================================================================== */
/* Features plan (docs/features-plan.md, 2026-10-11)                   */
/* ================================================================== */
// Shared types for Builder G (guest side) and Builder S (staff and server). Feature ids F1..F17
// are the rows of docs/features-plan.md section 2. Everything here keeps the existing rules:
// AS-1 (guest messages carry no scores, keys, counters or other guests), AS-3 (no browser storage
// on the guest page: every guest preference below lives in page memory only), D8 (the whole app
// works with no vendor key), BN-1 (nothing is spoken without the guest's tap).

/** Limits for the features-plan additions (kept apart from LIMITS so existing code is untouched). */
export const FEATURE_LIMITS = {
  /** Local STT: 16 kHz mono signed 16-bit PCM. One utterance is cut at this length and finalised. */
  sttSampleRate: 16_000,
  sttUtteranceMaxMs: 15_000,
  /** Body cap for POST /api/staff/stt (30 s of 16 kHz s16le, with room for the cut above). */
  sttBodyMaxBytes: 960_000,
  /** While the receptionist speaks, the growing utterance is re-sent this often for interim words. */
  sttInterimEveryMs: 700,
  /** Silence that ends an utterance (energy gate in the staff page; faster-whisper's VAD trims inside). */
  sttSilenceEndMs: 600,
  /** The app server waits at most this long for the local STT process, then drops that request. */
  sttTimeoutMs: 8_000,
  /** At most this many requests queued in the local STT process; more get 503 "busy" (interim only). */
  sttQueueMax: 2,
  /** Live caption text cap (characters) and how many live_caption events per second the server forwards. */
  liveCaptionMaxChars: 300,
  liveCaptionsPerSecond: 5,
  /** Live captions the guest page keeps in memory (the final ones also join the BN-5 record). */
  guestLiveCaptionsKept: 6,
  /** Fact values typed by staff. */
  factValueMax: 60,
  /** Desk alerts: at most this many open at once, and per minute. */
  alertsOpenMax: 3,
  alertsPerMinute: 6,
  /** Guest number pad: digits only, at most this many. */
  guestNumberMaxDigits: 6,
  /** Equal-access counters: any count below this is shown as "fewer than 5" (no small cells). */
  equalAccessMinShown: 5,
} as const;

/* ---------------- F3: live captions of the receptionist's speech ---------------- */

/**
 * Which speech-to-text produced a live caption. Always shown next to the caption on both screens
 * (the "captions badge"), so a cloud path is never presented as local.
 * - "local": faster-whisper (Systran/faster-whisper-small.en, int8, CPU) in web/stt/local_stt.py on
 *   127.0.0.1, HF_HUB_OFFLINE=1. Audio never leaves the laptop.
 * - "cloud_openai": P1's POST /api/transcribe (OpenAI), only when OPENAI_API_KEY is set; utterance-at-a-time.
 * - "browser_google" / "browser_apple" / "browser_other": the browser's own speech recognition
 *   (Web Speech API) in the staff page. The browser sends the audio to its maker. Explicit opt-in.
 * - "typed": no speech recognition; staff type or use quick replies (always available).
 */
export type CaptionBackend = "local" | "cloud_openai" | "browser_google" | "browser_apple" | "browser_other" | "typed";
export type BrowserCaptionBackend = "browser_google" | "browser_apple" | "browser_other";

/** The badge text, word for word (tests check it). */
export const CAPTION_BACKEND_LABEL: Readonly<Record<CaptionBackend, string>> = {
  local: "On this laptop",
  cloud_openai: "Cloud: OpenAI speech-to-text",
  browser_google: "Cloud: Google (Chrome speech recognition)",
  browser_apple: "Cloud: Apple (Safari speech recognition)",
  browser_other: "Cloud: this browser's speech service",
  typed: "Typed",
};

/** True for every backend that sends audio off the laptop. */
export const CAPTION_BACKEND_IS_CLOUD: Readonly<Record<CaptionBackend, boolean>> = {
  local: false,
  cloud_openai: true,
  browser_google: true,
  browser_apple: true,
  browser_other: true,
  typed: false,
};

/**
 * Staff-side disclosure shown before browser speech can be switched on, and kept on screen while it
 * runs. "{vendor}" is "Google" (Chrome, Edge), "Apple" (Safari) or "the browser maker".
 */
export const BROWSER_SPEECH_DISCLOSURE =
  "Browser speech recognition sends the sound from this microphone to {vendor} to turn it into text. It is not processed on this laptop. Use it only if the local captions are not running.";
/** Guest-side line under live captions while a cloud backend is live (the badge names it). */
export const CLOUD_CAPTION_GUEST_NOTE = "The desk's speech is turned into text by an outside service, named above.";
/** Guest-side line under live captions while the local backend is live. */
export const LOCAL_CAPTION_GUEST_NOTE = "The desk's speech is turned into text on the desk laptop. Nothing is sent outside.";
/** Under every live caption, with the grey words explained (FEATURE_STRATEGY feature 12). */
export const LIVE_CAPTION_NOTE = "Machine captions. Grey words may be wrong; tap \"Please type it\" if unsure.";

/** One word of a live caption. `unsure` = the recogniser's word probability was low (shown grey, dotted). */
export type LiveCaptionWord = { w: string; unsure: boolean };

/**
 * A live caption of the receptionist's speech, word by word. Interim revisions replace each other
 * (same utteranceId, higher rev); `final: true` closes the utterance. The text has passed the
 * hygiene step (NFKC, control characters removed, card-number-like digit runs replaced by
 * "[number hidden]"). Live captions never drive the avatar and never tick a checklist item, and a
 * number heard here never becomes a fact tile (F1).
 */
export type GuestLiveCaption = {
  type: "live_caption";
  utteranceId: string;
  rev: number;
  final: boolean;
  text: string;
  words: LiveCaptionWord[];
  backend: CaptionBackend;
  /** Staff removed this caption ("Remove from guest screen"): the guest page strikes it out with "Removed by the desk". */
  retracted?: boolean;
};

/** The badge changed (staff switched backend, or the local process went down and captions fell back to typed). */
export type GuestCaptionBackendEvent = { type: "caption_backend"; backend: CaptionBackend | null };

/** Staff mirror of a live caption: exactly what the guest sees, plus how long recognition took. */
export type StaffLiveCaption = Omit<GuestLiveCaption, "type"> & {
  type: "live_caption";
  /** Recognition time for this revision in ms (local STT decode time, or null for browser/cloud). */
  decodeMs: number | null;
  /** Time from the end of speech to the final caption reaching the server, when measurable. */
  speechEndToFinalMs: number | null;
};

/** Status of the caption backends, in StaffStatus.captions. */
export type CaptionStatus = {
  /** The backend live right now; null = live captions off. */
  live: CaptionBackend | null;
  /** Local STT process: "up" (GET /health answered and the model is loaded), "down", or "off" (no LOCAL_STT_PORT). */
  local: "up" | "down" | "off";
  /** P1 /api/transcribe has a key (and the profile allows cloud). */
  cloudOpenaiAvailable: boolean;
  /** The profile allows the browser speech opt-in (false in "engagement", D8). */
  browserAllowed: boolean;
  /** Median and last local decode time in ms over the last 20 requests, or null (measured, never invented). */
  localDecodeMs: { median: number | null; last: number | null };
};

/** Body of POST /api/staff/stt is raw PCM; these headers carry the rest (validated, short). */
export type SttRequestHeaders = {
  "x-sb-utterance": string;
  /** "0" interim, "1" final. */
  "x-sb-final": "0" | "1";
  /** ms since epoch when the staff page detected the end of speech (final only), for the latency panel. */
  "x-sb-speech-end"?: string;
};

/** What web/stt/local_stt.py answers on POST /transcribe (loopback, X-STT-Key). */
export type LocalSttResponse = {
  text: string;
  words: { w: string; p: number }[];
  audioMs: number;
  decodeMs: number;
};

/** Word probability below this is shown as unsure (grey, dotted underline). */
export const STT_UNSURE_BELOW = 0.5;

/* ---------------- F1/F4: facts on screen and the take-home card ---------------- */

/** Facts the guest keeps. Values always come from staff typing or the property settings, never from speech recognition. */
export type FactKey =
  | "room"
  | "wifi_network"
  | "wifi_password"
  | "breakfast"
  | "checkout"
  | "late_checkout"
  | "restaurant"
  | "parking"
  | "hotel_text";

export const FACT_KEYS: readonly FactKey[] = [
  "room",
  "wifi_network",
  "wifi_password",
  "breakfast",
  "checkout",
  "late_checkout",
  "restaurant",
  "parking",
  "hotel_text",
];

/** Tile and card labels. */
export const FACT_LABEL: Readonly<Record<FactKey, string>> = {
  room: "Room",
  wifi_network: "Wi-Fi network",
  wifi_password: "Wi-Fi password",
  breakfast: "Breakfast",
  checkout: "Checkout",
  late_checkout: "Late checkout",
  restaurant: "Restaurant",
  parking: "Parking",
  hotel_text: "Text the front desk",
};

/**
 * Sensitive facts: never spoken by the app, never sent to any vendor, never in a log line. The staff
 * screen suggests "Your room number is on your screen" instead of saying it in the lobby.
 */
export const FACT_SENSITIVE: Readonly<Record<FactKey, boolean>> = {
  room: true,
  wifi_network: false,
  wifi_password: true,
  breakfast: false,
  checkout: false,
  late_checkout: false,
  restaurant: false,
  parking: false,
  hotel_text: false,
};

/** Which quick reply also pins which fact (Builder S: say_quick pins the fact when it has a value). */
export const FACT_FOR_QUICK_REPLY: Readonly<Partial<Record<StaffIntentKey, FactKey>>> = {
  room_number: "room",
  wifi_password: "wifi_password",
  breakfast_time: "breakfast",
  checkout_time: "checkout",
  late_checkout: "late_checkout",
  restaurant_hours: "restaurant",
  parking_downstairs: "parking",
};

/** "staff_typed" for per-guest values; "property" for the values set once for the hotel (env or the staff Facts panel). */
export type FactSource = "staff_typed" | "property";

export type Fact = { key: FactKey; value: string; source: FactSource; at: number };

/** A fact tile appeared or changed on the guest screen. Not in the guest snapshot (AS-1): see "resend_facts". */
export type GuestFact = { type: "fact"; fact: Fact };
export type GuestFactCleared = { type: "fact_cleared"; key: FactKey };

/** Staff copy of the current fact set (this guest only), sent on every change and in the reconnect flow. */
export type StaffFacts = { type: "facts"; facts: Fact[]; property: Partial<Record<FactKey, string>> };

/** Take-home card wording (guest device only; built in the browser, QR holds the text itself, not a link). */
export const TAKE_HOME_TITLE = "Your hotel card";
export const TAKE_HOME_NOTE =
  "This card is made on this screen. The QR code holds the text itself, not a link. Scan it or photograph the screen. The hotel does not keep a copy, and the card is erased when the conversation ends.";
export const TAKE_HOME_SHOW = "Show my card";

/* ---------------- F2: picture request board ---------------- */

/** How a fixed sentence was chosen without recognition. Staff labels: "Tapped on board", "Picked from the list", "Typed, matched to a request". */
export type PhraseVia = "board" | "phrase_list" | "typed_match";

export const PHRASE_VIA_STAFF_LABEL: Readonly<Record<PhraseVia, string>> = {
  board: "Tapped on board",
  phrase_list: "Picked from the list",
  typed_match: "Typed, matched to a request",
};

/** Icon names for the board; the guest component draws each as an inline SVG (no image files, no network). */
export type BoardIcon =
  | "yes" | "no" | "reservation" | "name" | "thanks" | "elevator" | "wifi" | "breakfast_time" | "breakfast_place"
  | "towels" | "checkout_time" | "late_checkout" | "parking" | "taxi" | "help" | "room_where" | "room_problem"
  | "restaurant_where" | "restaurant_time" | "done";

/**
 * The board: every one of the 20 guest intents (vocabulary.md section 2) as a picture with a short
 * label. No tile names a condition (no "I have hearing loss" tile; FEATURE_STRATEGY feature 2).
 * Order: most-asked hotel requests first; YES / NO / Thank you / That's all last.
 */
export const BOARD_TILES: readonly { intentId: GuestIntentId; label: string; icon: BoardIcon }[] = [
  { intentId: 10, label: "More towels", icon: "towels" },
  { intentId: 7, label: "Wi-Fi password", icon: "wifi" },
  { intentId: 8, label: "Breakfast time", icon: "breakfast_time" },
  { intentId: 9, label: "Breakfast where", icon: "breakfast_place" },
  { intentId: 11, label: "Checkout time", icon: "checkout_time" },
  { intentId: 12, label: "Late checkout", icon: "late_checkout" },
  { intentId: 14, label: "Call a taxi", icon: "taxi" },
  { intentId: 16, label: "Find my room", icon: "room_where" },
  { intentId: 17, label: "Room problem", icon: "room_problem" },
  { intentId: 6, label: "Elevator", icon: "elevator" },
  { intentId: 13, label: "Parking", icon: "parking" },
  { intentId: 18, label: "Restaurant where", icon: "restaurant_where" },
  { intentId: 19, label: "Restaurant hours", icon: "restaurant_time" },
  { intentId: 3, label: "I have a booking", icon: "reservation" },
  { intentId: 4, label: "My name", icon: "name" },
  { intentId: 15, label: "Help, please", icon: "help" },
  { intentId: 1, label: "Yes", icon: "yes" },
  { intentId: 2, label: "No", icon: "no" },
  { intentId: 5, label: "Thank you", icon: "thanks" },
  { intentId: 20, label: "That's all", icon: "done" },
];

/* ---------------- F7: typed numbers ---------------- */

export type NumberAbout = "nights" | "room" | "people" | "other";

/** Staff-screen wording for a typed number ("Guest typed: 3 (nights)"). */
export const NUMBER_ABOUT_LABEL: Readonly<Record<NumberAbout, string>> = {
  nights: "nights",
  room: "room number",
  people: "people",
  other: "number",
};

export type StaffGuestNumber = { type: "guest_number"; about: NumberAbout; value: string; logSeq: number };

/* ---------------- F9: visual alerts from the desk to the guest device ---------------- */

/**
 * Generic codes only: no names, rooms or free text, so nothing personal travels in an alert. An
 * "emergency" code is deliberately NOT in the list (FEATURE_STRATEGY section 4: no emergency claims;
 * a screen may be asleep). Pager hardware is roadmap.
 */
export type DeskAlertCode = "come_to_desk" | "taxi_here" | "room_ready" | "look_at_desk";

export const DESK_ALERT_TEXT: Readonly<Record<DeskAlertCode, string>> = {
  come_to_desk: "Please come to the front desk.",
  taxi_here: "Your taxi is here.",
  room_ready: "Your room is ready.",
  look_at_desk: "Please look at the front desk.",
};

/** The guest device shows the alert full-width (no sound), flashes once unless reduced motion is on, and vibrates where the browser allows. */
export type GuestDeskAlert = { type: "desk_alert"; id: string; code: DeskAlertCode };
export type GuestDeskAlertCleared = { type: "desk_alert_cleared"; id: string };

/** Staff panel state: open alerts and whether the guest tapped OK. */
export type StaffDeskAlertState = { type: "desk_alerts"; alerts: { id: string; code: DeskAlertCode; sentAt: number; seenAt: number | null }[] };

/* ---------------- F10/F12: guest preferences (page memory only, AS-3) ---------------- */

/**
 * Held in the guest page's React state only: never localStorage, sessionStorage, IndexedDB, Cache
 * API, cookies or a service worker (AS-3). Gone when the conversation ends or the page reloads.
 * Only the subset the desk must know (mode, read-aloud, avatar on/off) is sent, via the existing
 * guest_choice and prefs actions.
 */
export type GuestPrefs = {
  textSize: 0 | 1 | 2;
  avatarSize: "small" | "medium" | "large";
  captionsOnly: boolean;
  alertFlash: boolean;
  alertVibrate: boolean;
  /** Show the interpreter choice first on later screens. */
  interpreterFirst: boolean;
  signLanguage: SignLanguage;
};

/* ---------------- F13: sign-language choice ---------------- */

/** ISO 639-3 codes. Only ASL is recognised; the others route to typing or an interpreter. */
export type SignLanguage = "ase" | "bfi" | "fsl" | "asf" | "isg" | "other";

export const SIGN_LANGUAGES: readonly { code: SignLanguage; name: string; recognised: boolean }[] = [
  { code: "ase", name: "American Sign Language (ASL)", recognised: true },
  { code: "bfi", name: "British Sign Language (BSL)", recognised: false },
  { code: "fsl", name: "French Sign Language (LSF)", recognised: false },
  { code: "asf", name: "Auslan", recognised: false },
  { code: "isg", name: "Irish Sign Language (ISL)", recognised: false },
  { code: "other", name: "Another sign language", recognised: false },
];

/** Shown when the guest picks any sign language other than ASL (FEATURE_STRATEGY Next 4, test 2). */
export const SIGN_LANGUAGE_NOT_YET = "Sign recognition is only for ASL today. You can type, tap pictures, or ask for an interpreter.";

/* ---------------- F11: interpreter hand-off with an optional context card ---------------- */

/**
 * What the guest agreed to share, ticked on their own screen after seeing the exact card text.
 * Nothing is sent to any provider by the app: staff read or copy the card when they call the
 * hotel's interpreting service.
 */
export type InterpreterContextConsent = {
  /** Include the sign language the guest picked. */
  language: SignLanguage | null;
  /** Include the topics so far (names of checklist topics, e.g. "room, Wi-Fi"), never names or numbers. */
  topics: boolean;
};

export type InterpreterContextCard = {
  language: string | null;
  topics: string[];
  /** The guest's open request, if any, as its fixed sentence (never typed text, never a name). */
  openRequest: string | null;
};

/* ---------------- F6: machine-or-human label on every line ---------------- */

/** One label per line, on the guest record and the staff log (FEATURE_STRATEGY feature 6). */
export type LineSourceLabel =
  | "Staff quick reply"
  | "Typed by staff"
  | "Staff speech, reviewed by staff"
  | "Staff speech, machine captions"
  | "Avatar (machine)"
  | "Signs recognised, confirmed by guest"
  | "Typed by guest"
  | "Tapped on board"
  | "Interpreter";

/* ---------------- F16: anonymous equal-access counters ---------------- */

/**
 * Counts only, since the server started, in memory only (reset on restart, never written to disk).
 * No timings, no per-session rows, no device or guest details. Any count below
 * FEATURE_LIMITS.equalAccessMinShown is shown as "fewer than 5".
 */
export type EqualAccessCounters = {
  sessions: number;
  modeChosen: Record<Exclude<GuestMode, "choosing">, number>;
  sentBy: { signs: number; board: number; phraseList: number; typed: number; typedMatch: number };
  repairReplies: number;
  interpreterRequests: number;
  factsShown: number;
  cardsShown: number;
  alertsSent: number;
  captionUtterances: Record<CaptionBackend, number>;
};

/* ---------------- F17: privacy receipt on the guest end screen ---------------- */

/**
 * Built by the server from real counters at session end. Guest-facing; no counts of anything
 * personal. `vendors` lists destinations that received data during this conversation (empty in the
 * offline configuration), each in plain words.
 */
export type GuestPrivacyReceipt = {
  /** Ways the guest used, e.g. ["Signs", "Pictures", "Typing"]. */
  used: string[];
  captionBackends: CaptionBackend[];
  /** "on_device" = the laptop's own voice; "cloud" = a vendor voice for fixed sentences; "none". */
  voice: "none" | "on_device" | "cloud";
  vendors: string[];
  erasedAt: number;
  itemsErased: number;
};

/* ---------------- Text hygiene (lib/app/hygiene.ts, Builder S) ---------------- */

/** What the hygiene step replaced; counted on the privacy panel, never the values themselves. */
export type RedactionKind = "card_number" | "long_digits" | "email" | "secret_phrase" | "token_shape";

/** Replacement text shown in captions and logs. */
export const REDACTED_TEXT: Readonly<Record<RedactionKind, string>> = {
  card_number: "[number hidden]",
  long_digits: "[number hidden]",
  email: "[email hidden]",
  secret_phrase: "[hidden]",
  token_shape: "[hidden]",
};

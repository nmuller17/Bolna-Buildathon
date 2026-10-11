// SignBridge app (P4, builder A): strict validation of everything that crosses a trust boundary
// (docs/app-plan.md sections 6.1, 6.2 and 8; SRV-11, BRG-2, BRG-7a, CAP-2, SPK-6, GST-8).
//
// - Bridge events from recognition/live.py --post (README "App bridge"): `type` must be known,
//   unknown keys are ignored, every known key is checked strictly; top-level face/frames/pose/video
//   keys are refused and reported so the privacy panel can count them.
// - Guest and staff action bodies: exact shapes, unknown keys refused.
// - Names, guest text, staff text and gloss tokens.
// Pure functions; every error carries a plain message (and `field` for the guest page, C2-25).
import {
  LIMITS,
  SIGN_LABEL_ALIASES,
  SIGN_LABELS,
  STAFF_INTENT_KEYS,
  CHECKIN_ITEMS,
  type BridgeFraming,
  type BridgeCapture,
  type BridgeSign,
  type BridgeStatus,
  type BridgeVlmSuggestion,
  type FramingStatus,
  type GuestAction,
  type GuestIntentId,
  type Point2,
  type Prediction,
  type SignLabel,
  type SkeletonSnapshot,
  type StaffAction,
} from "./types.ts";

export type Invalid = { ok: false; message: string; field?: "name" | "text" };
type Valid<T> = { ok: true; value: T };

const bad = (message: string, field?: "name" | "text"): Invalid => (field ? { ok: false, message, field } : { ok: false, message });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/* ------------------------------------------------------------------ */
/* Labels and predictions                                              */
/* ------------------------------------------------------------------ */

const LABEL_SET: ReadonlySet<string> = new Set(SIGN_LABELS);

/** Exact label (case-sensitive) after the alias map; null when not one of the 22. */
export function normalizeLabel(raw: unknown): SignLabel | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const l = has(SIGN_LABEL_ALIASES as Record<string, unknown>, raw) ? SIGN_LABEL_ALIASES[raw] : raw;
  return LABEL_SET.has(l) ? (l as SignLabel) : null;
}

function prediction(raw: unknown): Prediction | null {
  if (!isObj(raw)) return null;
  const label = normalizeLabel(raw.label);
  if (!label || !isNum(raw.conf) || raw.conf < 0 || raw.conf > 1) return null;
  return { label, conf: raw.conf };
}

function predictions(raw: unknown, min: number, max: number): Prediction[] | null {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return null;
  const out: Prediction[] = [];
  for (const p of raw) {
    const v = prediction(p);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bridge events                                                       */
/* ------------------------------------------------------------------ */

export const REFUSED_BODY_KEYS = ["face", "frames", "pose", "video"] as const;
export type RefusedBodyKey = (typeof REFUSED_BODY_KEYS)[number];

export const FRAMING_STATUSES: readonly FramingStatus[] = [
  "OK", "STEP_BACK", "MOVE_CAMERA_DOWN", "COME_CLOSER", "CENTER", "CENTER_LEFT", "CENTER_RIGHT", "HANDS_OUT", "NO_PERSON",
];

/** Validated bridge events. `top` is re-sorted best first; labels are aliased. */
export type ValidSign = Omit<BridgeSign, "top"> & { top: Prediction[] };

/**
 * Both utterance shapes of the shared contract, normalized (see BridgeUtterance in types.ts).
 * - "stream" (live.py, live_window.py): `signs` = top-1 with its score; `seqs` when sent.
 * - "sentence" (live_key.py): `signs` = the raw labels with NO score (conf is unknown, so it is null
 *   here and the app joins each label with its `sign` event); `corrected` = the recognizer's snapped
 *   labels when they differ from the raw ones. The recognizer's `text` is checked and dropped.
 */
export type ValidUtterance = {
  type: "utterance";
  shape: "stream" | "sentence";
  labels: SignLabel[];
  /** Score of each label from the utterance itself: the stream shape only. */
  confs: number[] | null;
  seqs: number[] | null;
  corrected: SignLabel[] | null;
  needs_repeat: boolean;
  t_end: number | null;
  t_sent?: number;
  run?: string;
};
export type ValidBridgeEvent =
  | ValidSign
  | ValidUtterance
  | BridgeFraming
  | BridgeStatus
  | BridgeCapture
  | (Omit<BridgeVlmSuggestion, "label"> & { label: SignLabel });

export type BridgeValidation =
  | { ok: true; event: ValidBridgeEvent }
  | { ok: false; message: string; refusedKeys: RefusedBodyKey[] };

const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEQ_MAX = 1_000_000_000;

/** 1..max labels, each one of the 22 after the alias map. */
function labelList(raw: unknown, max: number): SignLabel[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return null;
  const out: SignLabel[] = [];
  for (const l of raw) {
    const v = normalizeLabel(l);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

const optNum = (o: Record<string, unknown>, k: string) => !has(o, k) || o[k] === null || o[k] === undefined || isNum(o[k]);
const numOrUndef = (v: unknown): number | undefined => (isNum(v) ? v : undefined);

function point(raw: unknown): Point2 | null {
  if (!Array.isArray(raw) || raw.length !== 2 || !isNum(raw[0]) || !isNum(raw[1])) return null;
  if (Math.abs(raw[0]) > 100 || Math.abs(raw[1]) > 100) return null;
  return [Math.round(raw[0] * 1000) / 1000, Math.round(raw[1] * 1000) / 1000];
}

function points(raw: unknown, n: number): Point2[] | null {
  if (!Array.isArray(raw) || raw.length !== n) return null;
  const out: Point2[] = [];
  for (const p of raw) {
    const v = point(p);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

/** The skeleton snapshot in its exact shape only (plan 6.2): t, 7 pose points, two hands of 21 or null, nothing else. */
export function validateSkeleton(raw: unknown): SkeletonSnapshot | null {
  if (!isObj(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 4 || !["t", "pose", "lh", "rh"].every((k) => has(raw, k))) return null;
  if (JSON.stringify(raw).length > LIMITS.skeletonMaxBytes) return null;
  if (!isNum(raw.t)) return null;
  const pose = points(raw.pose, 7);
  const lh = raw.lh === null ? null : points(raw.lh, 21);
  const rh = raw.rh === null ? null : points(raw.rh, 21);
  if (!pose || (raw.lh !== null && !lh) || (raw.rh !== null && !rh)) return null;
  return { t: raw.t, pose, lh, rh };
}

export function validateBridgeEvent(raw: unknown): BridgeValidation {
  const fail = (message: string, refusedKeys: RefusedBodyKey[] = []) => ({ ok: false as const, message, refusedKeys });
  if (!isObj(raw)) return fail("body must be a JSON object");
  const refused = REFUSED_BODY_KEYS.filter((k) => has(raw, k));
  if (refused.length) return fail(`refused body keys: ${refused.join(", ")} (no video, frames, face or pose points)`, refused);
  const type = raw.type;
  // Shared contract: t_sent is optional (no recognizer sends it yet); when present it must be a real time.
  if (has(raw, "t_sent") && (!isNum(raw.t_sent) || raw.t_sent <= 0)) return fail("t_sent must be a Unix time in seconds");
  if (has(raw, "run") && (typeof raw.run !== "string" || !RUN_RE.test(raw.run))) return fail("run must be 1 to 64 letters, digits, _ or -");
  const common = {
    ...(isNum(raw.t_sent) ? { t_sent: raw.t_sent } : {}),
    ...(typeof raw.run === "string" ? { run: raw.run } : {}),
  };

  if (type === "sign") {
    if (!isInt(raw.seq, 1, SEQ_MAX)) return fail("seq must be a positive integer");
    const top = predictions(raw.top, 1, LIMITS.maxTop);
    if (!top) return fail("top must hold 1 to 5 predictions with a known label and a score in [0, 1]");
    const times = ["t_sign_start", "t_sign_end", "t_closed", "t_predicted"] as const;
    for (const k of times) if (!optNum(raw, k)) return fail(`${k} must be a number when present`);
    let skeleton: SkeletonSnapshot | undefined;
    if (has(raw, "skeleton") && raw.skeleton !== null && raw.skeleton !== undefined) {
      const s = validateSkeleton(raw.skeleton);
      if (!s) return fail("skeleton must be exactly {t, pose: 7 points, lh, rh: 21 points or null}, at most 2 KB");
      skeleton = s;
    }
    top.sort((a, b) => b.conf - a.conf);
    const event: ValidSign = { type: "sign", seq: raw.seq, top, ...(skeleton ? { skeleton } : {}), ...common };
    for (const k of times) {
      const v = numOrUndef(raw[k]);
      if (v !== undefined) event[k] = v;
    }
    return { ok: true, event };
  }
  if (type === "utterance") {
    if (has(raw, "needs_repeat") && raw.needs_repeat !== null && typeof raw.needs_repeat !== "boolean") return fail("needs_repeat must be true or false");
    if (!optNum(raw, "t_end")) return fail("t_end must be a number when present");
    const needs_repeat = raw.needs_repeat === true;
    const t_end = numOrUndef(raw.t_end) ?? null;
    /** Optional seqs: null when absent, false when malformed. */
    const parseSeqs = (n: number): number[] | null | false => {
      if (!has(raw, "seqs") || raw.seqs === null || raw.seqs === undefined) return null;
      if (!Array.isArray(raw.seqs) || raw.seqs.length !== n || !raw.seqs.every((s) => isInt(s, 1, SEQ_MAX))) return false;
      return raw.seqs as number[];
    };
    const SEQS_MSG = "seqs must list one positive integer per sign";

    if (has(raw, "labels")) {
      // live_key.py: { raw, labels, text, snapped }
      const labels = labelList(raw.labels, LIMITS.maxSigns);
      if (!labels) return fail("labels must hold 1 to 8 known sign labels");
      const rawLabels = has(raw, "raw") && raw.raw !== null && raw.raw !== undefined ? labelList(raw.raw, LIMITS.maxSigns) : labels;
      if (!rawLabels) return fail("raw must hold 1 to 8 known sign labels");
      if (has(raw, "text") && raw.text !== null && raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > LIMITS.staffTextMax)) {
        return fail("text must be a string of at most 300 characters, or null");
      }
      if (has(raw, "snapped") && raw.snapped !== null && raw.snapped !== undefined && typeof raw.snapped !== "boolean") return fail("snapped must be true or false");
      const seqs = parseSeqs(rawLabels.length);
      if (seqs === false) return fail(SEQS_MSG);
      const differs = labels.length !== rawLabels.length || labels.some((l, i) => l !== rawLabels[i]);
      return {
        ok: true,
        event: { type: "utterance", shape: "sentence", labels: rawLabels, confs: null, seqs, corrected: differs ? labels : null, needs_repeat, t_end, ...common },
      };
    }

    // live.py / live_window.py: { signs: [{label, conf}], seqs?, needs_repeat?, t_end? }
    const signs = predictions(raw.signs, LIMITS.minSigns, LIMITS.maxSigns);
    if (!signs) return fail("signs must hold 1 to 8 predictions with a known label and a score in [0, 1] (or send labels)");
    const seqs = parseSeqs(signs.length);
    if (seqs === false) return fail(SEQS_MSG);
    return {
      ok: true,
      event: {
        type: "utterance", shape: "stream", labels: signs.map((p) => p.label), confs: signs.map((p) => p.conf),
        seqs, corrected: null, needs_repeat, t_end, ...common,
      },
    };
  }
  if (type === "framing") {
    if (typeof raw.status !== "string" || !FRAMING_STATUSES.includes(raw.status as FramingStatus)) return fail("unknown framing status");
    if (!optNum(raw, "since")) return fail("since must be a number when present");
    if (has(raw, "rejected_seq") && !isInt(raw.rejected_seq, 1, SEQ_MAX)) return fail("rejected_seq must be a positive integer");
    const since = numOrUndef(raw.since);
    return {
      ok: true,
      event: {
        type: "framing", status: raw.status as FramingStatus,
        ...(since !== undefined ? { since } : {}),
        ...(has(raw, "rejected_seq") ? { rejected_seq: raw.rejected_seq as number } : {}),
        ...common,
      },
    };
  }
  if (type === "status") {
    if (has(raw, "fps") && raw.fps !== null && (!isNum(raw.fps) || raw.fps < 0 || raw.fps > 1000)) return fail("fps must be a number from 0 to 1000");
    if (raw.recognizer !== "ok" && raw.recognizer !== "mock" && raw.recognizer !== "no_model") return fail("recognizer must be ok, mock or no_model");
    if (!optNum(raw, "t")) return fail("t must be a number when present");
    const fps = numOrUndef(raw.fps);
    const t = numOrUndef(raw.t);
    return { ok: true, event: { type: "status", recognizer: raw.recognizer, ...(fps !== undefined ? { fps } : {}), ...(t !== undefined ? { t } : {}), ...common } };
  }
  if (type === "capture") {
    if (raw.phase !== "countdown" && raw.phase !== "processing") return fail("phase must be countdown or processing");
    for (const k of ["countdown", "duration"]) {
      if (!optNum(raw, k) || (isNum(raw[k]) && ((raw[k] as number) < 0 || (raw[k] as number) > 60))) return fail(`${k} must be 0 to 60 seconds when present`);
    }
    const countdown = numOrUndef(raw.countdown);
    const duration = numOrUndef(raw.duration);
    return {
      ok: true,
      event: { type: "capture", phase: raw.phase, ...(countdown !== undefined ? { countdown } : {}), ...(duration !== undefined ? { duration } : {}), ...common },
    };
  }
  if (type === "vlm_suggestion") {
    const label = normalizeLabel(raw.label);
    if (!isInt(raw.seq, 1, SEQ_MAX) || !label || !isNum(raw.conf) || raw.conf < 0 || raw.conf > 1) return fail("bad vlm_suggestion");
    if (typeof raw.model !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(raw.model)) return fail("bad vlm_suggestion model");
    return { ok: true, event: { type: "vlm_suggestion", seq: raw.seq, label, conf: raw.conf, model: raw.model, ...common } };
  }
  return fail("unknown event type");
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export const NAME_RULE_MESSAGE = "Names can use letters, spaces, hyphens and apostrophes";

/** Guest name (SPK-6): NFC; letters, marks, spaces, hyphen, apostrophe; 1 to 40 code points. */
export function sanitizeName(raw: unknown): Valid<string> | Invalid {
  if (typeof raw !== "string") return bad("Please type your name", "name");
  const s = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!s) return bad("Please type your name", "name");
  if ([...s].length > LIMITS.nameMax) return bad(`Names can be up to ${LIMITS.nameMax} characters`, "name");
  if (!/^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u.test(s)) return bad(NAME_RULE_MESSAGE, "name");
  return { ok: true, value: s };
}

function plainText(raw: string): string {
  return raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Text the guest typed (SPK-6): NFC, no control or format characters, 1 to 280 characters. */
export function sanitizeGuestText(raw: unknown): Valid<string> | Invalid {
  if (typeof raw !== "string") return bad("Please type a message first", "text");
  const s = plainText(raw);
  if (!s) return bad("Please type a message first", "text");
  if ([...s].length > LIMITS.guestTypedMax) return bad(`Messages can be up to ${LIMITS.guestTypedMax} characters`, "text");
  return { ok: true, value: s };
}

/** Staff free text (CAP-2): same cleaning, at most 300 characters and 600 UTF-8 bytes. */
export function sanitizeStaffText(raw: unknown): Valid<string> | Invalid {
  if (typeof raw !== "string") return bad("text must be a string", "text");
  const s = plainText(raw);
  if (!s) return bad("Please type something first", "text");
  if ([...s].length > LIMITS.staffTextMax || new TextEncoder().encode(s).length > LIMITS.captionMaxBytes) {
    return bad(`Text can be up to ${LIMITS.staffTextMax} characters`, "text");
  }
  return { ok: true, value: s };
}

const FS_RE = new RegExp(`^FS:[A-Z0-9]{1,${LIMITS.glossFingerspellMaxLen}}$`);

/**
 * Gloss tokens from /api/gloss, the client or P1's local mapping (CAP-2, RT8): every token must be a
 * key of signs/index.json, FS: plus 1 to 32 capitals or digits, or a leading BROWS-UP / BROWS-DOWN;
 * 1 to 40 tokens. Returns null when any token fails, so the caller falls back.
 */
export function validateGloss(raw: unknown, known: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.glossMaxTokens) return null;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (typeof t !== "string") return null;
    const marker = t === "BROWS-UP" || t === "BROWS-DOWN";
    if (marker ? i !== 0 : !(known.has(t) || FS_RE.test(t))) return null;
    out.push(t);
  }
  if (out.length === 1 && (out[0] === "BROWS-UP" || out[0] === "BROWS-DOWN")) return null;
  return out;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export const NONCE_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[A-Za-z0-9_:-]{1,80}$/;

function exactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  for (const k of required) if (!has(o, k)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isIntentId = (v: unknown): v is GuestIntentId => isInt(v, 1, 20);
const CHOICES = ["sign", "type", "interpreter", "text_only"] as const;
const FIXES = ["sign_again", "type", "interpreter", "not_this"] as const;
const REPLIES = ["please_repeat", "dont_understand", "please_type", "wait_please", "slower", "show_on_paper"] as const;
const PRESSURE = ["nominal", "fair", "serious", "critical"] as const;
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/**
 * POST /api/guest/action. The route dispatches `emergency` BEFORE calling this (C1-15), so a body
 * with a missing or reused nonce still reaches staff. Names and text are only type-checked here;
 * the store sanitizes them and reports the reason with `field`.
 */
export function validateGuestAction(raw: unknown): Valid<GuestAction> | Invalid {
  if (!isObj(raw)) return bad("body must be a JSON object");
  if (typeof raw.n !== "string" || !NONCE_RE.test(raw.n)) return bad("n must be 32 hex characters");
  const t = raw.type;
  const ok = (value: GuestAction): Valid<GuestAction> => ({ ok: true, value });
  switch (t) {
    case "guest_choice":
      return exactKeys(raw, ["n", "type", "choice"]) && inList(CHOICES, raw.choice) ? ok({ n: raw.n, type: t, choice: raw.choice }) : bad("bad guest_choice");
    case "stop_signing":
    case "interpreter_request":
    case "emergency":
    case "heartbeat":
      return exactKeys(raw, ["n", "type"]) ? ok({ n: raw.n, type: t }) : bad(`bad ${t}`);
    case "guest_confirm":
      if (!exactKeys(raw, ["n", "type", "proposalId", "candidateId"], ["name", "voice"]) || !isId(raw.proposalId) || !isId(raw.candidateId)) return bad("bad guest_confirm");
      if (has(raw, "name") && typeof raw.name !== "string") return bad(NAME_RULE_MESSAGE, "name");
      if (has(raw, "voice") && typeof raw.voice !== "boolean") return bad("bad guest_confirm");
      return ok({
        n: raw.n,
        type: t,
        proposalId: raw.proposalId,
        candidateId: raw.candidateId,
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.voice === "boolean" ? { voice: raw.voice } : {}),
      });
    case "guest_fix":
      return exactKeys(raw, ["n", "type", "proposalId", "action"]) && isId(raw.proposalId) && inList(FIXES, raw.action)
        ? ok({ n: raw.n, type: t, proposalId: raw.proposalId, action: raw.action })
        : bad("bad guest_fix");
    case "guest_phrase":
      if (!exactKeys(raw, ["n", "type", "intentId"], ["name", "voice"]) || !isIntentId(raw.intentId)) return bad("bad guest_phrase");
      if (has(raw, "name") && typeof raw.name !== "string") return bad(NAME_RULE_MESSAGE, "name");
      if (has(raw, "voice") && typeof raw.voice !== "boolean") return bad("bad guest_phrase");
      return ok({ n: raw.n, type: t, intentId: raw.intentId, ...(typeof raw.name === "string" ? { name: raw.name } : {}), ...(typeof raw.voice === "boolean" ? { voice: raw.voice } : {}) });
    case "guest_typed":
      if (!exactKeys(raw, ["n", "type", "text"])) return bad("bad guest_typed");
      if (typeof raw.text !== "string") return bad("Please type a message first", "text");
      return ok({ n: raw.n, type: t, text: raw.text });
    case "guest_reply":
      return exactKeys(raw, ["n", "type", "reply", "captionId"]) && inList(REPLIES, raw.reply) && (raw.captionId === null || isId(raw.captionId))
        ? ok({ n: raw.n, type: t, reply: raw.reply, captionId: raw.captionId as string | null })
        : bad("bad guest_reply");
    case "prefs": {
      if (!exactKeys(raw, ["n", "type"], ["speakAloud", "showAvatar"])) return bad("bad prefs");
      if (has(raw, "speakAloud") && typeof raw.speakAloud !== "boolean") return bad("bad prefs");
      if (has(raw, "showAvatar") && typeof raw.showAvatar !== "boolean") return bad("bad prefs");
      if (!has(raw, "speakAloud") && !has(raw, "showAvatar")) return bad("bad prefs");
      return ok({ n: raw.n, type: t, ...(has(raw, "speakAloud") ? { speakAloud: raw.speakAloud as boolean } : {}), ...(has(raw, "showAvatar") ? { showAvatar: raw.showAvatar as boolean } : {}) });
    }
    case "ack":
      return exactKeys(raw, ["n", "type", "seq"]) && isInt(raw.seq, 1, Number.MAX_SAFE_INTEGER) ? ok({ n: raw.n, type: t, seq: raw.seq }) : bad("bad ack");
    case "more_time":
      return exactKeys(raw, ["n", "type", "on"]) && (raw.on === "idle" || raw.on === "cap") ? ok({ n: raw.n, type: t, on: raw.on }) : bad("bad more_time");
    case "device_health":
      return exactKeys(raw, ["n", "type", "state"]) && inList(PRESSURE, raw.state) ? ok({ n: raw.n, type: t, state: raw.state }) : bad("bad device_health");
    default:
      return bad("unknown action type");
  }
}

const CHECKIN_KEYS = CHECKIN_ITEMS.map((i) => i.key);

/** POST /api/staff/action (staff cookie). Exact shapes, unknown keys refused. */
export function validateStaffAction(raw: unknown): Valid<StaffAction> | Invalid {
  if (!isObj(raw)) return bad("body must be a JSON object");
  const t = raw.type;
  const ok = (value: StaffAction): Valid<StaffAction> => ({ ok: true, value });
  switch (t) {
    case "new_guest":
    case "guest_is_here":
    case "refresh_code":
    case "open_guest_window":
    case "repair":
    case "end_guest":
    case "extend":
    case "touch":
      return exactKeys(raw, ["type"]) ? ok({ type: t }) : bad(`bad ${t}`);
    case "confirm_pair":
      return exactKeys(raw, ["type", "check"]) && typeof raw.check === "string" && /^\d{6}$/.test(raw.check) ? ok({ type: t, check: raw.check }) : bad("check must be 6 digits");
    case "say_quick":
      return exactKeys(raw, ["type", "intent"]) && inList(STAFF_INTENT_KEYS, raw.intent) ? ok({ type: t, intent: raw.intent }) : bad("unknown quick reply");
    case "say_text":
      if (!exactKeys(raw, ["type", "text", "gloss", "source"]) || (raw.source !== "voice" && raw.source !== "typed")) return bad("bad say_text");
      if (typeof raw.text !== "string") return bad("text must be a string", "text");
      if (raw.gloss !== null && !(Array.isArray(raw.gloss) && raw.gloss.length <= LIMITS.glossMaxTokens && raw.gloss.every((g) => typeof g === "string" && g.length <= 40))) {
        return bad("gloss must be null or at most 40 short tokens");
      }
      return ok({ type: t, text: raw.text, gloss: raw.gloss as string[] | null, source: raw.source });
    case "ack":
      return exactKeys(raw, ["type", "about"]) && inList(["emergency", "interpreter", "typed", "more_time"] as const, raw.about) ? ok({ type: t, about: raw.about }) : bad("bad ack");
    case "speak_name":
      return exactKeys(raw, ["type", "proposalId"]) && isId(raw.proposalId) ? ok({ type: t, proposalId: raw.proposalId }) : bad("bad speak_name");
    case "read_aloud":
      return exactKeys(raw, ["type", "logSeq"]) && isInt(raw.logSeq, 1, Number.MAX_SAFE_INTEGER) ? ok({ type: t, logSeq: raw.logSeq }) : bad("bad read_aloud");
    case "speak_done":
      return exactKeys(raw, ["type", "ref", "how", "startedAt"]) && isId(raw.ref) && inList(["tts", "local", "none"] as const, raw.how) && isNum(raw.startedAt)
        ? ok({ type: t, ref: raw.ref, how: raw.how, startedAt: raw.startedAt })
        : bad("bad speak_done");
    case "confirm_for_guest":
      return exactKeys(raw, ["type", "proposalId", "candidateId"]) && isId(raw.proposalId) && isId(raw.candidateId)
        ? ok({ type: t, proposalId: raw.proposalId, candidateId: raw.candidateId })
        : bad("bad confirm_for_guest");
    case "reject_for_guest":
      return exactKeys(raw, ["type", "proposalId"]) && isId(raw.proposalId) ? ok({ type: t, proposalId: raw.proposalId }) : bad("bad reject_for_guest");
    case "choice_for_guest":
      return exactKeys(raw, ["type", "choice"]) && inList(CHOICES, raw.choice) ? ok({ type: t, choice: raw.choice }) : bad("bad choice_for_guest");
    case "checklist_seen":
      return exactKeys(raw, ["type", "item"]) && inList(CHECKIN_KEYS, raw.item) ? ok({ type: t, item: raw.item }) : bad("bad checklist_seen");
    case "dismiss_warning":
      return exactKeys(raw, ["type", "id"]) && isId(raw.id) ? ok({ type: t, id: raw.id }) : bad("bad dismiss_warning");
    case "device_health":
      return exactKeys(raw, ["type", "state"]) && inList(PRESSURE, raw.state) ? ok({ type: t, state: raw.state }) : bad("bad device_health");
    case "note_vendor":
      return exactKeys(raw, ["type", "destination"]) && raw.destination === "browser speech service" ? ok({ type: t, destination: raw.destination }) : bad("bad note_vendor");
    default:
      return bad("unknown action type");
  }
}

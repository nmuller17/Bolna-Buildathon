// SignBridge app (P4, builder S): text hygiene before anything leaves the laptop or reaches a log
// (docs/features-plan.md section 3, "Text hygiene"; the design of mcp-terra's audio_summary.py).
//
// The rule from audio_summary.py: check text after Unicode NFKC normalisation AND after folding
// cross-script look-alikes (NFKC folds full-width digits and ligatures, but not a Cyrillic "о" that
// looks like a Latin "o"), so a secret cannot slip through in a disguised form.
//
// Two entry points:
// - hygieneForGuest(text): what a live caption needs before it reaches the guest screen. NFKC,
//   control and zero-width characters removed, and card-number-like digit runs (Luhn-valid, 13 to
//   19 digits, with or without spaces or dashes) replaced by "[number hidden]". A room number or a
//   time is left alone: the guest must read those.
// - hygieneForEgress(text): everything above plus long digit runs, emails, "password is ..."
//   phrases and API-key shapes. Applied before any vendor call and any log line.
//
// Both return the cleaned text and a count per redaction kind (the privacy panel shows the kinds and
// counts, never the values). Pure functions: no I/O, no globals, erasable TypeScript only.
import { REDACTED_TEXT, type RedactionKind } from "./types.ts";

export type HygieneResult = { text: string; redactions: Partial<Record<RedactionKind, number>> };

/**
 * Cross-script look-alikes folded to Latin for DETECTION only (index-aligned: every entry maps one
 * UTF-16 unit to one unit, so a match in the folded text has the same offsets in the original).
 * A small set on purpose: the letters and digits that make up English words, codes and key shapes.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic lower and upper
  "а": "a", "в": "b", "с": "c", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o",
  "р": "p", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ӏ": "l",
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J", "К": "K", "М": "M", "О": "O",
  "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "У": "Y", "Ԛ": "Q", "Ԝ": "W",
  // Greek lower and upper
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O",
  "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  // Look-alike digits and letters NFKC keeps
  "ⅼ": "l", "Ⅼ": "L", "ǀ": "l", "ı": "i",
};

/** NFKC, control/format/zero-width characters and line separators removed, whitespace collapsed. */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    // Zero-width and other format characters (U+200B..U+200F, U+2060.., U+FEFF, soft hyphen) vanish;
    // control characters and line/paragraph separators become a space.
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index-aligned look-alike folding (for matching only; never shown). */
export function foldConfusables(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    out += CONFUSABLES[c] ?? c;
  }
  return out;
}

/** Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

type Span = { start: number; end: number; kind: RedactionKind; keepPrefix?: number };

/** Runs of digits joined by single spaces or dashes (how a speech recogniser writes "4111 1111 ..."). */
const DIGIT_RUN = /\d(?:[ \-]?\d)+/g;

function digitSpans(folded: string, egress: boolean): Span[] {
  const out: Span[] = [];
  for (const m of folded.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) out.push({ start, end, kind: "card_number" });
    else if (egress && digits.length >= 9) out.push({ start, end, kind: "long_digits" });
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * "password is X", "passcode: X", "PIN 1234", "security code is X", "Wi-Fi key X": the value is
 * hidden, the words before it stay. A following ordinary word ("is on your key card") is not a value.
 */
const SECRET_PHRASE =
  /\b(?:pass\s?words?|pass\s?codes?|pass\s?phrases?|pins?|pin\s?codes?|security\s?codes?|access\s?codes?|door\s?codes?|cvv|cvc|wi-?fi\s?(?:key|code)s?|network\s?keys?)\b(?:\s+(?:is|was|will be))?\s*[:=]?\s*/gi;
const NOT_A_VALUE = new Set([
  "on", "in", "at", "the", "your", "my", "a", "an", "of", "for", "to", "printed", "written", "below", "above", "here", "there",
  "and", "or", "please", "card", "key", "same", "it", "this", "that", "not", "no", "yes", "is",
]);

function secretSpans(folded: string): Span[] {
  const out: Span[] = [];
  for (const m of folded.matchAll(SECRET_PHRASE)) {
    const start = m.index ?? 0;
    const after = start + m[0].length;
    const rest = folded.slice(after);
    // A password may hold "!" or "?": take the whole token and leave only a trailing . , ; outside.
    const v = /^\S+?(?=[.,;]*(?:\s|$))/.exec(rest);
    if (!v) continue;
    const word = v[0].replace(/["'’]/g, "").toLowerCase();
    if (NOT_A_VALUE.has(word)) continue;
    out.push({ start, end: after + v[0].length, kind: "secret_phrase", keepPrefix: m[0].length });
  }
  return out;
}

/** API-key and token shapes (OpenAI, Google, AWS, GitHub, Slack, long hex/base64 blobs with digits and letters). */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/]{32,}={0,2}/g,
];

function tokenSpans(folded: string): Span[] {
  const out: Span[] = [];
  for (const re of TOKEN_SHAPES) for (const m of folded.matchAll(re)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "token_shape" });
  return out;
}

function emailSpans(folded: string): Span[] {
  return [...folded.matchAll(EMAIL)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "email" as const }));
}

/** Applies non-overlapping spans (earliest first, longest wins on a tie) to the normalised text. */
function apply(text: string, spans: Span[]): HygieneResult {
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const sp of sorted) {
    const last = kept[kept.length - 1];
    if (last && sp.start < last.end) continue;
    kept.push(sp);
  }
  const redactions: Partial<Record<RedactionKind, number>> = {};
  let out = "";
  let pos = 0;
  for (const sp of kept) {
    out += text.slice(pos, sp.start);
    if (sp.keepPrefix) out += text.slice(sp.start, sp.start + sp.keepPrefix);
    out += REDACTED_TEXT[sp.kind];
    pos = sp.end;
    redactions[sp.kind] = (redactions[sp.kind] ?? 0) + 1;
  }
  out += text.slice(pos);
  return { text: out, redactions };
}

/** Live captions to the guest: NFKC, controls and zero-width removed, card numbers hidden. */
export function hygieneForGuest(raw: string): HygieneResult {
  const text = normalizeText(raw);
  const folded = foldConfusables(text);
  return apply(text, digitSpans(folded, false));
}

/** Before any vendor call or log line: every redaction kind. */
export function hygieneForEgress(raw: string): HygieneResult {
  const text = normalizeText(raw);
  const folded = foldConfusables(text);
  return apply(text, [...tokenSpans(folded), ...emailSpans(folded), ...secretSpans(folded), ...digitSpans(folded, true)]);
}

/** Adds one result's redaction counts into a running total (privacy panel). */
export function addRedactions(total: Partial<Record<RedactionKind, number>>, r: Partial<Record<RedactionKind, number>>): void {
  for (const [k, v] of Object.entries(r) as [RedactionKind, number][]) total[k] = (total[k] ?? 0) + v;
}

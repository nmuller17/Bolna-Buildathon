// SignBridge app (P4, builder A): traffic lights, the harm-weighted gate and intent matching
// (docs/app-plan.md section 6.3, SPK-2, SPK-3, SPK-4, SPK-9, BRG-8).
//
// Pure functions only: no clock, no store, no I/O. The app computes the outcome itself from the
// joined signs; the recognizer's needs_repeat is a hint for the staff log and never decides (C1-4).
import { GUEST_INTENTS } from "./vocab.ts";
import {
  CONF_THRESHOLD,
  HARM_THRESHOLDS,
  HELP_INTENT_ID,
  LIGHT_GREEN_MIN,
  LIMITS,
  type CandidateSource,
  type GuestIntent,
  type GuestIntentId,
  type Prediction,
  type RedReason,
  type RepeatReason,
  type SignLabel,
  type TrafficLight,
} from "./types.ts";

/** One sign of an utterance after joining it with its `sign` event (or the utterance's top-1 when that is missing). */
export type JoinedSign = {
  seq: number | null;
  /** Best first; at least one entry. Only the top-1 when the sign event was missing (joined = false). */
  top: Prediction[];
  joined: boolean;
  /** The recognizer rejected this sign because the guest was not framed (framing event with rejected_seq). */
  framingRejected: boolean;
};

/** The bar a label's top-1 score must reach: 0.6, or the provisional harm-weighted value. */
export function barFor(label: SignLabel): number {
  return HARM_THRESHOLDS[label] ?? CONF_THRESHOLD;
}

export function lightFor(sign: Pick<JoinedSign, "top" | "framingRejected">): { light: TrafficLight; red: RedReason | null } {
  const best = sign.top[0];
  if (sign.framingRejected) return { light: "red", red: "framing" };
  if (best.label === "NONE") return { light: "red", red: "none_sign" };
  const bar = barFor(best.label);
  if (!(best.conf >= bar)) return { light: "red", red: "below_bar" };
  return { light: best.conf >= LIGHT_GREEN_MIN ? "green" : "amber", red: null };
}

/** Labels for matching: consecutive duplicates collapsed (a sign the segmenter split in two). */
export function collapseRepeats(labels: readonly SignLabel[]): SignLabel[] {
  const out: SignLabel[] = [];
  for (const l of labels) if (out[out.length - 1] !== l) out.push(l);
  return out;
}

function multisetKey(labels: readonly string[]): string {
  return [...labels].sort().join(" ");
}

const INTENT_BY_MULTISET = new Map<string, GuestIntent>(GUEST_INTENTS.map((g) => [multisetKey(g.signs), g]));

/** Order-insensitive match against the 20 guest intents (SPK-4). */
export function matchIntent(labels: readonly SignLabel[]): GuestIntent | null {
  const collapsed = collapseRepeats(labels);
  if (collapsed.length === 0) return null;
  return INTENT_BY_MULTISET.get(multisetKey(collapsed)) ?? null;
}

/** Up to `max` intents that share the most signs with `labels` (at least one), for "Not a request we know". */
export function nearestIntents(labels: readonly SignLabel[], max = 3): GuestIntent[] {
  const have: SignLabel[] = collapseRepeats(labels).filter((l) => l !== "NONE");
  const scored = GUEST_INTENTS.map((g) => {
    const pool = [...have];
    let shared = 0;
    for (const s of g.signs) {
      const i = pool.indexOf(s);
      if (i !== -1) {
        shared++;
        pool.splice(i, 1);
      }
    }
    return { g, shared, extra: g.signs.length - shared };
  }).filter((x) => x.shared > 0);
  scored.sort((a, b) => b.shared - a.shared || a.extra - b.extra || a.g.id - b.g.id);
  return scored.slice(0, max).map((x) => x.g);
}

export type GateCandidate = { intentId: GuestIntentId; source: CandidateSource; score: number };

export type GateOutcome =
  | { kind: "repeat"; reason: RepeatReason; weak: number[] }
  | { kind: "proposal" | "did_you_mean" | "did_you_mean_help" | "pick"; candidates: GateCandidate[]; weak: number[] }
  /** Every sign passed but nothing matched: hold for LIMITS.unmatchedMergeMs, then "unmatched" (C1-17). */
  | { kind: "hold"; weak: number[] };

/**
 * The app's own gate, in the order of plan 6.3:
 * 1. any NONE or framing-rejected sign -> repeat;
 * 2. two or more signs below their bars -> repeat;
 * 3. all signs at or above their bars -> multiset match (proposal), a lone confident HELP asks, else hold;
 * 4. one weak sign that is HELP -> "Did you mean HELP?";
 * 5. one weak sign -> try each label of its top 3 (top-1 only when unjoined), ranked by the product of
 *    scores: one candidate -> "Did you mean", two or three -> "Pick one", none -> repeat.
 */
export function decide(signs: readonly JoinedSign[]): GateOutcome {
  if (signs.length === 0) return { kind: "repeat", reason: "no_candidate", weak: [] };
  const lights = signs.map(lightFor);
  const framing = lights.some((l) => l.red === "framing");
  const none = lights.some((l) => l.red === "none_sign");
  const redIdx = lights.flatMap((l, i) => (l.red ? [i] : []));
  if (framing || none) return { kind: "repeat", reason: framing ? "framing" : "none_sign", weak: redIdx };

  const weak = lights.flatMap((l, i) => (l.red === "below_bar" ? [i] : []));
  if (weak.length >= 2) return { kind: "repeat", reason: "low_confidence", weak };

  const labels = signs.map((s) => s.top[0].label);
  const product = (confs: number[]) => confs.reduce((p, c) => p * c, 1);

  if (weak.length === 0) {
    const hit = matchIntent(labels);
    if (hit) {
      return { kind: "proposal", candidates: [{ intentId: hit.id, source: "table", score: product(signs.map((s) => s.top[0].conf)) }], weak };
    }
    if (collapseRepeats(labels).length === 1 && labels[0] === "HELP") {
      return { kind: "did_you_mean_help", candidates: [{ intentId: HELP_INTENT_ID, source: "table", score: signs[0].top[0].conf }], weak };
    }
    return { kind: "hold", weak };
  }

  const w = weak[0];
  if (labels[w] === "HELP") {
    return { kind: "did_you_mean_help", candidates: [{ intentId: HELP_INTENT_ID, source: "runner_up", score: signs[w].top[0].conf }], weak };
  }

  const others = signs.filter((_, i) => i !== w).map((s) => s.top[0].conf);
  const tried = new Set<string>();
  const found = new Map<GuestIntentId, GateCandidate>();
  const options = signs[w].joined ? signs[w].top : signs[w].top.slice(0, 1);
  options.forEach((alt, rank) => {
    if (alt.label === "NONE" || tried.has(alt.label)) return;
    tried.add(alt.label);
    const replaced = labels.map((l, i) => (i === w ? alt.label : l));
    const hit = matchIntent(replaced);
    if (!hit) return;
    const score = product([...others, alt.conf]);
    const prev = found.get(hit.id);
    if (!prev || score > prev.score) found.set(hit.id, { intentId: hit.id, source: rank === 0 ? "table" : "runner_up", score });
  });
  const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.intentId - b.intentId).slice(0, 3);
  if (ranked.length === 0) return { kind: "repeat", reason: "no_candidate", weak };
  return { kind: ranked.length === 1 ? "did_you_mean" : "pick", candidates: ranked, weak };
}

/**
 * Merges a held (unmatched) utterance with the next one (plan 6.3 rule 6). Returns null when the
 * merged utterance would exceed LIMITS.maxSigns; the caller then evaluates the new one alone.
 */
export function mergeHeld(held: readonly JoinedSign[], next: readonly JoinedSign[]): JoinedSign[] | null {
  const merged = [...held, ...next];
  return merged.length <= LIMITS.maxSigns ? merged : null;
}

/**
 * Shared contract (live_key.py, adopted 2026-10-11): the recognizer may send its own sentence
 * correction, the labels snapped to the closest guest sentence of the same length. The app's gate on
 * the RAW signs still runs first and keeps the last word on safety:
 * - a framing-rejected or NONE sign still asks for a repeat, and a lone HELP still asks "Did you mean HELP?";
 * - a proposal the raw signs already earned is kept;
 * - otherwise (held, low confidence, no candidate, "Did you mean" or "Pick one"), the corrected
 *   sentence is offered first as "Did you mean...?" (source "sentence"), ahead of up to two of the
 *   gate's own candidates. The guest still confirms before anything is spoken (CLAUDE.md 7.2).
 * Its score is the product of the raw evidence for each corrected label (that label's score in the
 * sign's top list, 0 when it is not there), so a weak correction ranks honestly on the staff screen.
 */
export function applySentenceCorrection(outcome: GateOutcome, signs: readonly JoinedSign[], corrected: readonly SignLabel[] | null): GateOutcome {
  if (!corrected || corrected.length === 0) return outcome;
  if (outcome.kind === "repeat" && (outcome.reason === "framing" || outcome.reason === "none_sign")) return outcome;
  if (outcome.kind === "proposal" || outcome.kind === "did_you_mean_help") return outcome;
  const hit = matchIntent(corrected);
  if (!hit) return outcome;
  const score = corrected.reduce((p, label, i) => p * (signs[i]?.top.find((t) => t.label === label)?.conf ?? 0), 1);
  const own = outcome.kind === "did_you_mean" || outcome.kind === "pick" ? outcome.candidates.filter((c) => c.intentId !== hit.id) : [];
  const first: GateCandidate = { intentId: hit.id, source: "sentence", score };
  const candidates = [first, ...own].slice(0, 3);
  return { kind: candidates.length === 1 ? "did_you_mean" : "pick", candidates, weak: outcome.weak };
}

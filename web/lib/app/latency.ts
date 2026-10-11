// SignBridge app (P4, builder A): latency panel from real timestamps only (docs/app-plan.md 6.5, DSH-4, AS-22).
//
// Each stage keeps its last value, median and count for the current guest. A stage with no data
// shows "no data yet" on the staff screen (lastMs null). Values that include a guest-device
// acknowledgement are labelled "reported by the guest device" and dropped outside 0..10 s; laptop
// values are dropped when negative or above 60 s (a clock jump, not a measurement).
import { LIMITS, type LatencyStage, type LatencyStageKey } from "./types.ts";

export const LATENCY_STAGES: readonly { key: LatencyStageKey; label: string; measuredBy: "laptop" | "guest_device" }[] = [
  { key: "movement_to_prediction", label: "Movement end to prediction", measuredBy: "laptop" },
  { key: "prediction_to_app", label: "Prediction to the app", measuredBy: "laptop" },
  { key: "app_to_guest_screen", label: "App to guest screen (round trip, reported by the guest device)", measuredBy: "guest_device" },
  { key: "utterance_to_proposal_shown", label: "Utterance end to proposal on the guest screen (reported by the guest device)", measuredBy: "guest_device" },
  { key: "say_it_to_speech", label: "Send to speech starting at the desk", measuredBy: "laptop" },
];

const KEEP = 200;
const LAPTOP_MAX_MS = 60_000;

export type LatencyData = Record<LatencyStageKey, number[]>;

export function emptyLatency(): LatencyData {
  return Object.fromEntries(LATENCY_STAGES.map((s) => [s.key, [] as number[]])) as unknown as LatencyData;
}

/** Records one value; returns false when it was dropped by the stage's filter. */
export function recordLatency(data: LatencyData, key: LatencyStageKey, ms: number): boolean {
  const stage = LATENCY_STAGES.find((s) => s.key === key);
  if (!stage || !Number.isFinite(ms) || ms < 0) return false;
  if (ms > (stage.measuredBy === "guest_device" ? LIMITS.guestLatencyMaxMs : LAPTOP_MAX_MS)) return false;
  const list = data[key];
  list.push(Math.round(ms));
  if (list.length > KEEP) list.shift();
  return true;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function latencyStages(data: LatencyData): LatencyStage[] {
  return LATENCY_STAGES.map((s) => {
    const v = data[s.key];
    return { key: s.key, label: s.label, lastMs: v.length ? v[v.length - 1] : null, medianMs: median(v), count: v.length, measuredBy: s.measuredBy };
  });
}

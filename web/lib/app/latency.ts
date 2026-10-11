// P4: latency panel on the staff screen, from real timestamps only (BN-2; ported from the app-shell plan, DSH-4).
//
// A "sign" event from the recognizer can carry t_sign_end (last moving frame) and t_predicted (prediction
// ready), both Unix seconds from the recognizer's clock (recognition/stream.py, live.py). The app adds `at`
// (Unix seconds when /api/guest/signs received it) and the staff page adds the time the sign was painted.
// All three clocks are this laptop's clock, so the differences are real delays. live_key.py sends no
// timestamps today: then only "app to staff screen" has data and the other rows say "no data yet".
//
// Each stage keeps its last value, median and count. A value is dropped when it is not a finite number,
// negative, or above 60 s (a clock jump or a replayed event, not a measurement).
//
// Erasable TypeScript only, no imports: the tests run this file directly with Node.

export type LatencyStageKey = "sign_end_to_prediction" | "prediction_to_app" | "app_to_staff_screen" | "sign_end_to_staff_screen";

export type LatencyStage = { key: LatencyStageKey; label: string; lastMs: number | null; medianMs: number | null; count: number };

export const LATENCY_STAGES: readonly { key: LatencyStageKey; label: string }[] = [
  { key: "sign_end_to_prediction", label: "Sign end to prediction (recognizer)" },
  { key: "prediction_to_app", label: "Prediction to the app server" },
  { key: "app_to_staff_screen", label: "App server to staff screen" },
  { key: "sign_end_to_staff_screen", label: "End to end: sign end to staff screen" },
];

const KEEP = 200;
export const LATENCY_MAX_MS = 60_000;

export type LatencyData = Record<LatencyStageKey, number[]>;

/** The timestamps of one sign, Unix seconds. Missing recognizer fields stay undefined. */
export type SignTimes = { t_sign_end?: number; t_predicted?: number; at: number; shownAt: number };

export function emptyLatency(): LatencyData {
  return { sign_end_to_prediction: [], prediction_to_app: [], app_to_staff_screen: [], sign_end_to_staff_screen: [] };
}

/** Records one value in milliseconds; returns false when it was dropped. */
export function recordLatency(data: LatencyData, key: LatencyStageKey, ms: number): boolean {
  if (!(key in data) || !Number.isFinite(ms) || ms < 0 || ms > LATENCY_MAX_MS) return false;
  const list = data[key];
  list.push(Math.round(ms));
  if (list.length > KEEP) list.shift();
  return true;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Records every stage the sign's timestamps allow. Returns the keys that were recorded. */
export function recordSign(data: LatencyData, t: SignTimes): LatencyStageKey[] {
  const done: LatencyStageKey[] = [];
  const add = (key: LatencyStageKey, from: unknown, to: unknown) => {
    if (num(from) && num(to) && recordLatency(data, key, (to - from) * 1000)) done.push(key);
  };
  add("sign_end_to_prediction", t.t_sign_end, t.t_predicted);
  add("prediction_to_app", t.t_predicted, t.at);
  add("app_to_staff_screen", t.at, t.shownAt);
  add("sign_end_to_staff_screen", t.t_sign_end, t.shownAt);
  return done;
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
    return { key: s.key, label: s.label, lastMs: v.length ? v[v.length - 1] : null, medianMs: median(v), count: v.length };
  });
}

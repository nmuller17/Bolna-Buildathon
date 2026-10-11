// SignBridge app (P4, builder A): the benchmark card shows only audited figures (DSH-6).
//
// Today no figure is cleared, so the answer is "not_yet_audited". A report file (BENCHMARK_CLEARED_FILE)
// may replace that only when it says `cleared: true` with a non-empty `auditRef` and `clearedAt`; then
// only the figures it lists are passed through, as strings, and nothing is computed or invented.
import type { BenchmarkResponse } from "./types.ts";

const NOT_YET: BenchmarkResponse = { ok: true, status: "not_yet_audited" };

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function benchmarkFromReport(raw: unknown): BenchmarkResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NOT_YET;
  const r = raw as Record<string, unknown>;
  if (r.cleared !== true || !str(r.auditRef, 200) || !str(r.clearedAt, 64)) return NOT_YET;
  if (!Array.isArray(r.figures) || r.figures.length === 0 || r.figures.length > 20) return NOT_YET;
  const figures: { label: string; value: string; n?: number; scope?: string }[] = [];
  for (const f of r.figures) {
    if (typeof f !== "object" || f === null) return NOT_YET;
    const x = f as Record<string, unknown>;
    if (!str(x.label, 120) || !str(x.value, 60)) return NOT_YET;
    if (x.n !== undefined && !(Number.isInteger(x.n) && (x.n as number) > 0)) return NOT_YET;
    if (x.scope !== undefined && !str(x.scope, 200)) return NOT_YET;
    figures.push({ label: x.label, value: x.value, ...(x.n !== undefined ? { n: x.n as number } : {}), ...(x.scope !== undefined ? { scope: x.scope as string } : {}) });
  }
  return { ok: true, status: "cleared", auditRef: r.auditRef, clearedAt: r.clearedAt, figures };
}

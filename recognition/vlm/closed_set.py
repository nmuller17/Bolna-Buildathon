"""Experiment 3: closed-set baseline for Track B. A local VLM picks ONE of our 22 labels from a
few frames of each clip, using the shared closed-set prompt (prompts.build_closed_set).

Two clip sets:
  talha      - Talha's own takes, every class that has at least --min-clips takes (one signer
               only: this is NOT a held-out-signer benchmark).
  reference  - the 21 reference videos in capture/reference/<LABEL>.mp4 (one clip per class).

Two label orders:
  fixed      - the label list in its normal order (prompts.LABELS).
  shuffled   - a different, reproducible random order per clip (seed from the clip id). Comparing
               the two shows whether the model leans on a label's position in the list.

Predictions are written as JSON lines, one per clip, in the schema the Track B harness can
import later:
  {system, clip_id, signer, true_label, top:[{label, conf}], latency_s}
plus a few extra keys (top3/answered/oov, matching recognition/compare/common.record, and the
raw reply, parse format, model latency and label order) that an importer can ignore.

Label space: p2-avatar vocabulary, where checkout is LEAVE (recognition/labels.py on this
branch says FS-CHECKOUT; map LEAVE -> FS-CHECKOUT when importing). Talha's complete classes do
not include LEAVE, so only the reference set is affected.

Run (VLM venv, from /Users/trehman/CamelHack):
  /Users/trehman/.venvs/signbridge-vlm/bin/python -m recognition.vlm.closed_set run \
      --set talha --order fixed shuffled --out-dir /Users/trehman/CamelHack-handoff/vlm_closed_set
  ... -m recognition.vlm.closed_set summarize --out-dir /Users/trehman/CamelHack-handoff/vlm_closed_set
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time
import zlib
from collections import Counter, defaultdict
from pathlib import Path

from . import prompts as P

TALHA_DIR = Path("/Users/trehman/CamelHack-p2avatar/data/videos/train")
REF_DIR = Path("/Users/trehman/CamelHack-p2avatar/capture/reference")
OUT_DIR = Path("/Users/trehman/CamelHack-handoff/vlm_closed_set")
SHUFFLE_SEED = 20261010
MODEL_SHORT = {
    "mlx-community/Qwen3-VL-4B-Instruct-4bit": "qwen3vl4b",
    "mlx-community/Qwen3-VL-2B-Instruct-4bit": "qwen3vl2b",
    "mlx-community/Qwen2.5-VL-7B-Instruct-4bit": "qwen25vl7b",
}


# ------------------------------------------------------------------------------------ clips
def _num(stem: str) -> int:
    m = re.search(r"(\d+)$", stem)
    return int(m.group(1)) if m else 0


def talha_clips(root: Path = TALHA_DIR, min_clips: int = 12, signer: str = "talha") -> list[dict]:
    """[{clip_id, signer, true_label, path}] for every class folder with >= min_clips takes."""
    out = []
    for d in sorted(p for p in Path(root).iterdir() if p.is_dir()):
        lab = P.normalize_label(d.name)
        if lab is None:
            continue
        mp4s = sorted(d.glob(f"{signer}_*.mp4"), key=lambda p: _num(p.stem))
        if len(mp4s) < min_clips:
            continue
        out += [{"clip_id": f"{d.name}/{m.stem}", "signer": signer, "true_label": lab, "path": str(m)}
                for m in mp4s]
    return out


def reference_clips(root: Path = REF_DIR) -> list[dict]:
    out = []
    for m in sorted(Path(root).glob("*.mp4")):
        lab = P.normalize_label(m.stem)
        if lab is None:
            continue
        out.append({"clip_id": f"reference/{m.stem}", "signer": "reference", "true_label": lab,
                    "path": str(m)})
    return out


def per_class_subset(clips: list[dict], k: int) -> list[dict]:
    """First k clips of each (signer, true_label), keeping the input order (numeric take order)."""
    seen: Counter = Counter()
    out = []
    for c in clips:
        key = (c["signer"], c["true_label"])
        if seen[key] < k:
            out.append(c)
            seen[key] += 1
    return out


def label_order(clip_id: str, order: str, labels: list[str] | None = None,
                seed: int = SHUFFLE_SEED) -> list[str]:
    labels = list(labels or P.LABELS)
    if order == "fixed":
        return labels
    if order != "shuffled":
        raise ValueError(f"order must be fixed or shuffled, got {order!r}")
    rng = random.Random(seed ^ zlib.crc32(clip_id.encode()))
    rng.shuffle(labels)
    return labels


def system_name(model_id: str, n_frames: int, hints: bool, order: str) -> str:
    short = MODEL_SHORT.get(model_id, re.sub(r"[^a-z0-9]+", "", model_id.split("/")[-1].lower()))
    return f"vlm_{short}_{n_frames}f_{'hints' if hints else 'nohints'}_{order}"


def make_record(system: str, clip: dict, parsed: dict, latency_s: float, **extra) -> dict:
    """Track B record. top = [{label, conf}]: the chosen label with the model's stated confidence,
    then the rest of its top3 with conf None (the model gives one number only)."""
    top = []
    if parsed.get("ok") and parsed.get("label"):
        top.append({"label": parsed["label"], "conf": parsed.get("confidence")})
        for t in parsed.get("top3") or []:
            if t != parsed["label"] and len(top) < 3:
                top.append({"label": t, "conf": None})
    rec = {"system": system, "clip_id": clip["clip_id"], "signer": clip["signer"],
           "true_label": clip["true_label"], "top": top, "latency_s": round(float(latency_s), 3),
           # compatibility with recognition/compare/common.record readers
           "top3": top, "answered": bool(top), "oov": False}
    rec.update(extra)
    return rec


# ------------------------------------------------------------------------------------ stats
def wilson(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    """Wilson score 95% interval for k successes out of n."""
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def percentile(xs: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (numpy's default), q in 0..100."""
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    pos = (len(xs) - 1) * q / 100.0
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def pred(r: dict) -> str | None:
    return r["top"][0]["label"] if r.get("top") else None


def summarize_records(recs: list[dict], n_labels: int = 22) -> dict:
    n = len(recs)
    k = sum(pred(r) == r["true_label"] for r in recs)
    lo, hi = wilson(k, n)
    invalid = sum(not r.get("top") for r in recs)
    classes = sorted({r["true_label"] for r in recs})
    per_class = {}
    for c in classes:
        rc = [r for r in recs if r["true_label"] == c]
        kc = sum(pred(r) == c for r in rc)
        per_class[c] = {"n": len(rc), "correct": kc, "recall": kc / len(rc) if rc else None,
                        "predicted_as": dict(Counter(str(pred(r)) for r in rc).most_common())}
    pred_counts = Counter(str(pred(r)) for r in recs)
    confusions = Counter((r["true_label"], str(pred(r))) for r in recs if pred(r) != r["true_label"])
    lat = [r.get("latency_s") for r in recs]
    mlat = [r.get("model_latency_s") for r in recs if r.get("model_latency_s") is not None]
    conf_ok = [r["top"][0]["conf"] for r in recs if r.get("top") and pred(r) == r["true_label"]
               and r["top"][0]["conf"] is not None]
    conf_bad = [r["top"][0]["conf"] for r in recs if r.get("top") and pred(r) != r["true_label"]
                and r["top"][0]["conf"] is not None]
    most_common_class_n = max(Counter(r["true_label"] for r in recs).values()) if recs else 0
    # position of the chosen label in the list the model was shown (0 = first)
    positions = [r["label_order"].index(pred(r)) for r in recs
                 if pred(r) and r.get("label_order") and pred(r) in r["label_order"]]
    return {
        "n_clips": n, "n_classes_present": len(classes), "correct": k,
        "top1": k / n if n else None, "top1_wilson95": [lo, hi],
        "chance_uniform_22": 1.0 / n_labels,
        "chance_best_constant_guess": most_common_class_n / n if n else None,
        "invalid_outputs": invalid, "invalid_rate": invalid / n if n else None,
        "formats": dict(Counter(r.get("format", "?") for r in recs)),
        "per_class": per_class,
        "predicted_label_counts": dict(pred_counts.most_common()),
        "top_confusions": [{"true": t, "pred": p, "n": c} for (t, p), c in confusions.most_common(10)],
        "latency_s_p50": percentile(lat, 50), "latency_s_p95": percentile(lat, 95),
        "model_latency_s_p50": percentile(mlat, 50), "model_latency_s_p95": percentile(mlat, 95),
        "conf_when_correct_mean": sum(conf_ok) / len(conf_ok) if conf_ok else None,
        "conf_when_wrong_mean": sum(conf_bad) / len(conf_bad) if conf_bad else None,
        "n_conf_correct": len(conf_ok), "n_conf_wrong": len(conf_bad),
        "chosen_position_counts": dict(sorted(Counter(positions).items())),
    }


def order_comparison(fixed: list[dict], shuffled: list[dict]) -> dict:
    """Same clips, two label orders. Agreement and where in the list the answer sat."""
    f = {r["clip_id"]: r for r in fixed}
    s = {r["clip_id"]: r for r in shuffled}
    common = sorted(set(f) & set(s))
    agree = sum(pred(f[c]) == pred(s[c]) for c in common)
    lo, hi = wilson(agree, len(common))
    pos = [s[c]["label_order"].index(pred(s[c])) for c in common
           if pred(s[c]) and pred(s[c]) in s[c].get("label_order", [])]
    n_lab = len(next(iter(s.values()))["label_order"]) if s else 22
    first3 = sum(p < 3 for p in pos)
    last3 = sum(p >= n_lab - 3 for p in pos)
    return {"n_paired_clips": len(common), "same_answer": agree,
            "same_answer_rate": agree / len(common) if common else None,
            "same_answer_wilson95": [lo, hi],
            "shuffled_answers_in_first_3_positions": first3,
            "shuffled_answers_in_last_3_positions": last3,
            "n_shuffled_answers_with_position": len(pos),
            "expected_share_per_3_positions_if_no_position_bias": 3 / n_lab}


# ------------------------------------------------------------------------------------ run
def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def run(args) -> int:
    from . import frames as F
    from .engine import LocalVLM, wait_for_recorder

    out_dir = Path(args.out_dir)
    (out_dir / "preds").mkdir(parents=True, exist_ok=True)
    log = lambda m: print(m, flush=True)  # noqa: E731
    clips = []
    for s in args.set:
        clips += talha_clips(min_clips=args.min_clips) if s == "talha" else reference_clips()
    if args.per_class:
        clips = per_class_subset(clips, args.per_class)
    if args.limit:
        clips = clips[: args.limit]
    log(f"[closed_set] {len(clips)} clips; orders {args.order}; model {args.model}")

    wait_for_recorder(poll_s=60, log=log)
    eng = LocalVLM(args.model, max_tokens=args.max_tokens, timeout_s=args.timeout_s, load=False)
    log(f"[closed_set] loaded in {eng.load():.1f} s")
    w = eng.generate(F.sample_frames(clips[0]["path"], n=2).images, "Describe the hands in five words.",
                     max_tokens=12)
    log(f"[closed_set] warm-up {w.latency_s:.1f} s (excluded)")

    for order in args.order:
        system = system_name(args.model, args.frames, bool(args.hints), order)
        path = out_dir / "preds" / f"{system}.jsonl"
        done = {r["clip_id"] for r in _read_jsonl(path)}
        todo = [c for c in clips if c["clip_id"] not in done]
        log(f"[closed_set] {system}: {len(done)} done, {len(todo)} to run -> {path}")
        for i, clip in enumerate(todo, 1):
            wait_for_recorder(poll_s=60, log=log)
            t0 = time.monotonic()
            s = F.sample_frames(clip["path"], n=args.frames, mode=args.mode, long_side=args.long_side)
            labels = label_order(clip["clip_id"], order)
            prompt = P.build_closed_set(args.frames, labels=labels, hints=bool(args.hints))
            r = eng.generate(s.images, prompt)
            total = time.monotonic() - t0 - r.lock_wait_s
            parsed = P.parse_closed_set(r.text)
            rec = make_record(system, clip, parsed, total,
                              model=args.model, engine=r.engine, order=order, hints=bool(args.hints),
                              n_frames=args.frames, frame_mode=args.mode, long_side=args.long_side,
                              frame_indices=s.indices, model_latency_s=round(r.latency_s, 3),
                              lock_wait_s=round(r.lock_wait_s, 3), prompt_tokens=r.prompt_tokens,
                              generation_tokens=r.generation_tokens,
                              peak_mlx_gb=round(r.peak_memory_gb or 0, 2), timed_out=r.timed_out,
                              format=parsed["format"], label_order=labels,
                              reason=parsed.get("reason"), raw=r.text[:600],
                              label_space="p2-avatar (LEAVE = FS-CHECKOUT)",
                              when=time.strftime("%Y-%m-%d %H:%M:%S"))
            with open(path, "a") as f:
                f.write(json.dumps(rec) + "\n")
            log(f"[{system}] {i}/{len(todo)} {clip['clip_id']} -> {pred(rec)} "
                f"({rec['latency_s']:.1f} s, {parsed['format']})")
    eng.unload()
    return 0


# ------------------------------------------------------------------------------------ report
def _fmt_pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def summarize(args) -> int:
    out_dir = Path(args.out_dir)
    files = sorted((out_dir / "preds").glob("vlm_*.jsonl"))
    summary = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "systems": {}, "order_checks": {}}
    by_sys = {}
    for p in files:
        recs = _read_jsonl(p)
        for subset in ("talha", "reference"):
            rs = [r for r in recs if (r["signer"] == "reference") == (subset == "reference")]
            if rs:
                by_sys[(p.stem, subset)] = rs
                summary["systems"][f"{p.stem}|{subset}"] = summarize_records(rs)
    for (name, subset), rs in by_sys.items():
        if name.endswith("_fixed"):
            twin = (name[: -len("_fixed")] + "_shuffled", subset)
            if twin in by_sys:
                summary["order_checks"][f"{name[:-len('_fixed')]}|{subset}"] = order_comparison(rs, by_sys[twin])
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))

    lines = ["| system | clips | top-1 [Wilson 95% CI] | invalid | latency p50 / p95 (s) |",
             "|---|---|---|---|---|"]
    for key, s in summary["systems"].items():
        lo, hi = s["top1_wilson95"]
        lines.append(f"| {key} | {s['n_clips']} | {s['correct']}/{s['n_clips']} = {_fmt_pct(s['top1'])} "
                     f"[{_fmt_pct(lo)}, {_fmt_pct(hi)}] | {s['invalid_outputs']} | "
                     f"{s['latency_s_p50']:.1f} / {s['latency_s_p95']:.1f} |")
    print("\n".join(lines))
    for key, o in summary["order_checks"].items():
        print(f"{key}: same answer fixed vs shuffled {o['same_answer']}/{o['n_paired_clips']}; "
              f"shuffled answers in first 3 positions {o['shuffled_answers_in_first_3_positions']}/"
              f"{o['n_shuffled_answers_with_position']} (no-bias expectation "
              f"{_fmt_pct(o['expected_share_per_3_positions_if_no_position_bias'])})")
    print(f"wrote {out_dir / 'summary.json'}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--set", nargs="+", default=["talha"], choices=["talha", "reference"])
    r.add_argument("--order", nargs="+", default=["fixed", "shuffled"], choices=["fixed", "shuffled"])
    r.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
    r.add_argument("--frames", type=int, default=8)
    r.add_argument("--mode", default="motion", choices=["motion", "even"])
    r.add_argument("--long-side", type=int, default=448)
    r.add_argument("--hints", type=int, default=1)
    r.add_argument("--max-tokens", type=int, default=200)
    r.add_argument("--timeout-s", type=float, default=120)
    r.add_argument("--min-clips", type=int, default=12)
    r.add_argument("--per-class", type=int, default=0,
                   help="keep only the first N takes of each class (0 = all); used for the shuffled control")
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--out-dir", default=str(OUT_DIR))
    s = sub.add_parser("summarize")
    s.add_argument("--out-dir", default=str(OUT_DIR))
    a = ap.parse_args(argv)
    return run(a) if a.cmd == "run" else summarize(a)


if __name__ == "__main__":
    sys.exit(main())

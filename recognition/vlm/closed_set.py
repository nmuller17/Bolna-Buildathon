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

Label space: p2-avatar vocabulary, where checkout is LEAVE (recognition/labels.py now uses LEAVE
too; older branches said FS-CHECKOUT, which normalize_label maps to LEAVE).

`export` writes the strict six-key Track B rows (nothing else) to <out-dir>/trackb/<system>.jsonl.

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
    pred_none = pred_counts.get("NONE", 0)
    confusions = Counter((r["true_label"], str(pred(r))) for r in recs if pred(r) != r["true_label"])
    lat = [r.get("latency_s") for r in recs]
    mlat = [r.get("model_latency_s") for r in recs if r.get("model_latency_s") is not None]
    conf_ok = [r["top"][0]["conf"] for r in recs if r.get("top") and pred(r) == r["true_label"]
               and r["top"][0]["conf"] is not None]
    conf_bad = [r["top"][0]["conf"] for r in recs if r.get("top") and pred(r) != r["true_label"]
                and r["top"][0]["conf"] is not None]
    true_counts = Counter(r["true_label"] for r in recs)
    most_common_class_n = max(true_counts.values()) if recs else 0
    # chance agreement if answers were drawn independently of the clip, with the model's own
    # answer frequencies: sum_c P(true=c) * P(answer=c)
    chance_matched = (sum(true_counts[c] * pred_counts.get(c, 0) for c in true_counts) / (n * n)
                      if n else None)
    # position of the chosen label in the list the model was shown (0 = first)
    positions = [r["label_order"].index(pred(r)) for r in recs
                 if pred(r) and r.get("label_order") and pred(r) in r["label_order"]]
    recalls = [v["recall"] for v in per_class.values() if v["recall"] is not None]
    top3_hit = sum(any(t["label"] == r["true_label"] for t in r.get("top", [])[:3]) for r in recs)
    no_none = [r for r in recs if r["true_label"] != "NONE"]
    k_nn = sum(pred(r) == r["true_label"] for r in no_none)
    return {
        "n_clips": n, "n_classes_present": len(classes), "correct": k,
        "macro_recall": sum(recalls) / len(recalls) if recalls else None,
        "top3_hit": top3_hit, "top3_rate": top3_hit / n if n else None,
        "top3_wilson95": list(wilson(top3_hit, n)),
        "predicted_NONE": pred_none, "predicted_NONE_rate": pred_none / n if n else None,
        "n_clips_excluding_true_NONE": len(no_none), "correct_excluding_true_NONE": k_nn,
        "top1": k / n if n else None, "top1_wilson95": [lo, hi],
        "chance_uniform_22": 1.0 / n_labels,
        "chance_best_constant_guess": most_common_class_n / n if n else None,
        "chance_matched_to_answer_distribution": chance_matched,
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
    kf = sum(pred(f[c]) == f[c]["true_label"] for c in common)
    ks = sum(pred(s[c]) == s[c]["true_label"] for c in common)
    return {"n_paired_clips": len(common), "same_answer": agree,
            "fixed_correct_on_paired": kf, "shuffled_correct_on_paired": ks,
            "fixed_top1_on_paired_wilson95": list(wilson(kf, len(common))),
            "shuffled_top1_on_paired_wilson95": list(wilson(ks, len(common))),
            "same_answer_rate": agree / len(common) if common else None,
            "same_answer_wilson95": [lo, hi],
            "shuffled_answers_in_first_3_positions": first3,
            "shuffled_answers_in_last_3_positions": last3,
            "n_shuffled_answers_with_position": len(pos),
            "expected_share_per_3_positions_if_no_position_bias": 3 / n_lab}


# ------------------------------------------------------------------------------------ run
def recorder_running_strict(pattern: str = "train_session.py") -> bool:
    """Like engine.recorder_running, but only counts PYTHON processes whose arguments contain
    the pattern. engine's plain `pgrep -f` also matches any shell whose command text merely
    mentions the file name (an agent's pgrep or grep), which paused runs for nothing."""
    import os
    import subprocess
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    for pid in r.stdout.split():
        if not pid.strip().isdigit() or int(pid) == os.getpid():
            continue
        try:
            args = subprocess.run(["ps", "-o", "args=", "-p", pid], capture_output=True, text=True,
                                  timeout=10).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            continue
        first = args.split(" ", 1)[0].rsplit("/", 1)[-1].lower()
        if first.startswith("python") and pattern in args:
            return True
    return False


def wait_for_recorder_strict(poll_s: float = 60.0, log=print) -> float:
    t0 = time.monotonic()
    announced = False
    while recorder_running_strict():
        if not announced:
            log(f"[closed_set] recorder is running; waiting (poll {poll_s:.0f} s)")
            announced = True
        time.sleep(poll_s)
    return time.monotonic() - t0


def machine_load() -> dict:
    """Snapshot of how busy the machine is, stored with each row so latencies can be split into
    quiet vs contended without guessing: 1-min load average and how many OTHER recognition.vlm
    python processes (each holding its own model copy) are alive."""
    import os
    import subprocess
    try:
        load1 = round(os.getloadavg()[0], 1)
    except OSError:
        load1 = None
    n = None
    try:
        out = subprocess.run(["pgrep", "-f", "recognition.vlm"], capture_output=True, text=True,
                             timeout=10).stdout.split()
        n = 0
        for pid in out:
            if pid.isdigit() and int(pid) != os.getpid():
                a = subprocess.run(["ps", "-o", "args=", "-p", pid], capture_output=True, text=True,
                                   timeout=10).stdout.strip()
                if a.split(" ", 1)[0].rsplit("/", 1)[-1].lower().startswith("python"):
                    n += 1
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"load1": load1, "other_vlm_procs": n}


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def run(args) -> int:
    from . import frames as F
    from .engine import LocalVLM

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

    wait_for_recorder_strict(poll_s=60, log=log)
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
            wait_for_recorder_strict(poll_s=60, log=log)
            busy = machine_load()
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
                              load1_before=busy["load1"], other_vlm_procs=busy["other_vlm_procs"],
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


def latency_split(recs: list[dict], idle_after: str, idle_until: str = "9999",
                  quiet_load: float = 8.0) -> dict:
    """Latency p50/p95 for rows recorded before vs at/after `idle_after` ("YYYY-mm-dd HH:MM:SS").
    Rows before it were measured while other heavy jobs shared the machine. Rows that carry a
    load snapshot (load1_before, other_vlm_procs) are classified by it instead."""
    def quiet(r):
        if r.get("load1_before") is not None:   # measured: quiet = load < 8 on 12 cores, no other VLM
            return r["load1_before"] < quiet_load and not r.get("other_vlm_procs")
        return idle_after <= r.get("when", "") < idle_until
    out = {}
    for name, rs in (("contended", [r for r in recs if not quiet(r)]),
                     ("quiet", [r for r in recs if quiet(r)])):
        lat = [r.get("latency_s") for r in rs]
        mlat = [r.get("model_latency_s") for r in rs if r.get("model_latency_s") is not None]
        out[name] = {"n": len(rs), "latency_s_p50": percentile(lat, 50),
                     "latency_s_p95": percentile(lat, 95),
                     "model_latency_s_p50": percentile(mlat, 50),
                     "model_latency_s_p95": percentile(mlat, 95)}
    return out


def _f1(x):
    return "n/a" if x is None else f"{x:.1f}"


def report_md(summary: dict) -> str:
    L = ["# Experiment 3: closed-set VLM baseline (Track B)", "",
         f"Generated {summary['when']} by recognition/vlm/closed_set.py summarize.", "",
         "One signer only (Talha) plus the 21 reference videos: this is NOT a held-out-signer "
         "benchmark. Chance with 22 labels is 4.5% (uniform guess); 'matched chance' is what a guesser with the model's own answer frequencies would score. Latency is per clip (frame sampling + model, "
         "lock wait excluded); 'quiet' = 1-min load average below 8 on 12 cores and no other VLM process alive when the clip started (rows without that snapshot: recorded after the reboot, before other jobs restarted).", ""]
    L += ["| system / clip set | clips | top-1 [Wilson 95% CI] | macro recall | top-3 | answered NONE | "
          "invalid | latency p50 / p95 s (quiet n) | latency p50 / p95 s (contended n) |",
          "|---|---|---|---|---|---|---|---|---|"]
    for key, s in summary["systems"].items():
        lo, hi = s["top1_wilson95"]
        q, c = s["latency_split"]["quiet"], s["latency_split"]["contended"]
        L.append(f"| {key.replace('|', ' / ')} | {s['n_clips']} | {s['correct']}/{s['n_clips']} = "
                 f"{_fmt_pct(s['top1'])} [{_fmt_pct(lo)}, {_fmt_pct(hi)}] | {_fmt_pct(s['macro_recall'])} | "
                 f"{s['top3_hit']}/{s['n_clips']} | {s['predicted_NONE']}/{s['n_clips']} | "
                 f"{s['invalid_outputs']} | {_f1(q['latency_s_p50'])} / {_f1(q['latency_s_p95'])} "
                 f"(n={q['n']}) | {_f1(c['latency_s_p50'])} / {_f1(c['latency_s_p95'])} (n={c['n']}) |")
    for key, s in summary["systems"].items():
        L += ["", f"## {key.replace('|', ' / ')}", "", "| true class | n | correct | most common answers |", "|---|---|---|---|"]
        for c, v in s["per_class"].items():
            ans = ", ".join(f"{a} {m}" for a, m in list(v["predicted_as"].items())[:4])
            L.append(f"| {c} | {v['n']} | {v['correct']} | {ans} |")
        L += ["", f"Matched chance (model's answer frequencies, independent of the clip): "
              f"{_fmt_pct(s['chance_matched_to_answer_distribution'])}."]
        L += ["", "Answer counts over all clips: " + ", ".join(
            f"{a} {m}" for a, m in s["predicted_label_counts"].items()), "",
              "Top confusions (true -> answered): " + "; ".join(
            f"{t['true']} -> {t['pred']} x{t['n']}" for t in s["top_confusions"][:8])]
        if s["n_conf_correct"] or s["n_conf_wrong"]:
            L.append(f"\nStated confidence: mean {_f1(s['conf_when_correct_mean'] and 100*s['conf_when_correct_mean'])}% "
                     f"when right (n={s['n_conf_correct']}), {_f1(s['conf_when_wrong_mean'] and 100*s['conf_when_wrong_mean'])}% "
                     f"when wrong (n={s['n_conf_wrong']}).")
    if summary["order_checks"]:
        L += ["", "## Label-order control (same clips, fixed list vs per-clip shuffled list)", ""]
        for key, o in summary["order_checks"].items():
            L.append(f"- {key.replace('|', ' / ')}: {o['n_paired_clips']} paired clips. Same answer in both orders "
                     f"{o['same_answer']}/{o['n_paired_clips']}. Correct: fixed {o['fixed_correct_on_paired']}, "
                     f"shuffled {o['shuffled_correct_on_paired']}. Shuffled answers that sat in the first 3 "
                     f"list positions: {o['shuffled_answers_in_first_3_positions']}/"
                     f"{o['n_shuffled_answers_with_position']} (no-bias expectation "
                     f"{_fmt_pct(o['expected_share_per_3_positions_if_no_position_bias'])}); in the last 3: "
                     f"{o['shuffled_answers_in_last_3_positions']}.")
    return "\n".join(L) + "\n"


def summarize(args) -> int:
    out_dir = Path(args.out_dir)
    files = sorted((out_dir / "preds").glob("vlm_*.jsonl"))
    summary = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "systems": {}, "order_checks": {}}
    by_sys = {}
    for p in files:
        recs = _read_jsonl(p)
        talha = [r for r in recs if r["signer"] != "reference"]
        subsets = [("talha", talha), ("reference", [r for r in recs if r["signer"] == "reference"])]
        for k in args.balanced or []:
            sub = [r for r in talha if _num(r["clip_id"]) <= k]
            per = Counter(r["true_label"] for r in sub)
            if per and min(per.values()) == k:   # only report when every class has all k takes
                subsets.append((f"talha_takes1-{k}", sub))
        for subset, rs in subsets:
            if rs:
                by_sys[(p.stem, subset)] = rs
                sm = summarize_records(rs)
                sm["latency_split"] = latency_split(rs, args.idle_after, args.idle_until)
                summary["systems"][f"{p.stem}|{subset}"] = sm
    for (name, subset), rs in by_sys.items():
        if name.endswith("_fixed"):
            twin = (name[: -len("_fixed")] + "_shuffled", subset)
            if twin in by_sys:
                summary["order_checks"][f"{name[:-len('_fixed')]}|{subset}"] = order_comparison(rs, by_sys[twin])
    summary["idle_window_for_rows_without_load_snapshot"] = [args.idle_after, args.idle_until]
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    (out_dir / "report.md").write_text(report_md(summary))

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


TRACKB_KEYS = ("system", "clip_id", "signer", "true_label", "top", "latency_s")


def trackb_row(rec: dict) -> dict:
    return {k: rec[k] for k in TRACKB_KEYS}


def export(args) -> int:
    out_dir = Path(args.out_dir)
    dst = out_dir / "trackb"
    dst.mkdir(parents=True, exist_ok=True)
    for p in sorted((out_dir / "preds").glob("vlm_*.jsonl")):
        rows = [trackb_row(r) for r in _read_jsonl(p)]
        (dst / p.name).write_text("".join(json.dumps(r) + "\n" for r in rows))
        print(f"wrote {dst / p.name} ({len(rows)} rows)")
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
    s.add_argument("--balanced", type=int, nargs="*", default=[2, 4, 6, 12],
                   help="also summarise takes 1..K of every class (only if all classes have K)")
    s.add_argument("--idle-after", default="2026-10-11 00:00:00",
                   help="rows without a load snapshot count as 'quiet' from this time ...")
    s.add_argument("--idle-until", default="2026-10-11 00:29:30",
                   help="... until this time (other jobs restarted at 00:29-00:30 on 2026-10-11)")
    e = sub.add_parser("export", help="strict six-key Track B JSONL per system")
    e.add_argument("--out-dir", default=str(OUT_DIR))
    a = ap.parse_args(argv)
    return {"run": run, "summarize": summarize, "export": export}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())

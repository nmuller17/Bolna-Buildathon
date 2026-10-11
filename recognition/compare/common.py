"""Shared prediction schema and metrics for comparing sign classifiers on the same clips.

One JSON line per (system, clip):
    {"system", "track", "mode", "fold", "clip_id", "signer", "true_label",
     "oov": bool,            # clip is a sign outside the system's label set (open-set test)
     "oov_sign": str|None,   # which outside sign (GISLR gloss), for the report
     "top3": [{"label", "conf"}],   # conf may be None (manual competitor entry)
     "probs": {label: p}|None,      # full distribution over the mode's label set, when there is one
     "answered": bool,       # False = the system gave no answer for this clip
     "latency_ms": float|None}

Metrics reuse recognition.benchmark.metrics (accuracy, top-3, macro-F1, recall, confusion,
coverage and accuracy at 0.6, ECE) by placing each distribution in the 22-class index.
Confidence intervals resample SIGNERS, not clips: clips of one person are not independent,
and the question is "how well for a new person", so the person is the unit of sampling.
"""
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

from recognition.benchmark import metrics as bench_metrics
from recognition.labels import CLASSES, INDEX, NONE

THRESHOLD = 0.6
B_DEFAULT = 2000


def record(system, clip_id, signer, true_label, labels=None, probs=None, top=None, **extra):
    """Build one prediction record. Give either (labels, probs) or top=[(label, conf|None), ...]."""
    if probs is not None:
        p = np.asarray(probs, dtype=np.float64)
        order = np.argsort(-p, kind="stable")[:3]
        top3 = [{"label": labels[i], "conf": float(p[i])} for i in order]
        dist = {l: float(v) for l, v in zip(labels, p)}
    else:
        top3 = [{"label": l, "conf": None if c is None else float(c)} for l, c in (top or [])][:3]
        dist = None
    rec = {"system": system, "clip_id": str(clip_id), "signer": str(signer), "true_label": true_label,
           "oov": False, "oov_sign": None, "top3": top3, "probs": dist, "answered": bool(top3),
           "latency_ms": None}
    rec.update(extra)
    return rec


def write_jsonl(path, records):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def read_jsonl(paths):
    out = []
    for p in paths:
        with open(p) as f:
            out += [json.loads(line) for line in f if line.strip()]
    return out


def pred_of(r):
    return r["top3"][0]["label"] if r["answered"] else None


def conf_of(r):
    return r["top3"][0]["conf"] if r["answered"] else None


def accepted(r, threshold=THRESHOLD):
    """The demo rule: speak the top label when conf >= threshold and it is not NONE.
    A system without confidences (manual entry) counts as accepting every non-NONE answer."""
    if not r["answered"] or pred_of(r) == NONE:
        return False
    c = conf_of(r)
    return True if c is None else c >= threshold


def _to22(r):
    v = np.zeros(len(CLASSES))
    for l, p in r["probs"].items():
        v[INDEX[l]] = p
    return v


def in_vocab_metrics(recs, threshold=THRESHOLD):
    """Metrics on clips whose true label is in the label set. Records without an answer count as wrong."""
    if not recs:
        return None
    full = all(r["answered"] and r["probs"] is not None and all(l in INDEX for l in r["probs"]) for r in recs)
    y = np.array([INDEX[r["true_label"]] for r in recs])
    if full:
        m = bench_metrics(np.stack([_to22(r) for r in recs]), y, threshold)
        m.pop("none_false_alarm_rate", None)  # NONE clips are scored as open-set instead
        if any(not np.isclose(sum(r["probs"].values()), 1.0, atol=1e-5) for r in recs):
            m["ece"] = None  # e.g. pretrained R8 uses max-other scores, not a probability distribution
    else:  # top-1 only (manual entries, partial answers)
        pred = [pred_of(r) for r in recs]
        ok = np.array([p == r["true_label"] for p, r in zip(pred, recs)])
        top3 = np.array([any(t["label"] == r["true_label"] for t in r["top3"]) for r in recs])
        m = {"n": len(recs), "accuracy": round(float(ok.mean()), 4), "top3_accuracy": round(float(top3.mean()), 4),
             "macro_f1": round(macro_f1([r["true_label"] for r in recs], pred), 4),
             "per_class_recall": {}, "confusion": None, "ece": None,
             "coverage_at_threshold": None, "accuracy_on_accepted": None}
        for c in sorted({r["true_label"] for r in recs}):
            idx = [i for i, r in enumerate(recs) if r["true_label"] == c]
            m["per_class_recall"][c] = round(float(ok[idx].mean()), 4)
        confs = [conf_of(r) for r in recs]
        if all(c is not None for c in confs):  # top-3 with confidences but no full distribution (e.g. /predict)
            acc = np.array(confs) >= threshold
            m["coverage_at_threshold"] = round(float(acc.mean()), 4)
            m["accuracy_on_accepted"] = round(float(ok[acc].mean()), 4) if acc.any() else None
    # Product acceptance also excludes NONE. A confident refusal is never a spoken sign.
    if all(not r["answered"] or conf_of(r) is not None for r in recs):
        spoken = [r for r in recs if accepted(r, threshold)]
        m["coverage_at_threshold"] = round(len(spoken) / len(recs), 4)
        m["accuracy_on_accepted"] = (round(float(np.mean([pred_of(r) == r["true_label"] for r in spoken])), 4)
                                     if spoken else None)
    m["no_answer_rate"] = round(float(np.mean([not r["answered"] for r in recs])), 4)
    m["wrong_sign_spoken_rate"] = round(float(np.mean([accepted(r, threshold) and pred_of(r) != r["true_label"]
                                                       for r in recs])), 4)
    return m


def macro_f1(y_true, y_pred, labels=None):
    labels = sorted(set(y_true)) if labels is None else labels
    f1 = []
    for c in labels:
        tp = sum(t == c and p == c for t, p in zip(y_true, y_pred))
        fp = sum(t != c and p == c for t, p in zip(y_true, y_pred))
        fn = sum(t == c and p != c for t, p in zip(y_true, y_pred))
        f1.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1)) if f1 else float("nan")


def false_accept_rate(oov_recs, threshold=THRESHOLD):
    """Open-set: share of out-of-vocabulary clips the demo rule would SPEAK as one of our signs. Lower is better."""
    return round(float(np.mean([accepted(r, threshold) for r in oov_recs])), 4) if oov_recs else None


# ---------- bootstrap over signers ----------

def _groups(recs):
    g = defaultdict(list)
    for r in recs:
        g[r["signer"]].append(r)
    return g


STATS = {
    "top1": lambda rs: float(np.mean([pred_of(r) == r["true_label"] for r in rs])),
    "top3": lambda rs: float(np.mean([any(t["label"] == r["true_label"] for t in r["top3"]) for r in rs])),
    "macro_f1": lambda rs: macro_f1([r["true_label"] for r in rs], [pred_of(r) for r in rs]),
    "false_accept": lambda rs: float(np.mean([accepted(r) for r in rs])),
}


def boot_ci(recs, stat, B=B_DEFAULT, seed=0):
    """95% percentile CI of stat(pooled clips) when the signers are resampled with replacement."""
    if not recs:
        return None
    f = STATS[stat] if isinstance(stat, str) else stat
    g = _groups(recs)
    names = sorted(g)
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(B):
        pick = rng.integers(0, len(names), len(names))
        vals.append(f([r for i in pick for r in g[names[i]]]))
    return [round(float(np.percentile(vals, 2.5)), 4), round(float(np.percentile(vals, 97.5)), 4)]


def per_signer(recs, stat="top1"):
    f = STATS[stat] if isinstance(stat, str) else stat
    return {s: {"n": len(rs), stat if isinstance(stat, str) else "value": round(f(rs), 4)}
            for s, rs in sorted(_groups(recs).items())}


def paired(recs_a, recs_b, stat="top1", B=B_DEFAULT, seed=0):
    """A minus B on the clips both answered: point difference, signer-bootstrap 95% CI and two-sided
    bootstrap p, plus an exact McNemar test on top-1 (McNemar treats clips as independent, which
    they are not within a signer, so it is optimistic; the signer bootstrap is the main test)."""
    a = {r["clip_id"]: r for r in recs_a}
    b = {r["clip_id"]: r for r in recs_b}
    if len(a) != len(recs_a) or len(b) != len(recs_b):
        raise ValueError("duplicate clip IDs in paired comparison")
    common = sorted(set(a) & set(b))
    if not common:
        return None
    f = STATS[stat]
    pairs = defaultdict(list)
    for c in common:
        if any(a[c][key] != b[c][key] for key in ("signer", "true_label", "oov")):
            raise ValueError(f"inconsistent clip metadata for {c}")
        pairs[a[c]["signer"]].append((a[c], b[c]))
    names = sorted(pairs)
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(B):
        pick = rng.integers(0, len(names), len(names))
        pa = [x for i in pick for x, _ in pairs[names[i]]]
        pb = [y for i in pick for _, y in pairs[names[i]]]
        diffs.append(f(pa) - f(pb))
    diffs = np.array(diffs)
    point = f([a[c] for c in common]) - f([b[c] for c in common])
    p_boot = min(1.0, 2 * min((diffs <= 0).mean(), (diffs >= 0).mean()))
    out = {"n_clips": len(common), "n_signers": len(names), "stat": stat, "diff": round(point, 4),
           "ci95": [round(float(np.percentile(diffs, 2.5)), 4), round(float(np.percentile(diffs, 97.5)), 4)],
           "p_signer_bootstrap": round(float(p_boot), 4)}
    if stat == "top1":
        ra = [pred_of(a[c]) == a[c]["true_label"] for c in common]
        rb = [pred_of(b[c]) == b[c]["true_label"] for c in common]
        n01 = sum(x and not y for x, y in zip(ra, rb))
        n10 = sum(y and not x for x, y in zip(ra, rb))
        out.update(a_only_right=n01, b_only_right=n10, p_mcnemar_exact=round(mcnemar_exact(n01, n10), 6))
    return out


def mcnemar_exact(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def latency_p50(recs):
    v = [r["latency_ms"] for r in recs if r.get("latency_ms") is not None]
    return round(float(np.median(v)), 2) if v else None


def summarize(recs, threshold=THRESHOLD, B=B_DEFAULT):
    """Full summary for one system on one test set: in-vocabulary metrics with signer CIs, open-set
    false-accept with CI, per-signer accuracy. recs = that system's records (in-vocab and OOV)."""
    inv = [r for r in recs if not r["oov"]]
    oov = [r for r in recs if r["oov"]]
    m = in_vocab_metrics(inv, threshold) or {}
    out = {"n_clips": len(inv), "n_signers": len({r["signer"] for r in inv}), "metrics": m,
           "top1_ci95": boot_ci(inv, "top1", B), "top3_ci95": boot_ci(inv, "top3", B),
           "macro_f1_ci95": boot_ci(inv, "macro_f1", B), "per_signer_top1": per_signer(inv, "top1"),
           "n_oov_clips": len(oov), "open_set_false_accept": false_accept_rate(oov, threshold),
           "open_set_false_accept_ci95": boot_ci(oov, lambda rs: np.mean([accepted(r, threshold) for r in rs]), B) if oov else None,
           "open_set_per_sign": {s: round(float(np.mean([accepted(r, threshold) for r in oov if r["oov_sign"] == s])), 4)
                                 for s in sorted({r["oov_sign"] for r in oov if r["oov_sign"]})},
           "latency_p50_ms": latency_p50(recs)}
    return out

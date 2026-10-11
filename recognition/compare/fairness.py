"""Fairness-audit additions to the Track A / Track B reports (audit of 2026-10-10, findings 1, 4, 5, 6).

  signer-averaged top-1  mean over signers of each signer's top-1 (every new person counts once), next to
                         the pooled number (every clip counts once). CI and paired tests resample signers.
  macro-F1 with NONE     in a mode that can answer NONE (R8, Track B), an 8-class (or 22-class) macro-F1 over
                         in-vocabulary AND outside clips: NONE is a class, so a refusal of a real sign costs
                         recall of that sign AND precision of NONE, and a false accept costs precision of
                         the sign it was mistaken for. The old R8 number (7 sign classes, in-vocabulary clips
                         only) rewards refusing and is kept only as "macro-F1 over the 7 signs".
  outside-sign strata    open-set false accept per stratum (handpicked / random / near_neighbour), see
                         oov_strata.py; the random stratum also gets a CI that resamples signs as well as
                         signers, because which signs are drawn is a second source of chance.
"""
from collections import defaultdict

import numpy as np

from recognition.compare import common

STRATUM_TEXT = {
    "random": "random outside signs (pre-registered draw: 30 signs, 300 clips)",
    "near_neighbour": "near-neighbour outside signs (15 signs that resemble ours, 225 clips; hand-chosen by the audit)",
    "handpicked": "original hand-picked outside signs (15 signs, mostly animals/objects, 225 clips; no selection rule)",
}


def _groups(recs, key="signer"):
    g = defaultdict(list)
    for r in recs:
        g[r[key]].append(r)
    return g


def top1(rs):
    return float(np.mean([common.pred_of(r) == r["true_label"] for r in rs]))


def signer_avg(recs, stat=top1):
    return float(np.mean([stat(rs) for rs in _groups(recs).values()]))


def boot_signer_avg(recs, stat=top1, B=common.B_DEFAULT, seed=0):
    """Point value and signer-bootstrap 95% CI of the mean over signers (a signer drawn twice counts twice)."""
    per = [stat(rs) for _, rs in sorted(_groups(recs).items())]
    rng = np.random.default_rng(seed)
    vals = [np.mean([per[i] for i in rng.integers(0, len(per), len(per))]) for _ in range(B)]
    return round(float(np.mean(per)), 4), [round(float(np.percentile(vals, 2.5)), 4),
                                          round(float(np.percentile(vals, 97.5)), 4)]


def paired_signer_avg(recs_a, recs_b, stat=top1, B=common.B_DEFAULT, seed=0):
    """A minus B of the signer-averaged stat on the clips both have; signer bootstrap CI and two-sided p."""
    a = {r["clip_id"]: r for r in recs_a}
    b = {r["clip_id"]: r for r in recs_b}
    common_ids = sorted(set(a) & set(b))
    ga, gb = defaultdict(list), defaultdict(list)
    for c in common_ids:
        ga[a[c]["signer"]].append(a[c])
        gb[a[c]["signer"]].append(b[c])
    names = sorted(ga)
    d = np.array([stat(ga[s]) - stat(gb[s]) for s in names])
    rng = np.random.default_rng(seed)
    boots = np.array([d[rng.integers(0, len(d), len(d))].mean() for _ in range(B)])
    p = min(1.0, 2 * min((boots <= 0).mean(), (boots >= 0).mean()))
    return {"n_signers": len(names), "n_clips": len(common_ids), "diff": round(float(d.mean()), 4),
            "ci95": [round(float(np.percentile(boots, 2.5)), 4), round(float(np.percentile(boots, 97.5)), 4)],
            "p_signer_bootstrap": round(float(p), 4)}


def macro_f1_with_none(recs, labels):
    """Macro-F1 over `labels` (must include NONE) on in-vocabulary + outside records (outside true label = NONE).
    A record without an answer counts as a wrong answer (it never matches any label)."""
    return common.macro_f1([r["true_label"] for r in recs], [common.pred_of(r) for r in recs], labels)


def boot_macro_f1_with_none(recs, labels, B=common.B_DEFAULT, seed=0):
    return round(macro_f1_with_none(recs, labels), 4), common.boot_ci(recs, lambda rs: macro_f1_with_none(rs, labels), B, seed)


def false_accept_two_way_ci(oov_recs, B=common.B_DEFAULT, seed=0, threshold=common.THRESHOLD):
    """CI that resamples signers AND outside signs (independently), for a stratum whose signs were drawn at random."""
    signers = sorted({r["signer"] for r in oov_recs})
    signs = sorted({r["oov_sign"] for r in oov_recs})
    cell = defaultdict(list)
    for r in oov_recs:
        cell[(r["signer"], r["oov_sign"])].append(common.accepted(r, threshold))
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(B):
        ps = rng.integers(0, len(signers), len(signers))
        qs = rng.integers(0, len(signs), len(signs))
        x = [v for i in ps for j in qs for v in cell.get((signers[i], signs[j]), [])]
        if x:
            vals.append(np.mean(x))
    return [round(float(np.percentile(vals, 2.5)), 4), round(float(np.percentile(vals, 97.5)), 4)]


def stratum_summary(oov_recs, B=common.B_DEFAULT, two_way=False):
    fa = common.false_accept_rate(oov_recs)
    out = {"n_clips": len(oov_recs), "n_signers": len({r["signer"] for r in oov_recs}),
           "n_signs": len({r["oov_sign"] for r in oov_recs}), "false_accept": fa,
           "ci95_signers": common.boot_ci(oov_recs, "false_accept", B),
           "per_sign": {s: round(float(np.mean([common.accepted(r) for r in oov_recs if r["oov_sign"] == s])), 4)
                        for s in sorted({r["oov_sign"] for r in oov_recs})}}
    if two_way:
        out["ci95_signers_and_signs"] = false_accept_two_way_ci(oov_recs, B)
    return out

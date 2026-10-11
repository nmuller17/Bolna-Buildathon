"""Aggregate the LOSO transfer runs into recognition/transfer/reports/transfer_loso.{md,json}.

    python -m recognition.transfer.report [--out data/transfer_runs/v1]

Only aggregate numbers go into the report (per-take predictions stay in the gitignored data/ folder).
A system/fold without a manifest is refused (not silently skipped).
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from recognition.benchmark import THRESHOLD, metrics, spoken_wrong
from recognition.labels import CLASSES, INDEX
from recognition.transfer.run_loso import FOLDS, NAMES, OPENSET_GROUPS, OUT, SYSTEMS

NONE_I = INDEX["NONE"]
REPORTS = Path(__file__).parent / "reports"
T975_DF3 = 3.182446  # Student t, 97.5th percentile, 3 degrees of freedom (4 folds)


def load(out, system):
    P, P1, Y, OP, OP1, man = [], [], [], [], [], []
    for f in FOLDS:
        mp = out / "preds" / f"{system}_{f}.manifest.json"
        if not mp.exists():
            return None
        z = np.load(out / "preds" / f"{system}_{f}.npz")
        P.append(z["probs"]), P1.append(z["probs_T1"]), Y.append(z["labels"])
        OP.append(z["oov_probs"]), OP1.append(z["oov_probs_T1"])
        man.append(json.loads(mp.read_text()))
    return {"P": P, "P1": P1, "Y": Y, "OP": OP, "OP1": OP1, "man": man}


def wrong_spoken_vec(p, y):
    return ((p.max(1) >= THRESHOLD) & (p.argmax(1) != NONE_I) & (p.argmax(1) != y)).astype(float)


def gated_none_spoken(p, y):
    none = y == NONE_I
    if not none.any():
        return None
    q = p[none]
    return round(float(((q.max(1) >= THRESHOLD) & (q.argmax(1) != NONE_I)).mean()), 4)


def full_metrics(P, P1, Y):
    p, p1, y = np.concatenate(P), np.concatenate(P1), np.concatenate(Y)
    m = metrics(p, y)
    m["wrong_sign_spoken_rate_T1"] = spoken_wrong(p1, y)
    m["none_spoken_at_threshold"] = gated_none_spoken(p, y)
    return m


def oov_rate(OP):
    p = np.concatenate(OP)
    return round(float(((p.max(1) >= THRESHOLD) & (p.argmax(1) != NONE_I)).mean()), 4)


def openset_rates(out, system):
    """Grouped unknown-sign test (3 groups of 7 signs, every sign unknown once per fold) and, if present,
    the repo's exact one-sign-at-a-time version."""
    res = {}
    for kind, groups in (("grouped", [str(g) for g in range(len(OPENSET_GROUPS))]),
                         ("exact", [f"sign:{c}" for c in range(len(CLASSES)) if c != NONE_I])):
        rows = []
        for f in FOLDS:
            for g in groups:
                p = out / "openset" / f"{system}_{f}_{g}.json"
                if not p.exists():
                    rows = None
                    break
                rows.append(json.loads(p.read_text()))
            if rows is None:
                break
        if not rows:
            continue
        per_sign = {}
        per_fold = {f: [] for f in FOLDS}
        for r in rows:
            for lab, s in zip(r["labels"], r["spoken_T"]):
                per_sign.setdefault(CLASSES[lab], []).append(s)
                per_fold[r["fold"]].append(s)
        sign_rates = {k: round(float(np.mean(v)), 4) for k, v in per_sign.items()}
        res[kind] = {"unknown_sign_spoken_rate": round(float(np.mean(list(sign_rates.values()))), 4),
                     "unknown_sign_spoken_rate_T1": round(float(np.mean([np.mean([x for r in rows for x, l in zip(r["spoken_T1"], r["labels"]) if CLASSES[l] == k]) for k in sign_rates])), 4),
                     "per_fold": {f: round(float(np.mean(v)), 4) for f, v in per_fold.items()},
                     "per_sign": sign_rates}
    return res


def paired(a, b, key="wrong", n_boot=10000, seed=0):
    """b minus a over the 4 folds: per-fold differences, t-interval (df 3), hierarchical bootstrap
    (folds, then takes within fold; paired), exact sign-flip p over folds."""
    if key == "wrong":
        va = [wrong_spoken_vec(p, y) for p, y in zip(a["P"], a["Y"])]
        vb = [wrong_spoken_vec(p, y) for p, y in zip(b["P"], b["Y"])]
    else:
        va = [(p.argmax(1) == y).astype(float) for p, y in zip(a["P"], a["Y"])]
        vb = [(p.argmax(1) == y).astype(float) for p, y in zip(b["P"], b["Y"])]
    d = np.array([vb[i].mean() - va[i].mean() for i in range(len(FOLDS))])
    se = d.std(ddof=1) / np.sqrt(len(d))
    rng = np.random.default_rng(seed)
    boot = np.empty(n_boot)
    for k in range(n_boot):
        fs = rng.integers(0, len(FOLDS), len(FOLDS))
        tot = 0.0
        for f in fs:
            idx = rng.integers(0, len(va[f]), len(va[f]))
            tot += vb[f][idx].mean() - va[f][idx].mean()
        boot[k] = tot / len(fs)
    signs = np.array(np.meshgrid(*[[-1, 1]] * len(d))).reshape(len(d), -1).T
    null = np.abs((signs * d).mean(1))
    p_flip = float((null >= abs(d.mean()) - 1e-12).mean())
    # take-level paired test pooled over folds (exact McNemar-style sign test on discordant takes)
    da = np.concatenate(va)
    db = np.concatenate(vb)
    n10, n01 = int(((da == 1) & (db == 0)).sum()), int(((da == 0) & (db == 1)).sum())
    from math import comb
    n = n10 + n01
    k = min(n10, n01)
    p_mc = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0
    return {"per_fold_diff": dict(zip(FOLDS, np.round(d, 4).tolist())), "mean_diff": round(float(d.mean()), 4),
            "t_ci95": [round(float(d.mean() - T975_DF3 * se), 4), round(float(d.mean() + T975_DF3 * se), 4)],
            "bootstrap_ci95": [round(float(np.percentile(boot, 2.5)), 4), round(float(np.percentile(boot, 97.5)), 4)],
            "sign_flip_p_over_folds": round(p_flip, 4), "folds_b_better": int((d < 0).sum()) if key == "wrong" else int((d > 0).sum()),
            "takes_only_a_wrong": n10, "takes_only_b_wrong": n01, "exact_mcnemar_p_pooled_takes": round(p_mc, 4)}


def top_confusions(cm, k=6):
    cm = np.array(cm)
    off = [(cm[i, j], CLASSES[i], CLASSES[j]) for i in range(len(cm)) for j in range(len(cm)) if i != j and cm[i, j]]
    return [f"{t}->{p} ({n})" for n, t, p in sorted(off, reverse=True)[:k]]


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    out = Path(a.out)
    runs = {s: load(out, s) for s in SYSTEMS}
    missing = [s for s, r in runs.items() if r is None]
    runs = {s: r for s, r in runs.items() if r is not None}
    lat = json.loads((out / "latency.json").read_text()) if (out / "latency.json").exists() else {}
    stage1 = out.parent / "stage1" / "stage1_manifest.json"
    stage1 = json.loads(stage1.read_text()) if stage1.exists() else None
    res = {"created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "threshold": THRESHOLD,
           "folds": FOLDS, "systems": {}, "missing_systems": missing, "latency": lat,
           "openset_groups": [[CLASSES[c] for c in g] for g in OPENSET_GROUPS],
           "stage1": {k: v for k, v in (stage1 or {}).items() if k != "curve"}}
    for s, r in runs.items():
        m = full_metrics(r["P"], r["P1"], r["Y"])
        folds = []
        for f, p, p1, y, man in zip(FOLDS, r["P"], r["P1"], r["Y"], r["man"]):
            fm = metrics(p, y)
            folds.append({"fold": f, "n": int(len(y)), "accuracy": fm["accuracy"], "top3": fm["top3_accuracy"],
                          "macro_f1": fm["macro_f1"], "wrong_sign_spoken": fm["wrong_sign_spoken_rate"],
                          "coverage": fm["coverage_at_threshold"], "inner_val": man["inner_val"],
                          "best_epoch": man["inner_fit"].get("best_epoch"), "temperature": man["temperature"],
                          "oov_spoken": oov_rate([r["OP"][FOLDS.index(f)]])})
        res["systems"][s] = {"name": NAMES[s], "pooled": {k: v for k, v in m.items() if k != "confusion"},
                             "confusion": m["confusion"], "top_confusions": top_confusions(m["confusion"]),
                             "per_fold": folds, "gislr_oov_spoken_rate": oov_rate(r["OP"]),
                             "gislr_oov_spoken_rate_T1": oov_rate(r["OP1"]), "openset": openset_rates(out, s)}
    comps = {}
    for b, a_ in [("C", "A"), ("C", "B"), ("C", "D"), ("C", "C0"), ("B", "A"), ("D", "A"), ("C0", "A")]:
        if b in runs and a_ in runs:
            comps[f"{b}_vs_{a_}"] = {"wrong_sign_spoken": paired(runs[a_], runs[b], "wrong"),
                                     "accuracy": paired(runs[a_], runs[b], "acc")}
    res["comparisons"] = comps
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "transfer_loso.json").write_text(json.dumps(res, indent=1))
    write_md(res)
    print(f"wrote {REPORTS / 'transfer_loso.md'}")


def write_md(res):
    S = list(res["systems"])
    sy = res["systems"]
    L = ["# Transfer learning vs the team baseline: leave-one-signer-out, face-free", "",
         f"Created {res['created']}. Test signers: {', '.join(res['folds'])} (one fold each, 264 takes = 22 classes x 12). "
         "Talha is in every training set and is never a validation or test signer. Every system sees the same folds, "
         "the same takes, the same inner validation signer (chosen by recognition.train.split, seed 0) for early stopping "
         f"and temperature (T >= 1), the same refit on all training signers, and the same {res['threshold']} gate. "
         "All inputs are face-free (face = None, pose 1-10 replaced by the pose nose), as the live recognizer receives them.", ""]
    if res["missing_systems"]:
        L += [f"**Not finished / not reported:** {', '.join(res['missing_systems'])}.", ""]
    L += ["## Systems", "", md_table([[s, sy[s]["name"]] for s in S], ["id", "system"]), ""]
    keys = [("accuracy", "accuracy"), ("top3_accuracy", "top-3"), ("macro_f1", "macro-F1"),
            ("wrong_sign_spoken_rate", "wrong sign spoken @0.6"), ("wrong_sign_spoken_rate_T1", "wrong sign spoken @0.6, T=1"),
            ("coverage_at_threshold", "coverage @0.6"), ("accuracy_on_accepted", "accuracy on accepted"),
            ("none_false_accept_rate", "NONE false-accept (sign -> NONE)"), ("none_false_alarm_rate", "NONE false-alarm (NONE -> sign, argmax)"),
            ("none_spoken_at_threshold", "NONE spoken as a sign @0.6"), ("ece", "ECE")]
    rows = [[lab] + [sy[s]["pooled"].get(k) for s in S] for k, lab in keys]
    rows.append(["unknown sign spoken @0.6 (team, 3 groups of 7 left out)"] +
                [sy[s]["openset"].get("grouped", {}).get("unknown_sign_spoken_rate", "-") for s in S])
    rows.append(["unknown sign spoken @0.6 (team, repo's one-sign-out)"] +
                [sy[s]["openset"].get("exact", {}).get("unknown_sign_spoken_rate", "-") for s in S])
    rows.append(["GISLR out-of-vocabulary clips spoken as a sign @0.6 (450 clips, 30 signs)"] + [sy[s]["gislr_oov_spoken_rate"] for s in S])
    lat = res.get("latency", {})
    rows.append(["latency per segment p50 / p95 ms (CPU, 2 threads)"] +
                [f"{lat[s]['p50_ms']} / {lat[s]['p95_ms']}" if s in lat else "-" for s in S])
    rows.append(["parameters"] + [f"{lat[s]['params']:,}" if s in lat else "-" for s in S])
    rows.append(["checkpoint size"] + [f"{lat[s]['checkpoint_bytes'] / 1e6:.2f} MB" if s in lat else "-" for s in S])
    L += ["## Pooled over the 4 test signers (1,056 takes)", "", md_table(rows, ["metric"] + S), ""]
    if lat:
        L += [f"Latency: one {lat.get('segment_frames')}-frame segment, normalisation + features + forward, 200 runs, "
              f"machine load average {lat.get('load_avg_before')} (shared machine; compare systems with each other, not with an idle laptop).", ""]
    for name, c in res["comparisons"].items():
        b, a_ = name.split("_vs_")
        w, acc = c["wrong_sign_spoken"], c["accuracy"]
        L += [f"## {b} vs {a_}", "",
              md_table([["wrong sign spoken @0.6 (lower is better)", w["mean_diff"], w["t_ci95"], w["bootstrap_ci95"], w["sign_flip_p_over_folds"],
                         w["exact_mcnemar_p_pooled_takes"], f"{w['folds_b_better']}/4", ", ".join(f"{k} {v:+.4f}" for k, v in w["per_fold_diff"].items())],
                        ["accuracy (higher is better)", acc["mean_diff"], acc["t_ci95"], acc["bootstrap_ci95"], acc["sign_flip_p_over_folds"],
                         acc["exact_mcnemar_p_pooled_takes"], f"{acc['folds_b_better']}/4", ", ".join(f"{k} {v:+.4f}" for k, v in acc["per_fold_diff"].items())]],
                       ["metric", f"mean {b} - {a_}", "95% CI (t, 4 folds)", "95% CI (bootstrap: folds, then takes)",
                        "sign-flip p (folds)", "McNemar p (pooled takes)", f"folds where {b} is better", "per fold"]), ""]
    L += ["## Per fold", ""]
    rows = []
    for s in S:
        for f in sy[s]["per_fold"]:
            rows.append([s, f["fold"], f["inner_val"], f["best_epoch"], f["temperature"], f["accuracy"], f["top3"], f["macro_f1"],
                         f["wrong_sign_spoken"], f["coverage"], f["oov_spoken"]])
    L += [md_table(rows, ["system", "test signer", "inner val", "epochs", "T", "accuracy", "top-3", "macro-F1",
                          "wrong spoken", "coverage", "GISLR OOV spoken"]), ""]
    L += ["## Per-class recall (pooled)", "",
          md_table([[c] + [sy[s]["pooled"]["per_class_recall"].get(c, "-") for s in S] for c in CLASSES], ["sign"] + S), ""]
    L += ["## Top confusions (true -> predicted, count over 4 folds)", "",
          md_table([[s, "; ".join(sy[s]["top_confusions"])] for s in S], ["system", "confusions"]), ""]
    st = res.get("stage1") or {}
    if st:
        L += ["## Stage 1 (face-free adaptation of the pretrained weights, GISLR only)", "",
              f"{st.get('train_clips')} GISLR rerun clips (CC0) of {st.get('signs')} signs, held-out participant {st.get('val_participant')} "
              f"({st.get('val_clips')} clips). 250-way accuracy on that participant: teacher with face {st.get('teacher_val_acc_with_face')}, "
              f"face-free before adaptation {st.get('student_val_acc_face_free_before')}, after {st.get('student_val_acc_face_free_after')} "
              f"(best epoch {st.get('best_epoch')}). The 30 GISLR OOV test signs were excluded from stage 1.", ""]
    L += ["## Unknown-sign groups (team open-set test)", "",
          "Each fold trains three extra models, each without one group of 7 signs, for the epoch count chosen in that fold, and "
          "scores the held-out signer's takes of the missing signs at the fold's temperature. Every sign is unknown exactly once "
          "per fold. The repo's benchmark leaves out one sign at a time (21 models per fold); that exact version is also reported "
          "where it was run.", "", md_table([[i, ", ".join(g)] for i, g in enumerate(res["openset_groups"])], ["group", "signs"]), ""]
    L += ["## Definitions", "",
          "- **wrong sign spoken @0.6**: share of takes where the top label has confidence >= 0.6, is not NONE, and is wrong; the product would say a sign the guest did not make.",
          "- **coverage @0.6**: share of takes accepted (top confidence >= 0.6), whatever the label.",
          "- **NONE false-accept**: real signs predicted as NONE (argmax). **NONE false-alarm**: NONE takes predicted as a sign (argmax). **NONE spoken @0.6**: NONE takes that pass the gate as a sign.",
          "- **unknown sign spoken**: takes of a sign the model was not trained on that pass the gate as some sign (mean over signs).",
          "- **GISLR OOV spoken**: 450 GISLR rerun clips (10 Deaf signers, phone video) of 30 signs outside our vocabulary that pass the gate as a sign. Different domain from the team webcam data; the pretrained 1st-place network saw these 30 signs (from other people) during its original training, so this column favours C/C0.",
          "- **CIs**: with only 4 test signers the t-interval (3 degrees of freedom) is the honest between-signer interval; the bootstrap resamples signers and then takes; the sign-flip test over 4 folds cannot go below p = 0.125.", ""]
    (REPORTS / "transfer_loso.md").write_text("\n".join(L))


if __name__ == "__main__":
    main()

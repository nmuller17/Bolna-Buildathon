"""One comparison report (markdown + JSON) per track, following PROTOCOL.md.

    python -m recognition.compare.report --track a                       # -> reports/track_a_v1.{md,json}
    python -m recognition.compare.report --track b --preds data/compare/track_b/preds --tag team

Track A uses a (system, fold) prediction file only when its manifest exists, was written under the
current PROTOCOL.md, names the pre-registered clip index and fold, and still matches the file.
Everything else is listed as refused. Only aggregate numbers go into recognition/compare/reports/;
per-clip predictions stay in the gitignored data/compare/.
"""
import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from recognition.compare import common, manifest
from recognition.compare.audit import check_records

ROOT = Path(__file__).resolve().parents[2]
REPORTS = Path(__file__).parent / "reports"

ON_DEVICE = "nothing: landmarks only, processed locally"
LOSO = "yes: leave-one-signer-out"
SYSTEM_INFO = {
    "ours_gru": ("Ours: SignGRU (the model /predict serves)", "same folds: 9 GISLR signers", ON_DEVICE),
    "ours_baseline": ("Ours: baseline (logistic regression on take statistics)", "same folds: 9 GISLR signers", ON_DEVICE),
    "islr1st_ourfeat": ("GISLR 1st-place network on our features + our training procedure", "same folds: 9 GISLR signers", ON_DEVICE),
    "islr1st_retrained": ("GISLR 1st-place network + its own preprocessing (uses face points), retrained", "same folds: 9 GISLR signers", ON_DEVICE),
    "islr1st_pretrained": ("GISLR 1st-place published weights, REFERENCE ONLY", "~94k clips, 250 signs, 21 other participant IDs", ON_DEVICE),
    "claude-sonnet-5": ("Claude Sonnet 5, video frames, closed-set prompt", "general model, no sign training by us", "video frames incl. face -> Anthropic API"),
    "claude-opus-5-5": ("Claude Opus 5.5, video frames, closed-set prompt", "general model, no sign training by us", "video frames incl. face -> Anthropic API"),
}
PRETRAINED_HELD_OUT = ("by participant ID only (0 of its 21 training IDs are test IDs; identity unverified); "
                       "4 of the 10 test signers (public leaderboard) influenced its model selection")

DEFINITIONS = """\
## What each number means

- **test set / #signers / #clips / signer-held-out**: which clips were scored, how many different people signed them, how many clips, and whether the people were absent from the system's training data.
- **top-1**: share of test clips whose single best answer is the true sign. In the 7-class mode (C7), guessing gives 1/7 = 0.14; in the 8-class mode (R8) a sign clip answered NONE counts as wrong.
- **[95% CI]**: the range the number would likely fall in for another group of signers like these. It is computed by re-drawing the signers (not the clips) with replacement 2,000 times, because clips from one person are not independent and the question is how the system does for a new person. With 10 signers (6 in the sensitivity table) these ranges are wide.
- **macro-F1**: for each sign, F1 combines precision (when the system says this sign, how often it is right) and recall (how many clips of this sign it finds); the per-sign values are averaged with equal weight, so ignoring a hard sign is penalised. 1 is perfect.
- **open-set false accept**: clips of 15 signs OUTSIDE the vocabulary (signed by the same held-out person, never seen by the compared systems) that the product rule would speak as one of our signs (top-1 confidence >= 0.6 and top-1 is not NONE). Lower is better. n = number of such clips. The pretrained reference has no value here because all these signs are in its training vocabulary.
- **coverage@0.6**: share of in-vocabulary clips the product rule would speak (top-1 confidence >= 0.6 and not NONE) instead of asking the guest to repeat.
- **accuracy@0.6**: among those spoken clips, the share that are right.
- **wrong sign spoken**: share of in-vocabulary clips where the product rule speaks a WRONG sign. Lower is better.
- **paired difference**: system A minus system B on exactly the same clips. The CI and p come from re-drawing signers; the exact McNemar p treats clips as independent and is therefore optimistic.
- **confusion matrix**: rows are the true sign, columns the top-1 answer; counts of clips.
"""


def fmt(v, ci=None):
    if v is None:
        return "-"
    s = f"{v:.3f}"
    return f"{s} [{ci[0]:.3f}, {ci[1]:.3f}]" if ci else s


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    return "\n".join(out + ["| " + " | ".join(str(c) for c in r) + " |" for r in rows])


HEADER = ["system", "test set", "#signers", "#clips", "signer-held-out", "top-1 [95% CI]", "macro-F1 [95% CI]",
          "open-set false accept [95% CI]", "coverage@0.6", "accuracy@0.6", "wrong sign spoken", "p50 latency",
          "training data", "data that leaves the device"]


def comparison_rows(summaries, test_set, latency=None, track="A", held_out=None):
    rows = []
    for sys_, s in summaries.items():
        m = s["metrics"]
        info = SYSTEM_INFO.get(sys_, (sys_, "-", "-"))
        if track == "B" and sys_.startswith("ours"):
            info = (info[0], "the checkpoint in the Track B manifest", ON_DEVICE)
        elif track == "B" and sys_ not in SYSTEM_INFO:
            info = (sys_, "competitor product (unknown)", "whatever that product sends; check its terms")
        lat = (latency or {}).get(sys_, {}).get("p50_ms", s.get("latency_p50_ms"))
        fa = s["open_set_false_accept"]
        fa_txt = (fmt(fa, s["open_set_false_accept_ci95"]) + f" (n={s['n_oov_clips']})") if fa is not None else \
            ("excluded (OOV signs in its training vocabulary)" if sys_ == "islr1st_pretrained" else "-")
        rows.append([f"`{sys_}`", test_set, s["n_signers"], s["n_clips"], (held_out or {}).get(sys_, "-"),
                     fmt(m.get("accuracy"), s["top1_ci95"]), fmt(m.get("macro_f1"), s["macro_f1_ci95"]), fa_txt,
                     fmt(m.get("coverage_at_threshold")), fmt(m.get("accuracy_on_accepted")),
                     fmt(m.get("wrong_sign_spoken_rate"), s.get("wrong_sign_spoken_ci95")), "-" if lat is None else f"{lat:.1f} ms", info[1], info[2]])
    return rows


def by_system_mode(recs):
    g = defaultdict(list)
    for r in recs:
        g[(r["system"], r["mode"])].append(r)
    return g


def confusion(recs, true_labels, pred_labels):
    """Counts of (true sign, top-1 answer) on in-vocabulary records."""
    cm = {t: {p: 0 for p in pred_labels} for t in true_labels}
    for r in recs:
        if not r["oov"] and r["true_label"] in cm:
            p = common.pred_of(r)
            cm[r["true_label"]][p if p in cm[r["true_label"]] else pred_labels[-1]] += 1
    return cm


def confusion_md(cm, pred_labels):
    return md_table([[t] + [row[p] for p in pred_labels] for t, row in cm.items()], ["true \\ answer"] + pred_labels)


# ---------- Track A ----------

ORDER_A = ["ours_gru", "ours_baseline", "islr1st_ourfeat", "islr1st_retrained", "islr1st_pretrained"]
COMPARED = ORDER_A[:4]
PRIMARY = ("ours_gru", "islr1st_retrained", "C7", "top1")
MARGIN = -0.05   # PROTOCOL.md: non-inferiority margin for the primary endpoint
MODE_TEXT = {
    "C7": ("forced choice among the 7 signs (NONE removed)", "GISLR rerun, 7 shared signs"),
    "R8": ("7 signs or NONE (the product setting)", "GISLR rerun, 7 shared signs"),
}


def complete_groups(idx, recs):
    """Only compare systems with exactly the expected clip set and consistent metadata."""
    groups, excluded = {}, {}
    for key, records in by_system_mode(recs).items():
        system, mode = key
        if system not in ORDER_A or mode not in MODE_TEXT:
            continue
        check = check_records(idx, records, system, mode)
        if check['complete']:
            groups[key] = records
        else:
            excluded[f'{system}/{mode}'] = check['errors']
    return groups, excluded


def manifest_gate(idx, run_dir, groups, fold_sets, protocol=None):
    """Drop every (system, mode) group whose prediction files lack a valid manifest. Returns
    (accepted groups, refused {system: [errors]}, manifests used)."""
    run_dir = Path(run_dir)
    refused, used = {}, {}
    for system in {s for s, _ in groups}:
        folds = ["all"] if system == "islr1st_pretrained" else idx["signers"]
        errors = []
        for fold in folds:
            files = [run_dir / "preds" / f"{system}_{mode}_{fold}.jsonl" for mode in MODE_TEXT]
            errors += manifest.check(idx, system, fold, run_dir, fold_sets, [f for f in files if f.exists()], protocol)
            if not errors:
                used[f"{system}/{fold}"] = manifest.load(run_dir, system, fold)
        if errors:
            refused[system] = errors
    trained = {k: v for k, v in used.items() if not k.startswith("islr1st_pretrained/")}
    consistency = manifest.code_consistency(trained)
    if consistency:
        for system in {k.split("/")[0] for k in trained}:
            refused.setdefault(system, []).extend(consistency)
    accepted = {k: v for k, v in groups.items() if k[0] not in refused}
    return accepted, refused, {k: v for k, v in used.items() if k.split("/")[0] not in refused}


def primary_verdict(p):
    lo, hi = p["ci95"]
    if lo > 0:
        return "ours_gru better (CI entirely above 0)"
    if hi < 0:
        return "ours_gru worse (CI entirely below 0)"
    if lo > MARGIN:
        return f"ours_gru not worse by more than {abs(MARGIN):.2f} (CI lower bound above {MARGIN:+.2f}); no detectable difference"
    return f"inconclusive: the CI includes differences worse than {MARGIN:+.2f}"


# AMENDMENTS.md items 10-15: labels and sensitivity analyses printed with every primary result.
DISCLOSURE = ("endpoint and margin chosen after exploratory results on the same test set were seen "
              "(AMENDMENTS.md item 10)")
MARGIN_STATUS = "margin not yet confirmed by Talha (AMENDMENTS.md items 1 and 14)"
RETRAINED_QUALIFIER = ("`islr1st_retrained` = GISLR 1st-place network and recipe, PyTorch port, at most 60 epochs, 1 seed, "
                       "no AWP, CPU, about 1,200 training clips per fold; not the winner's full 300-epoch recipe")
SCOPE = ("our training recipe retrained per fold on 9 GISLR participants; not the shipped model, not the live "
         "pipeline, not the 22-sign hotel vocabulary")
# two-sided 95% Student t quantiles, df 1..30 (no scipy in the project venv)
T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
        2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042]


def _t975(df):
    return T975[df - 1] if 1 <= df <= len(T975) else 1.96


def signer_sensitivity(ia, ib, stat="top1"):
    """AMENDMENTS.md item 12: the same paired top-1 difference under three other analyses that treat the signer
    as the unit: (a) unweighted mean of per-signer differences with a t-interval (df = signers - 1);
    (b) cluster-robust t-interval for the pooled (clip-weighted) difference; (c) exact sign-flip test on the
    per-signer clip-weighted sums (all 2^G sign assignments)."""
    import itertools
    f = common.STATS[stat]
    a = {r["clip_id"]: r for r in ia}
    b = {r["clip_id"]: r for r in ib}
    by = defaultdict(list)
    for c in sorted(set(a) & set(b)):
        by[a[c]["signer"]].append(c)
    names = sorted(by)
    G = len(names)
    n = np.array([len(by[s]) for s in names], float)
    d = np.array([f([a[c] for c in by[s]]) - f([b[c] for c in by[s]]) for s in names])
    sums = d * n
    pooled = float(sums.sum() / n.sum())
    t = _t975(G - 1)
    um, use = float(d.mean()), float(d.std(ddof=1) / np.sqrt(G)) if G > 1 else float("nan")
    se_cr = float(np.sqrt(G / (G - 1) * np.sum((sums - pooled * n) ** 2)) / n.sum()) if G > 1 else float("nan")
    if G <= 16:
        flips = np.array([np.dot(sums, sg) for sg in itertools.product([-1, 1], repeat=G)])
        p_flip = float(np.mean(np.abs(flips) >= abs(sums.sum()) - 1e-9))
    else:
        p_flip = None
    return {"n_signers": G, "n_clips": int(n.sum()), "per_signer_diff": {s: round(float(x), 4) for s, x in zip(names, d)},
            "pooled_diff": round(pooled, 4),
            "unweighted_signer_mean": round(um, 4),
            "unweighted_signer_mean_t95": [round(um - t * use, 4), round(um + t * use, 4)],
            "cluster_robust_t95": [round(pooled - t * se_cr, 4), round(pooled + t * se_cr, 4)],
            "t_df": G - 1, "sign_flip_exact_p": None if p_flip is None else round(p_flip, 4)}


def verdict_category(ci):
    return primary_verdict({"ci95": ci}).split(" (")[0].split(":")[0]


def robust_verdict(boot_ci, sens):
    """Bootstrap verdict plus the AMENDMENTS.md item 12 wording when another interval gives another category."""
    cats = {"pooled signer bootstrap (registered)": verdict_category(boot_ci),
            "per-signer t (unweighted)": verdict_category(sens["unweighted_signer_mean_t95"]),
            "cluster-robust t (pooled)": verdict_category(sens["cluster_robust_t95"])}
    base = cats["pooled signer bootstrap (registered)"]
    if all(v == base for v in cats.values()):
        return f"same verdict under all three intervals: {base}", cats
    if base.startswith("ours_gru not worse"):
        return ("not worse by more than 5 points under the pre-registered pooled bootstrap only; inconclusive under "
                "per-signer weighting"), cats
    return "verdict depends on the interval method: " + "; ".join(f"{k}: {v}" for k, v in cats.items()), cats


def rate_with_ci(recs, fn, B):
    """Share of recs where fn(r) holds, with the signer-bootstrap 95% CI."""
    if not recs:
        return None
    return {"value": round(float(np.mean([fn(r) for r in recs])), 4),
            "ci95": common.boot_ci(recs, lambda rs: float(np.mean([fn(r) for r in rs])), B),
            "n_clips": len(recs), "n_signers": len({r["signer"] for r in recs})}


def wrong_spoken(r):
    return common.accepted(r) and common.pred_of(r) != r["true_label"]


def product_axis(g, systems, B):
    """AMENDMENTS.md item 13: R8 (product rule) open-set false accept and wrong-sign-spoken, with CIs, plus the
    paired differences, for the systems in the primary contrast."""
    out = {}
    for s in systems:
        recs = g.get((s, "R8"))
        if not recs:
            continue
        out[s] = {"R8_open_set_false_accept": rate_with_ci([r for r in recs if r["oov"]], common.accepted, B),
                  "R8_wrong_sign_spoken": rate_with_ci([r for r in recs if not r["oov"]], wrong_spoken, B)}
    if len(out) == 2:
        x, y = systems
        ra, rb = g[(x, "R8")], g[(y, "R8")]
        out["paired"] = {"R8_open_set_false_accept": common.paired([r for r in ra if r["oov"]], [r for r in rb if r["oov"]],
                                                                   "false_accept", B)}
        common.STATS.setdefault("wrong_spoken", lambda rs: float(np.mean([wrong_spoken(r) for r in rs])))
        out["paired"]["R8_wrong_sign_spoken"] = common.paired([r for r in ra if not r["oov"]],
                                                              [r for r in rb if not r["oov"]], "wrong_spoken", B)
    return out


def ci_txt(v):
    return "-" if not v else f"{v['value']:.3f} [{v['ci95'][0]:.3f}, {v['ci95'][1]:.3f}]"


def diff_txt(p):
    return "-" if not p else f"{p['diff']:+.3f} [{p['ci95'][0]:+.3f}, {p['ci95'][1]:+.3f}]"


def epoch_cap_groups(idx, protocol_used, B=None):
    """AMENDMENTS.md item 11: load the 200-epoch-cap sensitivity run. A system counts only when all 10 folds pass
    every protocol check except the cap, carry cap 200, and used the protocol run's training code."""
    from recognition.compare import epoch_cap
    out = epoch_cap.OUT
    status = {"run_dir": str(out.relative_to(ROOT) if out.is_relative_to(ROOT) else out), "cap": epoch_cap.CAP, "systems": {}}
    groups = {}
    if not (out / "index.json").exists():
        return groups, status
    want = {tuple((f, m.get("code_sha256", {}).get(f)) for f in manifest.TRAINING_CODE) for m in protocol_used.values()}
    for s in epoch_cap.ORDER:
        ok, errs = [], []
        for fold in idx["signers"]:
            e = epoch_cap.check(idx, s, fold, out)
            m = manifest.load(out, s, fold)
            if not e and m and tuple((f, m.get("code_sha256", {}).get(f)) for f in manifest.TRAINING_CODE) not in want:
                e = [f"{s}/{fold}: training code differs from the protocol run"]
            (errs.extend(e) if e else ok.append(fold))
        status["systems"][s] = {"folds_done": len(ok), "of": len(idx["signers"]),
                                "problems": [e for e in errs if "prediction files missing" not in e][:5]}
        if len(ok) == len(idx["signers"]):
            for mode in MODE_TEXT:
                recs = common.read_jsonl([out / "preds" / f"{s}_{mode}_{f}.jsonl" for f in ok])
                check = check_records(idx, recs, s, mode)
                if check["complete"]:
                    groups[(s, mode)] = recs
                else:
                    status["systems"][s]["problems"].append(f"{mode}: incomplete clip set")
    return groups, status


def track_a(run_dir=None, B=common.B_DEFAULT, protocol=None, write=True):
    from recognition.compare.track_a_gislr import OUT, PRIVATE6, fold_sets
    out = Path(run_dir or OUT)
    idx = json.loads((out / "index.json").read_text())
    recs = common.read_jsonl(sorted((out / "preds").glob("*.jsonl")))
    lat_path = out / "latency.json"
    latency = json.loads(lat_path.read_text()) if lat_path.exists() else {}
    g, excluded = complete_groups(idx, recs)
    g, refused, used = manifest_gate(idx, out, g, fold_sets, protocol)
    psha = protocol or manifest.protocol_sha256()
    n_sig, n_in = len(idx["signers"]), sum(not c["oov"] for c in idx["clips"])
    result = {"created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "track": "A",
              "protocol_sha256": psha, "run_dir": str(out), "index_sha256": manifest.index_fingerprint(idx),
              "signers": idx["signers"], "none_train_signs": idx["none_train_signs"],
              "none_test_signs": idx["none_test_signs"], "latency": latency, "modes": {},
              "release_approved": False, "excluded_incomplete": excluded, "refused_no_valid_manifest": refused,
              "manifests_used": sorted(used)}
    ready = all(any(k == (s, m) for k in g) for s in COMPARED for m in MODE_TEXT)
    L = [f"# Track A (protocol): Deaf signers, 7 shared signs, leave-one-signer-out", "",
         "> **NOT A PRODUCT ACCURACY RESULT.** Track A covers 7 of our 21 signs on public GISLR clips, without the "
         "live segmenter or framing gate. Scope of every number below: " + SCOPE + ". " + ("All four compared systems passed the manifest checks."
                                              if ready else "**Incomplete: some systems were refused (below); do not use for slides.**"), "",
         f"Created {result['created']}. Protocol sha256 `{psha}` (recognition/compare/PROTOCOL.md; written after the legacy exploratory results on the same clips were seen, see AMENDMENTS.md item 10). "
         f"Run folder `{out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}`. Clip index fingerprint "
         f"`{result['index_sha256'][:12]}...`.", "",
         f"Test data: GISLR rerun set (Kaggle `sohier/461054610546105`, the competition's hidden test set; CC0 per "
         f"Kaggle metadata), {n_sig} Deaf participant IDs, {n_in} clips of the 7 shared signs (YES, NO, THANK-YOU, "
         "WHERE, TIME, PLEASE, ROOM) plus the held-out person's clips of 15 outside signs "
         f"({', '.join(idx['none_test_signs'])}) for the open-set test. Every compared system is trained on the "
         f"same 9 participants per fold (7 signs + NONE from 15 other signs: {', '.join(idx['none_train_signs'])}) "
         "and tested on the 10th; epochs and temperature are chosen on an inner training signer only.", ""]
    if excluded:
        L += ["Excluded incomplete or inconsistent prediction sets: " + "; ".join(
            f"{name}: {', '.join(errors[:3])}" for name, errors in excluded.items()), ""]
    if refused:
        L += ["**Refused (no valid manifest under this protocol):**", ""]
        L += [f"- `{s}`: {len(e)} problem(s), e.g. {e[0]}" for s, e in sorted(refused.items())]
        L += [""]
    # primary endpoint (with the AMENDMENTS.md items 10-14 labels and sensitivity analyses)
    a, b, pmode, pstat = PRIMARY
    if (a, pmode) in g and (b, pmode) in g:
        ia = [r for r in g[(a, pmode)] if not r["oov"]]
        ib = [r for r in g[(b, pmode)] if not r["oov"]]
        p = common.paired(ia, ib, pstat, B)
        sens = signer_sensitivity(ia, ib, pstat)
        robust, cats = robust_verdict(p["ci95"], sens)
        prod = product_axis(g, [a, b], B)
        result["primary"] = {**p, "verdict": primary_verdict(p), "margin": MARGIN, "labels": [DISCLOSURE, MARGIN_STATUS],
                             "ci_sensitivity": sens, "verdict_by_interval": cats, "robust_verdict": robust,
                             "product_axis_R8": prod, "qualifier": RETRAINED_QUALIFIER, "scope": SCOPE}
        L += ["## Primary endpoint (registered in PROTOCOL.md before the v1 run; NOT a blind pre-registration)", "",
              f"> Labels that go with every quote of this result: **{DISCLOSURE}**; **{MARGIN_STATUS}**; scope: {SCOPE}. "
              f"{RETRAINED_QUALIFIER}.", "",
              f"`{a}` minus `{b}`, {pmode} top-1, GISLR rerun 7 signs, {p['n_signers']} signers, {p['n_clips']} clips, "
              f"signer-held-out: difference **{p['diff']:+.3f}** [95% CI {p['ci95'][0]:+.3f}, {p['ci95'][1]:+.3f}] "
              f"(pooled signer bootstrap, as registered), signer-bootstrap p = {p['p_signer_bootstrap']:.3f} "
              f"(exact McNemar p = {p['p_mcnemar_exact']:.2g}, {p['a_only_right']} vs {p['b_only_right']} clips only one "
              f"system got right). Verdict by the registered rule (margin {MARGIN:+.2f}): **{result['primary']['verdict']}**.", "",
              "Interval sensitivity (AMENDMENTS.md item 12; 10 signers is few, so the interval method matters):", "",
              md_table([["pooled signer bootstrap (registered)", f"{p['diff']:+.3f}", f"[{p['ci95'][0]:+.3f}, {p['ci95'][1]:+.3f}]",
                         cats["pooled signer bootstrap (registered)"]],
                        [f"unweighted per-signer mean, t (df {sens['t_df']})", f"{sens['unweighted_signer_mean']:+.3f}",
                         f"[{sens['unweighted_signer_mean_t95'][0]:+.3f}, {sens['unweighted_signer_mean_t95'][1]:+.3f}]",
                         cats["per-signer t (unweighted)"]],
                        [f"cluster-robust t, pooled (df {sens['t_df']})", f"{sens['pooled_diff']:+.3f}",
                         f"[{sens['cluster_robust_t95'][0]:+.3f}, {sens['cluster_robust_t95'][1]:+.3f}]",
                         cats["cluster-robust t (pooled)"]],
                        ["exact sign-flip test on per-signer sums", f"{sens['pooled_diff']:+.3f}", f"p = {sens['sign_flip_exact_p']}", "-"]],
                       ["analysis", "difference", "95% CI", "verdict category by the same rule"]), "",
              f"Overall reading: **{robust}**.", "",
              "Per-signer differences (A minus B): " + ", ".join(f"{k} {v:+.3f}" for k, v in sens["per_signer_diff"].items()) + ".", "",
              "The product axis next to it (AMENDMENTS.md item 13; R8 = 7 signs or NONE, product rule: speak the top-1 "
              "sign only when its confidence is >= 0.6 and it is not NONE; signer-bootstrap 95% CIs):", ""]
        rows = []
        for s_ in (a, b):
            v = prod.get(s_, {})
            fa, ws = v.get("R8_open_set_false_accept"), v.get("R8_wrong_sign_spoken")
            rows.append([f"`{s_}`", f"{ci_txt(ws)} ({ws['n_signers']} signers, {ws['n_clips']} clips)" if ws else "-",
                         f"{ci_txt(fa)} ({fa['n_signers']} signers, {fa['n_clips']} clips)" if fa else "-"])
        pp = prod.get("paired", {})
        rows.append([f"`{a}` minus `{b}` (paired)", diff_txt(pp.get("R8_wrong_sign_spoken")),
                     diff_txt(pp.get("R8_open_set_false_accept"))])
        L += [md_table(rows, ["system", "wrong sign spoken, in-vocabulary clips [95% CI]",
                              "outside-vocabulary sign spoken as one of ours (open-set false accept) [95% CI]"]), "",
              "Lower is better in both columns. Never quote the C7 primary without this table.", ""]
    else:
        L += ["## Primary endpoint", "", f"Not available: `{a}` or `{b}` is missing or refused.", ""]
    # epoch-cap sensitivity (AMENDMENTS.md item 11)
    eg, est = epoch_cap_groups(idx, used)
    result["epoch_cap_sensitivity"] = {"status": est}
    L += [f"## Epoch-cap sensitivity (AMENDMENTS.md item 11): every network re-run with a {est['cap']}-epoch cap", "",
          "Same folds, inner split, nested rule and training code; only the cap (and with it the cosine schedule) "
          "changes. Descriptive only; no verdict of its own.", "",
          "Status: " + "; ".join(f"`{s_}` {v['folds_done']}/{v['of']} folds" + (f" (problems: {v['problems'][0]})" if v["problems"] else "")
                                 for s_, v in est["systems"].items()) + (" (no run yet)" if not est["systems"] else ""), ""]
    contrasts = []
    if ("islr1st_retrained", "C7") in eg and ("ours_gru", "C7") in g:
        contrasts.append(("ours_gru (60) minus islr1st_retrained (200)", g[("ours_gru", "C7")], eg[("islr1st_retrained", "C7")]))
    if ("islr1st_retrained", "C7") in eg and ("ours_gru", "C7") in eg:
        contrasts.append(("ours_gru (200) minus islr1st_retrained (200)", eg[("ours_gru", "C7")], eg[("islr1st_retrained", "C7")]))
    if ("islr1st_ourfeat", "C7") in eg and ("ours_gru", "C7") in eg:
        contrasts.append(("ours_gru (200) minus islr1st_ourfeat (200)", eg[("ours_gru", "C7")], eg[("islr1st_ourfeat", "C7")]))
    erows, single = [], []
    for s_ in ("ours_gru", "islr1st_retrained", "islr1st_ourfeat"):
        if (s_, "C7") in eg:
            sm = common.summarize(eg[(s_, "C7")], B=B)
            r8 = eg.get((s_, "R8"), [])
            fa = rate_with_ci([r for r in r8 if r["oov"]], common.accepted, B)
            ws = rate_with_ci([r for r in r8 if not r["oov"]], wrong_spoken, B)
            single.append([f"`{s_}` (cap {est['cap']})", sm["n_signers"], sm["n_clips"], fmt(sm["metrics"]["accuracy"], sm["top1_ci95"]),
                           ci_txt(ws), ci_txt(fa)])
            result["epoch_cap_sensitivity"][s_] = {"C7": sm, "R8_wrong_sign_spoken": ws, "R8_open_set_false_accept": fa}
    if single:
        L += [md_table(single, ["system", "#signers", "#clips", "C7 top-1 [95% CI]", "R8 wrong sign spoken [95% CI]",
                                "R8 open-set false accept [95% CI]"]), ""]
    for name, xa, xb in contrasts:
        ia = [r for r in xa if not r["oov"]]
        ib = [r for r in xb if not r["oov"]]
        pc = common.paired(ia, ib, "top1", B)
        sc = signer_sensitivity(ia, ib)
        rv, cats_c = robust_verdict(pc["ci95"], sc)
        result["epoch_cap_sensitivity"][name] = {**pc, "ci_sensitivity": sc, "verdict_by_interval": cats_c, "reading": rv}
        erows.append([name, pc["n_signers"], pc["n_clips"], diff_txt(pc),
                      f"[{sc['unweighted_signer_mean_t95'][0]:+.3f}, {sc['unweighted_signer_mean_t95'][1]:+.3f}]",
                      f"[{sc['cluster_robust_t95'][0]:+.3f}, {sc['cluster_robust_t95'][1]:+.3f}]",
                      sc["sign_flip_exact_p"], cats_c["pooled signer bootstrap (registered)"]])
    if erows:
        L += [md_table(erows, ["C7 top-1 contrast", "#signers", "#clips", "diff [bootstrap 95% CI]", "per-signer t 95% CI",
                               "cluster-robust t 95% CI", "sign-flip p", "category by the primary rule"]), ""]
        if "primary" in result:
            prim = result["primary"]["verdict_by_interval"]["pooled signer bootstrap (registered)"]
            same = all(result["epoch_cap_sensitivity"][n]["verdict_by_interval"]["pooled signer bootstrap (registered)"] == prim
                       for n, _, _ in contrasts if n.endswith("islr1st_retrained (200)"))
            result["epoch_cap_sensitivity"]["primary_robust_to_cap"] = same
            L += ["**Primary verdict category " + ("unchanged" if same else "NOT robust to the epoch cap: it changes") +
                  " when `islr1st_retrained` is trained with the 200-epoch cap.**", ""]
    elif est["systems"]:
        L += ["No contrast yet: `islr1st_retrained` at the 200-epoch cap has not finished all 10 folds. No partial-fold "
              "number is reported.", ""]
    held = {s: LOSO for s in COMPARED} | {"islr1st_pretrained": PRETRAINED_HELD_OUT}
    for mode in ("C7", "R8"):
        title, test_set = MODE_TEXT[mode]
        comp = {s: common.summarize(g[(s, mode)], B=B) for s in COMPARED if g.get((s, mode))}
        if not comp:
            continue
        for s, v in comp.items():   # AMENDMENTS.md item 13: wrong-sign-spoken with a signer CI everywhere
            v["wrong_sign_spoken_ci95"] = common.boot_ci([r for r in g[(s, mode)] if not r["oov"]],
                                                         lambda rs: float(np.mean([wrong_spoken(r) for r in rs])), B)
        pairs = {}
        for x in ("ours_gru", "ours_baseline"):
            for y in COMPARED:
                if x != y and x in comp and y in comp and not (x == "ours_baseline" and y == "ours_gru"):
                    ia = [r for r in g[(x, mode)] if not r["oov"]]
                    ib = [r for r in g[(y, mode)] if not r["oov"]]
                    pairs[f"{x} - {y}"] = {"top1": common.paired(ia, ib, "top1", B),
                                           "macro_f1": common.paired(ia, ib, "macro_f1", B),
                                           "open_set_false_accept": common.paired(
                                               [r for r in g[(x, mode)] if r["oov"]],
                                               [r for r in g[(y, mode)] if r["oov"]], "false_accept", B)}
        pred_labels = [l for l in (["YES", "NO", "THANK-YOU", "WHERE", "TIME", "PLEASE", "ROOM"] +
                                   (["NONE"] if mode == "R8" else []))]
        cms = {s: confusion(g[(s, mode)], pred_labels[:7], pred_labels) for s in comp}
        priv = {s: common.summarize([r for r in g[(s, mode)] if r["signer"] in PRIVATE6 and not r["oov"]], B=B)
                for s in comp}
        for s, v in priv.items():
            v["wrong_sign_spoken_ci95"] = common.boot_ci([r for r in g[(s, mode)] if r["signer"] in PRIVATE6 and not r["oov"]],
                                                         lambda rs: float(np.mean([wrong_spoken(r) for r in rs])), B)
        result["modes"][mode] = {"title": title, "systems": comp, "paired": pairs, "confusion": cms,
                                 "sensitivity_private6": priv}
        L += [f"## Mode {mode}: {title}", "",
              md_table(comparison_rows(comp, f"{test_set} ({mode})", latency, held_out=held), HEADER), ""]
        L += ["Paired differences on the same clips (A minus B; signer-bootstrap 95% CI and p; exact McNemar p on top-1):", ""]
        prow = []
        for k, v in pairs.items():
            t, f, o = v["top1"], v["macro_f1"], v["open_set_false_accept"]
            pb = f"<{1 / B:.4f}" if t["p_signer_bootstrap"] == 0 else f"{t['p_signer_bootstrap']:.3f}"
            prow.append([k, t["n_signers"], t["n_clips"], f"{t['diff']:+.3f} [{t['ci95'][0]:+.3f}, {t['ci95'][1]:+.3f}] p={pb}",
                         ("<1e-6" if t["p_mcnemar_exact"] < 1e-6 else f"{t['p_mcnemar_exact']:.2g}") +
                         f" ({t['a_only_right']} vs {t['b_only_right']})",
                         f"{f['diff']:+.3f} [{f['ci95'][0]:+.3f}, {f['ci95'][1]:+.3f}]",
                         f"{o['diff']:+.3f} [{o['ci95'][0]:+.3f}, {o['ci95'][1]:+.3f}] (n={o['n_clips']})" if o else "-"])
        L += [md_table(prow, ["A - B", "#signers", "#clips", "top-1 diff [CI] p", "McNemar p (A-only vs B-only right)",
                              "macro-F1 diff [CI]", "false-accept diff [CI] (negative = A refuses more)"]), ""]
        L += ["Per-signer top-1 (every signer was absent from the compared systems' training):", "",
              md_table([[s] + [comp[x]["per_signer_top1"].get(s, {}).get("top1", "-") for x in comp]
                        + [next(iter(comp.values()))["per_signer_top1"].get(s, {}).get("n", "-")] for s in idx["signers"]],
                       ["signer"] + list(comp) + ["#clips"]), ""]
        classes = sorted({c for s in comp.values() for c in s["metrics"]["per_class_recall"]})
        L += ["Per-class recall:", "", md_table([[c] + [comp[x]["metrics"]["per_class_recall"].get(c, "-") for x in comp]
                                                 for c in classes], ["sign"] + list(comp)), ""]
        for s, cm in cms.items():
            L += [f"Confusion matrix, `{s}` ({mode}, {n_sig} signers, {sum(map(sum, (r.values() for r in cm.values())))} clips):", "",
                  confusion_md(cm, pred_labels), ""]
        L += ["Open-set false accept per outside sign:", "",
              md_table([[o] + [comp[x]["open_set_per_sign"].get(o, "-") for x in comp]
                        for o in sorted({k for s in comp.values() for k in s["open_set_per_sign"]})],
                       ["outside sign"] + list(comp)), ""]
        L += [f"Sensitivity (registered in PROTOCOL.md): only the 6 private-leaderboard signers ({', '.join(PRIVATE6)}), whose "
              "clips could not influence the published winner's model selection:", "",
              md_table(comparison_rows(priv, f"{test_set}, private 6 ({mode})", latency, held_out=held), HEADER), ""]
    # reference row, separately
    ref = {}
    for mode in ("C7", "R8"):
        if g.get(("islr1st_pretrained", mode)):
            inv = [r for r in g[("islr1st_pretrained", mode)] if not r["oov"]]
            ref[mode] = {"all10": common.summarize(inv, B=B),
                         "private6": common.summarize([r for r in inv if r["signer"] in PRIVATE6], B=B)}
    mx_path = out / "preds_exploratory" / "islr1st_pretrained_R8maxother_all.jsonl"
    pm = manifest.load(out, "islr1st_pretrained", "all")
    if ref and "R8" in ref and mx_path.exists() and pm and \
            pm.get("outputs", {}).get(f"preds_exploratory/{mx_path.name}") == manifest.sha256_file(mx_path):
        inv = [r for r in common.read_jsonl([mx_path]) if not r["oov"]]
        ref["R8_max_other"] = {"all10": common.summarize(inv, B=B),
                               "private6": common.summarize([r for r in inv if r["signer"] in PRIVATE6], B=B)}
    if ref:
        result["reference_pretrained"] = ref
        result["reference_pretrained_note"] = ("R8 readings: both rules were fixed after alternatives were examined "
                                               "(AMENDMENTS.md item 15); no pretrained R8 figure is cleared")
        rows = []
        for mode, v in ref.items():
            rule = {"C7": "softmax over its 7 shared-sign logits",
                    "R8": "sum rule (NONE = all 243 other signs); rule fixed after alternatives were examined; not cleared",
                    "R8_max_other": "max-other rule (NONE = its best other sign); chosen after seeing results; not cleared"}[mode]
            for subset, s in v.items():
                rows.append([mode, rule, "all 10 signers" if subset == "all10" else "private 6", s["n_signers"],
                             s["n_clips"], fmt(s["metrics"].get("accuracy"), s["top1_ci95"]),
                             fmt(s["metrics"].get("macro_f1"), s["macro_f1_ci95"])])
        L += ["## Reference only: published GISLR 1st-place weights (`islr1st_pretrained`)", "",
              "**Not a fair comparison and not in any paired test or open-set column.** It is a much larger model "
              "(3-seed ensemble) trained on about 94k clips of 250 signs from 21 other participant IDs. None of its "
              "training IDs is a test ID, but that IDs are different people is unverified; 4 of the 10 test signers "
              "(public leaderboard) influenced the winner's model selection; and all 30 outside signs are in its "
              "training vocabulary, so it has no valid open-set number.", "",
              md_table(rows, ["mode", "how its answer is read", "test set", "#signers", "#clips", "top-1 [95% CI]",
                              "macro-F1 [95% CI]"]), ""]
    L += ["## Caveats", "",
          "- All systems read the same GISLR MediaPipe landmarks (phones, unknown fps and aspect ratio); both hands are "
          "detected together in about 1% of frames, which affects every system.",
          "- 10 signers, two of whom (11696, 6927) have no ROOM, THANK-YOU or TIME clips; read the CIs and paired tests.",
          "- Three participants (11672, 2455, 34304) sign with the hand MediaPipe labels left; no test-time mirroring.",
          "- The 30 outside signs came from a hand-written list (no documented selection rule); mom and girl, signed "
          "at the chin like THANK-YOU, fell in the test half of the seed-0 split.",
          "- `islr1st_retrained` is a PyTorch port (checked: 95% top-1 agreement with the published TFLite on 400 "
          "clips), 1 seed, no AWP, CPU, at most 60 epochs on about 1,200 clips.",
          "- Rylo has no measurable sign-to-text (see README), so it has no row.", "", DEFINITIONS]
    if write:
        REPORTS.mkdir(parents=True, exist_ok=True)
        (REPORTS / "track_a_v1.json").write_text(json.dumps(result, indent=1))
        (REPORTS / "track_a_v1.md").write_text("\n".join(L))
        print(f"wrote {REPORTS / 'track_a_v1.md'}" + ("" if ready else "  (INCOMPLETE: refused or missing systems)"))
    return result


# ---------- Track B ----------

def track_b(preds_dir, tag, B=common.B_DEFAULT):
    preds_dir = Path(preds_dir)
    recs = common.read_jsonl(sorted(preds_dir.glob("*.jsonl")))
    by_sys = defaultdict(list)
    for r in recs:
        by_sys[r["system"]].append(r)
    refused = {}
    for s in list(by_sys):
        if s.startswith("ours"):
            mp = preds_dir / f"{s}.manifest.json"
            m = json.loads(mp.read_text()) if mp.exists() else None
            if m is None or m.get("pipeline") != "capture-parity-v1" or \
                    m.get("preds_sha256") != manifest.sha256_file(preds_dir / f"{s}.jsonl"):
                refused[s] = "no capture-parity manifest matching the predictions (re-run track_b_video ours)"
                del by_sys[s]
            elif not m.get("checkpoint", {}).get("pinned") and "smoke" not in tag:
                refused[s] = "checkpoint not pinned in recognition/model_pin.py (freeze and pin the model before testing)"
                del by_sys[s]
            elif "smoke" not in tag and (m.get("allow_precleaned") or m.get("outcomes", {}).get("precleaned")):
                refused[s] = "used pre-cleaned landmark files that bypass the live path (smoke runs only; AMENDMENTS.md item 16)"
                del by_sys[s]
    # Every system is scored on EVERY clip (AMENDMENTS.md item 18): a clip a system did not answer, or has no
    # row for, counts as no answer, i.e. wrong on a sign clip and not spoken on an outside clip. Scoring only the
    # clips all systems answered would reward a product that stays silent when unsure.
    meta = {}
    for r in recs:
        meta.setdefault(r["clip_id"], r)
    all_clips = set(meta)
    summaries, no_answer = {}, {}
    for s, rs in by_sys.items():
        have = {r["clip_id"] for r in rs}
        filled = list(rs) + [common.record(s, c, meta[c]["signer"], meta[c]["true_label"], track="B",
                                           oov=meta[c]["oov"], oov_sign=meta[c].get("oov_sign"), missing_row=True)
                             for c in sorted(all_clips - have)]
        no_answer[s] = round(sum(not r["answered"] for r in filled) / max(1, len(filled)), 4)
        summaries[s] = common.summarize(filled, B=B) if filled else None
    answered = {s: {r["clip_id"] for r in rs if r["answered"]} for s, rs in by_sys.items()}
    common_clips = set.intersection(*answered.values()) if answered else set()
    smoke = "smoke" in tag
    L = [f"# Track B: our 22 classes, same video clips for every system ({tag})", ""]
    if smoke:
        L += ["> **PLUMBING SMOKE TEST.** Generated clips with no real signing. These numbers mean nothing about "
              "accuracy. Track B status: **awaiting real held-out recordings**; no Track B result exists.", ""]
    else:
        L += ["> Valid only if the clips follow the recording protocol in README.md (held-out signers, consent, demo "
              "setup, model frozen before recording). Our models run the capture-parity path: per frame "
              "FrameAdapter(mode=\"capture\", image_size), framing gate, capture.clean.clean, Recognizer.predict.", ""]
    if refused:
        L += ["Refused: " + "; ".join(f"`{s}`: {why}" for s, why in refused.items()), ""]
    L += [f"{len(all_clips)} clips in total; every system is scored on all of them, and a clip without an answer "
          f"counts as wrong ({len(common_clips)} clips were answered by every system). No-answer rate per system: "
          + ", ".join(f"`{s}` {v}" for s, v in no_answer.items()), ""]
    rows = comparison_rows({s: v for s, v in summaries.items() if v}, f"team clips ({tag})", track="B",
                           held_out={s: "per recording protocol" for s in summaries})
    L += [md_table(rows, HEADER), "", DEFINITIONS]
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / f"track_b_{tag}.md").write_text("\n".join(L))
    (REPORTS / f"track_b_{tag}.json").write_text(json.dumps({"tag": tag, "no_answer_rate": no_answer, "refused": refused,
                                                              "n_common_clips": len(common_clips),
                                                              "systems": summaries}, indent=1))
    print(f"wrote {REPORTS / f'track_b_{tag}.md'}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", choices=["a", "b"], required=True)
    ap.add_argument("--run-dir", default=None, help="Track A run folder (default data/compare/track_a_v1)")
    ap.add_argument("--preds", default=str(ROOT / "data/compare/track_b/preds"))
    ap.add_argument("--tag", default="team")
    ap.add_argument("--bootstrap", type=int, default=common.B_DEFAULT)
    a = ap.parse_args(argv)
    if a.track == "a":
        track_a(a.run_dir, a.bootstrap)
    else:
        track_b(a.preds, a.tag, a.bootstrap)


if __name__ == "__main__":
    main()

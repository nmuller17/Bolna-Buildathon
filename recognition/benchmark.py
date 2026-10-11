"""Benchmark the classifier: leave-one-signer-out CV (SignGRU vs a non-deep baseline) and latency.

    python -m recognition.benchmark --data data/train --tag team
    python -m recognition.benchmark --checkpoint recognition/models/model.pt --test-data data/heldout --tag heldout

If the baseline beats the GRU on real data, train and serve it instead: python -m recognition.train --model baseline.
Choose between them only on real captures: the synthetic data is far easier than real signs.

Writes recognition/reports/benchmark_<tag>.json, benchmark_<tag>.md and confusion_<tag>_<model>.csv.
Leave-one-signer-out trains on all signers but one and tests on the one left out, so the
numbers estimate performance for a person the model has never seen.
"""
import argparse
import json
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from recognition import features
from recognition.data import load_dataset, load_with_extra, to_arrays
from recognition.labels import CLASSES, INDEX
from recognition.model import Predictor, save_checkpoint, softmax
from recognition.train import split, train_baseline, train_model

THRESHOLD = 0.6
REPORTS = Path(__file__).parent / "reports"
NONE_I = INDEX["NONE"]


def spoken_wrong(probs, y, threshold=THRESHOLD):
    """Share of takes where P4's rule (conf >= threshold and not NONE) accepts a wrong label."""
    pred, conf = probs.argmax(1), probs.max(1)
    return round(float(((conf >= threshold) & (pred != NONE_I) & (pred != y)).mean()), 4) if len(y) else None


def metrics(probs, y, threshold=THRESHOLD):
    """All benchmark metrics for probs [N, C] against integer labels y [N]."""
    C = len(CLASSES)
    pred = probs.argmax(1)
    conf = probs.max(1)
    top3 = np.argsort(-probs, 1)[:, :3]
    cm = np.zeros((C, C), dtype=int)
    np.add.at(cm, (y, pred), 1)
    present = [c for c in range(C) if cm[c].sum() > 0]
    recall, f1 = {}, []
    for c in present:
        tp = cm[c, c]
        rec = tp / cm[c].sum()
        prec = tp / cm[:, c].sum() if cm[:, c].sum() else 0.0
        recall[CLASSES[c]] = round(float(rec), 4)
        f1.append(0.0 if prec + rec == 0 else 2 * prec * rec / (prec + rec))
    sign = y != NONE_I
    accepted = conf >= threshold
    spoken = accepted & (pred != NONE_I)
    bins = np.minimum((conf * 10).astype(int), 9)
    ece = sum(abs((pred[bins == b] == y[bins == b]).mean() - conf[bins == b].mean()) * (bins == b).mean()
              for b in range(10) if (bins == b).any())
    return {
        "n": int(len(y)),
        "accuracy": round(float((pred == y).mean()), 4),
        "top3_accuracy": round(float((top3 == y[:, None]).any(1).mean()), 4),
        "macro_f1": round(float(np.mean(f1)), 4) if f1 else None,
        "none_false_accept_rate": round(float((pred[sign] == NONE_I).mean()), 4) if sign.any() else None,
        "none_false_alarm_rate": round(float((pred[~sign] != NONE_I).mean()), 4) if (~sign).any() else None,
        "coverage_at_threshold": round(float(accepted.mean()), 4),
        "accuracy_on_accepted": round(float((pred[accepted] == y[accepted]).mean()), 4) if accepted.any() else None,
        "wrong_sign_spoken_rate": round(float((spoken & (pred != y)).mean()), 4),
        "ece": round(float(ece), 4),
        "per_class_recall": recall,
        "confusion": cm.tolist(),
    }


def folds(labels, signers, seed, k=5):
    uniq = sorted(set(signers))
    if len(uniq) >= 2:
        s = np.asarray(signers)
        return [(f"signer:{u}", np.flatnonzero(s != u), np.flatnonzero(s == u)) for u in uniq]
    print(f"WARNING: one signer only; using stratified {k}-fold CV. Test takes come from the same person "
          "as training, so this overestimates accuracy on a new guest.", file=sys.stderr)
    rng = np.random.default_rng(seed)
    assign = np.zeros(len(labels), int)
    for c in np.unique(labels):
        idx = rng.permutation(np.flatnonzero(labels == c))
        assign[idx] = np.arange(len(idx)) % k
    return [(f"fold:{f}", np.flatnonzero(assign != f), np.flatnonzero(assign == f)) for f in range(k)]


def cross_validate(seqs, labels, signers, epochs, seed, refit=True, n_primary=None, log=print):
    """Out-of-fold probabilities for GRU and baseline on the first n_primary takes, per-fold info, last GRU.

    Takes after n_primary (extra data) are added to every training fold and never tested on.
    """
    n_primary = len(labels) if n_primary is None else n_primary
    extra = np.arange(n_primary, len(labels))
    P = {"gru": np.zeros((n_primary, len(CLASSES))), "baseline": np.zeros((n_primary, len(CLASSES)))}
    P1 = {k: np.zeros_like(v) for k, v in P.items()}  # same models at temperature 1
    info, last = [], None
    signers = np.asarray(signers)
    for name, tr, te in folds(labels[:n_primary], signers[:n_primary], seed):
        t0 = time.time()
        itr, iva, how = split(labels[tr], signers[tr], seed=seed)
        itr, iva = np.concatenate([tr[itr], extra]).astype(int), tr[iva]
        tr = np.concatenate([tr, extra]).astype(int)
        model, temp, fi = train_model(seqs, labels, itr, iva, epochs=epochs, seed=seed, log=lambda m: None)
        if refit:
            model, _, _ = train_model(seqs, labels, tr, np.array([], int), epochs=fi["best_epoch"], seed=seed,
                                      log=lambda m: None)
        Xte = torch.from_numpy(to_arrays([seqs[i] for i in te]))
        with torch.inference_mode():
            lg = model(Xte).numpy()
        P["gru"][te], P1["gru"][te] = softmax(lg, temp), softmax(lg)
        b, btemp, _ = train_baseline(seqs, labels, itr, iva, seed)
        if refit:
            b, _, _ = train_baseline(seqs, labels, tr, np.array([], int), seed)
        lb = b.logits(Xte.numpy())
        P["baseline"][te], P1["baseline"][te] = softmax(lb, btemp), softmax(lb)
        acc = {k: round(float((P[k][te].argmax(1) == labels[te]).mean()), 4) for k in P}
        info.append({"fold": name, "n_test": int(len(te)), "inner_val": how, "best_epoch": fi["best_epoch"],
                     "temperature": round(temp, 3), "temperature_baseline": round(btemp, 3),
                     "acc_gru": acc["gru"], "acc_baseline": acc["baseline"],
                     "seconds": round(time.time() - t0, 1)})
        log(f"{name}: gru {acc['gru']:.3f}  baseline {acc['baseline']:.3f}  "
            f"(best epoch {fi['best_epoch']}, T={temp:.2f}, {time.time() - t0:.0f}s)")
        last = (model, temp)
    return P, P1, info, last


def open_set(seqs, labels, signers, seed, n_primary=None, log=print):
    """Unknown-sign test (baseline only, temperature 1): for every held-out signer and every sign c,
    train without any takes of c and score the held-out signer's takes of c. Returns, per sign, the
    share that would be spoken as some other sign (conf >= 0.6, not NONE), and their mean.
    """
    n_primary = len(labels) if n_primary is None else n_primary
    extra = np.arange(n_primary, len(labels))
    hits = {c: [] for c in range(len(CLASSES)) if c != NONE_I}
    signers = np.asarray(signers)
    for name, tr, te in folds(labels[:n_primary], signers[:n_primary], seed):
        tr = np.concatenate([tr, extra]).astype(int)
        for c in hits:
            te_c = te[labels[te] == c]
            if not len(te_c):
                continue
            b, _, _ = train_baseline(seqs, labels, tr[labels[tr] != c], np.array([], int), seed)
            p = softmax(b.logits(to_arrays([seqs[i] for i in te_c])))
            hits[c] += ((p.max(1) >= THRESHOLD) & (p.argmax(1) != NONE_I)).tolist()
        log(f"open-set {name} done")
    rate = {CLASSES[c]: round(float(np.mean(h)), 4) for c, h in hits.items() if h}
    return {"unknown_sign_spoken_rate": round(float(np.mean(list(rate.values()))), 4) if rate else None,
            "per_sign": rate}


def pct(a):
    return {"p50_ms": round(float(np.percentile(a, 50)), 2), "p95_ms": round(float(np.percentile(a, 95)), 2)}


def latency(checkpoint, frames, n=200):
    from fastapi.testclient import TestClient
    from recognition.server import create_app
    torch.set_num_threads(2)  # same as the server
    pred = Predictor(checkpoint)
    fwd = pred.time_forward(frames, n)
    client = TestClient(create_app(model_path=checkpoint, mock=False, token=None), base_url="http://localhost",
                        client=("127.0.0.1", 50000))
    body = {"frames": frames}
    for _ in range(5):
        client.post("/predict", json=body)
    http = []
    for _ in range(n // 2):
        t0 = time.perf_counter()
        r = client.post("/predict", json=body)
        http.append((time.perf_counter() - t0) * 1000)
        assert r.status_code == 200, r.text
    return {"segment_frames": len(frames), "torch_threads": torch.get_num_threads(),
            "model_forward": pct(fwd), "http_predict_testclient": pct(http)}


DEFINITIONS = """\
## What each number means

- **accuracy**: share of test takes whose top prediction is the true sign. 1.0 is perfect; guessing gives 1/22 = 0.045.
- **top-3 accuracy**: share of test takes where the true sign is among the three labels /predict returns.
- **macro-F1**: for each sign, F1 combines precision (when the model says this sign, how often is it right) and recall (how many takes of this sign it finds); the 22 values are averaged with equal weight, so a model that ignores a hard sign is penalised. Higher is better.
- **per-class recall**: for each sign, the share of its takes recognised correctly. Look here for the signs that need more or cleaner captures.
- **confusion matrix**: counts of (true sign = row, predicted sign = column). Off-diagonal cells show which signs get mixed up.
- **NONE false-accept rate**: among takes of real signs, the share predicted as NONE. In the demo this triggers "Could you repeat?". Annoying but safe; lower is better.
- **NONE false-alarm rate**: among NONE takes (idle hands, scratching), the share predicted as a sign. Lower is better.
- **coverage at 0.6**: share of takes whose top confidence is at least 0.6, i.e. P4 would accept the answer instead of asking to repeat.
- **accuracy on accepted**: among those accepted takes, the share that are correct. Should be well above plain accuracy if confidence is meaningful.
- **wrong sign spoken rate**: share of all takes where P4's rule (conf >= 0.6 and not NONE) accepts a WRONG sign, so the system would say something the guest did not sign. This is the most damaging demo failure; lower is better.
- **wrong sign spoken at T=1**: the same rate with the temperature left at 1, to show what the fitted temperature changes. Because the temperature may only soften (T >= 1), the main rate is never higher than this one.
- **unknown sign spoken rate** (open-set, baseline only): for each sign, the model is trained WITHOUT that sign and then shown the held-out signer doing it; this is the share it would still speak as some other sign. It estimates what happens when a guest signs something outside the 21 words. Lower is better; it is usually high, because a closed-set classifier has no idea what it has not seen.
- **ECE (expected calibration error)**: takes are grouped by confidence (0-0.1, ..., 0.9-1); in each group the gap between average confidence and actual accuracy is measured and averaged (weighted by group size). 0 means "conf 0.8 is right 80% of the time"; above about 0.1 the 0.6 threshold is not trustworthy.
"""


def md_table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def write_reports(tag, result, synthetic):
    REPORTS.mkdir(parents=True, exist_ok=True)
    with open(REPORTS / f"benchmark_{tag}.json", "w") as f:
        json.dump(result, f, indent=1)
    for name, m in result["models"].items():
        with open(REPORTS / f"confusion_{tag}_{name}.csv", "w") as f:
            f.write("true\\pred," + ",".join(CLASSES) + "\n")
            for c, row in zip(CLASSES, m["confusion"]):
                f.write(c + "," + ",".join(map(str, row)) + "\n")
    names = list(result["models"])
    L = [f"# Recognition benchmark: {tag}", ""]
    if synthetic:
        L += ["> **SYNTHETIC DATA.** These numbers only show that the training and evaluation code run and learn "
              "on made-up trajectories. They are not a measure of how well real ASL signs are recognised. The "
              "synthetic signs are much easier to tell apart than real ones (each has its own location), so do not "
              "choose between the GRU and the baseline from this report.", ""]
    L += [f"Created {result['created']}. Mode: {result['mode']}. Data: {', '.join(result['data'])}.",
          f"{result['n_samples']} takes, {len(result['signers'])} signers ({', '.join(result['signers'])}).", ""]
    if result["mode"] == "cross-validation":
        L += ["Evaluation: each signer is held out in turn; the models are trained on the other signers "
              "(early stopping and temperature on one inner held-out signer, then refit on all training signers) "
              "and tested on the held-out signer. Predictions from all folds are pooled. Team members seen in "
              "training will usually score higher than this in the live demo; a new guest will score about this.", ""]
    rows = []
    keys = ["accuracy", "top3_accuracy", "macro_f1", "none_false_accept_rate", "none_false_alarm_rate",
            "coverage_at_threshold", "accuracy_on_accepted", "wrong_sign_spoken_rate", "wrong_sign_spoken_rate_T1", "ece"]
    for k in keys:
        rows.append([k] + [result["models"][n].get(k, "-") for n in names])
    L += ["## Summary", "", md_table(rows, ["metric"] + names), ""]
    if result.get("open_set"):
        o = result["open_set"]
        L += ["## Unknown signs (open-set, baseline)", "",
              f"Mean share of out-of-vocabulary takes spoken as a wrong sign: **{o['unknown_sign_spoken_rate']}**. "
              "Per sign (trained without it):", "",
              md_table([[c, v] for c, v in o["per_sign"].items()], ["sign left out", "spoken as another sign"]), ""]
    if result.get("folds"):
        L += ["## Per fold", "", md_table([[f["fold"], f["n_test"], f["acc_gru"], f["acc_baseline"], f["best_epoch"],
                                              f["temperature"], f.get("temperature_baseline", "-")] for f in result["folds"]],
                                            ["fold", "test takes", "gru acc", "baseline acc", "best epoch",
                                             "gru temperature", "baseline temperature"]), ""]
    L += ["## Per-class recall", "",
          md_table([[c] + [result["models"][n]["per_class_recall"].get(c, "-") for n in names] for c in CLASSES],
                   ["sign"] + names), ""]
    cm = result["models"][names[0]]["confusion"]
    short = [c[:5] for c in CLASSES]
    L += [f"## Confusion matrix ({names[0]}, rows = true, columns = predicted)", "",
          md_table([[c] + [v if v else "." for v in row] for c, row in zip(CLASSES, cm)], ["true"] + short), ""]
    if result.get("latency"):
        lat = result["latency"]
        L += ["## Latency", "",
              f"One segment of {lat['segment_frames']} frames on CPU ({lat['torch_threads']} torch threads). "
              "HTTP is measured in-process with FastAPI TestClient (includes JSON parsing, validation, "
              "features and model; excludes the real network).", "",
              md_table([["model forward", lat["model_forward"]["p50_ms"], lat["model_forward"]["p95_ms"]],
                        ["POST /predict", lat["http_predict_testclient"]["p50_ms"], lat["http_predict_testclient"]["p95_ms"]]],
                       ["step", "p50 ms", "p95 ms"]), ""]
    L += [DEFINITIONS]
    (REPORTS / f"benchmark_{tag}.md").write_text("\n".join(L))


def typical_segment(seqs):
    lengths = [features.seq_len(s) for s in seqs]
    i = int(np.argsort(lengths)[len(lengths) // 2])
    return features.seq_to_frames(seqs[i], ndigits=4)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/train")
    ap.add_argument("--extra-data", nargs="*", default=[])
    ap.add_argument("--tag", required=True)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-refit", action="store_true", help="skip the refit on all training signers in each fold")
    ap.add_argument("--checkpoint", help="evaluate this saved model on --test-data instead of cross-validating")
    ap.add_argument("--test-data")
    ap.add_argument("--no-latency", action="store_true")
    ap.add_argument("--no-open-set", action="store_true", help="skip the unknown-sign test (baseline, one fit per sign per signer)")
    args = ap.parse_args(argv)
    torch.set_num_threads(min(8, torch.get_num_threads()))

    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if args.checkpoint:
        if not args.test_data:
            sys.exit("--checkpoint needs --test-data")
        roots = [args.test_data]
        seqs, labels, signers, _ = load_dataset(roots)
        pred = Predictor(args.checkpoint)
        if pred.kind == "ffislr":  # its own face-free input (seqs are normalised: face dropped, pose 1-10 := nose)
            from recognition import ffislr
            lg = ffislr.logits(pred.model, [ffislr.seq_to_raw(ffislr.minimise(s)) for s in seqs])
        else:
            X = torch.from_numpy(to_arrays(seqs, pred.T))
            with torch.inference_mode():
                lg = pred.model(X).numpy()
        m = metrics(softmax(lg, pred.temperature), labels)
        m["wrong_sign_spoken_rate_T1"] = spoken_wrong(softmax(lg), labels)
        models = {pred.ck["kind"]: m}
        result = {"mode": f"checkpoint {args.checkpoint}", "folds": None}
        ckpt = args.checkpoint
    else:
        roots = [args.data] + list(args.extra_data)
        seqs, labels, signers, n_primary = load_with_extra(args.data, args.extra_data)
        P, P1, info, (model, temp) = cross_validate(seqs, labels, signers, args.epochs, args.seed,
                                                    refit=not args.no_refit, n_primary=n_primary)
        models = {k: metrics(v, labels[:n_primary]) for k, v in P.items()}
        for k in models:
            models[k]["wrong_sign_spoken_rate_T1"] = spoken_wrong(P1[k], labels[:n_primary])
        result = {"mode": "cross-validation", "folds": info}
        if not args.no_open_set:
            result["open_set"] = open_set(seqs, labels, signers, args.seed, n_primary)
        seqs, signers = seqs[:n_primary], signers[:n_primary]
        ckpt = Path(tempfile.mkdtemp()) / "last_fold.pt"
        save_checkpoint(ckpt, model, temp, meta={"note": "last CV fold, latency only"})
    result.update(created=created, data=[str(r) for r in roots], n_samples=len(seqs),
                  signers=sorted(set(signers)), threshold=THRESHOLD, models=models)
    if not args.no_latency:
        result["latency"] = latency(str(ckpt), typical_segment(seqs))
    synthetic = "synthetic" in args.tag.lower() or any("synthetic" in str(r).lower() for r in roots)
    result["synthetic"] = synthetic
    write_reports(args.tag, result, synthetic)
    for n, m in models.items():
        print(f"{n:9s} acc {m['accuracy']:.3f}  top3 {m['top3_accuracy']:.3f}  macroF1 {m['macro_f1']}  "
              f"coverage {m['coverage_at_threshold']:.3f}  acc@accepted {m['accuracy_on_accepted']}  ece {m['ece']:.3f}")
        print(f"{'':9s} wrong sign spoken {m['wrong_sign_spoken_rate']}  (at T=1: {m['wrong_sign_spoken_rate_T1']})")
    if result.get("open_set"):
        print(f"open-set (baseline): unknown sign spoken rate {result['open_set']['unknown_sign_spoken_rate']}")
    if result.get("latency"):
        print("latency", json.dumps(result["latency"]))
    print(f"wrote {REPORTS / f'benchmark_{args.tag}.md'}")


if __name__ == "__main__":
    main()

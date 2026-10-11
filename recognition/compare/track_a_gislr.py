"""Track A: Deaf signers, 7 shared classes, leave-one-participant-out, every system on the same clips.
The rules are pre-registered in recognition/compare/PROTOCOL.md; read it before running anything.

    python -m recognition.compare.track_a_gislr index                  # clip index (checked against PROTOCOL.md)
    python -m recognition.compare.track_a_gislr run --workers 5        # all protocol jobs (resumable) + pretrained
    python -m recognition.compare.track_a_gislr latency                # separately, on an idle machine
    python -m recognition.compare.report --track a                    # refuses results without a manifest

Outputs go to data/compare/track_a_v1/ (override with --out). The earlier exploratory runs stay in
data/compare/track_a/ (LEGACY_OUT); they have no manifests and the protocol report refuses them.

Test set: the GISLR rerun set (Kaggle sohier/461054610546105, the competition's hidden test set;
CC0 per Kaggle's metadata), converted to data/gislr (7 signs shared with our vocabulary: YES NO
THANK-YOU WHERE TIME PLEASE ROOM) and data/gislr_oov (30 other GISLR signs, 15 clips each, used
only as out-of-vocabulary negatives). 10 Deaf participants. Every system is trained on 9
participants and tested on the 10th, for all 10 (identical folds).

One model per (system, fold), trained on 7 signs + NONE (NONE = 15 out-of-vocabulary signs,
NONE_TRAIN, from the 9 training participants). Every trained system sees exactly the same
training clips and the same inner split (one training signer held out by recognition.train.split
with seed 0). Scored two ways on the same held-out clips:
  R8  the 8-way answer (7 signs or NONE): the product setting.
  C7  the distribution renormalised over the 7 signs only (forced choice).
Open-set test: the held-out participant's clips of the OTHER 15 outside signs (NONE_TEST), never
seen by any compared system. Open-set false accept = share of those clips the product rule
(top-1 conf >= 0.6 and not NONE) would speak as one of our signs.

Systems:
  ours_gru            recognition.train.train_model (SignGRU): early stopping on the inner signer's
                      validation loss (max 60 epochs, patience 12), temperature on the inner signer,
                      then a refit on all 9 training signers for the chosen number of epochs.
  ours_baseline       recognition.train.train_baseline (logistic regression), temperature on the inner signer.
  islr1st_ourfeat     GISLR 1st-place NETWORK on OUR features with OUR training procedure (same rule).
  islr1st_retrained   GISLR 1st-place network + ITS OWN preprocessing and recipe (compare/islr1st.py),
                      trained from scratch on the same folds with the same nested rule (no global pilot).
  islr1st_pretrained  REFERENCE ONLY: the published 1st-place TFLite weights, not retrained (21 other
                      training participant IDs, ~94k clips, 250 signs incl. all 30 outside signs). Excluded
                      from every outside-vocabulary comparison and every paired test.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import torch

from recognition import features
from recognition import train as rtrain
from recognition.compare import common, islr1st, manifest
from recognition.data import load_file, to_arrays
from recognition.labels import CLASSES, INDEX, NONE
from recognition.model import Baseline, SignGRU, fit_temperature, softmax

ROOT = Path(__file__).resolve().parents[2]
GISLR = ROOT / "data/gislr"
GISLR_OOV = ROOT / "data/gislr_oov"
GISLR_RAW = ROOT / "data/gislr_raw/test_landmark_files"
LEGACY_OUT = ROOT / "data/compare/track_a"          # exploratory runs, no manifests
OUT = ROOT / "data/compare/track_a_v1"              # protocol runs (main() may override with --out)
EXT = ROOT / "data/compare/ext/islr1st_hf"
BENCH_PY = Path.home() / ".venvs/signbridge-bench/bin/python"
TFLITE_SHA256 = "f55a2bb1ebe6d1e912a98e31c6ef3f995c9ae261f408fe115f2008099d3f0bb7"
# Canonical fingerprint of the clip index (manifest.index_fingerprint), recorded in PROTOCOL.md.
INDEX_SHA256 = "8626d72cf79d5bc86b7b5bc0ae47f30159333ce0523f3fa3824f2228e6039aca"

SIGNS7 = ["YES", "NO", "THANK-YOU", "WHERE", "TIME", "PLEASE", "ROOM"]
MODES = {"C7": SIGNS7, "R8": SIGNS7 + [NONE]}
SYSTEMS = ["ours_gru", "ours_baseline", "islr1st_ourfeat", "islr1st_retrained", "islr1st_pretrained"]
TRAINED = SYSTEMS[:4]
# Kaggle "Usage" column of the rerun labels: public-leaderboard signers could influence the
# winner's model selection; the private six could not (sensitivity analysis in PROTOCOL.md).
PUBLIC4 = ["6927", "11696", "14938", "23662"]
PRIVATE6 = ["2455", "11672", "15662", "32536", "34304", "48118"]
EPOCHS_MAX = 60           # pre-registered upper bound for every network (same as recognition.benchmark)
PATIENCE = 12             # recognition.train.train_model default
TUNING_RULE = "inner_val_loss_patience_12"
SEED = 0
THREADS = 2
MAX_WORKERS = 6


# ---------- clip index ----------

def build_index(out=None):
    """All clips with signer, label, OOV flag and paths; OOV signs split 15/15 with a fixed seed."""
    out = Path(out or OUT)
    clips = []
    for root, oov in ((GISLR, False), (GISLR_OOV, True)):
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            for f in sorted(d.glob("*.json")):
                pid, seq = f.stem[len("gislr"):].rsplit("_", 1)
                clips.append({"clip_id": f"{pid}_{seq}", "signer": pid, "label": NONE if oov else d.name,
                              "oov": oov, "gislr_sign": d.name if oov else None, "json": str(f.relative_to(ROOT)),
                              "raw": str((GISLR_RAW / pid / f"{seq}.parquet").relative_to(ROOT))})
    oov_signs = sorted({c["gislr_sign"] for c in clips if c["oov"]})
    perm = np.random.default_rng(SEED).permutation(len(oov_signs))
    none_train = sorted(oov_signs[i] for i in perm[:len(perm) // 2])
    none_test = sorted(oov_signs[i] for i in perm[len(perm) // 2:])
    idx = {"clips": clips, "signers": sorted({c["signer"] for c in clips}, key=int),
           "none_train_signs": none_train, "none_test_signs": none_test}
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.json").write_text(json.dumps(idx, indent=0))
    return idx


def load_index(out=None, verify=True):
    p = Path(out or OUT) / "index.json"
    idx = json.loads(p.read_text()) if p.exists() else build_index(out)
    if verify and manifest.index_fingerprint(idx) != INDEX_SHA256:
        sys.exit(f"{p}: clip index fingerprint {manifest.index_fingerprint(idx)} differs from the pre-registered "
                 f"{INDEX_SHA256} (PROTOCOL.md); refusing to run on a different test set")
    return idx


def fold_sets(idx, fold):
    nt = set(idx["none_train_signs"])
    tr = [c for c in idx["clips"] if c["signer"] != fold and (not c["oov"] or c["gislr_sign"] in nt)]
    te = [c for c in idx["clips"] if c["signer"] == fold and not c["oov"]]
    te_oov = [c for c in idx["clips"] if c["signer"] == fold and c["oov"] and c["gislr_sign"] not in nt]
    return tr, te, te_oov


def inner_split(tr):
    """The ONE inner split every trained system uses: recognition.train.split over the training
    signers only (seed 0). The outer test signer is not in `tr`, so it can never be chosen."""
    signers = np.array([c["signer"] for c in tr])
    labels = np.array([INDEX[c["label"]] for c in tr])
    return rtrain.split(labels, signers, seed=SEED)


def restrict(p22, labels):
    q = np.array([p22[INDEX[l]] for l in labels])
    return q / q.sum()


def restrict_to(p, labels, sub):
    q = np.array([p[labels.index(l)] for l in sub])
    return q / q.sum()


# ---------- jobs ----------

def _ours_like(system, tr, te_all, itr, iva, epochs_max, log):
    """Train with recognition.train exactly as recognition.benchmark.cross_validate does for one fold."""
    seqs = [features.normalize(load_file(ROOT / c["json"]))[0] for c in tr + te_all]
    labels = np.array([INDEX[c["label"]] for c in tr + te_all], dtype=np.int64)
    ntr = len(tr)
    trn = np.arange(ntr)
    if system == "ours_baseline":
        _, temp, _ = rtrain.train_baseline(seqs, labels, itr, iva, SEED)
        model, _, _ = rtrain.train_baseline(seqs, labels, trn, np.array([], int), SEED)
        info = {"temperature": temp}
    else:
        orig = rtrain.SignGRU
        if system == "islr1st_ourfeat":
            n_now = {"n": ntr}
            rtrain.SignGRU = lambda: islr1st.ISLR1stOnOurFeatures(
                features.FEATURE_DIM, len(CLASSES), late_dropout_start=15 * math.ceil(n_now["n"] / 64))
            n_now["n"] = len(itr)
        try:
            _, temp, fi = rtrain.train_model(seqs, labels, itr, iva, epochs=epochs_max, seed=SEED,
                                             patience=PATIENCE, log=log)
            if system == "islr1st_ourfeat":
                n_now["n"] = ntr
            model, _, _ = rtrain.train_model(seqs, labels, trn, np.array([], int), epochs=fi["best_epoch"],
                                             seed=SEED, log=lambda m: None)
        finally:
            rtrain.SignGRU = orig
        info = {"temperature": temp, "best_epoch": fi["best_epoch"], "epochs_run": fi["epochs_run"],
                "inner_val_acc": fi.get("val_acc"), "inner_best_val_loss": fi.get("best_val_loss")}
    X = to_arrays(seqs[ntr:])
    with torch.inference_mode():
        lg = model(torch.from_numpy(X)).numpy()
    return model, temp, softmax(lg, temp), info


def _retrained(tr, te_all, itr, iva, epochs_max, labels, log):
    """The winner's own recipe with the same nested rule as ours: inner fit with early stopping on the
    inner signer, temperature on the inner signer, refit on all 9 training signers for best_epoch."""
    Xtr = [islr1st.load_raw(ROOT / c["raw"]) for c in tr]
    ytr = np.array([labels.index(c["label"]) for c in tr])
    inner, fi = islr1st.train_own_recipe([Xtr[i] for i in itr], ytr[itr], len(labels), epochs_max, seed=SEED,
                                         val=([Xtr[i] for i in iva], ytr[iva]), patience=PATIENCE, log=log)
    temp = fit_temperature(islr1st.predict_logits(inner, [Xtr[i] for i in iva]), ytr[iva])
    model, _ = islr1st.train_own_recipe(Xtr, ytr, len(labels), fi["best_epoch"], seed=SEED, log=log)
    lg = islr1st.predict_logits(model, [islr1st.load_raw(ROOT / c["raw"]) for c in te_all])
    info = {"temperature": round(temp, 4), "best_epoch": fi["best_epoch"], "epochs_run": fi["epochs_run"],
            "inner_best_val_loss": fi.get("best_val_loss"), "inner_val_curve": fi["val_curve"]}
    return model, temp, softmax(lg, temp), info


def run_job(system, fold, smoke=False, log=print):
    torch.set_num_threads(THREADS)
    started, load0, t0 = manifest.now(), manifest.host_load(), time.time()
    code0 = manifest.code_hashes()  # hashed at job START (the code this process imports); end hash recorded too
    out = Path(OUT)
    idx = load_index(out, verify=not smoke)
    labels = MODES["R8"]
    tr, te, te_oov = fold_sets(idx, fold)
    te_all = te + te_oov
    itr, iva, how = inner_split(tr)
    epochs_max = 2 if smoke else EPOCHS_MAX
    if system == "islr1st_retrained":
        model, temp, P, info = _retrained(tr, te_all, itr, iva, epochs_max, labels, log)
        p22 = None
    else:
        model, temp, P22, info = _ours_like(system, tr, te_all, itr, iva, epochs_max, log)
        P = np.stack([restrict(p, labels) for p in P22])
        p22 = P22
    log(f"{system} fold {fold}: inner {how}, {json.dumps({k: v for k, v in info.items() if k != 'inner_val_curve'})}")
    outputs = {}
    for mode, mlabels in MODES.items():
        recs = []
        for i, c in enumerate(te_all):
            extra = {"track": "A", "mode": mode, "fold": fold, "oov": c["oov"], "oov_sign": c["gislr_sign"]}
            if p22 is not None:  # what the real 22-way head says without restricting to this test's labels
                extra["pred22"] = CLASSES[int(np.argmax(p22[i]))]
            recs.append(common.record(system, c["clip_id"], c["signer"], c["label"], mlabels,
                                      restrict_to(P[i], labels, mlabels), **extra))
        path = out / "preds" / f"{system}_{mode}_{fold}.jsonl"
        common.write_jsonl(path, recs)
        outputs[f"preds/{path.name}"] = manifest.sha256_file(path)
        log(f"{system} {mode} fold {fold}: train {len(tr)}, test {len(te)} + {len(te_oov)} OOV, "
            f"top1 {np.mean([r['top3'][0]['label'] == r['true_label'] for r in recs if not r['oov']]):.3f}")
    mpath = out / "models" / f"{system}_{fold}.pt"
    mpath.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"system": system, "fold": fold, "state_dict": model.state_dict(), "temperature": temp,
                "n_classes": len(labels), "info": info, "n_train": len(tr), "seconds": round(time.time() - t0, 1)},
               mpath)
    outputs[f"models/{mpath.name}"] = manifest.sha256_file(mpath)
    inner_tr, inner_va = [tr[i] for i in itr], [tr[i] for i in iva]
    tuning = ({"rule": "none (logistic regression has no epochs)", "temperature": round(float(temp), 4),
               "temperature_rule": "recognition.model.fit_temperature on the inner validation signer (T >= 1)"}
              if system == "ours_baseline" else
              {"rule": TUNING_RULE, "epochs_max": epochs_max, "patience": PATIENCE,
               "best_epoch": info["best_epoch"], "epochs_run": info["epochs_run"], "refit_epochs": info["best_epoch"],
               "temperature": round(float(temp), 4),
               "temperature_rule": "recognition.model.fit_temperature on the inner validation signer (T >= 1)",
               "inner_val_curve": info.get("inner_val_curve")})
    m = {"schema": manifest.SCHEMA, "smoke": bool(smoke), "protocol_sha256": manifest.protocol_sha256(),
         "system": system, "fold": fold, "index_sha256": manifest.index_fingerprint(idx),
         "git": manifest.git_info(), "code_sha256": code0, "code_sha256_end": manifest.code_hashes(),
         "versions": manifest.versions(), "seed": SEED, "torch_threads": THREADS,
         "data": manifest.fold_data(tr, te, te_oov),
         "label_counts": {"train": manifest.label_counts(tr), "inner_train": manifest.label_counts(inner_tr),
                          "inner_val": manifest.label_counts(inner_va), "test": manifest.label_counts(te),
                          "test_oov_signs": dict(sorted(Counter(c["gislr_sign"] for c in te_oov).items()))},
         "inner": {"how": how, "train_signers": sorted({c["signer"] for c in inner_tr}, key=int),
                   "val_signers": sorted({c["signer"] for c in inner_va}, key=int),
                   "train_clips_sha256": manifest.sha256_ids(c["clip_id"] for c in inner_tr),
                   "val_clips_sha256": manifest.sha256_ids(c["clip_id"] for c in inner_va),
                   "n_train": len(inner_tr), "n_val": len(inner_va)},
         "tuning": tuning,
         "rejection_rule": {"threshold": common.THRESHOLD,
                            "R8": "speak top-1 when conf >= 0.6 and top-1 != NONE (product rule, fixed a priori)",
                            "C7": "forced choice over the 7 signs; coverage uses conf >= 0.6"},
         "host": {"start": load0, "end": manifest.host_load()},
         "started": started, "finished": manifest.now(), "seconds": round(time.time() - t0, 1),
         "outputs": outputs}
    manifest.write(manifest.manifest_path(out, system, fold), m)
    log(f"done in {time.time() - t0:.0f}s; manifest written")


def job_done(idx, system, fold, out=None):
    out = Path(out or OUT)
    files = [out / "preds" / f"{system}_{m}_{fold}.jsonl" for m in MODES]
    return all(f.exists() for f in files) and not manifest.check(idx, system, fold, out, fold_sets, files)


# ---------- external pretrained model (bench venv): reference only ----------

def pretrained_vectors(raw):
    """One TFLite output row -> (C7 vector, R8 vector under the PRE-SPECIFIED sum rule, R8 vector under
    the post-hoc max-other rule). Sum rule: NONE = total probability of the 243 other signs, so the 8
    values are the model's own 250-way probabilities collapsed onto our labels and sum to 1."""
    p7_closed = np.asarray(raw["p7_closed"], np.float64)
    p7_raw = np.asarray(raw["p8_reject"][:7], np.float64)
    r8_sum = np.append(p7_raw, max(0.0, float(raw["p_none_sum"])))
    r8_sum = r8_sum / r8_sum.sum()
    r8_max = np.asarray(raw["p8_reject"], np.float64)
    return p7_closed, r8_sum, r8_max


def run_pretrained(raw_from=None, log=print):
    """Run the published TFLite (or reuse an earlier raw output file, recorded by sha256) and write the
    reference predictions: C7, R8 with the pre-specified sum rule, and the post-hoc max-other rule into
    preds_exploratory/ (never read by the protocol report's main tables)."""
    import hashlib
    out = Path(OUT)
    started, t0 = manifest.now(), time.time()
    model = EXT / "model.tflite"
    if hashlib.sha256(model.read_bytes()).hexdigest() != TFLITE_SHA256:
        sys.exit(f"{model} sha256 mismatch; refusing to run an unverified model file")
    idx = load_index(out)
    raw_out = out / "ext_islr1st_pretrained_raw.jsonl"
    if raw_from:
        shutil.copyfile(raw_from, raw_out)
        how = f"reused {Path(raw_from).relative_to(ROOT) if Path(raw_from).is_relative_to(ROOT) else raw_from}"
    else:
        cmd = [str(BENCH_PY), str(Path(__file__).with_name("ext_islr1st_tflite.py")), "--index", str(out / "index.json"),
               "--root", str(ROOT), "--model", str(model), "--map", str(EXT / "sign_to_prediction_index_map.json"),
               "--out", str(raw_out)]
        log(" ".join(cmd))
        subprocess.run(cmd, check=True)
        how = "ran ext_islr1st_tflite.py"
    raw = {}
    with open(raw_out) as f:
        for line in f:
            r = json.loads(line)
            raw[r["clip_id"]] = r
    nt = set(idx["none_train_signs"])
    outputs = {}
    for mode, labels in list(MODES.items()) + [("R8maxother", MODES["R8"])]:
        recs = []
        for c in idx["clips"]:
            if c["oov"] and c["gislr_sign"] in nt:
                continue  # same clip set as the trained systems (their NONE_TRAIN clips are training data)
            r = raw[c["clip_id"]]
            c7, r8_sum, r8_max = pretrained_vectors(r)
            p = {"C7": c7, "R8": r8_sum, "R8maxother": r8_max}[mode]
            recs.append(common.record("islr1st_pretrained", c["clip_id"], c["signer"], c["label"], labels, p, track="A", mode=mode, fold=None, oov=c["oov"],
                                      oov_sign=c["gislr_sign"], pred250=r["top250"], latency_ms=r["latency_ms"]))
        sub = "preds_exploratory" if mode == "R8maxother" else "preds"
        path = out / sub / f"islr1st_pretrained_{mode}_all.jsonl"
        common.write_jsonl(path, recs)
        outputs[f"{sub}/{path.name}"] = manifest.sha256_file(path)
    m = {"schema": manifest.SCHEMA, "smoke": False, "protocol_sha256": manifest.protocol_sha256(),
         "system": "islr1st_pretrained", "fold": "all", "index_sha256": manifest.index_fingerprint(idx),
         "role": "reference only: not retrained; excluded from outside-vocabulary and paired comparisons",
         "model": {"path": str(model.relative_to(ROOT)), "sha256": TFLITE_SHA256,
                   "provenance": "byte-identical to the output of Kaggle hoyso48/1st-place-solution-inference "
                                 "(3-seed ensemble); 21 training participant IDs, none shared with the 10 test IDs; "
                                 "identity UNVERIFIED; 4 test signers (public leaderboard) influenced its selection"},
         "raw_output": {"how": how, "sha256": manifest.sha256_file(raw_out)},
         "rejection_rule": {"R8": "sum_of_other_signs", "R8_exploratory": "max_other_sign (chosen after seeing "
                            "results; preds_exploratory only)", "threshold": common.THRESHOLD},
         "git": manifest.git_info(), "code_sha256": manifest.code_hashes(), "versions": manifest.versions(),
         "host": manifest.host_load(), "started": started, "finished": manifest.now(),
         "seconds": round(time.time() - t0, 1), "outputs": outputs}
    manifest.write(manifest.manifest_path(out, "islr1st_pretrained", "all"), m)
    log("pretrained done; manifest written")


# ---------- latency (serial, after training, idle machine) ----------

def run_latency(n=100, force=False, log=print):
    """Per-clip CPU time (features + model, one clip at a time, 2 torch threads like the server) on the
    first fold's models. Refuses to measure on a busy machine (1-minute load average above 2)."""
    torch.set_num_threads(THREADS)
    load = manifest.host_load()
    if not force and load["loadavg_1_5_15"] and load["loadavg_1_5_15"][0] > 2.0:
        sys.exit(f"machine busy (load {load['loadavg_1_5_15']}); latency must be measured idle (or pass --force)")
    out = Path(OUT)
    idx = load_index(out)
    fold = idx["signers"][0]
    _, te, _ = fold_sets(idx, fold)
    te = te[:n]
    res = {"host_load_start": load}
    for system in TRAINED:
        ck = torch.load(out / "models" / f"{system}_{fold}.pt", map_location="cpu", weights_only=True)
        if system == "islr1st_retrained":
            m = islr1st.ISLR1st(n_classes=ck["n_classes"])
            m.load_state_dict(ck["state_dict"])
            m.eval()
            data = [islr1st.load_raw(ROOT / c["raw"]) for c in te]
            fn = lambda x: islr1st.predict_logits(m, [x])
        else:
            m = {"ours_gru": SignGRU, "ours_baseline": Baseline}.get(system)
            m = m() if m else islr1st.ISLR1stOnOurFeatures(features.FEATURE_DIM, len(CLASSES))
            m.load_state_dict(ck["state_dict"])
            m.eval()
            data = [load_file(ROOT / c["json"])["frames"] for c in te]

            def fn(frames, m=m):
                with torch.inference_mode():
                    return m(torch.from_numpy(features.prepare(frames))[None]).numpy()
        for x in data[:5]:
            fn(x)
        ts = []
        for x in data:
            t0 = time.perf_counter()
            fn(x)
            ts.append((time.perf_counter() - t0) * 1000)
        res[system] = {"p50_ms": round(float(np.median(ts)), 2), "p95_ms": round(float(np.percentile(ts, 95)), 2),
                       "n": len(ts), "what": "features + model forward, one clip, CPU, 2 threads; excludes MediaPipe"}
        log(f"latency {system}: {res[system]}")
    res["host_load_end"] = manifest.host_load()
    (out / "latency.json").write_text(json.dumps(res, indent=1))


# ---------- driver ----------

def _pid_file(out):
    return Path(out) / "run.pid"


def run_all(systems, workers, log=print):
    out = Path(OUT)
    if workers > MAX_WORKERS:
        sys.exit(f"at most {MAX_WORKERS} workers")
    if manifest.protocol_sha256() is None:
        sys.exit("PROTOCOL.md is missing: write and record the protocol before any run")
    pid = _pid_file(out)
    if pid.exists():
        sys.exit(f"{pid} exists (pid {pid.read_text().strip()}): another run may be active; check `ps` and remove it")
    idx = load_index(out)
    jobs = [(s, f) for s in systems if s in TRAINED for f in idx["signers"] if not job_done(idx, s, f, out)]
    # cheap systems first, then the two expensive ones interleaved
    cost = {"ours_baseline": 0, "ours_gru": 1, "islr1st_retrained": 2, "islr1st_ourfeat": 2}
    jobs.sort(key=lambda x: (cost[x[0]], x[1], x[0]))
    (out / "logs").mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "OMP_NUM_THREADS": str(THREADS), "PYTHONHASHSEED": "0", "PYTHONUNBUFFERED": "1"}
    log(f"{len(jobs)} jobs, {workers} workers, protocol sha256 {manifest.protocol_sha256()}")
    pid.parent.mkdir(parents=True, exist_ok=True)
    pid.write_text(str(os.getpid()))
    children = set()
    code_at_launch = manifest.training_code_hashes()

    def one(job):
        s, f = job
        t0 = time.time()
        changed = [k for k, v in manifest.training_code_hashes().items() if code_at_launch.get(k) != v]
        if changed:  # never mix training code within one protocol run
            log(f"REFUSED {s} {f}: training code changed since launch: {', '.join(changed)}")
            return 1
        with open(out / "logs" / f"{s}_{f}.log", "w") as fh:
            p = subprocess.Popen([sys.executable, "-m", "recognition.compare.track_a_gislr", "--out", str(out), "job",
                                  "--system", s, "--fold", f], cwd=ROOT, env=env, stdout=fh, stderr=subprocess.STDOUT)
            children.add(p)
            rc = p.wait()
            children.discard(p)
        log(f"{'ok ' if rc == 0 else 'FAILED'} {s} {f} {time.time() - t0:.0f}s")
        return rc
    try:
        with ThreadPoolExecutor(workers) as ex:
            rcs = list(ex.map(one, jobs))
        if any(rcs):
            sys.exit(f"{sum(1 for r in rcs if r)} jobs failed; see {out / 'logs'}")
        if "islr1st_pretrained" in systems and not manifest.manifest_path(out, "islr1st_pretrained", "all").exists():
            run_pretrained(log=log)
    finally:
        for p in list(children):
            p.kill()
        pid.unlink(missing_ok=True)


def main(argv=None):
    global OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(OUT), help="run folder (default data/compare/track_a_v1)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="all protocol jobs (skips those with a valid manifest), then the pretrained reference")
    r.add_argument("--workers", type=int, default=5)
    r.add_argument("--systems", nargs="*", default=SYSTEMS)
    j = sub.add_parser("job")
    j.add_argument("--system", required=True, choices=TRAINED)
    j.add_argument("--fold", required=True)
    j.add_argument("--smoke", action="store_true", help="2 epochs, manifest marked smoke (refused by the report)")
    sub.add_parser("index")
    p = sub.add_parser("pretrained")
    p.add_argument("--raw-from", help="reuse an earlier ext_islr1st_pretrained_raw.jsonl instead of running TFLite")
    lat = sub.add_parser("latency")
    lat.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    OUT = Path(a.out).resolve()
    if a.cmd == "index":
        idx = load_index(OUT)
        print(f"{len(idx['clips'])} clips, signers {idx['signers']}\nNONE_TRAIN {idx['none_train_signs']}\n"
              f"NONE_TEST {idx['none_test_signs']}\nfingerprint {manifest.index_fingerprint(idx)} (matches PROTOCOL.md)")
    elif a.cmd == "job":
        run_job(a.system, a.fold, smoke=a.smoke)
    elif a.cmd == "pretrained":
        run_pretrained(a.raw_from)
    elif a.cmd == "latency":
        run_latency(force=a.force)
    else:
        run_all(a.systems, a.workers)


if __name__ == "__main__":
    main()

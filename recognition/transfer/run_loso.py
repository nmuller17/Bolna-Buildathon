"""Leave-one-signer-out comparison of the baseline, the GRU and face-free transfer models on team data.

    python -m recognition.transfer.run_loso job --system C --fold cosme
    python -m recognition.transfer.run_loso openset --system C --fold cosme --group 0
    python -m recognition.transfer.run_loso latency
    python -m recognition.transfer.run_loso report

Systems (all face-free: face = None and pose 1-10 replaced by the pose nose before anything is computed):
  A   the teammates' Baseline (logistic regression), trained exactly as recognition.benchmark.cross_validate
  B   our SignGRU, trained exactly as recognition.benchmark.cross_validate
  C   FF-ISLR: GISLR 1st-place weights -> stage-1 face-free distillation on GISLR -> new 22-class head, fine-tuned
  C0  the same without stage 1 (published weights, face columns zeroed, then fine-tuned) - ablation
  D   the same FF-ISLR architecture trained from scratch on team data only - isolates pretraining

Protocol (identical for every system): outer test signer in {cosme, maya, nath, roni}; training = the
other three + talha. Talha is appended as extra data AFTER the inner split, so he is never a test or
validation signer. The inner validation signer is recognition.train.split(seed 0) over the three primary
training signers; it chooses the epoch (networks) and the temperature (all systems, T >= 1); the model is
then refit on all training signers (incl. talha) for the chosen epochs. Same 0.6 gate for all.
"""
import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from recognition import features
from recognition.benchmark import THRESHOLD, metrics, spoken_wrong
from recognition.data import load_dataset, to_arrays
from recognition.labels import CLASSES, INDEX
from recognition.model import fit_temperature, softmax
from recognition.train import split, train_baseline, train_model

ROOT = Path(__file__).resolve().parents[2]
TRAIN = Path("/Users/trehman/CamelHack/data/train")
EXTRA = Path("/Users/trehman/CamelHack/data/train_extra")
OOV = Path("/Users/trehman/CamelHack/data/gislr_oov")
NPZ = Path("/Users/trehman/CamelHack/data/compare/ext/islr1st_h5/seed42_weights.npz")
OUT = ROOT / "data" / "transfer_runs" / "v1"
STAGE1 = ROOT / "data" / "transfer_runs" / "stage1" / "ff_stage1.pt"
FOLDS = ["cosme", "maya", "nath", "roni"]
TRAIN_ONLY = "talha"
SYSTEMS = ["A", "B", "C", "C0", "D"]
NAMES = {"A": "baseline (teammates', logistic regression)", "B": "SignGRU (ours)",
         "C": "FF-ISLR transfer (pretrained + face-free stage 1 + fine-tune)",
         "C0": "FF-ISLR transfer without stage 1 (ablation)", "D": "FF-ISLR from scratch (no pretraining)"}
NONE_I = INDEX["NONE"]
EPOCHS, SEED = 60, 0
SIGN_CLASSES = [c for c in range(len(CLASSES)) if c != NONE_I]
OPENSET_GROUPS = [sorted(g.tolist()) for g in np.array_split(np.random.default_rng(0).permutation(SIGN_CLASSES), 3)]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def minimise(seq):
    """Product privacy parity (mediapipe_adapter minimize=True): no face, pose 1-10 = pose nose."""
    s = {k: v.copy() for k, v in seq.items()}
    s["face"][:] = np.nan
    s["pose"][:, 1:11] = s["pose"][:, :1]
    return s


def load_team():
    seqs, labels, signers, paths = load_dataset([TRAIN], warn=False)
    n_primary = len(seqs)
    es, el, esg, ep = load_dataset([EXTRA], warn=False)
    assert set(esg) == {TRAIN_ONLY} and TRAIN_ONLY not in signers, (set(esg), set(signers))
    seqs = [minimise(s) for s in seqs + es]
    return seqs, np.concatenate([labels, el]), np.array(signers + esg), n_primary, paths + ep


def load_oov():
    """External unknown signs: GISLR rerun clips (CC0) of 30 signs outside our vocabulary; NONE is correct."""
    seqs, signs, files = [], [], []
    for d in sorted(p for p in OOV.iterdir() if p.is_dir()):
        for f in sorted(d.glob("*.json")):
            seq, ok = features.normalize(json.loads(f.read_text()))
            if ok and features.seq_len(seq):
                seqs.append(minimise(seq))
                signs.append(d.name)
                files.append(str(f))
    return seqs, signs, files


def fold_indices(labels, signers, n_primary, fold):
    prim = np.arange(n_primary)
    extra = np.arange(n_primary, len(labels))
    tr = prim[signers[:n_primary] != fold]
    te = prim[signers[:n_primary] == fold]
    itr, iva, how = split(labels[tr], signers[tr], seed=SEED)
    itr, iva = np.concatenate([tr[itr], extra]).astype(int), tr[iva]
    trall = np.concatenate([tr, extra]).astype(int)
    assert TRAIN_ONLY not in set(signers[te]) | set(signers[iva]) and fold not in set(signers[trall])
    return itr, iva, trall, te, how


def init_for(system):
    from recognition.transfer import ffislr as FF
    if system == "C":
        return torch.load(STAGE1, map_location="cpu", weights_only=True)
    if system == "C0":
        return FF.from_pretrained(NPZ).state_dict()
    return None


class Fitted:
    """A trained system: .logits(list of minimised seqs) -> [N, 22]."""

    def __init__(self, system, model):
        self.system, self.model = system, model

    def logits(self, seqs):
        if self.system == "A":
            return self.model.logits(to_arrays(seqs))
        if self.system == "B":
            with torch.inference_mode():
                return self.model(torch.from_numpy(to_arrays(seqs))).numpy()
        from recognition.transfer import ffislr as FF
        return FF.logits(self.model, [FF.seq_to_raw(s) for s in seqs])


def fit(system, seqs, labels, tr, va, epochs=None, log=print, ckpt=None):
    """Train one system on tr; with va choose epochs/temperature. Returns (Fitted, temperature, info)."""
    if system == "A":
        m, t, info = train_baseline(seqs, labels, tr, va, SEED)
        return Fitted("A", m), t, info
    if system == "B":
        m, t, info = train_model(seqs, labels, tr, va, epochs=epochs or EPOCHS, seed=SEED, log=lambda m: None)
        return Fitted("B", m), t, info
    from recognition.transfer import ffislr as FF
    raws = {i: FF.seq_to_raw(seqs[i]) for i in np.concatenate([tr, va]).astype(int)}
    val = ([raws[i] for i in va], labels[va]) if len(va) else None
    m, info = FF.train([raws[i] for i in tr], labels[tr], len(CLASSES), epochs or EPOCHS, init=init_for(system),
                       seed=SEED, val=val, log=log, ckpt=ckpt)
    t = 1.0
    if len(va):
        t = fit_temperature(FF.logits(m, val[0]), labels[va])
    info["temperature"] = round(t, 4)
    return Fitted(system, m), t, info


def env_info():
    try:
        commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain"], capture_output=True, text=True).stdout.strip())
    except OSError:
        commit, dirty = None, None
    return {"git_commit": commit, "git_dirty": dirty, "torch": torch.__version__, "numpy": np.__version__,
            "python": platform.python_version(), "torch_threads": torch.get_num_threads(),
            "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"), "load_avg": os.getloadavg(),
            "code_sha256": {p.name: sha256(p) for p in sorted((ROOT / "recognition").glob("*.py")) +
                            sorted((ROOT / "recognition/transfer").glob("*.py"))}}


def save_model(path, fitted):
    if fitted.system in ("A", "B"):
        torch.save({"kind": fitted.system, "state_dict": fitted.model.state_dict()}, path)
    else:
        torch.save({"kind": fitted.system, "state_dict": fitted.model.state_dict()}, path)


def job(system, fold, out):
    out = Path(out)
    (out / "preds").mkdir(parents=True, exist_ok=True)
    (out / "models").mkdir(parents=True, exist_ok=True)
    man_path = out / "preds" / f"{system}_{fold}.manifest.json"
    if man_path.exists():
        print(f"{man_path} exists, skipping")
        return
    t0 = time.time()
    seqs, labels, signers, n_primary, paths = load_team()
    itr, iva, trall, te, how = fold_indices(labels, signers, n_primary, fold)
    log = lambda m: print(f"[{system} {fold}] {m}", flush=True)
    ckdir = out / "ckpt"
    ckdir.mkdir(parents=True, exist_ok=True)
    inner_json = ckdir / f"{system}_{fold}_inner.json"  # the inner model itself is not needed after this
    if inner_json.exists():
        d = json.loads(inner_json.read_text())
        temp, fi = d["temperature"], d["info"]
        log("inner fit restored from checkpoint")
    else:
        _, temp, fi = fit(system, seqs, labels, itr, iva, log=log, ckpt=ckdir / f"{system}_{fold}_inner.pt")
        inner_json.write_text(json.dumps({"temperature": float(temp), "info": fi}))
    best = fi.get("best_epoch")
    log(f"inner fit done ({how}, best epoch {best}, T={temp:.3f}); refit on {len(trall)} takes")
    model, _, ri = fit(system, seqs, labels, trall, np.array([], int), epochs=best, log=log,
                       ckpt=ckdir / f"{system}_{fold}_refit.pt")
    lg = model.logits([seqs[i] for i in te])
    oseqs, osigns, ofiles = load_oov()
    lo = model.logits(oseqs)
    np.savez(out / "preds" / f"{system}_{fold}.npz", test_idx=te, labels=labels[te], logits=lg, temperature=temp,
             probs=softmax(lg, temp), probs_T1=softmax(lg), oov_logits=lo, oov_probs=softmax(lo, temp),
             oov_probs_T1=softmax(lo))
    mpath = out / "models" / f"{system}_{fold}.pt"
    save_model(mpath, model)
    acc = float((lg.argmax(1) == labels[te]).mean())
    count = lambda idx: {s: int((signers[idx] == s).sum()) for s in sorted(set(signers[idx]))}
    man = {
        "system": system, "system_name": NAMES[system], "fold": f"signer:{fold}", "test_signer": fold,
        "inner_val": how, "inner_train_takes_by_signer": count(itr), "inner_val_takes_by_signer": count(iva),
        "refit_takes_by_signer": count(trall), "test_takes": int(len(te)),
        "talha_role": "training only (inner train + refit); never validation or test",
        "test_label_counts": {CLASSES[c]: int((labels[te] == c).sum()) for c in range(len(CLASSES))},
        "file_list_sha256": hashlib.sha256(json.dumps([paths[i] for i in np.concatenate([trall, te])]).encode()).hexdigest(),
        "test_files_sha256": hashlib.sha256(json.dumps([paths[i] for i in te]).encode()).hexdigest(),
        "face_free": "face=None, pose 1-10 := pose 0 for every take (train, val, test, OOV)",
        "inner_fit": {k: v for k, v in fi.items() if k != "val_curve"}, "inner_val_curve": fi.get("val_curve"),
        "refit": {k: v for k, v in ri.items() if k != "val_curve"}, "temperature": round(float(temp), 4),
        "threshold": THRESHOLD, "seed": SEED, "max_epochs": EPOCHS,
        "init": {"C": f"{STAGE1} sha256 {sha256(STAGE1) if STAGE1.exists() else None}",
                 "C0": f"{NPZ} sha256 {sha256(NPZ)}"}.get(system, "random (seed 0)" if system in ("B", "D") else "n/a"),
        "test_accuracy": round(acc, 4), "oov_clips": len(oseqs),
        "preds_sha256": sha256(out / "preds" / f"{system}_{fold}.npz"), "model_sha256": sha256(mpath),
        "seconds": round(time.time() - t0, 1),
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), **env_info(),
    }
    man_path.write_text(json.dumps(man, indent=1))
    for p in ckdir.glob(f"{system}_{fold}_*.pt"):
        p.unlink()
    log(f"test acc {acc:.3f}  ({man['seconds']}s, excludes time before any resume)")


def openset(system, fold, group, out):
    """Unknown-sign test: train WITHOUT the signs of one group (7 of 21), for the epoch count the main job chose,
    and score the held-out signer's takes of those signs. group = 'sign:<c>' runs the repo's exact one-sign version."""
    out = Path(out)
    (out / "openset").mkdir(parents=True, exist_ok=True)
    dest = out / "openset" / f"{system}_{fold}_{group}.json"
    if dest.exists():
        return
    main = json.loads((out / "preds" / f"{system}_{fold}.manifest.json").read_text())
    seqs, labels, signers, n_primary, _ = load_team()
    _, _, trall, te, _ = fold_indices(labels, signers, n_primary, fold)
    held = [int(group.split(":")[1])] if str(group).startswith("sign:") else OPENSET_GROUPS[int(group)]
    tr = trall[~np.isin(labels[trall], held)]
    te_h = te[np.isin(labels[te], held)]
    ck = out / "ckpt" / f"open_{system}_{fold}_{str(group).replace(':', '_')}.pt"
    ck.parent.mkdir(parents=True, exist_ok=True)
    model, _, _ = fit(system, seqs, labels, tr, np.array([], int), epochs=main["inner_fit"].get("best_epoch"),
                      log=lambda m: None, ckpt=ck if system not in ("A", "B") else None)
    lg = model.logits([seqs[i] for i in te_h])
    T = main["temperature"]
    res = {"system": system, "fold": fold, "group": str(group), "held_out_signs": [CLASSES[c] for c in held],
           "n": int(len(te_h)), "temperature": T, "labels": labels[te_h].tolist()}
    for name, p in (("T", softmax(lg, T)), ("T1", softmax(lg))):
        res[f"spoken_{name}"] = ((p.max(1) >= THRESHOLD) & (p.argmax(1) != NONE_I)).astype(int).tolist()
        res[f"pred_{name}"] = [CLASSES[i] for i in p.argmax(1)]
    dest.write_text(json.dumps(res))
    if ck.exists():
        ck.unlink()
    print(f"[openset {system} {fold} {group}] spoken {np.mean(res['spoken_T']):.3f}", flush=True)


def latency(out, n=200):
    """CPU latency per segment (2 torch threads, as the server): features from raw Frame[] + forward."""
    from recognition.transfer import ffislr as FF
    out = Path(out)
    torch.set_num_threads(2)
    seqs, labels, signers, n_primary, paths = load_team()
    te = np.flatnonzero(signers == FOLDS[0])
    lens = [features.seq_len(seqs[i]) for i in te]
    i = int(te[np.argsort(lens)[len(lens) // 2]])
    frames = features.seq_to_frames(seqs[i], ndigits=4)
    res = {"segment_frames": len(frames), "torch_threads": torch.get_num_threads(), "load_avg_before": os.getloadavg()}
    for system in SYSTEMS:
        mp = out / "models" / f"{system}_{FOLDS[0]}.pt"
        if not mp.exists():
            continue
        ck = torch.load(mp, map_location="cpu", weights_only=True)
        if system == "A":
            from recognition.model import Baseline
            m = Baseline()
        elif system == "B":
            from recognition.model import SignGRU
            m = SignGRU()
        else:
            m = FF.new_model(len(CLASSES))
        m.load_state_dict(ck["state_dict"])
        m.eval()

        def run():
            seq = minimise(features.normalize(frames)[0])
            if system in ("A", "B"):
                x = torch.from_numpy(features.resample(features.frames_to_array(seq)))[None]
                return m(x)
            X, M = FF.P.pad_batch([FF.preprocess(FF.seq_to_raw(seq))])
            return m(X, M)
        ts = []
        with torch.inference_mode():
            for _ in range(10):
                run()
            for _ in range(n):
                t0 = time.perf_counter()
                run()
                ts.append((time.perf_counter() - t0) * 1000)
        res[system] = {"p50_ms": round(float(np.percentile(ts, 50)), 2), "p95_ms": round(float(np.percentile(ts, 95)), 2),
                       "params": int(sum(p.numel() for p in m.parameters())),
                       "checkpoint_bytes": os.path.getsize(mp)}
        print(system, res[system], flush=True)
    res["load_avg_after"] = os.getloadavg()
    (out / "latency.json").write_text(json.dumps(res, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("job")
    j.add_argument("--system", choices=SYSTEMS, required=True)
    j.add_argument("--fold", choices=FOLDS, required=True)
    o = sub.add_parser("openset")
    o.add_argument("--system", choices=SYSTEMS, required=True)
    o.add_argument("--fold", choices=FOLDS, required=True)
    o.add_argument("--group", required=True)
    sub.add_parser("latency")
    for p in (j, o, ap):
        p.add_argument("--out", default=str(OUT))
        p.add_argument("--threads", type=int, default=3)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    if a.cmd == "job":
        job(a.system, a.fold, a.out)
    elif a.cmd == "openset":
        openset(a.system, a.fold, a.group, a.out)
    elif a.cmd == "latency":
        latency(a.out)


if __name__ == "__main__":
    main()

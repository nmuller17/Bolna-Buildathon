"""Train the face-free GISLR 1st-place network (kind "ffislr", system D) on all signers and save it.

    python -m recognition.train_ffislr --out recognition/models/model.pt

The recipe is the one measured leave-one-signer-out in the transfer study (TRANSFER_RESULTS.md,
system D), in its "refit on everything" form:

1. inner fit: one primary signer (recognition.train.split, seed 0, over the --data signers only) is
   held out for validation; the network is trained from scratch on the other primary signers plus
   every --extra-data signer, with early stopping on the held-out signer's loss (at most 60 epochs,
   patience 12). This picks the epoch count and the temperature (T >= 1, model.fit_temperature).
2. refit: the same network, same seed, trained from scratch on ALL signers for that many epochs.

--extra-data signers (Talha: data/train_extra) are training-only: never validation, never test.
Face-free throughout: face = None and pose 1-10 := pose nose before anything is computed.
Training is resumable: a killed run restarts from its last finished epoch (--work holds the state).
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from recognition import ffislr
from recognition.data import load_dataset
from recognition.labels import CLASSES
from recognition.model import fit_temperature, save_checkpoint
from recognition.train import split

ROOT = Path(__file__).resolve().parents[1]
ATTRIBUTION = ("Network design, augmentation and preprocessing derived from the GISLR 1st-place solution, "
               "Copyright (c) 2023 hoyso48, MIT License "
               "(https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution); "
               "trained from scratch on the team's own recordings, no third-party weights. See NOTICE.")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(ROOT / "data" / "train"))
    ap.add_argument("--extra-data", nargs="*", default=[str(ROOT / "data" / "train_extra")],
                    help="training-only signers (never validation)")
    ap.add_argument("--out", default=str(ROOT / "recognition" / "models" / "model.pt"))
    ap.add_argument("--work", default=str(ROOT / "data" / "ffislr_final"), help="resume state and run record")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=3)
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    log = lambda m: print(f"[ffislr] {m}", flush=True)

    seqs, labels, signers, paths = load_dataset([a.data], warn=False)
    n_primary = len(seqs)
    if a.extra_data:
        es, el, esg, ep = load_dataset(a.extra_data, warn=False)
        if set(esg) & set(signers):
            sys.exit(f"extra-data signers also in --data: {sorted(set(esg) & set(signers))}")
        seqs, labels, signers, paths = seqs + es, np.concatenate([labels, el]), signers + esg, paths + ep
    signers = np.asarray(signers)
    raws = [ffislr.seq_to_raw(ffislr.minimise(s)) for s in seqs]

    prim = np.arange(n_primary)
    extra = np.arange(n_primary, len(labels))
    itr, iva, how = split(labels[prim], signers[prim], seed=a.seed)
    itr = np.concatenate([prim[itr], extra]).astype(int)
    iva = prim[iva]
    assert not set(signers[iva]) & set(signers[extra]), "a training-only signer reached validation"
    count = lambda idx: {str(s): int((signers[idx] == s).sum()) for s in sorted(set(signers[idx]))}
    rel = lambda p: str(Path(p).resolve().relative_to(ROOT)) if Path(p).resolve().is_relative_to(ROOT) else Path(p).name

    inner_json = work / "inner.json"
    if inner_json.exists():
        inner = json.loads(inner_json.read_text())
        log(f"inner fit restored ({inner['inner_val']}, best epoch {inner['best_epoch']}, T={inner['temperature']})")
    else:
        log(f"inner fit: val {how} {count(iva)}, train {count(itr)}")
        m, info = ffislr.train([raws[i] for i in itr], labels[itr], len(CLASSES), a.epochs, seed=a.seed,
                               val=([raws[i] for i in iva], labels[iva]), log=log, ckpt=work / "inner.pt")
        temp = fit_temperature(ffislr.logits(m, [raws[i] for i in iva]), labels[iva])
        inner = {"inner_val": how, "best_epoch": info["best_epoch"], "temperature": round(float(temp), 4),
                 "info": {k: v for k, v in info.items() if k != "val_curve"}, "val_curve": info["val_curve"],
                 "train_takes_by_signer": count(itr), "val_takes_by_signer": count(iva)}
        inner_json.write_text(json.dumps(inner, indent=1))
        (work / "inner.pt").unlink(missing_ok=True)
        del m

    allidx = np.arange(len(labels))
    log(f"refit on all {len(allidx)} takes {count(allidx)} for {inner['best_epoch']} epochs")
    model, rinfo = ffislr.train([raws[i] for i in allidx], labels, len(CLASSES), inner["best_epoch"],
                                seed=a.seed, log=log, ckpt=work / "refit.pt")
    meta = {
        "model": "ffislr (system D: GISLR 1st-place architecture, face-free, trained from scratch)",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": [rel(p) for p in [a.data] + list(a.extra_data)], "takes_by_signer": count(allidx),
        "training_only_signers": sorted(set(signers[extra].tolist())),
        "inner_val": inner["inner_val"], "inner_best_epoch": inner["best_epoch"],
        "inner_best_val_loss": inner["info"].get("best_val_loss"), "refit_epochs": inner["best_epoch"],
        "refit_seconds": rinfo["train_seconds"], "seed": a.seed, "max_epochs": a.epochs,
        "file_list_sha256": hashlib.sha256(json.dumps([rel(p) for p in paths]).encode()).hexdigest(),
        "face_free": "face=None, pose 1-10 := pose 0; lip/eye stem columns are 0",
        "params": ffislr.n_params(model), "attribution": ATTRIBUTION,
    }
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    save_checkpoint(out, model, temperature=inner["temperature"], meta=meta)
    (work / "refit.pt").unlink(missing_ok=True)
    (work / "run.json").write_text(json.dumps({**meta, "out": str(out), "temperature": inner["temperature"],
                                               "sha256": hashlib.sha256(out.read_bytes()).hexdigest()}, indent=1))
    log(f"saved {out} (T={inner['temperature']}); pin it with python -m recognition.pin_model {out}")


if __name__ == "__main__":
    main()

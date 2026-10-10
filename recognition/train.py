"""Train the classifier on data/train/<SIGN>/*.json, save recognition/models/model.pt.

    python -m recognition.train --data data/train --epochs 60

Validation is split BY SIGNER (one whole signer held out) so the reported accuracy is
for a person the model has not seen; with one signer it falls back to a stratified
random split and says so. A temperature is fit on the validation split, but only
ever to soften an overconfident model (T >= 1, see model.fit_temperature); it is never
used to sharpen confidence. Runs on CPU (a small GRU is not faster on MPS).
"""
import argparse
import copy
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from recognition import features
from recognition.data import load_with_extra, to_arrays
from recognition.labels import CLASSES
from recognition.model import Baseline, SignGRU, fit_temperature, save_checkpoint

# Floor for the per-feature std used to standardize inputs, in shoulder-width units.
# Without it, near-constant features (e.g. shoulder y) turn tiny per-signer differences into huge inputs.
SD_FLOOR = 0.01


def set_seed(seed):
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def split(labels, signers, val_signer=None, seed=0, val_frac=0.2):
    """Returns (train_idx, val_idx, description). Whole signers go to val when possible."""
    signers = np.asarray(signers)
    uniq = sorted(set(signers.tolist()))
    if val_signer is not None and val_signer not in uniq:
        raise ValueError(f"--val-signer {val_signer!r} not in {uniq}")
    if val_signer is None and len(uniq) >= 2:
        val_signer = uniq[np.random.default_rng(seed).integers(len(uniq))]
    if val_signer is not None:
        return np.flatnonzero(signers != val_signer), np.flatnonzero(signers == val_signer), f"signer:{val_signer}"
    print("WARNING: only one signer; using a stratified random split. Validation takes come from the "
          "same person as training, so the val accuracy will be optimistic for a new guest.", file=sys.stderr)
    rng = np.random.default_rng(seed)
    tr, va = [], []
    for c in np.unique(labels):
        idx = rng.permutation(np.flatnonzero(labels == c))
        k = max(1, int(round(len(idx) * val_frac))) if len(idx) > 1 else 0
        va += idx[:k].tolist()
        tr += idx[k:].tolist()
    return np.array(sorted(tr)), np.array(sorted(va)), "stratified-random"


def train_model(seqs, labels, tr, va, epochs=60, batch_size=64, lr=2e-3, seed=0, patience=12,
                T=features.T_DEFAULT, log=print):
    """Train SignGRU on seqs[tr] (augmented), early-stop on val loss. Returns (model, temperature, info)."""
    set_seed(seed)
    rng = np.random.default_rng(seed)
    Xtr = to_arrays([seqs[i] for i in tr], T)
    model = SignGRU()
    mu = Xtr.reshape(-1, Xtr.shape[-1]).mean(0)
    sd = np.maximum(Xtr.reshape(-1, Xtr.shape[-1]).std(0), SD_FLOOR)
    model.mu.copy_(torch.from_numpy(mu))
    model.sd.copy_(torch.from_numpy(sd))
    has_val = len(va) > 0
    if has_val:
        Xv = torch.from_numpy(to_arrays([seqs[i] for i in va], T))
        yv = torch.from_numpy(labels[va])
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    best_loss, best_state, best_ep, bad, ep = float("inf"), None, epochs - 1, 0, -1
    t0 = time.time()
    for ep in range(epochs):
        model.train()
        perm = rng.permutation(tr)
        Xa = torch.from_numpy(np.stack([features.resample(features.frames_to_array(features.augment(seqs[i], rng)), T)
                                        for i in perm]))
        ya = torch.from_numpy(labels[perm])
        total = 0.0
        for b in range(0, len(perm), batch_size):
            loss = F.cross_entropy(model(Xa[b:b + batch_size]), ya[b:b + batch_size], label_smoothing=0.1)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item() * len(ya[b:b + batch_size])
        sched.step()
        msg = f"epoch {ep + 1:3d}  train_loss {total / len(perm):.3f}"
        if has_val:
            model.eval()
            with torch.inference_mode():
                lv = model(Xv)
                vloss = F.cross_entropy(lv, yv).item()
                vacc = (lv.argmax(1) == yv).float().mean().item()
            msg += f"  val_loss {vloss:.3f}  val_acc {vacc:.3f}"
            if vloss < best_loss - 1e-4:
                best_loss, best_state, best_ep, bad = vloss, copy.deepcopy(model.state_dict()), ep, 0
            else:
                bad += 1
        log(msg)
        if has_val and bad >= patience:
            log(f"early stop at epoch {ep + 1} (best {best_ep + 1})")
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    info = {"epochs_run": ep + 1, "best_epoch": best_ep + 1, "train_seconds": round(time.time() - t0, 1),
            "n_train": int(len(tr)), "n_val": int(len(va))}
    temperature = 1.0
    if has_val:
        with torch.inference_mode():
            lv = model(Xv).numpy()
        temperature = fit_temperature(lv, labels[va])
        info.update(best_val_loss=round(best_loss, 4), val_acc=round(float((lv.argmax(1) == labels[va]).mean()), 4))
    info["temperature"] = round(temperature, 4)
    return model, temperature, info


def train_baseline(seqs, labels, tr, va, seed=0, T=features.T_DEFAULT):
    """Fit the Baseline on seqs[tr] plus mirrored copies; temperature from va. Returns (model, temperature, info)."""
    idx = list(tr)
    X = np.concatenate([to_arrays([seqs[i] for i in idx], T), to_arrays([features.mirror(seqs[i]) for i in idx], T)])
    y = np.concatenate([labels[tr], labels[tr]])
    model = Baseline().fit(X, y, seed=seed)
    info = {"n_train": int(len(tr)), "n_val": int(len(va))}
    temperature = 1.0
    if len(va):
        lv = model.logits(to_arrays([seqs[i] for i in va], T))
        temperature = fit_temperature(lv, labels[va])
        info["val_acc"] = round(float((lv.argmax(1) == labels[va]).mean()), 4)
    model.temperature = temperature
    info["temperature"] = round(temperature, 4)
    return model, temperature, info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/train")
    ap.add_argument("--extra-data", nargs="*", default=[], help="more roots in the same layout (e.g. converted GISLR)")
    ap.add_argument("--out", default="recognition/models/model.pt")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--val-signer", default=None)
    ap.add_argument("--model", choices=["gru", "baseline"], default="gru",
                    help="baseline = logistic regression on per-take statistics; serve it if it wins the benchmark")
    ap.add_argument("--refit-all", action="store_true",
                    help="after early stopping, retrain on ALL signers for the best epoch count (use for the demo model)")
    args = ap.parse_args(argv)
    torch.set_num_threads(min(8, torch.get_num_threads()))

    seqs, labels, signers, n_primary = load_with_extra(args.data, args.extra_data)
    if not n_primary:
        sys.exit(f"no training files found under {args.data}")
    print(f"{len(seqs)} samples ({len(seqs) - n_primary} extra), {len(set(signers))} signers, "
          f"{len(set(labels.tolist()))}/{len(CLASSES)} classes")
    tr, va, how = split(labels[:n_primary], signers[:n_primary], args.val_signer, args.seed)
    tr = np.concatenate([tr, np.arange(n_primary, len(seqs))]).astype(int)
    print(f"split {how}: train {len(tr)}, val {len(va)}")
    everyone, no_val = np.arange(len(seqs)), np.array([], int)
    if args.model == "baseline":
        model, temperature, info = train_baseline(seqs, labels, tr, va, args.seed)
        if args.refit_all and len(va):
            print(f"refit baseline on all {len(seqs)} samples (temperature kept from val fit)")
            model, _, info["refit_all"] = train_baseline(seqs, labels, everyone, no_val, args.seed)
    else:
        model, temperature, info = train_model(seqs, labels, tr, va, args.epochs, args.batch_size, args.lr, args.seed)
        if args.refit_all and len(va):
            print(f"refit on all {len(seqs)} samples for {info['best_epoch']} epochs (temperature kept from val fit)")
            model, _, info["refit_all"] = train_model(seqs, labels, everyone, no_val, info["best_epoch"],
                                                      args.batch_size, args.lr, args.seed)
    meta = {"model": args.model, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "data": [args.data] + list(args.extra_data),
            "n_samples": len(seqs), "signers": sorted(set(signers)), "split": how, "seed": args.seed,
            "lr": args.lr, "batch_size": args.batch_size, **info}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    save_checkpoint(args.out, model, temperature, meta=meta)
    print(f"saved {args.out}  val_acc {info.get('val_acc', 'n/a')}  temperature {temperature:.3f}")


if __name__ == "__main__":
    main()

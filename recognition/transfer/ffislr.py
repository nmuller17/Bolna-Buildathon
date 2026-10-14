"""Face-free GISLR 1st-place network (FF-ISLR): input, pretrained init, stage-1 adaptation, stage-2 fine-tune.

Privacy rule: the recognizer never receives a face mesh (face = None) and pose points 1-10 are
overwritten with the pose nose (mediapipe_adapter minimisation). The original 1st-place input is
118 points (40 lip, 2 x 21 hand, 4 nose, 2 x 16 eye) centred on lip point 17 and divided by the
clip's per-axis std over those points. The face-free input keeps the same 708 columns so the
pretrained stem lines up, but:

- the 72 lip and eye slots are always empty (0 after nan_to_num), and their stem columns are set
  to 0 and stay 0 (zero input -> zero gradient; checked by assert_face_blind);
- the 4 nose slots carry pose point 0 (the pose nose, which the product already sends);
- centre = clip mean of the pose nose + OFFSET shoulder widths (median lip-17 minus pose-nose
  offset measured once on GISLR clips), scale = R x mean shoulder width per axis (median ratio of
  the original std to shoulder width, also measured once on GISLR) - no face data is needed;
- 6 pose points (shoulders, elbows, wrists: 11-16) are appended as 36 new columns (x, y and the
  1- and 2-frame differences) whose stem weights start at 0, so at initialisation the network
  computes exactly the pretrained function of the face-free input.

Team clips are already 6.2-normalised (shoulder units). Before augmentation they are mapped into
GISLR-like image coordinates (x * SW + MID) so the 1st-place augmentation (rotation about the
image centre, spatial masks in [0, 1]) means the same thing for both sources.
"""
import copy
import math
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from recognition.transfer import islr1st_port as P

# Measured on 300 GISLR rerun clips (seed 0) - see PROGRESS_LIVE_transfer.md.
OFFSET = np.array([-0.01572, 0.12506], np.float32)  # lip 17 - pose nose, shoulder widths (y down)
R = np.array([0.17242, 0.17624], np.float32)         # original per-axis std / shoulder width
SW = 0.56569                                          # median GISLR shoulder width (image units)
MID = np.array([0.54844, 0.62221], np.float32)        # median GISLR shoulder midpoint

POSE0 = P.OFFSET["pose"]
NOSE_ROWS = P.NOSE                                    # face-mesh rows 1, 2, 98, 327
EXTRA_POSE = [11, 12, 13, 14, 15, 16]
EXTRA_ROWS = [POSE0 + i for i in EXTRA_POSE]
FACE_SLOTS = [i for i, r in enumerate(P.POINTS) if r < 468 and r not in NOSE_ROWS]  # 72 lip + eye slots
N_PTS = len(P.POINTS)                                 # 118
IN_DIM = 6 * N_PTS + 6 * len(EXTRA_POSE)              # 708 + 36 = 744


def face_columns():
    """Stem input columns that carry lip/eye slots (always 0 in face-free input)."""
    cols = []
    for block in range(3):  # p, dx, dx2 for the 118 original points, each laid out [point, xy]
        for s in FACE_SLOTS:
            cols += [block * 2 * N_PTS + 2 * s, block * 2 * N_PTS + 2 * s + 1]
    return np.array(cols)


FACE_COLS = face_columns()


# ---------- face-free raw arrays ----------

def face_free(raw):
    """[T,543,3] GISLR-order array -> the same with every face-mesh row removed (NaN) except the 4 nose
    slots, which get the POSE nose, and with pose 1-10 overwritten by the pose nose (product minimisation)."""
    x = raw.copy()
    x[:, :468] = np.nan
    nose = x[:, POSE0]
    x[:, POSE0 + 1:POSE0 + 11] = nose[:, None]
    x[:, NOSE_ROWS] = nose[:, None]
    return x


def seq_to_raw(seq):
    """6.2-normalised Seq (shoulder units) -> face-free [T,543,3] in GISLR-like image coordinates."""
    T = len(seq["pose"])
    x = np.full((T, P.ROWS, 3), np.nan, np.float32)
    x[:, POSE0:POSE0 + 33] = seq["pose"]
    x[:, P.OFFSET["left_hand"]:P.OFFSET["left_hand"] + 21] = seq["lh"]
    x[:, P.OFFSET["right_hand"]:P.OFFSET["right_hand"] + 21] = seq["rh"]
    x[..., :2] = x[..., :2] * SW + MID
    x[..., 2] = x[..., 2] * SW
    return face_free(x)


def preprocess(x, max_len=P.MAX_LEN):
    """Face-free [T,543,3] -> [T', IN_DIM] float32. Face rows other than the pose-nose slots are ignored."""
    x = P.filter_nans(x)  # keeps frames with any hand or the (pose) nose
    if len(x) == 0:
        return np.zeros((1, IN_DIM), np.float32)
    with np.errstate(invalid="ignore", divide="ignore"):
        l, r = x[:, POSE0 + 11, :2], x[:, POSE0 + 12, :2]
        d = np.linalg.norm(l - r, axis=1)
        sw = float(np.nanmean(d)) if np.isfinite(d).any() else np.nan
        nose = x[:, NOSE_ROWS[0], :2]
        if not np.isfinite(sw) or sw < 1e-6:
            sw = SW
        centre = (np.nanmean(nose, 0) if np.isfinite(nose).any() else MID - OFFSET * SW) + OFFSET * sw
        scale = R * sw
        pts = x[:, P.POINTS, :2].copy()
        pts[:, FACE_SLOTS] = np.nan
        p = (pts - centre) / scale
        e = (x[:, EXTRA_ROWS, :2] - centre) / scale
    p, e = p[:max_len], e[:max_len]

    def diffs(a):
        T = len(a)
        d1, d2 = np.zeros_like(a), np.zeros_like(a)
        if T > 1:
            d1[:-1] = a[1:] - a[:-1]
        if T > 2:
            d2[:-2] = a[2:] - a[:-2]
        return [a.reshape(T, -1), d1.reshape(T, -1), d2.reshape(T, -1)]
    out = np.concatenate(diffs(p) + diffs(e), axis=1)
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


# ---------- model ----------

def new_model(n_classes, late_dropout_start=0):
    return P.ISLR1st(in_dim=IN_DIM, n_classes=n_classes, late_dropout_start=late_dropout_start)


def zero_face_columns(model):
    with torch.no_grad():
        model.stem.weight[:, torch.from_numpy(FACE_COLS)] = 0.0


def assert_face_blind(model):
    w = model.stem.weight.detach()[:, torch.from_numpy(FACE_COLS)]
    assert float(w.abs().max()) == 0.0, "stem weights on lip/eye columns are not zero"


def from_pretrained(npz, n_classes=250):
    """Published 250-way weights in the face-free layout: original 708 columns copied (lip/eye columns
    zeroed), 36 new pose columns zero. With n_classes != 250 the classifier is a fresh layer."""
    src = P.load_keras(npz)
    m = new_model(250)
    sd = src.state_dict()
    w = torch.zeros(m.stem.weight.shape)
    w[:, :6 * N_PTS] = sd.pop("stem.weight")
    m.load_state_dict({**sd, "stem.weight": w}, strict=True)
    zero_face_columns(m)
    if n_classes != 250:
        m.cls = nn.Linear(m.cls.in_features, n_classes)
    return m.eval()


def n_params(model):
    return int(sum(p.numel() for p in model.parameters()))


def logits(model, raws, batch=64):
    """Unaugmented logits for a list of face-free raw arrays (length-bucketed, masked: output-neutral)."""
    model.eval()
    X = [preprocess(r) for r in raws]
    order = np.argsort([len(a) for a in X])
    out = np.zeros((len(X), model.cls.out_features), np.float32)
    with torch.inference_mode():
        for b in range(0, len(order), batch):
            idx = order[b:b + batch]
            xb, mb = P.pad_batch([X[i] for i in idx])
            out[idx] = model(xb, mb).numpy()
    return out


# ---------- resumable checkpoints (jobs were killed twice overnight; a kill now costs at most one epoch) ----------

def _ck_save(path, state):
    if path is None:
        return
    import os
    tmp = str(path) + ".tmp"
    torch.save(state, tmp)
    os.replace(tmp, path)


def _ck_load(path):
    import os
    if path is None or not os.path.exists(path):
        return None
    return torch.load(path, map_location="cpu", weights_only=False)


# ---------- stage 2: supervised training (fine-tune or from scratch) ----------

def train(raws, y, n_classes, epochs, init=None, seed=0, batch_size=64, lr=5e-4, wd=0.1, lr_min=1e-6,
          late_epochs=15, val=None, patience=12, log=print, ckpt=None):
    """The 1st-place recipe (as recognition/compare/islr1st.train_own_recipe, minus AWP) on face-free input.

    init: None = random init (system D); a state_dict of a face-free backbone = transfer (C, C0); the
    classifier is always new. Without val: exactly `epochs` epochs (refit). With val=(raws_val, y_val):
    unaugmented val loss after every epoch, keep the lowest (improvement > 1e-4), stop after `patience`
    epochs without improvement (the same nested rule as recognition.train.train_model)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    steps = max(1, math.ceil(len(y) / batch_size))
    model = new_model(n_classes, late_dropout_start=late_epochs * steps)
    if init is not None:
        sd = {k: v for k, v in init.items() if not k.startswith("cls.") and k != "steps"}
        missing, unexpected = model.load_state_dict(sd, strict=False)
        assert set(missing) <= {"cls.weight", "cls.bias", "steps"} and not unexpected, (missing, unexpected)
        zero_face_columns(model)
    else:
        zero_face_columns(model)  # same face-blind constraint for the from-scratch model
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd)
    total = epochs * steps
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (lr_min + 0.5 * (lr - lr_min) * (1 + math.cos(math.pi * min(s, total) / total))) / lr)
    yt = torch.as_tensor(y)
    best_loss, best_state, best_ep, bad, curve, ep = float("inf"), None, epochs - 1, 0, [], -1
    t0, start = time.time(), 0
    ck = _ck_load(ckpt)
    if ck is not None:  # resume: identical continuation (model, optimiser, schedule, both RNG streams)
        assert ck["n_train"] == len(y) and ck["epochs"] == epochs, "checkpoint does not match this job"
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        rng.bit_generator.state = ck["np_rng"]
        torch.set_rng_state(ck["torch_rng"])
        best_loss, best_state, best_ep, bad, curve = ck["best_loss"], ck["best_state"], ck["best_ep"], ck["bad"], ck["curve"]
        start, ep = ck["next_ep"], ck["next_ep"] - 1
        t0 -= ck["elapsed"]
        log(f"resumed from {ckpt} at epoch {start + 1}")
    stopped = val is not None and bad >= patience
    for ep in range(start, epochs):
        if stopped:
            ep -= 1
            break
        model.train()
        perm = rng.permutation(len(y))
        aug = {i: preprocess(P.augment(raws[i], rng)) for i in perm}
        batches = []
        for c in range(0, len(perm), batch_size * 8):
            chunk = sorted(perm[c:c + batch_size * 8], key=lambda i: len(aug[i]))
            batches += [chunk[b:b + batch_size] for b in range(0, len(chunk), batch_size)]
        tot = 0.0
        for k in rng.permutation(len(batches)):
            idx = np.array(batches[k])
            X, M = P.pad_batch([aug[i] for i in idx])
            loss = F.cross_entropy(model(X, M), yt[idx], label_smoothing=0.1)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(idx)
        msg = f"epoch {ep + 1} loss {tot / len(y):.3f}"
        if val is not None:
            lv = logits(model, val[0])
            vloss = float(F.cross_entropy(torch.from_numpy(lv), torch.as_tensor(val[1])).item())
            vacc = float((lv.argmax(1) == np.asarray(val[1])).mean())
            curve.append({"epoch": ep + 1, "val_loss": round(vloss, 5), "val_acc": round(vacc, 4)})
            msg += f" val_loss {vloss:.3f} val_acc {vacc:.3f}"
            if vloss < best_loss - 1e-4:
                best_loss, best_state, best_ep, bad = vloss, copy.deepcopy(model.state_dict()), ep, 0
            else:
                bad += 1
        log(msg + f" ({time.time() - t0:.0f}s)")
        _ck_save(ckpt, {"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                        "np_rng": rng.bit_generator.state, "torch_rng": torch.get_rng_state(), "best_loss": best_loss,
                        "best_state": best_state, "best_ep": best_ep, "bad": bad, "curve": curve, "next_ep": ep + 1,
                        "elapsed": time.time() - t0, "n_train": len(y), "epochs": epochs})
        if val is not None and bad >= patience:
            log(f"early stop at epoch {ep + 1} (best {best_ep + 1})")
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    assert_face_blind(model)
    info = {"epochs_run": ep + 1, "best_epoch": best_ep + 1, "val_curve": curve,
            "train_seconds": round(time.time() - t0, 1), "n_train": int(len(y))}
    if val is not None:
        info["best_val_loss"] = round(best_loss, 5)
    return model.eval(), info


# ---------- stage 1: face-free self-distillation on GISLR ----------

def distill(teacher, student, raws, y250, epochs, val=None, seed=0, batch_size=64, lr=2e-4, wd=0.01,
            tau=2.0, alpha=0.5, log=print, ckpt=None):
    """Teacher = published weights on the FULL GISLR input (face included; GISLR is public CC0 data, not
    a guest). Student = the same weights on the face-free input. Loss = tau^2 KL(teacher || student at
    tau) + alpha CE(true 250-way label). Both see the same augmented clip. Keeps the epoch with the
    lowest face-free val CE on held-out GISLR participants (val = (raws, y250))."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    teacher.eval()
    steps = max(1, math.ceil(len(y250) / batch_size))
    student.late_start = 0
    opt = torch.optim.AdamW(student.parameters(), lr=lr, weight_decay=wd)
    total = epochs * steps
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: max(0.02, 0.5 * (1 + math.cos(math.pi * min(s, total) / total))))
    yt = torch.as_tensor(y250)
    best, best_state, best_ep, curve = float("inf"), None, -1, []
    t0 = time.time()
    if val is not None:
        lv = logits(student, val[0])
        v0 = float(F.cross_entropy(torch.from_numpy(lv), torch.as_tensor(val[1])).item())
        curve.append({"epoch": 0, "val_ce": round(v0, 4), "val_acc": round(float((lv.argmax(1) == val[1]).mean()), 4)})
        log(f"epoch 0 (no adaptation) val_ce {v0:.3f} val_acc {curve[-1]['val_acc']:.3f}")
        best, best_state, best_ep = v0, copy.deepcopy(student.state_dict()), 0
    start = 0
    ck = _ck_load(ckpt)
    if ck is not None:
        assert ck["n_train"] == len(y250) and ck["epochs"] == epochs, "checkpoint does not match this run"
        student.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        rng.bit_generator.state = ck["np_rng"]
        torch.set_rng_state(ck["torch_rng"])
        best, best_state, best_ep, curve, start = ck["best"], ck["best_state"], ck["best_ep"], ck["curve"], ck["next_ep"]
        t0 -= ck["elapsed"]
        log(f"resumed from {ckpt} at epoch {start + 1}")
    for ep in range(start, epochs):
        student.train()
        perm = rng.permutation(len(y250))
        T_in, S_in = {}, {}
        for i in perm:
            a = P.augment(raws[i], rng)
            T_in[i] = P.preprocess(a, drop_empty=False)
            S_in[i] = preprocess(face_free(a))
        tot = 0.0
        for b in range(0, len(perm), batch_size):
            idx = perm[b:b + batch_size]
            xt, mt = P.pad_batch([T_in[i] for i in idx])
            xs, ms = P.pad_batch([S_in[i] for i in idx])
            with torch.no_grad():
                lt = teacher(xt, mt)
            ls = student(xs, ms)
            kl = F.kl_div(F.log_softmax(ls / tau, -1), F.log_softmax(lt / tau, -1), log_target=True,
                          reduction="batchmean") * tau ** 2
            loss = kl + alpha * F.cross_entropy(ls, yt[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item() * len(idx)
        msg = f"epoch {ep + 1} loss {tot / len(perm):.3f}"
        if val is not None:
            lv = logits(student, val[0])
            v = float(F.cross_entropy(torch.from_numpy(lv), torch.as_tensor(val[1])).item())
            acc = float((lv.argmax(1) == val[1]).mean())
            curve.append({"epoch": ep + 1, "val_ce": round(v, 4), "val_acc": round(acc, 4)})
            msg += f" val_ce {v:.3f} val_acc {acc:.3f}"
            if v < best - 1e-4:
                best, best_state, best_ep = v, copy.deepcopy(student.state_dict()), ep + 1
        log(msg + f" ({time.time() - t0:.0f}s)")
        _ck_save(ckpt, {"model": student.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                        "np_rng": rng.bit_generator.state, "torch_rng": torch.get_rng_state(), "best": best,
                        "best_state": best_state, "best_ep": best_ep, "curve": curve, "next_ep": ep + 1,
                        "elapsed": time.time() - t0, "n_train": len(y250), "epochs": epochs})
    if best_state is not None:
        student.load_state_dict(best_state)
    assert_face_blind(student)
    return student.eval(), {"best_epoch": best_ep, "curve": curve, "seconds": round(time.time() - t0, 1)}

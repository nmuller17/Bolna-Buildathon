# Network, augmentation and preprocessing derived from the GISLR 1st-place solution:
# github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution
#
# MIT License
#
# Copyright (c) 2023 hoyso48
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
#
# Modified by the SignBridge contributors (2026): ported from the TensorFlow notebook to PyTorch,
# face inputs removed (see below), 6 pose points added, trained from scratch on our own recordings.
# No weights of the original solution are used. See recognition/NOTICE.
"""Face-free GISLR 1st-place network (kind "ffislr"): input, network, training.

This is "system D" of the transfer study (handoff/transfer/TRANSFER_RESULTS.md): the 1st-place
architecture and training recipe, trained from scratch on team recordings only (no third-party
weights). It is a straight port of recognition/transfer/{islr1st_port,ffislr}.py on the
talha/transfer branch, minus the pretrained-weight loader and the stage-1 distillation.

Privacy (face-free by construction, checked by tests/test_ffislr.py):
- the guest's face is never an input: drop_face() blanks it before the 6.2 normalisation,
  minimise() replaces pose 1-10 (eyes, ears, mouth) by the pose nose, and preprocess() itself
  blanks every face-mesh row again, so a caller that skips the earlier steps still cannot pass
  face geometry into the network;
- the 4 nose slots of the original 118-point input carry the POSE nose (pose 0);
- the 72 lip and eye slots are always empty (0), and their stem weights are 0 (assert_face_blind,
  checked when a checkpoint is loaded).

Original input: 118 points (40 lip, 2 x 21 hand, 4 nose, 2 x 16 eye) centred on lip point 17 and
divided by the clip's per-axis std. Here: centre = clip mean of the pose nose + OFFSET shoulder
widths, scale = R x mean shoulder width (both measured once on public GISLR clips), and 6 pose
points (shoulders, elbows, wrists) appended as 36 extra columns. Team clips are 6.2-normalised
(shoulder units); seq_to_raw maps them into GISLR-like image coordinates so the 1st-place
augmentation (rotation about the image centre, spatial masks in [0, 1]) applies unchanged.

Raw array: float32 [T, 543, 3] in GISLR row order (face 468, left hand 21, pose 33, right hand 21), NaN = missing.
"""
import copy
import math
import os
import time
import warnings

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from recognition import features

INPUT_VERSION = "ffislr-v1"

# ---------- GISLR row layout (from the 1st-place notebook) ----------

ROWS = 543
NOSE = [1, 2, 98, 327]
LNOSE, RNOSE = [98], [327]
LIP = [0, 61, 185, 40, 39, 37, 267, 269, 270, 409, 291, 146, 91, 181, 84, 17, 314, 405, 321, 375,
       78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
LLIP = [84, 181, 91, 146, 61, 185, 40, 39, 37, 87, 178, 88, 95, 78, 191, 80, 81, 82]
RLIP = [314, 405, 321, 375, 291, 409, 270, 269, 267, 317, 402, 318, 324, 308, 415, 310, 311, 312]
LPOSE, RPOSE = [513, 505, 503, 501], [512, 504, 502, 500]
REYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173]
LEYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398]
LHAND = list(range(468, 489))
RHAND = list(range(522, 543))
POINTS = LIP + LHAND + RHAND + NOSE + REYE + LEYE
MAX_LEN = 384
OFFSET = {"face": 0, "left_hand": 468, "pose": 489, "right_hand": 522}
FLIP_PAIRS = [(LHAND, RHAND), (LLIP, RLIP), (LPOSE, RPOSE), (LEYE, REYE), (LNOSE, RNOSE)]

# ---------- face-free layout (measured on 300 GISLR rerun clips, seed 0; see the transfer study) ----------

FACE_ROWS = 468                                       # GISLR rows 0-467 are the face mesh
OFFSET_SW = np.array([-0.01572, 0.12506], np.float32)  # lip 17 - pose nose, shoulder widths (y down)
R = np.array([0.17242, 0.17624], np.float32)          # original per-axis std / shoulder width
SW = 0.56569                                          # median GISLR shoulder width (image units)
MID = np.array([0.54844, 0.62221], np.float32)        # median GISLR shoulder midpoint
POSE0 = OFFSET["pose"]
NOSE_ROWS = NOSE                                      # face-mesh rows 1, 2, 98, 327 -> carry the pose nose
EXTRA_POSE = [11, 12, 13, 14, 15, 16]
EXTRA_ROWS = [POSE0 + i for i in EXTRA_POSE]
FACE_SLOTS = [i for i, r in enumerate(POINTS) if r < FACE_ROWS and r not in NOSE_ROWS]  # 72 lip + eye slots
N_PTS = len(POINTS)                                   # 118
IN_DIM = 6 * N_PTS + 6 * len(EXTRA_POSE)              # 708 + 36 = 744


def face_columns():
    """Stem input columns that carry lip/eye slots (always 0 in face-free input)."""
    cols = []
    for block in range(3):  # p, dx, dx2 for the 118 original points, each laid out [point, xy]
        for s in FACE_SLOTS:
            cols += [block * 2 * N_PTS + 2 * s, block * 2 * N_PTS + 2 * s + 1]
    return np.array(cols)


FACE_COLS = face_columns()


# ---------- face removal ----------

def drop_face(frames):
    """Frame[] / Seq -> Seq copy with the face part blanked (NaN). Applied before anything is computed."""
    seq = features.as_seq(frames)
    out = {p: a.copy() for p, a in seq.items()}
    out["face"][:] = np.nan
    return out


def minimise(seq):
    """Product privacy parity (mediapipe_adapter minimize=True): no face, pose 1-10 = pose nose."""
    s = {k: v.copy() for k, v in seq.items()}
    s["face"][:] = np.nan
    s["pose"][:, 1:11] = s["pose"][:, :1]
    return s


def face_free(raw):
    """[T,543,3] -> the same with every face-mesh row blanked (NaN) except the 4 nose slots, which get
    the POSE nose, and with pose 1-10 overwritten by the pose nose. Idempotent."""
    x = np.array(raw, dtype=np.float32, copy=True)
    x[:, :FACE_ROWS] = np.nan
    nose = x[:, POSE0]
    x[:, POSE0 + 1:POSE0 + 11] = nose[:, None]
    x[:, NOSE_ROWS] = nose[:, None]
    return x


def seq_to_raw(seq):
    """6.2-normalised Seq (shoulder units) -> face-free [T,543,3] in GISLR-like image coordinates.
    The Seq's face part is never read."""
    T = len(seq["pose"])
    x = np.full((T, ROWS, 3), np.nan, np.float32)
    x[:, POSE0:POSE0 + 33] = seq["pose"]
    x[:, OFFSET["left_hand"]:OFFSET["left_hand"] + 21] = seq["lh"]
    x[:, OFFSET["right_hand"]:OFFSET["right_hand"] + 21] = seq["rh"]
    x[..., :2] = x[..., :2] * SW + MID
    x[..., 2] = x[..., 2] * SW
    return face_free(x)


def filter_nans(x):
    keep = ~np.isnan(x[:, POINTS]).all(axis=(1, 2))
    return x[keep]


def preprocess(x, max_len=MAX_LEN):
    """[T,543,3] -> [T', IN_DIM] float32. Blanks the face itself first (face_free), so whatever the
    caller passes in the face-mesh rows or pose 1-10 cannot reach the network."""
    x = filter_nans(face_free(x))  # keeps frames with any hand or the (pose) nose
    if len(x) == 0:
        return np.zeros((1, IN_DIM), np.float32)
    with np.errstate(invalid="ignore", divide="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        l, r = x[:, POSE0 + 11, :2], x[:, POSE0 + 12, :2]
        d = np.linalg.norm(l - r, axis=1)
        sw = float(np.nanmean(d)) if np.isfinite(d).any() else np.nan
        nose = x[:, NOSE_ROWS[0], :2]
        if not np.isfinite(sw) or sw < 1e-6:
            sw = SW
        centre = (np.nanmean(nose, 0) if np.isfinite(nose).any() else MID - OFFSET_SW * SW) + OFFSET_SW * sw
        scale = R * sw
        pts = x[:, POINTS, :2].copy()
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


def prepare(frames):
    """Frame[] / Seq (raw capture coordinates) -> model input [T', IN_DIM]. Same path for train and serve:
    face dropped first, then the 6.2 normalisation, pose 1-10 := pose nose, GISLR-like coordinates."""
    seq, _ = features.normalize(drop_face(frames))
    return preprocess(seq_to_raw(minimise(seq)))


# ---------- augmentation (numpy port of the notebook's augment_fn) ----------

def _resample(x, rng, rate=(0.5, 1.5)):
    T = len(x)
    n = max(1, int(rng.uniform(*rate) * T))
    src = np.linspace(0, T - 1, n) if T > 1 else np.zeros(n)
    if rng.random() < 0.33 or T == 1:
        return x[np.round(src).astype(int)]
    i0 = np.floor(src).astype(int)
    i1 = np.minimum(i0 + 1, T - 1)
    w = (src - i0)[:, None, None]
    return x[i0] * (1 - w) + x[i1] * w


def flip_lr(x):
    x = x.copy()
    x[..., 0] = 1 - x[..., 0]
    for a, b in FLIP_PAIRS:
        x[:, a], x[:, b] = x[:, b].copy(), x[:, a].copy()
    return x


def _affine(x, rng):
    x = x.copy()
    center = np.array([0.5, 0.5], np.float32)
    x *= rng.uniform(0.8, 1.2)
    sh = rng.uniform(-0.15, 0.15)
    sx, sy = (0.0, sh) if rng.random() < 0.5 else (sh, 0.0)
    xy = x[..., :2] @ np.array([[1, sx], [sy, 1]], np.float32)
    center = center + np.array([sy, sx], np.float32)
    r = np.deg2rad(rng.uniform(-30, 30))
    c, s = math.cos(r), math.sin(r)
    xy = (xy - center) @ np.array([[c, s], [-s, c]], np.float32) + center
    x[..., :2] = xy
    return x + rng.uniform(-0.1, 0.1)


def _temporal_mask(x, rng):
    T = len(x)
    n = int(T * rng.uniform(0.2, 0.4))
    o = rng.integers(0, max(1, T - n))
    x = x.copy()
    x[o:o + n] = np.nan
    return x


def _spatial_mask(x, rng):
    ox, oy, s = rng.random(), rng.random(), rng.uniform(0.2, 0.4)
    m = (x[..., 0] > ox) & (x[..., 0] < ox + s) & (x[..., 1] > oy) & (x[..., 1] < oy + s)
    x = x.copy()
    x[m] = np.nan
    return x


def augment(x, rng, max_len=MAX_LEN):
    x = filter_nans(x)
    if len(x) == 0:
        return x
    if rng.random() < 0.8:
        x = _resample(x, rng)
    if rng.random() < 0.5:
        x = flip_lr(x)
    if len(x) > max_len:
        o = rng.integers(0, len(x) - max_len + 1)
        x = x[o:o + max_len]
    if rng.random() < 0.75:
        x = _affine(x, rng)
    if rng.random() < 0.5:
        x = _temporal_mask(x, rng)
    if rng.random() < 0.5:
        x = _spatial_mask(x, rng)
    return x.astype(np.float32)


def pad_batch(arrs):
    T = max(len(a) for a in arrs)
    X = np.zeros((len(arrs), T, arrs[0].shape[1]), np.float32)
    M = np.zeros((len(arrs), T), bool)
    for i, a in enumerate(arrs):
        X[i, :len(a)] = a
        M[i, :len(a)] = True
    return torch.from_numpy(X), torch.from_numpy(M)


# ---------- network (get_model(dim=192) of the notebook) ----------

class MaskedBN(nn.Module):
    """BatchNorm over channels using only unpadded frames (Keras momentum 0.95 -> torch 0.05, eps 1e-3)."""

    def __init__(self, c, momentum=0.05, eps=1e-3):
        super().__init__()
        self.bn = nn.BatchNorm1d(c, momentum=momentum, eps=eps)

    def forward(self, x, mask):
        out = torch.zeros_like(x)
        out[mask] = self.bn(x[mask]) if (not self.training or mask.sum() > 1) else x[mask]
        return out


def masked_mean(x, mask):
    m = mask.unsqueeze(-1).to(x.dtype)
    return (x * m).sum(1) / m.sum(1).clamp_min(1.0)


class SampleDropout(nn.Module):
    """Dropout with noise_shape (B,1,1): drops a whole residual branch per sample."""

    def __init__(self, p):
        super().__init__()
        self.p = p

    def forward(self, x):
        if not self.training or self.p == 0:
            return x
        keep = (torch.rand(x.shape[0], 1, 1) >= self.p).to(x.dtype)
        return x * keep / (1 - self.p)


class ECA(nn.Module):
    def __init__(self, k=5):
        super().__init__()
        self.conv = nn.Conv1d(1, 1, k, padding=k // 2, bias=False)

    def forward(self, x, mask):
        g = torch.sigmoid(self.conv(masked_mean(x, mask).unsqueeze(1))).squeeze(1)
        return x * g.unsqueeze(1)


class Conv1DBlock(nn.Module):
    def __init__(self, dim, k=17, drop=0.2, expand=2):
        super().__init__()
        self.expand = nn.Linear(dim, dim * expand)
        self.k = k
        self.dw = nn.Conv1d(dim * expand, dim * expand, k, groups=dim * expand, bias=False)
        self.bn = MaskedBN(dim * expand)
        self.eca = ECA()
        self.project = nn.Linear(dim * expand, dim)
        self.drop = SampleDropout(drop)

    def forward(self, x, mask):
        h = F.silu(self.expand(x))
        h = self.dw(F.pad(h.transpose(1, 2), (self.k - 1, 0))).transpose(1, 2)  # causal depthwise
        h = self.eca(self.bn(h, mask), mask)
        return x + self.drop(self.project(h))


class MHSA(nn.Module):
    def __init__(self, dim, heads=4, attn_drop=0.2):
        super().__init__()
        self.dim, self.heads, self.scale = dim, heads, dim ** -0.5  # notebook scales by full dim
        self.qkv = nn.Linear(dim, 3 * dim, bias=False)
        self.proj = nn.Linear(dim, dim, bias=False)
        self.drop = nn.Dropout(attn_drop)

    def forward(self, x, mask):
        B, T, _ = x.shape
        qkv = self.qkv(x).reshape(B, T, self.heads, 3 * self.dim // self.heads).permute(0, 2, 1, 3)
        q, k, v = qkv.split(self.dim // self.heads, dim=-1)
        att = (q @ k.transpose(-1, -2)) * self.scale
        att = att.masked_fill(~mask[:, None, None, :], float("-inf"))
        att = self.drop(att.softmax(-1))
        return self.proj((att @ v).permute(0, 2, 1, 3).reshape(B, T, self.dim))


class TransformerBlock(nn.Module):
    def __init__(self, dim, expand=2, drop=0.2):
        super().__init__()
        self.bn1, self.bn2 = MaskedBN(dim), MaskedBN(dim)
        self.att = MHSA(dim)
        self.ff1 = nn.Linear(dim, dim * expand, bias=False)
        self.ff2 = nn.Linear(dim * expand, dim, bias=False)
        self.d1, self.d2 = SampleDropout(drop), SampleDropout(drop)

    def forward(self, x, mask):
        x = x + self.d1(self.att(self.bn1(x, mask), mask))
        return x + self.d2(self.ff2(F.silu(self.ff1(self.bn2(x, mask)))))


class ISLR1st(nn.Module):
    """get_model(dim=192). forward(x [B,T,in_dim], mask [B,T] bool) -> logits."""

    def __init__(self, in_dim=IN_DIM, n_classes=250, dim=192, late_dropout_start=0):
        super().__init__()
        self.stem = nn.Linear(in_dim, dim, bias=False)
        self.stem_bn = MaskedBN(dim)
        blocks = []
        for _ in range(2):
            blocks += [Conv1DBlock(dim), Conv1DBlock(dim), Conv1DBlock(dim), TransformerBlock(dim)]
        self.blocks = nn.ModuleList(blocks)
        self.top = nn.Linear(dim, 2 * dim)
        self.late = nn.Dropout(0.8)
        self.late_start = late_dropout_start
        self.register_buffer("steps", torch.zeros((), dtype=torch.long))
        self.cls = nn.Linear(2 * dim, n_classes)

    def forward(self, x, mask=None):
        if mask is None:
            mask = torch.ones(x.shape[:2], dtype=torch.bool)
        h = self.stem_bn(self.stem(x), mask)
        for b in self.blocks:
            h = b(h, mask)
        h = masked_mean(self.top(h), mask)
        if self.training:
            if self.steps >= self.late_start:
                h = self.late(h)
            self.steps += 1
        return self.cls(h)


def new_model(n_classes, late_dropout_start=0):
    return ISLR1st(in_dim=IN_DIM, n_classes=n_classes, late_dropout_start=late_dropout_start)


def zero_face_columns(model):
    with torch.no_grad():
        model.stem.weight[:, torch.from_numpy(FACE_COLS)] = 0.0


def assert_face_blind(model):
    w = model.stem.weight.detach()[:, torch.from_numpy(FACE_COLS)]
    if float(w.abs().max()) != 0.0:
        raise ValueError("stem weights on lip/eye columns are not zero (not a face-free ffislr model)")


def n_params(model):
    return int(sum(p.numel() for p in model.parameters()))


def logits(model, raws, batch=64):
    """Unaugmented logits for a list of raw arrays (length-bucketed, masked: output-neutral)."""
    model.eval()
    X = [preprocess(r) for r in raws]
    order = np.argsort([len(a) for a in X])
    out = np.zeros((len(X), model.cls.out_features), np.float32)
    with torch.inference_mode():
        for b in range(0, len(order), batch):
            idx = order[b:b + batch]
            xb, mb = pad_batch([X[i] for i in idx])
            out[idx] = model(xb, mb).numpy()
    return out


# ---------- resumable training checkpoints (a killed job costs at most one epoch) ----------

def _ck_save(path, state):
    if path is None:
        return
    tmp = str(path) + ".tmp"
    torch.save(state, tmp)
    os.replace(tmp, path)


def _ck_load(path):
    if path is None or not os.path.exists(path):
        return None
    return torch.load(path, map_location="cpu", weights_only=False)  # our own resume file, never a shipped model


# ---------- training: the 1st-place recipe (minus AWP) on face-free input ----------

def train(raws, y, n_classes, epochs, seed=0, batch_size=64, lr=5e-4, wd=0.1, lr_min=1e-6,
          late_epochs=15, val=None, patience=12, log=print, ckpt=None):
    """From-scratch training (system D). AdamW, per-step cosine decay to lr_min over `epochs`, label
    smoothing 0.1, late dropout from epoch `late_epochs`. Without val: exactly `epochs` epochs (refit).
    With val=(raws_val, y_val): unaugmented val loss after every epoch, keep the lowest (improvement
    > 1e-4), stop after `patience` epochs without improvement (as recognition.train.train_model)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    steps = max(1, math.ceil(len(y) / batch_size))
    model = new_model(n_classes, late_dropout_start=late_epochs * steps)
    zero_face_columns(model)
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
        aug = {i: preprocess(augment(raws[i], rng)) for i in perm}
        batches = []
        for c in range(0, len(perm), batch_size * 8):
            chunk = sorted(perm[c:c + batch_size * 8], key=lambda i: len(aug[i]))
            batches += [chunk[b:b + batch_size] for b in range(0, len(chunk), batch_size)]
        tot = 0.0
        for k in rng.permutation(len(batches)):
            idx = np.array(batches[k])
            X, M = pad_batch([aug[i] for i in idx])
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

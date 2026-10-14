# Copied from recognition/compare/islr1st.py (read-only there; owned by the benchmark workflow) on 2026-10-11,
# plus load_keras() from recognition/compare/check_islr1st_port.py. Unchanged apart from this header.
#
# Derived from github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution:
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
"""PyTorch re-implementation of the GISLR 1st-place model (hoyso48, Kaggle 2023, MIT licence).

Source: github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution
(one TensorFlow notebook). Ported here: the 130-point preprocessing (40 lip, 2x21 hand, 4 nose,
2x16 eye points; centred on face point 17, divided by the clip's std, x/y plus 1- and 2-frame
differences), its augmentation, and get_model(dim=192): stem, 2 x (3 Conv1DBlock + 1
TransformerBlock), top dense, masked average pool, late dropout 0.8, classifier.

Deliberate differences from the original (all because of CPU time and data size):
- one seed instead of an ensemble of 4, batch 64 on one device instead of 8 x 64 on a TPU;
- no AWP (adversarial weight perturbation), no fp16;
- far fewer optimisation steps (at most 60 epochs, chosen by nested early stopping on an inner
  training signer; see PROTOCOL.md) on ~1,000 clips instead of 94k;
- time resampling uses linear or nearest interpolation (bicubic dropped);
- BatchNorm statistics ignore padded frames (Keras masking behaviour is version dependent);
- batches are bucketed by clip length (less padding on CPU; masking makes this output-neutral).

Raw input: float32 [T, 543, 3] in GISLR row order (face 468, left hand 21, pose 33, right hand 21), NaN = missing.
"""
import copy
import math
import warnings

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

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
IN_DIM = 6 * len(POINTS)  # 780
MAX_LEN = 384
OFFSET = {"face": 0, "left_hand": 468, "pose": 489, "right_hand": 522}
FLIP_PAIRS = [(LHAND, RHAND), (LLIP, RLIP), (LPOSE, RPOSE), (LEYE, REYE), (LNOSE, RNOSE)]


def load_raw(path):
    """GISLR parquet -> float32 [T, 543, 3] (frames sorted, rows placed by type + landmark_index)."""
    import pandas as pd
    df = pd.read_parquet(path, columns=["frame", "type", "landmark_index", "x", "y", "z"])
    frames = np.sort(df["frame"].unique())
    pos = {f: i for i, f in enumerate(frames)}
    a = np.full((len(frames), ROWS, 3), np.nan, np.float32)
    row = df["type"].map(OFFSET).to_numpy() + df["landmark_index"].to_numpy().astype(int)
    a[df["frame"].map(pos).to_numpy(), row] = df[["x", "y", "z"]].to_numpy(np.float32)
    return a


def filter_nans(x):
    keep = ~np.isnan(x[:, POINTS]).all(axis=(1, 2))
    return x[keep]


def preprocess(x, max_len=MAX_LEN, drop_empty=True):
    """[T, 543, 3] -> [T', 780] float32 (T' <= max_len), as Preprocess() in the notebook.
    drop_empty removes frames without any of the 130 points (the notebook does this when it
    decodes a clip, i.e. before augmentation; frames blanked by temporal_mask are kept)."""
    if drop_empty:
        x = filter_nans(x)
    if len(x) == 0:
        return np.zeros((1, IN_DIM), np.float32)
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(x[:, [17]], axis=(0, 1), keepdims=True)  # [1,1,3]
        mean = np.where(np.isnan(mean), 0.5, mean)
        p = x[:, POINTS]
        std = np.sqrt(np.nanmean((p - mean) ** 2, axis=(0, 1), keepdims=True))
    p = ((p - mean) / std)[:max_len, :, :2]
    T = len(p)
    dx = np.zeros_like(p)
    dx2 = np.zeros_like(p)
    if T > 1:
        dx[:-1] = p[1:] - p[:-1]
    if T > 2:
        dx2[:-2] = p[2:] - p[:-2]
    out = np.concatenate([p.reshape(T, -1), dx.reshape(T, -1), dx2.reshape(T, -1)], axis=1)
    return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


# ---------- augmentation (numpy port of augment_fn) ----------

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


# ---------- model ----------

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


class ISLR1stOnOurFeatures(nn.Module):
    """The same network on OUR 141-D features, with the same input step as SignGRU
    (standardise with mu/sd, append the temporal difference), so only the network differs."""

    def __init__(self, in_dim, n_classes, late_dropout_start=0):
        super().__init__()
        self.register_buffer("mu", torch.zeros(in_dim))
        self.register_buffer("sd", torch.ones(in_dim))
        self.net = ISLR1st(in_dim=2 * in_dim, n_classes=n_classes, late_dropout_start=late_dropout_start)

    def forward(self, x):
        x = (x - self.mu) / self.sd
        v = torch.diff(x, dim=1, prepend=x[:, :1])
        return self.net(torch.cat([x, v], dim=-1))


def train_own_recipe(X_raw, y, n_classes, epochs, seed=0, batch_size=64, lr=5e-4, wd=0.1,
                     lr_min=1e-6, late_epochs=15, val=None, patience=12, log=print):
    """Train ISLR1st on raw [T,543,3] arrays with the notebook's recipe (minus AWP): AdamW, cosine
    decay per step to lr_min over `epochs`, label smoothing 0.1, late dropout from epoch 15.

    Without val: exactly `epochs` epochs (the refit). With val=(X_raw_val, y_val): the same nested
    rule as recognition.train.train_model (PROTOCOL.md): after every epoch the unaugmented
    validation loss (cross-entropy, no smoothing) is computed; the state with the lowest loss
    (improvement > 1e-4) is kept and training stops after `patience` epochs without improvement.
    Returns (model in eval mode, info) where info has best_epoch, epochs_run and the val curve."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    steps_per_epoch = max(1, math.ceil(len(y) / batch_size))
    model = ISLR1st(n_classes=n_classes, late_dropout_start=late_epochs * steps_per_epoch)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd)
    total = epochs * steps_per_epoch
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: (lr_min + 0.5 * (lr - lr_min) * (1 + math.cos(math.pi * min(s, total) / total))) / lr)
    yt = torch.as_tensor(y)
    best_loss, best_state, best_ep, bad, curve = float("inf"), None, epochs - 1, 0, []
    ep = -1
    for ep in range(epochs):
        model.train()
        perm = rng.permutation(len(y))
        aug = {i: preprocess(augment(X_raw[i], rng), drop_empty=False) for i in perm}
        batches = []
        for c in range(0, len(perm), batch_size * 8):  # bucket: sort by length inside chunks of 8 batches
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
            model.eval()
            lv = predict_logits(model, val[0])
            vloss = float(F.cross_entropy(torch.from_numpy(lv), torch.as_tensor(val[1])).item())
            vacc = float((lv.argmax(1) == np.asarray(val[1])).mean())
            curve.append({"epoch": ep + 1, "val_loss": round(vloss, 5), "val_acc": round(vacc, 4)})
            msg += f" val_loss {vloss:.3f} val_acc {vacc:.3f}"
            if vloss < best_loss - 1e-4:
                best_loss, best_state, best_ep, bad = vloss, copy.deepcopy(model.state_dict()), ep, 0
            else:
                bad += 1
            model.train()
        log(msg)
        if val is not None and bad >= patience:
            log(f"early stop at epoch {ep + 1} (best {best_ep + 1})")
            break
    if best_state is not None:
        model.load_state_dict(best_state)
    info = {"epochs_run": ep + 1, "best_epoch": best_ep + 1, "val_curve": curve}
    if val is not None:
        info["best_val_loss"] = round(best_loss, 5)
    return model.eval(), info


def predict_logits(model, X_raw):
    out = []
    with torch.inference_mode():
        for x in X_raw:
            X, M = pad_batch([preprocess(x)])
            out.append(model(X, M).numpy()[0])
    return np.stack(out)


def load_keras(npz):
    """Published Keras weights (Kaggle hoyso48/islr-models, seed 42 .h5, converted to .npz) -> ISLR1st(250).
    Copied from recognition/compare/check_islr1st_port.py."""
    w = {k.replace("|", "/"): v for k, v in np.load(npz).items()}
    g = lambda name: torch.from_numpy(w[name].astype(np.float32))
    m = ISLR1st(n_classes=250)

    def bn(mod, prefix):
        mod.bn.weight.data, mod.bn.bias.data = g(f"{prefix}/gamma:0"), g(f"{prefix}/beta:0")
        mod.bn.running_mean.data, mod.bn.running_var.data = g(f"{prefix}/moving_mean:0"), g(f"{prefix}/moving_variance:0")

    m.stem.weight.data = g("stem_conv/stem_conv/kernel:0").T
    bn(m.stem_bn, "stem_bn/stem_bn")
    convs = [b for b in m.blocks if isinstance(b, Conv1DBlock)]
    trans = [b for b in m.blocks if isinstance(b, TransformerBlock)]
    for i, b in enumerate(convs, 1):
        b.expand.weight.data, b.expand.bias.data = g(f"{i}_expand_conv/{i}_expand_conv/kernel:0").T, g(f"{i}_expand_conv/{i}_expand_conv/bias:0")
        b.dw.weight.data = g(f"{i}_dwconv/{i}_dwconv/{i}_dwconv_dwconv/depthwise_kernel:0")[:, :, 0].T.unsqueeze(1).contiguous()
        bn(b.bn, f"{i}_bn/{i}_bn")
        eca = "eca" if i == 1 else f"eca_{i - 1}"
        b.eca.conv.weight.data = g(f"{eca}/{eca}/conv1d/kernel:0")[:, 0, 0].reshape(1, 1, -1)
        b.project.weight.data, b.project.bias.data = g(f"{i}_project_conv/{i}_project_conv/kernel:0").T, g(f"{i}_project_conv/{i}_project_conv/bias:0")
    for j, b in enumerate(trans):
        bn(b.bn1, f"batch_normalization{'' if j == 0 else '_' + str(2 * j)}/batch_normalization{'' if j == 0 else '_' + str(2 * j)}")
        bn(b.bn2, f"batch_normalization_{2 * j + 1}/batch_normalization_{2 * j + 1}")
        mh = "multi_head_self_attention" + ("" if j == 0 else "_1")
        b.att.qkv.weight.data = g(f"{mh}/{mh}/dense{'' if j == 0 else '_4'}/kernel:0").T
        b.att.proj.weight.data = g(f"{mh}/{mh}/dense_{1 if j == 0 else 5}/kernel:0").T
        b.ff1.weight.data = g(f"dense_{2 if j == 0 else 6}/dense_{2 if j == 0 else 6}/kernel:0").T
        b.ff2.weight.data = g(f"dense_{3 if j == 0 else 7}/dense_{3 if j == 0 else 7}/kernel:0").T
    m.top.weight.data, m.top.bias.data = g("top_conv/top_conv/kernel:0").T, g("top_conv/top_conv/bias:0")
    m.cls.weight.data, m.cls.bias.data = g("classifier/classifier/kernel:0").T, g("classifier/classifier/bias:0")
    return m.eval()

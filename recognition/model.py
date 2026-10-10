"""GRU sign classifier (22 classes, CLAUDE.md 8.2), a non-deep baseline, checkpoints, predictor.

Both models take [B, T, D] features and return logits, and both can be saved and served."""
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from recognition import features
from recognition.labels import CLASSES


class SignGRU(nn.Module):
    """[B, T, D] features -> [B, n_classes] logits.

    Standardize, concat temporal velocity, project, 2-layer BiGRU, mean+max pool, MLP.
    """

    def __init__(self, in_dim=features.FEATURE_DIM, n_classes=len(CLASSES), hidden=128, dropout=0.3):
        super().__init__()
        self.register_buffer("mu", torch.zeros(in_dim))
        self.register_buffer("sd", torch.ones(in_dim))
        self.proj = nn.Sequential(nn.Linear(2 * in_dim, hidden), nn.LayerNorm(hidden), nn.GELU(), nn.Dropout(0.1))
        self.gru = nn.GRU(hidden, hidden, num_layers=2, batch_first=True, bidirectional=True, dropout=dropout)
        self.head = nn.Sequential(nn.Linear(4 * hidden, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, n_classes))

    def forward(self, x):
        x = (x - self.mu) / self.sd
        v = torch.diff(x, dim=1, prepend=x[:, :1])
        h, _ = self.gru(self.proj(torch.cat([x, v], dim=-1)))
        return self.head(torch.cat([h.mean(1), h.amax(1)], dim=-1))


class Baseline(nn.Module):
    """Non-deep baseline: multinomial logistic regression on per-take mean, std, min, max of each
    feature plus the mean of each third of the take (so it sees the direction of movement)."""

    N_STATS = 7

    def __init__(self, in_dim=features.FEATURE_DIM, n_classes=len(CLASSES)):
        super().__init__()
        self.register_buffer("mu", torch.zeros(self.N_STATS * in_dim))
        self.register_buffer("sd", torch.ones(self.N_STATS * in_dim))
        self.lin = nn.Linear(self.N_STATS * in_dim, n_classes)
        self.temperature = 1.0

    @staticmethod
    def stats(x):
        thirds = [c.mean(1) for c in torch.tensor_split(x, 3, dim=1)]
        return torch.cat([x.mean(1), x.std(1, unbiased=False), x.amin(1), x.amax(1), *thirds], dim=-1)

    def forward(self, x):
        return self.lin((self.stats(x) - self.mu) / self.sd)

    def fit(self, X, y, weight_decay=1e-3, steps=300, seed=0):
        """Full-batch L-BFGS fit on numpy X [N, T, D], y [N]."""
        torch.manual_seed(seed)
        S = self.stats(torch.from_numpy(X))
        self.mu.copy_(S.mean(0))
        self.sd.copy_(S.std(0, unbiased=False) + 1e-6)
        Z = (S - self.mu) / self.sd
        t = torch.from_numpy(y)
        opt = torch.optim.LBFGS(self.lin.parameters(), max_iter=steps, line_search_fn="strong_wolfe")

        def closure():
            opt.zero_grad()
            loss = F.cross_entropy(self.lin(Z), t) + weight_decay * self.lin.weight.pow(2).sum()
            loss.backward()
            return loss
        opt.step(closure)
        return self.eval()

    def logits(self, X):
        with torch.inference_mode():
            return self(torch.from_numpy(X)).numpy()


T_MIN, T_MAX = 1.0, 10.0


def fit_temperature(logits, y):
    """Scalar T minimizing NLL of softmax(logits / T) on held-out data, clipped to [T_MIN, T_MAX].

    T_MIN = 1: the temperature may only soften an overconfident model, never sharpen it.
    With one (near) perfectly classified val signer the NLL keeps falling as T -> 0, and
    sharpening on such a split pushed wrong answers for a harder new signer over 0.6.
    """
    lg = torch.tensor(logits, dtype=torch.float32)
    t = torch.tensor(y, dtype=torch.long)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], max_iter=100, line_search_fn="strong_wolfe")

    def closure():
        opt.zero_grad()
        loss = F.cross_entropy(lg / log_t.exp(), t)
        loss.backward()
        return loss
    opt.step(closure)
    return float(np.clip(log_t.exp().item(), T_MIN, T_MAX))


def softmax(logits, temperature=1.0):
    z = logits / temperature
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def save_checkpoint(path, model, temperature=1.0, T=features.T_DEFAULT, meta=None):
    torch.save({
        "kind": "baseline" if isinstance(model, Baseline) else "gru",
        "state_dict": model.state_dict(),
        "classes": list(CLASSES),
        "feature_version": features.FEATURE_VERSION,
        "feature_dim": features.FEATURE_DIM,
        "T": T,
        "temperature": float(temperature),
        "meta": meta or {},
    }, path)


def load_checkpoint(path):
    """Returns (model in eval mode, checkpoint dict). Refuses a mismatched label set or feature layout.

    weights_only=True: a checkpoint is tensors and plain metadata, never code (a pickled .pt
    shared over chat could otherwise run anything at server start)."""
    ck = torch.load(path, map_location="cpu", weights_only=True)
    if ck.get("kind") not in ("gru", "baseline"):
        raise ValueError("checkpoint has no model kind (made by an older train.py); retrain it")
    if ck["classes"] != list(CLASSES):
        raise ValueError(f"checkpoint classes differ from recognition/labels.py: {ck['classes']}")
    if ck["feature_version"] != features.FEATURE_VERSION:
        raise ValueError(f"checkpoint feature layout {ck['feature_version']} != {features.FEATURE_VERSION}; retrain it")
    cls = Baseline if ck["kind"] == "baseline" else SignGRU
    model = cls(in_dim=ck["feature_dim"], n_classes=len(ck["classes"]))
    model.load_state_dict(ck["state_dict"])
    model.eval()
    return model, ck


class Predictor:
    """Loads a checkpoint once and turns one Frame[] segment into calibrated class probabilities."""

    def __init__(self, path):
        self.model, self.ck = load_checkpoint(path)
        self.T, self.temperature = self.ck["T"], self.ck["temperature"]

    def probs(self, frames):
        x = torch.from_numpy(features.prepare(frames, self.T))[None]
        with torch.inference_mode():
            logits = self.model(x).numpy()[0]
        return softmax(logits, self.temperature)

    def top(self, frames, k=3):
        p = self.probs(frames)
        order = np.argsort(-p)[:k]
        return [{"label": CLASSES[i], "conf": float(p[i])} for i in order]

    def time_forward(self, frames, n=200):
        """Model forward latency (ms) on one prepared segment: returns list of n timings."""
        x = torch.from_numpy(features.prepare(frames, self.T))[None]
        out = []
        with torch.inference_mode():
            for _ in range(10):
                self.model(x)
            for _ in range(n):
                t0 = time.perf_counter()
                self.model(x)
                out.append((time.perf_counter() - t0) * 1000)
        return out

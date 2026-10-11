"""Cheap landmark baseline for training-take QC: dynamic time warping (DTW) on hand trajectories.

Input is the landmark JSON written by capture/train_session.py (one per take, already shoulder
centred and shoulder-width scaled by capture.landmarks.normalize, then trimmed / forward-filled /
smoothed by capture.clean). Reference videos get the same treatment through ref_landmarks.py.

Per frame we keep both hands, 21 points each, x and y only (z from MediaPipe is relative to the
wrist and noisy). Distance between two frames = mean over the two hands of
  - mean point-to-point distance (shoulder-width units) when the hand is present in both frames,
  - MISSING_PENALTY when it is present in only one of them,
  - 0 when it is absent in both.
DTW finds the cheapest monotone alignment of the two sequences; the score is the total cost
divided by the alignment length, so long and short takes are comparable.

Three scores per take (higher = more suspicious):
  ref_dtw   - DTW to the reference video of the sign (different signer: the reference signer).
  pool_dtw  - median DTW to the same person's OTHER takes of the same sign. Needs no reference,
              but assumes most of that person's takes are right.
  ref_rel   - ref_dtw divided by the median ref_dtw of the same person's takes of that sign, so
              one threshold works across signs that are naturally far from / close to the reference.
Only numpy; no model.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

MISSING_PENALTY = 0.5   # shoulder widths; a hand seen in one frame but not the other
HANDS = ("lh", "rh")


def load_frames(path: str | Path) -> list[dict]:
    d = json.loads(Path(path).read_text())
    return d["frames"] if isinstance(d, dict) else d


def to_array(frames: list[dict], mirror: bool = False) -> np.ndarray:
    """(T, 2, 21, 2) float array, hands (lh, rh) x points x (x, y); NaN where a hand is missing.
    mirror=True swaps left/right hands and negates x (a mirrored recording)."""
    T = len(frames)
    out = np.full((T, 2, 21, 2), np.nan, dtype=np.float64)
    for t, f in enumerate(frames):
        for h, key in enumerate(HANDS):
            pts = f.get(key) if f else None
            if pts:
                a = np.asarray(pts, dtype=np.float64)[:21, :2]
                if a.shape == (21, 2):
                    out[t, h] = a
    if mirror:
        out = out[:, ::-1].copy()
        out[..., 0] *= -1.0
    return out


FEATURES = ("all", "wrist", "shape")


def select(a: np.ndarray, features: str = "all") -> np.ndarray:
    """Pick what the distance looks at.
    all   - all 21 points in shoulder coordinates (hand location + handshape together),
    wrist - only the wrist point (hand location / path),
    shape - all 21 points relative to the wrist (handshape and finger motion, not location)."""
    if features == "all":
        return a
    if features == "wrist":
        return a[:, :, :1]
    if features == "shape":
        return a - a[:, :, :1]
    raise ValueError(f"features must be one of {FEATURES}, got {features!r}")


def frame_costs(a: np.ndarray, b: np.ndarray, missing_penalty: float = MISSING_PENALTY) -> np.ndarray:
    """(Ta, Tb) frame-to-frame cost matrix for two (T, 2, K, 2) arrays."""
    Ta, Tb = len(a), len(b)
    total = np.zeros((Ta, Tb))
    for h in range(2):
        A, B = a[:, h], b[:, h]                       # (T, K, 2)
        pa = ~np.isnan(A[:, 0, 0])
        pb = ~np.isnan(B[:, 0, 0])
        both = pa[:, None] & pb[None, :]
        one = pa[:, None] ^ pb[None, :]
        c = np.zeros((Ta, Tb))
        if both.any():
            A0 = np.nan_to_num(A)
            B0 = np.nan_to_num(B)
            d = np.linalg.norm(A0[:, None] - B0[None, :], axis=-1).mean(-1)   # (Ta, Tb)
            c = np.where(both, d, 0.0)
        c = c + np.where(one, missing_penalty, 0.0)
        total += c
    return total / 2.0


def dtw(cost: np.ndarray) -> float:
    """Classic DTW on a cost matrix; returns total cost / alignment length (inf when empty)."""
    Ta, Tb = cost.shape
    if Ta == 0 or Tb == 0:
        return float("inf")
    D = np.full((Ta + 1, Tb + 1), np.inf)
    L = np.zeros((Ta + 1, Tb + 1), dtype=np.int64)
    D[0, 0] = 0.0
    for i in range(1, Ta + 1):
        ci = cost[i - 1]
        Di, Dp, Li, Lp = D[i], D[i - 1], L[i], L[i - 1]
        for j in range(1, Tb + 1):
            # predecessors: diagonal, up, left
            d0, d1, d2 = Dp[j - 1], Dp[j], Di[j - 1]
            if d0 <= d1 and d0 <= d2:
                best, ln = d0, Lp[j - 1]
            elif d1 <= d2:
                best, ln = d1, Lp[j]
            else:
                best, ln = d2, Li[j - 1]
            Di[j] = best + ci[j - 1]
            Li[j] = ln + 1
    return float(D[Ta, Tb] / max(1, L[Ta, Tb]))


def dtw_distance(a: np.ndarray, b: np.ndarray, stride: int = 1,
                 missing_penalty: float = MISSING_PENALTY, features: str = "all") -> float:
    """Length-normalised DTW between two (T, 2, 21, 2) arrays. stride>1 subsamples in time."""
    a, b = select(a, features), select(b, features)
    if stride > 1:
        a, b = a[::stride], b[::stride]
    return dtw(frame_costs(a, b, missing_penalty))


def pool_median(dists_to_others: list[float]) -> float:
    vals = [d for d in dists_to_others if np.isfinite(d)]
    return float(np.median(vals)) if vals else float("inf")


def auc(pos_scores, neg_scores) -> float | None:
    """Probability a random positive (suspicious) scores above a random negative; ties count 1/2.
    None when either side is empty."""
    p = np.asarray([s for s in pos_scores if s is not None], dtype=float)
    n = np.asarray([s for s in neg_scores if s is not None], dtype=float)
    if len(p) == 0 or len(n) == 0:
        return None
    gt = (p[:, None] > n[None, :]).sum()
    eq = (p[:, None] == n[None, :]).sum()
    return float((gt + 0.5 * eq) / (len(p) * len(n)))

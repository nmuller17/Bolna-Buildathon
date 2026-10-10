"""Frames -> feature array: 6.2 normalization, mirroring, augmentation, fixed layout.

The server computes features from raw Frame[] itself, so the browser only needs the
6.2 normalization (web/lib/recognition/features.ts), not this feature layout.

Internally a sequence is a Seq: dict of float32 arrays, NaN where a part is missing.
    pose [T,33,3]   lh [T,21,3]   rh [T,21,3]   face [T,26,3]

Feature layout v2, one row per frame (D = 141):
    [0:63)    left hand:  wrist x,y | 20 joints minus wrist (x,y,z) | present
    [63:126)  right hand: same
    [126:141) pose 0,11,12,13,14,15,16 (nose, shoulders, elbows, wrists) x,y | present
Face landmarks are not features (privacy, and a client may send face: null); the
pose nose is kept as the only head reference. Only hand-relative z is used (pose z and
the wrist's absolute z are noisy). Hands are assigned to lh/rh by the nearest pose wrist,
so the landmarker's handedness labels do not matter. A missing hand is forward-filled
from its last real observation for up to HAND_FFILL frames, else zeros + present 0.
"""
import numpy as np

PARTS = {"pose": 33, "lh": 21, "rh": 21, "face": 26}
FACE_INDICES = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 33, 133, 159, 145,
                362, 263, 386, 374, 61, 291, 0, 17, 13, 14, 1, 152]

# MediaPipe pose left/right pairs (0 = nose is on the midline).
POSE_LR = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16),
           (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
# Positions in the 26-point face order. Mesh pairs: brows 70-300, 63-293, 105-334,
# 66-296, 107-336; eyes 33-263, 133-362, 159-386, 145-374; mouth corners 61-291.
# 0, 17, 13, 14 (lips), 1 (nose tip), 152 (chin) are on the midline.
FACE_LR = [(0, 9), (1, 8), (2, 7), (3, 6), (4, 5), (10, 15), (11, 14), (12, 16), (13, 17), (18, 19)]

FEATURE_VERSION = "v2"
T_DEFAULT = 32
HAND_FFILL = 5
POSE_SUBSET = [0, 11, 12, 13, 14, 15, 16]
HAND_DIM = 2 + 20 * 3 + 1
FEATURE_DIM = 2 * HAND_DIM + (2 * len(POSE_SUBSET) + 1)


def to_seq(frames):
    """Frame[] (or a SignFile dict with "frames") -> Seq. Malformed parts become NaN."""
    if isinstance(frames, dict) and "frames" in frames:
        frames = frames["frames"]
    T = len(frames)
    seq = {p: np.full((T, n, 3), np.nan, np.float32) for p, n in PARTS.items()}
    for t, f in enumerate(frames):
        for p, n in PARTS.items():
            pts = f.get(p) if isinstance(f, dict) else None
            if pts is None:
                continue
            try:
                a = np.asarray(pts, dtype=np.float32)
            except (ValueError, TypeError):
                continue
            if a.shape == (n, 3):
                seq[p][t] = a
    return seq


def as_seq(x):
    return x if isinstance(x, dict) and "pose" in x and isinstance(x["pose"], np.ndarray) else to_seq(x)


def seq_len(seq):
    return len(seq["pose"])


def seq_to_frames(seq, ndigits=None):
    """Seq -> Frame[] (JSON-ready). A part with any NaN is written as null."""
    out = []
    for t in range(seq_len(seq)):
        f = {}
        for p in PARTS:
            a = seq[p][t]
            if not np.isfinite(a).all():
                f[p] = None
            elif ndigits is None:
                f[p] = a.tolist()
            else:
                f[p] = np.round(a.astype(np.float64), ndigits).tolist()
        out.append(f)
    return out


def assign_hands(seq):
    """Give each hand to lh or rh by the nearer pose wrist (15 = left, 16 = right), per frame.

    MediaPipe handedness labels depend on image mirroring and may differ between Python
    Holistic and tasks-vision; the pose wrists follow the arms. Frames without both pose
    wrists keep their labels.
    """
    lh, rh = seq["lh"].copy(), seq["rh"].copy()
    pl, pr = seq["pose"][:, 15, :2], seq["pose"][:, 16, :2]
    hl, hr = np.isfinite(lh[:, 0, :2]).all(1), np.isfinite(rh[:, 0, :2]).all(1)
    d = lambda h, w: np.linalg.norm(h[:, 0, :2] - w, axis=1)
    both = d(lh, pr) + d(rh, pl) < d(lh, pl) + d(rh, pr)
    swap = np.where(hl & hr, both, np.where(hl, d(lh, pr) < d(lh, pl), d(rh, pl) < d(rh, pr)))
    swap &= np.isfinite(pl).all(1) & np.isfinite(pr).all(1) & (hl | hr)
    lh[swap], rh[swap] = seq["rh"][swap], seq["lh"][swap]
    return {**seq, "lh": lh, "rh": rh}


def pose_fraction(frames):
    """Fraction of frames with both shoulders (pose 11, 12) present."""
    seq = as_seq(frames)
    if seq_len(seq) == 0:
        return 0.0
    return float(np.isfinite(seq["pose"][:, [11, 12]]).all(axis=(1, 2)).mean())


def normalize(frames):
    """Apply CLAUDE.md 6.2 per frame (after assign_hands); returns (Seq, ok).

    Origin = midpoint of pose 11/12 (x,y,z), scale = their x,y distance. Because the
    result does not depend on any earlier translation or uniform scaling, re-applying
    it is idempotent and undoes upstream normalization differences. Frames without a
    pose reuse the last valid origin/scale (or the first valid one ahead). If no frame
    has a pose, coordinates are returned unchanged and ok is False; such a segment must
    not be classified.
    """
    seq = assign_hands(as_seq(frames))
    out = {p: a.copy() for p, a in seq.items()}
    T = seq_len(seq)
    if T == 0:
        return out, False
    l, r = seq["pose"][:, 11], seq["pose"][:, 12]
    origin = (l + r) / 2
    scale = np.linalg.norm((l - r)[:, :2], axis=1)
    valid = np.isfinite(origin).all(1) & np.isfinite(scale) & (scale > 1e-6)
    if not valid.any():
        return out, False
    idx = np.arange(T)
    last = np.maximum.accumulate(np.where(valid, idx, -1))
    last[last < 0] = idx[valid][0]
    o, s = origin[last], scale[last]
    for p in PARTS:
        out[p] = ((seq[p] - o[:, None, :]) / s[:, None, None]).astype(np.float32)
    return out, True


def mirror(frames):
    """Left/right mirror of a normalized Seq: x -> -x, swap hands and L/R pose/face points."""
    seq = as_seq(frames)
    out = {p: a.copy() for p, a in seq.items()}
    for p in PARTS:
        out[p][..., 0] *= -1
    out["lh"], out["rh"] = out["rh"], out["lh"]
    for key, pairs in (("pose", POSE_LR), ("face", FACE_LR)):
        a, b = zip(*pairs)
        a, b = list(a), list(b)
        out[key][:, a], out[key][:, b] = out[key][:, b].copy(), out[key][:, a].copy()
    return out


def _hand_block(h):
    T = len(h)
    h = h.copy()
    present = np.isfinite(h).all(axis=(1, 2))
    last = -1
    for t in range(T):
        if present[t]:
            last = t
        elif last >= 0 and t - last <= HAND_FFILL and np.isfinite(h[last]).all():
            h[t] = h[last]
    filled = np.isfinite(h).all(axis=(1, 2))
    wrist = h[:, 0]
    rel = (h[:, 1:] - wrist[:, None]).reshape(T, -1)
    block = np.concatenate([wrist[:, :2], rel, filled[:, None].astype(np.float32)], axis=1)
    block[~filled] = 0
    return block


def _xy_block(a, subset):
    xy = a[:, subset, :2].reshape(len(a), -1)
    present = np.isfinite(xy).all(1)
    block = np.concatenate([xy, present[:, None].astype(np.float32)], axis=1)
    block[~present] = 0
    return block


def frames_to_array(frames):
    """Seq or Frame[] (already normalized) -> float32 [T, FEATURE_DIM], layout above."""
    seq = as_seq(frames)
    if seq_len(seq) == 0:
        return np.zeros((0, FEATURE_DIM), np.float32)
    arr = np.concatenate([
        _hand_block(seq["lh"]), _hand_block(seq["rh"]), _xy_block(seq["pose"], POSE_SUBSET),
    ], axis=1)
    return np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)


def resample(arr, T=T_DEFAULT):
    """Linear interpolation in time to exactly T rows (any input length, including 0 or 1)."""
    n = len(arr)
    if n == 0:
        return np.zeros((T, arr.shape[1]), np.float32)
    if n == 1:
        return np.repeat(arr, T, axis=0).astype(np.float32)
    src = np.linspace(0, n - 1, T)
    i0 = np.floor(src).astype(int)
    i1 = np.minimum(i0 + 1, n - 1)
    w = (src - i0)[:, None]
    return (arr[i0] * (1 - w) + arr[i1] * w).astype(np.float32)


def prepare(frames, T=T_DEFAULT):
    """Frame[] / SignFile / Seq -> model input [T, FEATURE_DIM]. Same path for train and serve.

    Without a pose the result is meaningless; callers check pose_fraction first (the server does)."""
    seq, _ = normalize(frames)
    return resample(frames_to_array(seq), T)


def hand_fraction(frames):
    """Fraction of frames with at least one hand present."""
    seq = as_seq(frames)
    T = seq_len(seq)
    if T == 0:
        return 0.0
    has = np.isfinite(seq["lh"]).all(axis=(1, 2)) | np.isfinite(seq["rh"]).all(axis=(1, 2))
    return float(has.mean())


def _time_index(seq, idx):
    return {p: a[idx] for p, a in seq.items()}


def augment(frames, rng):
    """Random training augmentation of a normalized Seq (returns a new Seq)."""
    seq = {p: a.copy() for p, a in as_seq(frames).items()}
    T = seq_len(seq)
    if T >= 6:  # trim up to 10% at each end (segmenter cuts differ from capture windows)
        a = rng.integers(0, max(1, T // 10) + 1)
        b = rng.integers(0, max(1, T // 10) + 1)
        seq = _time_index(seq, np.arange(a, T - b))
        T = seq_len(seq)
    speed = rng.uniform(0.75, 1.33)
    newT = max(2, int(round(T / speed)))
    seq = _time_index(seq, np.round(np.linspace(0, T - 1, newT)).astype(int))
    T = seq_len(seq)
    keep = rng.random(T) > 0.1
    if keep.sum() >= 2:
        seq = _time_index(seq, np.flatnonzero(keep))
        T = seq_len(seq)
    if rng.random() < 0.15 and T > 1:
        hand = "lh" if rng.random() < 0.5 else "rh"
        n = rng.integers(1, max(2, T // 3) + 1)
        start = rng.integers(0, max(1, T - n + 1))
        seq[hand][start:start + n] = np.nan
    if rng.random() < 0.5:
        seq = mirror(seq)
    th = np.deg2rad(rng.uniform(-10, 10))
    sc = rng.uniform(0.85, 1.15)
    R = sc * np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]], np.float32)
    shift = rng.uniform(-0.1, 0.1, 2).astype(np.float32)
    for p in PARTS:
        a = seq[p]
        a[..., :2] = a[..., :2] @ R.T + shift
        a[..., 2] *= sc
        a += rng.normal(0, 0.01, a.shape).astype(np.float32)
    return seq

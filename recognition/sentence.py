"""Continuous signing: recognize a whole guest sentence signed in one go, without cutting it into signs.

The classifier was trained on isolated signs (capture windows of about 2 s). For a sentence signed
continuously, sliding windows of that length run over the cleaned recording (window_probs), and
decode_continuous aligns every guest sentence of docs/vocabulary.md section 2 to that sequence of
window probabilities: its labels in order, each covering a contiguous run of windows (monotonic
alignment, dynamic programming), scored by the mean log probability. The best sentence wins, so
there is no segmentation step to get wrong and the sentence context fixes doubtful signs.
"""
import math

import numpy as np

from recognition import features
from recognition.intents import GUEST_INTENTS, without_none
from recognition.labels import CLASSES, INDEX
from recognition.recognizer import validate

WIN = 30          # frames per window at 30 fps (1 s). Held-out signer, continuous sentences: 30 -> 90-91%, 50 -> 84%, 64 -> 73%
STEP = 4          # frames between windows (0.13 s)
FLOOR = 1e-6
FRAMES_PER_SIGN = 56   # average cleaned training take
LENGTH_WEIGHT = 0.0    # duration prior (per squared sign of difference); did not help on the held-out signer


def window_probs(frames, predictor, win=WIN, step=STEP):
    """Cleaned, normalized frames of a whole sentence -> list of probability vectors (NONE removed).
    Each window is validated on its own: a long sentence may exceed the server's per-request MAX_FRAMES."""
    if len(frames) <= win:
        starts = [0]
    else:
        starts = list(range(0, len(frames) - win + 1, step))
        if starts[-1] != len(frames) - win:
            starts.append(len(frames) - win)
    out = []
    for s in starts:
        p = predictor.probs(features.to_seq(validate(frames[s:s + win])))
        out.append(without_none(p))
    return out


def _align(logp, labels):
    """Best monotonic alignment of labels over windows. logp: [n_windows, n_classes]. Returns the
    total log probability and the label index of each window, or (-inf, None) if impossible."""
    n, k = len(logp), len(labels)
    if n < k:
        return -math.inf, None
    cols = [INDEX[label] for label in labels]
    dp = np.full((n, k), -np.inf)
    back = np.zeros((n, k), dtype=int)
    dp[0, 0] = logp[0, cols[0]]
    for i in range(1, n):
        for j in range(min(i + 1, k)):
            stay = dp[i - 1, j]
            move = dp[i - 1, j - 1] if j > 0 else -np.inf
            if stay >= move:
                dp[i, j], back[i, j] = stay, j
            else:
                dp[i, j], back[i, j] = move, j - 1
            dp[i, j] += logp[i, cols[j]]
    if not np.isfinite(dp[n - 1, k - 1]):
        return -math.inf, None
    path, j = [k - 1] * n, k - 1
    for i in range(n - 1, 0, -1):
        j = back[i, j]
        path[i - 1] = j
    return float(dp[n - 1, k - 1]), path


def collapse(labels):
    """Run-length collapse: A A B B B A -> A B A."""
    out = []
    for label in labels:
        if not out or out[-1] != label:
            out.append(label)
    return out


def candidate_intents(candidates):
    """Expected answers (list of label lists) -> the matching GUEST_INTENTS entries, in order.
    None, empty, or nothing matching -> all 20 sentences."""
    if not candidates:
        return GUEST_INTENTS
    wanted = [list(c) for c in candidates if isinstance(c, (list, tuple))]
    picked = [(labels, text) for labels, text in GUEST_INTENTS if labels in wanted]
    return picked or GUEST_INTENTS


def decode_continuous(probs, n_frames=None, length_weight=None, candidates=None):
    """Window probabilities of one sentence -> dict like intents.decode: raw (collapsed window
    argmax), labels, text, snapped, score (mean log probability per window, minus a duration
    prior: a sentence of k signs is expected to last about k * FRAMES_PER_SIGN frames).
    candidates: the expected answers (label lists, e.g. [["YES"], ["YES", "RESERVATION"]]) from the
    conversation context; only those sentences are considered (all 20 when None)."""
    weight = LENGTH_WEIGHT if length_weight is None else length_weight
    if not probs:
        return {"raw": [], "labels": [], "text": None, "snapped": False, "score": -math.inf}
    logp = np.log(np.maximum(np.asarray(probs), FLOOR))
    raw = collapse([CLASSES[int(np.argmax(p))] for p in probs])
    best = None
    for labels, text in candidate_intents(candidates):
        total, path = _align(logp, labels)
        if path is None:
            continue
        score = total / len(probs)
        if n_frames:
            score -= weight * (len(labels) - n_frames / FRAMES_PER_SIGN) ** 2
        if best is None or score > best[0]:
            best = (score, labels, text)
    if best is None:
        return {"raw": raw, "labels": raw, "text": None, "snapped": False, "score": -math.inf}
    return {"raw": raw, "labels": list(best[1]), "text": best[2], "snapped": True, "score": best[0]}

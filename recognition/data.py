"""Load data/train/<LABEL>/<signer>_<n>.json (Frame[] or SignFile) into normalized Seqs."""
import json
import sys
from pathlib import Path

import numpy as np

from recognition import features
from recognition.labels import CLASSES, INDEX

FEW_SAMPLES = 5
MANY_SIGNERS = 20


def signer_of(path, doc=None):
    """Signer = the SignFile "signer" field if present, else the file stem before the last
    underscore ("cosme_12.json" -> "cosme")."""
    if isinstance(doc, dict) and isinstance(doc.get("signer"), str) and doc["signer"].strip():
        return doc["signer"].strip()
    stem = Path(path).stem
    return stem.rsplit("_", 1)[0] if "_" in stem else stem


def load_file(path):
    with open(path) as f:
        return json.load(f)


def bad_parts(doc):
    """Names of parts that are present but do not have the 6.1 shape (they are dropped as missing)."""
    frames = doc["frames"] if isinstance(doc, dict) and "frames" in doc else doc
    bad = set()
    for f in frames if isinstance(frames, list) else []:
        for p, n in features.PARTS.items():
            pts = f.get(p) if isinstance(f, dict) else None
            if pts is None:
                continue
            try:
                ok = np.shape(pts) == (n, 3)
            except ValueError:  # ragged
                ok = False
            if not ok:
                bad.add(p)
    return sorted(bad)


def load_dataset(roots, warn=True):
    """Returns (seqs, labels, signers, paths): normalized Seqs, int label array, signer names, file paths.

    roots: one folder or a list of folders, each laid out as <root>/<LABEL>/<signer>_<n>.json.
    Files with no pose in any frame are skipped (they cannot be normalized).
    """
    if isinstance(roots, (str, Path)):
        roots = [roots]
    seqs, labels, signers, paths = [], [], [], []
    say = (lambda m: print(f"WARNING: {m}", file=sys.stderr)) if warn else (lambda m: None)
    for root in map(Path, roots):
        if not root.is_dir():
            raise FileNotFoundError(f"data folder not found: {root}")
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            if d.name not in INDEX:
                say(f"skipping unknown label folder {d}")
                continue
            for f in sorted(d.glob("*.json")):
                doc = load_file(f)
                bad = bad_parts(doc)
                if bad:
                    say(f"{f}: wrong number of points in {', '.join(bad)} (see CLAUDE.md 6.1); treated as missing")
                seq, ok = features.normalize(doc)
                if features.seq_len(seq) == 0:
                    say(f"empty file skipped: {f}")
                    continue
                if not ok:
                    say(f"no pose in any frame, skipped: {f}")
                    continue
                seqs.append(seq)
                labels.append(INDEX[d.name])
                signers.append(signer_of(f, doc))
                paths.append(str(f))
    labels = np.array(labels, dtype=np.int64)
    if warn:
        counts = np.bincount(labels, minlength=len(CLASSES))
        for c, n in zip(CLASSES, counts):
            if n == 0:
                say(f"class {c} has no samples")
            elif n < FEW_SAMPLES:
                say(f"class {c} has only {n} samples")
        uniq = set(signers)
        if len(uniq) > MANY_SIGNERS or (len(uniq) == len(signers) > 1) or uniq & set(CLASSES):
            say(f"{len(uniq)} signers for {len(signers)} files ({sorted(uniq)[:5]} ...). Signer names come from "
                "the SignFile 'signer' field or <signer>_<n>.json; if this is wrong, leave-one-signer-out "
                "becomes leave-one-take-out and the benchmark is optimistic.")
    return seqs, labels, signers, paths


def to_arrays(seqs, T=features.T_DEFAULT):
    """Normalized Seqs -> float32 [N, T, D] without augmentation."""
    return np.stack([features.resample(features.frames_to_array(s), T) for s in seqs]) if seqs else \
        np.zeros((0, T, features.FEATURE_DIM), np.float32)


def load_with_extra(data, extra=()):
    """Primary data plus extra roots. Returns (seqs, labels, signers, n_primary); extras come last.

    Validation and test signers are only ever taken from the first n_primary takes; extra
    data (e.g. converted GISLR) is always training data.
    """
    seqs, labels, signers, _ = load_dataset(data)
    n_primary = len(seqs)
    if extra:
        es, el, esg, _ = load_dataset(list(extra), warn=False)
        seqs, labels, signers = seqs + es, np.concatenate([labels, el]), signers + esg
    return seqs, labels, signers, n_primary

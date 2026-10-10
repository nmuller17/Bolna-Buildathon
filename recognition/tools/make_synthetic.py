"""Generate a SYNTHETIC dataset in the data/train layout, to check the pipeline end to end.

    python -m recognition.tools.make_synthetic --out /tmp/synthetic_train

Each of the 22 classes is a made-up parametric hand trajectory + handshape (not real
ASL), with per-signer style offsets, per-take noise, 30-90 frames and occasional missing
hands. NONE is hands at rest or drifting. Three pairs of classes (REVERSED_PAIRS) share
location, handshape and path and differ only in the direction of time, so a model that
ignores frame order cannot separate them. Numbers obtained on this data only show that
the code learns and evaluates correctly; they say nothing about real signs.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from recognition import features
from recognition.labels import CLASSES

REST_Y = 2.3
# (a, b): class b is class a played backwards.
REVERSED_PAIRS = [("RESERVATION", "NAME"), ("BREAKFAST", "TIME"), ("PARKING", "TAXI")]
# Hand frame coordinates (along palm-perpendicular p, along fingers u) of each finger base, and direction.
FINGERS = [((0.10, 0.10), (0.7, 0.7)), ((0.05, 0.40), (0.0, 1.0)), ((0.0, 0.42), (0.0, 1.0)),
           ((-0.05, 0.40), (0.0, 1.0)), ((-0.09, 0.36), (-0.1, 1.0))]


def hand_points(wrist, theta, curl, size, rng):
    """21 x 3 hand landmarks: wrist + 5 fingers x 4 points; curl[f] in [0,1] shortens finger f."""
    u = np.array([np.sin(theta), -np.cos(theta)])
    p = np.array([np.cos(theta), np.sin(theta)])
    pts = [np.array([wrist[0], wrist[1], 0.0])]
    for f, ((bp, bu), (dp, du)) in enumerate(FINGERS):
        base = wrist + size * (bp * p + bu * u)
        d = (dp * p + du * u) / np.hypot(dp, du)
        seg = size * 0.13 * (1 - 0.75 * np.clip(curl[f], 0, 1))
        for k in range(4):
            xy = base + d * seg * k
            pts.append(np.array([xy[0], xy[1], -0.03 * k * curl[f]]))
    return np.array(pts) + rng.normal(0, 0.004, (21, 3))


def class_spec(k, rng):
    label = CLASSES[k]
    spec = {
        "center": np.array([rng.uniform(-0.75, 0.25), rng.uniform(-1.3, 0.9)]),
        "kind": ["circle", "line", "arc", "tap", "wiggle"][k % 5],
        "amp": rng.uniform(0.12, 0.35),
        "phi": rng.uniform(0, np.pi),
        "freq": [0.5, 1.0, 1.5, 2.0][(k // 5) % 4],
        "theta": rng.uniform(-0.8, 0.8, 2),
        "curl": rng.integers(0, 2, (2, 5)).astype(float),
        "two_hands": k % 3 == 0,
        "static_base": k % 2 == 0,
        "letters": None,
        "reverse": False,
    }
    if label.startswith("FS-"):
        n = 4 if label == "FS-WIFI" else 8
        spec["letters"] = rng.integers(0, 2, (n, 5)).astype(float)
        spec["kind"], spec["amp"], spec["two_hands"] = "line", 0.08, False
        spec["center"] = np.array([-0.55, -0.4])
    return spec


def wrist_path(spec, s, amp):
    """Dominant (right) wrist offset at normalized time s in [0,1]."""
    w = 2 * np.pi * spec["freq"] * s
    c, si = np.cos(spec["phi"]), np.sin(spec["phi"])
    if spec["kind"] == "circle":
        off = amp * np.stack([np.cos(w), np.sin(w)], -1)
    elif spec["kind"] == "line":
        off = amp * (2 * s - 1)[:, None] * np.array([c, si])
    elif spec["kind"] == "arc":
        off = amp * np.stack([np.cos(np.pi * s), -np.sin(np.pi * s)], -1)
    elif spec["kind"] == "tap":
        off = amp * np.abs(np.sin(w))[:, None] * np.array([c, si])
    else:
        off = amp * np.stack([0.3 * np.sin(4 * w), 2 * s - 1], -1)
    return off


def body(T, rng, tilt):
    """Pose [T,33,3] and face [T,26,3] in normalized coordinates, small head motion."""
    pose = np.zeros((T, 33, 3))
    ref = {0: (0, -1.1), 1: (0.06, -1.2), 2: (0.1, -1.21), 3: (0.14, -1.2), 4: (-0.06, -1.2), 5: (-0.1, -1.21),
           6: (-0.14, -1.2), 7: (0.26, -1.15), 8: (-0.26, -1.15), 9: (0.05, -0.95), 10: (-0.05, -0.95),
           11: (0.5, tilt), 12: (-0.5, -tilt), 23: (0.35, 2.0), 24: (-0.35, 2.0), 25: (0.35, 3.5),
           26: (-0.35, 3.5), 27: (0.35, 5.0), 28: (-0.35, 5.0), 29: (0.35, 5.1), 30: (-0.35, 5.1),
           31: (0.4, 5.2), 32: (-0.4, 5.2)}
    for i, (x, y) in ref.items():
        pose[:, i, :2] = (x, y)
    face_ref = [(-0.2, -1.35), (-0.16, -1.37), (-0.12, -1.38), (-0.08, -1.37), (-0.05, -1.35),
                (0.05, -1.35), (0.08, -1.37), (0.12, -1.38), (0.16, -1.37), (0.2, -1.35),
                (-0.17, -1.25), (-0.06, -1.25), (-0.115, -1.28), (-0.115, -1.22),
                (0.06, -1.25), (0.17, -1.25), (0.115, -1.28), (0.115, -1.22),
                (-0.08, -0.95), (0.08, -0.95), (0, -0.98), (0, -0.88), (0, -0.955), (0, -0.945),
                (0, -1.1), (0, -0.75)]
    face = np.zeros((T, 26, 3))
    face[:, :, :2] = face_ref
    head = np.cumsum(rng.normal(0, 0.003, (T, 2)), 0)
    for i in range(11):
        pose[:, i, :2] += head
    face[:, :, :2] += head[:, None]
    pose[:, :, 2] = rng.normal(0, 0.05, (T, 33))
    face[:, :, 2] = rng.normal(0, 0.01, (T, 26))
    return pose, face


def make_take(k, spec, style, rng):
    T = int(rng.integers(30, 91))
    pose, face = body(T, rng, style["tilt"])
    lh = np.full((T, 21, 3), np.nan)
    rh = np.full((T, 21, 3), np.nan)
    if CLASSES[k] == "NONE":
        start_r = np.array([rng.uniform(-0.8, 0.2), rng.uniform(0.5, 2.6)])
        start_l = np.array([rng.uniform(0.2, 0.8), rng.uniform(1.0, 2.6)])
        drift_r = np.cumsum(rng.normal(0, 0.02, (T, 2)), 0) + start_r
        drift_l = np.cumsum(rng.normal(0, 0.02, (T, 2)), 0) + start_l
        curl = rng.uniform(0, 1, 5)
        for t in range(T):
            if drift_r[t, 1] < 2.2:
                rh[t] = hand_points(drift_r[t], 0.2, curl, style["size"], rng)
            if drift_l[t, 1] < 2.2 and rng.random() < 0.7:
                lh[t] = hand_points(drift_l[t], -0.2, curl, style["size"], rng)
    else:
        lead, tail = int(rng.integers(3, 12)), int(rng.integers(3, 12))
        n = max(8, T - lead - tail)
        s = np.linspace(0, 1, n)
        if spec["reverse"]:
            s = s[::-1]
        center = spec["center"] + style["offset"] + rng.normal(0, 0.03, 2)
        amp = spec["amp"] * style["amp"]
        path = center + wrist_path(spec, s, amp)
        rest = np.array([center[0], REST_Y])
        full = np.concatenate([np.linspace(rest, path[0], lead + 1)[:-1], path,
                               np.linspace(path[-1], rest, tail + 1)[1:]])[:T]
        if len(full) < T:
            full = np.concatenate([full, np.repeat(full[-1:], T - len(full), 0)])
        for t in range(T):
            a = np.clip((t - lead) / max(1, n - 1), 0, 1)
            if spec["reverse"]:
                a = 1 - a
            if spec["letters"] is not None:
                curl = spec["letters"][min(int(a * len(spec["letters"])), len(spec["letters"]) - 1)]
            else:
                curl = (1 - a) * spec["curl"][0] + a * spec["curl"][1]
            curl = curl + style["curl"]
            theta = (1 - a) * spec["theta"][0] + a * spec["theta"][1] + style["theta"]
            if full[t, 1] < 2.2:
                rh[t] = hand_points(full[t], theta, curl, style["size"], rng)
            if spec["two_hands"] and full[t, 1] < 2.2:
                if spec["static_base"]:
                    lw, lth = np.array([0.1, 0.5]), 1.4
                else:
                    lw, lth = np.array([-full[t, 0], full[t, 1]]), -theta
                lh[t] = hand_points(lw, lth, np.full(5, 0.2), style["size"], rng)
    for h in (lh, rh):
        h[rng.random(T) < 0.02] = np.nan
        if rng.random() < 0.1:
            a = int(rng.integers(0, T))
            h[a:a + int(rng.integers(3, 9))] = np.nan
    pose[:, 15, :2] = np.where(np.isfinite(lh[:, 0, :2]), lh[:, 0, :2], [0.6, REST_Y])
    pose[:, 16, :2] = np.where(np.isfinite(rh[:, 0, :2]), rh[:, 0, :2], [-0.6, REST_Y])
    pose[:, 13, :2] = (pose[:, 11, :2] + pose[:, 15, :2]) / 2 + [0.15, 0.3]
    pose[:, 14, :2] = (pose[:, 12, :2] + pose[:, 16, :2]) / 2 + [-0.15, 0.3]
    for a, w in ((17, 15), (19, 15), (21, 15), (18, 16), (20, 16), (22, 16)):
        pose[:, a, :2] = pose[:, w, :2] + rng.normal(0, 0.03, 2)
    seq = {"pose": pose, "lh": lh, "rh": rh, "face": face}
    # Place the body in a random "camera" (raw image coords), then normalize like capture would.
    s_cam, shift = style["cam_scale"] * rng.uniform(0.95, 1.05), style["cam_shift"] + rng.normal(0, 0.01, 2)
    raw = {}
    for p, a in seq.items():
        r = a.astype(np.float32).copy()
        r[..., :2] = r[..., :2] * s_cam + shift
        r[..., :2] += rng.normal(0, 0.002, r[..., :2].shape)
        r[..., 2] *= s_cam
        raw[p] = r
    norm, _ = features.normalize(raw)
    return norm


def generate(out, n_signers=4, n_takes=15, seed=0):
    rng = np.random.default_rng(seed)
    specs = [class_spec(k, rng) for k in range(len(CLASSES))]
    for a, b in REVERSED_PAIRS:
        specs[CLASSES.index(b)] = {**specs[CLASSES.index(a)], "reverse": True}
    out = Path(out)
    count = 0
    for si in range(n_signers):
        name = f"synth{chr(ord('A') + si)}"
        style = {"offset": rng.normal(0, 0.06, 2), "amp": rng.uniform(0.85, 1.15), "theta": rng.normal(0, 0.12),
                 "curl": rng.normal(0, 0.08, 5), "size": rng.uniform(0.45, 0.55), "tilt": rng.normal(0, 0.03),
                 "cam_scale": rng.uniform(0.18, 0.3), "cam_shift": np.array([rng.uniform(0.4, 0.6), rng.uniform(0.45, 0.6)])}
        for k, label in enumerate(CLASSES):
            d = out / label
            d.mkdir(parents=True, exist_ok=True)
            for n in range(n_takes):
                seq = make_take(k, specs[k], style, rng)
                doc = {"id": label, "source": "synthetic", "signer": name, "fps": 30,
                       "frames": features.seq_to_frames(seq, ndigits=4)}
                with open(d / f"{name}_{n}.json", "w") as f:
                    json.dump(doc, f, separators=(",", ":"))
                count += 1
    return count


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--signers", type=int, default=4)
    ap.add_argument("--takes", type=int, default=15)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    n = generate(args.out, args.signers, args.takes, args.seed)
    print(f"wrote {n} SYNTHETIC files to {args.out}")


if __name__ == "__main__":
    main()

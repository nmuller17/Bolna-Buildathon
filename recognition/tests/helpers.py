"""Small frame generators shared by the tests."""
import numpy as np


def raw_frames(T, rng, lh=True, rh=True, scale=0.25, shift=(0.5, 0.55)):
    """Frame[] in raw-image-like coordinates: shoulders ~scale apart around shift.

    Like an unmirrored camera, the person's left (pose 11, lh) is on the image right;
    pose wrists 15/16 sit on the lh/rh wrists, so hand assignment keeps the labels.
    """
    frames = []
    for t in range(T):
        pose = rng.normal(0, 0.3, (33, 3)) * scale
        pose[11] = [0.5 * scale, 0, 0]
        pose[12] = [-0.5 * scale, 0, 0]
        hands = {}
        for key, side, w in (("lh", 1, 15), ("rh", -1, 16)):
            h = rng.normal(0, 0.05, (21, 3)) * scale
            h[:, 0] += side * 0.4 * scale
            h[:, 1] += 0.6 * scale
            pose[w] = h[0]
            hands[key] = h
        pose[:, :2] += shift
        frames.append({
            "pose": pose.tolist(),
            "lh": (hands["lh"] + [*shift, 0]).tolist() if lh else None,
            "rh": (hands["rh"] + [*shift, 0]).tolist() if rh else None,
            "face": (rng.normal(0, 0.1, (26, 3)) * scale + [shift[0], shift[1] - scale, 0]).tolist(),
        })
    return frames

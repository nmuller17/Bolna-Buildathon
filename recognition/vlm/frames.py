"""Frame sampling for VLM prompts: read an mp4, pick N frames evenly or around the motion,
resize the long side, optionally mirror, and return RGB PIL images (or one tiled grid image).

Only OpenCV, numpy and Pillow; no model needed, so this module is unit-testable anywhere.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


@dataclass
class Sampled:
    images: list[Image.Image]      # RGB, time order
    indices: list[int]             # source frame indices
    n_total: int                   # frames decoded from the video
    fps: float
    window: tuple[int, int]        # [start, end] frame window the samples were drawn from


def read_video(path: str | Path) -> tuple[list[np.ndarray], float]:
    """All frames as BGR uint8 arrays plus fps. Raises FileNotFoundError / ValueError."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    cap = cv2.VideoCapture(str(path))
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or 30.0
        frames = []
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            frames.append(fr)
    finally:
        cap.release()
    if not frames:
        raise ValueError(f"no frames decoded from {path}")
    return frames, fps


def even_indices(n_total: int, n: int, start: int = 0, end: int | None = None) -> list[int]:
    """n indices spread evenly over [start, end] inclusive (centres of n equal bins)."""
    if n_total <= 0 or n <= 0:
        return []
    end = n_total - 1 if end is None else min(end, n_total - 1)
    start = max(0, min(start, end))
    span = end - start + 1
    if n >= span:
        return list(range(start, end + 1))
    return [start + int((i + 0.5) * span / n) for i in range(n)]


def motion_energy(frames: list[np.ndarray], size: int = 64) -> np.ndarray:
    """Per-frame motion: mean absolute grey difference to the previous frame (frame 0 = 0)."""
    if not frames:
        return np.zeros(0)
    small = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) if f.ndim == 3 else f, (size, size),
                        interpolation=cv2.INTER_AREA).astype(np.float32) for f in frames]
    e = np.zeros(len(small), dtype=np.float64)
    for i in range(1, len(small)):
        e[i] = float(np.mean(np.abs(small[i] - small[i - 1])))
    return e


def motion_window(energy: np.ndarray, lo: float = 0.05, hi: float = 0.95, pad: int = 2) -> tuple[int, int]:
    """Frame window holding the central lo..hi share of the motion energy, padded by `pad`.
    Falls back to the whole clip when there is no motion at all."""
    n = len(energy)
    if n == 0:
        return (0, -1)
    tot = float(energy.sum())
    if tot <= 1e-9:
        return (0, n - 1)
    c = np.cumsum(energy) / tot
    s = int(np.searchsorted(c, lo))
    e = int(np.searchsorted(c, hi))
    return (max(0, s - pad), min(n - 1, e + pad))


def _resize_long(img: np.ndarray, long_side: int | None) -> np.ndarray:
    if not long_side:
        return img
    h, w = img.shape[:2]
    scale = long_side / float(max(h, w))
    if abs(scale - 1.0) < 1e-6:
        return img
    nh, nw = max(1, round(h * scale)), max(1, round(w * scale))
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    return cv2.resize(img, (nw, nh), interpolation=interp)


def to_pil(frames_bgr: list[np.ndarray], long_side: int | None = 448, mirror: bool = False) -> list[Image.Image]:
    out = []
    for f in frames_bgr:
        f = _resize_long(f, long_side)
        if mirror:
            f = cv2.flip(f, 1)
        out.append(Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)))
    return out


def sample_frames_from_arrays(frames_bgr: list[np.ndarray], n: int = 8, mode: str = "motion",
                              long_side: int | None = 448, mirror: bool = False,
                              fps: float = 30.0) -> Sampled:
    """mode='even': evenly over the whole clip. mode='motion': evenly inside the window that
    holds the central 90% of motion energy (drops the still lead-in / lead-out)."""
    if mode not in ("even", "motion"):
        raise ValueError(f"mode must be 'even' or 'motion', got {mode!r}")
    n_total = len(frames_bgr)
    if mode == "motion":
        win = motion_window(motion_energy(frames_bgr))
    else:
        win = (0, n_total - 1)
    idx = even_indices(n_total, n, win[0], win[1])
    imgs = to_pil([frames_bgr[i] for i in idx], long_side=long_side, mirror=mirror)
    return Sampled(images=imgs, indices=idx, n_total=n_total, fps=fps, window=win)


def sample_frames(path: str | Path, n: int = 8, mode: str = "motion", long_side: int | None = 448,
                  mirror: bool = False) -> Sampled:
    frames, fps = read_video(path)
    return sample_frames_from_arrays(frames, n=n, mode=mode, long_side=long_side, mirror=mirror, fps=fps)


def grid(images: list[Image.Image], cols: int | None = None, label: bool = True,
         cell_long_side: int | None = None) -> Image.Image:
    """Tile images (time order, row-major) into one image, numbering each tile 1..N.
    One grid image costs far fewer vision tokens than N separate images."""
    if not images:
        raise ValueError("no images")
    if cell_long_side:
        images = [im.copy() for im in images]
        for im in images:
            im.thumbnail((cell_long_side, cell_long_side))
    n = len(images)
    cols = cols or int(np.ceil(np.sqrt(n)))
    rows = int(np.ceil(n / cols))
    w = max(im.width for im in images)
    h = max(im.height for im in images)
    canvas = Image.new("RGB", (cols * w, rows * h), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    for k, im in enumerate(images):
        r, c = divmod(k, cols)
        canvas.paste(im, (c * w, r * h))
        if label:
            x, y = c * w + 4, r * h + 4
            draw.rectangle([x, y, x + 26, y + 16], fill=(0, 0, 0))
            draw.text((x + 3, y + 2), str(k + 1), fill=(255, 255, 0))
    return canvas

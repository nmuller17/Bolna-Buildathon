"""Clean a capture: resample to 30 fps, trim, forward-fill missing parts, 3-frame moving average."""

PARTS = ("pose", "lh", "rh", "face")
FPS = 30


def resample(frames, timestamps_ms, fps=FPS):
    """Nearest-neighbor resample of frames recorded at irregular times to a fixed fps."""
    if not frames:
        return []
    t0, t_end = timestamps_ms[0], timestamps_ms[-1]
    out, j = [], 0
    n = int((t_end - t0) * fps / 1000) + 1
    for k in range(n):
        t = t0 + k * 1000 / fps
        while j + 1 < len(timestamps_ms) and abs(timestamps_ms[j + 1] - t) <= abs(timestamps_ms[j] - t):
            j += 1
        out.append(frames[j])
    return out


def has_hand(frame):
    return frame is not None and (frame["lh"] is not None or frame["rh"] is not None)


def trim(frames):
    """Drop leading and trailing frames with no hand visible."""
    idx = [i for i, f in enumerate(frames) if has_hand(f)]
    return frames[idx[0]: idx[-1] + 1] if idx else []


def forward_fill(frames):
    """Replace a missing frame or part by the last seen one (a hand blinking out for a few frames)."""
    out, last = [], {p: None for p in PARTS}
    for f in frames:
        f = f or {p: None for p in PARTS}
        filled = {p: f[p] if f[p] is not None else last[p] for p in PARTS}
        last = filled
        out.append(filled)
    return out


def smooth(frames):
    """3-frame centered moving average, per point, over neighbors where the part exists."""
    out = []
    for i, f in enumerate(frames):
        window = frames[max(0, i - 1): i + 2]
        sf = {}
        for p in PARTS:
            if f[p] is None:
                sf[p] = None
                continue
            sources = [w[p] for w in window if w[p] is not None]
            sf[p] = [[round(sum(s[k][c] for s in sources) / len(sources), 5) for c in range(3)]
                     for k in range(len(f[p]))]
        out.append(sf)
    return out


def clean(frames, timestamps_ms):
    """Normalized frames (None when pose missing) + capture times -> cleaned Frame list at 30 fps."""
    return smooth(forward_fill(trim(resample(frames, timestamps_ms))))

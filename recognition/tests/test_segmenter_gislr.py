"""Segmenter detection rate on real signing (GISLR clips in data/gislr, gitignored; skipped without them).

Each clip of 30+ frames is padded with 1 s of hands-down frames on both sides and must give at
least one sign. GISLR clips are cut tightly to the sign (no raise or drop of the hands, the hand
appears suddenly) and their aspect ratio is unknown, so this is a pessimistic bound and a guard
against regressions, not the live detection rate. Run with -s to see the per-label table.
"""
import json
from collections import defaultdict
from pathlib import Path

import pytest

from recognition.segmenter import Segmenter

GISLR = Path(__file__).resolve().parents[2] / "data" / "gislr"
MIN_FRAMES = 30
FLOOR_ALL, FLOOR_LABEL = 0.65, 0.5   # measured 2026-10-10: 269/366 = 0.73, lowest label 0.60 (TIME)


def gap(frame, n):
    return [{"pose": frame["pose"], "lh": None, "rh": None, "face": None}] * n


def detection_rates(paths):
    """{label: (clips, clips with >= 1 sign)} for clips of MIN_FRAMES+ frames."""
    out = defaultdict(lambda: [0, 0])
    for p in paths:
        clip = json.loads(Path(p).read_text())
        fr = clip["frames"]
        if len(fr) < MIN_FRAMES:
            continue
        seg, events = Segmenter(), []
        for i, f in enumerate(gap(fr[0], 30) + fr + gap(fr[-1], 30)):
            events += seg.push(f, i / 30)
        events += seg.flush()
        out[clip["id"]][0] += 1
        out[clip["id"]][1] += any(e[0] == "sign" for e in events)
    return dict(out)


@pytest.mark.skipif(not GISLR.is_dir(), reason="data/gislr not present (python -m recognition.tools.gislr_to_frames)")
def test_gislr_detection_rate_per_label():
    rates = detection_rates(sorted(GISLR.glob("*/*.json")))
    if not rates:
        pytest.skip("no GISLR clips of 30+ frames")
    n, hit = sum(v[0] for v in rates.values()), sum(v[1] for v in rates.values())
    table = "\n".join(f"  {k:10s} {v[1]:3d}/{v[0]:3d}  {v[1] / v[0]:.0%}" for k, v in sorted(rates.items()))
    report = f"segmenter on GISLR clips >= {MIN_FRAMES} frames: {hit}/{n} = {hit / n:.0%}\n{table}"
    print("\n" + report)
    assert hit / n >= FLOOR_ALL, report
    assert all(v[1] / v[0] >= FLOOR_LABEL for v in rates.values()), report

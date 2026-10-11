"""Frame sampler on tiny synthetic videos (no model needed)."""
import cv2
import numpy as np
import pytest

from recognition.vlm import frames as F


def _clip(n=40, still_head=10, still_tail=10, h=48, w=64):
    """Black frames; a white square moves only in the middle section."""
    out = []
    for i in range(n):
        f = np.zeros((h, w, 3), np.uint8)
        k = min(max(i - still_head, 0), n - still_head - still_tail)
        f[10:20, 2 + k:12 + k] = 255
        f[0:5, 0:5] = (0, 0, 255)  # red marker top-left (BGR) to test colour order + mirroring
        out.append(f)
    return out


def test_even_indices():
    assert F.even_indices(10, 5) == [1, 3, 5, 7, 9]
    assert F.even_indices(4, 8) == [0, 1, 2, 3]
    assert F.even_indices(0, 3) == []
    idx = F.even_indices(100, 4, 20, 59)
    assert idx == sorted(idx) and min(idx) >= 20 and max(idx) <= 59 and len(idx) == 4


def test_motion_window_drops_still_lead_in_and_out():
    fr = _clip()
    e = F.motion_energy(fr)
    assert e[0] == 0 and e[:10].max() == 0 and e[12:28].min() > 0
    s, t = F.motion_window(e, pad=0)
    assert 9 <= s <= 12 and 27 <= t <= 31
    assert F.motion_window(np.zeros(5)) == (0, 4)


def test_sample_modes_resize_and_colour():
    fr = _clip()
    ev = F.sample_frames_from_arrays(fr, n=4, mode="even", long_side=32)
    mo = F.sample_frames_from_arrays(fr, n=4, mode="motion", long_side=32)
    assert len(ev.images) == 4 and ev.images[0].size == (32, 24)
    assert ev.window == (0, 39)
    assert mo.window[0] >= 7 and mo.window[1] <= 33
    assert all(mo.window[0] <= i <= mo.window[1] for i in mo.indices)
    px = np.asarray(ev.images[0])
    assert tuple(px[0, 0]) == (255, 0, 0)          # BGR red -> RGB red
    m = F.sample_frames_from_arrays(fr, n=1, mode="even", long_side=None, mirror=True)
    assert tuple(np.asarray(m.images[0])[0, -1]) == (255, 0, 0)   # marker moved to top-right
    with pytest.raises(ValueError):
        F.sample_frames_from_arrays(fr, n=4, mode="random")


def test_sample_frames_reads_mp4(tmp_path):
    p = tmp_path / "t.mp4"
    wr = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), 30, (64, 48))
    for f in _clip():
        wr.write(f)
    wr.release()
    s = F.sample_frames(p, n=8, mode="motion", long_side=64)
    assert s.n_total == 40 and len(s.images) == 8 and s.fps > 0
    with pytest.raises(FileNotFoundError):
        F.sample_frames(tmp_path / "missing.mp4")


def test_grid_tiles_in_order():
    imgs = F.sample_frames_from_arrays(_clip(), n=5, mode="even", long_side=32).images
    g = F.grid(imgs, label=False)
    assert g.size == (3 * 32, 2 * 24)
    assert np.array_equal(np.asarray(g)[24:48, 0:32], np.asarray(imgs[3]))
    g2 = F.grid(imgs, cols=5, label=True, cell_long_side=16)
    assert g2.size == (5 * 16, 12)
    with pytest.raises(ValueError):
        F.grid([])

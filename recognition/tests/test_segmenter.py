import numpy as np
import pytest

from recognition import segmenter
from recognition.recognizer import MAX_FRAMES
from recognition.segmenter import Segmenter

FPS = 30
SHAPE = np.random.default_rng(0).normal(0, 0.08, (21, 3))
SHAPE[0] = 0


def frame(wrist=None, fingers=0.0, rng=None, jitter=0.0):
    """One normalized frame: shoulders at x = +-0.5, one right hand at `wrist` (None = no hand)."""
    pose = np.zeros((33, 3))
    pose[11], pose[12] = [0.5, 0, 0], [-0.5, 0, 0]
    rh = None
    if wrist is not None:
        h = SHAPE.copy()
        h[1:, 1] += fingers
        h[:, :2] += wrist
        if jitter:
            h += rng.normal(0, jitter, h.shape)
        rh = h.tolist()
    return {"pose": pose.tolist(), "lh": None, "rh": rh, "face": None}


def down(n):
    return [frame(None) for _ in range(n)]


def still(n, at=(0.0, 0.5), jitter=0.01, seed=1):
    rng = np.random.default_rng(seed)
    return [frame(np.array(at), rng=rng, jitter=jitter) for _ in range(n)]


def move(n, center=(0.0, 0.5), radius=0.4, hz=1.0):
    t = np.arange(n) / FPS
    return [frame(np.array(center) + radius * np.array([np.cos(2 * np.pi * hz * s) - 1, np.sin(2 * np.pi * hz * s)]))
            for s in t]                                                            # starts and ends at center


def run(frames, flush=False, times=None, **kw):
    seg, out = Segmenter(fps=FPS, **kw), []
    for i, f in enumerate(frames):
        out += [(i, e) for e in seg.push(f, None if times is None else times[i])]
    if flush:
        out += [(len(frames), e) for e in seg.flush()]
    return out


def kinds(events):
    return [e[0] for _, e in events]


def test_two_signs_separated_by_a_pause():
    ev = run(down(15) + move(30) + still(24) + move(30) + down(60))
    assert kinds(ev) == ["sign", "sign", "utterance_end"]
    for _, (_, frames) in ev[:2]:   # motion is measured over MOTION_SEC, so it lags the hand
        assert 29 <= len(frames) <= 30 + segmenter.PREROLL + segmenter.TAIL_KEEP + round(segmenter.MOTION_SEC * FPS)


def test_hands_down_for_1_5_s_ends_the_utterance():
    stream = down(10) + move(30)
    first_down = len(stream)
    ev = run(stream + down(80))
    assert kinds(ev) == ["sign", "utterance_end"]
    assert ev[0][0] == first_down + round(segmenter.CLOSE_SEC * FPS) - 1          # sign closes after 0.5 s
    assert ev[1][0] == first_down + round(segmenter.UTTERANCE_SEC * FPS) - 1      # utterance after 1.5 s
    assert kinds(run(stream + down(40))) == ["sign"]                              # 1.33 s is not enough


def test_hands_down_without_a_sign_is_not_an_utterance():
    assert run(down(200)) == []


@pytest.mark.parametrize("jitter", [0.005, 0.01, 0.02, 0.03])
def test_jitter_while_still_gives_no_sign(jitter):
    assert run(down(5) + still(300, jitter=jitter) + down(60)) == []


def test_movement_outside_the_signing_area_is_ignored():
    assert run(move(120, center=(0.0, 2.2))) == []                                # hands in the lap
    assert run(move(120, center=(3.0, 0.5))) == []                                # far to the side


def test_long_continuous_movement_is_force_closed():
    ev = run(move(MAX_FRAMES + 60))
    assert ev[0][1][0] == "sign" and len(ev[0][1][1]) == MAX_FRAMES


def test_too_short_movement_is_discarded():
    flick = [frame(np.array([dx, 0.5])) for dx in (0.15, 0.3, 0.15)]                # out and back in 0.1 s
    assert run(still(20, jitter=0) + flick + still(60, jitter=0)) == []
    assert kinds(run(still(20, jitter=0) + move(12) + down(20))) == ["sign"]       # 0.4 s of movement is kept


def test_fingerspelling_with_a_still_wrist_is_a_sign():
    t = np.arange(45) / FPS
    fs = [frame(np.array([0.0, 0.5]), fingers=0.3 * np.sin(2 * np.pi * 2 * s)) for s in t]
    assert kinds(run(still(10) + fs + down(60))) == ["sign", "utterance_end"]


def test_hands_resting_still_in_the_area_end_the_utterance():
    ev = run(move(30) + still(int(segmenter.REST_UTTERANCE_SEC * FPS) + 15))
    assert kinds(ev) == ["sign", "utterance_end"]
    assert kinds(run(move(30) + still(int(segmenter.REST_UTTERANCE_SEC * FPS) - 5))) == ["sign"]


def test_flush_closes_an_open_sign():
    assert kinds(run(move(40), flush=True)) == ["sign", "utterance_end"]
    assert run(still(40), flush=True) == []


def test_segments_are_accepted_by_the_server_schema():
    from recognition.recognizer import validate
    ev = run(down(15) + move(30) + down(60))
    validate(ev[0][1][1])


def test_timing_follows_timestamps_not_the_frame_rate():
    stream = down(15) + move(30) + still(24) + move(30) + down(60)
    every_other = stream[::2]                                                     # landmarker at 15 frames/s
    ev = run(every_other, times=[2 * i / FPS for i in range(len(every_other))])
    assert kinds(ev) == ["sign", "sign", "utterance_end"]
    late = [1.0 + i / FPS for i in range(len(stream))]                            # first frame after 1 s start-up
    assert kinds(run(stream, times=late)) == kinds(run(stream))
    ev = run(stream[:45] + down(80), times=[i / FPS for i in range(125)])
    assert ev[1][0] == 45 + round(segmenter.UTTERANCE_SEC * FPS) - 1


def test_y_scale_puts_the_area_in_real_shoulder_widths():
    t = np.arange(40) / FPS
    low = [frame(np.array([0.3 * np.sin(2 * np.pi * s), 1.4])) for s in t]       # 1.4 shoulder widths in 16:9 units
    assert run(down(10) + low + down(60)) == []                                   # below the area as given
    assert kinds(run(down(10) + low + down(60), y_scale=9 / 16)) == ["sign", "utterance_end"]  # 0.79 real


def test_finger_taps_with_a_still_wrist_are_a_sign():
    t = np.arange(24) / FPS
    taps = [frame(np.array([0.0, 0.3]), fingers=-0.12 * (1 - np.cos(2 * np.pi * 3 * s))) for s in t]
    assert kinds(run(still(10, jitter=0) + taps + still(40, jitter=0) + down(60))) == ["sign", "utterance_end"]


def test_a_still_hand_entering_or_flickering_is_not_a_sign():
    assert run(down(10) + still(60) + down(8) + still(60) + down(60)) == []


def test_hand_entering_mid_movement_is_cut_from_the_entry():
    ev = run(down(30) + move(30, hz=1.5) + down(60))
    assert kinds(ev) == ["sign", "utterance_end"]
    assert ev[0][1][1][0]["rh"] is not None                                       # starts at the entry, no empty pre-roll

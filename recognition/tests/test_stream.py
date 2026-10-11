"""Training-capture parity, null frames, and the live event stream (recognition.stream)."""
import json
import os
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np
import pytest

from recognition import features, framing, mediapipe_adapter as mpa, stream
from recognition.model import SignGRU, save_checkpoint
from recognition.recognizer import Recognizer, needs_repeat, validate
from recognition.segmenter import Segmenter
from recognition.stream import SignStream, Timings, describe

W, H = 1280, 720
A = W / H
HAND = np.random.default_rng(0).normal(0, 0.012, (21, 3))
HAND[0] = 0
REST_L, REST_R = (0.6, 0.86), (0.4, 0.86)       # hands resting at the waist, in the picture
SIGN_C = np.array([0.5, 0.42])


def lms(a, presence=0.99):
    return [NS(x=float(p[0]), y=float(p[1]), z=float(p[2]), visibility=presence, presence=presence) for p in a]


def holistic(lw, rw, rng, jitter=0.0015, face=True):
    """Raw HolisticLandmarkerResult-like object of a person framed head to waist; lw / rw: wrist (x, y) or None."""
    pose = np.zeros((33, 3))
    pose[0] = [0.5, 0.2, -0.3]
    pose[1:11] = pose[0] + rng.normal(0, 0.01, (10, 3))
    pose[11], pose[12] = [0.58, 0.36, 0], [0.42, 0.36, 0]
    pose[13], pose[14] = [0.62, 0.55, 0], [0.38, 0.55, 0]
    pose[23], pose[24] = [0.555, 0.82, 0], [0.445, 0.82, 0]
    pose[25:] = [0.5, 0.95, 0]
    hands = {}
    for key, w, idx, rest in (("lh", lw, 15, REST_L), ("rh", rw, 16, REST_R)):
        if w is None:
            pose[idx] = [rest[0], 0.9, 0]
            hands[key] = []
            continue
        h = HAND.copy()
        h[:, 0] /= A
        h[:, :2] += w
        h += rng.normal(0, jitter, h.shape)
        pose[idx] = h[0]
        hands[key] = lms(h)
    pose[:, :2] += rng.normal(0, jitter, (33, 2))
    return NS(pose_landmarks=lms(pose), left_hand_landmarks=hands["lh"], right_hand_landmarks=hands["rh"],
              face_landmarks=lms(rng.uniform(0.45, 0.55, (478, 3))) if face else [])


def motion(n, rest, rng, sign_at=15, sign_len=30, ramp=5):
    """n frames: hands rest (in the picture if rest else out of it), rise, sign, drop, rest."""
    out = []
    for i in range(n):
        if sign_at <= i < sign_at + sign_len:
            s = (i - sign_at) / 30
            d = 0.06 * np.array([np.cos(2 * np.pi * 1.5 * s) - 1, np.sin(2 * np.pi * 1.5 * s)])
            lw, rw = SIGN_C + [0.04, 0] + d, SIGN_C - [0.04, 0] + d * [-1, 1]
        elif sign_at - ramp <= i < sign_at or sign_at + sign_len <= i < sign_at + sign_len + ramp:
            k = (i - sign_at + ramp) / ramp if i < sign_at else 1 - (i - sign_at - sign_len) / ramp
            lw = np.array(REST_L) + k * (SIGN_C + [0.04, 0] - REST_L)
            rw = np.array(REST_R) + k * (SIGN_C - [0.04, 0] - REST_R)
        else:
            lw, rw = (REST_L, REST_R) if rest else (None, None)
        out.append(holistic(None if lw is None else tuple(lw), None if rw is None else tuple(rw), rng))
    return out


class Spy:
    """Recognizer stand-in: records what it is asked to classify."""

    def __init__(self, conf=0.9, label="YES"):
        self.got, self.conf, self.label = [], conf, label

    def predict(self, frames):
        self.got.append(frames)
        return [{"label": self.label, "conf": self.conf}, {"label": "NO", "conf": 0.05}, {"label": "NAME", "conf": 0.02}]


def capture_take(results, stamps_ms):
    """What capture.py writes for these MediaPipe results: clean([normalize(to_frame(r, w / h))], stamps)."""
    lm, clean = mpa.capture_modules()
    return clean.clean([lm.normalize(lm.to_frame(r, A)) for r in results], stamps_ms)


def run_live(results, times, rec=None, **kw):
    st = SignStream(rec or Spy(), (W, H), **kw)
    events = []
    for r, t in zip(results, times):
        events += st.push(r, t)
    return st, events + st.flush()


# ---------- 1. parity with capture.py ----------

def test_capture_mode_frame_is_capture_landmarks_output():
    rng = np.random.default_rng(1)
    r = holistic((0.6, 0.5), (0.4, 0.5), rng)
    lm, _ = mpa.capture_modules()
    want = lm.normalize(lm.to_frame(r, A))
    assert mpa.FrameAdapter(minimize=False, image_size=(W, H), mode="capture")(r) == want
    small = mpa.FrameAdapter(image_size=(W, H), mode="capture")(r)
    assert small["face"] is None and all(p == small["pose"][0] for p in small["pose"][1:11])
    for p in ("lh", "rh"):
        assert small[p] == want[p]
    assert [small["pose"][i] for i in [0] + list(range(11, 33))] == [want["pose"][i] for i in [0] + list(range(11, 33))]
    validate([small])


def test_capture_mode_settings():
    assert mpa.FrameAdapter(image_size=(W, H), mode="capture").y_scale == 1.0     # thresholds in real shoulder widths
    with pytest.raises(ValueError):
        mpa.FrameAdapter(mode="capture")
    with pytest.raises(ValueError):
        mpa.FrameAdapter(image_size=(W, H), mode="other")
    ad = mpa.FrameAdapter(image_size=(W, H), mode="capture")
    with pytest.raises(ValueError):
        ad(NS(pose_landmarks=[[]]), hands=NS(hand_landmarks=[]))
    assert ad(None) is None
    empty = NS(pose_landmarks=[], left_hand_landmarks=lms(np.full((21, 3), 0.5)), right_hand_landmarks=[],
               face_landmarks=[])
    assert ad(empty) is None                                                      # no pose: None, as capture.py
    assert mpa.to_frame(holistic(None, None, np.random.default_rng(0)), image_size=(W, H), mode="capture")["lh"] is None


def take_vs_live(seed, irregular):
    rng = np.random.default_rng(seed)
    take = motion(60, rest=False, rng=rng)
    stamps = list(np.cumsum(rng.uniform(30, 37, 60))) if irregular else [i * 1000 / 30 for i in range(60)]
    want = capture_take(take, stamps)
    before, after = motion(10, False, rng, sign_at=99), motion(45, False, rng, sign_at=99)
    times = [i / 30 for i in range(10)] + [10 / 30 + (s - stamps[0]) / 1000 for s in stamps]
    times += [times[-1] + (i + 1) / 30 for i in range(45)]
    spy = Spy()
    _, events = run_live(before + take + after, times, spy)
    assert [e["type"] for e in events if e["type"] != "framing"] == ["sign", "utterance"]
    assert len(spy.got) == 1
    assert spy.got[0][0]["face"] is None and want[0]["face"] is not None          # only the minimisation differs
    return spy.got[0], want


@pytest.mark.parametrize("seed", range(4))
def test_hands_from_below_take_matches_capture(seed):
    """A 2 s take where the hands come up from out of the picture: the live segment, cleaned, is the training file.
    At a steady 30 frames/s it is identical. With irregular frame times, capture's 30 fps resampling grid starts
    at the take's first frame (unknowable live), so a nearest-neighbour pick can move by one frame."""
    got, want = take_vs_live(seed, irregular=False)
    assert len(got) == len(want)
    np.testing.assert_allclose(features.prepare(got), features.prepare(want), atol=1e-6)
    got, want = take_vs_live(seed, irregular=True)
    assert abs(len(got) - len(want)) <= 1
    assert np.abs(features.prepare(got) - features.prepare(want)).mean() < 0.005


def test_hands_resting_in_view_take_is_close_to_capture():
    """Hands visible the whole time: a take keeps its whole 2 s window, the live segment at most 0.5 s either side
    of the movement, so the cut differs; check it stays close (window position is unknowable live)."""
    rng = np.random.default_rng(3)
    take = motion(60, rest=True, rng=rng)
    stamps = [i * 1000 / 30 for i in range(60)]
    want = capture_take(take, stamps)
    seq = motion(10, True, rng, sign_at=99) + take + motion(45, True, rng, sign_at=99)
    spy = Spy()
    run_live(seq, [i / 30 for i in range(len(seq))], spy)
    assert len(spy.got) == 1
    a, b = features.prepare(spy.got[0]), features.prepare(want)
    assert np.abs(a - b).mean() < 0.015
    assert abs(len(spy.got[0]) - len(want)) <= 8


def test_segment_extension_never_reaches_into_the_previous_sign():
    rng = np.random.default_rng(4)
    a = motion(40, True, rng, sign_at=5, sign_len=20)
    b = motion(60, True, rng, sign_at=5, sign_len=20)
    spy = Spy()
    st, events = run_live(a + b, [i / 30 for i in range(100)], spy)
    signs = [e for e in events if e["type"] == "sign"]
    assert len(signs) == 2 and signs[0]["t_sign_end"] < signs[1]["t_sign_start"]
    assert sum(len(g) for g in spy.got) <= 100


# ---------- null frames ----------

@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    path = tmp_path_factory.mktemp("s") / "model.pt"
    save_checkpoint(path, SignGRU().eval(), temperature=1.0)
    return path


def test_null_frames_inside_a_segment(ckpt):
    from fastapi.testclient import TestClient
    from recognition.server import create_app
    rng = np.random.default_rng(5)
    lm, _ = mpa.capture_modules()
    frames = [lm.normalize(lm.to_frame(r, A)) for r in motion(30, False, rng, sign_at=5, sign_len=20)]
    frames[3] = frames[12] = None
    empty = [f if f is not None else {"pose": None, "lh": None, "rh": None, "face": None} for f in frames]
    rec = Recognizer(ckpt)
    assert rec.predict(frames) == rec.predict(empty)
    c = TestClient(create_app(model_path=ckpt, mock=False, token=None), base_url="http://localhost",
                   client=("127.0.0.1", 50000))
    r = c.post("/predict", json={"frames": empty})
    assert r.status_code == 200 and r.json()["top"] == rec.predict(frames)
    assert c.post("/predict", json={"frames": frames}).status_code == 422
    assert c.post("/predict", json={"frames": [None] * 5}).status_code == 422
    assert rec.predict([None] * 5)[0]["label"] == "NONE"
    assert c.post("/predict", json={"frames": []}).status_code == 422


# ---------- events and timing ----------

def test_sign_event_comes_at_close_before_the_utterance_ends():
    rng = np.random.default_rng(6)
    seq = motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)
    st = SignStream(Spy(), (W, H), utterance_gap=1.5)
    got = []
    for i, r in enumerate(seq):
        got += [(i, e) for e in st.push(r, i / 30)]
    kinds = [(i, e["type"]) for i, e in got if e["type"] != "framing"]
    assert [k for _, k in kinds] == ["sign", "utterance"]
    (i_sign, sign), (i_utt, utt) = [(i, e) for i, e in got if e["type"] != "framing"]
    assert i_utt - i_sign >= 30                                                  # the sign did not wait for the utterance
    assert sign["seq"] == 1 and len(sign["top"]) == 3
    assert sign["t_sign_start"] <= sign["t_sign_end"] <= sign["t_closed"] <= sign["t_predicted"]
    assert utt == {"type": "utterance", "signs": [sign["top"][0]], "seqs": [1], "needs_repeat": False,
                   "t_end": utt["t_end"]}
    json.dumps(got)


def test_utterance_gap_is_a_parameter():
    def end_frame(gap):
        rng = np.random.default_rng(7)
        st = SignStream(Spy(), (W, H), utterance_gap=gap)
        for i, r in enumerate(motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)):
            if any(e["type"] == "utterance" for e in st.push(r, i / 30)):
                return i
    assert end_frame(1.5) - end_frame(0.8) == pytest.approx(0.7 * 30, abs=1)


def test_needs_repeat_uses_the_shared_rule():
    rng = np.random.default_rng(8)
    seq = motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)
    for conf, label in ((0.9, "YES"), (0.59, "YES"), (0.95, "NONE")):
        _, events = run_live(seq, [i / 30 for i in range(len(seq))], Spy(conf, label))
        utt = [e for e in events if e["type"] == "utterance"][0]
        assert utt["needs_repeat"] == needs_repeat(utt["signs"]) == (conf < 0.6 or label == "NONE")


def test_badly_framed_sign_is_not_classified_and_forces_a_repeat():
    rng = np.random.default_rng(9)
    seq = motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)
    for r in seq:                                    # hips below the picture the whole time (head to hips fits)
        for i in (23, 24):
            r.pose_landmarks[i].y = 0.99
    spy = Spy()
    _, events = run_live(seq, [i / 30 for i in range(len(seq))], spy)
    assert spy.got == []
    rejected = [e for e in events if e["type"] == "framing" and "rejected_seq" in e]
    assert len(rejected) == 1 and rejected[0]["status"] == framing.MOVE_CAMERA_DOWN
    utt = [e for e in events if e["type"] == "utterance"][0]
    assert utt["signs"] == [{"label": "NONE", "conf": 0.0}] and utt["needs_repeat"]
    _, events = run_live(seq, [i / 30 for i in range(len(seq))], spy, waist="none")
    assert len(spy.got) == 1 and not any("rejected_seq" in e for e in events)


def test_framing_events_on_held_changes_only():
    rng = np.random.default_rng(10)
    seq = [holistic(None, None, rng) for _ in range(30)] + [None] * 10 + [holistic(None, None, rng) for _ in range(30)]
    _, events = run_live(seq, [i / 30 for i in range(len(seq))])
    fr = [(e["status"], e["since"]) for e in events if e["type"] == "framing"]
    assert fr == [("OK", 0.0)]                                                   # a 0.33 s drop-out is not reported
    seq = [holistic(None, None, rng) for _ in range(30)] + [None] * 20 + [holistic(None, None, rng) for _ in range(30)]
    _, events = run_live(seq, [i / 30 for i in range(len(seq))])
    fr = [(e["status"], e["since"]) for e in events if e["type"] == "framing"]
    assert [s for s, _ in fr] == ["OK", "NO_PERSON", "OK"]
    assert fr[1][1] == pytest.approx(1.0, abs=1e-3) and fr[2][1] == pytest.approx(50 / 30, abs=1e-3)


def test_status_events_are_rate_limited_and_times_offset():
    clock = [100.0]
    st = SignStream(None, (W, H), clock=lambda: clock[0], time_offset=1000.0)
    first = st.status_event("no_model")
    assert first["type"] == "status" and first["recognizer"] == "no_model" and first["t"] == 1100.0
    clock[0] += 0.5
    assert st.status_event("no_model") is None
    clock[0] += 0.6
    assert st.status_event("ok") is not None


def test_no_model_gives_no_sign_events():
    rng = np.random.default_rng(11)
    seq = motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)
    st = SignStream(None, (W, H))
    events = []
    for i, r in enumerate(seq):
        events += st.push(r, i / 30)
    assert all(e["type"] == "framing" for e in events)


def test_timings_and_describe():
    t = Timings()
    for v in range(1, 101):
        t.add("predict_ms", v)
    p50, p95, n = t.pct("predict_ms")
    assert n == 100 and p50 == pytest.approx(50.5) and p95 == pytest.approx(95.05)
    s = t.summary(29.9)
    assert "predict 50/95 ms" in s and "MediaPipe -" in s and "29.9 frames/s" in s
    ev = {"type": "sign", "seq": 2, "top": [{"label": "YES", "conf": 0.9}], "t_sign_start": 1.0, "t_sign_end": 2.0,
          "t_closed": 2.5, "t_predicted": 2.51}
    assert describe(ev).startswith("  sign 2: YES 0.90") and "510 ms" in describe(ev)
    assert describe({"type": "status", "fps": 30, "recognizer": "ok", "t": 0}) is None


def test_segmenter_sign_event_stays_a_tuple():
    seg = Segmenter(close_sec=0.3, utterance_sec=0.6)
    pose = np.zeros((33, 3))
    pose[11], pose[12] = [0.5, 0, 0], [-0.5, 0, 0]
    out = []
    for i in range(80):
        rh = None
        if 10 <= i < 40:
            h = HAND.copy()
            h[:, :2] += [0.4 * np.cos(i / 3), 0.4 * np.sin(i / 3)]
            rh = h.tolist()
        out += [(i, e) for e in seg.push({"pose": pose.tolist(), "lh": None, "rh": rh, "face": None}, i / 30, tag=i)]
    (i_s, sign), (i_u, utt) = out
    kind, frames = sign
    assert kind == "sign" and sign[0] == "sign" and len(frames) == len(sign.times) == len(sign.tags)
    assert sign.tags == list(range(sign.tags[0], sign.tags[0] + len(frames)))
    assert sign.times[0] == sign.t_start <= sign.t_end < sign.t_close == i_s / 30
    assert sign.t_close - sign.t_end == pytest.approx(0.3, abs=0.04)
    assert utt == ("utterance_end",) and (i_u - 39) / 30 == pytest.approx(0.6, abs=0.04)


def test_max_sec_force_closes():
    seg = Segmenter(max_sec=1.0)
    pose = np.zeros((33, 3))
    pose[11], pose[12] = [0.5, 0, 0], [-0.5, 0, 0]
    signs = []
    for i in range(120):
        h = HAND.copy()
        h[:, :2] += [0.4 * np.cos(i / 3), 0.4 * np.sin(i / 3)]
        signs += [e for e in seg.push({"pose": pose.tolist(), "lh": None, "rh": h.tolist(), "face": None}, i / 30)
                  if e[0] == "sign"]
    assert len(signs) >= 3 and all(s.times[-1] - s.times[0] <= 1.0 + 1e-6 for s in signs)


REAL_IMAGE = os.environ.get("RECOGNITION_TEST_IMAGE")
REAL_TASK = Path(os.environ.get("RECOGNITION_HOLISTIC_TASK", mpa.DEFAULT_TASK))


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and REAL_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE and provide the holistic .task")
def test_real_holistic_capture_parity():
    """Real HolisticLandmarker: capture.landmarks.normalize(to_frame(res, w / h)) == FrameAdapter(mode='capture')."""
    pytest.importorskip("mediapipe")
    cv2 = pytest.importorskip("cv2")
    lm, _ = mpa.capture_modules()
    rgb = cv2.cvtColor(cv2.imread(REAL_IMAGE), cv2.COLOR_BGR2RGB)
    for img in (rgb, np.ascontiguousarray(rgb[:, : rgb.shape[1] // 2])):            # two aspect ratios
        h, w = img.shape[:2]
        res = mpa.detect_image(img, REAL_TASK)
        want = lm.normalize(lm.to_frame(res, w / h))
        got = mpa.FrameAdapter(minimize=False, image_size=(w, h), mode="capture")(res)
        assert want is not None and got is not None
        for p in features.PARTS:
            assert (want[p] is None) == (got[p] is None), p
            if want[p] is not None:
                assert np.abs(np.array(want[p]) - np.array(got[p])).max() <= 1e-5
        pose = np.array(got["pose"])
        assert np.allclose((pose[11, :2] + pose[12, :2]) / 2, 0, atol=1e-4)
        assert np.isclose(np.linalg.norm(pose[11, :2] - pose[12, :2]), 1, atol=1e-4)


def test_resting_hands_rule_scales_with_the_utterance_gap():
    pose = np.zeros((33, 3))
    pose[11], pose[12] = [0.5, 0, 0], [-0.5, 0, 0]

    def end(gap):
        seg = Segmenter(utterance_sec=gap)
        for i in range(300):
            h = HAND.copy()
            h[:, :2] += [0.4 * np.cos(i / 3), 0.4 * np.sin(i / 3)] if 10 <= i < 40 else [0.4, 0.0]   # then rests in the area
            if ("utterance_end",) in seg.push({"pose": pose.tolist(), "lh": None, "rh": h.tolist(), "face": None}, i / 30):
                return i / 30
    assert end(1.5) - end(0.75) == pytest.approx(1.5, abs=0.05)                  # 3.0 s -> 1.5 s of resting


def test_lead_in_is_at_most_context_before_sec():
    """Hands resting in view for 2 s before the sign: only CONTEXT_BEFORE_SEC of that rest (plus the segmenter's
    pre-roll) is added in front of the sign, not the whole rest."""
    from recognition import segmenter, stream as stream_mod
    rng = np.random.default_rng(12)
    seq = motion(130, True, rng, sign_at=60)
    spy = Spy()
    run_live(seq, [i / 30 for i in range(len(seq))], spy)
    assert len(spy.got) == 1
    wrist_y = [f["rh"][0][1] if f["rh"] else None for f in spy.got[0]]
    resting = next(i for i, y in enumerate(wrist_y) if y < 1.7)       # hands at the waist: about 1.76 below
    assert 0 < resting <= stream_mod.CONTEXT_BEFORE_SEC * 30 + segmenter.PREROLL + 1


def test_utterance_is_ended_at_max_signs():
    rng = np.random.default_rng(12)
    seq = motion(20, False, rng, sign_at=99)
    for _ in range(stream.MAX_UTTERANCE_SIGNS + 1):
        seq += motion(55, False, rng, sign_at=5)     # 0.5 s hands down between signs: no utterance end
    spy = Spy()
    _, events = run_live(seq, [i / 30 for i in range(len(seq))], spy)
    assert len(spy.got) == stream.MAX_UTTERANCE_SIGNS + 1
    utts = [e for e in events if e["type"] == "utterance"]
    assert [len(u["signs"]) for u in utts] == [stream.MAX_UTTERANCE_SIGNS, 1]
    assert utts[0]["seqs"] == list(range(1, stream.MAX_UTTERANCE_SIGNS + 1)) and utts[1]["seqs"] == [9]
    kinds = [e["type"] for e in events if e["type"] != "framing"]
    assert kinds.index("utterance") == stream.MAX_UTTERANCE_SIGNS           # sent right after the 8th sign


def test_no_person_after_a_small_person_is_come_closer():
    rng = np.random.default_rng(13)

    def small():
        r = holistic(None, None, rng)
        for p in r.pose_landmarks:
            p.x, p.y = 0.5 + (p.x - 0.5) * 0.35, 0.5 + (p.y - 0.5) * 0.35
        return r
    seq = [small() for _ in range(30)] + [None] * 60 + [None] * 60
    st = SignStream(Spy(), (W, H))
    statuses = []
    for i, r in enumerate(seq):
        st.push(r, i / 30)
        statuses.append(st.status)
    assert statuses[0] == framing.COME_CLOSER
    assert set(statuses[30:30 + 90]) == {framing.COME_CLOSER}                 # within FAR_MEMORY_SEC
    assert statuses[-1] == framing.NO_PERSON
    st = SignStream(Spy(), (W, H))
    for i, r in enumerate([holistic(None, None, rng)] * 5 + [None] * 5):
        st.push(r, i / 30)
    assert st.status == framing.NO_PERSON                                    # a normal-size person left

import json
import os
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np
import pytest

from recognition import features, mediapipe_adapter as mpa
from recognition.model import Predictor, SignGRU, save_checkpoint
from recognition.recognizer import COORD_LIMIT, validate
from recognition.tests.helpers import raw_frames


def lms(a):
    return [NS(x=float(p[0]), y=float(p[1]), z=float(p[2]), visibility=0.9, presence=0.9, name=None) for p in a]


def mesh(rng, n=478):
    return rng.uniform(0.3, 0.7, (n, 3))


def tasks_holistic(f, face=None):
    """Shaped like mediapipe 1.1.0 HolisticLandmarkerResult: flat lists, [] when missing."""
    part = lambda a: lms(a) if a is not None else []
    return NS(pose_landmarks=part(f["pose"]), left_hand_landmarks=part(f["lh"]), right_hand_landmarks=part(f["rh"]),
              face_landmarks=part(face), pose_world_landmarks=[], left_hand_world_landmarks=[],
              right_hand_world_landmarks=[], face_blendshapes=[], segmentation_mask=None)


def legacy_holistic(f, face=None):
    """Shaped like mp.solutions.holistic results: protos with .landmark, None when missing."""
    part = lambda a: NS(landmark=lms(a)) if a is not None else None
    return NS(pose_landmarks=part(f["pose"]), left_hand_landmarks=part(f["lh"]), right_hand_landmarks=part(f["rh"]),
              face_landmarks=part(face), pose_world_landmarks=None, segmentation_mask=None)


def pose_hands(f, order=(1, 0), labels=("Left", "Left")):
    """PoseLandmarkerResult + HandLandmarkerResult: list of lists; handedness deliberately wrong."""
    pose = NS(pose_landmarks=[lms(f["pose"])] if f["pose"] is not None else [], pose_world_landmarks=[])
    hs = [h for h in (f["lh"], f["rh"]) if h is not None]
    hs = [hs[i] for i in order if i < len(hs)]
    hands = NS(hand_landmarks=[lms(h) for h in hs], hand_world_landmarks=[],
               handedness=[[NS(category_name=labels[i % 2], score=0.9)] for i in range(len(hs))])
    return pose, hands


def raw(seed=0, **kw):
    f = raw_frames(1, np.random.default_rng(seed), **kw)[0]
    f["face"] = None
    return f


def expected(f, minimize=True):
    """features.normalize of the raw frame, pose 1-10 set to the nose when minimizing."""
    f = json.loads(json.dumps(f))
    if minimize and f["pose"] is not None:
        f["pose"][1:11] = [f["pose"][0]] * 10
    seq, ok = features.normalize([f])
    assert ok
    return {p: None if f[p] is None else seq[p][0] for p in features.PARTS}


def close(frame, exp, atol=1e-6):
    for p in features.PARTS:
        assert (frame[p] is None) == (exp[p] is None), p
        if exp[p] is not None:
            np.testing.assert_allclose(np.array(frame[p]), exp[p], atol=atol)


def test_tasks_holistic_matches_features_normalize():
    f = raw()
    out = mpa.to_frame(tasks_holistic(f, mesh(np.random.default_rng(1))))
    close(out, expected(f))
    assert out["face"] is None
    validate([out])
    json.dumps(out)
    assert all(type(v) is float for v in out["lh"][0])


def test_legacy_and_tasks_holistic_agree():
    f, m = raw(1), mesh(np.random.default_rng(2), 468)
    for minimize in (True, False):
        a = mpa.to_frame(tasks_holistic(f, m), minimize=minimize)
        b = mpa.to_frame(legacy_holistic(f, m), minimize=minimize)
        assert a == b


def test_pose_and_hand_landmarkers_assign_by_wrist_not_label():
    f = raw(2)
    want = mpa.to_frame(tasks_holistic(f))
    for order in ((0, 1), (1, 0)):
        for labels in (("Left", "Left"), ("Right", "Left"), ("Left", "Right")):
            close(mpa.to_frame(*pose_hands(f, order, labels)), want)


def test_single_hand_goes_to_the_nearer_wrist():
    f = raw(3, lh=False)
    out = mpa.to_frame(*pose_hands(f, labels=("Left", "Left")))
    assert out["lh"] is None and out["rh"] is not None
    f = raw(3, rh=False)
    out = mpa.to_frame(*pose_hands(f, labels=("Right", "Right")))
    assert out["rh"] is None and out["lh"] is not None


def test_extra_far_hand_is_dropped():
    f = raw(4)
    pose, hands = pose_hands(f)
    stranger = np.array(f["lh"]) + [5.0, 5.0, 0]
    hands.hand_landmarks.insert(0, lms(stranger))
    close(mpa.to_frame(pose, hands), mpa.to_frame(tasks_holistic(f)))


def test_minimize_removes_face_and_keeps_model_input(tmp_path):
    rng = np.random.default_rng(5)
    frames = raw_frames(25, rng)
    full, small = mpa.FrameAdapter(minimize=False), mpa.FrameAdapter()
    a = [full(tasks_holistic(f, mesh(rng))) for f in frames]
    b = [small(tasks_holistic(f, mesh(rng))) for f in frames]
    for fa, fb in zip(a, b):
        assert fb["face"] is None and len(fa["face"]) == 26
        assert all(p == fb["pose"][0] for p in fb["pose"][1:11])
        assert fa["pose"][1:11] != fb["pose"][1:11]
    assert np.array_equal(features.prepare(a), features.prepare(b))
    path = tmp_path / "m.pt"
    save_checkpoint(path, SignGRU().eval())
    pred = Predictor(path)
    assert pred.top(a) == pred.top(b)


def test_minimize_false_returns_the_26_face_points():
    f, m = raw(6), mesh(np.random.default_rng(6))
    out = mpa.to_frame(tasks_holistic(f, m), minimize=False)
    f["face"] = m[features.FACE_INDICES].tolist()
    close(out, expected(f, minimize=False))


def test_missing_parts_are_none():
    f = raw(7, lh=False, rh=False)
    for res in (tasks_holistic(f), legacy_holistic(f)):
        out = mpa.to_frame(res)
        assert out["lh"] is None and out["rh"] is None and out["face"] is None and out["pose"] is not None
    empty = {"pose": None, "lh": None, "rh": None, "face": None}
    for res in (tasks_holistic(empty), legacy_holistic(empty), None):
        assert mpa.to_frame(res) == empty
    assert mpa.to_frame(*pose_hands(empty)) == empty


def test_hands_without_any_pose_are_dropped():
    f = raw(8)
    f["pose"] = None
    assert mpa.to_frame(tasks_holistic(f)) == {"pose": None, "lh": None, "rh": None, "face": None}


def test_stream_reuses_last_shoulders_like_features_normalize():
    frames = raw_frames(8, np.random.default_rng(9))
    for f in frames:
        f["face"] = None
        f["pose"][1:11] = [f["pose"][0]] * 10
    frames[3]["pose"] = None
    frames[4]["pose"] = None
    want, ok = features.normalize(frames)
    assert ok
    adapter = mpa.FrameAdapter()
    holistic = [adapter(tasks_holistic(f)) for f in frames]
    adapter = mpa.FrameAdapter()
    combined = [adapter(*pose_hands(f)) for f in frames]
    for out in (holistic, combined):
        assert out[3]["pose"] is None and out[3]["lh"] is not None
        for t, fr in enumerate(out):
            for p in ("lh", "rh"):
                np.testing.assert_allclose(np.array(fr[p]), want[p][t], atol=1e-5)


def test_aspect_correct_scales_x_and_z_before_normalizing():
    f = raw(10)
    w, h = 1280, 720
    scaled = json.loads(json.dumps(f))
    for p in ("pose", "lh", "rh"):
        scaled[p] = (np.array(f[p]) * [w / h, 1, w / h]).tolist()
    out = mpa.to_frame(tasks_holistic(f), image_size=(w, h), aspect_correct=True)
    close(out, expected(scaled), atol=1e-5)
    assert mpa.to_frame(tasks_holistic(f), image_size=(w, h)) == mpa.to_frame(tasks_holistic(f))
    with pytest.raises(ValueError):
        mpa.FrameAdapter(aspect_correct=True)


def test_degenerate_or_exploding_parts_are_dropped():
    f = raw(11)
    f["pose"][12] = list(f["pose"][11])                       # shoulders coincide: cannot normalize
    assert mpa.to_frame(tasks_holistic(f))["pose"] is None
    f = raw(12)
    f["rh"][5] = [1e6, 0, 0]
    out = mpa.to_frame(tasks_holistic(f))
    assert out["rh"] is None and out["lh"] is not None
    assert mpa.MAX_ABS == COORD_LIMIT


def test_mediapipe_not_needed_to_import():
    assert "mediapipe" not in mpa.__dict__


REAL_IMAGE = os.environ.get("RECOGNITION_TEST_IMAGE")
REAL_TASK = Path(os.environ.get("RECOGNITION_HOLISTIC_TASK", mpa.DEFAULT_TASK))


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and REAL_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE (a person facing the camera) and provide the holistic .task")
def test_real_holistic_landmarker_on_an_image():
    pytest.importorskip("mediapipe")
    cv2 = pytest.importorskip("cv2")
    rgb = cv2.cvtColor(cv2.imread(REAL_IMAGE), cv2.COLOR_BGR2RGB)
    outs = []
    for video in (False, True):
        lm = mpa.load_holistic(REAL_TASK, video=video)
        img = mpa.mp_image(rgb)
        res = lm.detect_for_video(img, 0) if video else lm.detect(img)
        assert isinstance(res.pose_landmarks, list) and len(res.pose_landmarks) == 33
        assert hasattr(res.pose_landmarks[0], "x")                  # flat list, not list of lists
        outs.append(mpa.to_frame(res, image_size=(rgb.shape[1], rgb.shape[0])))
        full = mpa.to_frame(res, minimize=False)
        lm.close()
    out = outs[0]
    assert outs[1] == out
    validate([out])
    pose = np.array(out["pose"])
    assert np.allclose((pose[11] + pose[12]) / 2, 0, atol=1e-5)
    assert np.isclose(np.linalg.norm((pose[11] - pose[12])[:2]), 1, atol=1e-5)
    assert pose[11, 0] > 0                                         # unmirrored: person's left is on image right
    assert out["face"] is None and (pose[1:11] == pose[0]).all()
    assert out["lh"] is not None or out["rh"] is not None
    for side, w in (("lh", 15), ("rh", 16)):
        if out[side] is not None:
            d = [np.linalg.norm(np.array(out[side][0][:2]) - pose[k, :2]) for k in (15, 16)]
            assert d[w - 15] <= d[16 - w]
    if res.face_landmarks:
        assert len(full["face"]) == 26


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and REAL_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE (a person facing the camera) and provide the holistic .task")
def test_detect_image_has_no_state_between_images():
    pytest.importorskip("mediapipe")
    cv2 = pytest.importorskip("cv2")
    rgb = cv2.cvtColor(cv2.imread(REAL_IMAGE), cv2.COLOR_BGR2RGB)
    other = np.ascontiguousarray(cv2.resize(rgb, (rgb.shape[1] // 2, rgb.shape[0] // 2 + 7)))   # another size
    frames = [mpa.to_frame(mpa.detect_image(im, REAL_TASK)) for im in (rgb, other, rgb, rgb)]
    assert frames[0] == frames[2] == frames[3]
    assert frames[0]["pose"] is not None


def test_y_scale_for_the_segmenter():
    assert mpa.FrameAdapter().y_scale == 1.0
    assert mpa.FrameAdapter(image_size=(1280, 720)).y_scale == 720 / 1280
    assert mpa.FrameAdapter(image_size=(1280, 720), aspect_correct=True).y_scale == 1.0


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and REAL_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE (a person facing the camera) and provide the holistic .task")
def test_real_landmark_jitter_on_a_still_person_gives_no_sign():
    """Real MediaPipe jitter: the photo with camera noise and sub-pixel shake, as a 3 s VIDEO stream."""
    pytest.importorskip("mediapipe")
    cv2 = pytest.importorskip("cv2")
    from recognition.segmenter import Segmenter
    rgb = cv2.cvtColor(cv2.imread(REAL_IMAGE), cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    rng = np.random.default_rng(0)
    lm, adapter = mpa.load_holistic(REAL_TASK, video=True), mpa.FrameAdapter(image_size=(w, h))
    seg, events, hands = Segmenter(y_scale=adapter.y_scale), [], 0
    for i in range(90):
        noisy = np.clip(rgb + rng.normal(0, 6, rgb.shape), 0, 255).astype(np.uint8)
        shake = np.float32([[1, 0, rng.normal(0, 0.5)], [0, 1, rng.normal(0, 0.5)]])
        noisy = cv2.warpAffine(noisy, shake, (w, h), borderMode=cv2.BORDER_REFLECT)
        frame = adapter(lm.detect_for_video(mpa.mp_image(noisy), i * 33))
        hands += frame["lh"] is not None or frame["rh"] is not None
        events += seg.push(frame, i / 30)
    lm.close()
    assert hands > 60 and events + seg.flush() == []

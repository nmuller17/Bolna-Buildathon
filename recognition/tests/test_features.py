import numpy as np
import pytest

from recognition import features
from recognition.features import FACE_INDICES, FACE_LR, FEATURE_DIM, HAND_DIM
from recognition.tests.helpers import raw_frames
from recognition.tools.make_synthetic import body


def same(a, b, atol=1e-5):
    return all(np.allclose(a[p], b[p], atol=atol, equal_nan=True) for p in features.PARTS)


def test_shape_and_layout():
    frames = raw_frames(45, np.random.default_rng(0))
    x = features.prepare(frames)
    assert FEATURE_DIM == 141
    assert x.shape == (features.T_DEFAULT, FEATURE_DIM)
    assert x.dtype == np.float32 and np.isfinite(x).all()


def test_signfile_input():
    frames = raw_frames(10, np.random.default_rng(1))
    a = features.prepare(frames)
    b = features.prepare({"id": "YES", "frames": frames})
    assert np.array_equal(a, b)


def test_normalize_puts_shoulders_at_origin_unit_distance():
    seq, ok = features.normalize(raw_frames(5, np.random.default_rng(2)))
    assert ok
    l, r = seq["pose"][:, 11], seq["pose"][:, 12]
    assert np.allclose((l + r) / 2, 0, atol=1e-6)
    assert np.allclose(np.linalg.norm((l - r)[:, :2], axis=1), 1, atol=1e-6)


def test_normalize_idempotent_and_invariant_to_translation_scale():
    frames = raw_frames(20, np.random.default_rng(3))
    once, _ = features.normalize(frames)
    twice, _ = features.normalize(once)
    assert same(once, twice)
    moved = {p: (a * 3.7 + 0.4) for p, a in features.to_seq(frames).items()}
    assert same(features.normalize(moved)[0], once, atol=1e-4)


def test_normalize_missing_pose_reuses_neighbour_and_all_missing_is_flagged():
    frames = raw_frames(6, np.random.default_rng(4))
    frames[0]["pose"] = None
    frames[3]["pose"] = None
    seq, ok = features.normalize(frames)
    assert ok and np.isfinite(seq["rh"]).all()
    for f in frames:
        f["pose"] = None
    seq, ok = features.normalize(frames)
    assert not ok
    assert np.allclose(seq["rh"], features.to_seq(frames)["rh"])


def test_mirror_is_an_involution():
    seq, _ = features.normalize(raw_frames(12, np.random.default_rng(5), lh=False))
    assert same(features.mirror(features.mirror(seq)), seq, atol=0)
    m = features.mirror(seq)
    assert np.isnan(m["rh"]).all() and np.allclose(m["lh"][..., 0], -seq["rh"][..., 0])


def test_face_mirror_pairs_match_mesh_indices():
    pairs = {frozenset((FACE_INDICES[a], FACE_INDICES[b])) for a, b in FACE_LR}
    expected = {frozenset(p) for p in [(70, 300), (63, 293), (105, 334), (66, 296), (107, 336),
                                       (33, 263), (133, 362), (159, 386), (145, 374), (61, 291)]}
    assert pairs == expected
    # A symmetric face/pose maps onto itself under mirroring.
    pose, face = body(1, np.random.default_rng(0), 0.0)
    seq = {"pose": pose.astype(np.float32), "face": face.astype(np.float32),
           "lh": np.full((1, 21, 3), np.nan, np.float32), "rh": np.full((1, 21, 3), np.nan, np.float32)}
    seq["pose"][..., 2] = 0
    seq["face"][..., 2] = 0
    head_x = seq["face"][:, 24:25, 0].copy()  # undo the random head sway so the body is symmetric
    seq["face"][..., 0] -= head_x
    seq["pose"][:, :11, 0] -= head_x
    m = features.mirror(seq)
    assert np.allclose(m["face"], seq["face"], atol=1e-6)
    assert np.allclose(m["pose"], seq["pose"], atol=1e-6)


def test_missing_hand_forward_fill_then_zero():
    frames = raw_frames(20, np.random.default_rng(6))
    for t in range(5, 20):
        frames[t]["rh"] = None
    for f in frames:
        f["lh"] = None
    arr = features.frames_to_array(features.normalize(frames)[0])
    lh_present = arr[:, HAND_DIM - 1]
    rh_present = arr[:, 2 * HAND_DIM - 1]
    assert (lh_present == 0).all() and (arr[:, :HAND_DIM] == 0).all()
    assert (rh_present[:10] == 1).all()          # 5 real + 5 forward-filled
    assert (rh_present[10:] == 0).all() and (arr[10:, HAND_DIM:2 * HAND_DIM] == 0).all()
    assert np.allclose(arr[9, HAND_DIM:2 * HAND_DIM], arr[4, HAND_DIM:2 * HAND_DIM])


@pytest.mark.parametrize("T", [0, 1, 2, 300])
def test_any_length_resamples(T):
    frames = raw_frames(T, np.random.default_rng(7))
    x = features.prepare(frames)
    assert x.shape == (features.T_DEFAULT, FEATURE_DIM) and np.isfinite(x).all()


def test_augment_keeps_valid_sequences():
    rng = np.random.default_rng(8)
    seq, _ = features.normalize(raw_frames(40, rng))
    for _ in range(50):
        a = features.augment(seq, rng)
        assert features.seq_len(a) >= 2
        x = features.resample(features.frames_to_array(a))
        assert np.isfinite(x).all()


def test_hand_fraction():
    frames = raw_frames(10, np.random.default_rng(9), lh=False, rh=False)
    assert features.hand_fraction(frames) == 0
    frames[0]["rh"] = raw_frames(1, np.random.default_rng(0))[0]["rh"]
    assert features.hand_fraction(frames) == pytest.approx(0.1)


def test_hand_labels_do_not_matter():
    # Swapping lh/rh labels (another landmarker's handedness convention) gives identical features.
    frames = raw_frames(30, np.random.default_rng(10))
    frames[3]["lh"] = None
    frames[7]["rh"] = None
    swapped = [{**f, "lh": f["rh"], "rh": f["lh"]} for f in frames]
    assert np.array_equal(features.prepare(frames), features.prepare(swapped))
    seq, _ = features.normalize(frames)
    assert np.allclose(seq["rh"][7, 0, 0], features.normalize(swapped)[0]["rh"][7, 0, 0], equal_nan=True)
    assert np.isnan(seq["rh"][7]).all()  # a lone left hand stays left


def test_face_is_not_a_feature():
    frames = raw_frames(20, np.random.default_rng(11))
    rng = np.random.default_rng(0)
    jittered = [{**f, "face": (np.asarray(f["face"]) + rng.normal(0, 0.2, (26, 3))).tolist()} for f in frames]
    no_face = [{**f, "face": None} for f in frames]
    x = features.prepare(frames)
    assert np.array_equal(x, features.prepare(jittered)) and np.array_equal(x, features.prepare(no_face))


def test_wrist_z_is_not_a_feature():
    frames = raw_frames(10, np.random.default_rng(12))
    moved = [{**f, "pose": (np.asarray(f["pose"]) + [0, 0, 0.3]).tolist()} for f in frames]
    assert np.allclose(features.prepare(frames), features.prepare(moved), atol=1e-5)  # float32 rounding only


def test_pose_fraction():
    frames = raw_frames(10, np.random.default_rng(13))
    assert features.pose_fraction(frames) == 1.0
    for f in frames[:8]:
        f["pose"] = None
    assert features.pose_fraction(frames) == pytest.approx(0.2)
    assert features.pose_fraction([]) == 0.0

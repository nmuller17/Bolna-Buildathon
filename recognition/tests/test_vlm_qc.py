"""Tests for the training-take QC tool (recognition/vlm/landmark_qc.py, qc_takes.py). No model needed."""
import json
from pathlib import Path

import numpy as np
import pytest

from recognition.vlm import landmark_qc as LQ
from recognition.vlm import qc_takes as Q


def _frame(lx=None, rx=None, y=0.0):
    def hand(x):
        if x is None:
            return None
        return [[x + 0.01 * k, y + 0.02 * k, 0.0] for k in range(21)]
    return {"pose": [[0.0, 0.0, 0.0]] * 33, "lh": hand(lx), "rh": hand(rx), "face": None}


def _seq(xs, hand="rh", y=0.0):
    return [_frame(rx=x, y=y) if hand == "rh" else _frame(lx=x, y=y) for x in xs]


def test_to_array_shape_and_missing():
    a = LQ.to_array([_frame(rx=0.1), _frame()])
    assert a.shape == (2, 2, 21, 2)
    assert np.isnan(a[0, 0]).all() and not np.isnan(a[0, 1]).any()
    assert np.isnan(a[1]).all()


def test_mirror_swaps_hands_and_negates_x():
    a = LQ.to_array([_frame(rx=0.3)], mirror=True)
    assert np.isnan(a[0, 1]).all()
    assert a[0, 0, 0, 0] == pytest.approx(-0.3)


def test_dtw_zero_for_identical_and_time_warp():
    a = LQ.to_array(_seq(np.linspace(0, 1, 20)))
    b = LQ.to_array(_seq(np.linspace(0, 1, 40)))     # same path, slower
    assert LQ.dtw_distance(a, a) == pytest.approx(0.0)
    assert LQ.dtw_distance(a, b) < 0.02
    c = LQ.to_array(_seq(np.linspace(1, 0, 20)))     # reversed path
    assert LQ.dtw_distance(a, c) > LQ.dtw_distance(a, b)


def test_missing_hand_penalty():
    a = LQ.to_array(_seq([0.0] * 5, hand="rh"))
    b = LQ.to_array(_seq([0.0] * 5, hand="lh"))
    # rh present only in a, lh only in b -> both hands pay the penalty, averaged over 2 hands
    assert LQ.dtw_distance(a, b) == pytest.approx(LQ.MISSING_PENALTY)
    assert LQ.dtw_distance(a, a[:0]) == float("inf")


def test_feature_subsets():
    a = LQ.to_array(_seq([0.0] * 5))
    b = LQ.to_array(_seq([0.5] * 5))                 # same handshape, shifted location
    assert LQ.dtw_distance(a, b, features="shape") == pytest.approx(0.0, abs=1e-9)
    assert LQ.dtw_distance(a, b, features="wrist") == pytest.approx(0.25)   # 0.5 on one hand / 2
    with pytest.raises(ValueError):
        LQ.select(a, "bogus")


def test_auc():
    assert LQ.auc([3, 4], [1, 2]) == 1.0
    assert LQ.auc([1], [1]) == 0.5
    assert LQ.auc([], [1]) is None
    assert LQ.auc([None, 2], [1]) == 1.0


def test_pool_median_ignores_inf():
    assert LQ.pool_median([1.0, float("inf"), 3.0]) == 2.0
    assert LQ.pool_median([]) == float("inf")


def _write_take(folder: Path, name: str, xs):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps({"id": "X", "frames": _seq(xs)}))
    (folder / f"{name}.mp4").write_bytes(b"")


def test_landmark_scores_flags_the_odd_take(tmp_path):
    good = [np.linspace(0, 1, 20) + 0.01 * k for k in range(5)]
    for k, xs in enumerate(good):
        _write_take(tmp_path / "train", f"amy_{k + 1}", xs)
    _write_take(tmp_path / "bad", "amy_9", np.linspace(1, 0, 20))
    takes = [Q.Take("X", "amy", p, None) for p in sorted((tmp_path / "train").glob("*.json"))]
    takes.append(Q.Take("X", "amy", tmp_path / "bad" / "amy_9.json", None))
    ref = LQ.to_array(_seq(np.linspace(0, 1, 25)))
    rows = Q.landmark_scores(takes, ref)
    worst = max(rows, key=lambda r: r["pool_dtw"])
    assert worst["take"] == "bad/amy_9.json"
    assert max(rows, key=lambda r: r["ref_dtw"])["take"] == "bad/amy_9.json"
    assert all("ref_rel" in r for r in rows)


def test_check_never_deletes(tmp_path, monkeypatch, capsys):
    train = tmp_path / "data" / "train" / "X"
    for k in range(4):
        _write_take(train, f"amy_{k + 1}", np.linspace(0, 1, 15) + 0.01 * k)
    ref_dir = tmp_path / "ref"
    ref_dir.mkdir()
    (ref_dir / "X.json").write_text(json.dumps({"frames": _seq(np.linspace(0, 1, 15))}))
    monkeypatch.setattr(Q, "TRAIN_JSON", tmp_path / "data" / "train")
    monkeypatch.setattr(Q, "TRAIN_VIDEO", tmp_path / "videos")
    before = sorted(p.name for p in train.iterdir())
    rc = Q.main(["check", "--person", "amy", "--sign", "X", "--ref-landmarks", str(ref_dir)])
    assert rc == 0
    assert sorted(p.name for p in train.iterdir()) == before
    assert "Nothing is deleted" in capsys.readouterr().out


class _FakeEngine:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def generate(self, images, prompt, max_tokens=None, timeout_s=None):
        from recognition.vlm.engine import VLMResult
        self.calls.append((len(images), prompt))
        return VLMResult(text=self.text, engine="fake", model="fake", latency_s=0.1, n_images=len(images))


def test_vlm_judge_uses_shared_prompt_and_parses(monkeypatch):
    from recognition.vlm import frames as F

    class S:
        images = ["img"] * 8
    monkeypatch.setattr(F, "sample_frames", lambda *a, **k: S())
    eng = _FakeEngine('{"same_sign": false, "score": 0.2, "issues": ["wrong location"]}')
    v = Q.vlm_judge(eng, Path("take.mp4"), "PASSWORD")
    assert eng.calls[0][0] == 16
    assert "REFERENCE" in eng.calls[0][1] and "PASSWORD" in eng.calls[0][1]
    assert v["flag"] is True and v["suspicion"] == pytest.approx(0.8)
    eng2 = _FakeEngine("I think they match.")
    v2 = Q.vlm_judge(eng2, Path("take.mp4"), "YES")
    assert v2["flag"] is None and v2["suspicion"] is None and v2["format"] == "unparsed"

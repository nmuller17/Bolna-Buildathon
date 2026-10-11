"""Facial-grammar feasibility helpers without a model: geometry, crop conditions, summary."""
import numpy as np
import pytest

from recognition.vlm import facial as FA


def _face(brow_y=-0.8, eye_y=-0.73, nose=(0.0, -0.65)):
    pts = [[0.0, 0.0, 0.0] for _ in range(26)]
    for i in FA.BROW_IDX:
        pts[i] = [0.0, brow_y, 0.0]
    for i in FA.EYE_IDX:
        pts[i] = [0.0, eye_y, 0.0]
    pts[FA.NOSE_TIP] = [nose[0], nose[1], 0.0]
    return pts


def test_face_geometry_brow_raise_and_nose_range():
    frames = [{"face": _face(nose=(x, -0.65))} for x in (0.0, 0.05, -0.05, 0.0)]
    frames.append({"face": None})
    g = FA.face_geometry(frames)
    assert g["n_face_frames"] == 4
    assert g["brow_raise_median"] == pytest.approx(0.07)
    assert g["nose_x_range"] == pytest.approx(0.10) and g["nose_y_range"] == pytest.approx(0.0)
    assert FA.face_geometry([{"face": None}] * 5) is None


def _clip(n=30):
    rng = np.random.default_rng(1)
    return [rng.integers(0, 255, (90, 160, 3), dtype=np.uint8) for _ in range(n)]


def test_condition_inputs_mirror_jitter_and_full():
    fr = _clip()
    box = (40, 10, 100, 70)
    crop, idx = FA.condition_inputs(fr, "crop", n=4, box=box, crop_size=32)
    mir, idx_m = FA.condition_inputs(fr, "crop_mirror", n=4, box=box, crop_size=32)
    jit, idx_j = FA.condition_inputs(fr, "crop_jitter", n=4, box=box, crop_size=32, jitter=2)
    full, _ = FA.condition_inputs(fr, "full", n=4, full_long_side=64)
    assert idx == idx_m and idx_j == [min(len(fr) - 1, i + 2) for i in idx]
    assert crop[0].size == (32, 32) and full[0].size == (64, 36)
    a, b = np.asarray(crop[0]), np.asarray(mir[0])
    assert np.array_equal(a[:, ::-1], b)
    with pytest.raises(ValueError):
        FA.condition_inputs(fr, "crop", n=4, box=None)


def test_crop_prompt_mentions_face_crops_and_keeps_schema():
    p = FA.build_facial_crop_prompt(8)
    assert "close-up crops of the head and face" in p and '"marker"' in p


def test_summary_agreement_and_false_alarms():
    def row(clip, cond, marker, brows="neutral", head="none", protocol="neutral_face"):
        return {"clip": clip, "condition": cond, "status": "ok", "marker": marker, "brows": brows,
                "head": head, "protocol": protocol, "latency_s": 1.0,
                "geometry": {"brow_raise_median": 0.07, "nose_x_range": 0.02, "nose_y_range": 0.02}}
    rows = [row("a", "crop", "neutral"), row("a", "crop_mirror", "neutral"),
            row("b", "crop", "wh_question", brows="furrowed"), row("b", "crop_mirror", "neutral"),
            row("b", "full", "wh_question", brows="Furrowed")]
    s = FA.summarize(rows)
    assert s["marker_agreement_vs_crop"]["crop_mirror"]["agree"] == 1
    assert s["marker_agreement_vs_crop"]["crop_mirror"]["n"] == 2
    assert s["brows_agreement_vs_crop"]["full"] == {"agree": 1, "n": 1, "ci": FA.wilson(1, 1)}
    assert s["talha_false_alarm_crop"]["non_neutral"] == 1 and s["talha_false_alarm_crop"]["n"] == 2

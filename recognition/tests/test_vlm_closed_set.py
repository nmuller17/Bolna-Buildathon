"""Closed-set baseline plumbing: clip discovery, label shuffling, record schema, statistics
(no model needed)."""
import json

import pytest

from recognition.vlm import closed_set as C
from recognition.vlm import prompts as P


def _touch(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"")


def test_talha_clips_keeps_only_complete_classes(tmp_path):
    for i in range(1, 4):
        _touch(tmp_path / "YES" / f"talha_{i}.mp4")
    _touch(tmp_path / "NO" / "talha_1.mp4")
    _touch(tmp_path / "BOGUS" / "talha_1.mp4")
    for i in range(1, 4):
        _touch(tmp_path / "BOGUS" / f"talha_{i}.mp4")
    clips = C.talha_clips(tmp_path, min_clips=3)
    assert [c["clip_id"] for c in clips] == ["YES/talha_1", "YES/talha_2", "YES/talha_3"]
    assert {c["signer"] for c in clips} == {"talha"} and {c["true_label"] for c in clips} == {"YES"}


def test_talha_clips_numeric_order_and_checkout_alias(tmp_path):
    for i in (1, 2, 10):
        _touch(tmp_path / "FS-CHECKOUT" / f"talha_{i}.mp4")
    clips = C.talha_clips(tmp_path, min_clips=3)
    assert [c["clip_id"] for c in clips] == ["FS-CHECKOUT/talha_1", "FS-CHECKOUT/talha_2",
                                             "FS-CHECKOUT/talha_10"]
    assert clips[0]["true_label"] == "LEAVE"


def test_reference_clips(tmp_path):
    _touch(tmp_path / "YES.mp4")
    _touch(tmp_path / "LEAVE.mp4")
    _touch(tmp_path / "notes.mp4")
    clips = C.reference_clips(tmp_path)
    assert [(c["clip_id"], c["true_label"], c["signer"]) for c in clips] == [
        ("reference/LEAVE", "LEAVE", "reference"), ("reference/YES", "YES", "reference")]


def test_label_order_fixed_and_shuffled_are_reproducible_permutations():
    assert C.label_order("YES/talha_1", "fixed") == P.LABELS
    a = C.label_order("YES/talha_1", "shuffled")
    assert a == C.label_order("YES/talha_1", "shuffled")
    assert sorted(a) == sorted(P.LABELS) and a != P.LABELS
    assert a != C.label_order("YES/talha_2", "shuffled")
    with pytest.raises(ValueError):
        C.label_order("x", "reversed")
    prompt = P.build_closed_set(8, labels=a, hints=True)
    assert prompt.index(f"- {a[0]}:") < prompt.index(f"- {a[-1]}:")


def test_system_name():
    assert C.system_name("mlx-community/Qwen3-VL-4B-Instruct-4bit", 8, True, "fixed") == \
        "vlm_qwen3vl4b_8f_hints_fixed"
    assert C.system_name("org/Some-Model", 4, False, "shuffled") == "vlm_somemodel_4f_nohints_shuffled"


def test_make_record_schema():
    clip = {"clip_id": "YES/talha_1", "signer": "talha", "true_label": "YES", "path": "/x.mp4"}
    parsed = P.parse_closed_set('{"label": "NO", "confidence": 0.9, "top3": ["NO", "YES", "MORE"]}')
    rec = C.make_record("sys", clip, parsed, 7.5, format=parsed["format"])
    assert {"system", "clip_id", "signer", "true_label", "top", "latency_s"} <= set(rec)
    assert rec["top"] == [{"label": "NO", "conf": 0.9}, {"label": "YES", "conf": None},
                          {"label": "MORE", "conf": None}]
    assert rec["top3"] == rec["top"] and rec["answered"] is True
    json.dumps(rec)
    bad = C.make_record("sys", clip, P.parse_closed_set("I cannot tell."), 3.0)
    assert bad["top"] == [] and bad["answered"] is False and C.pred(bad) is None


def test_wilson_and_percentile():
    lo, hi = C.wilson(0, 10)
    assert lo == 0.0 and 0.27 < hi < 0.29
    lo, hi = C.wilson(5, 10)
    assert abs(lo - 0.2366) < 1e-3 and abs(hi - 0.7634) < 1e-3
    assert C.wilson(0, 0) == (0.0, 1.0)
    assert C.percentile([1, 2, 3, 4], 50) == 2.5
    assert C.percentile([5.0], 95) == 5.0 and C.percentile([], 50) is None


def _rec(cid, true, pred, order=None, lat=5.0, conf=0.9):
    top = [{"label": pred, "conf": conf}] if pred else []
    return {"clip_id": cid, "signer": "talha", "true_label": true, "top": top, "latency_s": lat,
            "label_order": order or P.LABELS, "format": "json" if pred else "unparsed"}


def test_summarize_records_counts():
    recs = [_rec("a", "YES", "YES"), _rec("b", "YES", "NO"), _rec("c", "NO", "NO"),
            _rec("d", "NO", None, lat=9.0)]
    s = C.summarize_records(recs)
    assert s["n_clips"] == 4 and s["correct"] == 2 and s["top1"] == 0.5
    assert s["invalid_outputs"] == 1 and s["per_class"]["YES"]["recall"] == 0.5
    assert s["top_confusions"][0]["n"] == 1
    assert s["chance_uniform_22"] == pytest.approx(1 / 22)
    assert s["chance_best_constant_guess"] == 0.5
    assert s["latency_s_p50"] == 5.0
    assert s["chosen_position_counts"] == {0: 1, 1: 2}   # YES once, NO twice


def test_order_comparison_detects_first_position_habit():
    fixed, shuf = [], []
    for i in range(10):
        cid = f"YES/talha_{i}"
        order = C.label_order(cid, "shuffled")
        fixed.append(_rec(cid, "YES", "YES"))
        shuf.append(_rec(cid, "YES", order[0], order=order))   # always picks the first listed
    o = C.order_comparison(fixed, shuf)
    assert o["n_paired_clips"] == 10
    assert o["shuffled_answers_in_first_3_positions"] == 10
    assert o["same_answer"] == sum(r["top"][0]["label"] == "YES" for r in shuf)


def test_per_class_subset_keeps_first_takes_of_each_class():
    clips = [{"clip_id": f"{lab}/talha_{i}", "signer": "talha", "true_label": lab}
             for lab in ("YES", "NO") for i in range(1, 5)]
    clips.append({"clip_id": "reference/YES", "signer": "reference", "true_label": "YES"})
    sub = C.per_class_subset(clips, 2)
    assert [c["clip_id"] for c in sub] == ["YES/talha_1", "YES/talha_2", "NO/talha_1", "NO/talha_2",
                                          "reference/YES"]

"""Regression tests for the five review findings (no model needed)."""
import multiprocessing as mp
import time

import numpy as np
import pytest

from recognition.vlm import engine as E
from recognition.vlm import fallback as FB
from recognition.vlm import prompts as P
from recognition.vlm.engine import VLMResult


# ---- finding 1: offline, pinned load ------------------------------------------------------
def test_default_model_is_pinned_and_offline_by_default(monkeypatch):
    monkeypatch.delenv("SIGNBRIDGE_VLM_ALLOW_DOWNLOAD", raising=False)
    m = E.LocalVLM(load=False)
    assert m.revision == E.PINNED_REVISIONS[E.DEFAULT_LOCAL_MODEL]
    assert len(m.revision) == 40 and m.allow_download is False


def test_resolve_local_model_never_downloads(tmp_path, monkeypatch):
    pytest.importorskip("huggingface_hub")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))   # empty cache
    import huggingface_hub.constants as C
    monkeypatch.setattr(C, "HF_HUB_CACHE", str(tmp_path))
    with pytest.raises(Exception):
        E.resolve_local_model("mlx-community/this-model-is-not-cached-xyz", None)
    d = tmp_path / "local_model"
    d.mkdir()
    assert E.resolve_local_model(str(d)) == str(d)       # a local folder is used as is


# ---- finding 5: one resident model per machine ---------------------------------------------
def _hold_resident(path, ready, seconds):
    m = E.LocalVLM(load=False, resident_lock_path=path)
    m._take_resident()
    ready.set()
    time.sleep(seconds)
    m._release_resident()


def test_second_resident_model_is_refused_or_waits(tmp_path):
    path = str(tmp_path / "resident.lock")
    ctx = mp.get_context("spawn")
    ready = ctx.Event()
    p = ctx.Process(target=_hold_resident, args=(path, ready, 1.5))
    p.start()
    try:
        assert ready.wait(20)
        assert E.resident_holder(path) == str(p.pid)
        product = E.LocalVLM(load=False, resident_lock_path=path, resident_timeout_s=0)
        t0 = time.monotonic()
        with pytest.raises(E.ModelResident, match="pid"):
            product._take_resident()
        assert time.monotonic() - t0 < 1.0
        batch = E.LocalVLM(load=False, resident_lock_path=path, resident_timeout_s=20)
        batch._take_resident()          # waits until the holder lets go
        assert batch._resident_fd is not None
        batch._release_resident()
        assert E.resident_holder(path) is None
    finally:
        p.join(10)
        if p.is_alive():
            p.kill()


def test_unload_releases_resident_lock(tmp_path):
    path = str(tmp_path / "resident.lock")
    m = E.LocalVLM(load=False, resident_lock_path=path)
    m._take_resident()
    m.unload()
    assert m._resident_fd is None and E.resident_holder(path) is None


def test_recorder_check_ignores_non_python_shells():
    assert E.recorder_running("this-pattern-is-not-running-xyz-123") is False


# ---- finding 2: the shipped fallback shuffles the list on every call -----------------------
class _Capture:
    engine = "local-mlx"

    def __init__(self, text='{"candidates": ["TOWEL"], "none_of_these": false}', timed_out=False):
        self.text, self.timed_out, self.lock_timeout_s, self.prompts = text, timed_out, None, []

    def generate(self, images, prompt, max_tokens=None, timeout_s=None):
        self.prompts.append(prompt)
        return VLMResult(text=self.text, engine=self.engine, model="fake", latency_s=1.0,
                         timed_out=self.timed_out)


def _frames(n=20):
    rng = np.random.default_rng(0)
    return [rng.integers(0, 255, (60, 80, 3), dtype=np.uint8) for _ in range(n)]


def _order(prompt):
    ids = [r["id"] for r in FB.HOTEL_REQUESTS]
    return sorted(ids, key=lambda i: prompt.index(f"- {i}: "))


def test_propose_shuffles_request_list_per_call():
    eng = _Capture()
    fb = FB.Fallback(eng, seed=1)
    for _ in range(4):
        fb.propose(_frames())
    orders = [tuple(_order(p)) for p in eng.prompts]
    assert len(set(orders)) == 4                                  # a fresh order every call
    assert all(sorted(o) == sorted(r["id"] for r in FB.HOTEL_REQUESTS) for o in orders)
    assert list(orders[-1]) == fb.last_order
    eng2 = _Capture()
    FB.Fallback(eng2, shuffle=False).propose(_frames())
    assert _order(eng2.prompts[0]) == [r["id"] for r in FB.HOTEL_REQUESTS]


def test_position_bias_reports_first5_against_expectation():
    rows = [{"cand_pos": [0], "list_len": 48}] * 9 + [{"cand_pos": [30], "list_len": 48}]
    b = FB.position_bias(rows)
    assert b["top1_in_first5_of_list"] == 9 and b["top1_first5_n"] == 10
    assert b["top1_first5_expected"] == pytest.approx(1.0, abs=0.05)
    assert b["top1_first5_p"] < 1e-6
    assert FB.position_bias([])["top1_first5_p"] is None


# ---- finding 3: timeout is reported as timeout ----------------------------------------------
def test_timeout_status_is_not_overwritten_by_unparsed():
    ev = FB.Fallback(_Capture(text='{"candidates": ["TOW', timed_out=True)).propose(_frames())
    assert ev["status"] == "timeout"
    ev = FB.Fallback(_Capture(text="garbage")).propose(_frames())
    assert ev["status"] == "unparsed"


# ---- finding 4: plain English must not read as our sign NO ---------------------------------
@pytest.mark.parametrize("text", ["No sign is visible.", "I see no sign here", "no idea", "Nope"])
def test_closed_set_free_text_does_not_invent_no(text):
    r = P.parse_closed_set(text)
    assert r["label"] != "NO"


def test_closed_set_free_text_capitals_still_parse():
    assert P.parse_closed_set("NO SIGN visible")["label"] == "NONE"
    assert P.parse_closed_set("The answer is NO.")["label"] == "NO"
    assert P.parse_closed_set("I think this is the sign WHERE, maybe TIME.")["label"] == "WHERE"

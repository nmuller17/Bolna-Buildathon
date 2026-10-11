"""Out-of-vocabulary fallback without a model: request list, prompt, parser, hook, ring, stats."""
import numpy as np
import pytest

from recognition.vlm import fallback as FB
from recognition.vlm import prompts as P
from recognition.vlm.engine import VLMResult


def test_request_list_covers_our_signs_and_adds_outside_ones():
    ids = [r["id"] for r in FB.HOTEL_REQUESTS]
    assert len(ids) == len(set(ids))
    assert 30 <= len(ids) <= 50
    ours = {r["sign"] for r in FB.HOTEL_REQUESTS if r["sign"]}
    assert ours == set(P.LABELS) - {"NONE"}
    assert sum(1 for r in FB.HOTEL_REQUESTS if r["sign"] is None) >= 20
    assert all(r["english"] and r["hint"] for r in FB.HOTEL_REQUESTS)


def test_prompt_lists_every_request_and_the_escape():
    p = FB.build_fallback_prompt(4)
    assert "4 frames" in p and FB.NONE_OF_THESE in p
    for r in FB.HOTEL_REQUESTS:
        assert f"- {r['id']}:" in p
    assert "Sign:" not in FB.build_fallback_prompt(4, hints=False)


def test_parse_json_candidates_normalises_and_drops_unknown():
    p = FB.parse_fallback('```json\n{"candidates": ["towel", "Thank you", "WIFI", "SPACESHIP"], '
                          '"none_of_these": false, "what_i_see": "x"}\n```')
    assert p["ok"] and p["candidates"] == ["TOWEL", "THANK-YOU", "FS-WIFI"]
    assert p["dropped"] == ["SPACESHIP"] and p["none_of_these"] is False


def test_parse_none_of_these_and_checkout_synonym():
    p = FB.parse_fallback('{"candidates": ["NONE-OF-THESE"], "none_of_these": true}')
    assert p["ok"] and p["candidates"] == [] and p["none_of_these"] and p["model_none"]
    p = FB.parse_fallback('{"candidates": ["checkout", "toilet"], "none_of_these": false}')
    assert p["candidates"] == ["LEAVE", "BATHROOM"]


def test_parse_free_text_and_garbage_never_raise():
    p = FB.parse_fallback("I think this is TOWEL or maybe MORE.")
    assert p["format"] == "free_text" and p["candidates"] == ["TOWEL", "MORE"]
    for bad in ("", None, "{{{", "no idea"):
        assert FB.parse_fallback(bad)["candidates"] == []


@pytest.mark.parametrize("top,expect", [
    ([{"label": "TOWEL", "conf": 0.9}], False),
    ([{"label": "TOWEL", "conf": 0.6}], False),
    ([{"label": "TOWEL", "conf": 0.59}], True),
    ([{"label": "NONE", "conf": 0.99}], True),
    ([], True),
    ([{"label": "TOWEL", "conf": float("nan")}], True),
])
def test_should_fallback_matches_the_repeat_rule(top, expect):
    assert FB.should_fallback(top) is expect


def test_frame_ring_downscales_keeps_window_and_clears():
    ring = FB.FrameRing(seconds=1.0, fps=10, long_side=64)
    for i in range(25):
        ring.push(np.full((120, 160, 3), i, np.uint8), t=i / 10)
    assert len(ring) == 10                       # 1 s at 10 fps
    seg = ring.segment(2.0, 2.25)
    assert [int(f[0, 0, 0]) for f in seg] == [20, 21, 22]
    assert seg[0].shape == (48, 64, 3)
    ring.clear()
    assert len(ring) == 0


class _FakeLocal:
    engine = "local-mlx"

    def __init__(self, text="", exc=None):
        self.text, self.exc, self.lock_timeout_s, self.calls = text, exc, None, []

    def generate(self, images, prompt, max_tokens=None, timeout_s=None):
        self.calls.append((len(images), self.lock_timeout_s, timeout_s))
        if self.exc:
            raise self.exc
        return VLMResult(text=self.text, engine=self.engine, model="fake", latency_s=1.234)


def _frames(n=20):
    rng = np.random.default_rng(0)
    return [rng.integers(0, 255, (60, 80, 3), dtype=np.uint8) for _ in range(n)]


def test_fallback_event_shape_and_confirmation():
    eng = _FakeLocal('{"candidates": ["TOWEL", "KEY"], "none_of_these": false}')
    fb = FB.Fallback(eng, n_frames=4, timeout_s=9, lock_timeout_s=0.25)
    ev = fb.propose(_frames(), seq=3, classifier_top=[{"label": "NONE", "conf": 0.4}])
    assert ev["type"] == "fallback" and ev["seq"] == 3 and ev["status"] == "ok"
    assert ev["needs_confirmation"] is True and ev["none_of_these_option"] is True
    assert [c["id"] for c in ev["candidates"]] == ["TOWEL", "KEY"]
    assert ev["candidates"][1]["sign"] is None and ev["latency_s"] == 1.23
    assert eng.calls == [(4, 0.25, 9)] and eng.lock_timeout_s is None   # restored


def test_fallback_busy_error_and_no_frames_do_not_raise():
    from recognition.vlm.engine import LockTimeout
    assert FB.Fallback(_FakeLocal(exc=LockTimeout("x"))).propose(_frames())["status"] == "busy"
    assert FB.Fallback(_FakeLocal(exc=RuntimeError("x"))).propose(_frames())["status"].startswith("error")
    assert FB.Fallback(_FakeLocal()).propose([])["status"] == "no_frames"
    assert FB.Fallback(_FakeLocal("garbage")).propose(_frames())["status"] == "unparsed"


def test_fallback_refuses_non_local_engine():
    class Remote(_FakeLocal):
        engine = "claude-api"
    with pytest.raises(ValueError, match="LOCAL"):
        FB.Fallback(Remote())


def test_wilson_and_scoring():
    lo, hi = FB.wilson(5, 10)
    assert 0.23 < lo < 0.24 and 0.76 < hi < 0.77
    assert FB.wilson(0, 10)[0] == 0.0
    rows = [{"truth": "TOWEL", "candidates": ["TOWEL"], "latency_s": 1.0},
            {"truth": "TOWEL", "candidates": ["MORE", "TOWEL"], "latency_s": 2.0},
            {"truth": "YES", "candidates": ["NO"], "latency_s": 3.0},
            {"truth": "YES", "candidates": [], "latency_s": 4.0}]
    s = FB.score_rows(rows)
    assert (s["top1"], s["top3"], s["wrong_no_abstain"], s["abstained"]) == (1, 2, 1, 1)
    assert s["latency_p50_s"] == 2.5


def test_eval_clip_truths_are_request_ids():
    for c in FB.eval_clips("reference") if FB.REF_DIR.exists() else []:
        assert c["truth"] in FB.REQUEST_BY_ID

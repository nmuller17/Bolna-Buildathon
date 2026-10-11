"""Engine plumbing without a model: machine-wide lock, recorder check, Claude guard rails."""
import multiprocessing as mp
import os
import time

import pytest

from recognition.vlm import engine as E


def _hold(path, ready, seconds):
    with E.inference_lock(path):
        ready.set()
        time.sleep(seconds)


def test_lock_is_exclusive_across_processes(tmp_path):
    path = str(tmp_path / "vlm.lock")
    ctx = mp.get_context("spawn")
    ready = ctx.Event()
    p = ctx.Process(target=_hold, args=(path, ready, 1.5))
    p.start()
    try:
        assert ready.wait(20)
        with pytest.raises(E.LockTimeout):
            with E.inference_lock(path, timeout_s=0.3):
                pass
        with E.inference_lock(path, timeout_s=20) as waited:   # queues until the holder exits
            assert waited > 0.2
    finally:
        p.join(10)
        if p.is_alive():
            p.kill()


def test_lock_is_released_after_exception(tmp_path):
    path = str(tmp_path / "vlm.lock")
    with pytest.raises(RuntimeError):
        with E.inference_lock(path):
            raise RuntimeError("boom")
    with E.inference_lock(path, timeout_s=0.5) as waited:
        assert waited < 0.5


def test_recorder_running_matches_own_cmdline_only_if_present():
    assert E.recorder_running("this-pattern-is-not-running-xyz-123") is False


def test_local_vlm_does_not_import_mlx_until_load():
    m = E.LocalVLM(load=False)
    assert m.model is None and m.model_id == E.DEFAULT_LOCAL_MODEL


def test_claude_requires_key_and_consent(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        E.ClaudeVLM(consent_team_clips_only=True)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    with pytest.raises(RuntimeError, match="consent"):
        E.ClaudeVLM()


def test_claude_warns_and_uses_shared_interface(monkeypatch, capsys, tmp_path):
    pytest.importorskip("anthropic")
    from PIL import Image
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    eng = E.ClaudeVLM(consent_team_clips_only=True, lock_path=str(tmp_path / "vlm.lock"))
    assert "leaves the laptop" in capsys.readouterr().err

    class _Blk:
        type, text = "text", '{"label": "YES"}'

    class _Usage:
        input_tokens, output_tokens = 10, 5

    class _Resp:
        content, usage, stop_reason = [_Blk()], _Usage(), "end_turn"

    sent = {}

    class _Msgs:
        def create(self, **kw):
            sent.update(kw)
            return _Resp()

    class _Client:
        messages = _Msgs()

    eng._client = _Client()
    r = eng.generate([Image.new("RGB", (8, 8))], "prompt")
    assert r.text == '{"label": "YES"}' and r.engine == "claude-api" and r.n_images == 1
    blocks = sent["messages"][0]["content"]
    assert blocks[0]["type"] == "image" and blocks[-1] == {"type": "text", "text": "prompt"}
    assert "leaves the laptop" in capsys.readouterr().err

"""Red-team regression tests: model and landmarker integrity (A1, A2, A10, C4, C5).

Each test replays the demonstrated attack and checks it is now refused.
"""
import hashlib
import inspect
import logging
import os
import pickle
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient

from recognition import mediapipe_adapter as mpa
from recognition import model, model_pin, recognizer
from recognition.labels import CLASSES
from recognition.model import SignGRU, load_checkpoint, save_checkpoint
from recognition.recognizer import ModelPinError, Recognizer, load_predictor, sha256_bytes
from recognition.server import create_app
from recognition.tests.helpers import raw_frames

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def strict(monkeypatch):
    """No development opt-in and no pin (a fresh checkout before pin_model, or a cleared pin)."""
    monkeypatch.delenv("RECOGNITION_ALLOW_UNPINNED", raising=False)
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", None)


@pytest.fixture(scope="module")
def real_and_tampered(tmp_path_factory):
    """A genuine checkpoint and two structurally valid tampered copies (A1: temperature 99; C4: head bias)."""
    d = tmp_path_factory.mktemp("integrity")
    real = d / "model.pt"
    save_checkpoint(real, SignGRU().eval(), temperature=1.0)
    ck = torch.load(real, map_location="cpu", weights_only=True)
    hot = d / "tampered_temperature.pt"
    torch.save(dict(ck, temperature=99.0), hot)
    biased = d / "tampered_bias.pt"
    sd = {k: v.clone() for k, v in ck["state_dict"].items()}
    bias_key = [k for k in sd if k.endswith("bias") and sd[k].shape == (len(CLASSES),)][-1]
    sd[bias_key][:] = -50.0
    sd[bias_key][CLASSES.index("TAXI")] = 50.0
    torch.save(dict(ck, state_dict=sd), biased)
    return real, hot, biased


def client_for(path, **kw):
    return TestClient(create_app(model_path=path, mock=False, token=None, **kw), base_url="http://localhost",
                      client=("127.0.0.1", 50000))


def test_a1_unpinned_model_is_refused_by_default(strict, real_and_tampered, caplog):
    _, hot, biased = real_and_tampered
    for bad in (hot, biased):
        with caplog.at_level(logging.ERROR, "recognition"), pytest.raises(ModelPinError):
            load_predictor(bad)
        assert "model not pinned: refusing" in caplog.text
        with pytest.raises(ModelPinError):
            Recognizer(bad)
        c = client_for(bad)
        assert c.get("/health").json()["model_loaded"] is False
        r = c.post("/predict", json={"frames": raw_frames(30, np.random.default_rng(0))})
        assert r.status_code == 503


def test_c4_biased_head_would_force_taxi_but_is_refused_when_pinned(real_and_tampered, monkeypatch):
    real, _, biased = real_and_tampered
    # The attack works on an unpinned development setup (this is what the red team demonstrated)...
    top = Recognizer(biased, allow_unpinned=True).predict(raw_frames(30, np.random.default_rng(1)))
    assert top[0]["label"] == "TAXI" and top[0]["conf"] > 0.99
    # ...and a set pin refuses it, even with the development opt-in present.
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", sha256_bytes(real.read_bytes()))
    monkeypatch.setenv("RECOGNITION_ALLOW_UNPINNED", "1")
    with pytest.raises(ModelPinError):
        load_predictor(biased)
    with pytest.raises(ModelPinError):
        load_predictor(biased, allow_unpinned=True)
    load_predictor(real)   # the genuine file still loads


def test_a1_dev_optin_is_explicit(strict, real_and_tampered, caplog, monkeypatch):
    real, _, _ = real_and_tampered
    for value in ("", "0", "no", "false"):
        monkeypatch.setenv("RECOGNITION_ALLOW_UNPINNED", value)
        with pytest.raises(ModelPinError):
            load_predictor(real)
    monkeypatch.delenv("RECOGNITION_ALLOW_UNPINNED")
    with caplog.at_level(logging.WARNING, "recognition"):
        assert load_predictor(real, allow_unpinned=True) is not None
    assert "development only" in caplog.text


def test_a2_pickle_payload_never_runs(strict, tmp_path):
    marker = tmp_path / "PWNED"

    class Evil:
        def __reduce__(self):
            return (os.system, (f"touch {marker}",))

    mal = tmp_path / "malicious_model.pt"
    torch.save({"kind": "gru", "x": Evil()}, mal)
    with pytest.raises(pickle.UnpicklingError):
        load_checkpoint(mal)
    with pytest.raises(pickle.UnpicklingError):
        load_predictor(mal, allow_unpinned=True)
    assert not marker.exists()
    # Do not regress: the loader must keep weights_only=True.
    assert "weights_only=True" in inspect.getsource(model.load_checkpoint)


def test_a10_importing_the_server_loads_no_model(tmp_path):
    env = dict(os.environ, RECOGNITION_MODEL=str(tmp_path / "sentinel_missing.pt"), PYTHONDONTWRITEBYTECODE="1")
    code = ("import logging, sys; logging.basicConfig(level=logging.INFO, stream=sys.stderr); "
            "import recognition.server as s; print('lazy' if s.app._app is None else 'eager')")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == "lazy"
    assert "sentinel_missing" not in out.stderr and "model loaded" not in out.stderr


def test_a10_lazy_app_still_serves(monkeypatch, tmp_path):
    from recognition import server
    lazy = server._LazyApp(lambda: create_app(model_path=tmp_path / "x.pt", mock=True, token=None))
    c = TestClient(lazy, base_url="http://localhost", client=("127.0.0.1", 50000))
    assert c.get("/health").json()["mock"] is True


def test_c5_task_file_is_hash_pinned(tmp_path):
    fake = tmp_path / "holistic_landmarker.task"
    fake.write_bytes(b"not the pinned landmarker")
    with pytest.raises(mpa.TaskPinError):
        mpa.read_pinned_task(fake)
    if mpa.DEFAULT_TASK.is_file():
        data = mpa.DEFAULT_TASK.read_bytes()
        assert hashlib.sha256(data).hexdigest() == mpa.EXPECTED_TASK_SHA256
        assert mpa.read_pinned_task(mpa.DEFAULT_TASK) == data
        flipped = bytearray(data)
        flipped[len(flipped) // 2] ^= 1
        bad = tmp_path / "flipped.task"
        bad.write_bytes(bytes(flipped))
        with pytest.raises(mpa.TaskPinError):
            mpa.read_pinned_task(bad)


def test_c5_load_holistic_refuses_a_swapped_task(tmp_path):
    pytest.importorskip("mediapipe")
    fake = tmp_path / "holistic_landmarker.task"
    fake.write_bytes(b"\x00" * 1024)
    with pytest.raises(mpa.TaskPinError):
        mpa.load_holistic(fake)

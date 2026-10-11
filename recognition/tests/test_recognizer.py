import logging
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from recognition import model_pin, pin_model, recognizer
from recognition.model import SignGRU, save_checkpoint
from recognition.recognizer import ModelPinError, Recognizer, sha256_bytes
from recognition.server import create_app
from recognition.tests.helpers import raw_frames

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    path = tmp_path_factory.mktemp("r") / "model.pt"
    save_checkpoint(path, SignGRU().eval(), temperature=1.0)
    return path


def server_top(ckpt, frames, mock=False):
    c = TestClient(create_app(model_path=ckpt, mock=mock, token=None), base_url="http://localhost",
                   client=("127.0.0.1", 50000))
    r = c.post("/predict", json={"frames": frames})
    return r.status_code, r.json()


def test_recognizer_matches_server(ckpt):
    rec = Recognizer(ckpt)
    rng = np.random.default_rng(0)
    cases = [raw_frames(40, rng), raw_frames(1, rng), raw_frames(30, rng, lh=False, rh=False)]
    nopose = raw_frames(20, rng)
    for f in nopose:
        f["pose"] = None
    for frames in cases + [nopose]:
        code, body = server_top(ckpt, frames)
        assert code == 200 and body["top"] == rec.predict(frames)
    assert rec.predict(cases[2])[0]["label"] == "NONE" and rec.predict(nopose)[0]["label"] == "NONE"


def test_recognizer_mock_matches_server(tmp_path):
    frames = raw_frames(10, np.random.default_rng(1))
    code, body = server_top(tmp_path / "missing.pt", frames, mock=True)
    assert code == 200 and body["top"] == Recognizer(mock=True).predict(frames)


def test_benchmark_latency_uses_a_loopback_client(ckpt):
    from recognition.benchmark import latency

    frames = raw_frames(12, np.random.default_rng(4))
    report = latency(ckpt, frames, n=4)
    assert report["segment_frames"] == len(frames)
    for kind in ("model_forward", "http_predict_testclient"):
        assert 0 <= report[kind]["p50_ms"] <= report[kind]["p95_ms"]


@pytest.mark.parametrize("bad", [
    [],
    [{"pose": [[0, 0, 0]] * 32, "lh": None, "rh": None, "face": None}],
    [{"pose": None, "lh": None, "rh": [[True, False, True]] * 21, "face": None}],
    [{"pose": None, "lh": None, "rh": [[1e9, 0, 0]] * 21, "face": None}],
    [{"pose": None, "lh": None, "rh": [[float("nan"), 0, 0]] * 21, "face": None}],
    [{"pose": None, "lh": None, "rh": None, "face": None, "leftHand": None}],
    [{"pose": None, "lh": None, "rh": None, "face": None}] * 301,
])
def test_recognizer_rejects_what_the_server_rejects(ckpt, bad):
    with pytest.raises(ValueError):
        Recognizer(ckpt).predict(bad)


def test_recognizer_accepts_numpy_parts(ckpt):
    frames = raw_frames(12, np.random.default_rng(2))
    arr = [{p: (None if v is None else np.asarray(v, np.float32)) for p, v in f.items()} for f in frames]
    top = Recognizer(ckpt).predict(arr)
    assert len(top) == 3 and all(0 <= p["conf"] <= 1 for p in top)


def test_unpinned_model_warns(ckpt, caplog):
    with caplog.at_level(logging.WARNING, "recognition"):
        Recognizer(ckpt)
    assert "model not pinned" in caplog.text


def test_pinned_model_loads(ckpt, monkeypatch):
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", sha256_bytes(ckpt.read_bytes()))
    assert server_top(ckpt, raw_frames(8, np.random.default_rng(3)))[0] == 200
    Recognizer(ckpt)


def test_one_changed_byte_is_503(ckpt, tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", sha256_bytes(ckpt.read_bytes()))
    data = bytearray(ckpt.read_bytes())
    data[len(data) // 2] ^= 1
    bad = tmp_path / "model.pt"
    bad.write_bytes(bytes(data))
    with caplog.at_level(logging.ERROR, "recognition"):
        code, body = server_top(bad, raw_frames(8, np.random.default_rng(4)))
    assert code == 503 and "hash mismatch" in caplog.text
    with pytest.raises(ModelPinError):
        Recognizer(bad)


def test_pin_has_no_env_override(ckpt, monkeypatch):
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", "0" * 64)
    for k in ("RECOGNITION_MODEL_SHA256", "RECOGNITION_PIN", "EXPECTED_SHA256"):
        monkeypatch.setenv(k, sha256_bytes(ckpt.read_bytes()))
    with pytest.raises(ModelPinError):
        recognizer.load_predictor(ckpt)


def test_pin_model_rewrites_only_the_constant(ckpt, tmp_path):
    pin = tmp_path / "model_pin.py"
    pin.write_text(Path(model_pin.__file__).read_text())
    digest = pin_model.file_sha256(ckpt)
    pin_model.write_pin(digest, pin)
    ns = {}
    exec(pin.read_text(), ns)
    assert ns["EXPECTED_SHA256"] == digest == sha256_bytes(ckpt.read_bytes())
    pin_model.write_pin(None, pin)
    ns = {}
    exec(pin.read_text(), ns)
    assert ns["EXPECTED_SHA256"] is None
    committed = {}
    exec(Path(model_pin.__file__).read_text(), committed)
    pin_model.write_pin(committed["EXPECTED_SHA256"], pin)
    assert pin.read_text() == Path(model_pin.__file__).read_text()
    with pytest.raises(ValueError):
        pin_model.write_pin("not-a-hash", pin)


def committed_pin():
    """EXPECTED_SHA256 as committed in model_pin.py (conftest sets the live value aside for the tests)."""
    ns = {}
    exec(Path(model_pin.__file__).read_text(), ns)
    return ns["EXPECTED_SHA256"]


def test_committed_pin_is_none_or_a_digest():
    assert committed_pin() is None or len(committed_pin()) == 64


def test_committed_model_matches_the_committed_pin():
    model_pt = ROOT / "recognition" / "models" / "model.pt"
    if committed_pin() is None or not model_pt.is_file():
        pytest.skip("no committed pin or no committed model.pt")
    assert sha256_bytes(model_pt.read_bytes()) == committed_pin()


def test_server_import_does_not_import_mediapipe():
    code = ("import sys, recognition.server, recognition.recognizer, recognition.segmenter, "
            "recognition.mediapipe_adapter; "
            "print(sorted(m for m in sys.modules if m.split('.')[0] in ('mediapipe', 'cv2')))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip() == "[]"

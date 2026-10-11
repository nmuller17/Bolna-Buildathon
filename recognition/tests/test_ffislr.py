"""The face-free GISLR 1st-place model (kind "ffislr"): face removal, checkpoints, serving, fallback."""
from pathlib import Path

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient

from recognition import ffislr, features, model_pin
from recognition.labels import CLASSES
from recognition.model import Predictor, SignGRU, load_checkpoint, save_checkpoint
from recognition.recognizer import ModelPinError, Recognizer, load_predictor, sha256_bytes
from recognition.server import create_app
from recognition.tests.helpers import raw_frames

ROOT = Path(__file__).resolve().parents[2]


def tiny_model(seed=0, face_weights=False):
    """A random ffislr network. face_weights=True puts non-zero weights on the lip/eye stem columns
    (a model that WOULD read the face if the input carried it)."""
    torch.manual_seed(seed)
    m = ffislr.new_model(len(CLASSES))
    if not face_weights:
        ffislr.zero_face_columns(m)
    else:
        with torch.no_grad():
            m.stem.weight[:, torch.from_numpy(ffislr.FACE_COLS)] = torch.randn(m.stem.weight.shape[0], len(ffislr.FACE_COLS))
    return m.eval()


@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    path = tmp_path_factory.mktemp("ff") / "model.pt"
    save_checkpoint(path, tiny_model(), temperature=1.0)
    return path


def with_face(frames, face):
    """Same frames, with the face part replaced (face(t) -> 26x3 list or None) and random pose 1-10."""
    rng = np.random.default_rng(7)
    out = []
    for t, f in enumerate(frames):
        g = dict(f)
        g["face"] = face(t)
        if g.get("pose") is not None:
            pose = np.asarray(g["pose"], np.float64)
            pose[1:11] = pose[0] + rng.normal(0, 0.05, (10, 3))  # eyes, ears, mouth: identity-bearing
            g["pose"] = pose.tolist()
        out.append(g)
    return out


def face_variants(frames):
    rng = np.random.default_rng(3)
    return {
        "random": with_face(frames, lambda t: rng.normal(0.5, 0.2, (26, 3)).tolist()),
        "zero": with_face(frames, lambda t: np.zeros((26, 3)).tolist()),
        "none": with_face(frames, lambda t: None),
    }


def segments():
    rng = np.random.default_rng(0)
    yield raw_frames(40, rng)
    yield raw_frames(25, rng, rh=False)
    gappy = raw_frames(30, rng)
    for t in range(5, 10):  # frames without a pose or a hand (MediaPipe dropouts)
        gappy[t] = {**gappy[t], "pose": None, "lh": None}
    yield gappy


@pytest.mark.parametrize("face_weights", [False, True])
def test_random_face_and_zero_face_give_identical_outputs(face_weights):
    """The face is removed before the input is prepared: identical logits, bit for bit, even for a network
    whose stem has non-zero lip/eye weights (so the guarantee does not rest on the weights)."""
    m = tiny_model(1, face_weights)
    for frames in segments():
        outs = {}
        for name, fr in face_variants(frames).items():
            X, M = ffislr.pad_batch([ffislr.prepare(fr)])
            with torch.inference_mode():
                outs[name] = m(X, M).numpy()
        assert np.array_equal(outs["random"], outs["zero"]) and np.array_equal(outs["zero"], outs["none"])


def test_preprocess_blanks_face_rows_itself():
    """Even a caller that passes a full 543-row array with a face mesh and random pose 1-10 gets the
    face-free input: the face rows and pose 1-10 never change preprocess()."""
    rng = np.random.default_rng(0)
    seq, _ = features.normalize(raw_frames(30, rng))
    raw = ffislr.seq_to_raw(ffislr.minimise(seq))
    noisy = raw.copy()
    noisy[:, :ffislr.FACE_ROWS] = rng.uniform(0, 1, (len(raw), ffislr.FACE_ROWS, 3))
    noisy[:, ffislr.POSE0 + 1:ffislr.POSE0 + 11] = rng.uniform(0, 1, (len(raw), 10, 3))
    zero = raw.copy()
    zero[:, :ffislr.FACE_ROWS] = 0.0
    a, b, c = ffislr.preprocess(raw), ffislr.preprocess(noisy), ffislr.preprocess(zero)
    assert np.array_equal(a, b) and np.array_equal(a, c)
    cols = ffislr.FACE_COLS
    assert not a[:, cols].any(), "lip/eye input columns must be 0"


def test_predictor_and_recognizer_are_face_blind(ckpt):
    pred = Predictor(ckpt)
    rec = Recognizer(ckpt, allow_unpinned=True)
    for frames in segments():
        v = face_variants(frames)
        p = {k: pred.probs(fr) for k, fr in v.items()}
        assert np.array_equal(p["random"], p["zero"]) and np.array_equal(p["zero"], p["none"])
        assert rec.predict(v["random"]) == rec.predict(v["zero"]) == rec.predict(v["none"])


def test_checkpoint_roundtrip_is_weights_only_and_exact(ckpt):
    raw = torch.load(ckpt, map_location="cpu", weights_only=True)
    assert raw["kind"] == "ffislr" and raw["feature_version"] == ffislr.INPUT_VERSION and raw["T"] is None
    m, ck = load_checkpoint(ckpt)
    ref = tiny_model()
    frames = next(segments())
    X, M = ffislr.pad_batch([ffislr.prepare(frames)])
    with torch.inference_mode():
        assert torch.equal(m(X, M), ref(X, M))
    lb = Predictor(ckpt).logits_batch([frames, frames])
    assert lb.shape == (2, len(CLASSES)) and np.allclose(lb[0], lb[1])


def test_loader_refuses_a_model_that_reads_face_columns(tmp_path):
    bad = tmp_path / "face.pt"
    m = tiny_model(face_weights=True)
    torch.save({"kind": "ffislr", "state_dict": m.state_dict(), "classes": list(CLASSES),
                "feature_version": ffislr.INPUT_VERSION, "feature_dim": ffislr.IN_DIM, "T": None,
                "temperature": 1.0, "meta": {}}, bad)
    with pytest.raises(ValueError, match="lip/eye"):
        load_checkpoint(bad)
    with pytest.raises(ValueError, match="lip/eye"):
        save_checkpoint(tmp_path / "x.pt", m)


def test_loader_refuses_a_wrong_input_version(ckpt, tmp_path):
    ck = torch.load(ckpt, map_location="cpu", weights_only=True)
    ck["feature_version"] = "ffislr-v0"
    p = tmp_path / "v0.pt"
    torch.save(ck, p)
    with pytest.raises(ValueError, match="ffislr checkpoint input"):
        load_checkpoint(p)


def test_server_serves_an_ffislr_checkpoint(ckpt):
    c = TestClient(create_app(model_path=ckpt, mock=False, token=None, allow_unpinned=True),
                   base_url="http://localhost", client=("127.0.0.1", 50000))
    assert c.get("/health").json()["model_loaded"] is True
    frames = next(segments())
    r = c.post("/predict", json={"frames": frames})
    assert r.status_code == 200
    top = r.json()["top"]
    assert len(top) == 3 and all(p["label"] in CLASSES and 0 <= p["conf"] <= 1 for p in top)
    r0 = c.post("/predict", json={"frames": face_variants(frames)["zero"]}).json()
    r1 = c.post("/predict", json={"frames": face_variants(frames)["random"]}).json()
    assert r0 == r1


def test_pinned_ffislr_checkpoint_loads_and_a_tampered_one_is_refused(ckpt, tmp_path, monkeypatch):
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", sha256_bytes(ckpt.read_bytes()))
    monkeypatch.delenv("RECOGNITION_ALLOW_UNPINNED", raising=False)
    assert load_predictor(ckpt).kind == "ffislr"
    bad = tmp_path / "model.pt"
    data = bytearray(ckpt.read_bytes())
    data[-100] ^= 1
    bad.write_bytes(bytes(data))
    with pytest.raises(ModelPinError):
        load_predictor(bad)


def test_gru_checkpoints_still_load_and_predict(tmp_path):
    """The previous kinds stay loadable (the shipped baseline is the documented fallback)."""
    p = tmp_path / "gru.pt"
    save_checkpoint(p, SignGRU().eval())
    pred = Predictor(p)
    frames = next(segments())
    x = torch.from_numpy(features.prepare(frames, pred.T))[None]
    with torch.inference_mode():
        ref = pred.model(x).numpy()[0]
    assert pred.kind == "gru" and np.allclose(pred.logits_batch([frames])[0], ref)


def _committed_pin():
    ns = {}
    exec(Path(model_pin.__file__).read_text(), ns)
    return ns["EXPECTED_SHA256"]


def test_committed_demo_model_is_face_blind():
    demo = ROOT / "recognition" / "models" / "model.pt"
    if not demo.is_file():
        pytest.skip("no model.pt")
    m, ck = load_checkpoint(demo)  # raises if the stem reads lip/eye columns
    if ck["kind"] != "ffislr":
        pytest.skip(f"demo model is kind {ck['kind']}")
    ffislr.assert_face_blind(m)
    assert ck["T"] is None and 1.0 <= ck["temperature"] <= 10.0
    assert ck["meta"].get("training_only_signers") == ["talha"]
    assert "hoyso48" in ck["meta"].get("attribution", "")


def test_baseline_fallback_loads_when_pinned(monkeypatch):
    fb = ROOT / "recognition" / "models" / "model_baseline_team5.pt"
    if not fb.is_file():
        pytest.skip("no baseline fallback file")
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", sha256_bytes(fb.read_bytes()))
    monkeypatch.delenv("RECOGNITION_ALLOW_UNPINNED", raising=False)
    pred = load_predictor(fb)
    assert pred.kind == "baseline"
    if _committed_pin() is not None and sha256_bytes(fb.read_bytes()) != _committed_pin():
        monkeypatch.setattr(model_pin, "EXPECTED_SHA256", _committed_pin())
        with pytest.raises(ModelPinError):
            load_predictor(fb)  # the fallback needs a deliberate re-pin

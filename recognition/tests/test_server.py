import asyncio
import json
import os
import pickle

import numpy as np
import pytest
from fastapi.testclient import TestClient

from recognition.labels import CLASSES
from recognition.model import SignGRU, load_checkpoint, save_checkpoint
from recognition.server import MAX_BODY_BYTES, MAX_FRAMES, Guard, create_app
from recognition.tests.helpers import raw_frames

LOCAL = "http://localhost"
LOOPBACK = ("127.0.0.1", 50000)


def make_client(peer=LOOPBACK, **kw):
    return TestClient(create_app(**kw), base_url=LOCAL, client=peer)


@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    path = tmp_path_factory.mktemp("m") / "model.pt"
    save_checkpoint(path, SignGRU().eval(), temperature=1.0)
    return path


@pytest.fixture(scope="module")
def client(ckpt):
    return make_client(model_path=ckpt, mock=False, token=None)


def check_contract(body):
    assert set(body) == {"top"}
    top = body["top"]
    assert len(top) == 3
    for p in top:
        assert set(p) == {"label", "conf"} and p["label"] in CLASSES and 0 <= p["conf"] <= 1
    confs = [p["conf"] for p in top]
    assert confs == sorted(confs, reverse=True)
    assert len({p["label"] for p in top}) == 3


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "model_loaded": True, "classes": CLASSES, "mock": False}


def test_predict_contract(client):
    r = client.post("/predict", json={"frames": raw_frames(40, np.random.default_rng(0))})
    assert r.status_code == 200
    check_contract(r.json())


def test_single_frame_segment(client):
    r = client.post("/predict", json={"frames": raw_frames(1, np.random.default_rng(1))})
    assert r.status_code == 200
    check_contract(r.json())


def test_no_hands_returns_none(client):
    r = client.post("/predict", json={"frames": raw_frames(30, np.random.default_rng(2), lh=False, rh=False)})
    assert r.status_code == 200
    body = r.json()
    check_contract(body)
    assert body["top"][0]["label"] == "NONE" and body["top"][0]["conf"] >= 0.9


@pytest.mark.parametrize("bad", [
    {},
    {"frames": []},
    {"frames": [{"pose": [[0, 0, 0]] * 32, "lh": None, "rh": None, "face": None}]},
    {"frames": [{"pose": None, "lh": [[0, 0]] * 21, "rh": None, "face": None}]},
    {"frames": [{"pose": None, "lh": None, "rh": [[0, 0, "a"]] * 21, "face": None}]},
    {"frames": [{"pose": None, "lh": None, "rh": None, "face": [[0, 0, 0]] * 27}]},
    {"frames": "nope"},
    {"frames": [{"pose": None, "lh": None, "rh": None, "face": None, "leftHand": None}]},   # unknown key
    {"frames": [{"pose": None, "lh": None, "rh": None, "face": None}], "extra": 1},
    {"frames": [{"pose": None, "lh": None, "rh": [["0.1", "0.2", "0.3"]] * 21, "face": None}]},  # strings
    {"frames": [{"pose": None, "lh": None, "rh": [[True, False, True]] * 21, "face": None}]},
    {"frames": [{"pose": None, "lh": None, "rh": [[1e9, 0, 0]] * 21, "face": None}]},     # out of range
])
def test_malformed_is_422(client, bad):
    r = client.post("/predict", json=bad)
    assert r.status_code == 422
    assert all(set(e) == {"loc", "msg"} for e in r.json()["detail"])  # landmarks are not echoed back


def test_non_finite_is_422(client):
    frames = raw_frames(2, np.random.default_rng(3))
    text = json.dumps({"frames": frames})
    text = text.replace(str(frames[0]["rh"][0][0]), "NaN", 1)
    assert "NaN" in text
    r = client.post("/predict", content=text, headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_too_many_frames_is_422(client):
    frame = {"pose": None, "lh": None, "rh": None, "face": None}
    r = client.post("/predict", json={"frames": [frame] * (MAX_FRAMES + 1)})
    assert r.status_code == 422


def test_oversized_body_is_413(client):
    r = client.post("/predict", content=b"x" * (MAX_BODY_BYTES + 1), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_oversized_streamed_body_is_413(client):
    def chunks():
        for _ in range(5):
            yield b"x" * (MAX_BODY_BYTES // 4)
    r = client.post("/predict", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_integer_coordinates_are_accepted(client):
    frames = raw_frames(3, np.random.default_rng(7))
    frames[0]["rh"][0] = [0, 1, 0]
    assert client.post("/predict", json={"frames": frames}).status_code == 200


def test_no_pose_returns_none(client):
    # Hands but no shoulders: coordinates cannot be normalized, so the model must not answer.
    frames = raw_frames(40, np.random.default_rng(8))
    for f in frames:
        f["pose"] = None
    body = client.post("/predict", json={"frames": frames}).json()
    check_contract(body)
    assert body["top"][0]["label"] == "NONE"
    frames[0]["pose"] = raw_frames(1, np.random.default_rng(0))[0]["pose"]  # 1 of 40 frames is not enough
    assert client.post("/predict", json={"frames": frames}).json()["top"][0]["label"] == "NONE"


def test_unknown_host_is_400(client):
    assert client.get("/health", headers={"Host": "evil.com"}).status_code == 400


def test_token_checked_before_body(ckpt):
    c = make_client(model_path=ckpt, mock=False, token="s3cret")
    assert c.post("/predict", json={"frames": []}).status_code == 401


def test_non_ascii_token_is_401_not_500(ckpt):
    c = make_client(model_path=ckpt, mock=False, token="s3cret")
    body = {"frames": raw_frames(5, np.random.default_rng(6))}
    assert c.post("/predict", json=body, headers={"X-Recognition-Token": b"caf\xe9"}).status_code == 401


def test_inflight_limit_is_429():
    calls = []

    async def app(scope, receive, send):
        calls.append(scope["path"])

    async def run():
        sent = []

        async def send(msg):
            sent.append(msg)
        g = Guard(app, max_inflight=0)
        await g({"type": "http", "path": "/predict", "method": "POST", "headers": []}, None, send)
        await g({"type": "http", "path": "/health", "method": "GET", "headers": []}, None, send)
        return sent
    sent = asyncio.run(run())
    assert sent[0]["status"] == 429 and calls == ["/health"]


def test_checkpoint_is_not_unpickled_as_code(tmp_path):
    marker = tmp_path / "pwned"

    class Evil:
        def __reduce__(self):
            return (os.system, (f"touch {marker}",))
    path = tmp_path / "evil.pt"
    with open(path, "wb") as f:
        pickle.dump(Evil(), f)
    with pytest.raises(Exception):
        load_checkpoint(path)
    assert not marker.exists()
    c = make_client(model_path=path, mock=False, token=None)
    r = c.post("/predict", json={"frames": raw_frames(3, np.random.default_rng(0))})
    assert r.status_code == 503 and str(tmp_path) not in r.text and not marker.exists()


def test_mock_mode_is_deterministic_and_needs_no_model(tmp_path):
    c = make_client(model_path=tmp_path / "missing.pt", mock=True, token=None)
    assert c.get("/health").json()["mock"] is True
    body = {"frames": raw_frames(7, np.random.default_rng(4))}
    a, b = c.post("/predict", json=body), c.post("/predict", json=body)
    assert a.status_code == 200 and a.json() == b.json()
    check_contract(a.json())
    low = c.post("/predict", json={"frames": raw_frames(10, np.random.default_rng(4))}).json()
    assert low["top"][0]["conf"] < 0.6  # every 5th frame count exercises P4's repeat path


def test_missing_model_without_mock_is_503(tmp_path):
    c = make_client(model_path=tmp_path / "missing.pt", mock=False, token=None)
    assert c.get("/health").json()["model_loaded"] is False
    r = c.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(5))})
    assert r.status_code == 503 and "RECOGNITION_MOCK" in r.json()["detail"] and str(tmp_path) not in r.text


def test_token_required_when_set(ckpt):
    c = make_client(model_path=ckpt, mock=False, token="s3cret")
    body = {"frames": raw_frames(5, np.random.default_rng(6))}
    assert c.post("/predict", json=body).status_code == 401
    assert c.post("/predict", json=body, headers={"X-Recognition-Token": "wrong"}).status_code == 401
    assert c.post("/predict", json=body, headers={"X-Recognition-Token": "s3cret"}).status_code == 200


def test_cors_allowlist(client):
    pre = {"Access-Control-Request-Method": "POST"}
    for origin in ("http://localhost:3000", "http://127.0.0.1:3000"):
        ok = client.options("/predict", headers={"Origin": origin, **pre})
        assert ok.headers.get("access-control-allow-origin") == origin
    bad = client.options("/predict", headers={"Origin": "http://evil.example", **pre})
    assert "access-control-allow-origin" not in bad.headers


def test_lan_client_without_token_is_403(ckpt):
    c = make_client(peer=("192.168.1.5", 50000), model_path=ckpt, mock=False, token=None)
    assert c.get("/health").status_code == 403
    r = c.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(9))})
    assert r.status_code == 403 and "frames" not in r.text


@pytest.mark.parametrize("peer", [("::1", 50000), ("127.0.0.1", 1), ("::ffff:127.0.0.1", 50000)])
def test_loopback_clients_are_accepted(ckpt, peer):
    assert make_client(peer=peer, model_path=ckpt, mock=False, token=None).get("/health").status_code == 200


@pytest.mark.parametrize("peer", [("testclient", 50000), ("10.0.0.2", 50000), ("::ffff:192.168.1.5", 50000)])
def test_non_loopback_peers_are_403(ckpt, peer):
    assert make_client(peer=peer, model_path=ckpt, mock=False, token=None).get("/health").status_code == 403


def test_empty_token_keeps_the_loopback_guard(ckpt, monkeypatch):
    monkeypatch.delenv("RECOGNITION_TOKEN", raising=False)
    c = make_client(peer=("192.168.1.5", 50000), model_path=ckpt, mock=False, token="")
    assert c.get("/health").status_code == 403
    assert c.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(9))}).status_code == 403
    local = make_client(model_path=ckpt, mock=False, token="")
    assert local.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(9))}).status_code == 200


def test_lan_client_with_token_uses_token_rules(ckpt):
    c = make_client(peer=("192.168.1.5", 50000), model_path=ckpt, mock=False, token="s3cret")
    body = {"frames": raw_frames(5, np.random.default_rng(6))}
    assert c.post("/predict", json=body).status_code == 401
    assert c.post("/predict", json=body, headers={"X-Recognition-Token": "s3cret"}).status_code == 200

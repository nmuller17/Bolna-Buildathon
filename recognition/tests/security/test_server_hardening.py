"""Red-team regression tests: recognizer HTTP surface (A3, A5, A6, A7, D11)."""
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from recognition import server
from recognition.labels import CLASSES
from recognition.model import SignGRU, save_checkpoint
from recognition.server import MAX_BODY_BYTES, create_app
from recognition.tests.helpers import raw_frames

TOKEN = "verify-tok-123"
LAN_PEER = ("10.0.149.212", 50123)


@pytest.fixture(scope="module")
def ckpt(tmp_path_factory):
    path = tmp_path_factory.mktemp("s") / "model.pt"
    save_checkpoint(path, SignGRU().eval(), temperature=1.0)
    return path


def lan_token_client(ckpt, peer=LAN_PEER):
    app = create_app(model_path=ckpt, mock=False, token=TOKEN, allowed_hosts=["localhost", "10.0.149.212"],
                     allowed_origins=["http://10.0.149.212:3000"], allow_unpinned=True)
    return TestClient(app, base_url="http://10.0.149.212:8121", client=peer)


def test_a3_health_tells_a_lan_caller_nothing_without_the_token(ckpt):
    c = lan_token_client(ckpt)
    r = c.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    assert "YES" not in r.text and "mock" not in r.text
    assert c.get("/health", headers={"X-Recognition-Token": "wrong"}).json() == {"status": "ok"}
    full = c.get("/health", headers={"X-Recognition-Token": TOKEN}).json()
    assert full["classes"] == CLASSES and full["model_loaded"] is True and full["mock"] is False


def test_a3_health_is_full_on_the_laptop(ckpt):
    c = lan_token_client(ckpt, peer=("127.0.0.1", 50000))
    assert c.get("/health", headers={"Host": "localhost"}).json()["classes"] == CLASSES


def test_a6_forged_forwarding_headers_do_not_grant_loopback(ckpt):
    app = create_app(model_path=ckpt, mock=False, token=None, allow_unpinned=True)
    spoof = {"Host": "localhost", "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", "Forwarded": "for=127.0.0.1"}
    for peer in (LAN_PEER, ("::ffff:10.0.0.5", 1), ("", 0)):
        c = TestClient(app, base_url="http://localhost", client=peer)
        assert c.get("/health", headers=spoof).status_code == 403
        r = c.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(0))}, headers=spoof)
        assert r.status_code == 403
    ok = TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000))
    assert ok.get("/health").status_code == 200


def test_a6_rebinding_host_and_hostile_origin(ckpt):
    c = lan_token_client(ckpt)
    for host in ("evil.example", "attacker.com", "rebind.attacker.test:8121"):
        assert c.get("/health", headers={"Host": host}).status_code == 400
    pre = c.options("/predict", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in pre.headers
    r = c.post("/predict", json={"frames": raw_frames(5, np.random.default_rng(0))},
               headers={"Origin": "http://evil.example", "X-Recognition-Token": TOKEN})
    assert r.headers.get("access-control-allow-origin") is None


def test_a6_chunked_oversized_body_is_413(ckpt):
    c = lan_token_client(ckpt)

    def chunks():
        for _ in range(6):
            yield b" " * (1024 * 1024)
    r = c.post("/predict", content=chunks(), headers={"content-type": "application/json", "X-Recognition-Token": TOKEN})
    assert r.status_code == 413
    assert 6 * 1024 * 1024 > MAX_BODY_BYTES


def test_a7_rejected_landmarks_are_not_echoed(ckpt):
    c = lan_token_client(ckpt)
    frames = raw_frames(3, np.random.default_rng(2))
    frames[0]["rh"][0] = [424242.0, 0, 0]
    r = c.post("/predict", json={"frames": frames}, headers={"X-Recognition-Token": TOKEN})
    assert r.status_code == 422 and "424242" not in r.text
    text = json.dumps({"frames": raw_frames(2, np.random.default_rng(3))}).replace("0.", "NaN", 1)
    r = c.post("/predict", content=text, headers={"content-type": "application/json", "X-Recognition-Token": TOKEN})
    assert r.status_code == 422


def test_d11_face_points_are_dropped_before_the_model(ckpt, monkeypatch):
    seen = []
    real = server.decide

    def spy(frames, predictor, mock=False):
        seen.extend(frames)
        return real(frames, predictor, mock)
    monkeypatch.setattr(server, "decide", spy)
    c = lan_token_client(ckpt)
    frames = raw_frames(12, np.random.default_rng(4))
    assert all(f["face"] is not None for f in frames)
    r = c.post("/predict", json={"frames": frames}, headers={"X-Recognition-Token": TOKEN})
    assert r.status_code == 200
    assert seen and all(f["face"] is None for f in seen)


@pytest.fixture
def fake_uvicorn(monkeypatch):
    calls = []
    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.append(kw))
    return calls


def test_a5_lan_bind_needs_tls(monkeypatch, fake_uvicorn, tmp_path):
    monkeypatch.setenv("RECOGNITION_TOKEN", TOKEN)
    with pytest.raises(SystemExit, match="plain HTTP"):
        server.main(["--host", "10.0.149.212"])
    with pytest.raises(SystemExit, match="both"):
        server.main(["--host", "10.0.149.212", "--ssl-certfile", "c.pem"])
    assert fake_uvicorn == []
    server.main(["--host", "10.0.149.212", "--ssl-certfile", str(tmp_path / "c.pem"), "--ssl-keyfile", str(tmp_path / "k.pem")])
    assert fake_uvicorn[-1]["ssl_certfile"].endswith("c.pem") and fake_uvicorn[-1]["ssl_keyfile"].endswith("k.pem")
    server.main(["--host", "10.0.149.212", "--insecure-http"])   # explicit opt-out, with a warning
    assert "ssl_certfile" not in fake_uvicorn[-1]


def test_a5_loopback_bind_needs_neither_token_nor_tls(monkeypatch, fake_uvicorn):
    monkeypatch.delenv("RECOGNITION_TOKEN", raising=False)
    server.main([])
    assert fake_uvicorn[-1]["host"] == "127.0.0.1"
    with pytest.raises(SystemExit, match="RECOGNITION_TOKEN"):
        server.main(["--host", "0.0.0.0", "--insecure-http"])

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from recognition import live, mediapipe_adapter as mpa
from recognition.classify_video import needs_repeat

KEY = "k" * 40


class App:
    """Local HTTP server standing in for the app: records (headers, body) of every POST."""

    def __init__(self, status=200, location=None):
        got = self.got = []

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                got.append(({k.lower(): v for k, v in self.headers.items()}, body))
                self.send_response(status)
                if location:
                    self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}/api/guest/signs"
        self.th = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.th.start()

    def wait(self, n, timeout=5):
        end = time.monotonic() + timeout
        while len(self.got) < n and time.monotonic() < end:
            time.sleep(0.01)
        return self.got

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def test_poster_sends_json_with_the_bridge_key():
    app = App()
    p = live.Poster(app.url, KEY)
    events = [{"type": "sign", "seq": 1, "top": [{"label": "YES", "conf": 0.9}]},
              {"type": "utterance", "signs": [{"label": "YES", "conf": 0.31}], "needs_repeat": True, "t_end": 1.0}]
    for ev in events:
        p.send(ev)
    p.close()
    app.close()
    assert [b for _, b in app.got] == events                                       # repeat requests are sent too
    for headers, _ in app.got:
        assert headers["content-type"] == "application/json" and headers["x-bridge-key"] == KEY


def test_poster_without_key_sends_no_header():
    app = App()
    p = live.Poster(app.url, None)
    p.send({"type": "status"})
    p.close()
    app.close()
    assert "x-bridge-key" not in app.got[0][0]


def test_poster_never_follows_redirects(capsys):
    other = App()
    app = App(status=307, location=other.url)
    p = live.Poster(app.url, KEY)
    p.send({"type": "status"})
    p.close()
    app.close()
    other.close()
    assert len(app.got) == 1 and other.got == [] and p.failed == 1
    assert KEY not in capsys.readouterr().err


def test_poster_drops_the_oldest_and_never_blocks(monkeypatch):
    gate, posted = threading.Event(), []

    def slow_post(self, ev):
        gate.wait(5)
        posted.append(ev["n"])
    monkeypatch.setattr(live.Poster, "_post", slow_post)
    p = live.Poster("http://127.0.0.1:9/x", None, maxsize=3)
    t0 = time.monotonic()
    p.send({"n": 0})
    time.sleep(0.1)                                    # the worker holds event 0
    for n in range(1, 10):
        p.send({"n": n})
    assert time.monotonic() - t0 < 1.0
    gate.set()
    p.close()
    assert posted == [0, 7, 8, 9] and p.dropped == 6


def test_poster_survives_a_dead_app(capsys):
    p = live.Poster("http://127.0.0.1:9/api", KEY, timeout=0.5)
    t0 = time.monotonic()
    for i in range(5):
        p.send({"type": "status", "i": i})
    assert time.monotonic() - t0 < 0.2
    p.close(5)
    err = capsys.readouterr().err
    assert p.failed == 5 and "post failed" in err and KEY not in err


def test_poster_shutdown_with_a_full_queue_discards_pending_events(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    posted = []

    def blocked_post(self, ev):
        entered.set()
        release.wait(5)
        posted.append(ev["n"])

    monkeypatch.setattr(live.Poster, "_post", blocked_post)
    p = live.Poster("http://127.0.0.1:9/x", maxsize=2)
    try:
        p.send({"n": 0})
        assert entered.wait(1)
        p.send({"n": 1})
        p.send({"n": 2})
        start = time.monotonic()
        p.close(timeout=0.02)
        assert time.monotonic() - start < 0.5
        assert p.q.empty() and p.dropped == 2
        p.send({"n": 3})
        assert p.q.empty() and p.dropped == 3
    finally:
        release.set()
        p.thread.join(1)
    assert not p.thread.is_alive() and posted == [0]


def test_camera_reader_keeps_only_the_newest_frame(monkeypatch):
    monkeypatch.setattr(live, "READ_FAIL_SEC", 0.2)

    class Cap:
        def __init__(self):
            self.n = 0

        def read(self):
            self.n += 1
            if self.n > 50:
                return False, None
            return True, self.n
    r = live.CameraReader(Cap())
    time.sleep(0.1)
    img, t = r.get()
    assert img >= 1 and r.skipped == img - 1
    gets = 1
    while r.get(1) is not None:
        gets += 1
    assert r.done and r.taken == 50 and r.skipped == 50 - gets
    r.stop()


def fake_live(monkeypatch, n_frames=45):
    """live.main with a fake camera, landmarker, recognizer and stream; returns (stream calls, posted app)."""
    import types
    clock = [100.0]
    monkeypatch.setattr(live.time, "monotonic", lambda: clock[0])

    class Cap:
        def isOpened(self):
            return True

        def get(self, p):
            return 1280 if p == 3 else 720

        def set(self, *a):
            return True

        def release(self):
            pass

    class Reader:
        def __init__(self, cap):
            self.i, self.skipped = 0, 0

        def get(self):
            self.i += 1
            clock[0] += 1 / 30
            if self.i > n_frames:
                return None
            return np.zeros((720, 1280, 3), np.uint8), clock[0]

        def stop(self):
            pass

    class LM:
        def close(self):
            pass

    calls = []

    class Stream:
        status = "OK"

        def __init__(self, rec, size, args, **kw):
            calls.append(("size", size, args.utterance_gap, args.waist))
            self.timings = types.SimpleNamespace(summary=lambda fps=None: "latency p50/p95: test")

        def detect(self, lm, rgb, t):
            calls.append(t)
            if len(calls) == 21:
                return [{"type": "sign", "seq": 1, "top": [{"label": "YES", "conf": 0.31}] * 3, "t_sign_start": 1,
                         "t_sign_end": 2, "t_closed": 2.5, "t_predicted": 2.51},
                        {"type": "utterance", "signs": [{"label": "YES", "conf": 0.31}], "seqs": [1],
                         "needs_repeat": True, "t_end": 4}]
            return []

        def status_event(self, state):
            return {"type": "status", "fps": 30.0, "recognizer": state, "t": 0} if len(calls) == 2 else None

        def fps(self):
            return 30.0

    cv2 = types.SimpleNamespace(VideoCapture=lambda i: Cap(), CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4,
                                CAP_PROP_FPS=5, cvtColor=lambda a, c: a, COLOR_BGR2RGB=0)
    monkeypatch.setattr(live, "import_cv2", lambda: cv2)
    monkeypatch.setattr(live, "load_recognizer", lambda args, allow_missing: (None, "mock"))
    monkeypatch.setattr(live, "load_landmarker", lambda args: LM())
    monkeypatch.setattr(live, "CameraReader", Reader)
    monkeypatch.setattr(live, "make_stream", Stream)
    return calls


def test_live_posts_every_event_including_repeat_requests(monkeypatch, capsys):
    monkeypatch.setenv("BRIDGE_KEY", KEY)
    app = App()
    calls = fake_live(monkeypatch)
    live.main(["--no-preview", "--mock", "--post", app.url, "--utterance-gap", "0.9", "--waist", "none"])
    got = app.wait(3)
    app.close()
    out = capsys.readouterr().out
    assert calls[0] == ("size", (1280, 720), 0.9, "none")
    assert np.allclose(np.diff(calls[1:]), 1 / 30)                       # capture times from the reader
    assert [b["type"] for _, b in got] == ["status", "sign", "utterance"]
    assert got[2][1]["needs_repeat"] is True and all(h["x-bridge-key"] == KEY for h, _ in got)
    assert "repeat request" in out and "latency p50/p95" in out and KEY not in out


def test_post_rejects_non_http_urls():
    with pytest.raises(SystemExit):
        live.main(["--post", "file:///etc/passwd", "--mock", "--no-preview"])


def test_needs_repeat_follows_the_p4_rule():
    assert not needs_repeat([{"label": "YES", "conf": 0.9}])
    assert needs_repeat([{"label": "YES", "conf": 0.9}, {"label": "NONE", "conf": 0.98}])
    assert needs_repeat([{"label": "YES", "conf": 0.59}])


REAL_IMAGE = os.environ.get("RECOGNITION_TEST_IMAGE")


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and mpa.DEFAULT_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE and download the holistic .task")
def test_classify_video_end_to_end(tmp_path, capsys):
    """Real MediaPipe on a clip made by rocking a still photo (NOT signing): checks the plumbing only."""
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("mediapipe")
    from recognition import classify_video
    img = cv2.imread(REAL_IMAGE)
    h, w = img.shape[:2]
    clip = tmp_path / "rock.mp4"
    vw = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 30, (w, h))
    for i in range(90):
        a = 12 * np.sin(2 * np.pi * (i - 15) / 30) if 15 <= i < 60 else 0
        vw.write(cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2, h / 2), a, 1.0), (w, h),
                                borderMode=cv2.BORDER_REFLECT))
    for _ in range(60):
        vw.write(np.full_like(img, 128))
    vw.release()
    classify_video.main([str(clip), "--mock", "--json"])
    out = capsys.readouterr().out
    assert "sign 1" in out and "utterance:" in out and "150 frames read" in out
    events = [json.loads(line[6:]) for line in out.splitlines() if line.startswith("event ")]
    kinds = [e["type"] for e in events]
    assert "sign" in kinds and "utterance" in kinds and kinds.index("sign") < kinds.index("utterance")
    assert {"type": "framing", "status": "NO_PERSON", "since": 3.0} in events
    sign = events[kinds.index("sign")]
    assert sign["t_sign_start"] <= sign["t_sign_end"] <= sign["t_closed"] <= sign["t_predicted"]
    assert "latency p50/p95: MediaPipe" in out

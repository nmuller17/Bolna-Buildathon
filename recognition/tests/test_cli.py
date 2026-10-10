import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import pytest

from recognition import live, mediapipe_adapter as mpa
from recognition.classify_video import needs_repeat


def test_post_sends_only_the_signs():
    got = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            got.append((self.headers["Content-Type"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.handle_request, daemon=True)
    th.start()
    signs = [{"label": "YES", "conf": 0.9}, {"label": "RESERVATION", "conf": 0.8}]
    live.post(f"http://127.0.0.1:{srv.server_port}/api/english", signs).join(5)
    th.join(5)
    srv.server_close()
    assert got == [("application/json", {"signs": signs})]


class Recorder:
    """Local HTTP server that records POST bodies."""

    def __init__(self):
        got = self.got = []

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass
        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.srv.timeout = 0.5
        self.url = f"http://127.0.0.1:{self.srv.server_port}/api/english"

    def serve_once(self):
        self.srv.handle_request()
        self.srv.server_close()


@pytest.mark.parametrize("signs", [[{"label": "YES", "conf": 0.31}],
                                   [{"label": "NONE", "conf": 0.98}, {"label": "YES", "conf": 0.9}],
                                   [{"label": "NONE", "conf": 0.98}]])
def test_utterances_needing_a_repeat_are_never_posted(signs, capsys):
    rec = Recorder()
    assert live.on_utterance(signs, rec.url) is None
    rec.serve_once()                                       # waits 0.5 s for a request that must not come
    assert rec.got == [] and "repeat request" in capsys.readouterr().out


def test_confident_utterance_is_posted():
    rec = Recorder()
    signs = [{"label": "YES", "conf": 0.9}, {"label": "RESERVATION", "conf": 0.61}]
    th = live.on_utterance(signs, rec.url)
    rec.serve_once()
    th.join(5)
    assert rec.got == [{"signs": signs}]


def fake_camera(monkeypatch, first_read, n_frames=45, conf=0.9):
    """live.main with a fake clock, camera, landmarker, recognizer and segmenter; returns the segmenter times."""
    import types
    clock = [100.0]
    monkeypatch.setattr(live.time, "monotonic", lambda: clock[0])

    class Cap:
        def __init__(self, i):
            self.n = 0

        def isOpened(self):
            return True

        def get(self, p):
            return 1280 if p == 3 else 720

        def read(self):
            clock[0] += first_read if self.n == 0 else 1 / 30
            self.n += 1
            if self.n > n_frames:
                raise KeyboardInterrupt
            return True, np.zeros((720, 1280, 3), np.uint8)

        def release(self):
            pass

    class LM:
        def detect_for_video(self, img, ts):
            return None

        def close(self):
            pass

    class Rec:
        def predict(self, frames):
            return [{"label": "YES", "conf": conf}] * 3

    seen = []

    class Seg:
        def __init__(self, fps=30, y_scale=1.0):
            seen.append(("y_scale", y_scale))

        def push(self, frame, t=None):
            seen.append(t)
            return [("sign", [frame]), ("utterance_end",)] if len(seen) == 40 else []

    cv2 = types.SimpleNamespace(VideoCapture=Cap, CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4,
                                cvtColor=lambda a, c: a, COLOR_BGR2RGB=0)
    monkeypatch.setattr(live, "import_cv2", lambda: cv2)
    monkeypatch.setattr(live, "load", lambda args: (Rec(), LM()))
    monkeypatch.setattr(live.mpa, "mp_image", lambda a: a)
    import recognition.segmenter
    monkeypatch.setattr(recognition.segmenter, "Segmenter", Seg)
    return seen


def test_live_passes_capture_times_and_ignores_camera_start_up(monkeypatch, capsys):
    seen = fake_camera(monkeypatch, first_read=1.0)
    live.main(["--no-preview", "--mock"])
    out = capsys.readouterr().out
    assert seen[0] == ("y_scale", 720 / 1280)
    assert np.allclose(np.diff(seen[1:]), 1 / 30)                 # real frame times, start-up excluded
    assert "processing at 30.0 frames/s" in out


def test_live_post_skips_low_confidence(monkeypatch, capsys):
    rec = Recorder()
    fake_camera(monkeypatch, first_read=0.03, conf=0.31)
    live.main(["--no-preview", "--mock", "--post", rec.url])
    rec.serve_once()
    assert rec.got == [] and "repeat request" in capsys.readouterr().out


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
    classify_video.main([str(clip), "--mock"])
    out = capsys.readouterr().out
    assert "sign 1" in out and "utterance:" in out and "150 frames read" in out

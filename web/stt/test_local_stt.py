"""Tests for web/stt/local_stt.py with a stub model (features plan F3 test 1). Standard library only.

Run: python3 -m unittest web/stt/test_local_stt.py   (from the repository root)
"""
from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_stt  # noqa: E402

KEY = "k" * 40
CANARY = "Zq7CanaryRoom517"


class Word:
    def __init__(self, word: str, probability: float) -> None:
        self.word = word
        self.probability = probability


class Seg:
    def __init__(self, text: str, words: list) -> None:
        self.text = text
        self.words = words


class StubModel:
    """Returns a fixed sentence; `delay` makes decoding slow so the queue fills."""

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.calls = 0

    def transcribe(self, audio, **kw):
        self.calls += 1
        assert kw["language"] == "en" and kw["vad_filter"] is True and kw["word_timestamps"] is True and kw["beam_size"] == 1
        time.sleep(self.delay)
        return [Seg(f" Welcome to {CANARY}​", [Word(" Welcome", 0.98), Word(" to", 0.9), Word(f" {CANARY}", 0.31)])], None


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Server:
    def __init__(self, delay: float = 0.0, queue_max: int = 2) -> None:
        self.port = free_port()
        self.model = StubModel(delay)
        self.srv = local_stt.SttServer(self.port, KEY, lambda: local_stt.Decoder(self.model), queue_max=queue_max)
        self.srv.load()
        threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.worker = threading.Thread(target=self.srv.worker, daemon=True)
        self.worker.start()

    def close(self) -> None:
        self.srv.stopping.set()
        self.srv.shutdown()
        self.srv.server_close()

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> tuple[int, dict]:
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"127.0.0.1:{self.port}", "X-STT-Key": KEY}
        if body is not None:
            h["Content-Type"] = "application/octet-stream"
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            c.putheader(k, v)
        if body is not None and "Content-Length" not in h and "Transfer-Encoding" not in h:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders()
        if body is not None:
            c.send(body)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data else {})


PCM = b"\x01\x00" * 16_000  # one second of near-silence


class LocalSttTests(unittest.TestCase):
    def setUp(self) -> None:
        self.s = Server()

    def tearDown(self) -> None:
        self.s.close()

    def test_binds_loopback_only_and_refuses_other_hosts(self) -> None:
        self.assertEqual(self.s.srv.server_address[0], "127.0.0.1")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(local_stt.main(["--port", str(free_port()), "--host", "0.0.0.0"]), 2)
        self.assertIn("127.0.0.1", err.getvalue())

    def test_key_required_and_constant_time(self) -> None:
        self.assertEqual(self.s.request("GET", "/health", headers={"X-STT-Key": None})[0], 401)
        self.assertEqual(self.s.request("GET", "/health", headers={"X-STT-Key": "x" * 40})[0], 401)
        self.assertEqual(self.s.request("POST", "/transcribe", PCM, headers={"X-STT-Key": "wrong"})[0], 401)
        st, body = self.s.request("GET", "/health")
        self.assertEqual((st, body), (200, {"ok": True, "ready": True, "model": "small.en"}))
        with self.assertRaises(ValueError):
            local_stt.SttServer(free_port(), "short", lambda: None)

    def test_host_and_origin_checks(self) -> None:
        self.assertEqual(self.s.request("GET", "/health", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.s.request("POST", "/transcribe", PCM, headers={"Origin": "http://127.0.0.1:3000"})[0], 403)

    def test_content_length_size_and_type(self) -> None:
        self.assertEqual(self.s.request("POST", "/transcribe", None, headers={"Content-Type": "application/octet-stream"})[0], 411)
        # Only the header is sent: the server must refuse before reading a byte of the body.
        self.assertEqual(self.s.request("POST", "/transcribe", b"", headers={"Content-Length": str(local_stt.MAX_BODY_BYTES + 2)})[0], 413)
        self.assertEqual(self.s.request("POST", "/transcribe", PCM, headers={"Content-Type": "audio/webm"})[0], 415)
        self.assertEqual(self.s.request("POST", "/transcribe", b"\x00\x00\x00")[0], 400)
        self.assertEqual(self.s.request("GET", "/transcribe")[0], 404)
        self.assertEqual(self.s.request("POST", "/other", PCM)[0], 404)

    def test_transcribe_shape_and_cleaning(self) -> None:
        st, body = self.s.request("POST", "/transcribe", PCM)
        self.assertEqual(st, 200)
        self.assertEqual(set(body), {"text", "words", "audioMs", "decodeMs"})
        self.assertEqual(body["text"], f"Welcome to {CANARY}")  # zero-width removed, trimmed
        self.assertEqual(body["words"][2], {"w": CANARY, "p": 0.31})
        self.assertEqual(body["audioMs"], 1000)

    def test_audio_is_cut_at_15_seconds(self) -> None:
        captured = {}
        orig = self.s.model.transcribe

        def spy(audio, **kw):
            captured["n"] = len(audio)
            return orig(audio, **kw)

        self.s.model.transcribe = spy
        st, body = self.s.request("POST", "/transcribe", b"\x00\x00" * (16_000 * 20))
        self.assertEqual(st, 200)
        self.assertEqual(captured["n"], 16_000 * 15)
        self.assertEqual(body["audioMs"], 15_000)

    def test_full_queue_answers_busy(self) -> None:
        self.s.close()
        self.s = Server(delay=0.6, queue_max=1)
        results: list[int] = []
        lock = threading.Lock()

        def go() -> None:
            st, _ = self.s.request("POST", "/transcribe", PCM)
            with lock:
                results.append(st)

        threads = [threading.Thread(target=go) for _ in range(4)]
        for t in threads:
            t.start()
            time.sleep(0.05)
        for t in threads:
            t.join()
        self.assertIn(503, results)
        self.assertIn(200, results)

    def test_nothing_is_logged(self) -> None:
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            self.s.request("POST", "/transcribe", PCM)
            self.s.request("POST", "/transcribe", PCM, headers={"X-STT-Key": "bad"})
            self.s.request("GET", "/nope")
        self.assertEqual(err.getvalue() + out.getvalue(), "")
        self.assertNotIn(CANARY, err.getvalue())

    def test_clean_text(self) -> None:
        self.assertEqual(local_stt.clean_text("ﬁve​  rooms\x00 ok"), "five rooms ok")


if __name__ == "__main__":
    unittest.main()

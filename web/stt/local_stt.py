#!/usr/bin/env python3
"""SignBridge local speech-to-text (P4, features plan F3, "On this laptop").

faster-whisper (Systran/faster-whisper-small.en, int8 on the CPU) behind a tiny HTTP listener on
127.0.0.1 only. The app server (web/app/api/staff/stt) is its only client: the staff page sends the
receptionist's microphone audio to the app on 127.0.0.1, the app forwards it here, and the words
come back. Nothing is downloaded and nothing is sent anywhere: HF_HUB_OFFLINE=1 and
HF_HUB_DISABLE_TELEMETRY=1 are set by this process itself before faster_whisper is imported, and the
model is opened with local_files_only=True from ~/.cache/huggingface.

Hardening (the design of mcp-terra's audio_summary.py):
- binds 127.0.0.1 only; any other --host is refused;
- every request needs X-STT-Key, compared in constant time with LOCAL_STT_KEY (at least 32
  characters, from the environment, never from the command line);
- POST /transcribe takes raw 16 kHz mono signed 16-bit little-endian PCM with Content-Type
  application/octet-stream and a Content-Length (411 without one, 413 above the cap, 415 for any
  other type); at most 15 seconds of audio are decoded per request;
- one decoder thread and a bounded queue (503 "busy" when full), a cap on open connections, a
  socket timeout on every connection;
- requests are never logged (log_message is a no-op); audio and text never touch the disk;
- the text is NFKC-normalised and control/format characters are removed before it is returned;
- clean exit on SIGTERM and SIGINT, and when the parent process is gone.

Run (demo.sh does this with an argument list, never a shell string):
    LOCAL_STT_KEY=<32+ chars> /Users/trehman/.venvs/signbridge-stt/bin/python web/stt/local_stt.py --port 8790
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import queue
import signal
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 15
MAX_DECODE_SAMPLES = SAMPLE_RATE * MAX_AUDIO_SECONDS
# Same as FEATURE_LIMITS.sttBodyMaxBytes in web/lib/app/types.ts (30 s of s16le, room for the 15 s cut).
MAX_BODY_BYTES = 960_000
QUEUE_MAX = 2  # FEATURE_LIMITS.sttQueueMax
MAX_CONNECTIONS = 8
SOCKET_TIMEOUT_S = 10.0
JOB_TIMEOUT_S = 20.0
KEY_MIN_LEN = 32
MODEL_NAME = "small.en"
MAX_TEXT_CHARS = 2_000


def clean_text(s: str) -> str:
    """NFKC, control/format characters removed, whitespace collapsed (same rule as hygiene.ts)."""
    s = unicodedata.normalize("NFKC", s)
    out = []
    for ch in s:
        cat = unicodedata.category(ch)
        if cat == "Cf":
            continue
        if cat in ("Cc", "Zl", "Zp"):
            out.append(" ")
            continue
        out.append(ch)
    return " ".join("".join(out).split())[:MAX_TEXT_CHARS]


class Decoder:
    """Wraps a faster-whisper model (or a test stub with the same transcribe signature)."""

    def __init__(self, model: Any) -> None:
        self.model = model

    def decode(self, pcm: bytes) -> dict:
        import array

        samples = array.array("h")
        samples.frombytes(pcm[: MAX_DECODE_SAMPLES * 2])
        if sys.byteorder != "little":
            samples.byteswap()
        audio_ms = int(len(samples) * 1000 / SAMPLE_RATE)
        try:
            import numpy as np  # present in the faster-whisper venv

            audio: Any = np.frombuffer(samples.tobytes(), dtype=np.int16).astype(np.float32) / 32768.0
        except ImportError:  # test stubs run without numpy
            audio = [x / 32768.0 for x in samples]
        t0 = time.perf_counter()
        segments, _info = self.model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=True,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        texts: list[str] = []
        words: list[dict] = []
        for seg in segments:
            texts.append(str(seg.text))
            for w in getattr(seg, "words", None) or []:
                word = clean_text(str(w.word))
                if word:
                    p = float(w.probability)
                    words.append({"w": word, "p": round(max(0.0, min(1.0, p)), 3)})
        decode_ms = int((time.perf_counter() - t0) * 1000)
        return {"text": clean_text(" ".join(texts)), "words": words[:400], "audioMs": audio_ms, "decodeMs": decode_ms}


class Job:
    __slots__ = ("pcm", "done", "result", "error")

    def __init__(self, pcm: bytes) -> None:
        self.pcm = pcm
        self.done = threading.Event()
        self.result: Optional[dict] = None
        self.error = False


class SttServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, key: str, decoder_factory: Callable[[], Decoder], queue_max: int = QUEUE_MAX) -> None:
        if len(key) < KEY_MIN_LEN:
            raise ValueError(f"LOCAL_STT_KEY must be at least {KEY_MIN_LEN} characters")
        self.key = key.encode("utf-8")
        self.port_number = port
        self.jobs: "queue.Queue[Job]" = queue.Queue(maxsize=queue_max)
        self.ready = False
        self.decoder: Optional[Decoder] = None
        self.decoder_factory = decoder_factory
        self.connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.stopping = threading.Event()
        super().__init__(("127.0.0.1", port), Handler)

    def load(self) -> None:
        self.decoder = self.decoder_factory()
        self.ready = True

    def worker(self) -> None:
        while not self.stopping.is_set():
            try:
                job = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                assert self.decoder is not None
                job.result = self.decoder.decode(job.pcm)
            except Exception:
                job.error = True
            finally:
                job.pcm = b""
                job.done.set()

    def process_request(self, request: Any, client_address: Any) -> None:  # bound open connections
        if not self.connections.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


class Handler(BaseHTTPRequestHandler):
    server: SttServer
    timeout = SOCKET_TIMEOUT_S
    protocol_version = "HTTP/1.1"
    server_version = "sb-stt"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - never log a request
        return

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def guard(self) -> bool:
        """Host is ours, no browser Origin, key matches. False (with a reply sent) when refused."""
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in (f"127.0.0.1:{self.server.port_number}", f"localhost:{self.server.port_number}"):
            self.reply(403, {"ok": False, "error": "host not allowed"})
            return False
        if self.headers.get("Origin") is not None:
            self.reply(403, {"ok": False, "error": "not for browsers"})
            return False
        given = (self.headers.get("X-STT-Key") or "").encode("utf-8")
        if not hmac.compare_digest(given, self.server.key):
            self.reply(401, {"ok": False, "error": "wrong or missing key"})
            return False
        return True

    def do_GET(self) -> None:
        if self.path != "/health":
            self.reply(404, {"ok": False, "error": "not found"})
            return
        if not self.guard():
            return
        self.reply(200, {"ok": True, "ready": self.server.ready, "model": MODEL_NAME})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self.reply(404, {"ok": False, "error": "not found"})
            return
        if not self.guard():
            return
        if self.headers.get("Transfer-Encoding") is not None:
            self.reply(411, {"ok": False, "error": "Content-Length required"})
            return
        declared = self.headers.get("Content-Length")
        if declared is None or not declared.isdigit():
            self.reply(411, {"ok": False, "error": "Content-Length required"})
            return
        n = int(declared)
        if n > MAX_BODY_BYTES:
            self.reply(413, {"ok": False, "error": "too large"})
            return
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/octet-stream":
            self.reply(415, {"ok": False, "error": "Content-Type must be application/octet-stream"})
            return
        if n == 0 or n % 2:
            self.reply(400, {"ok": False, "error": "body must be 16-bit PCM"})
            return
        pcm = self.rfile.read(n)
        if len(pcm) != n:
            self.reply(400, {"ok": False, "error": "short body"})
            return
        if not self.server.ready:
            self.reply(503, {"ok": False, "error": "loading"})
            return
        job = Job(pcm)
        del pcm
        try:
            self.server.jobs.put_nowait(job)
        except queue.Full:
            self.reply(503, {"ok": False, "error": "busy"})
            return
        if not job.done.wait(JOB_TIMEOUT_S) or job.error or job.result is None:
            self.reply(500, {"ok": False, "error": "decode failed"})
            return
        self.reply(200, job.result)


def load_whisper(threads: int) -> Decoder:
    # Set before the import so nothing is downloaded and no telemetry is sent.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    from faster_whisper import WhisperModel  # type: ignore

    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", local_files_only=True, cpu_threads=threads)
    dec = Decoder(model)
    dec.decode(b"\x00\x00" * (SAMPLE_RATE // 2))  # warm-up so the first real request is not slow
    return dec


def watch_parent(server: SttServer, parent: int) -> None:
    while not server.stopping.wait(1.0):
        if os.getppid() != parent:
            stop(server)
            return


def stop(server: SttServer) -> None:
    if server.stopping.is_set():
        return
    server.stopping.set()
    threading.Thread(target=server.shutdown, daemon=True).start()


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="SignBridge local speech-to-text (127.0.0.1 only)")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--threads", type=int, default=min(6, os.cpu_count() or 2))
    ap.add_argument("--no-parent-watch", action="store_true", help="keep running when the parent exits (manual runs)")
    args = ap.parse_args(argv)
    if args.host != "127.0.0.1":
        print("local_stt: refusing to listen anywhere but 127.0.0.1", file=sys.stderr)
        return 2
    if not 1024 <= args.port <= 65535:
        print("local_stt: --port must be 1024 to 65535", file=sys.stderr)
        return 2
    key = os.environ.get("LOCAL_STT_KEY", "")
    if len(key) < KEY_MIN_LEN:
        print(f"local_stt: set LOCAL_STT_KEY (at least {KEY_MIN_LEN} characters) in the environment", file=sys.stderr)
        return 2
    os.environ.pop("LOCAL_STT_KEY", None)  # nothing this process starts needs it
    threads = max(1, min(8, args.threads))
    try:
        server = SttServer(args.port, key, lambda: load_whisper(threads))
    except OSError as e:
        print(f"local_stt: cannot listen on 127.0.0.1:{args.port} ({e.strerror})", file=sys.stderr)
        return 2
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop(server))
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()
    if not args.no_parent_watch:
        threading.Thread(target=watch_parent, args=(server, os.getppid()), daemon=True).start()
    print(f"local_stt: listening on 127.0.0.1:{args.port}, loading {MODEL_NAME} (offline)", file=sys.stderr, flush=True)
    t0 = time.perf_counter()
    try:
        server.load()
    except Exception as e:  # missing model, missing package
        print(
            f"local_stt: could not load {MODEL_NAME} from the local cache ({type(e).__name__}). "
            "Captions stay off; nothing was downloaded.",
            file=sys.stderr,
            flush=True,
        )
        stop(server)
        server.server_close()
        return 3
    print(f"local_stt: ready in {time.perf_counter() - t0:.1f} s", file=sys.stderr, flush=True)
    worker = threading.Thread(target=server.worker, daemon=True)
    worker.start()
    server.stopping.wait()
    worker.join(timeout=3)
    server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

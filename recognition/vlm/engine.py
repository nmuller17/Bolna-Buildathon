"""Vision-language engines with one interface: engine.generate(images, prompt) -> VLMResult.

LocalVLM  - runs on this laptop through MLX (Apple Silicon). Guest video never leaves the
            machine. This is the only engine the product path may use.
ClaudeVLM - Anthropic API. Frames are uploaded, so it is for consenting TEAM clips only
            (benchmarks), never for guest video. It refuses to start without ANTHROPIC_API_KEY
            and an explicit consent flag, and prints a warning on every call.

Both engines take an exclusive fcntl lock on /tmp/signbridge_vlm.lock around every generate
call, so only one VLM inference runs on the machine at a time (other processes queue on it).

LocalVLM also holds a second lock, /tmp/signbridge_vlm_resident.lock, for as long as a model is
loaded, so only ONE process on the machine keeps a ~4 GB model in memory (review finding 5: with
two resident copies on a 16 GB laptop, model time inside the inference lock went from p50 8.0 s
to 36.9 s). A second process either waits for it (batch jobs) or is refused (product, timeout 0).

Offline by default (review finding 1): LocalVLM.load() resolves the model from the local Hugging
Face cache only, at a pinned revision, and sets HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 before
importing the HF libraries, so loading never contacts huggingface.co. Downloading a model is a
separate, explicit step (allow_download=True or SIGNBRIDGE_VLM_ALLOW_DOWNLOAD=1).
"""
from __future__ import annotations

import base64
import fcntl
import io
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator, Sequence

from PIL import Image

LOCK_PATH = "/tmp/signbridge_vlm.lock"
RESIDENT_LOCK_PATH = "/tmp/signbridge_vlm_resident.lock"
DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3-VL-4B-Instruct-4bit"
# Exact snapshot every measurement in VLM_RESULTS.md used. An upstream update cannot silently
# change the product's model: load() refuses any other revision unless told otherwise.
PINNED_REVISIONS = {
    "mlx-community/Qwen3-VL-4B-Instruct-4bit": "2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b",
}
OFFLINE_ENV = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
DEFAULT_CLAUDE_MODEL = "claude-opus-5"   # ProtoCopilot compared claude-opus-4-8; pass model= to match it


class LockTimeout(TimeoutError):
    pass


class ModelResident(RuntimeError):
    """Another process already holds a loaded VLM (see RESIDENT_LOCK_PATH)."""


def _try_flock(fd: int, timeout_s: float | None, poll_s: float = 0.05) -> bool:
    t0 = time.monotonic()
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if timeout_s is not None and time.monotonic() - t0 >= timeout_s:
                return False
            time.sleep(poll_s)


def resident_holder(path: str = RESIDENT_LOCK_PATH) -> str | None:
    """PID text of the process that currently keeps a model loaded, or None if nobody does."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    except OSError:
        return None
    try:
        if _try_flock(fd, 0):
            fcntl.flock(fd, fcntl.LOCK_UN)
            return None
        return (os.pread(fd, 32, 0).decode(errors="replace").strip() or "?")
    finally:
        os.close(fd)


def resolve_local_model(model_id: str, revision: str | None = None) -> str:
    """Local directory of a cached model, WITHOUT any network access. Raises if it is not cached
    (download it once, deliberately, with allow_download=True)."""
    if Path(model_id).exists():
        return str(model_id)
    from huggingface_hub import snapshot_download
    return snapshot_download(model_id, revision=revision, local_files_only=True)


@contextmanager
def inference_lock(path: str = LOCK_PATH, timeout_s: float | None = None,
                   poll_s: float = 0.05) -> Iterator[float]:
    """Exclusive machine-wide lock. Yields the seconds spent waiting for it.
    timeout_s=None waits forever; otherwise raises LockTimeout."""
    t0 = time.monotonic()
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if timeout_s is not None and time.monotonic() - t0 >= timeout_s:
                    raise LockTimeout(f"could not take {path} within {timeout_s} s")
                time.sleep(poll_s)
        try:
            os.ftruncate(fd, 0)
            os.write(fd, f"{os.getpid()}\n".encode())
        except OSError:
            pass
        yield time.monotonic() - t0
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def recorder_running(pattern: str = "train_session.py") -> bool:
    """True while Talha's recorder is running (heavy inference would make it drop frames).
    Only a PYTHON process whose command line names the recorder counts: a shell that merely has
    the pattern in its text (e.g. someone's `pgrep -f train_session.py`) used to trigger a 60 s
    false wait."""
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    for pid in r.stdout.split():
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            comm = subprocess.run(["ps", "-o", "comm=", "-p", pid], capture_output=True, text=True,
                                  timeout=10).stdout.strip().lower()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if "python" in Path(comm).name:
            return True
    return False


def wait_for_recorder(poll_s: float = 60.0, log=print, pattern: str = "train_session.py") -> float:
    """Block while the recorder runs, polling every poll_s seconds. Returns seconds waited."""
    t0 = time.monotonic()
    announced = False
    while recorder_running(pattern):
        if not announced:
            log(f"[vlm] {pattern} is running; waiting (poll {poll_s:.0f} s) so recording keeps every frame")
            announced = True
        time.sleep(poll_s)
    return time.monotonic() - t0


@dataclass
class VLMResult:
    text: str
    engine: str
    model: str
    latency_s: float                 # wall time inside the lock (prefill + decode)
    lock_wait_s: float = 0.0
    n_images: int = 0
    prompt_tokens: int | None = None
    generation_tokens: int | None = None
    peak_memory_gb: float | None = None
    timed_out: bool = False
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _as_pil(images: Sequence) -> list[Image.Image]:
    out = []
    for im in images:
        if isinstance(im, Image.Image):
            out.append(im.convert("RGB"))
        elif isinstance(im, (str, Path)):
            out.append(Image.open(im).convert("RGB"))
        else:  # numpy RGB array
            out.append(Image.fromarray(im).convert("RGB"))
    return out


class LocalVLM:
    """MLX vision-language model loaded once and reused.

    generate() is deterministic (greedy, temperature 0). timeout_s caps DECODING only: generation
    stops at the first token after the deadline and the result is marked timed_out. Reading the
    images (prefill) cannot be interrupted, so the real floor of any call is the prefill time:
    measured ~6.8 s for 8 frames at 448 px with timeout_s=0.01 (review probe, n=1). Keep
    frames/resolution modest; a timeout does not bound wall time below that.

    Loading: offline, from the local cache, at PINNED_REVISIONS[model_id] when one is pinned.
    resident_timeout_s: how long load() waits for another process to unload its model
    (None = wait as long as it takes, the right choice for batch jobs; 0 = refuse at once with
    ModelResident, the right choice for the live product).
    """

    engine = "local-mlx"

    def __init__(self, model_id: str = DEFAULT_LOCAL_MODEL, max_tokens: int = 256,
                 timeout_s: float = 60.0, lock_path: str = LOCK_PATH,
                 lock_timeout_s: float | None = None, load: bool = True,
                 revision: str | None = None, allow_download: bool | None = None,
                 resident_lock_path: str = RESIDENT_LOCK_PATH,
                 resident_timeout_s: float | None = None):
        self.model_id = model_id
        self.revision = revision or PINNED_REVISIONS.get(model_id)
        if allow_download is None:
            allow_download = os.environ.get("SIGNBRIDGE_VLM_ALLOW_DOWNLOAD") == "1"
        self.allow_download = allow_download
        self.resident_lock_path = resident_lock_path
        self.resident_timeout_s = resident_timeout_s
        self._resident_fd: int | None = None
        self.model_path: str | None = None
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.lock_path = lock_path
        self.lock_timeout_s = lock_timeout_s
        self.model = self.processor = self.config = None
        self.load_s: float | None = None
        if load:
            self.load()

    def _take_resident(self) -> None:
        fd = os.open(self.resident_lock_path, os.O_RDWR | os.O_CREAT, 0o666)
        announced = False
        t0 = time.monotonic()
        while not _try_flock(fd, 0):
            waited = time.monotonic() - t0
            if self.resident_timeout_s is not None and waited >= self.resident_timeout_s:
                holder = os.pread(fd, 32, 0).decode(errors="replace").strip() or "?"
                os.close(fd)
                raise ModelResident(f"another process (pid {holder}) already keeps a VLM loaded; "
                                    "only one resident model per machine (16 GB)")
            if not announced:
                print(f"[vlm] another process keeps a VLM loaded ({self.resident_lock_path}); "
                      "waiting for it to unload", file=sys.stderr, flush=True)
                announced = True
            time.sleep(min(1.0, max(0.05, (self.resident_timeout_s or 1.0) / 10)))
        try:
            os.ftruncate(fd, 0)
            os.pwrite(fd, f"{os.getpid()}\n".encode(), 0)
        except OSError:
            pass
        self._resident_fd = fd

    def _release_resident(self) -> None:
        if self._resident_fd is not None:
            try:
                fcntl.flock(self._resident_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._resident_fd)
                self._resident_fd = None

    def load(self) -> float:
        if self.model is not None:
            return self.load_s or 0.0
        if not self.allow_download:
            for k in OFFLINE_ENV:      # before the HF libraries are imported (they read it once)
                os.environ.setdefault(k, "1")
        self._take_resident()
        try:
            t0 = time.monotonic()
            if self.allow_download:
                from huggingface_hub import snapshot_download
                self.model_path = snapshot_download(self.model_id, revision=self.revision)
            else:
                self.model_path = resolve_local_model(self.model_id, self.revision)
            from mlx_vlm import load as mlx_load  # heavy import, only when a model is used
            self.model, self.processor = mlx_load(self.model_path)
            self.config = self.model.config
            self.load_s = time.monotonic() - t0
        except BaseException:
            self.model = self.processor = self.config = None
            self._release_resident()
            raise
        return self.load_s

    def unload(self) -> None:
        self.model = self.processor = self.config = None
        try:
            import gc

            import mlx.core as mx
            gc.collect()
            mx.clear_cache()
        except Exception:
            pass
        finally:
            self._release_resident()   # only after the memory is given back

    def generate(self, images: Sequence, prompt: str, max_tokens: int | None = None,
                 timeout_s: float | None = None) -> VLMResult:
        import mlx.core as mx
        from mlx_vlm import stream_generate
        from mlx_vlm.prompt_utils import apply_chat_template

        self.load()
        imgs = _as_pil(images)
        formatted = apply_chat_template(self.processor, self.config, prompt, num_images=len(imgs))
        deadline_s = self.timeout_s if timeout_s is None else timeout_s
        text, last, timed_out = "", None, False
        with inference_lock(self.lock_path, self.lock_timeout_s) as waited:
            mx.reset_peak_memory()
            t0 = time.monotonic()
            for resp in stream_generate(self.model, self.processor, formatted,
                                        image=imgs if imgs else None,
                                        max_tokens=max_tokens or self.max_tokens,
                                        temperature=0.0):
                text += resp.text
                last = resp
                if deadline_s and time.monotonic() - t0 > deadline_s:
                    timed_out = True
                    break
            latency = time.monotonic() - t0
            peak = mx.get_peak_memory() / 1e9
        return VLMResult(
            text=text, engine=self.engine, model=self.model_id, latency_s=latency,
            lock_wait_s=waited, n_images=len(imgs),
            prompt_tokens=getattr(last, "prompt_tokens", None),
            generation_tokens=getattr(last, "generation_tokens", None),
            peak_memory_gb=peak, timed_out=timed_out,
            extra={"prompt_tps": getattr(last, "prompt_tps", None),
                   "generation_tps": getattr(last, "generation_tps", None)},
        )


CLAUDE_WARNING = ("[vlm] WARNING: ClaudeVLM uploads frames to the Anthropic API - video leaves the "
                  "laptop. Consenting team clips only; never guest video.")


class ClaudeVLM:
    """Same interface as LocalVLM, backed by the Anthropic Messages API (benchmarks only)."""

    engine = "claude-api"

    def __init__(self, model_id: str = DEFAULT_CLAUDE_MODEL, max_tokens: int = 1024,
                 timeout_s: float = 120.0, lock_path: str = LOCK_PATH,
                 consent_team_clips_only: bool = False, jpeg_quality: int = 85):
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ClaudeVLM runs only when ANTHROPIC_API_KEY is set.")
        if not consent_team_clips_only:
            raise RuntimeError("ClaudeVLM uploads video frames. Pass consent_team_clips_only=True "
                               "to confirm the clips are consenting team recordings, not guests.")
        import anthropic  # noqa: F401  (fail early if the SDK is missing)
        self.model_id = model_id
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.lock_path = lock_path
        self.jpeg_quality = jpeg_quality
        self._client = None
        print(CLAUDE_WARNING, file=sys.stderr)

    def _client_(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(timeout=self.timeout_s)
        return self._client

    def _b64(self, im: Image.Image) -> str:
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=self.jpeg_quality)
        return base64.standard_b64encode(buf.getvalue()).decode("ascii")

    def generate(self, images: Sequence, prompt: str, max_tokens: int | None = None,
                 timeout_s: float | None = None) -> VLMResult:
        print(CLAUDE_WARNING, file=sys.stderr)
        imgs = _as_pil(images)
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                "data": self._b64(im)}} for im in imgs]
        content.append({"type": "text", "text": prompt})
        client = self._client_()
        if timeout_s is not None:
            client = client.with_options(timeout=timeout_s)
        with inference_lock(self.lock_path) as waited:
            t0 = time.monotonic()
            resp = client.messages.create(model=self.model_id, max_tokens=max_tokens or self.max_tokens,
                                          messages=[{"role": "user", "content": content}])
            latency = time.monotonic() - t0
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        return VLMResult(text=text, engine=self.engine, model=self.model_id, latency_s=latency,
                         lock_wait_s=waited, n_images=len(imgs),
                         prompt_tokens=getattr(resp.usage, "input_tokens", None),
                         generation_tokens=getattr(resp.usage, "output_tokens", None),
                         extra={"stop_reason": resp.stop_reason})

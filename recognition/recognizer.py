"""In-process recognition: the same decision logic as POST /predict, without HTTP.

    from recognition.recognizer import Recognizer
    rec = Recognizer()                      # loads recognition/models/model.pt once
    rec.predict(frames)                     # -> [{"label", "conf"} x 3], best first

server.py calls decide() and the same validation models, so the two cannot diverge:
- frames are validated like the request body (CLAUDE.md 6.1 shapes, finite numbers within
  +-COORD_LIMIT, 1 to MAX_FRAMES frames); Recognizer.predict raises ValueError where the
  server answers 422;
- NONE (conf 0.98) without running the model when fewer than MIN_HAND_FRACTION of the frames
  contain a hand or fewer than MIN_POSE_FRACTION contain both shoulders;
- NONE when the model returns a non-finite confidence; confidences are clipped to [0, 1];
- the in-process helper converts a null whole frame (capture.landmarks.normalize returns
  None when MediaPipe found no pose) to a frame with every part null before validation.
  The HTTP API still requires Frame objects, as in the protected team contract.

needs_repeat(signs) is the CLAUDE.md 7.2 step 4 rule (any top-1 NONE or below REPEAT_BELOW);
recognition.stream uses it for the utterance event, and the app applies the same rule.

The checkpoint is checked against model_pin.EXPECTED_SHA256 before it is loaded (the bytes
that were hashed are the bytes that are loaded); a mismatch raises ModelPinError. Fail closed
(red-team A1/C4): while the pin is None, loading is also refused (ModelPinError) unless the
caller opts in to development mode with allow_unpinned=True or RECOGNITION_ALLOW_UNPINNED=1.
That opt-in never overrides a pin that is set: a set pin always wins.

Face landmarks are dropped right after validation (red-team D11): the model does not use them,
so neither the server nor Recognizer keeps a guest's face geometry in memory.
"""
import hashlib
import io
import logging
import os
from pathlib import Path
from typing import Annotated, Optional

import numpy as np
import torch
from pydantic import BaseModel, ConfigDict, Field

from recognition import features, model_pin
from recognition.labels import CLASSES, NONE
from recognition.model import Predictor

log = logging.getLogger("recognition")

MAX_FRAMES = 300
COORD_LIMIT = 50.0
MIN_HAND_FRACTION = 0.1
MIN_POSE_FRACTION = 0.3
REPEAT_BELOW = 0.6
EMPTY_FRAME = {"pose": None, "lh": None, "rh": None, "face": None}
DEFAULT_MODEL = Path(__file__).parent / "models" / "model.pt"

Coord = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-COORD_LIMIT, le=COORD_LIMIT)]
Point = Annotated[list[Coord], Field(min_length=3, max_length=3)]


class Frame(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pose: Optional[Annotated[list[Point], Field(min_length=33, max_length=33)]] = None
    lh: Optional[Annotated[list[Point], Field(min_length=21, max_length=21)]] = None
    rh: Optional[Annotated[list[Point], Field(min_length=21, max_length=21)]] = None
    face: Optional[Annotated[list[Point], Field(min_length=26, max_length=26)]] = None


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frames: Annotated[list[Frame], Field(min_length=1, max_length=MAX_FRAMES)]


def frame_dicts(frames):
    """Parsed Frame models -> plain Frame dicts, face dropped (not a model feature; privacy)."""
    return [{**f.model_dump(exclude={"face"}), "face": None} for f in frames]


class ModelUnavailable(RuntimeError):
    """No model loaded (and not in mock mode)."""


class ModelPinError(RuntimeError):
    """The checkpoint's SHA-256 differs from model_pin.EXPECTED_SHA256, or no pin is set (fail closed)."""


ALLOW_UNPINNED_ENV = "RECOGNITION_ALLOW_UNPINNED"


def unpinned_allowed(allow_unpinned=None):
    """allow_unpinned if given, else RECOGNITION_ALLOW_UNPINNED in (1, true, yes). Only matters while the pin is None."""
    if allow_unpinned is not None:
        return bool(allow_unpinned)
    return os.environ.get(ALLOW_UNPINNED_ENV, "").strip().lower() in ("1", "true", "yes")


def mock_top(frames):
    """Deterministic mock in the contract shape: label from the frame count; every 5th count is low-confidence."""
    n = len(frames)
    i = n % len(CLASSES)
    c1 = 0.45 if n % 5 == 0 else 0.9
    return [{"label": CLASSES[i], "conf": c1},
            {"label": CLASSES[(i + 1) % len(CLASSES)], "conf": round((1 - c1) * 0.6, 4)},
            {"label": CLASSES[(i + 2) % len(CLASSES)], "conf": round((1 - c1) * 0.3, 4)}]


def none_top():
    others = [c for c in CLASSES if c != NONE][:2]
    return [{"label": NONE, "conf": 0.98}, {"label": others[0], "conf": 0.01}, {"label": others[1], "conf": 0.01}]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def load_predictor(path, allow_unpinned=None):
    """Read the checkpoint once, check it against the pin, load it. Raises FileNotFoundError,
    ModelPinError (hash mismatch, or no pin without the development opt-in), or the loader's error."""
    data = Path(path).read_bytes()
    digest = sha256_bytes(data)
    expected = model_pin.EXPECTED_SHA256
    if expected is None:
        if not unpinned_allowed(allow_unpinned):
            log.error("model not pinned: refusing %s (sha256 %s). Pin it with python -m recognition.pin_model "
                      "%s, or for development only set %s=1", Path(path).name, digest, path, ALLOW_UNPINNED_ENV)
            raise ModelPinError("model not pinned (see the log)")
        log.warning("model not pinned: loading %s (sha256 %s) without a fingerprint check (%s=1, development "
                    "only); pin it at the freeze with python -m recognition.pin_model", Path(path).name, digest,
                    ALLOW_UNPINNED_ENV)
    elif digest != expected.lower():
        log.error("model hash mismatch: %s has sha256 %s, model_pin.py expects %s", Path(path).name, digest, expected)
        raise ModelPinError("model hash mismatch (see the log)")
    return Predictor(io.BytesIO(data))


def validate(frames):
    """Capture frames -> Frame dicts, using the HTTP schema after replacing missing frames.
    Raises pydantic.ValidationError (a ValueError) on malformed input."""
    if isinstance(frames, (list, tuple)):
        frames = [dict(EMPTY_FRAME) if f is None else f for f in frames]
    req = PredictRequest.model_validate({"frames": frames})
    return frame_dicts(req.frames)


def needs_repeat(signs):
    """CLAUDE.md 7.2 step 4: True when any sign's top prediction is NONE or below REPEAT_BELOW."""
    return any(p["label"] == NONE or p["conf"] < REPEAT_BELOW for p in signs)


def decide(frames, predictor, mock=False):
    """Validated Frame dicts -> top-3 predictions. Shared by the server and Recognizer."""
    if mock:
        return mock_top(frames)
    if predictor is None:
        raise ModelUnavailable("model not loaded")
    seq = features.to_seq(frames)
    if features.hand_fraction(seq) < MIN_HAND_FRACTION or features.pose_fraction(seq) < MIN_POSE_FRACTION:
        return none_top()
    top = predictor.top(seq, k=3)
    if not all(np.isfinite(p["conf"]) for p in top):
        return none_top()
    for p in top:
        p["conf"] = min(1.0, max(0.0, p["conf"]))
    return top


def _plain(x):
    """numpy arrays / scalars -> Python lists / floats (the strict schema accepts only plain numbers)."""
    if isinstance(x, np.ndarray):
        return x.tolist()
    if isinstance(x, np.generic):
        return x.item()
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_plain(v) for v in x]
    return x


class Recognizer:
    """Recognizer(checkpoint).predict(frames) -> top 3, same rules as POST /predict.

    frames: one segmented sign as Frame dicts (e.g. mediapipe_adapter output). mock=True
    needs no model and returns the server's deterministic mock answers."""

    def __init__(self, checkpoint=None, mock=False, allow_unpinned=None):
        self.mock = mock
        self.predictor = None
        if not mock:
            torch.set_num_threads(2)
            self.predictor = load_predictor(Path(checkpoint or DEFAULT_MODEL), allow_unpinned)

    def predict(self, frames):
        return decide(validate(_plain(list(frames))), self.predictor, self.mock)

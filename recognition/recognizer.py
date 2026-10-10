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
- NONE when the model returns a non-finite confidence; confidences are clipped to [0, 1].

The checkpoint is checked against model_pin.EXPECTED_SHA256 before it is loaded (the bytes
that were hashed are the bytes that are loaded); a mismatch raises ModelPinError.
"""
import hashlib
import io
import logging
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


class ModelUnavailable(RuntimeError):
    """No model loaded (and not in mock mode)."""


class ModelPinError(RuntimeError):
    """The checkpoint's SHA-256 differs from model_pin.EXPECTED_SHA256."""


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


def load_predictor(path):
    """Read the checkpoint once, check it against the pin, load it. Raises FileNotFoundError,
    ModelPinError, or the checkpoint loader's error."""
    data = Path(path).read_bytes()
    digest = sha256_bytes(data)
    expected = model_pin.EXPECTED_SHA256
    if expected is None:
        log.warning("model not pinned: loading %s (sha256 %s) without a fingerprint check; "
                    "pin it at the freeze with python -m recognition.pin_model", Path(path).name, digest)
    elif digest != expected.lower():
        log.error("model hash mismatch: %s has sha256 %s, model_pin.py expects %s", Path(path).name, digest, expected)
        raise ModelPinError("model hash mismatch (see the log)")
    return Predictor(io.BytesIO(data))


def validate(frames):
    """Frame[] -> plain Frame dicts, exactly as the server parses a request body. Raises
    pydantic.ValidationError (a ValueError) on malformed input."""
    req = PredictRequest.model_validate({"frames": frames})
    return [f.model_dump() for f in req.frames]


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

    def __init__(self, checkpoint=None, mock=False):
        self.mock = mock
        self.predictor = None
        if not mock:
            torch.set_num_threads(2)
            self.predictor = load_predictor(Path(checkpoint or DEFAULT_MODEL))

    def predict(self, frames):
        return decide(validate(_plain(list(frames))), self.predictor, self.mock)

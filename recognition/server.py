"""FastAPI server: POST /predict on port 8000.

    uvicorn recognition.server:app --host 127.0.0.1 --port 8000
    python -m recognition.server --host 0.0.0.0     # LAN (iPad): refuses to start without RECOGNITION_TOKEN

POST /predict  {"frames": Frame[]} -> {"top": [{"label", "conf"} x 3]}  (CLAUDE.md 6.5)
GET  /health   -> {"status", "model_loaded", "classes", "mock"}

Environment:
    RECOGNITION_MODEL            checkpoint path (default recognition/models/model.pt)
    RECOGNITION_MOCK=1           answer with a deterministic mock, no model needed
    RECOGNITION_ALLOWED_ORIGINS  comma-separated CORS allowlist (default http://localhost:3000,http://127.0.0.1:3000)
    RECOGNITION_ALLOWED_HOSTS    extra Host header values to accept (default only localhost, 127.0.0.1)
    RECOGNITION_TOKEN            if set, /predict requires header X-Recognition-Token

Privacy: request bodies and landmarks are never logged or written to disk; face
landmarks are not used by the model. Bind to 127.0.0.1 (default). Binding 0.0.0.0
(e.g. an iPad on the LAN) must come with the origin/host allowlists and RECOGNITION_TOKEN.
Never expose port 8000 through a tunnel (ngrok etc.).

Rejection rules (the model is skipped and NONE is returned with conf 0.98):
- fewer than 10% of frames contain a hand (the segment cannot be a sign);
- fewer than 30% of frames contain both shoulders (the coordinates cannot be normalized).
"""
import argparse
import hmac
import logging
import os
import sys
from pathlib import Path
from typing import Annotated, Optional

import numpy as np
import torch
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from recognition import features
from recognition.labels import CLASSES, NONE
from recognition.model import Predictor

log = logging.getLogger("recognition")

MAX_FRAMES = 300
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_INFLIGHT = 8
COORD_LIMIT = 50.0
MIN_HAND_FRACTION = 0.1
MIN_POSE_FRACTION = 0.3
DEFAULT_MODEL = Path(__file__).parent / "models" / "model.pt"
DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
LOCAL_HOSTS = ["localhost", "127.0.0.1"]

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


class Prediction(BaseModel):
    label: str
    conf: float


class PredictResponse(BaseModel):
    top: list[Prediction]


class Guard:
    """ASGI middleware: 413 for bodies over max_bytes (Content-Length or streamed), 429 when
    more than max_inflight /predict requests are already being handled."""

    def __init__(self, app, max_bytes=MAX_BODY_BYTES, max_inflight=MAX_INFLIGHT):
        self.app, self.max_bytes, self.max_inflight, self.inflight = app, max_bytes, max_inflight, 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.max_bytes:
            return await self._reject(send, 413, b"request body too large")
        counted = scope.get("path") == "/predict" and scope.get("method") == "POST"
        if counted and self.inflight >= self.max_inflight:
            return await self._reject(send, 429, b"server busy, retry")
        state = {"seen": 0, "over": False, "sent": False}

        async def limited_receive():
            msg = await receive()
            if msg["type"] == "http.request":
                state["seen"] += len(msg.get("body", b""))
                if state["seen"] > self.max_bytes:
                    state["over"] = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return msg

        async def guarded_send(msg):
            if state["over"]:
                if not state["sent"]:
                    state["sent"] = True
                    await self._reject(send, 413, b"request body too large")
                return
            await send(msg)

        self.inflight += counted
        try:
            await self.app(scope, limited_receive, guarded_send)
        finally:
            self.inflight -= counted

    @staticmethod
    async def _reject(send, status, detail):
        body = b'{"detail":"' + detail + b'"}'
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


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


def _split_env(name, default=""):
    return [o.strip() for o in os.environ.get(name, default).split(",") if o.strip()]


def create_app(model_path=None, mock=None, allowed_origins=None, token=None, allowed_hosts=None):
    model_path = Path(model_path or os.environ.get("RECOGNITION_MODEL") or DEFAULT_MODEL)
    if mock is None:
        mock = os.environ.get("RECOGNITION_MOCK", "") in ("1", "true", "yes")
    if allowed_origins is None:
        allowed_origins = _split_env("RECOGNITION_ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    if allowed_hosts is None:
        allowed_hosts = LOCAL_HOSTS + _split_env("RECOGNITION_ALLOWED_HOSTS")
    if token is None:
        token = os.environ.get("RECOGNITION_TOKEN") or None

    torch.set_num_threads(2)
    predictor = None
    if mock:
        log.warning("RECOGNITION_MOCK is on: /predict returns invented signs, not model output")
    elif model_path.exists():
        try:
            predictor = Predictor(model_path)
            log.info("model loaded from %s", model_path)
        except Exception as e:  # keep serving /health; /predict answers 503
            log.error("could not load %s: %s", model_path, e)
    else:
        log.error("model file not found: %s. Train one (python -m recognition.train) or set RECOGNITION_MOCK=1.",
                  model_path)

    def check_token(x_recognition_token: Optional[str] = Header(default=None)):
        # Runs before the body is validated. Compare bytes: non-ASCII str would raise in compare_digest.
        if token is not None and not hmac.compare_digest((x_recognition_token or "").encode("utf-8"),
                                                         token.encode("utf-8")):
            raise HTTPException(status_code=401, detail="missing or wrong X-Recognition-Token")

    api = FastAPI(title="SignBridge recognition", docs_url=None, redoc_url=None, openapi_url=None)
    # Added inner to outer: Guard, then CORS, then the Host check outermost.
    api.add_middleware(Guard, max_bytes=MAX_BODY_BYTES, max_inflight=MAX_INFLIGHT)
    api.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Recognition-Token"])
    api.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @api.exception_handler(RequestValidationError)
    async def compact_422(request: Request, exc: RequestValidationError):
        # Never echo the submitted landmarks back (pydantic's default includes the input).
        errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg", "")} for e in exc.errors()[:5]]
        return JSONResponse({"detail": errors}, status_code=422)

    @api.get("/health")
    def health():
        return {"status": "ok", "model_loaded": predictor is not None, "classes": CLASSES, "mock": mock}

    @api.post("/predict", response_model=PredictResponse, dependencies=[Depends(check_token)])
    def predict(req: PredictRequest):
        frames = [f.model_dump() for f in req.frames]
        if mock:
            return {"top": mock_top(frames)}
        if predictor is None:
            raise HTTPException(status_code=503, detail="model not loaded (see the server log); "
                                                        "train one or set RECOGNITION_MOCK=1")
        seq = features.to_seq(frames)
        if features.hand_fraction(seq) < MIN_HAND_FRACTION or features.pose_fraction(seq) < MIN_POSE_FRACTION:
            return {"top": none_top()}
        top = predictor.top(seq, k=3)
        if not all(np.isfinite(p["conf"]) for p in top):
            return {"top": none_top()}
        for p in top:
            p["conf"] = min(1.0, max(0.0, p["conf"]))
        return {"top": top}

    return api


app = create_app()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run the recognition server (refuses a non-local host without a token).")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)
    if args.host not in LOCAL_HOSTS and not os.environ.get("RECOGNITION_TOKEN"):
        sys.exit(f"refusing to bind {args.host} without RECOGNITION_TOKEN (and set RECOGNITION_ALLOWED_ORIGINS, "
                 "RECOGNITION_ALLOWED_HOSTS to the laptop's LAN address)")
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, limit_concurrency=32)


if __name__ == "__main__":
    main()

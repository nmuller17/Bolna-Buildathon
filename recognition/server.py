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
    RECOGNITION_TOKEN            if set, /predict requires header X-Recognition-Token; if NOT set, any
                                 client whose address is not 127.0.0.1 / ::1 gets 403

Privacy: request bodies and landmarks are never logged or written to disk; face
landmarks are not used by the model. Bind to 127.0.0.1 (default). Binding 0.0.0.0
(e.g. an iPad on the LAN) must come with the origin/host allowlists and RECOGNITION_TOKEN.
Never expose port 8000 through a tunnel (ngrok etc.).

The checkpoint must match recognition/model_pin.py (SHA-256) when that is set; otherwise
the log says "hash mismatch" and /predict answers 503.

The decision rules (NONE when too few frames contain a hand or the shoulders, non-finite
guard) live in recognition/recognizer.py, shared with the in-process Recognizer.
"""
import argparse
import hmac
import ipaddress
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import torch
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from recognition.labels import CLASSES
from recognition.recognizer import (COORD_LIMIT, DEFAULT_MODEL, MAX_FRAMES, MIN_HAND_FRACTION,  # noqa: F401
                                    MIN_POSE_FRACTION, Frame, ModelUnavailable, PredictRequest, decide,
                                    load_predictor, mock_top, none_top)

log = logging.getLogger("recognition")

MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_INFLIGHT = 8
DEFAULT_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"
LOCAL_HOSTS = ["localhost", "127.0.0.1"]


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


def is_loopback(client):
    """True for a 127.0.0.0/8 or ::1 peer (also IPv4-mapped ::ffff:127.x); False for anything else or no peer."""
    try:
        ip = ipaddress.ip_address((client or ("",))[0])
    except ValueError:
        return False
    return ip.is_loopback or bool(getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped.is_loopback)


class LoopbackOnly:
    """ASGI middleware: 403 for any HTTP client whose socket address is not on this machine."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and not is_loopback(scope.get("client")):
            if scope["type"] == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            return await Guard._reject(send, 403, b"only local clients are accepted")
        return await self.app(scope, receive, send)


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
    token = token or os.environ.get("RECOGNITION_TOKEN") or None  # "" never disables the loopback guard

    torch.set_num_threads(2)
    predictor = None
    if mock:
        log.warning("RECOGNITION_MOCK is on: /predict returns invented signs, not model output")
    elif model_path.exists():
        try:
            predictor = load_predictor(model_path)
            log.info("model loaded from %s", model_path)
        except Exception as e:  # keep serving /health; /predict answers 503 (hash mismatch is logged by load_predictor)
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
    # Added inner to outer: Guard, CORS, the Host check, then (without a token) the loopback check outermost.
    api.add_middleware(Guard, max_bytes=MAX_BODY_BYTES, max_inflight=MAX_INFLIGHT)
    api.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Recognition-Token"])
    api.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    if token is None:  # no token: only this laptop may connect, whatever address uvicorn is bound to
        api.add_middleware(LoopbackOnly)

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
        try:
            return {"top": decide([f.model_dump() for f in req.frames], predictor, mock)}
        except ModelUnavailable:
            raise HTTPException(status_code=503, detail="model not loaded (see the server log); "
                                                        "train one or set RECOGNITION_MOCK=1")

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

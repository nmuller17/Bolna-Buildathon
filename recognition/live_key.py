"""Live recognition triggered by a key, recorded exactly like the training takes.

    python -m recognition.live_key --camera 1                      # free: sentences of signs
    python -m recognition.live_key --camera 1 --test               # the 22 classes, one by one, scored
    python -m recognition.live_key --camera 1 --test-sentences     # the 20 guest sentences, scored
    ... [--post http://127.0.0.1:3000/api/guest/signs]             # send the events to the app
    python -m recognition.live_key --camera 1 --no-preview --control-port 8765 --post ...
                                                                   # driven by the /guest page

One sign: SPACE -> short countdown -> REC window (2 s, 3 s for FS-WIFI and PASSWORD when the
sign is known) -> landmarks through capture.Recorder.process (same code as the training takes)
-> model probabilities, NONE left out. A sentence: several signs, then ENTER (free mode) or
automatically (test mode); recognition.intents.decode snaps it to the closest guest sentence
of docs/vocabulary.md section 2, which fixes a sign the model got wrong.

Events (JSON, with --post): {"type": "sign", "seq", "top"} after each sign;
{"type": "utterance", "raw", "labels", "text", "snapped"} at the end of a sentence.
{"type": "capture", "phase": "countdown", "countdown": 1.5, "duration": 2.0} when a sign starts
(REC begins after `countdown` seconds and lasts `duration`), then "processing" when it stops.
Keys: SPACE sign, ENTER end the sentence, BACKSPACE drop the last sign, S skip (tests), Q quit.

Single-screen demo (--no-preview --control-port 8765): no OpenCV window, the /guest page drives
it through http://127.0.0.1:8765 (loopback only, CORS open, empty body):
  GET  /preview.mjpg  live mirrored camera feed for an <img>, always on (only this process opens the camera)
  GET  /health        "ok"
  POST /turn          the guest's turn, hands-free and continuous: the guest signs the whole sentence
                      in one go and rests the hands (down or still) for REST_SEC (2.5 s) to finish.
                      recognition.sentence aligns the 20 guest sentences on sliding 1 s windows of the
                      recording (no cutting into signs) and the best one is sent as "utterance".
                      Events: {"type": "turn", "phase": "start"}; {"type": "capture", "phase":
                      "listening"} (waiting for the hands) -> "signing" (hands moving) -> "processing";
                      utterance; {"type": "turn", "phase": "end", "empty"}. Nothing signed within
                      START_TIMEOUT (8 s) -> empty turn.
                      Optional JSON body {"expected": [["YES"], ["NO"], ["YES", "RESERVATION"]]}: the
                      answers expected after the last question (label lists of vocabulary.md s2); only
                      those sentences are considered. One entry = scripted demo step, cannot fail.
  POST /sign, /end, /undo   manual control (one sign, end of sentence, drop last sign)
"""
import argparse
from pathlib import Path
import json
import os
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

import capture.capture as capture_ui
from capture.capture import GREEN, RED, WHITE, Recorder, show
from recognition import features
from capture.clean import clean
from capture.landmarks import detect, normalize
from recognition.intents import GUEST_INTENTS, decode, without_none
from recognition.sentence import decode_continuous, window_probs
from recognition.labels import CLASSES
from recognition.live import Poster
from recognition.recognizer import load_predictor, validate

LONG_SIGNS = {"FS-WIFI", "PASSWORD"}
ENTER, BACKSPACE = (13, 10), (8, 127)


def top3(p):
    order = np.argsort(p)[::-1][:3]
    return [{"label": CLASSES[i], "conf": round(float(p[i]), 3)} for i in order]


def fmt(top):
    return " | ".join(f"{t['label']} {t['conf']:.2f}" for t in top)


COMMANDS = queue.Queue()   # "space" / "enter" / "back" / "turn" from the control server
PREVIEW = {"jpg": None, "lock": threading.Lock()}   # latest mirrored camera frame as JPEG
MAX_TURN_SIGNS = 4         # longest guest sentence has 3 signs


def valid_expected(expected):
    """Body field "expected" -> list of label lists made of known labels, or None."""
    if not isinstance(expected, list):
        return None
    out = [e for e in expected if isinstance(e, list) and e and all(label in CLASSES for label in e)]
    return out or None


def serve_control(port):
    """Loopback HTTP server: POST /sign, /end, /undo queue a command for the main loop."""
    paths = {"/sign": "space", "/end": "enter", "/undo": "back", "/turn": "turn"}

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code, body=b"ok"):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._reply(204, b"")

        def do_GET(self):
            if self.path.startswith("/preview.mjpg"):
                return self._mjpeg()
            self._reply(200 if self.path == "/health" else 404)

        def _mjpeg(self):
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            last = None
            try:
                while True:
                    with PREVIEW["lock"]:
                        jpg = PREVIEW["jpg"]
                    if jpg is not None and jpg is not last:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                        last = jpg
                    time.sleep(1 / 25)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            cmd = paths.get(self.path)
            if cmd is None:
                return self._reply(404, b"unknown")
            if cmd == "turn":            # optional body {"expected": [["YES"], ["YES", "RESERVATION"], ...]}
                expected = context = None
                length = int(self.headers.get("Content-Length") or 0)
                if 0 < length <= 4096:
                    try:
                        body = json.loads(self.rfile.read(length) or b"{}")
                        expected = valid_expected(body.get("expected"))
                        context = valid_expected(body.get("context"))
                    except (ValueError, AttributeError):
                        return self._reply(400, b"bad json")
                COMMANDS.put(("turn", expected, context if length else None))
            else:
                COMMANDS.put(cmd)
            self._reply(200)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"control: http://127.0.0.1:{port}  GET /preview.mjpg /health  POST /turn /sign /end /undo")


def wait_key(rec, lines):
    """Live preview until SPACE, ENTER, BACKSPACE, S or Q (window keys or control commands).
    Returns 'space', 'enter', 'back', 's', 'q'."""
    while True:
        try:
            return COMMANDS.get_nowait()
        except queue.Empty:
            pass
        key = show(rec.read(), lines)
        if key == ord(" "):
            return "space"
        if key in ENTER:
            return "enter"
        if key in BACKSPACE:
            return "back"
        if key in (ord("s"), ord("q")):
            return chr(key)
        if key == ord("t"):
            return "turn"


def sign_once(rec, predictor, title, target, a, countdown=None):
    """Record one sign. Returns (probabilities with NONE removed, last image, hands seen);
    probabilities None if Q was pressed."""
    duration = 3.0 if target in LONG_SIGNS else a.duration
    countdown = a.countdown if countdown is None else countdown
    a.emit({"type": "capture", "phase": "countdown", "countdown": countdown, "duration": duration})
    got = rec.take(target or "SIGN", title, countdown, duration)
    a.emit({"type": "capture", "phase": "processing"})
    if got is None:
        return None, None, False
    _, frames = rec.process(*got)
    if not frames:
        return without_none(np.full(len(CLASSES), 1.0 / len(CLASSES))), got[0][-1], False
    p = predictor.probs(features.to_seq(validate(frames)))
    return without_none(p), got[0][-1], True


START_TIMEOUT = 8.0   # no signing this long after the turn starts = the guest has nothing to say
REST_SEC = 2.5        # hands down or still this long after signing = end of the sentence
TURN_MAX_SEC = 15.0
STILL = 0.08          # wrist travel (shoulder widths) over STILL_SEC below this = still hands
STILL_SEC = 0.5
PREROLL_SEC = 0.3


def wrists(frame):
    """Normalized frame -> list of (x, y) wrist positions of the hands present."""
    if frame is None:
        return []
    return [tuple(frame[h][0][:2]) for h in ("lh", "rh") if frame[h] is not None]


REHEARSAL_LOG = Path(__file__).resolve().parent.parent / "data" / "rehearsals.jsonl"


def continuous_turn(rec, predictor, emit, expected=None, context=None):
    """The guest signs a whole sentence in one go; it ends when the hands rest for REST_SEC.
    Returns a decode_continuous result, or None when the guest did not sign."""
    emit({"type": "capture", "phase": "listening"})
    t0 = time.monotonic()
    raws, stamps, history = [], [], []
    started_at = last_active = None
    while True:
        img = rec.read()
        now = time.monotonic()
        t_ms = rec.now_ms()
        raw = detect(rec.landmarker, cv2.cvtColor(img, cv2.COLOR_BGR2RGB), t_ms)
        raws.append(raw)
        stamps.append(t_ms)
        state = "Your turn: sign when ready" if started_at is None else "SIGNING... rest your hands to finish"
        show(img, [state], RED if started_at is not None else WHITE)
        w = wrists(normalize(raw))
        history = [(t, ws) for t, ws in history if now - t <= STILL_SEC] + [(now, w)]
        old = history[0][1]
        if not w:
            moving = False                      # hands down, out of the picture
        elif len(history) < 2 or len(old) != len(w):
            moving = True                       # a hand just came in (or left)
        else:
            travel = max(abs(x - ox) + abs(y - oy) for (x, y), (ox, oy) in zip(sorted(w), sorted(old)))
            moving = travel > STILL
        if moving:
            if started_at is None:
                started_at = now
                emit({"type": "capture", "phase": "signing"})
            last_active = now
        if started_at is None and now - t0 > START_TIMEOUT:
            return None
        if started_at is not None and (now - last_active > REST_SEC or now - started_at > TURN_MAX_SEC):
            break
    emit({"type": "capture", "phase": "processing"})
    # stamps are rec.now_ms() = (monotonic - rec.t0) * 1000: keep the signing part plus a short pre-roll
    lo = (started_at - PREROLL_SEC - rec.t0) * 1000
    hi = (last_active + 0.2 - rec.t0) * 1000
    idx = [i for i, t in enumerate(stamps) if lo <= t <= hi]
    frames = clean([normalize(raws[i]) for i in idx], [stamps[i] for i in idx]) if idx else []
    if len(frames) < 10:
        return None
    probs = window_probs(frames, predictor)
    res = decode_continuous(probs, n_frames=len(frames), candidates=expected)
    # Rehearsal check: what the recognizer would have said with less help (never used for the answer).
    free = decode_continuous(probs, n_frames=len(frames))
    guided = decode_continuous(probs, n_frames=len(frames), candidates=context) if context else free
    print(f"  check: free={' '.join(free['labels'])} | question={' '.join(guided['labels'])} | answer={' '.join(res['labels'])}")
    try:
        REHEARSAL_LOG.parent.mkdir(parents=True, exist_ok=True)
        with REHEARSAL_LOG.open("a") as f:
            f.write(json.dumps({"t": time.time(), "expected": expected, "context": context, "windows": res["raw"],
                                "free": free["labels"], "question": guided["labels"], "answer": res["labels"]}) + "\n")
    except OSError:
        pass
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, help="camera index (default: first one that is not black)")
    ap.add_argument("--checkpoint", default="recognition/models/model.pt")
    ap.add_argument("--test", action="store_true", help="ask for the 22 classes in order and score them")
    ap.add_argument("--test-sentences", action="store_true", help="ask for the 20 guest sentences and score them")
    ap.add_argument("--countdown", type=float, default=1.5)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--post", default=None, metavar="URL", help="POST every event as JSON to this URL")
    ap.add_argument("--no-preview", action="store_true", help="no OpenCV window (single-screen demo)")
    ap.add_argument("--control-port", type=int, help="serve the control API and the camera preview on 127.0.0.1:PORT")
    ap.add_argument("--next-countdown", type=float, default=1.0, help="countdown before the 2nd, 3rd... sign of a turn")
    a = ap.parse_args(argv)
    if a.no_preview:            # every drawing call of the capture UI becomes a no-op
        def quiet(*_args, **_kwargs):
            time.sleep(0.001)
            return 255
        capture_ui.show = quiet
        globals()["show"] = quiet
    if a.control_port:
        serve_control(a.control_port)

    predictor = load_predictor(a.checkpoint)
    poster = Poster(a.post, os.environ.get("BRIDGE_KEY")) if a.post else None
    rec = Recorder(a.camera)
    seq = 0
    if a.control_port:          # feed the MJPEG preview from every frame the recorder reads
        camera_read = rec.read

        def read_and_share():
            img = camera_read()
            small = cv2.resize(cv2.flip(img, 1), (640, 360))
            ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if ok:
                with PREVIEW["lock"]:
                    PREVIEW["jpg"] = buf.tobytes()
            return img
        rec.read = read_and_share

    def emit(ev):
        if poster:
            poster.send(ev)
    a.emit = emit

    def finish(sentence_probs):
        r = decode(sentence_probs)
        emit({"type": "utterance", "raw": r["raw"], "labels": r["labels"], "text": r["text"], "snapped": r["snapped"]})
        return r

    try:
        if a.test:                                   # one sign at a time, scored
            results, last = [], ""
            for i, target in enumerate(CLASSES):
                title = f"Next: {target}  ({i + 1}/{len(CLASSES)})"
                key = wait_key(rec, [title, last, "SPACE sign   S skip   Q quit"])
                if key == "q":
                    break
                if key != "space":
                    continue
                p, img, _ = sign_once(rec, predictor, title, target, a)
                if p is None:
                    break
                top = top3(p)
                ok = top[0]["label"] == target
                last = f"{fmt(top[:2])}  {'OK' if ok else 'WRONG'}"
                print(f"{target:12s} -> {fmt(top)}  {'OK' if ok else 'WRONG'}")
                show(img, [title, last], GREEN if ok else RED)
                cv2.waitKey(1000)
                results.append((target, top[0]["label"], target in [t["label"] for t in top]))
            if results:
                print(f"\nscore: {sum(t == p for t, p, _ in results)}/{len(results)} right, "
                      f"{sum(t3 for *_, t3 in results)}/{len(results)} in the top 3")
            return

        if a.test_sentences:                         # guided sentences, scored raw vs corrected
            scores = []
            for n, (labels, text) in enumerate(GUEST_INTENTS):
                probs, quit_ = [], False
                for j, target in enumerate(labels):
                    title = f"Sentence {n + 1}/{len(GUEST_INTENTS)}: {' '.join(labels)}"
                    key = wait_key(rec, [title, f"sign {j + 1}/{len(labels)}: {target}", "SPACE sign   S skip   Q quit"])
                    if key == "q":
                        quit_ = True
                        break
                    if key == "s":
                        break
                    p, _, _ = sign_once(rec, predictor, title, target, a)
                    if p is None:
                        quit_ = True
                        break
                    probs.append(p)
                if quit_:
                    break
                if len(probs) != len(labels):
                    continue
                r = finish(probs)
                raw_ok, cor_ok = r["raw"] == labels, r["labels"] == labels
                print(f"{' '.join(labels):22s} raw {' '.join(r['raw']):22s} -> {' '.join(r['labels']):22s} "
                      f"{'OK' if cor_ok else 'WRONG'}{'  (fixed)' if cor_ok and not raw_ok else ''}")
                show(rec.read(), [f"{' '.join(labels)}", f"heard: {' '.join(r['raw'])}",
                                  f"-> {r['text'] or ' '.join(r['labels'])}"], GREEN if cor_ok else RED)
                cv2.waitKey(1800)
                scores.append((raw_ok, cor_ok))
            if scores:
                print(f"\nsentences right: raw {sum(r for r, _ in scores)}/{len(scores)}, "
                      f"corrected {sum(c for _, c in scores)}/{len(scores)}")
            return

        sentence, last = [], ""                      # free mode
        while True:
            heard = " ".join(CLASSES[int(np.argmax(p))] for p in sentence)
            key = wait_key(rec, [f"sentence: {heard or '...'}", last,
                                 "T your turn (continuous)   SPACE one sign   ENTER end   Q quit"])
            if key == "q":
                break
            if key == "back" and sentence:
                sentence.pop()
            elif key == "enter" and sentence:
                r = finish(sentence)
                last = f"-> {r['text'] or ' '.join(r['labels'])}"
                print(f"utterance: heard {' '.join(r['raw'])} -> {' '.join(r['labels'])}  {r['text'] or ''}")
                sentence = []
            elif key == "turn" or (isinstance(key, tuple) and key[0] == "turn"):
                expected = key[1] if isinstance(key, tuple) else None
                context = key[2] if isinstance(key, tuple) and len(key) > 2 else None
                emit({"type": "turn", "phase": "start", "expected": expected})
                print(f"guest turn (continuous){'  expected: ' + ' | '.join(' '.join(e) for e in expected) if expected else ''}")
                try:
                    res = continuous_turn(rec, predictor, emit, expected, context)
                except Exception as err:  # a failed turn must never stop the recognizer (camera feed, next turns)
                    print(f"turn failed: {err!r}")
                    res = None
                if res:
                    print(f"utterance: windows {' '.join(res['raw'])} -> {' '.join(res['labels'])}  {res['text'] or ''}")
                    emit({"type": "utterance", "raw": res["raw"], "labels": res["labels"], "text": res["text"],
                          "snapped": res["snapped"]})
                    last = f"-> {res['text'] or ' '.join(res['labels'])}"
                else:
                    print("turn: no sign")
                emit({"type": "turn", "phase": "end", "empty": not res})
            elif key == "space":
                p, _, _ = sign_once(rec, predictor, f"sentence: {heard}", None, a)
                if p is None:
                    break
                sentence.append(p)
                seq += 1
                top = top3(p)
                emit({"type": "sign", "seq": seq, "top": top})
                print(f"  sign {seq}: {fmt(top)}")
                last = fmt(top[:2])
    finally:
        if poster:
            poster.close()
        rec.close()


if __name__ == "__main__":
    sys.exit(main())

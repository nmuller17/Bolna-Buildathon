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
  POST /turn          the guest's turn, hands-free: sign windows one after another (countdown +
                      REC each, like the training takes) until a window with no hands, or MAX_TURN_SIGNS;
                      then the sentence is snapped and sent as "utterance" (or {"type": "turn",
                      "phase": "end", "empty": true} when the guest signed nothing).
                      Events: {"type": "turn", "phase": "start"}, capture/sign events, utterance, turn end.
  POST /sign, /end, /undo   manual control (one sign, end of sentence, drop last sign)
"""
import argparse
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
from recognition.intents import GUEST_INTENTS, decode, without_none
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
                                 "SPACE sign   ENTER end sentence   BACKSPACE undo   Q quit"])
            if key == "q":
                break
            if key == "back" and sentence:
                sentence.pop()
            elif key == "enter" and sentence:
                r = finish(sentence)
                last = f"-> {r['text'] or ' '.join(r['labels'])}"
                print(f"utterance: heard {' '.join(r['raw'])} -> {' '.join(r['labels'])}  {r['text'] or ''}")
                sentence = []
            elif key == "turn":
                sentence = []
                emit({"type": "turn", "phase": "start"})
                print("guest turn")
                for k in range(MAX_TURN_SIGNS):
                    p, _, hands = sign_once(rec, predictor, "your turn", None, a,
                                            countdown=a.countdown if k == 0 else a.next_countdown)
                    if p is None or not hands:
                        break
                    sentence.append(p)
                    seq += 1
                    top = top3(p)
                    emit({"type": "sign", "seq": seq, "top": top})
                    print(f"  sign {seq}: {fmt(top)}")
                if sentence:
                    r = finish(sentence)
                    print(f"utterance: heard {' '.join(r['raw'])} -> {' '.join(r['labels'])}  {r['text'] or ''}")
                    last = f"-> {r['text'] or ' '.join(r['labels'])}"
                else:
                    print("turn: no sign")
                emit({"type": "turn", "phase": "end", "empty": not sentence})
                sentence = []
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

"""Webcam loop: camera -> HolisticLandmarker -> recognition.stream (framing gate, capture-parity
frames, Segmenter, capture.clean, Recognizer) -> events printed and, with --post, sent to the app.

    python -m recognition.live [--camera 0] [--post http://127.0.0.1:3000/api/guest/signs] [--mock]
                               [--utterance-gap 1.5] [--waist hips|none]

- MediaPipe gets the UNMIRRORED camera image at 1280x720, as capture.py records the training
  takes; only the preview is flipped. The preview shows the framing guide (head to waist).
- A reader thread keeps only the newest camera frame, stamped with its capture time, so a
  slow landmarker never works on stale frames (skipped frames are counted).
- Events (README "App bridge"): "sign" the moment each sign closes, "utterance", "framing",
  "status" (at most once a second). --post sends each one as JSON from a worker thread with a
  bounded queue (the oldest event is dropped when the app is down), timeout POST_TIMEOUT,
  header X-Bridge-Key from the BRIDGE_KEY environment variable (never printed), no redirects,
  no proxies. Every event is sent, including repeat requests; no video or landmarks ever are.
- A rolling latency summary is printed after each utterance, every SUMMARY_SEC and at exit.
Quit with q or Esc in the preview window, or Ctrl+C.
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from recognition import framing
from recognition.classify_video import add_args, import_cv2, load_landmarker, load_recognizer, make_stream, show

WIDTH, HEIGHT = 1280, 720      # capture.py's camera settings
POST_TIMEOUT = 1.0
QUEUE_MAX = 64
SUMMARY_SEC = 10.0
READ_FAIL_SEC = 2.0
LOOPBACK = ("127.0.0.1", "localhost", "::1")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None            # a redirect would carry X-Bridge-Key to another URL


class Poster:
    """POSTs events as JSON from one worker thread; send() never blocks (drop-oldest queue)."""

    def __init__(self, url, key=None, maxsize=QUEUE_MAX, timeout=POST_TIMEOUT):
        if maxsize < 1:
            raise ValueError("maxsize must be positive")
        self.url, self.key, self.timeout = url, key, timeout
        self.q = queue.Queue(maxsize)
        self.sent = self.failed = self.dropped = 0
        self._last_err = None
        self._lock = threading.Lock()
        self._closing, self._stop = threading.Event(), threading.Event()
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def send(self, event):
        with self._lock:
            if self._closing.is_set():
                self.dropped += 1
                return
            while True:
                try:
                    self.q.put_nowait(event)
                    return
                except queue.Full:
                    try:
                        self.q.get_nowait()
                        self.dropped += 1
                    except queue.Empty:
                        pass

    def close(self, timeout=2.0):
        """Drain for at most timeout seconds, then discard queued events and stop.

        An in-flight request can finish within its own POST timeout; queued events will
        not keep posting after close returns, even if the app was unavailable.
        """
        with self._lock:
            self._closing.set()
        self.thread.join(timeout)
        self._stop.set()
        while True:
            try:
                self.q.get_nowait()
                self.dropped += 1
            except queue.Empty:
                break

    def _run(self):
        while not self._stop.is_set():
            try:
                ev = self.q.get(timeout=0.05)
            except queue.Empty:
                if self._closing.is_set():
                    return
                continue
            if self._stop.is_set():
                self.dropped += 1
                return
            self._post(ev)

    def _post(self, ev):
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["X-Bridge-Key"] = self.key
        req = urllib.request.Request(self.url, data=json.dumps(ev, separators=(",", ":")).encode(),
                                     method="POST", headers=headers)
        try:
            with self._opener.open(req, timeout=self.timeout):
                pass  # Only the response status is needed; do not buffer the response body.
            self.sent += 1
        except Exception as e:  # the app being down must never stop recognition
            self.failed += 1
            now = time.monotonic()
            if self._last_err is None or now - self._last_err >= 5:
                self._last_err = now
                why = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__
                print(f"  post failed ({why}; {self.failed} failed so far)", file=sys.stderr)


class CameraReader:
    """Reads the camera in a thread; get() returns the newest (bgr, capture time), skipping older ones."""

    def __init__(self, cap, clock=time.monotonic):
        self.cap, self.clock = cap, clock
        self.cond = threading.Condition()
        self.latest, self.n, self.taken, self.skipped = None, 0, 0, 0
        self.done = self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        fail_since = None
        while not self._stop:
            ok, img = self.cap.read()
            t = self.clock()
            if not ok:
                fail_since = t if fail_since is None else fail_since
                if t - fail_since >= READ_FAIL_SEC:
                    break
                time.sleep(0.05)
                continue
            fail_since = None
            with self.cond:
                self.latest, self.n = (img, t), self.n + 1
                self.cond.notify()
        with self.cond:
            self.done = True
            self.cond.notify()

    def get(self, timeout=READ_FAIL_SEC + 1):
        with self.cond:
            self.cond.wait_for(lambda: self.n > self.taken or self.done, timeout)
            if self.n == self.taken:
                return None
            self.skipped += self.n - self.taken - 1
            self.taken = self.n
            return self.latest

    def stop(self):
        self._stop = True
        self.thread.join(1.0)


def draw_guide(cv2, view, status, line2=""):
    """Guide box (the framing margin) and guidance text on the mirrored preview."""
    h, w = view.shape[:2]
    m = framing.MARGIN
    color = (80, 220, 80) if status == framing.OK else (0, 165, 255)
    cv2.rectangle(view, (int(m * w), int(m * h)), (int((1 - m) * w), int((1 - m) * h)), color, 3)
    for i, text in enumerate([framing.GUIDANCE.get(status, status), line2]):
        if text:
            y = int(m * h) + 40 + 40 * i
            cv2.putText(view, text, (int(m * w) + 15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 5, cv2.LINE_AA)
            cv2.putText(view, text, (int(m * w) + 15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2, cv2.LINE_AA)
    return view


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=WIDTH, help=f"camera width (default {WIDTH}, as capture.py)")
    ap.add_argument("--height", type=int, default=HEIGHT, help=f"camera height (default {HEIGHT}, as capture.py)")
    ap.add_argument("--post", default=None, metavar="URL", help="POST every event as JSON to this http(s) URL")
    ap.add_argument("--no-preview", action="store_true", help="no window (stop with Ctrl+C)")
    add_args(ap)
    args = ap.parse_args(argv)
    if args.post and urlparse(args.post).scheme not in ("http", "https"):
        sys.exit("--post needs an http:// or https:// URL")
    if args.post and urlparse(args.post).scheme == "http" and urlparse(args.post).hostname not in LOOPBACK:
        print("WARNING: --post over plain http to another machine sends X-Bridge-Key unencrypted", file=sys.stderr)
    cv2 = import_cv2()
    rec, state = load_recognizer(args, allow_missing=True)
    landmarker = load_landmarker(args)
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        sys.exit(f"cannot open camera {args.camera} (on macOS, allow camera access for the terminal)")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    cap.set(cv2.CAP_PROP_FPS, 30)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if w * HEIGHT != h * WIDTH:
        print(f"WARNING: camera gives {w}x{h}; training captures are {WIDTH}x{HEIGHT} (16:9). "
              "Landmarks are aspect-corrected, but the field of view differs.", file=sys.stderr)
    stream = make_stream(rec, (w, h), args, clock=time.monotonic, time_offset=time.time() - time.monotonic())
    poster = Poster(args.post, os.environ.get("BRIDGE_KEY") or None) if args.post else None
    reader = CameraReader(cap)
    status_line, last_summary = "", time.monotonic()
    print(f"camera {args.camera}: {w}x{h}, recognizer {state}, waist={args.waist}"
          + (f", posting events to {args.post}" if poster else "") + "; sign when ready")
    try:
        while True:
            got = reader.get()
            if got is None:
                print("camera stopped sending frames", file=sys.stderr)
                break
            bgr, t = got
            events = stream.detect(landmarker, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t)
            st = stream.status_event(state)
            for ev in events + ([st] if st else []):
                show(ev, args.json)
                if poster:
                    poster.send(ev)
                if ev["type"] == "sign":
                    status_line = f"{ev['top'][0]['label']} {ev['top'][0]['conf']:.2f}"
            now = time.monotonic()
            if any(ev["type"] == "utterance" for ev in events) or now - last_summary >= SUMMARY_SEC:
                print(stream.timings.summary(stream.fps()) + f" | {reader.skipped} camera frames skipped")
                last_summary = now
            if not args.no_preview:
                view = draw_guide(cv2, cv2.flip(bgr, 1), stream.status, status_line)   # mirror only the preview
                cv2.imshow("recognition (preview is mirrored)", view)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        reader.stop()
        cap.release()
        landmarker.close()
        if poster:
            poster.close()
        if not args.no_preview:
            cv2.destroyAllWindows()
        print(stream.timings.summary(stream.fps()))


if __name__ == "__main__":
    main()

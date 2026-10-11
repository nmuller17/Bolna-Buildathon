"""Webcam loop: camera -> HolisticLandmarker -> recognition.stream (framing gate, capture-parity
frames, Segmenter, capture.clean, Recognizer) -> events printed and, with --post, sent to the app.

    python -m recognition.live [--camera 0] [--post http://127.0.0.1:3000/api/guest/signs] [--mock]
                               [--utterance-gap 1.5] [--waist hips|none]

- MediaPipe gets the UNMIRRORED camera image at 1280x720, as capture.py records the training
  takes; only the preview is flipped. The preview shows the framing guide (head to waist).
- A reader thread keeps only the newest camera frame, stamped with its capture time, so a
  slow landmarker never works on stale frames (skipped frames are counted).
- Events (README "App bridge"): "sign" the moment each sign closes, "utterance", "framing",
  "status" (at most once a second). --post sends them as JSON from a worker thread (Poster):
  sign, utterance and every other event type in order first, plain framing and status
  coalesced to the newest, events older than STALE_SEC dropped, header X-Bridge-Key from the
  BRIDGE_KEY environment variable (never printed; a key that is set must have at least
  BRIDGE_KEY_MIN characters, else the program refuses to start), no redirects, no proxies.
  Every utterance is sent, including repeat requests; no video or landmarks ever are.
- --post accepts only a loopback URL (127.0.0.1, ::1, localhost), where the app runs (red-team A4).
  Another host needs --post-allow-remote AND https://; Poster itself refuses a non-loopback URL
  without that opt-in, so a mistyped or planted URL cannot collect BRIDGE_KEY or the events.
  live_key.py and live_window.py use the same checks through bridge_poster().
- A rolling latency summary is printed after each utterance, every SUMMARY_SEC and at exit.
Quit with q or Esc in the preview window, or Ctrl+C.
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from urllib.parse import urlparse

from recognition import framing
from recognition.classify_video import add_args, import_cv2, load_landmarker, load_recognizer, make_stream, show

WIDTH, HEIGHT = 1280, 720      # capture.py's camera settings
POST_TIMEOUT = 1.0             # queued (in-order) events: sign, utterance, rejected-sign framing, capture
LIGHT_TIMEOUT = 0.3            # coalesced framing and status
STALE_SEC = 5.0                # an event waiting longer than this is not sent
QUEUE_MAX = 64
BRIDGE_KEY_MIN = 32            # = web/lib/app/types.ts LIMITS.bridgeKeyMinLen
SUMMARY_SEC = 10.0
READ_FAIL_SEC = 2.0
LOOPBACK = ("127.0.0.1", "localhost", "::1")
COALESCED = ("framing", "status")   # state events: only the newest one matters


def is_loopback_url(url):
    """True when the URL's host is this machine (localhost, 127.0.0.0/8, ::1). urlparse resolves
    userinfo tricks such as http://127.0.0.1@evil.example/ to their real host (evil.example)."""
    import ipaddress
    try:
        host = urlparse(url).hostname
    except ValueError:
        return False
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_post_url(url, allow_remote=False):
    """None when a --post URL is acceptable, else why it is refused (red-team A4)."""
    try:
        scheme = urlparse(url).scheme
    except ValueError:
        return "--post URL cannot be parsed"
    if scheme not in ("http", "https"):
        return "--post needs an http:// or https:// URL"
    if is_loopback_url(url):
        return None
    if not allow_remote:
        return ("--post only sends to this laptop (127.0.0.1, ::1 or localhost), where the app runs; "
                "for another host pass --post-allow-remote with an https:// URL")
    if scheme != "https":
        return "--post to another host must use https:// (X-Bridge-Key would cross the network in clear text)"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None            # a redirect would carry X-Bridge-Key to another URL


class Poster:
    """POSTs events as JSON from one worker thread; send() never blocks.

    "framing" (without rejected_seq) and "status" events are only the latest state, so they are
    coalesced; every other event ("sign", "utterance", a framing event with rejected_seq,
    live_key.py's "capture") goes into a FIFO of at most maxsize (the oldest is dropped when
    full) and is always sent first, in order. The coalesced events: only the newest of each type waits, and it is sent only when the FIFO
    is empty, with the shorter light_timeout. An event still waiting stale_sec after it was
    queued is dropped (counted in .stale). Each body gets "t_sent" (Unix seconds) when it goes out.
    """

    def __init__(self, url, key=None, maxsize=QUEUE_MAX, timeout=POST_TIMEOUT, light_timeout=LIGHT_TIMEOUT,
                 stale_sec=STALE_SEC, clock=time.monotonic, allow_remote=False):
        if maxsize < 1:
            raise ValueError("maxsize must be positive")
        why = check_post_url(url, allow_remote)
        if why:   # red-team A4: BRIDGE_KEY and the event stream go to this laptop only
            raise ValueError(why)
        self.url, self.key, self.maxsize, self.clock = url, key, maxsize, clock
        self.timeout, self.light_timeout, self.stale_sec = timeout, light_timeout, stale_sec
        self.events, self.latest = deque(), {}         # (t queued, event); latest: type -> (t, event)
        self.sent = self.failed = self.dropped = self.stale = self.coalesced = 0
        self.first_status = None                       # HTTP status (or error name) of the first answer
        self._last_err = None
        self.cond = threading.Condition()
        self._closing, self._stop = threading.Event(), threading.Event()
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    @staticmethod
    def priority(ev):
        return ev.get("type") not in COALESCED or "rejected_seq" in ev

    def pending(self):
        with self.cond:
            return len(self.events) + len(self.latest)

    def send(self, event):
        with self.cond:
            if self._closing.is_set():
                self.dropped += 1
                return
            item = (self.clock(), event)
            if self.priority(event):
                if len(self.events) >= self.maxsize:
                    self.events.popleft()
                    self.dropped += 1
                self.events.append(item)
            else:
                if event.get("type") in self.latest:
                    self.coalesced += 1
                self.latest[event.get("type")] = item
            self.cond.notify()

    def close(self, timeout=2.0):
        """Drain for at most timeout seconds, then discard waiting events and stop.

        An in-flight request can finish within its own POST timeout; waiting events will
        not keep posting after close returns, even if the app was unavailable.
        """
        with self.cond:
            self._closing.set()
            self.cond.notify()
        self.thread.join(timeout)
        with self.cond:
            self._stop.set()
            self.dropped += len(self.events) + len(self.latest)
            self.events.clear()
            self.latest.clear()

    def _next(self):
        if self.events:
            return self.events.popleft(), self.timeout
        for kind in list(self.latest):
            return self.latest.pop(kind), self.light_timeout
        return None

    def _run(self):
        while True:
            with self.cond:
                got = None if self._stop.is_set() else self._next()
                if got is None:
                    if self._closing.is_set() or self._stop.is_set():
                        return
                    self.cond.wait(0.05)
                    continue
            (t_queued, ev), timeout = got
            if self.clock() - t_queued > self.stale_sec:
                self.stale += 1
                continue
            self._post(ev, timeout)

    def _post(self, ev, timeout=POST_TIMEOUT):
        headers = {"Content-Type": "application/json"}
        if self.key:
            headers["X-Bridge-Key"] = self.key
        body = dict(ev, t_sent=round(time.time(), 3))
        req = urllib.request.Request(self.url, data=json.dumps(body, separators=(",", ":")).encode(),
                                     method="POST", headers=headers)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                self._first(f"HTTP {resp.status}")   # only the status is needed; the body is not read
            self.sent += 1
        except Exception as e:  # the app being down must never stop recognition
            self.failed += 1
            why = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__
            if self._first(why):
                return
            now = time.monotonic()
            if self._last_err is None or now - self._last_err >= 5:
                self._last_err = now
                print(f"  post failed ({why}; {self.failed} failed so far)", file=sys.stderr)

    def _first(self, why):
        """Print the app's answer to the first event once (a 401 means a wrong BRIDGE_KEY)."""
        if self.first_status is not None:
            return False
        self.first_status = why
        hint = " (check BRIDGE_KEY: the app must use the same key)" if why in ("HTTP 401", "HTTP 403") else ""
        ok = why.startswith("HTTP 2")
        print(f"{'' if ok else 'WARNING: '}bridge: the app answered the first event with {why}{hint}",
              file=sys.stdout if ok else sys.stderr)
        return True


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


def bridge_key_problem(key):
    """None when BRIDGE_KEY is acceptable, else why not. Unset is allowed (the app accepts keyless
    events only while its own BRIDGE_KEY is unset); a key that is set needs BRIDGE_KEY_MIN characters."""
    if key and len(key) < BRIDGE_KEY_MIN:
        return (f"BRIDGE_KEY has {len(key)} characters; use at least {BRIDGE_KEY_MIN} (e.g. openssl rand -hex 32), "
                "the same value as the app's")
    return None


def bridge_poster(url, allow_remote=False):
    """Poster for --post URL with BRIDGE_KEY from the environment, or exit with a plain reason
    (a non-loopback URL, a short key). Shared by live.py, live_key.py and live_window.py."""
    why = check_post_url(url, allow_remote)
    key = os.environ.get("BRIDGE_KEY") or None
    why = why or bridge_key_problem(key)
    if why:
        sys.exit(why)
    if not key:
        print("WARNING: BRIDGE_KEY is not set: events are sent without X-Bridge-Key (the app accepts them only "
              "while its own BRIDGE_KEY is unset)", file=sys.stderr)
    return Poster(url, key, allow_remote=allow_remote)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=WIDTH, help=f"camera width (default {WIDTH}, as capture.py)")
    ap.add_argument("--height", type=int, default=HEIGHT, help=f"camera height (default {HEIGHT}, as capture.py)")
    ap.add_argument("--post", default=None, metavar="URL", help="POST every event as JSON to this URL (loopback only)")
    ap.add_argument("--post-allow-remote", action="store_true",
                    help="allow --post to another host (https:// only; BRIDGE_KEY is sent there)")
    ap.add_argument("--no-preview", action="store_true", help="no window (stop with Ctrl+C)")
    add_args(ap)
    args = ap.parse_args(argv)
    poster = bridge_poster(args.post, args.post_allow_remote) if args.post else None   # before the camera opens
    try:
        cv2 = import_cv2()
        rec, state = load_recognizer(args, allow_missing=True)
        landmarker = load_landmarker(args)
    except BaseException:
        if poster:
            poster.close(0)
        raise
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
            print(f"bridge: {poster.sent} sent, {poster.failed} failed, {poster.dropped} dropped, "
                  f"{poster.stale} stale, {poster.coalesced} coalesced")
        if not args.no_preview:
            cv2.destroyAllWindows()
        print(stream.timings.summary(stream.fps()))


if __name__ == "__main__":
    main()

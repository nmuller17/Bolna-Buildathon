"""Webcam loop: camera -> HolisticLandmarker -> recognition.stream (framing gate, capture-parity
frames, Segmenter, capture.clean, Recognizer) -> events printed and, with --post, sent to the app.

    python -m recognition.live [--camera 0] [--post http://127.0.0.1:3000/api/guest/signs] [--mock]
                               [--utterance-gap 1.5] [--waist hips|none]
    python -m recognition.live --source screen --list-windows
    python -m recognition.live --source screen --window-id ID [--region x,y,w,h] [--say]

- --source screen (Option A, a guest on a Zoom / Teams / Meet / FaceTime call): the frames are
  read from a window or rectangle of this laptop's screen instead of a camera, then go through
  exactly the same pipeline (recognition/screen_source.py: options, mirroring, macOS Screen
  Recording permission). It must be told what to read (--window-id, --window-name or --region);
  the whole screen only with --whole-screen. SignBridge's own windows are never read. Start it
  only after the guest has agreed to the notice on the shared page. The preview is off by default there (it could cover the call window);
  --preview turns it on, unmirrored. --say speaks each clear utterance's fixed English sentence
  with a local macOS voice and prints captions (recognition/call_voice.py); nothing goes to the
  cloud. Captions are printed in screen mode even without --say.

- MediaPipe gets the UNMIRRORED camera image at 1280x720, as capture.py records the training
  takes; only the preview is flipped. The preview shows the framing guide (head to waist).
- A reader thread keeps only the newest camera frame, stamped with its capture time, so a
  slow landmarker never works on stale frames (skipped frames are counted).
- Events (README "App bridge"): "sign" the moment each sign closes, "utterance", "framing",
  "status" (at most once a second). --post sends them as JSON from a worker thread (Poster):
  sign and utterance events first, framing and status coalesced to the newest, events older
  than STALE_SEC dropped, header X-Bridge-Key from the BRIDGE_KEY environment variable (at
  least BRIDGE_KEY_MIN characters, else live.py refuses to start; never printed), no
  redirects, no proxies. Every utterance is sent, including repeat requests; no video or
  landmarks ever are.
- --post accepts only a loopback URL (127.0.0.1, ::1, localhost), where the app runs (red-team A4).
  Another host needs --post-allow-remote AND https://; Poster itself refuses a non-loopback URL
  without that opt-in, so a mistyped or planted URL cannot collect BRIDGE_KEY or the events.
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

from recognition import call_voice, framing
from recognition.classify_video import add_args, import_cv2, load_landmarker, load_recognizer, make_stream, show

WIDTH, HEIGHT = 1280, 720      # capture.py's camera settings
POST_TIMEOUT = 1.0             # sign, utterance, rejected-sign framing
LIGHT_TIMEOUT = 0.3            # coalesced framing and status
STALE_SEC = 5.0                # an event waiting longer than this is not sent
QUEUE_MAX = 64
BRIDGE_KEY_MIN = 32            # the app (LIMITS.bridgeKeyMinLen) disables the route for shorter keys
SUMMARY_SEC = 10.0
READ_FAIL_SEC = 2.0
LOOPBACK = ("127.0.0.1", "localhost", "::1")


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

    "sign", "utterance" and framing events with rejected_seq go into a FIFO of at most maxsize
    (the oldest is dropped when full) and are always sent first. Other "framing" and "status"
    events are coalesced: only the newest of each type waits, and it is sent only when the FIFO
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
        return ev.get("type") in ("sign", "utterance") or "rejected_seq" in ev

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


def _region(text):
    from recognition.screen_source import parse_region
    try:
        return parse_region(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from None


def open_screen(args):
    """ScreenSource for --source screen, or exit with a plain reason (permission, window, region)."""
    from recognition import screen_source as ss
    try:
        src = ss.ScreenSource(region=args.region, window_name=args.window_name,
                              fps=ss.DEFAULT_FPS if args.fps is None else args.fps, mirror=args.mirror,
                              window_id=args.window_id, whole_screen=args.whole_screen)
    except (ss.ScreenPermissionError, ss.ScreenSourceError, ValueError) as e:
        sys.exit(str(e))
    for warning in ss.warnings_for(src.size):
        print(warning, file=sys.stderr)
    return src


def make_speaker(args):
    try:
        return call_voice.Speaker(voice=args.say_voice, engine=args.say_engine)
    except RuntimeError as e:
        sys.exit(str(e))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=WIDTH, help=f"camera width (default {WIDTH}, as capture.py)")
    ap.add_argument("--height", type=int, default=HEIGHT, help=f"camera height (default {HEIGHT}, as capture.py)")
    ap.add_argument("--post", default=None, metavar="URL", help="POST every event as JSON to this http(s) URL")
    ap.add_argument("--post-allow-remote", action="store_true",
                    help="allow --post to another host (https:// only; BRIDGE_KEY is sent there)")
    ap.add_argument("--no-preview", action="store_true", help="no window (stop with Ctrl+C)")
    scr = ap.add_argument_group("screen source (a guest in a video call; recognition/screen_source.py)")
    scr.add_argument("--source", choices=["camera", "screen"], default="camera",
                     help="camera (default) or screen: read the guest's video tile from this screen")
    scr.add_argument("--window-id", type=int, default=None, metavar="ID",
                     help="read exactly this window (first column of --list-windows); the safest choice")
    scr.add_argument("--window-name", default=None, metavar="NAME",
                     help="the one on-screen window whose app or title contains NAME (zoom.us, Microsoft Teams, "
                          "FaceTime); refuses when several match")
    scr.add_argument("--whole-screen", action="store_true",
                     help="read the whole main display (includes the avatar page, self-view, notifications)")
    scr.add_argument("--region", type=_region, default=None, metavar="X,Y,W,H",
                     help="screen rectangle in points; with --window-name, relative to that window (one tile)")
    scr.add_argument("--list-windows", action="store_true", help="print the on-screen windows and exit")
    scr.add_argument("--fps", type=float, default=None,
                     help="screen frames per second (default 20; MediaPipe takes about 33 ms per frame)")
    scr.add_argument("--mirror", action="store_true", help="flip each screen frame (the tile shows a mirror image)")
    scr.add_argument("--preview", action="store_true", help="screen source: show the (unmirrored) preview window")
    scr.add_argument("--say", action="store_true",
                     help="speak each clear utterance's English sentence with a local macOS voice and print captions")
    scr.add_argument("--say-voice", default=None, metavar="VOICE", help="macOS voice for --say (say -v '?' lists them)")
    scr.add_argument("--say-engine", choices=["auto", "appkit", "say"], default="auto",
                     help="auto (default): a warm macOS speech synthesizer (pyobjc AppKit), else the 'say' command")
    add_args(ap)
    args = ap.parse_args(argv)
    screen = args.source == "screen"
    if args.list_windows:
        from recognition import screen_source as ss
        try:
            print(ss.format_windows(ss.quartz_windows()))
        except ss.ScreenSourceError as e:
            sys.exit(str(e))
        return
    if not screen and (args.window_name or args.window_id is not None or args.whole_screen or args.region
                       or args.mirror or args.preview or args.fps is not None):
        sys.exit("--window-id, --window-name, --whole-screen, --region, --fps, --mirror and --preview "
                 "need --source screen")
    if args.post and (why := check_post_url(args.post, args.post_allow_remote)):
        sys.exit(why)
    key = os.environ.get("BRIDGE_KEY", "")
    if args.post and len(key) < BRIDGE_KEY_MIN:
        sys.exit(f"--post needs the environment variable BRIDGE_KEY ({'unset' if not key else f'{len(key)} characters'}), "
                 f"at least {BRIDGE_KEY_MIN} characters and the same as the app's; the app rejects every event otherwise")
    cv2 = import_cv2()
    if screen:
        cap = open_screen(args)                     # fails fast (permission, window) before loading models
        w, h = cap.size
        source_name = f"screen {cap.describe()}"
    rec, state = load_recognizer(args, allow_missing=True)
    landmarker = load_landmarker(args)
    if not screen:
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
        source_name = f"camera {args.camera}: {w}x{h}"
    stream = make_stream(rec, (w, h), args, clock=time.monotonic, time_offset=time.time() - time.monotonic())
    poster = Poster(args.post, key, allow_remote=args.post_allow_remote) if args.post else None
    speaker = make_speaker(args) if args.say else None
    captions = args.say or screen
    preview = args.preview if screen else not args.no_preview
    reader = CameraReader(cap)
    status_line, last_summary = "", time.monotonic()
    print(f"{source_name}, recognizer {state}, waist={args.waist}"
          + (f", posting events to {args.post}" if poster else "") + (", speaking with a local macOS voice" if speaker else "")
          + "; sign when ready")
    try:
        while True:
            got = reader.get()
            if got is None:
                print(f"{'screen source' if screen else 'camera'} stopped sending frames", file=sys.stderr)
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
                if ev["type"] == "utterance" and captions:
                    line, sentence = call_voice.caption(ev, state)
                    print(line, flush=True)
                    if speaker and sentence:
                        speaker.speak(sentence)
            now = time.monotonic()
            if any(ev["type"] == "utterance" for ev in events) or now - last_summary >= SUMMARY_SEC:
                print(stream.timings.summary(stream.fps()) + f" | {reader.skipped} camera frames skipped")
                last_summary = now
            if preview:
                if screen:          # the remote guest as the call shows them; mirroring would confuse
                    view = draw_guide(cv2, bgr.copy(), stream.status, status_line)
                    cv2.imshow("recognition (screen source)", view)
                else:
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
        if speaker:
            speaker.close()
        if preview:
            cv2.destroyAllWindows()
        print(stream.timings.summary(stream.fps()))


if __name__ == "__main__":
    main()

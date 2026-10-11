"""Screen capture as a camera for live.py --source screen (Option A: SignBridge inside any video call).

The Deaf guest is on a Zoom, Teams, Meet or FaceTime call with the hotel laptop. Their video tile
is already on the laptop's screen, so the recognizer reads that tile instead of a webcam and runs
the same pipeline (framing gate, segmenter, Recognizer). No call platform API, no keys, no network:
pixels are read from this screen, turned into landmarks on this laptop and never saved.

    python -m recognition.live --source screen --list-windows
    python -m recognition.live --source screen --window-id 4711 [--region 0,40,960,540]
    python -m recognition.live --source screen --window-name zoom.us [--region 0,40,960,540]
    python -m recognition.live --source screen --region 100,100,1280,720 [--fps 20]

- --window-id ID: exactly that window (the first column of --list-windows). The safest choice.
- --window-name NAME: the one normal on-screen window whose owner (application) or title
  contains NAME, case-insensitive ("zoom.us", "Microsoft Teams", "FaceTime"). When more than one
  window matches (for example two Chrome windows, one with Meet and one with our own call-share
  page), it refuses and lists them with their ids: pick one with --window-id. Our own windows are
  never chosen: titles containing "SignBridge", "127.0.0.1" or "localhost", and windows of this
  Python process (the preview), are skipped by both options. If the followed window's title
  later turns into one of ours (a tab switched to the call-share page), frames stop until it
  changes back.
- Windows are found with macOS Quartz (CGWindowListCopyWindowInfo, pyobjc); the position is
  re-read every FOLLOW_SEC so moving the window is fine. Its size is fixed at start (the
  landmarker needs one image size per stream): resizing prints a warning, restart to re-measure.
  With --region as well, the region is relative to the window's top-left corner, which is how
  one participant's tile inside a gallery view is selected.
- --region x,y,w,h alone: an absolute screen rectangle in points (the coordinates of
  --list-windows and of macOS screenshots with Cmd+Shift+4). It must lie on a display.
- None of these: refused. The whole main display (our avatar page, the receptionist's self-view,
  notifications) is read only with the explicit --whole-screen.
- Frames come out as BGR uint8 arrays from read() (the same contract as cv2.VideoCapture.read),
  downscaled to at most MAX_WIDTH pixels wide, paced at --fps. live.py converts them to RGB and
  feeds MediaPipe exactly like camera frames. The framing gate and the capture-mode aspect
  scaling use this captured size, so a tile that is not 16:9 is measured correctly (a warning is
  printed, as for a webcam that is not 1280x720, because the training takes were 16:9).
- The rectangle is read from the composed screen: anything on top of it (a notification, the
  preview window, another app) is read too. Keep the call window visible and uncovered. The
  recognizer's own preview is therefore off by default in screen mode.

Mirroring: the training takes are unmirrored camera images. Zoom, Teams, Meet and FaceTime mirror
only your OWN self-view; remote participants are shown as their camera sends them (unmirrored)
unless the guest's own app flips the outgoing picture. So the default is no flip, and --mirror
flips each frame for a source that is a mirror image. Hands are assigned by the pose wrists and
the model was trained with random left/right mirroring, so a wrong choice costs little, but a
mirrored source is still not what the takes looked like. (Vendor behaviour as documented; not
yet checked on a live call.)

Permission (macOS): reading other apps' windows needs Screen Recording permission for the app
that started Python (Terminal, iTerm2, VS Code...). Without it macOS hides other apps' pixels and
window titles. ScreenSource checks CGPreflightScreenCaptureAccess first and refuses to start with
PERMISSION_HINT; when the check cannot be made it prints UNKNOWN_PERMISSION_HINT and goes on. Nothing here imports mss, Quartz or cv2 at import time (the server never needs
them).
"""
import ctypes
import os
import sys
import time
from dataclasses import dataclass

import numpy as np

DEFAULT_FPS = 20.0
MAX_FPS = 60.0
MAX_WIDTH = 1280            # capture.py records 1280x720; larger captures only slow MediaPipe
MIN_SIDE = 64               # a region smaller than this cannot hold a person
SMALL_HEIGHT = 360          # below this the guest's hands are only a few dozen pixels
FOLLOW_SEC = 1.0            # how often a window's position is re-read
TRAIN_ASPECT = 1280 / 720
INSTALL_HINT = "pip install mss pyobjc-framework-Quartz   (screen source only; the server does not need them)"
PERMISSION_HINT = (
    "macOS Screen Recording permission is missing for the app that runs Python, so other apps' "
    "windows (the video call) cannot be read.\n"
    "  Open System Settings > Privacy & Security > Screen & System Audio Recording, switch on the\n"
    "  terminal you are using (Terminal, iTerm2, Visual Studio Code...), then quit and reopen that\n"
    "  terminal (macOS applies the change only to newly started apps) and run this again.\n"
    "  Nothing is recorded or saved: frames are turned into landmarks in memory and dropped.")
UNKNOWN_PERMISSION_HINT = (
    "WARNING: could not check the macOS Screen Recording permission. If the recognizer sees nothing (frames "
    "show only the wallpaper or are black), switch it on in System Settings > Privacy & Security > "
    "Screen & System Audio Recording and restart the terminal.")
# Our own pages and windows: never read them as the guest (the avatar signs some of the guest's words).
OWN_TITLE_MARKERS = ("signbridge", "127.0.0.1", "localhost")
_CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"


class ScreenPermissionError(RuntimeError):
    """macOS Screen Recording permission is not granted."""


class ScreenSourceError(RuntimeError):
    """Bad region, window not found, or a capture library is missing."""


@dataclass(frozen=True)
class Window:
    id: int
    owner: str
    title: str
    x: int
    y: int
    w: int
    h: int
    layer: int = 0
    pid: int = 0

    @property
    def area(self):
        return self.w * self.h

    def describe(self):
        title = f' "{self.title}"' if self.title else ""
        return f"{self.id:>6}  {self.owner}{title}  at {self.x},{self.y} size {self.w}x{self.h}"


# ---------- permission ----------

def has_screen_permission():
    """True / False from CGPreflightScreenCaptureAccess (no prompt), None where it cannot be asked (not macOS)."""
    if sys.platform != "darwin":
        return None
    try:
        cg = ctypes.cdll.LoadLibrary(_CG)
        fn = cg.CGPreflightScreenCaptureAccess
    except (OSError, AttributeError):
        return None
    fn.restype = ctypes.c_bool
    return bool(fn())


def check_permission(permission=has_screen_permission, log=None):
    """Raise ScreenPermissionError with PERMISSION_HINT when permission is known to be missing; warn
    (UNKNOWN_PERMISSION_HINT) when it cannot be checked."""
    ok = permission()
    if ok is False:
        raise ScreenPermissionError(PERMISSION_HINT)
    if ok is None:
        (log or (lambda msg: print(msg, file=sys.stderr)))(UNKNOWN_PERMISSION_HINT)


# ---------- regions ----------

def parse_region(text):
    """'x,y,w,h' (integers, spaces allowed) -> (x, y, w, h); ValueError with a plain reason otherwise."""
    parts = [p.strip() for p in str(text).split(",")]
    if len(parts) != 4:
        raise ValueError(f"--region needs four numbers x,y,w,h (got {text!r})")
    try:
        x, y, w, h = (int(p) for p in parts)
    except ValueError:
        raise ValueError(f"--region needs whole numbers x,y,w,h (got {text!r})") from None
    if w < MIN_SIDE or h < MIN_SIDE:
        raise ValueError(f"--region {w}x{h} is too small: width and height must be at least {MIN_SIDE}")
    if x < 0 or y < 0:
        raise ValueError(f"--region starts at {x},{y}: x and y must be 0 or more")
    return x, y, w, h


def validate_region(region, bounds):
    """region (x, y, w, h) must lie inside bounds (bx, by, bw, bh) -> region; ValueError otherwise."""
    x, y, w, h = region
    bx, by, bw, bh = bounds
    if w < MIN_SIDE or h < MIN_SIDE:
        raise ValueError(f"region {w}x{h} is too small (at least {MIN_SIDE}x{MIN_SIDE})")
    if x < bx or y < by or x + w > bx + bw or y + h > by + bh:
        raise ValueError(f"region {x},{y} {w}x{h} is not inside {bx},{by} {bw}x{bh}")
    return region


def output_size(w, h, max_width=MAX_WIDTH):
    """Pixel size frames are delivered at: the captured size, scaled down to at most max_width wide."""
    if w <= max_width:
        return int(w), int(h)
    return int(max_width), max(1, int(round(h * max_width / w)))


# ---------- windows ----------

def parse_windows(raw):
    """CGWindowListCopyWindowInfo entries (dict-like) -> [Window], skipping entries without bounds."""
    out = []
    for d in raw or []:
        try:
            b = d.get("kCGWindowBounds") or {}
            win = Window(id=int(d.get("kCGWindowNumber", 0)), owner=str(d.get("kCGWindowOwnerName") or ""),
                         title=str(d.get("kCGWindowName") or ""), x=int(b["X"]), y=int(b["Y"]),
                         w=int(b["Width"]), h=int(b["Height"]), layer=int(d.get("kCGWindowLayer", 0)),
                         pid=int(d.get("kCGWindowOwnerPID", 0) or 0))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if d.get("kCGWindowIsOnscreen", True) is False:
            continue
        out.append(win)
    return out


def quartz_windows():
    """On-screen windows from macOS Quartz -> [Window]. Imports Quartz here (pyobjc)."""
    try:
        import Quartz
    except ImportError as e:
        raise ScreenSourceError(f"--window-name and --list-windows need pyobjc on macOS: {INSTALL_HINT}") from e
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    return parse_windows(Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID))


def is_own_window(win, own_pid=None):
    """True for SignBridge's own windows: a title with OWN_TITLE_MARKERS (the call-share page, the app)
    or a window of this process (the recognizer preview)."""
    title = win.title.lower()
    own_pid = os.getpid() if own_pid is None else own_pid
    return any(m in title for m in OWN_TITLE_MARKERS) or (win.pid != 0 and win.pid == own_pid)


def matching_windows(name, windows, own_pid=None):
    """Normal (layer 0), large enough, not our own, owner or title contains name (case-insensitive)."""
    key = name.strip().lower()
    if not key:
        return []
    return [w for w in windows if w.layer == 0 and w.w >= MIN_SIDE and w.h >= MIN_SIDE
            and not is_own_window(w, own_pid) and (key in w.owner.lower() or key in w.title.lower())]


def find_window(name, windows, own_pid=None):
    """The one window matching name (see matching_windows), or None when nothing matches.
    ScreenSourceError when several match: the caller must choose with --window-id."""
    hits = matching_windows(name, windows, own_pid)
    if len(hits) > 1:
        listing = "\n".join("  " + w.describe() for w in sorted(hits, key=lambda w: -w.area))
        raise ScreenSourceError(f"{len(hits)} windows match {name!r}; choose one with --window-id ID "
                                f"(first column):\n{listing}")
    return hits[0] if hits else None


def find_window_id(window_id, windows, own_pid=None):
    """The on-screen window with this id, or ScreenSourceError (missing, or one of our own windows)."""
    win = next((w for w in windows if w.id == int(window_id)), None)
    if win is None:
        raise ScreenSourceError(f"no on-screen window has id {window_id}; run with --list-windows "
                                "(the call window must be open, not minimized)")
    if is_own_window(win, own_pid):
        raise ScreenSourceError(f"window {window_id} is SignBridge's own window ({win.owner} {win.title!r}), "
                                "not the call; pick the call window from --list-windows")
    return win


def format_windows(windows, own_pid=None):
    rows = [w for w in windows if w.layer == 0]
    lines = [w.describe() + ("   (SignBridge's own window: never read)" if is_own_window(w, own_pid) else "")
             for w in sorted(rows, key=lambda w: (w.owner.lower(), -w.area))]
    if lines:
        lines.insert(0, "    id  app \"title\"  position and size (points); use --window-id ID")
    if rows and not any(w.title for w in rows):
        lines.append("(no window titles: macOS shows them only with Screen Recording permission; owners still match)")
    return "\n".join(lines) if lines else "(no on-screen windows found)"


# ---------- capture ----------

def mss_grabber():
    """grab(x, y, w, h) -> BGRA uint8 [H, W, 4] using mss. Imported and created on first use, in the
    thread that grabs (mss keeps per-thread handles on some platforms)."""
    try:
        import mss
    except ImportError as e:
        raise ScreenSourceError(f"--source screen needs mss: {INSTALL_HINT}") from e
    make = getattr(mss, "MSS", None) or mss.mss
    sct = make()

    def grab(x, y, w, h):
        shot = sct.grab({"left": int(x), "top": int(y), "width": int(w), "height": int(h)})
        return np.frombuffer(shot.bgra, np.uint8).reshape(shot.height, shot.width, 4)
    grab.close = sct.close
    return grab


def _monitor(index):
    try:
        import mss
    except ImportError as e:
        raise ScreenSourceError(f"--source screen needs mss: {INSTALL_HINT}") from e
    make = getattr(mss, "MSS", None) or mss.mss
    with make() as sct:
        m = sct.monitors[index]
    return m["left"], m["top"], m["width"], m["height"]


def main_display():
    """(x, y, w, h) of the main display in points (mss monitor 1)."""
    return _monitor(1)


def all_displays():
    """(x, y, w, h) bounding box of every display in points (mss monitor 0)."""
    return _monitor(0)


class ScreenSource:
    """A cv2.VideoCapture-like reader of a screen rectangle: read() -> (ok, bgr) at fps; release().

    grabber: factory () -> grab(x, y, w, h) returning BGRA or BGR uint8 (default mss_grabber); it is
    called on the first read() of the reading thread, and once more in __init__ to learn the size.
    windows: () -> [Window] (default quartz_windows), only used with window_id / window_name.
    permission: () -> True / False / None (default has_screen_permission).
    bounds: () -> (x, y, w, h) of all displays (default all_displays), checks a --region given alone.
    One of window_id, window_name, region or whole_screen=True is required."""

    def __init__(self, region=None, window_name=None, fps=DEFAULT_FPS, mirror=False, max_width=MAX_WIDTH,
                 grabber=mss_grabber, windows=quartz_windows, permission=has_screen_permission,
                 display=main_display, clock=time.monotonic, sleep=time.sleep, follow_sec=FOLLOW_SEC, log=None,
                 window_id=None, whole_screen=False, bounds=all_displays, own_pid=None):
        if not 0 < float(fps) <= MAX_FPS:
            raise ValueError(f"--fps must be above 0 and at most {MAX_FPS:g}")
        if window_id is not None and window_name:
            raise ScreenSourceError("use --window-id or --window-name, not both")
        if whole_screen and (window_id is not None or window_name or region):
            raise ScreenSourceError("--whole-screen cannot be combined with --window-id, --window-name or --region")
        if not (whole_screen or window_id is not None or window_name or region):
            raise ScreenSourceError(
                "say what to read: --window-id ID (see --list-windows), --window-name NAME or --region X,Y,W,H. "
                "The whole screen would include this page's avatar, your self-view and notifications; "
                "add --whole-screen only if you really want that.")
        self.log = log or (lambda msg: print(msg, file=sys.stderr))
        check_permission(permission, self.log)
        self.fps, self.mirror, self.max_width = float(fps), bool(mirror), int(max_width)
        self._grabber, self._windows, self.clock, self.sleep = grabber, windows, clock, sleep
        self.follow_sec, self.own_pid = follow_sec, own_pid
        self.window, self.offset = None, (0, 0)
        if window_id is not None or window_name:
            if window_id is not None:
                win = find_window_id(window_id, windows(), own_pid)
            else:
                win = find_window(window_name, windows(), own_pid)
                if win is None:
                    raise ScreenSourceError(f"no on-screen window matches {window_name!r} (SignBridge's own windows "
                                            "are skipped); run with --list-windows "
                                            "(the call window must be open, not minimized)")
            self.window, self.window_name = win, window_name
            if region:
                validate_region(region, (0, 0, win.w, win.h))
                self.offset, (w, h) = region[:2], region[2:]
            else:
                w, h = win.w, win.h
            x, y = win.x + self.offset[0], win.y + self.offset[1]
        elif region:
            validate_region(region, bounds())       # an off-screen rectangle would read nothing useful
            x, y, w, h = region
        else:                                       # whole_screen, asked for explicitly
            x, y, w, h = display()
            if w < MIN_SIDE or h < MIN_SIDE:
                raise ValueError(f"region {w}x{h} is too small")
        self.rect = [int(x), int(y), int(w), int(h)]          # screen points
        self._grab = None
        self._last_follow = clock()
        self._resized_warned = False
        self._gone = False
        self._next = None
        self.frames = 0
        probe_grab = grabber()
        try:
            probe = probe_grab(*self.rect)
        finally:
            getattr(probe_grab, "close", lambda: None)()
        ph, pw = probe.shape[:2]
        self.pixels = (pw, ph)                                 # captured pixels (Retina may double the points)
        self.size = output_size(pw, ph, self.max_width)        # delivered pixels (w, h)

    # cv2.VideoCapture-like surface used by live.py
    def isOpened(self):
        return True

    def describe(self):
        x, y, w, h = self.rect
        what = f"window {self.window.id} {self.window.owner!r}" + (f" region +{self.offset[0]},+{self.offset[1]}" if self.offset != (0, 0)
                                                    else "") if self.window else "screen region"
        return (f"{what} at {x},{y} size {w}x{h} points -> {self.size[0]}x{self.size[1]} pixels, "
                f"{self.fps:g} frames/s{', mirrored' if self.mirror else ''}")

    def _follow(self):
        """Re-read the window position; False when the window is gone (closed or minimized)."""
        if self.window is None or self.clock() - self._last_follow < self.follow_sec:
            return not self._gone
        self._last_follow = self.clock()
        now = next((w for w in self._windows() if w.id == self.window.id), None)
        if now is None:
            if not self._gone:
                self.log(f"screen source: window {self.window.owner!r} is closed or minimized")
            self._gone = True          # never read the old rectangle: something else is there now
            return False
        if is_own_window(now, self.own_pid):
            if not self._gone:
                self.log(f"screen source: window {self.window.id} now shows SignBridge's own page "
                         f"({now.title!r}); not reading it until it shows the call again")
            self._gone = True
            return False
        self._gone = False
        if (now.w, now.h) != (self.window.w, self.window.h) and not self._resized_warned:
            self._resized_warned = True
            self.log(f"WARNING: window resized from {self.window.w}x{self.window.h} to {now.w}x{now.h}; still reading "
                     f"a {self.rect[2]}x{self.rect[3]} rectangle at its top-left (+region). Restart to re-measure.")
        self.window = now
        self.rect[0], self.rect[1] = now.x + self.offset[0], now.y + self.offset[1]
        return True

    def read(self):
        """Wait for the next frame time, grab, convert -> (True, BGR uint8 [h, w, 3]) or (False, None)."""
        now = self.clock()
        if self._next is not None and now < self._next:
            self.sleep(self._next - now)
            now = self.clock()
        self._next = max(now, self._next or now) + 1.0 / self.fps
        if not self._follow():
            return False, None
        if self._grab is None:
            self._grab = self._grabber()
        try:
            img = self._grab(*self.rect)
        except Exception as e:  # a display change or a vanished window must not crash the loop
            self.log(f"screen source: capture failed ({type(e).__name__})")
            return False, None
        bgr = self.convert(img)
        self.frames += 1
        return True, bgr

    def convert(self, img):
        """BGRA / BGR capture -> BGR uint8 [size[1], size[0], 3], flipped if mirror."""
        img = np.asarray(img)
        if img.ndim != 3 or img.shape[2] not in (3, 4):
            raise ValueError("grabber must return an [H, W, 3 or 4] array")
        bgr = img[:, :, :3]
        if (bgr.shape[1], bgr.shape[0]) != self.size:
            import cv2
            bgr = cv2.resize(bgr, self.size, interpolation=cv2.INTER_AREA)
        if self.mirror:
            bgr = bgr[:, ::-1]
        return np.ascontiguousarray(bgr)

    def release(self):
        if self._grab is not None:
            getattr(self._grab, "close", lambda: None)()
            self._grab = None


def warnings_for(size):
    """Plain-language warnings about a captured size (w, h) -> [str]."""
    w, h = size
    out = []
    if abs(w / h - TRAIN_ASPECT) > 0.05:
        out.append(f"WARNING: the captured picture is {w}x{h} (aspect {w / h:.2f}); training takes are 16:9 (1.78). "
                   "Landmarks are aspect-corrected, but the framing differs: choose a 16:9 tile or --region.")
    if h < SMALL_HEIGHT:
        out.append(f"WARNING: the captured picture is only {h} pixels tall; make the guest's tile larger "
                   f"(at least {SMALL_HEIGHT} tall, ideally 720) or the hands will be too small for MediaPipe.")
    return out

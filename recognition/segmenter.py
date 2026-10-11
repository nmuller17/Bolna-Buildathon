"""Streaming sign segmenter (CLAUDE.md 7.2 step 2) for frames from Python MediaPipe.

    adapter = FrameAdapter(image_size=(w, h))
    seg = Segmenter(y_scale=adapter.y_scale)
    for t, frame in stream:               # t: capture time in seconds; frame: mediapipe_adapter output
        for event in seg.push(frame, t):
            if event[0] == "sign":
                top = recognizer.predict(event[1])
            else:                         # ("utterance_end",)
                ...
    seg.flush()                           # end of a video: close what is still open

A sign event is a SignEvent: still the tuple ("sign", frames), plus .times (capture time of
each frame), .tags (whatever was passed as push(..., tag=)), .t_start (first frame), .t_end
(last frame that was still moving) and .t_close (capture time of the frame that closed it).
recognition.stream builds on this (cleaning, framing gate, timestamps).

Time: pass each frame's capture time t (seconds, increasing). Speeds are displacement per
elapsed second and every *_SEC rule is in seconds, so a landmarker running slower than the
camera changes nothing. Without t, frame i is taken to be at i / fps.

Units: shoulder widths from the shoulder midpoint, y down (CLAUDE.md 6.2). MediaPipe divides
y by the image height, so without aspect correction a normalized y is stretched by
width / height; y_scale = height / width undoes that (FrameAdapter.y_scale gives the right
value), so the thresholds below are real shoulder widths whatever the camera.

Signing area: a hand counts when it is present and its wrist (point 0) lies in the box
|x| <= AREA_HALF_WIDTH, AREA_TOP <= y <= AREA_BOTTOM (about the navel; the hips are often out
of frame at a desk, and MediaPipe then still invents pose 23/24).

Motion of a hand in the area, in shoulder widths per second: its points are smoothed
(exponential average with time constant SMOOTH_SEC), then compared with the oldest frame
of the last MOTION_SEC in which that hand was in the area, at least MIN_MOTION_SEC old.
It is the larger of travel (mean xy displacement of the 21 points) and shape (mean change of
the five fingertip-to-wrist distances: NO, fingerspelling). The frame's motion is the
faster hand. Smoothing and the lag keep landmark jitter below the thresholds (real
MediaPipe jitter on a still person: about 0.01 shoulder widths per frame; tests use 0.03).

Rules (all thresholds are named constants below):
- a sign starts when a hand in the area moves faster than START_SPEED (up to PREROLL
  earlier frames are included), or already when a hand enters the area after none was in
  it for MOTION_SEC; a sign that never exceeds START_SPEED is discarded;
- an idle frame has no hand in the area or motion below PAUSE_SPEED; a sign closes after
  CLOSE_SEC of idle frames (hands pause, drop or disappear), trimmed to TAIL_KEEP of them;
- a closed sign whose movement (start to the last non-idle frame, without the pre-roll)
  is shorter than MIN_SIGN_SEC, or whose hands travelled less than MIN_PATH, is discarded
  (jitter, twitches);
- a sign reaching max_frames (the server's limit) is force-closed and sent;
- after at least one sign, the utterance ends after UTTERANCE_SEC with no hand in the area,
  or REST_UTTERANCE_SEC of idle frames (hands resting still inside the area).
Segmenter(close_sec=, utterance_sec=) override CLOSE_SEC and UTTERANCE_SEC (latency knobs; the
resting-hands rule scales with utterance_sec: REST_UTTERANCE_SEC * utterance_sec / UTTERANCE_SEC);
max_sec force-closes a sign that lasts that long (recognition.stream uses it so a cleaned
segment resampled to 30 frames/s stays within the server's MAX_FRAMES).
The thresholds are first guesses, checked on synthetic streams and on GISLR clips (cut
tightly to the sign, unknown aspect ratio; tests/test_segmenter_gislr.py), not on our own
webcam takes. Re-tune them on the first real takes (classify_video --trace prints the
per-frame motion) before freezing.
"""
from collections import deque

import numpy as np

from recognition.recognizer import MAX_FRAMES

AREA_HALF_WIDTH = 2.0
AREA_TOP = -3.0
AREA_BOTTOM = 1.0
SMOOTH_SEC = 0.065       # new-frame weight 0.4 at 30 frames/s
MOTION_SEC = 0.17        # 5 frames at 30 frames/s
MIN_MOTION_SEC = 0.09    # 3 frames at 30 frames/s
START_SPEED = 0.5
PAUSE_SPEED = 0.3
CLOSE_SEC = 0.5
PREROLL = 6
TAIL_KEEP = 3
MIN_SIGN_SEC = 0.25
MIN_PATH = 0.2
UTTERANCE_SEC = 1.5
REST_UTTERANCE_SEC = 3.0
HANDS = ("lh", "rh")
TIPS = [4, 8, 12, 16, 20]
EPS = 1e-6


def hands_in_area(frame, y_scale=1.0):
    """{"lh"/"rh": float [21, 3]} (y multiplied by y_scale) for the hands present whose wrist is in the area."""
    out = {}
    for side in HANDS:
        pts = frame.get(side) if isinstance(frame, dict) else None
        if pts is None:
            continue
        try:
            a = np.array(pts, dtype=np.float64)
        except (TypeError, ValueError):
            continue
        if a.shape != (21, 3) or not np.isfinite(a).all():
            continue
        a[:, 1] *= y_scale
        x, y = a[0, 0], a[0, 1]
        if abs(x) <= AREA_HALF_WIDTH and AREA_TOP <= y <= AREA_BOTTOM:
            out[side] = a
    return out


def hand_motion(cur, prev, dt):
    """Shoulder widths per second between two [21, 3] hands dt seconds apart: max(travel, shape)."""
    travel = np.linalg.norm(cur[:, :2] - prev[:, :2], axis=1).mean()
    reach = [np.linalg.norm(h[TIPS, :2] - h[0, :2], axis=1) for h in (cur, prev)]
    shape = np.abs(reach[0] - reach[1]).mean()
    return max(travel, shape) / dt


class SignEvent(tuple):
    """("sign", frames) with the frames' capture times and tags (see the module docstring)."""

    def __new__(cls, frames, times, tags, t_end, t_close):
        ev = super().__new__(cls, ("sign", frames))
        ev.times, ev.tags, ev.t_start, ev.t_end, ev.t_close = times, tags, times[0], t_end, t_close
        return ev


class Segmenter:
    """push(frame, t=None, tag=None) -> list of events: SignEvent ("sign", frames) when a sign
    closes, ("utterance_end",) when the utterance ends."""

    def __init__(self, fps=30, max_frames=MAX_FRAMES, y_scale=1.0, close_sec=CLOSE_SEC,
                 utterance_sec=UTTERANCE_SEC, max_sec=None):
        self.fps = float(fps)
        self.max_frames = max_frames
        self.y_scale = float(y_scale)
        self.close_sec = float(close_sec)
        self.utterance_sec = float(utterance_sec)
        self.rest_sec = REST_UTTERANCE_SEC * self.utterance_sec / UTTERANCE_SEC
        self.max_sec = max_sec
        self.reset()

    def reset(self):
        self.n = 0
        self.t = None
        self.dt = 1.0 / self.fps
        self.before = deque(maxlen=PREROLL)
        self.hist = deque()  # (t, smoothed hands in the area) over the last MOTION_SEC
        self.active = None
        self.path = 0.0
        self.t_busy = None   # last frame with a hand in the area moving at least PAUSE_SPEED
        self.t_up = None     # last frame with a hand in the area
        self.pending = False
        self.speed = 0.0     # motion of the last frame (for tracing)

    def _motion(self, hands, t, step):
        last = self.hist[-1][1] if self.hist else {}
        w = 1 - np.exp(-step / SMOOTH_SEC)
        hands = {s: (w * a + (1 - w) * last[s] if s in last else a) for s, a in hands.items()}
        speed = 0.0
        for side, cur in hands.items():
            for t0, old in self.hist:
                if side in old:
                    if t - t0 >= MIN_MOTION_SEC - EPS:
                        speed = max(speed, hand_motion(cur, old[side], t - t0))
                    break
        self.hist.append((t, hands))
        return speed

    def push(self, frame, t=None, tag=None):
        t = self.n / self.fps if t is None else float(t)
        if self.t is not None:
            if t <= self.t:  # repeated or out-of-order time: one frame interval later
                t = self.t + self.dt
            self.dt = 0.8 * self.dt + 0.2 * (t - self.t)
        step = 0.0 if self.t is None else t - self.t
        self.n, self.t = self.n + 1, t
        while self.hist and t - self.hist[0][0] > MOTION_SEC + EPS:
            self.hist.popleft()
        entered = bool(self.hist) and not any(h for _, h in self.hist)
        hands = hands_in_area(frame, self.y_scale)
        speed = self.speed = self._motion(hands, t, step)
        up = bool(hands)
        busy = up and speed >= PAUSE_SPEED
        if up:
            self.t_up = t
        if busy:
            self.t_busy = t
        events = []
        if self.active is None:
            fast = up and speed > START_SPEED
            if fast or (up and entered):
                pre = list(self.before) if fast else []
                self.active = [f for f, _, _ in pre] + [frame]
                self.a_t, self.a_tag = [x for _, x, _ in pre] + [t], [g for _, _, g in pre] + [tag]
                self.pre, self.path, self.fast = len(pre), speed * self.dt, fast
                self.t_start = self.t_move = t
                self.i_move = len(self.active) - 1
                self.before.clear()
            else:
                self.before.append((frame, t, tag))
        else:
            self.active.append(frame)
            self.a_t.append(t)
            self.a_tag.append(tag)
            self.path += speed * step
            self.fast = self.fast or speed > START_SPEED
            if busy:
                self.t_move, self.i_move = t, len(self.active) - 1
            if t - self.t_move >= self.close_sec - EPS:
                events += self._close(t)
            elif len(self.active) >= self.max_frames or (self.max_sec and t - self.a_t[0] >= self.max_sec - EPS):
                self.t_move, self.i_move = t, len(self.active) - 1
                events += self._close(t)
        if self.pending and (t - self.t_up >= self.utterance_sec - EPS or t - self.t_busy >= self.rest_sec - EPS):
            self.pending = False
            events.append(("utterance_end",))
        return events

    def _close(self, t_close):
        k = self.i_move + 1 + TAIL_KEEP
        frames, times, tags = self.active[:k], self.a_t[:k], self.a_tag[:k]
        moving = self.t_move - self.t_start + self.dt
        self.active, path, self.path = None, self.path, 0.0
        if not self.fast or moving < MIN_SIGN_SEC - EPS or path < MIN_PATH:
            return []
        self.pending = True
        return [SignEvent(frames, times, tags, self.t_move, t_close)]

    def flush(self):
        """End of stream: close an open sign (same guards) and end a pending utterance."""
        events = self._close(self.t) if self.active is not None else []
        if self.pending:
            events.append(("utterance_end",))
        self.reset()
        return events

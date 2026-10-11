"""One camera (or video) stream -> app events with timestamps (README "App bridge").

    stream = SignStream(Recognizer(), image_size=(w, h))   # recognizer=None: no predictions
    for rgb, t in camera:                                  # UNMIRRORED RGB, capture time in s
        for event in stream.detect(landmarker, rgb, t):    # runs MediaPipe and times it
            send(event)                                    # JSON-ready dicts
    stream.flush()                                         # end of a video file

Per frame: framing.check on the raw result; FrameAdapter(mode="capture") (frames identical to
capture.py's); Segmenter.push(frame, t). When a sign closes, its extent is matched to a
capture.py take: a take keeps every frame with a hand visible (clean.trim), so the segment is
extended over the contiguous hand-visible frames just before it (at most CONTEXT_BEFORE_SEC,
never into the previous sign) and just after it (up to the frame that closed it; no added
delay). It is classified only if at least framing.MIN_OK_FRACTION of its frames were framed
OK; it is then cleaned with capture.clean.clean(frames, capture times in ms), exactly as
capture.py cleans a training take, and Recognizer.predict gives a "sign" event at once. The end of an utterance
gives an "utterance" event whose needs_repeat is recognizer.needs_repeat (the app's 0.6 / NONE
rule); a sign rejected for framing stands in it as {"label": "NONE", "conf": 0.0}, so the
utterance always asks for a repeat. An utterance that reaches MAX_UTTERANCE_SIGNS signs is
ended at once (the app's LIMITS.maxSigns is 8); the next signs start a new one. NO_PERSON
within FAR_MEMORY_SEC of a COME_CLOSER frame is reported as COME_CLOSER (a person too far
away for MediaPipe is still standing there). A framing status held for FRAMING_HOLD_SEC gives a
"framing" event when it changes. status_event() gives a "status" event at most once per
STATUS_EVERY_SEC.

Times: t is the capture time on the stream's clock (time.monotonic for a camera); t_closed and
t_predicted are read from that clock when the segmenter decided and when the prediction was
ready, so t_predicted - t_sign_end is the true end-to-end delay from the last moving frame.
Every time in an event is clock + time_offset (live.py passes time.time() - time.monotonic(),
so events carry Unix seconds), rounded to the millisecond.
"""
import time
from collections import deque

import numpy as np

from recognition import framing, mediapipe_adapter as mpa
from recognition.labels import NONE
from recognition.recognizer import MAX_FRAMES, needs_repeat
from recognition.segmenter import CLOSE_SEC, UTTERANCE_SEC, Segmenter

CLEAN_FPS = 30              # capture.clean.FPS
CONTEXT_BEFORE_SEC = 0.5    # a 2 s take around a ~1 s sign leaves about this much hand-visible lead-in
FRAMING_HOLD_SEC = 0.5
FAR_MEMORY_SEC = 3.0
MAX_UTTERANCE_SIGNS = 8     # web/lib/app/types.ts LIMITS.maxSigns
STATUS_EVERY_SEC = 1.0
FPS_WINDOW_SEC = 2.0
TIMING_WINDOW = 300
LABELS = {"mediapipe_ms": "MediaPipe", "predict_ms": "predict", "close_ms": "close delay", "total_ms": "total"}


class Timings:
    """Rolling samples (last TIMING_WINDOW of each) -> p50 / p95 summary."""

    def __init__(self, window=TIMING_WINDOW):
        self.window = window
        self.data = {}

    def add(self, key, value):
        self.data.setdefault(key, deque(maxlen=self.window)).append(float(value))

    def pct(self, key):
        a = self.data.get(key)
        return (float(np.percentile(a, 50)), float(np.percentile(a, 95)), len(a)) if a else None

    def summary(self, fps=None):
        parts = []
        for key, name in LABELS.items():
            p = self.pct(key)
            unit = " ms/frame" if key == "mediapipe_ms" else " ms"
            parts.append(f"{name} {p[0]:.0f}/{p[1]:.0f}{unit}" if p else f"{name} -")
        rate = f" | {fps:.1f} frames/s" if fps else ""
        return "latency p50/p95: " + " | ".join(parts) + rate


class FileClock:
    """Clock for a video file: the frame's video time plus the processing time since it was handed
    over, i.e. the delays a live camera would see if the machine keeps up with the frame rate."""

    def __init__(self):
        self.t, self.wall = 0.0, time.perf_counter()

    def frame(self, t):
        self.t, self.wall = float(t), time.perf_counter()

    def __call__(self):
        return self.t + time.perf_counter() - self.wall


class SignStream:
    def __init__(self, recognizer, image_size, *, waist="hips", gate=True, min_ok=framing.MIN_OK_FRACTION,
                 utterance_gap=UTTERANCE_SEC, sign_gap=CLOSE_SEC, fps=30, mode="capture", aspect_correct=False,
                 minimize=True, clock=time.monotonic, time_offset=0.0):
        if waist not in ("hips", "none"):
            raise ValueError("waist must be 'hips' or 'none'")
        self.rec, self.waist, self.gate, self.min_ok, self.mode = recognizer, waist, gate, min_ok, mode
        self.aspect = image_size[0] / image_size[1]
        self.adapter = mpa.FrameAdapter(minimize=minimize, image_size=image_size, mode=mode,
                                        aspect_correct=aspect_correct and mode == "legacy")
        self.seg = Segmenter(fps=fps, y_scale=self.adapter.y_scale, close_sec=sign_gap, utterance_sec=utterance_gap,
                             max_sec=(MAX_FRAMES - 1) / CLEAN_FPS - CONTEXT_BEFORE_SEC - sign_gap)
        self.clock, self.offset = clock, float(time_offset)
        self.timings = Timings()
        self.seq = 0
        self.signs = []                 # (seq, top-1) of the open utterance
        self.frame = self.status = None
        self._held = (None, None)       # (status, since) being held
        self._reported = None
        self._t0, self._ts = None, -1
        self._times = deque()
        self._last_status = None
        self._hist = deque(maxlen=MAX_FRAMES + 120)   # (index, frame, t, status) of recent frames
        self._n = 0
        self._last_end = -1             # history index of the last frame given to a sign
        self._far_t = None              # capture time of the last COME_CLOSER frame

    def out(self, t):
        return round(t + self.offset, 3)

    def detect(self, landmarker, rgb, t):
        """Run the VIDEO-mode landmarker on one UNMIRRORED RGB frame captured at t, then push()."""
        if self._t0 is None:
            self._t0 = t
        self._ts = max(self._ts + 1, int(round((t - self._t0) * 1000)))
        c0 = time.perf_counter()
        result = landmarker.detect_for_video(mpa.mp_image(rgb), self._ts)
        self.timings.add("mediapipe_ms", (time.perf_counter() - c0) * 1000)
        return self.push(result, t)

    def push(self, result, t):
        """One raw MediaPipe result captured at t -> list of events."""
        self.status = self._far(framing.check(result, self.aspect, self.waist), t)
        self.frame = self.adapter(result)
        self._times.append(t)
        while self._times and t - self._times[0] > FPS_WINDOW_SEC:
            self._times.popleft()
        self._hist.append((self._n, self.frame, t, self.status))
        events = self._framing(self.status, t)
        for ev in self.seg.push(self.frame, t, tag=self._n):
            events += self._sign(ev) if ev[0] == "sign" else self._utterance()
        self._n += 1
        return events

    def flush(self):
        """End of a video: close an open sign and end the utterance."""
        events = []
        for ev in self.seg.flush():
            events += self._sign(ev) if ev[0] == "sign" else self._utterance()
        return events

    def fps(self):
        n = len(self._times)
        return (n - 1) / (self._times[-1] - self._times[0]) if n > 1 and self._times[-1] > self._times[0] else 0.0

    def status_event(self, recognizer_state):
        """{"type": "status", ...} at most once per STATUS_EVERY_SEC, else None."""
        now = self.clock()
        if self._last_status is not None and now - self._last_status < STATUS_EVERY_SEC:
            return None
        self._last_status = now
        return {"type": "status", "fps": round(self.fps(), 1), "recognizer": recognizer_state, "t": self.out(now)}

    def extent(self, ev):
        """SignEvent -> (frames, times, statuses) of the segment extended like a capture.py take."""
        first = self._hist[0][0]
        rows = [self._hist[i - first] for i in range(ev.tags[0], ev.tags[-1] + 1)]
        i, t0 = ev.tags[0] - 1, rows[0][2]
        while i > self._last_end and i >= first:
            row = self._hist[i - first]
            if not has_hand(row[1]) or t0 - row[2] > CONTEXT_BEFORE_SEC + 1e-6:
                break
            rows.insert(0, row)
            i -= 1
        i = ev.tags[-1] + 1
        while has_hand(rows[-1][1]) and i - first < len(self._hist) and has_hand(self._hist[i - first][1]):
            rows.append(self._hist[i - first])
            i += 1
        self._last_end = rows[-1][0]
        return [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows]

    def clean(self, frames, times):
        """Segment frames + capture times (s) -> frames as capture.py cleans a take (legacy mode: unchanged)."""
        if self.mode != "capture":
            return [f for f in frames if f is not None]
        _, clean = mpa.capture_modules()
        return clean.clean(list(frames), [x * 1000 for x in times])[:MAX_FRAMES]

    def _far(self, status, t):
        if status == framing.COME_CLOSER:
            self._far_t = t
        elif status != framing.NO_PERSON:
            self._far_t = None
        elif self._far_t is not None and t - self._far_t <= FAR_MEMORY_SEC:
            return framing.COME_CLOSER
        return status

    def _framing(self, status, t):
        held, since = self._held
        if status != held:
            self._held = (status, t)
            held, since = status, t
        if status != self._reported and t - since >= FRAMING_HOLD_SEC - 1e-6:
            self._reported = status
            return [{"type": "framing", "status": status, "since": self.out(since)}]
        return []

    def _sign(self, ev):
        t_closed = self.clock()
        frames, times, statuses = self.extent(ev)
        if self.gate and not framing.segment_ok(statuses, self.min_ok):
            self.seq += 1
            self.signs.append((self.seq, {"label": NONE, "conf": 0.0}))
            return [{"type": "framing", "status": framing.dominant(statuses), "since": self.out(ev.t_start),
                     "rejected_seq": self.seq}] + self._full()
        frames = self.clean(frames, times)
        if not frames or self.rec is None:
            return []
        c0 = time.perf_counter()
        try:
            top = self.rec.predict(frames)
        except ValueError:          # cannot happen with adapter output; never crash the loop
            top = [{"label": NONE, "conf": 0.0}]
        self.timings.add("predict_ms", (time.perf_counter() - c0) * 1000)
        t_pred = self.clock()
        self.timings.add("close_ms", (t_closed - ev.t_end) * 1000)
        self.timings.add("total_ms", (t_pred - ev.t_end) * 1000)
        self.seq += 1
        self.signs.append((self.seq, dict(top[0])))
        return [{"type": "sign", "seq": self.seq, "top": top, "t_sign_start": self.out(ev.t_start),
                 "t_sign_end": self.out(ev.t_end), "t_closed": self.out(t_closed),
                 "t_predicted": self.out(t_pred)}] + self._full()

    def _full(self):
        return self._utterance() if len(self.signs) >= MAX_UTTERANCE_SIGNS else []

    def _utterance(self):
        if not self.signs:
            return []
        signs = [p for _, p in self.signs]
        ev = {"type": "utterance", "signs": signs, "seqs": [s for s, _ in self.signs],
              "needs_repeat": needs_repeat(signs), "t_end": self.out(self.clock())}
        self.signs = []
        return [ev]


def has_hand(frame):
    return isinstance(frame, dict) and (frame.get("lh") is not None or frame.get("rh") is not None)


def format_top(top):
    return " | ".join(f"{p['label']} {p['conf']:.2f}" for p in top)


def describe(ev):
    """One human-readable line per event (None for status events)."""
    kind = ev["type"]
    if kind == "sign":
        return (f"  sign {ev['seq']}: {format_top(ev['top'])}  (closed {1000 * (ev['t_closed'] - ev['t_sign_end']):.0f} ms "
                f"after the last movement, predicted {1000 * (ev['t_predicted'] - ev['t_sign_end']):.0f} ms after it)")
    if kind == "utterance":
        words = " ".join(p["label"] for p in ev["signs"])
        return f"utterance: {words}" + ("  -> repeat request" if ev["needs_repeat"] else "")
    if kind == "framing":
        tail = f"; sign {ev['rejected_seq']} not classified" if "rejected_seq" in ev else ""
        return f"  framing: {ev['status']} ({framing.GUIDANCE[ev['status']]}){tail}"
    return None

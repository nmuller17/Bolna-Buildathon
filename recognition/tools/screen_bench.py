"""Speed check for live.py --source screen, without a real call and without Screen Recording permission.

    RECOGNITION_ALLOW_UNPINNED=1 python -m recognition.tools.screen_bench CLIP [--seconds 40] [--fps 20]

One process plays CLIP (looped, scaled to 1280x720, 1 s of the last frame held between repeats) in
an OpenCV window titled "SignBridge test call", standing in for the guest's video tile, and reads
that window back from the screen with recognition.screen_source in a worker thread, through the
same CameraReader -> SignStream (MediaPipe, framing gate, segmenter, Recognizer) as live.py.
macOS lets a process read its own windows without Screen Recording permission, which is why the
player is in the same process; a real call window (another app) needs the permission.

A small barcode (8 black/white squares, the frame number mod 256) is drawn in the top-left corner
of every shown frame, so each captured frame can be matched to the moment it was put on screen:
"display -> capture" is capture time minus the time cv2.imshow was called for that frame.

Prints: capture-only timing (grab + convert, unpaced), then for the paced run the frames/s
delivered and processed, display -> capture delay, MediaPipe, predict, close delay and total
(end of movement -> prediction), framing statuses seen, and the sign events. Nothing is saved.
With a synthetic model.pt the labels are meaningless: this measures plumbing and speed only.
"""
import argparse
import os
import sys
import threading
import time
from collections import Counter

import numpy as np

from recognition import mediapipe_adapter as mpa, screen_source as ss
from recognition.classify_video import load_landmarker, load_recognizer
from recognition.live import CameraReader
from recognition.stream import SignStream, describe

TITLE = "SignBridge test call"
W, H = 1280, 720
BOX, BITS = 16, 8


def draw_code(img, n):
    for b in range(BITS):
        v = 255 if (n >> b) & 1 else 0
        img[4:4 + BOX, 4 + b * BOX: 4 + (b + 1) * BOX] = v
    return img


def read_code(img):
    """Frame number mod 256 from the barcode (threshold at mid-grey; colour management shifts values)."""
    n = 0
    for b in range(BITS):
        patch = img[4 + 4: 4 + BOX - 4, 4 + b * BOX + 4: 4 + (b + 1) * BOX - 4]
        if patch.mean() > 127:
            n |= 1 << b
    return n


def pct(a):
    return f"{np.percentile(a, 50):.0f}/{np.percentile(a, 95):.0f}" if len(a) else "-"


def main(argv=None):
    import cv2
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip")
    ap.add_argument("--seconds", type=float, default=40.0)
    ap.add_argument("--fps", type=float, default=ss.DEFAULT_FPS, help="screen capture frames/s")
    ap.add_argument("--checkpoint", default=None)
    ap.add_argument("--task", default=None)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--waist", choices=["hips", "none"], default="hips")
    ap.add_argument("--no-gate", action="store_true")
    args = ap.parse_args(argv)

    frames = []
    cap = cv2.VideoCapture(args.clip)
    clip_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(cv2.resize(f, (W, H), interpolation=cv2.INTER_LINEAR))
    cap.release()
    if not frames:
        sys.exit(f"cannot read {args.clip}")
    seq = frames + [frames[-1]] * int(round(clip_fps))

    cv2.namedWindow(TITLE, cv2.WINDOW_AUTOSIZE)
    cv2.moveWindow(TITLE, 40, 40)
    shown = {}                         # code -> perf_counter time of the last imshow with that code
    n = 0

    def show_next():
        nonlocal n
        img = draw_code(seq[n % len(seq)].copy(), n % 256)
        cv2.imshow(TITLE, img)
        shown[n % 256] = time.perf_counter()
        n += 1

    for _ in range(15):                # let the window appear
        show_next()
        cv2.waitKey(30)
    win = next((w for w in ss.quartz_windows() if w.title == TITLE), None)
    if win is None:
        sys.exit("test window not found on screen")
    region = (win.w - W) // 2, win.h - H, W, H                  # below the title bar
    print(f"test window {win.describe()}; reading +{region[0]},+{region[1]} {W}x{H}")

    def source(fps, **kw):   # own window: no Screen Recording permission needed
        return ss.ScreenSource(window_name=TITLE, region=region, fps=fps, permission=lambda: True, **kw)

    # 1. capture only (pacing switched off): grab + convert per frame
    src = source(ss.MAX_FPS, sleep=lambda s: None)
    grab_ms = []
    end = time.perf_counter() + 3.0
    t_next = time.perf_counter()
    while time.perf_counter() < end:
        c0 = time.perf_counter()
        ok, _ = src.read()
        if ok:
            grab_ms.append((time.perf_counter() - c0) * 1000)
        if time.perf_counter() >= t_next:
            show_next()
            cv2.waitKey(1)
            t_next += 1 / clip_fps
    src.release()
    print(f"capture only ({W}x{H}, pixels {src.pixels[0]}x{src.pixels[1]}): grab+convert p50/p95 {pct(grab_ms)} ms, "
          f"{1000 / np.percentile(grab_ms, 50):.0f} frames/s possible from the median")

    # 2. the live pipeline at --fps, in a worker thread; the main thread keeps playing the clip
    ns = argparse.Namespace(checkpoint=args.checkpoint, mock=args.mock, task=args.task or str(mpa.DEFAULT_TASK))
    rec, state = load_recognizer(ns, allow_missing=True)
    landmarker = load_landmarker(ns)
    src = source(args.fps)
    stream = SignStream(rec, src.size, waist=args.waist, gate=not args.no_gate, clock=time.perf_counter)
    stats = {"delay": [], "statuses": Counter(), "events": [], "processed": 0}
    stop = threading.Event()

    def worker():
        reader = CameraReader(src, clock=time.perf_counter)
        try:
            while not stop.is_set():
                got = reader.get(1.0)
                if got is None:
                    break
                bgr, t = got
                code = read_code(bgr)
                if code in shown and 0 <= t - shown[code] < 2.0:
                    stats["delay"].append((t - shown[code]) * 1000)
                evs = stream.detect(landmarker, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t)
                stats["processed"] += 1
                stats["statuses"][stream.status] += 1
                stats["events"] += evs
        finally:
            stats["skipped"] = reader.skipped
            reader.stop()

    th = threading.Thread(target=worker, daemon=True)
    t0 = time.perf_counter()
    th.start()
    t_next = t0
    while time.perf_counter() - t0 < args.seconds and th.is_alive():
        now = time.perf_counter()
        if now >= t_next:
            show_next()
            t_next += 1 / clip_fps
        cv2.waitKey(max(1, int((t_next - time.perf_counter()) * 1000)))
    stop.set()
    th.join(5)
    elapsed = time.perf_counter() - t0
    src.release()
    landmarker.close()
    cv2.destroyAllWindows()
    cv2.waitKey(1)

    ev = stats["events"]
    for e in ev:
        line = describe(e)
        if line:
            print(line)
    signs = [e for e in ev if e["type"] == "sign"]
    tm = stream.timings
    print(f"\nrecognizer {state}; load average {os.getloadavg()[0]:.1f} (1 min) on {os.cpu_count()} cores")
    print(f"paced run {args.fps:g} frames/s target, {elapsed:.1f} s: {src.frames} frames captured "
          f"({src.frames / elapsed:.1f}/s), {stats['processed']} processed ({stats['processed'] / elapsed:.1f}/s), "
          f"{stats.get('skipped', 0)} skipped (landmarker slower than capture)")
    print(f"display -> capture delay p50/p95 {pct(stats['delay'])} ms ({len(stats['delay'])} frames matched)")
    print(tm.summary(stream.fps()))
    print(f"framing statuses: {dict(stats['statuses'])}; {len(signs)} sign events, "
          f"{sum(e['type'] == 'utterance' for e in ev)} utterances, "
          f"{sum('rejected_seq' in e for e in ev)} signs rejected by the framing gate")


if __name__ == "__main__":
    main()

"""Classify the signs in a video file with the live pipeline (recognition.stream): HolisticLandmarker
(VIDEO mode) -> framing gate -> capture-parity frames -> Segmenter -> capture.clean -> Recognizer.
Prints the same events as live.py and a latency summary.

    python -m recognition.classify_video clip.mp4 [--checkpoint recognition/models/model.pt] [--mock] [--json] [--trace]

Times in the events are seconds from the start of the clip; t_closed and t_predicted add the real
processing time, as if a camera delivered the frames live (valid when MediaPipe keeps up with
the clip's frame rate; a warning is printed when it does not).
--trace prints, per frame, the framing status, the segmenter's motion (shoulder widths per
second) and the wrist positions of the hands inside the signing area (shoulder widths): use it
on the first real webcam takes to re-tune the thresholds in segmenter.py.

Needs mediapipe and opencv (the server does not). The clip must show the unmirrored camera
image, as OpenCV records it; pass --unmirror for a selfie-mirrored clip.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from recognition import mediapipe_adapter as mpa
from recognition.recognizer import REPEAT_BELOW, needs_repeat  # noqa: F401  (re-exported)
from recognition.segmenter import CLOSE_SEC, UTTERANCE_SEC
from recognition.stream import FileClock, SignStream, describe, format_top  # noqa: F401


def import_cv2():
    try:
        import cv2
        import mediapipe  # noqa: F401
    except ImportError:
        sys.exit(f"mediapipe and opencv are needed here: {mpa.INSTALL_HINT}")
    return cv2


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def check_task(task):
    """Warn when capture.py's landmarker model differs from ours (frames would not match the training captures)."""
    other = Path(mpa.__file__).resolve().parent.parent / "capture" / "models" / "holistic_landmarker.task"
    if other.is_file() and Path(task).is_file() and _sha(other) != _sha(task):
        print(f"WARNING: {task} differs from capture.py's {other}: use the same .task file for capture and live",
              file=sys.stderr)


def load_recognizer(args, allow_missing=False):
    """(Recognizer or None, "ok" | "mock" | "no_model"). Exits with a hint unless allow_missing."""
    from recognition.recognizer import ModelPinError, Recognizer
    try:
        return Recognizer(args.checkpoint, mock=args.mock), ("mock" if args.mock else "ok")
    except (FileNotFoundError, ModelPinError) as e:
        hint = ("this model.pt is not the one pinned in recognition/model_pin.py (or no pin is set: pin it with "
                "python -m recognition.pin_model, or for development only set RECOGNITION_ALLOW_UNPINNED=1)"
                if isinstance(e, ModelPinError) else "train a model (python -m recognition.train) or pass --mock")
        if not allow_missing:
            sys.exit(f"{e}\n  {hint}")
        print(f"WARNING: no model ({e}); {hint}. Running without predictions.", file=sys.stderr)
        return None, "no_model"


def load(args, video=True):
    """(Recognizer, HolisticLandmarker) or exit with a hint."""
    rec, _ = load_recognizer(args)
    return rec, load_landmarker(args, video)


def load_landmarker(args, video=True):
    try:
        landmarker = mpa.load_holistic(args.task, video=video)
    except (ImportError, FileNotFoundError, mpa.TaskPinError) as e:
        sys.exit(str(e))
    check_task(args.task)
    return landmarker


def add_args(ap):
    ap.add_argument("--checkpoint", default=None, help="model.pt (default recognition/models/model.pt)")
    ap.add_argument("--task", default=str(mpa.DEFAULT_TASK), help="holistic_landmarker.task path")
    ap.add_argument("--mock", action="store_true", help="no model: the server's deterministic mock answers")
    ap.add_argument("--mode", choices=["capture", "legacy"], default="capture",
                    help="capture (default): frames and cleaning exactly as capture.py makes the training files")
    ap.add_argument("--aspect-correct", action="store_true", help="legacy mode only: scale x by width/height")
    ap.add_argument("--utterance-gap", type=float, default=UTTERANCE_SEC,
                    help=f"seconds without hands that end an utterance (default {UTTERANCE_SEC}; target 0.8-1.0 after tuning)")
    ap.add_argument("--sign-gap", type=float, default=CLOSE_SEC,
                    help=f"seconds of pause that close a sign (default {CLOSE_SEC})")
    ap.add_argument("--waist", choices=["hips", "none"], default="hips",
                    help="framing: require the hips in the picture (default); 'none' only where a counter hides them")
    ap.add_argument("--no-gate", action="store_true", help="classify every sign whatever the framing (debugging)")
    ap.add_argument("--json", action="store_true", help="print each event as JSON too")


def make_stream(rec, size, args, **kw):
    return SignStream(rec, size, waist=args.waist, gate=not args.no_gate, utterance_gap=args.utterance_gap,
                      sign_gap=args.sign_gap, mode=args.mode, aspect_correct=args.aspect_correct, **kw)


def show(ev, as_json=False):
    line = describe(ev)
    if line:
        print(line)
    if as_json:
        print("event " + json.dumps(ev, separators=(",", ":")))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--unmirror", action="store_true", help="flip each frame first (clip recorded as a mirror image)")
    ap.add_argument("--trace", action="store_true", help="print framing, motion and wrist positions per frame")
    add_args(ap)
    args = ap.parse_args(argv)
    cv2 = import_cv2()
    from recognition.segmenter import hands_in_area

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = fps if 1 <= fps <= 240 else 30.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    rec, landmarker = load(args)
    clock = FileClock()
    stream = make_stream(rec, (w, h), args, fps=fps, clock=clock)
    print(f"{args.video}: {w}x{h} at {fps:.1f} fps ({args.mode} mode, waist={args.waist})")
    n = 0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if args.unmirror:
                bgr = cv2.flip(bgr, 1)
            t = n / fps
            clock.frame(t)
            events = stream.detect(landmarker, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), t)
            if args.trace:
                wrists = " ".join(f"{s} ({a[0, 0]:+.2f}, {a[0, 1]:+.2f})"
                                  for s, a in hands_in_area(stream.frame, stream.seg.y_scale).items())
                print(f"    {t:6.2f} s  {stream.status:16s} motion {stream.seg.speed:5.2f}  {wrists or 'no hand in area'}")
            for ev in events:
                show(ev, args.json)
            n += 1
        clock.frame(n / fps)
        for ev in stream.flush():
            show(ev, args.json)
    finally:
        cap.release()
        landmarker.close()
    print(f"{n} frames read")
    print(stream.timings.summary())
    mp = stream.timings.pct("mediapipe_ms")
    if mp and mp[0] > 1000 / fps:
        print(f"WARNING: MediaPipe p50 {mp[0]:.0f} ms is slower than the clip's {1000 / fps:.0f} ms per frame: "
              "live, frames would be dropped and the delays above are optimistic")


if __name__ == "__main__":
    main()

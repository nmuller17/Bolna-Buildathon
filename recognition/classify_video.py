"""Classify the signs in a video file: HolisticLandmarker (VIDEO mode) -> mediapipe_adapter ->
Segmenter -> Recognizer. Prints each segment's top 3 and each utterance.

    python -m recognition.classify_video clip.mp4 [--checkpoint recognition/models/model.pt] [--mock] [--trace]

--trace prints, per frame, the segmenter's motion (shoulder widths per second) and the wrist
positions of the hands inside the signing area (real shoulder widths): use it on the first
real webcam takes to re-tune the thresholds in segmenter.py.

Needs mediapipe and opencv-python (the server does not). The clip must show the unmirrored
camera image, as OpenCV records it; pass --unmirror for a selfie-mirrored clip.
"""
import argparse
import sys

from recognition import mediapipe_adapter as mpa
from recognition.labels import NONE

REPEAT_BELOW = 0.6  # CLAUDE.md 7.2 step 4 (P4 applies it in the app; shown here for reference)


def import_cv2():
    try:
        import cv2
        import mediapipe  # noqa: F401
    except ImportError:
        sys.exit(f"mediapipe and opencv-python are needed here: {mpa.INSTALL_HINT}")
    return cv2


def load(args, video=True):
    """(Recognizer, HolisticLandmarker) or exit with a hint."""
    from recognition.recognizer import ModelPinError, Recognizer
    try:
        rec = Recognizer(args.checkpoint, mock=args.mock)
    except FileNotFoundError as e:
        sys.exit(f"{e}\n  train a model (python -m recognition.train) or pass --mock")
    except ModelPinError as e:
        sys.exit(f"{e}: this model.pt is not the one pinned in recognition/model_pin.py")
    try:
        landmarker = mpa.load_holistic(args.task, video=video)
    except (ImportError, FileNotFoundError) as e:
        sys.exit(str(e))
    return rec, landmarker


def format_top(top):
    return " | ".join(f"{p['label']} {p['conf']:.2f}" for p in top)


def needs_repeat(signs):
    return any(p["label"] == NONE or p["conf"] < REPEAT_BELOW for p in signs)


def add_args(ap):
    ap.add_argument("--checkpoint", default=None, help="model.pt (default recognition/models/model.pt)")
    ap.add_argument("--task", default=str(mpa.DEFAULT_TASK), help="holistic_landmarker.task path")
    ap.add_argument("--mock", action="store_true", help="no model: the server's deterministic mock answers")
    ap.add_argument("--aspect-correct", action="store_true",
                    help="scale x by width/height before normalizing (must match how the training data was made)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--unmirror", action="store_true", help="flip each frame first (clip recorded as a mirror image)")
    ap.add_argument("--trace", action="store_true", help="print the segmenter's motion and wrist positions per frame")
    add_args(ap)
    args = ap.parse_args(argv)
    cv2 = import_cv2()
    from recognition.segmenter import Segmenter, hands_in_area

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = fps if 1 <= fps <= 240 else 30.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    rec, landmarker = load(args)
    adapter = mpa.FrameAdapter(image_size=(w, h), aspect_correct=args.aspect_correct)
    seg = Segmenter(fps=fps, y_scale=adapter.y_scale)
    print(f"{args.video}: {w}x{h} at {fps:.1f} fps")
    signs, n = [], 0

    def handle(events, t):
        for ev in events:
            if ev[0] == "sign":
                top = rec.predict(ev[1])
                signs.append(top[0])
                print(f"  sign {len(signs)} (ends ~{t:.1f} s, {len(ev[1])} frames): {format_top(top)}")
            else:
                flag = "  -> would ask to repeat" if needs_repeat(signs) else ""
                print(f"utterance: {' '.join(p['label'] for p in signs)}{flag}")
                signs.clear()
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if args.unmirror:
                bgr = cv2.flip(bgr, 1)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            res = landmarker.detect_for_video(mpa.mp_image(rgb), int(n * 1000 / fps))
            frame = adapter(res)
            events = seg.push(frame, n / fps)
            if args.trace:
                wrists = " ".join(f"{s} ({a[0, 0]:+.2f}, {a[0, 1]:+.2f})" for s, a in hands_in_area(frame, seg.y_scale).items())
                print(f"    {n / fps:6.2f} s  motion {seg.speed:5.2f}  {wrists or 'no hand in area'}")
            handle(events, n / fps)
            n += 1
        handle(seg.flush(), n / fps)
    finally:
        cap.release()
        landmarker.close()
    print(f"{n} frames read")


if __name__ == "__main__":
    main()

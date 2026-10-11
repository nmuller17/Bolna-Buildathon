"""Live recognition triggered by a key, recorded exactly like the training takes.

    python -m recognition.live_key --camera 1                    # free signing
    python -m recognition.live_key --camera 1 --test             # the 22 classes in order, with a score

SPACE -> short countdown -> REC window (2 s, 3 s for FS-WIFI and PASSWORD in --test) -> the
landmarks go through capture.Recorder.process (same code as capture/train_session.py) ->
Recognizer -> the result is shown and printed. This is the most reliable live path: the model
sees windows cut exactly like its training data.
Keys: SPACE sign, S skip (test), Q quit.
"""
import argparse
import sys

import cv2

from capture.capture import GREEN, RED, Recorder, show
from recognition.labels import CLASSES
from recognition.recognizer import REPEAT_BELOW, decide, load_predictor, validate

LONG_SIGNS = {"FS-WIFI", "PASSWORD"}


def fmt(top):
    return " | ".join(f"{p['label']} {p['conf']:.2f}" for p in top)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, help="camera index (default: first one that is not black)")
    ap.add_argument("--checkpoint", default="recognition/models/model.pt")
    ap.add_argument("--test", action="store_true", help="ask for the 22 classes in order and score them")
    ap.add_argument("--countdown", type=float, default=1.5)
    ap.add_argument("--duration", type=float, default=2.0)
    a = ap.parse_args(argv)

    predictor = load_predictor(a.checkpoint)
    rec = Recorder(a.camera)
    todo = list(CLASSES) if a.test else None
    results, last = [], ""
    try:
        i = 0
        while todo is None or i < len(todo):
            target = todo[i] if todo else None
            title = f"Next: {target}  ({i + 1}/{len(todo)})" if target else "Press SPACE, then sign"
            key = rec.wait_start([title, last])
            if key == "q":
                break
            if key == "s":
                i += 1
                continue
            duration = 3.0 if target in LONG_SIGNS else a.duration
            got = rec.take(target or "SIGN", "get ready", a.countdown, duration)
            if got is None:
                break
            _, frames = rec.process(*got)
            top = decide(validate(frames), predictor) if frames else [{"label": "NONE", "conf": 0.0}]
            ok = target is None or top[0]["label"] == target
            sure = top[0]["conf"] >= REPEAT_BELOW
            verdict = ("OK" if ok and sure else "low confidence" if ok else "WRONG") if target else \
                ("" if sure else "low confidence -> repeat")
            last = f"{fmt(top[:2])}  {verdict}"
            print(f"{(target or ''):12s} -> {fmt(top)}  {verdict}")
            show(got[0][-1], [title, last], GREEN if (ok and sure) else RED)
            cv2.waitKey(1200)
            if target:
                results.append((target, top[0]["label"], top[0]["conf"]))
            i += 1
    finally:
        rec.close()
    if results:
        right = [r for r in results if r[0] == r[1]]
        sure = [r for r in right if r[2] >= REPEAT_BELOW]
        print(f"\nscore: {len(right)}/{len(results)} right, {len(sure)} right and above {REPEAT_BELOW}")
        print("wrong:", ", ".join(f"{t}->{p}" for t, p, _ in results if t != p) or "none")


if __name__ == "__main__":
    sys.exit(main())

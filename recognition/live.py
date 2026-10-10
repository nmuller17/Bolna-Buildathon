"""REFERENCE webcam loop: camera -> HolisticLandmarker -> mediapipe_adapter -> Segmenter -> Recognizer.

    python -m recognition.live [--camera 0] [--post http://localhost:3000/api/english] [--mock]

This is a reference, not the product: the landmarks teammate may replace it by calling
FrameAdapter, Segmenter and Recognizer directly from their own loop (README, "Python
MediaPipe input"). Rules it demonstrates:
- MediaPipe gets the UNMIRRORED camera frame; only the on-screen preview is flipped;
- predictions are printed; with --post, an utterance is POSTed as {"signs": [Prediction]}
  (top 1 per sign, the CLAUDE.md 6.5 /api/english request) only when it passes the CLAUDE.md
  7.2 step 4 check (every sign >= 0.6 and not NONE). Otherwise nothing is posted and a repeat
  request is printed: /api/english would turn a guess into a spoken sentence. No video or
  landmarks ever leave the process.
- each frame's capture time goes to the segmenter, so its speeds and timings stay right
  however fast the landmarker runs (camera start-up included).
Quit with q or Esc in the preview window, or Ctrl+C.
"""
import argparse
import json
import sys
import threading
import time
import urllib.request
from urllib.parse import urlparse

from recognition import mediapipe_adapter as mpa
from recognition.classify_video import REPEAT_BELOW, add_args, format_top, import_cv2, load, needs_repeat

RATE_FRAMES = 30  # report the processing rate over the first 30 frame intervals


def post(url, signs):
    """POST {"signs": [...]} in a background thread; failures are printed, never fatal."""
    def send():
        req = urllib.request.Request(url, data=json.dumps({"signs": signs}).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                print(f"  posted -> HTTP {r.status}")
        except Exception as e:
            print(f"  post failed: {type(e).__name__}: {e}", file=sys.stderr)
    t = threading.Thread(target=send, daemon=True)
    t.start()
    return t


def on_utterance(signs, url=None):
    """Print one utterance; POST it to url only if no sign needs a repeat (CLAUDE.md 7.2 step 4).
    Returns the posting thread, or None when nothing was posted."""
    words = " ".join(p["label"] for p in signs)
    if needs_repeat(signs):
        print(f"utterance: {words}  -> repeat request (a sign is NONE or below {REPEAT_BELOW}; not posted)")
        return None
    print(f"utterance: {words}")
    return post(url, list(signs)) if url else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--post", default=None, metavar="URL", help='POST {"signs": [...]} to this http(s) URL for each utterance that passes the 0.6 / NONE check')
    ap.add_argument("--no-preview", action="store_true", help="no window (stop with Ctrl+C)")
    add_args(ap)
    args = ap.parse_args(argv)
    if args.post and urlparse(args.post).scheme not in ("http", "https"):
        sys.exit("--post needs an http:// or https:// URL")
    cv2 = import_cv2()
    from recognition.segmenter import Segmenter

    rec, landmarker = load(args)
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        sys.exit(f"cannot open camera {args.camera} (on macOS, allow camera access for the terminal)")
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    adapter = mpa.FrameAdapter(image_size=(w, h), aspect_correct=args.aspect_correct)
    seg, signs, status = Segmenter(y_scale=adapter.y_scale), [], "ready"
    t0, last_ts, n = None, -1, 0
    print(f"camera {args.camera}: {w}x{h}" + (" (MOCK predictions)" if args.mock else "") + "; sign when ready")
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                print("camera read failed", file=sys.stderr)
                break
            t = time.monotonic()                                  # capture time of this frame
            t0 = t if t0 is None else t0
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)            # unmirrored: what MediaPipe must see
            ts = max(last_ts + 1, int((t - t0) * 1000))
            last_ts = ts
            frame = adapter(landmarker.detect_for_video(mpa.mp_image(rgb), ts))
            n += 1
            if n == RATE_FRAMES + 1:
                print(f"processing at {RATE_FRAMES / max(1e-3, t - t0):.1f} frames/s")
            for ev in seg.push(frame, t):
                if ev[0] == "sign":
                    top = rec.predict(ev[1])
                    signs.append(top[0])
                    status = f"{top[0]['label']} {top[0]['conf']:.2f}"
                    print(f"  sign {len(signs)}: {format_top(top)}")
                else:
                    on_utterance(signs, args.post)
                    status, signs = "ready", []
            if not args.no_preview:
                view = cv2.flip(bgr, 1)                             # mirror only the preview
                hands = "hands" if (frame["lh"] or frame["rh"]) else "no hands"
                cv2.putText(view, f"{status} ({hands})", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                cv2.imshow("recognition (preview is mirrored)", view)
                if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        landmarker.close()
        if not args.no_preview:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

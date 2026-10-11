"""Live recognition with capture-style windows: one sign at a time, cut like the training takes.

    python -m recognition.live_window --camera 1 [--post http://127.0.0.1:3000/api/guest/signs]

Why: the training takes (capture/train_session.py) are fixed windows from the moment the hands
rise into the picture until they leave it, cleaned by capture.clean. The speed-based Segmenter
(recognition.live) cuts signs differently (it splits signs with a pause, keeps parts of the
rise), so live accuracy dropped far below the benchmark although the same recorded clips are
recognized at 0.85-0.99. This loop reproduces the capture cut instead:

  1. IDLE: wait until a hand is in the picture for ARM_FRAMES frames in a row.
  2. SIGN: record from that moment until the hands have left the picture for END_SEC, or
     MAX_SEC (3 s, the longest training window), whichever comes first.
  3. Landmarks -> capture.landmarks.normalize -> capture.clean (exactly as the training takes)
     -> Recognizer -> "sign" event. NONE predictions are kept in the log but not in the sentence.
  4. The utterance ends after UTTERANCE_SEC with no hand in the picture: "utterance" event with
     the non-NONE signs; needs_repeat when there is none or one is below REPEAT_BELOW.

How to sign: hands resting below the picture (on the lap), raise them, sign, lower them out of
the picture again; one sign at a time. Same events as recognition.live (README "App bridge").
Quit with q or Esc in the preview window, or Ctrl+C.
"""
import argparse
import sys
import time

import cv2

from capture.capture import open_camera, show
from capture.clean import clean
from capture.landmarks import create_landmarker, detect, normalize
from recognition.labels import NONE
from recognition.live import bridge_poster
from recognition.recognizer import REPEAT_BELOW, load_predictor, decide, validate

WIDTH, HEIGHT = 1280, 720
ARM_FRAMES = 2          # consecutive frames with a hand before a sign starts
END_SEC = 0.3           # hands out of the picture this long = the sign is over
MAX_SEC = 3.0           # longest training window (FS-WIFI, PASSWORD)
MIN_FRAMES = 8          # shorter cleaned windows are ignored (a hand crossing the edge)
UTTERANCE_SEC = 2.0     # no hand this long after a sign = end of the sentence
GREEN, RED, WHITE, AMBER = (80, 220, 80), (60, 60, 230), (255, 255, 255), (40, 180, 230)


def has_hand(raw):
    return raw["lh"] is not None or raw["rh"] is not None


def fmt(top):
    return " | ".join(f"{p['label']} {p['conf']:.2f}" for p in top)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, help="camera index (default: first one that is not black)")
    ap.add_argument("--checkpoint", default="recognition/models/model.pt")
    ap.add_argument("--post", default=None, metavar="URL", help="POST every event as JSON to this URL")
    ap.add_argument("--utterance-gap", type=float, default=UTTERANCE_SEC)
    ap.add_argument("--video", help="read a video file instead of the camera (offline check, no window)")
    a = ap.parse_args(argv)
    poster = bridge_poster(a.post) if a.post else None   # loopback URL, BRIDGE_KEY length

    predictor = load_predictor(a.checkpoint)
    landmarker = create_landmarker()
    if a.video:
        cap = cv2.VideoCapture(a.video)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
    else:
        cap = open_camera(a.camera)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
    t0, n_read = time.monotonic(), 0

    def emit(ev):
        if poster:
            poster.send(ev)

    state, armed, raws, stamps = "idle", 0, [], []
    t_last_hand, seq, sentence, last_line = None, 0, [], ""
    print("ready: hands on your lap, raise them, sign, lower them out of the picture")
    try:
        while True:
            ok, img = cap.read()
            if not ok:
                if a.video:                       # end of the file: hands gone for good
                    img, raw_end = None, True
                else:
                    time.sleep(0.01)
                    continue
            else:
                raw_end = False
            n_read += 1
            now = t0 + n_read / fps if a.video else time.monotonic()
            if raw_end:
                if state == "idle" and not sentence:
                    break
                now += 10  # flush: close the open sign and the sentence
                img = last_img
            t_ms = (now - t0) * 1000
            raw = {"pose": None, "lh": None, "rh": None, "face": None} if raw_end else \
                detect(landmarker, cv2.cvtColor(img, cv2.COLOR_BGR2RGB), t_ms)
            last_img = img
            hand = has_hand(raw)
            if hand:
                t_last_hand = now

            if state == "idle":
                armed = armed + 1 if hand else 0
                if armed >= ARM_FRAMES:
                    state, raws, stamps, t_start = "sign", [], [], now
                elif sentence and t_last_hand and now - t_last_hand > a.utterance_gap:
                    signs = [p for p in sentence if p["label"] != NONE]
                    repeat = not signs or any(p["conf"] < REPEAT_BELOW for p in signs)
                    words = " ".join(p["label"] for p in signs) or "(nothing)"
                    print(f"utterance: {words}" + ("  -> repeat request" if repeat else ""))
                    emit({"type": "utterance", "signs": signs, "needs_repeat": repeat, "t_end": round(now - t0, 3)})
                    last_line, sentence = words + ("  (repeat?)" if repeat else ""), []
            if state == "sign" and not raw_end:
                raws.append(raw)
                stamps.append(t_ms)
            if state == "sign":
                gone = t_last_hand is not None and now - t_last_hand > END_SEC
                if gone or now - t_start > MAX_SEC:
                    frames = clean([normalize(r) for r in raws], stamps)
                    state, armed = "cooldown", 0
                    if len(frames) >= MIN_FRAMES:
                        top = decide(validate(frames), predictor)
                        seq += 1
                        sentence.append(dict(top[0]))
                        print(f"  sign {seq}: {fmt(top)}  ({len(frames)} frames, {now - t_start:.1f} s)")
                        emit({"type": "sign", "seq": seq, "top": top, "t_sign_start": round(t_start - t0, 3),
                              "t_predicted": round(time.monotonic() - t0, 3)})
                        last_line = fmt(top[:2])
            if state == "cooldown" and t_last_hand is not None and now - t_last_hand > END_SEC:
                state = "idle"        # hands left the picture: ready for the next sign

            label = {"idle": ("ready: raise your hands and sign", WHITE),
                     "sign": ("SIGNING...", RED),
                     "cooldown": ("lower your hands out of the picture", AMBER)}[state]
            if a.video:
                continue
            key = show(img, [label[0], last_line], label[1] if state != "idle" else (GREEN if not sentence else WHITE))
            if key in (ord("q"), 27):
                break
    except KeyboardInterrupt:
        pass
    finally:
        if poster:
            poster.close()
        cap.release()
        landmarker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    sys.exit(main())

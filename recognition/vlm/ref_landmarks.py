"""Extract MediaPipe landmarks from the reference videos, in the SAME format as a training take.

The training takes in data/train/<SIGN>/<person>_<n>.json were made by capture/train_session.py:
MediaPipe Holistic (VIDEO mode) on each camera frame -> capture.landmarks.normalize (shoulder
centred, shoulder-width scaled) -> capture.clean.clean (30 fps resample, trim to frames with a
hand, forward-fill, 3-frame smoothing). This script runs exactly that code on
capture/reference/<SIGN>.mp4 so a take and its reference can be compared point for point.

It imports capture/ from the p2-avatar checkout, so run it with that checkout's venv (it has
mediapipe 1.1.0 and the holistic model already downloaded):

  /Users/trehman/CamelHack-p2avatar/.venv/bin/python \
      /Users/trehman/CamelHack/recognition/vlm/ref_landmarks.py --out-dir <cache dir> [--signs ...]

Output: <out-dir>/<SIGN>.json with keys id, source, signer, fps, frames (+ qc stats).
Reference videos are 480x270; --upscale 1280 resizes frames before detection (no new detail,
but MediaPipe's hand detector finds small hands more reliably at the size the takes used).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

P2 = Path("/Users/trehman/CamelHack-p2avatar")
REF_DIR = P2 / "capture" / "reference"


def extract(path: Path, upscale: int | None = None) -> dict:
    import cv2

    sys.path.insert(0, str(P2))
    from capture.clean import clean
    from capture.landmarks import create_landmarker, detect, normalize

    cap = cv2.VideoCapture(str(path))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0) or 30.0
    lm = create_landmarker()
    raws, stamps, n = [], [], 0
    try:
        while True:
            ok, img = cap.read()
            if not ok:
                break
            if upscale and img.shape[1] < upscale:
                h, w = img.shape[:2]
                img = cv2.resize(img, (upscale, round(h * upscale / w)), interpolation=cv2.INTER_CUBIC)
            t = n * 1000.0 / fps
            raws.append(detect(lm, cv2.cvtColor(img, cv2.COLOR_BGR2RGB), t))
            stamps.append(t)
            n += 1
    finally:
        cap.release()
        lm.close()
    frames = clean([normalize(r) for r in raws], stamps)
    stats = {
        "n_video_frames": n,
        "n_pose": sum(r["pose"] is not None for r in raws),
        "n_lh": sum(r["lh"] is not None for r in raws),
        "n_rh": sum(r["rh"] is not None for r in raws),
        "n_clean_frames": len(frames),
        "upscale": upscale,
    }
    return {"id": path.stem, "source": "reference", "signer": "reference", "fps": 30,
            "frames": frames, "qc": stats}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--signs", nargs="*", default=None, help="default: every capture/reference/*.mp4")
    ap.add_argument("--upscale", type=int, default=0, help="0 = detect at native 480 px (default; 1280 gave the same hand counts within 1-2 frames)")
    a = ap.parse_args(argv)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = ([REF_DIR / f"{s}.mp4" for s in a.signs] if a.signs
             else sorted(REF_DIR.glob("*.mp4")))
    for p in paths:
        t0 = time.monotonic()
        d = extract(p, upscale=a.upscale or None)
        d["qc"]["seconds"] = round(time.monotonic() - t0, 2)
        (out / f"{p.stem}.json").write_text(json.dumps(d))
        print(json.dumps({"sign": p.stem, **d["qc"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Build the shared reference videos shown while recording: capture/reference/<SIGN>.mp4.

Source per sign: the avatar capture (data/videos/avatar/<SIGN>.mp4), else the reference
signer's first training take (data/videos/train/<SIGN>/<signer>_*.mp4). Videos are
downscaled so they can be committed and used on every teammate's laptop.

  python capture/make_references.py              # all classifier classes, signer cosme
  python capture/make_references.py --signs YES NO
"""
from pathlib import Path
import argparse
import sys

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from capture.train_session import CLASSES, REFERENCE_DIR  # noqa: E402

VIDEO_DIR = ROOT / "data" / "videos"
WIDTH = 480


def source_for(sign, signer):
    avatar = VIDEO_DIR / "avatar" / f"{sign}.mp4"
    if avatar.exists():
        return avatar
    takes = sorted((VIDEO_DIR / "train" / sign).glob(f"{signer}_*.mp4"),
                   key=lambda p: int(p.stem.rsplit("_", 1)[1]))
    return takes[0] if takes else None


def downscale(src, dst):
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    writer = None
    while True:
        ok, img = cap.read()
        if not ok:
            break
        h, w = img.shape[:2]
        img = cv2.resize(img, (WIDTH, int(h * WIDTH / w)))
        if writer is None:
            writer = cv2.VideoWriter(str(dst), cv2.VideoWriter_fourcc(*"mp4v"), fps, img.shape[1::-1])
        writer.write(img)
    cap.release()
    if writer:
        writer.release()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--signs", nargs="+", default=[s for s in CLASSES if s != "NONE"])
    p.add_argument("--signer", default="cosme")
    a = p.parse_args()
    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    for sign in a.signs:
        src = source_for(sign.upper(), a.signer)
        if src is None:
            print(f"{sign}: no source video yet")
            continue
        downscale(src, REFERENCE_DIR / f"{sign.upper()}.mp4")
        print(f"{sign}: {src.relative_to(ROOT)} -> capture/reference/{sign.upper()}.mp4")


if __name__ == "__main__":
    main()

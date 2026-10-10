"""Team training session: one sign at a time, each person records their takes in turn.

For each sign, every user records --reps takes (default 20) into data/train/<SIGN>/<user>_<n>.json,
then the session moves to the next sign. A reference video of the sign loops in the corner
(Cosme's avatar capture, or else the first training take of that sign). Takes already on disk
are counted, so a session can be stopped and restarted where it left off.

  python capture/train_session.py --users maya          # one person on their own laptop
  python capture/train_session.py --camera 1            # whole team in turn on one laptop
  python capture/train_session.py --signs YES NO --users maya cosme

Waiting screen: SPACE start   S skip this person   N next sign   Q quit
During takes:   R redo the last take   P pause (back to the waiting screen)
"""
from pathlib import Path
import argparse
import sys
import time

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from capture.capture import (  # noqa: E402
    GREEN, RED, VIDEO_DIR, Recorder, next_number, save_sign, save_video, show,
)

# Classifier classes, docs/vocabulary.md section 3.
CLASSES = ["YES", "NO", "RESERVATION", "NAME", "THANK-YOU", "WHERE", "ELEVATOR", "FS-WIFI",
           "PASSWORD", "BREAKFAST", "TIME", "TOWEL", "MORE", "FS-CHECKOUT", "LATE", "PLEASE",
           "PARKING", "TAXI", "HELP", "ROOM", "RESTAURANT", "NONE"]
LONG_SIGNS = {"FS-WIFI", "PASSWORD", "FS-CHECKOUT"}
HINTS = {
    "FS-WIFI": "fingerspell W-I-F-I in one go",
    "FS-CHECKOUT": "fingerspell C-H-E-C-K-O-U-T in one go",
    "PASSWORD": "PRIVATE then WORD in one go",
    "NONE": "NO sign: scratch, touch hair, random moves (vary!)",
}
# Cosme goes first: his first take becomes the reference video for signs without an avatar capture.
USERS = ["cosme", "maya", "roni", "thanya", "nath"]
DATA_DIR = ROOT / "data" / "train"
REFERENCE_DIR = ROOT / "capture" / "reference"  # shared reference videos, see make_references.py
INSET_WIDTH = 360


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--signs", nargs="+", default=CLASSES)
    p.add_argument("--users", nargs="+", default=USERS)
    p.add_argument("--reps", type=int, default=20)
    p.add_argument("--countdown", type=float, default=3.0, help="seconds before a person's first take")
    p.add_argument("--gap", type=float, default=1.5, help="seconds between two takes of the same person")
    p.add_argument("--camera", type=int, help="camera index (default: first one that is not black)")
    a = p.parse_args()
    a.signs = [s.upper() for s in a.signs]
    a.users = [u.lower() for u in a.users]
    return a


def count_takes(sign, user):
    return len(list((DATA_DIR / sign).glob(f"{user}_*.json")))


class Reference:
    """Looping, mirrored, downscaled reference video for a sign."""

    def __init__(self, sign):
        self.frames = []
        candidates = ([REFERENCE_DIR / f"{sign}.mp4", VIDEO_DIR / "avatar" / f"{sign}.mp4"]
                      + sorted((VIDEO_DIR / "train" / sign).glob("*.mp4")))
        for path in candidates:
            if path.exists():
                self.frames = self._load(path)
                if self.frames:
                    break
        self.t0 = time.monotonic()

    @staticmethod
    def _load(path):
        cap, frames = cv2.VideoCapture(str(path)), []
        while True:
            ok, img = cap.read()
            if not ok:
                break
            h, w = img.shape[:2]
            frames.append(cv2.flip(cv2.resize(img, (INSET_WIDTH, int(h * INSET_WIDTH / w))), 1))
        cap.release()
        return frames

    def frame(self):
        if not self.frames:
            return None
        return self.frames[int((time.monotonic() - self.t0) * 30) % len(self.frames)]


def wait(rec, lines, ref):
    """Live preview with the reference inset until SPACE, S, N or Q."""
    while True:
        key = show(rec.read(), lines + ["SPACE start  S skip person  N next sign  Q quit"], inset=ref.frame())
        if key in (ord(" "), ord("s"), ord("n"), ord("q")):
            return chr(key)


def record_person(rec, a, sign, user, duration):
    """Record the missing takes of one person. Returns 'done', 'pause' or 'quit'."""
    folder = DATA_DIR / sign
    first = True
    while (done := count_takes(sign, user)) < a.reps:
        label = f"{user}  take {done + 1}/{a.reps}"
        got = rec.take(sign, label, a.countdown if first else a.gap, duration)
        if got is None:
            return "quit"
        first = False
        _, frames = rec.process(*got)
        if not frames:
            show(got[0][-1], [sign, label, "No hands detected, again"], RED)
            cv2.waitKey(1000)
            continue
        num = next_number(folder, user)
        path = folder / f"{user}_{num}.json"
        save_sign(path, sign, "team", user, frames)
        save_video(*got, VIDEO_DIR / "train" / sign / f"{user}_{num}.mp4")
        show(got[0][-1], [sign, f"{user}  saved {done + 1}/{a.reps}", "R redo   P pause"], GREEN)
        key = cv2.waitKey(700) & 0xFF
        if key == ord("r"):
            path.unlink()
            (VIDEO_DIR / "train" / sign / f"{user}_{num}.mp4").unlink(missing_ok=True)
            first = True
        elif key == ord("p"):
            return "pause"
    print(f"{sign}: {user} done ({a.reps} takes)")
    return "done"


def summary(a):
    print("\n" + "sign".ljust(14) + "".join(u[:7].rjust(8) for u in a.users))
    for sign in a.signs:
        print(sign.ljust(14) + "".join(str(count_takes(sign, u)).rjust(8) for u in a.users))


def main():
    a = parse_args()
    rec = Recorder(a.camera)
    try:
        for si, sign in enumerate(a.signs):
            duration = 3.0 if sign in LONG_SIGNS else 2.0
            next_sign = False
            ui = 0
            while ui < len(a.users) and not next_sign:
                user = a.users[ui]
                if count_takes(sign, user) >= a.reps:
                    ui += 1
                    continue
                ref = Reference(sign)
                lines = [f"{sign}   (sign {si + 1}/{len(a.signs)}, {duration:.0f} s)",
                         f"Next: {user.upper()}  ({count_takes(sign, user)}/{a.reps} done)"]
                if sign in HINTS:
                    lines.append(HINTS[sign])
                key = wait(rec, lines, ref)
                if key == "q":
                    return
                if key == "n":
                    next_sign = True
                elif key == "s":
                    print(f"{sign}: {user} skipped")
                    ui += 1
                else:
                    result = record_person(rec, a, sign, user, duration)
                    if result == "quit":
                        return
                    if result == "done":
                        ui += 1
    finally:
        rec.close()
        summary(a)


if __name__ == "__main__":
    main()

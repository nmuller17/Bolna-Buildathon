"""Webcam recorder: video + landmarks per sign. Args: --signs, --reps, --user, --out, --duration.

Two modes:
  train   N takes per sign for the classifier  -> data/train/<SIGN>/<user>_<n>.json
  avatar  1 take, replay it, keep or redo      -> signs/team/<SIGN>.json (+ signs/index.json)

Examples (from the repo root):
  python capture/capture.py --mode avatar --signs HELLO WELCOME --user cosme
  python capture/capture.py --mode avatar --signs A B C --user cosme --out signs/alphabet
  python capture/capture.py --mode train --signs YES NO --user cosme
  python capture/capture.py --mode train --signs FS-WIFI PASSWORD --duration 3 --user cosme

Keys: SPACE start sign, S skip sign, Q quit, R redo last take (train).
Review (avatar): 1-9 replay a take, ENTER keep the take on screen, R record again, S skip.
"""
from pathlib import Path
import argparse
import json
import sys
import time

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from capture.clean import FPS, clean  # noqa: E402
from capture.landmarks import create_landmarker, detect, normalize  # noqa: E402

WINDOW = "capture"
VIDEO_DIR = ROOT / "data" / "videos"
GREEN, RED, WHITE = (80, 220, 80), (60, 60, 230), (255, 255, 255)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=["train", "avatar"], default="train")
    p.add_argument("--signs", nargs="+", required=True, help="sign IDs, or a .txt file with one ID per line")
    p.add_argument("--user", required=True, help="signer name, e.g. cosme")
    p.add_argument("--reps", type=int, help="takes per sign (default: 20 train, 1 avatar)")
    p.add_argument("--out", type=Path, help="output dir (default: data/train or signs/team)")
    p.add_argument("--duration", type=float, default=2.0, help="seconds per take (3 for FS-* and compounds)")
    p.add_argument("--countdown", type=float, default=3.0, help="seconds before each take")
    p.add_argument("--camera", type=int, help="camera index (default: first one that is not black)")
    a = p.parse_args()
    a.reps = a.reps or (20 if a.mode == "train" else 1)
    a.out = (a.out or (ROOT / ("data/train" if a.mode == "train" else "signs/team"))).resolve()
    signs = []
    for s in a.signs:
        if s.endswith(".txt"):
            signs += [line.strip() for line in Path(s).read_text().splitlines() if line.strip()]
        else:
            signs.append(s)
    a.signs = [s.upper() for s in signs]
    return a


# ---------- display ----------

def show(img, lines, color=WHITE, inset=None):
    """Show a mirrored copy of img with text lines at the top and an optional inset image bottom-right."""
    view = cv2.flip(img, 1)
    if inset is not None:
        ih, iw = inset.shape[:2]
        h, w = view.shape[:2]
        view[h - ih - 20: h - 20, w - iw - 20: w - 20] = inset
        cv2.rectangle(view, (w - iw - 22, h - ih - 22), (w - 18, h - 18), WHITE, 2)
    for i, text in enumerate(lines):
        y = 50 + i * 45
        cv2.putText(view, text, (20, y), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 6, cv2.LINE_AA)
        cv2.putText(view, text, (20, y), cv2.FONT_HERSHEY_SIMPLEX, 1.2, color, 2, cv2.LINE_AA)
    cv2.imshow(WINDOW, view)
    return cv2.waitKey(1) & 0xFF


def draw_raw(img, raw):
    """Draw raw landmarks (aspect-scaled image coords) on a BGR frame, before mirroring."""
    h, w = img.shape[:2]
    aspect = w / h
    for part, color, r in (("pose", WHITE, 3), ("lh", GREEN, 3), ("rh", RED, 3), ("face", (230, 180, 60), 2)):
        for x, y, _ in raw[part] or []:
            cv2.circle(img, (int(x / aspect * w), int(y * h)), r, color, -1)
    return img


# ---------- capture ----------

def open_camera(index, exit_on_failure=True):
    """Open the given camera, or the first one sending a non-black image
    (an idle iPhone Continuity Camera shows up as a black camera on macOS)."""
    for i in [index] if index is not None else range(4):
        cap = cv2.VideoCapture(i)
        if not cap.isOpened():
            continue
        end = time.monotonic() + 2
        while time.monotonic() < end:
            ok, img = cap.read()
            if ok and img.mean() > 5:
                print(f"Using camera {i}")
                return cap
        cap.release()
        print(f"Camera {i}: black image, skipped")
    if not exit_on_failure:
        return None
    sys.exit("No working camera (check the camera permission for VS Code / your terminal).")


class Recorder:
    def __init__(self, camera):
        self.camera = camera
        self.open()
        self.landmarker = create_landmarker()
        self.t0 = time.monotonic()

    def open(self, exit_on_failure=True):
        cap = open_camera(self.camera, exit_on_failure)
        if cap is None:
            return False
        self.cap = cap
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        return True

    def now_ms(self):
        return (time.monotonic() - self.t0) * 1000

    REOPEN_FOR_SEC = 60

    def read(self):
        """Next webcam frame. Retries for 2 s (macOS cameras drop frames while warming up), then keeps
        reopening the camera every 2 s for REOPEN_FOR_SEC (another app grabbed it, the Mac paused it)."""
        give_up = None
        while True:
            end = time.monotonic() + 2
            while time.monotonic() < end:
                ok, img = self.cap.read()
                if ok:
                    return img
                time.sleep(0.05)
            give_up = give_up or time.monotonic() + self.REOPEN_FOR_SEC
            if time.monotonic() > give_up:
                sys.exit("Webcam stopped sending frames (close other apps using the camera, check the camera permission).")
            print("Webcam stopped sending frames, reopening it...")
            self.cap.release()
            while not self.open(exit_on_failure=False):
                if time.monotonic() > give_up:
                    sys.exit("No working camera (close other apps using the camera, check the camera permission).")
                time.sleep(2)

    def wait_start(self, lines):
        """Live preview until SPACE (start), S (skip) or Q (quit)."""
        while True:
            key = show(self.read(), lines + ["SPACE start   S skip   Q quit"])
            if key in (ord(" "), ord("s"), ord("q")):
                return chr(key)

    def take(self, sign, label, countdown, duration):
        """Countdown, then record. Returns (images, timestamps) or None if Q was pressed."""
        end = time.monotonic() + countdown
        while (left := end - time.monotonic()) > 0:
            if show(self.read(), [sign, label, f"{left:.0f}" if left >= 0.5 else "GO"]) == ord("q"):
                return None
        images, stamps = [], []
        end = time.monotonic() + duration
        while time.monotonic() < end:
            img = self.read()
            images.append(img)
            stamps.append(self.now_ms())
            show(img, [sign, label, "REC"], RED)
        return images, stamps

    def process(self, images, stamps):
        """Landmarks for each image -> (raw frames, cleaned normalized frames)."""
        raws = []
        for i, (img, t) in enumerate(zip(images, stamps)):
            if i % 10 == 0:
                show(img, ["processing..."])
            raws.append(detect(self.landmarker, cv2.cvtColor(img, cv2.COLOR_BGR2RGB), t))
        return raws, clean([normalize(r) for r in raws], stamps)

    def close(self):
        self.cap.release()
        self.landmarker.close()
        cv2.destroyAllWindows()


# ---------- saving ----------

def save_video(images, stamps, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fps = max(1.0, (len(stamps) - 1) * 1000 / (stamps[-1] - stamps[0])) if len(stamps) > 1 else FPS
    h, w = images[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for img in images:
        writer.write(img)
    writer.release()


def save_sign(path, sign, source, user, frames):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"id": sign, "source": source, "signer": user, "fps": FPS, "frames": frames}
    path.write_text(json.dumps(data, separators=(",", ":")))


def update_index(signs_root, sign, path):
    index_path = signs_root / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    index[sign] = path.relative_to(signs_root).as_posix()
    index_path.write_text(json.dumps(dict(sorted(index.items())), indent=2) + "\n")


def next_number(folder, user):
    nums = [int(p.stem.rsplit("_", 1)[1]) for p in folder.glob(f"{user}_*.json") if p.stem.rsplit("_", 1)[1].isdigit()]
    return max(nums, default=0) + 1


# ---------- modes ----------

def record_train(rec, a, sign):
    folder = a.out / sign
    n = 0
    while n < a.reps:
        got = rec.take(sign, f"take {n + 1}/{a.reps}", a.countdown, a.duration)
        if got is None:
            return False
        raws, frames = rec.process(*got)
        if not frames:
            show(got[0][-1], [sign, "No hands detected, again"], RED)
            cv2.waitKey(1200)
            continue
        num = next_number(folder, a.user)
        path = folder / f"{a.user}_{num}.json"
        save_sign(path, sign, "team", a.user, frames)
        save_video(*got, VIDEO_DIR / "train" / sign / f"{a.user}_{num}.mp4")
        n += 1
        show(got[0][-1], [sign, f"saved {n}/{a.reps}  ({len(frames)} frames)", "R redo"], GREEN)
        if cv2.waitKey(700) & 0xFF == ord("r"):
            path.unlink()
            n -= 1
    return True


def review(takes, sign):
    """Replay takes with landmarks. Returns the chosen index, 'redo', 'skip' or 'quit'."""
    current = 0
    while True:
        images, _, raws, frames = takes[current]
        for img, raw in zip(images, raws):
            key = show(draw_raw(img.copy(), raw),
                       [sign, f"take {current + 1}/{len(takes)}  ({len(frames)} frames)",
                        f"1-{len(takes)} view  ENTER keep  R redo  S skip"])
            if ord("1") <= key < ord("1") + len(takes):
                current = key - ord("1")
                break
            if key in (13, 10):
                return current
            if key in (ord("r"), ord("s"), ord("q")):
                return {"r": "redo", "s": "skip", "q": "quit"}[chr(key)]
            time.sleep(1 / FPS)
        cv2.waitKey(300)


def record_avatar(rec, a, sign):
    source = a.out.name if a.out.name in ("team", "public", "alphabet") else "team"
    while True:
        takes = []
        while len(takes) < a.reps:
            got = rec.take(sign, f"take {len(takes) + 1}/{a.reps}", a.countdown, a.duration)
            if got is None:
                print("Quit during countdown.")
                return False
            raws, frames = rec.process(*got)
            print(f"{sign}: take {len(takes) + 1} -> {len(got[0])} images, {len(frames)} frames with hands")
            if not frames:
                show(got[0][-1], [sign, "No hands detected, again"], RED)
                cv2.waitKey(1200)
                continue
            takes.append((*got, raws, frames))
        choice = review(takes, sign)
        print(f"{sign}: review -> {choice}")
        if choice == "quit":
            return False
        if choice == "skip":
            return True
        if choice == "redo":
            continue
        images, stamps, _, frames = takes[choice]
        path = a.out / f"{sign}.json"
        save_sign(path, sign, source, a.user, frames)
        save_video(images, stamps, VIDEO_DIR / "avatar" / f"{sign}.mp4")
        if (a.out.parent / "index.json").exists():
            update_index(a.out.parent, sign, path)
        print(f"{sign}: saved {path.relative_to(ROOT)} ({len(frames)} frames)")
        return True


def main():
    a = parse_args()
    rec = Recorder(a.camera)
    record = record_train if a.mode == "train" else record_avatar
    try:
        for i, sign in enumerate(a.signs):
            key = rec.wait_start([f"Next: {sign}", f"sign {i + 1}/{len(a.signs)}  ({a.mode})"])
            if key == "q":
                print("Quit.")
                break
            if key == "s":
                print(f"{sign}: skipped")
                continue
            if not record(rec, a, sign):
                break
    finally:
        rec.close()


if __name__ == "__main__":
    main()

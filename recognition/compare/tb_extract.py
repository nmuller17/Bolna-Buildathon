"""Track B helper: mp4 clips -> capture-parity landmark files (+ optional sampled JPEG frames for the
vision-model baseline). Needs mediapipe and opencv (the bench venv, or the project venv if it has them).

    ~/.venvs/signbridge-bench/bin/python recognition/compare/tb_extract.py --clips <dir> --out <dir> [--frames 16 8]

For each <clips>/<LABEL>/<name>.mp4 it writes <out>/landmarks/<LABEL>/<name>.json with exactly what the
live pipeline (recognition.stream) computes per frame, before cleaning:
  - frames: FrameAdapter(mode="capture", image_size=(w, h)) output, i.e. capture/landmarks.py
    to_frame(result, w / h) + normalize, face data minimised as live does; None when there is no pose;
  - t_ms: the frame's capture time (frame index * 1000 / fps), the times capture.clean.clean resamples on;
  - framing: recognition.framing.check(result, w / h, waist) per frame, for waist "hips" and "none".
track_b_video.prepare() then applies the framing gate, capture.clean.clean(frames, t_ms) and
Recognizer.predict, as stream.py does for one sign. A <name>.json next to an mp4 is taken as an
already-cleaned capture.py SignFile instead. With --frames N it also writes N evenly spaced frames,
cropped to the upper body and resized to a 640 px long edge, JPEG quality 92, into
<out>/frames<N>/<LABEL>/<name>/NN.jpg. Everything stays on this machine.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from recognition import framing, mediapipe_adapter as mpa  # noqa: E402

PIPELINE = "capture-parity-v1"
LONG_EDGE = 640
UPPER_BODY = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24]


def convert(results, image_size, fps, label="", signer="", task_sha256=None):
    """Holistic results of one clip (in time order) -> the uncleaned capture-parity landmark document."""
    w, h = image_size
    adapter = mpa.FrameAdapter(image_size=(w, h), mode="capture")      # minimize=True, as live
    frames = [adapter(r) for r in results]
    return {"id": label, "source": "team", "signer": signer, "fps": fps, "image_size": [w, h],
            "pipeline": PIPELINE, "stage": "uncleaned", "task_sha256": task_sha256,
            "frames": frames, "t_ms": [i * 1000.0 / fps for i in range(len(results))],
            "framing": {waist: [framing.check(r, w / h, waist) for r in results] for waist in ("hips", "none")}}


def read_video(path):
    import cv2
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = fps if fps and 1 <= fps <= 240 else 30.0
    frames = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(bgr)
    cap.release()
    return frames, fps


def crop_box(boxes, w, h):
    """Union of per-frame upper-body boxes (pixels) with a 25% margin, or the full frame."""
    if not boxes:
        return 0, 0, w, h
    b = np.array(boxes)
    x0, y0, x1, y1 = b[:, 0].min(), b[:, 1].min(), b[:, 2].max(), b[:, 3].max()
    mx, my = 0.25 * (x1 - x0), 0.25 * (y1 - y0)
    return (int(max(0, x0 - mx)), int(max(0, y0 - my)), int(min(w, x1 + mx)), int(min(h, y1 + my)))


def main():
    import cv2
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--task", default=str(mpa.DEFAULT_TASK), help="the same .task file live.py uses")
    ap.add_argument("--frames", type=int, nargs="*", default=[])
    a = ap.parse_args()
    clips, out = Path(a.clips), Path(a.out)
    task_sha = hashlib.sha256(Path(a.task).read_bytes()).hexdigest()
    for mp4 in sorted(clips.glob("*/*.mp4")):
        label, name = mp4.parent.name, mp4.stem
        dest = out / "landmarks" / label / f"{name}.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        pre = mp4.with_suffix(".json")
        if dest.exists() and json.loads(dest.read_text()).get("pipeline") not in (PIPELINE, "precleaned"):
            dest.unlink()      # written by the old legacy-mode extractor: redo
        need_lm = not dest.exists()
        need_fr = [n for n in a.frames if not (out / f"frames{n}" / label / name).exists()]
        if not need_lm and not need_fr:
            continue
        frames, fps = read_video(mp4)
        if not frames:
            print(f"unreadable, skipped: {mp4}", flush=True)
            continue
        h, w = frames[0].shape[:2]
        boxes = []
        if pre.exists():
            doc = json.loads(pre.read_text())
            doc = doc if isinstance(doc, dict) else {"frames": doc}
            doc.update(pipeline="precleaned", stage="cleaned")
            dest.write_text(json.dumps(doc, separators=(",", ":")))
        elif need_lm or need_fr:
            landmarker = mpa.load_holistic(a.task, video=True)  # fresh per clip: VIDEO mode timestamps
            results = []
            for i, bgr in enumerate(frames):
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                res = landmarker.detect_for_video(mpa.mp_image(rgb), int(round(i * 1000 / fps)))
                results.append(res)
                pose = mpa._first(getattr(res, "pose_landmarks", None)) or []
                if len(pose) >= 25:
                    xs = [pose[k].x * w for k in UPPER_BODY]
                    ys = [pose[k].y * h for k in UPPER_BODY]
                    boxes.append((min(xs), min(ys), max(xs), max(ys)))
            landmarker.close()
            if need_lm:
                doc = convert(results, (w, h), fps, label, name.rsplit("_", 1)[0], task_sha)
                dest.write_text(json.dumps(doc, separators=(",", ":")))
        x0, y0, x1, y1 = crop_box(boxes, w, h)
        for n in need_fr:
            d = out / f"frames{n}" / label / name
            d.mkdir(parents=True, exist_ok=True)
            for k, i in enumerate(np.linspace(0, len(frames) - 1, n).round().astype(int)):
                img = frames[i][y0:y1, x0:x1]
                s = LONG_EDGE / max(img.shape[:2])
                img = cv2.resize(img, (round(img.shape[1] * s), round(img.shape[0] * s)), interpolation=cv2.INTER_AREA)
                cv2.imwrite(str(d / f"{k:02d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        print(f"done {label}/{name} ({len(frames)} frames)", flush=True)


if __name__ == "__main__":
    main()

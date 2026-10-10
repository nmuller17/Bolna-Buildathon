"""MediaPipe Holistic extraction + normalization (Python reference impl, CLAUDE.md 6.1-6.2).

Any change to normalize() must be mirrored in web/lib/recognition/features.ts.
"""
from pathlib import Path
import math
import urllib.request

import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
    "holistic_landmarker/float16/latest/holistic_landmarker.task"
)
MODEL_PATH = Path(__file__).parent / "models" / "holistic_landmarker.task"

# Face mesh indices kept in a Frame, in this order (eyebrows, eyes, mouth, nose tip, chin).
FACE_IDX = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 33, 133, 159, 145,
            362, 263, 386, 374, 61, 291, 0, 17, 13, 14, 1, 152]

L_SHOULDER, R_SHOULDER = 11, 12


def create_landmarker(model_path=MODEL_PATH):
    """Holistic landmarker in VIDEO mode. Downloads the model on first use."""
    model_path = Path(model_path)
    if not model_path.exists():
        model_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {MODEL_URL} ...")
        urllib.request.urlretrieve(MODEL_URL, model_path)
    options = vision.HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
    )
    return vision.HolisticLandmarker.create_from_options(options)


def detect(landmarker, rgb, timestamp_ms):
    """Run the landmarker on one RGB frame (numpy HxWx3) and return a raw Frame."""
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect_for_video(image, int(timestamp_ms))
    h, w = rgb.shape[:2]
    return to_frame(result, aspect=w / h)


def to_frame(result, aspect):
    """HolisticLandmarkerResult -> Frame with raw image coordinates (y-down).

    x is multiplied by the image aspect ratio (w / h) so x and y share the same unit;
    otherwise shoulder-width normalization would be skewed on non-square video.
    """
    def pts(landmarks, idx=None):
        if not landmarks:
            return None
        chosen = landmarks if idx is None else [landmarks[i] for i in idx]
        return [[p.x * aspect, p.y, p.z * aspect] for p in chosen]

    return {
        "pose": pts(result.pose_landmarks),
        "lh": pts(result.left_hand_landmarks),
        "rh": pts(result.right_hand_landmarks),
        "face": pts(result.face_landmarks, FACE_IDX),
    }


def normalize(frame):
    """Shoulder-centered, shoulder-width-scaled Frame (CLAUDE.md 6.2).

    x, y: origin = shoulder midpoint, divided by the 2D shoulder distance.
    z: MediaPipe gives z relative to each part (hips, wrist, face), so it is only scaled.
    Returns None when the pose (hence the shoulders) is missing.
    """
    pose = frame["pose"]
    if pose is None:
        return None
    ls, rs = pose[L_SHOULDER], pose[R_SHOULDER]
    ox, oy = (ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2
    scale = math.hypot(ls[0] - rs[0], ls[1] - rs[1]) or 1.0

    def norm(points):
        if points is None:
            return None
        return [[round((x - ox) / scale, 5), round((y - oy) / scale, 5), round(z / scale, 5)]
                for x, y, z in points]

    return {key: norm(frame[key]) for key in ("pose", "lh", "rh", "face")}

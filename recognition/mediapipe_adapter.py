"""MediaPipe Python result -> one Frame (CLAUDE.md 6.1), normalized per 6.2.

mediapipe is never imported at module import time (the server must not need it): results
are read by attribute. Supported inputs, all computed on the UNMIRRORED camera image:
- tasks HolisticLandmarker (mediapipe 1.1.0, IMAGE or VIDEO mode): pose_landmarks is a flat
  list of 33 landmarks, left/right_hand_landmarks flat lists of 21, face_landmarks 478;
  a part that was not detected is [].
- legacy mp.solutions.holistic (mediapipe <= 0.10.x): result.pose_landmarks.landmark etc.,
  None when not detected.
- PoseLandmarker + HandLandmarker (+ optional FaceLandmarker) results: pose_landmarks[0]
  (first person), hand_landmarks[i]. Hands go to lh/rh by the nearest pose wrist
  (15 = person's left, 16 = right); handedness labels are ignored.

Data minimisation (minimize=True, default): face = None, and pose 1-10 (eyes, ears, mouth)
are overwritten with a copy of pose 0 (nose), so the frame holds no facial landmark beyond
the nose position the model already uses. The model reads only pose 0 and 11-16 plus the
hands, so its output is unchanged (tested). minimize=False keeps pose 1-10 and returns the
26-point face subset (features.FACE_INDICES), e.g. for avatar captures.

Aspect ratio: MediaPipe divides x by image width and y by image height. With
aspect_correct=True and image_size=(w, h), x and z are multiplied by w / h first (all in
image-height units). The default False matches the current 6.2 contract. Training captures
and live input must use the same setting. FrameAdapter.y_scale (h / w without correction,
else 1) is what the segmenter needs to measure its area in real shoulder widths.

Landmarker state: a HolisticLandmarker keeps state between calls even in IMAGE mode (it
smooths the segmentation mask): it raises on an image of a different size and can give a
different result for the same image on the next call. Use one VIDEO-mode landmarker per
stream (fixed size, increasing timestamps) and detect_image() for still images, which makes
a fresh landmarker per image. To compare settings (minimize, aspect_correct), convert the
same result object twice rather than detecting again.

Streams: use one FrameAdapter per stream. A frame without a usable pose reuses the last
shoulders (as features.normalize does) and the last pose wrists for hand assignment; with
no earlier pose its hands are dropped (lh = rh = None), because they cannot be normalized.
A part whose normalized coordinates exceed MAX_ABS is dropped (the server would reject it).

mode="capture" (live.py and classify_video.py use it): exact parity with the training
captures. The frame is capture.landmarks.normalize(capture.landmarks.to_frame(result, w / h)),
the teammate's own code (imported lazily): x and z times w / h, origin = shoulder midpoint in
x, y only, z only scaled, rounded to 5 decimals, MediaPipe's lh/rh labels kept (features.py
reassigns hands by the pose wrists for training and serving alike). A frame without pose is
None, as in capture.py. Minimisation and the MAX_ABS check are applied after that conversion.
Holistic results only (as capture.py); y_scale is 1. Segments must then be cleaned with
capture.clean.clean before prediction (recognition.stream does it).
"""
from pathlib import Path

import numpy as np

from recognition import features

POSE_N, HAND_N, FACE_MESH_N = 33, 21, 468
FACE_POSE = list(range(1, 11))
NOSE, L_WRIST, R_WRIST = 0, 15, 16
MAX_ABS = 50.0  # = recognizer.COORD_LIMIT (checked by a test)
HOLISTIC_URL = ("https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
                "holistic_landmarker/float16/latest/holistic_landmarker.task")
DEFAULT_TASK = Path(__file__).parent / "models" / "holistic_landmarker.task"
INSTALL_HINT = "pip install mediapipe opencv-python   (or: pip install -r requirements.txt)"


def _landmarks(obj):
    """Landmark container (list, legacy proto with .landmark, or None) -> non-empty list or None."""
    if obj is None:
        return None
    obj = getattr(obj, "landmark", obj)
    try:
        lms = list(obj)
    except TypeError:
        return None
    return lms or None


def _first(obj):
    """First person of a list-of-lists result (PoseLandmarker, FaceLandmarker); a flat list is returned as is."""
    lms = _landmarks(obj)
    if lms and not hasattr(lms[0], "x"):
        return lms[0]
    return lms


def _points(obj, n):
    """-> float64 [n, 3] or None (missing, too few points, or non-finite)."""
    lms = _landmarks(obj)
    if lms is None or len(lms) < n:
        return None
    try:
        a = np.array([[lm.x, lm.y, lm.z] for lm in lms[:n]], dtype=np.float64)
    except (AttributeError, TypeError, ValueError):
        return None
    return a if np.isfinite(a).all() else None


def _face(obj):
    mesh = _points(obj, FACE_MESH_N)
    return None if mesh is None else mesh[features.FACE_INDICES]


def _shoulders(pose):
    """(origin, scale) per 6.2, or None when the shoulders are missing or coincide."""
    if pose is None:
        return None
    l, r = pose[11], pose[12]
    scale = float(np.linalg.norm((l - r)[:2]))
    if not np.isfinite(scale) or scale <= 1e-6:
        return None
    return (l + r) / 2, scale


def capture_modules():
    """(capture.landmarks, capture.clean), imported on first use (capture.landmarks imports mediapipe)."""
    try:
        from capture import clean, landmarks
    except ModuleNotFoundError as e:
        if e.name != "capture":
            raise
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from capture import clean, landmarks
    return landmarks, clean


class _Flat:
    """A Holistic result with flat landmark lists ([] when missing), as capture.landmarks.to_frame reads it."""

    def __init__(self, result):
        self.pose_landmarks, self.left_hand_landmarks, self.right_hand_landmarks, face = (
            _landmarks(getattr(result, name, None)) or []
            for name in ("pose_landmarks", "left_hand_landmarks", "right_hand_landmarks", "face_landmarks"))
        self.face_landmarks = face if len(face) >= FACE_MESH_N else []


class FrameAdapter:
    """Stateful converter for one video stream: adapter(result) -> Frame dict (JSON-ready lists).

    mode="legacy" (default): the conversion described above. mode="capture": capture.py parity
    (needs image_size; returns None for a frame without pose)."""

    def __init__(self, minimize=True, image_size=None, aspect_correct=False, mode="legacy"):
        if mode not in ("legacy", "capture"):
            raise ValueError("mode must be 'legacy' or 'capture'")
        if (aspect_correct or mode == "capture") and not image_size:
            raise ValueError("aspect_correct=True and mode='capture' need image_size=(width, height)")
        self.mode = mode
        self.minimize = minimize
        self.aspect = image_size[0] / image_size[1] if image_size else None
        self.xz_scale = image_size[0] / image_size[1] if aspect_correct else 1.0
        self.y_scale = image_size[1] / image_size[0] if image_size and not aspect_correct else 1.0
        if mode == "capture":
            self.y_scale = 1.0
        self._shoulders = None
        self._wrists = None

    def __call__(self, result, hands=None, face=None):
        """result: a Holistic result (tasks or legacy), or a PoseLandmarker result (or None).
        hands / face: HandLandmarker / FaceLandmarker results, only with a PoseLandmarker result."""
        if self.mode == "capture":
            return self._capture(result, hands, face)
        if hands is None and face is None and result is not None and hasattr(result, "left_hand_landmarks"):
            pose = _points(result.pose_landmarks, POSE_N)
            lh = _points(result.left_hand_landmarks, HAND_N)
            rh = _points(result.right_hand_landmarks, HAND_N)
            fc = _face(getattr(result, "face_landmarks", None))
            pose, lh, rh, fc = (self._aspect(a) for a in (pose, lh, rh, fc))
        else:
            pose = self._aspect(_points(_first(getattr(result, "pose_landmarks", None)), POSE_N))
            found = [_points(h, HAND_N) for h in (_landmarks(getattr(hands, "hand_landmarks", None)) or [])]
            lh, rh = self._place([self._aspect(h) for h in found if h is not None], pose)
            fc = self._aspect(_face(_first(getattr(face, "face_landmarks", None))))
        return self._finish(pose, lh, rh, fc)

    def _capture(self, result, hands, face):
        if hands is not None or face is not None or (result is not None and not hasattr(result, "left_hand_landmarks")):
            raise ValueError("mode='capture' takes a HolisticLandmarker result, as capture.py does")
        if result is None:
            return None
        lm, _ = capture_modules()
        frame = lm.normalize(lm.to_frame(_Flat(result), self.aspect))
        if frame is None:
            return None
        if self.minimize:
            frame["face"] = None
            frame["pose"] = [list(frame["pose"][NOSE]) if i in FACE_POSE else p for i, p in enumerate(frame["pose"])]
        for p, a in frame.items():
            if a is not None and not (np.abs(np.asarray(a, np.float64)) <= MAX_ABS).all():
                frame[p] = None
        return frame if frame["pose"] is not None else None

    def _aspect(self, a):
        if a is None or self.xz_scale == 1.0:
            return a
        a = a.copy()
        a[:, [0, 2]] *= self.xz_scale
        return a

    def _place(self, hands, pose):
        """Up to two hands -> (lh, rh) by distance to the pose wrists (current, else last seen)."""
        wrists = pose[[L_WRIST, R_WRIST], :2] if pose is not None else self._wrists
        if not hands or wrists is None:
            return None, None
        d = np.array([[np.linalg.norm(h[0, :2] - w) for w in wrists] for h in hands])
        keep = np.argsort(d.min(1))[:2]
        if len(keep) == 1:
            h = hands[keep[0]]
            return (h, None) if d[keep[0], 0] <= d[keep[0], 1] else (None, h)
        a, b = keep
        if d[a, 0] + d[b, 1] <= d[a, 1] + d[b, 0]:
            return hands[a], hands[b]
        return hands[b], hands[a]

    def _finish(self, pose, lh, rh, fc):
        if self.minimize:
            fc = None
            if pose is not None:
                pose = pose.copy()
                pose[FACE_POSE] = pose[NOSE]
        sh = _shoulders(pose)
        if sh is None:
            pose = None
            sh = self._shoulders
        else:
            self._shoulders, self._wrists = sh, pose[[L_WRIST, R_WRIST], :2].copy()
        frame = {"pose": pose, "lh": lh, "rh": rh, "face": fc}
        if sh is None:
            return {"pose": None, "lh": None, "rh": None, "face": None}
        if pose is not None:  # same code path as training and serving
            seq, _ = features.normalize([{p: (None if a is None else a.tolist()) for p, a in frame.items()}])
            out = {p: (None if frame[p] is None else seq[p][0]) for p in features.PARTS}
        else:
            origin, scale = sh
            out = {p: (None if a is None else ((a - origin) / scale).astype(np.float32)) for p, a in frame.items()}
        return {p: (None if a is None or not (np.abs(a) <= MAX_ABS).all() else a.tolist()) for p, a in out.items()}


def to_frame(result, hands=None, face=None, minimize=True, image_size=None, aspect_correct=False, mode="legacy"):
    """One-shot conversion of a single result (no memory of earlier frames). Use FrameAdapter for video."""
    return FrameAdapter(minimize, image_size, aspect_correct, mode)(result, hands, face)


def load_holistic(task_path=DEFAULT_TASK, video=True):
    """Create a tasks HolisticLandmarker (VIDEO mode by default). Imports mediapipe here, not at import time.
    One landmarker per stream and image size: it keeps state between calls even in IMAGE mode
    (see the module docstring); for still images use detect_image()."""
    try:
        from mediapipe.tasks.python import BaseOptions, vision
    except ImportError as e:
        raise ImportError(f"mediapipe is not installed: {INSTALL_HINT}") from e
    task_path = Path(task_path)
    if not task_path.is_file():
        raise FileNotFoundError(f"model file not found: {task_path}\n  download it with:\n  "
                                f"curl -L -o {task_path} {HOLISTIC_URL}")
    mode = vision.RunningMode.VIDEO if video else vision.RunningMode.IMAGE
    return vision.HolisticLandmarker.create_from_options(vision.HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(task_path)), running_mode=mode))


def detect_image(rgb, task_path=DEFAULT_TASK):
    """One still RGB image -> HolisticLandmarkerResult, from a fresh IMAGE-mode landmarker (no state carried over)."""
    landmarker = load_holistic(task_path, video=False)
    try:
        return landmarker.detect(mp_image(rgb))
    finally:
        landmarker.close()


def mp_image(rgb):
    """RGB uint8 array -> mediapipe.Image."""
    import mediapipe as mp
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))

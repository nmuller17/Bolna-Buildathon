"""Head-to-waist framing gate, from the RAW MediaPipe pose (image coordinates, before normalization).

    status = check(result, aspect=w / h)            # one of STATUSES
    status = check(result, aspect=w / h, waist="none")   # counter hides the hips (fallback)

A frame is OK when the nose, both shoulders, both elbows, both wrists and both hips (pose 23/24,
the waist) lie inside the image with a MARGIN (fraction of the width / height on each side) and
MediaPipe's presence score is at least MIN_PRESENCE (where the landmarker reports one; out-of-image
points get low presence and coordinates beyond 0..1). MediaPipe also invents points: with the
head cut off it put the nose inside the image at shoulder height with presence 1.0, and on a
photo it misread it put the hips next to the shoulders. So the head also counts as cut when the
nose is less than NOSE_ABOVE_SW shoulder widths above the shoulder midpoint, and the hips when
their midpoint is less than HIPS_BELOW_SW below it (loose bounds; upright adults are about 0.5
and 1.2-1.5). A nose inside the picture does not mean the face is: the picture must also reach
HEADROOM_SW shoulder widths above the nose (plus the margin), about the hairline (on the test
photo the top of the head is 0.7 above the nose). Otherwise, first match wins:
- NO_PERSON         no pose;
- STEP_BACK         head (with its headroom) or hips cut at the top or bottom and the body would
                    not fit by aiming the camera differently, or the signing space
                    (SPACE_HALF_WIDTH shoulder widths either side of the body midline) is wider
                    than the image;
- MOVE_CAMERA_DOWN  hips below the bottom edge but head to hips would fit: tilt or lower the camera;
- COME_CLOSER       shoulder width below MIN_SHOULDER of the shorter image side (hands too small);
                    recognition.stream also shows it instead of NO_PERSON shortly after a small pose;
- CENTER            nose, shoulders or hips cut at a side edge, or the signing space crosses one;
- HANDS_OUT         a wrist or elbow outside the image (body framed correctly);
- OK.
waist="none" drops the hips from every rule: use it only where a counter or desk hides them; the
classifier was trained on head-to-waist captures, so signing near the waist is then unchecked.

A sign segment is classified only when at least MIN_OK_FRACTION of its frames are OK
(recognition.stream); otherwise the dominant problem is reported instead of a prediction.
mediapipe is not imported here.
"""
from collections import Counter

from recognition.mediapipe_adapter import _first

OK, STEP_BACK, MOVE_CAMERA_DOWN, COME_CLOSER, CENTER, HANDS_OUT, NO_PERSON = (
    "OK", "STEP_BACK", "MOVE_CAMERA_DOWN", "COME_CLOSER", "CENTER", "HANDS_OUT", "NO_PERSON")
STATUSES = (OK, STEP_BACK, MOVE_CAMERA_DOWN, COME_CLOSER, CENTER, HANDS_OUT, NO_PERSON)
GUIDANCE = {
    OK: "Ready: sign when you like",
    STEP_BACK: "Please step back: head to waist must be in the picture",
    MOVE_CAMERA_DOWN: "Tilt the camera down: your waist is below the picture",
    COME_CLOSER: "Please come closer",
    CENTER: "Please move to the centre of the picture",
    HANDS_OUT: "Keep your hands inside the picture",
    NO_PERSON: "Please stand in front of the camera",
}

MARGIN = 0.03
MIN_PRESENCE = 0.5
SPACE_HALF_WIDTH = 1.5
NOSE_ABOVE_SW = 0.25
HIPS_BELOW_SW = 0.8
HEADROOM_SW = 0.4
MIN_SHOULDER = 0.12        # first guess (60 px shoulders at 720p passed before); tune on webcam frames
MIN_OK_FRACTION = 0.8
NOSE, SHOULDERS, ELBOWS, WRISTS, HIPS = [0], [11, 12], [13, 14], [15, 16], [23, 24]


def _present(p):
    presence = getattr(p, "presence", None)
    return presence is None or presence >= MIN_PRESENCE


def _inside(p, margin):
    return _present(p) and margin <= p.x <= 1 - margin and margin <= p.y <= 1 - margin


def check(result, aspect=1.0, waist="hips", margin=MARGIN):
    """Raw Holistic (or PoseLandmarker) result -> framing status (a STATUSES string)."""
    if waist not in ("hips", "none"):
        raise ValueError("waist must be 'hips' or 'none'")
    pose = _first(getattr(result, "pose_landmarks", None)) if result is not None else None
    if not pose or len(pose) < 33:
        return NO_PERSON
    body = NOSE + SHOULDERS + (HIPS if waist == "hips" else [])
    lo, hi = margin, 1 - margin
    ls, rs = pose[11], pose[12]
    mid_y = (ls.y + rs.y) / 2
    sw_h = (((ls.x - rs.x) * aspect) ** 2 + (ls.y - rs.y) ** 2) ** 0.5     # shoulder width in image heights
    head_top = pose[0].y - HEADROOM_SW * sw_h
    top_cut = (head_top < lo or any(pose[i].y < lo for i in SHOULDERS)
               or mid_y - pose[0].y < NOSE_ABOVE_SW * sw_h)
    bottom_cut = waist == "hips" and (any(pose[i].y > hi or not _present(pose[i]) for i in HIPS)
                                      or (pose[23].y + pose[24].y) / 2 - mid_y < HIPS_BELOW_SW * sw_h)
    if top_cut or bottom_cut:
        bottom = HIPS if waist == "hips" else SHOULDERS + ELBOWS
        span = max(pose[i].y for i in bottom) - min([head_top] + [pose[i].y for i in SHOULDERS])
        if top_cut or span > hi - lo:
            return STEP_BACK
        return MOVE_CAMERA_DOWN
    if sw_h / min(aspect, 1.0) < MIN_SHOULDER:      # shorter side, so portrait cameras are not penalised
        return COME_CLOSER
    mid = (ls.x + rs.x) / 2
    space = SPACE_HALF_WIDTH * sw_h / aspect                             # in image widths
    if 2 * space > hi - lo:
        return STEP_BACK
    if not all(_inside(pose[i], margin) for i in body) or mid - space < lo or mid + space > hi:
        return CENTER
    if not all(_inside(pose[i], margin) for i in ELBOWS + WRISTS):
        return HANDS_OUT
    return OK


def dominant(statuses):
    """Most common non-OK status of a segment (ties: the order of STATUSES), or OK if there is none."""
    bad = Counter(s for s in statuses if s != OK)
    if not bad:
        return OK
    return max(bad, key=lambda s: (bad[s], -STATUSES.index(s)))


def segment_ok(statuses, min_ok=MIN_OK_FRACTION):
    """True when at least min_ok of the statuses are OK (None counts as not OK)."""
    statuses = list(statuses)
    return bool(statuses) and sum(s == OK for s in statuses) >= min_ok * len(statuses) - 1e-9

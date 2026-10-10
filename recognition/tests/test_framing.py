import os
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np
import pytest

from recognition import framing, mediapipe_adapter as mpa
from recognition.framing import CENTER, HANDS_OUT, MOVE_CAMERA_DOWN, NO_PERSON, OK, STEP_BACK

ASPECT = 16 / 9


def body(dx=0.0, dy=0.0, scale=1.0):
    """33 raw pose points (x in image widths, y in image heights) of a person framed head to waist."""
    p = np.full((33, 2), 0.5)
    pts = {0: (0.5, 0.22), 11: (0.56, 0.36), 12: (0.44, 0.36), 13: (0.6, 0.55), 14: (0.4, 0.55),
           15: (0.58, 0.68), 16: (0.42, 0.68), 23: (0.54, 0.82), 24: (0.46, 0.82)}
    for i, xy in pts.items():
        p[i] = xy
    p = (p - [0.5, 0.5]) * scale + [0.5 + dx, 0.5 + dy]
    return p


def result(p, presence=None):
    presence = presence or {}
    return NS(pose_landmarks=[NS(x=float(x), y=float(y), z=0.0, visibility=0.9, presence=presence.get(i, 0.99))
                              for i, (x, y) in enumerate(p)],
              left_hand_landmarks=[], right_hand_landmarks=[], face_landmarks=[])


def test_well_framed_person_is_ok():
    assert framing.check(result(body()), ASPECT) == OK
    assert framing.check(result(body()), ASPECT, waist="none") == OK


def test_no_person():
    assert framing.check(None, ASPECT) == NO_PERSON
    assert framing.check(NS(pose_landmarks=[]), ASPECT) == NO_PERSON
    assert framing.check(NS(pose_landmarks=[[]]), ASPECT) == NO_PERSON


def test_too_close_is_step_back():
    assert framing.check(result(body(scale=1.6)), ASPECT) == STEP_BACK      # head and hips both cut


def test_head_cut_is_step_back():
    assert framing.check(result(body(dy=-0.25)), ASPECT) == STEP_BACK


def test_hips_below_the_picture_with_headroom_is_move_camera_down():
    assert framing.check(result(body(dy=0.18)), ASPECT) == MOVE_CAMERA_DOWN
    assert framing.check(result(body(dy=0.18)), ASPECT, waist="none") == OK   # counter fallback ignores the hips


def test_hidden_hips_count_as_cut():
    r = result(body(), presence={23: 0.1, 24: 0.2})
    assert framing.check(r, ASPECT) == MOVE_CAMERA_DOWN
    assert framing.check(r, ASPECT, waist="none") == OK


def test_invented_points_are_not_trusted():
    p = body()
    p[0, 1] = 0.35                       # nose at shoulder height (MediaPipe did this with the head cut off)
    assert framing.check(result(p), ASPECT) == STEP_BACK
    p = body()
    p[[23, 24], 1] = 0.4                 # hips next to the shoulders
    assert framing.check(result(p), ASPECT) == MOVE_CAMERA_DOWN


def test_off_centre_is_center():
    assert framing.check(result(body(dx=0.3)), ASPECT) == CENTER
    assert framing.check(result(body(dx=-0.3)), ASPECT) == CENTER           # signing space crosses the edge
    assert framing.check(result(body(dx=0.45)), ASPECT) == CENTER           # a shoulder outside


def test_wrist_or_elbow_out_is_hands_out():
    p = body()
    p[15] = (1.02, 0.5)
    assert framing.check(result(p), ASPECT) == HANDS_OUT
    p = body()
    p[16, 1] = 0.01                      # hand raised above the top margin
    assert framing.check(result(p), ASPECT) == HANDS_OUT
    assert framing.check(result(body(), presence={14: 0.1}), ASPECT) == HANDS_OUT


def test_margin_is_a_named_constant():
    p = body()
    p[15] = (1 - framing.MARGIN / 2, 0.6)
    assert framing.check(result(p), ASPECT) == HANDS_OUT
    assert framing.check(result(p), ASPECT, margin=0.0) == OK


def test_pose_landmarker_result_list_of_lists():
    r = result(body())
    assert framing.check(NS(pose_landmarks=[r.pose_landmarks]), ASPECT) == OK


def test_segment_gate_and_dominant_problem():
    assert framing.segment_ok([OK] * 8 + [HANDS_OUT] * 2)
    assert not framing.segment_ok([OK] * 7 + [HANDS_OUT] * 3)
    assert not framing.segment_ok([])
    assert framing.dominant([OK, HANDS_OUT, STEP_BACK, HANDS_OUT]) == HANDS_OUT
    assert framing.dominant([OK, CENTER, STEP_BACK]) == STEP_BACK          # tie: STATUSES order
    assert framing.dominant([OK, OK]) == OK
    with pytest.raises(ValueError):
        framing.check(result(body()), ASPECT, waist="knees")


REAL_IMAGE = os.environ.get("RECOGNITION_TEST_IMAGE")
REAL_TASK = Path(os.environ.get("RECOGNITION_HOLISTIC_TASK", mpa.DEFAULT_TASK))


@pytest.mark.skipif(not (REAL_IMAGE and Path(REAL_IMAGE).is_file() and REAL_TASK.is_file()),
                    reason="set RECOGNITION_TEST_IMAGE (a person facing the camera, hips visible) and provide the .task")
def test_real_image_ok_and_crops_not_ok():
    pytest.importorskip("mediapipe")
    cv2 = pytest.importorskip("cv2")
    rgb = cv2.cvtColor(cv2.imread(REAL_IMAGE), cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]

    def status(img, waist="hips"):
        img = np.ascontiguousarray(img)
        return framing.check(mpa.detect_image(img, REAL_TASK), img.shape[1] / img.shape[0], waist)
    assert status(rgb) == OK
    assert status(rgb[: int(0.45 * h)]) != OK                    # cut at chest height: no waist
    assert status(rgb[int(0.25 * h):]) != OK                     # head cut off

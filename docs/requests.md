# Cross-team change requests

One entry per request: date, from, to, what, why.

## 2026-10-10, from P3 (recognition)

| # | To | What | Why |
|---|---|---|---|
| 1 | P2 | `capture.py`: one fixed `signer` name per person in every SignFile; exactly 21 points per hand and 26 face points; run MediaPipe on the unmirrored frame (flip only the preview); use `mediapipe.tasks.python.vision.HolisticLandmarker` (`mp.solutions` no longer exists in mediapipe 1.x); keep the `.mp4` locally | Leave-one-signer-out depends on the signer name; the mp4s are needed to benchmark video-only systems |
| 2 | All | Record with the same camera, resolution and orientation used in the demo. NONE takes must vary (scratching, hair, random gestures, other signs). One person who is never in training (e.g. from another team) records 5 takes of each class as the test set | Different aspect ratios distort landmarks; NONE is what stops unknown signs being spoken as ours; a held-out signer is the only honest accuracy number |
| 3 | P3/P4 (browser landmarks) | Send `face: null` to `/predict`, keys exactly `pose`, `lh`, `rh`, `face`, unmirrored frames, shoulders in view | Model ignores the face (privacy, smaller payload); unknown keys get 422; no shoulders gives NONE |
| 4 | P4 | Treat any `/predict` error (401, 413, 422, 429, 503) like low confidence and post `repeat_request`. If the server runs on the LAN, send the `X-Recognition-Token` header. Never tunnel port 8000 | Errors must never crash the demo or speak a guess; a tunnel makes the classifier public |
| 5 | All (CLAUDE.md 6.2 and rule 4) | Clarify 6.2: origin = shoulder midpoint in x, y, z; scale = shoulder distance in x, y. Add: capture and live must use the same aspect ratio (or multiply x by W/H first). Rule 4: only the 6.2 normalization must match in TS; features are computed server-side | Matches the implementation; prevents a silent train/demo mismatch |
| 6 | All (CLAUDE.md 5) | Drop "ASL Citizen or WLASL" for `signs/public`; use Google's GISLR data only inside gitignored `data/` | ASL Citizen forbids redistribution; WLASL's licence is unclear; GISLR's rules forbid redistribution |
| 7 | P2/P3 | Put a real recording in `fixtures/utterance_frames.json` (currently `[]`) | Needed to check that Python and TS normalization match |
| 8 | Whoever trains | `recognition/models/model.pt` is gitignored: share the trained file directly. The server refuses old-format checkpoints and loads weights only | The demo laptop needs the real model; a tampered file cannot run code |
| 9 | All | Pin versions in `requirements.txt` before the demo | Unpinned deps can change under us (mediapipe 1.x already broke `mp.solutions`) |

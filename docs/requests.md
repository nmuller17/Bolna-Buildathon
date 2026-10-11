# Cross-team change requests

One entry per request: date, from, to, what, why.

- 2026-10-10, from P4 (Nath), to all: text to speech switched from ElevenLabs to **Piper** (local, free, offline, no API key). `/api/tts` now returns `audio/wav` instead of `audio/mpeg`. `piper-tts` added to `requirements.txt`, voice files go in `voices/` (gitignored), env var `PIPER_VOICE` replaces `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`. CLAUDE.md updated accordingly. Why: no API key or credits, works without internet during the demo.
- 2026-10-10, from P4 (Nath), to all: text to speech is back on **ElevenLabs** as the main voice, with **Piper kept as an automatic backup** (then browser `speechSynthesis`). The `/api/tts` contract is unchanged: `{ text }` -> `audio/wav`. New env vars in `web/.env.local`: `ELEVENLABS_API_KEY` (ask Nath, never commit it) and `ELEVENLABS_VOICE_ID`; `PIPER_VOICE` is still needed for the backup. CLAUDE.md section 5 explains the setup. Why: ElevenLabs sounds much better and answers in ~0.3 s, while Piper keeps the demo working offline.

## 2026-10-10, from P2 to P3 (+ team): normalization details (CLAUDE.md 6.2)
Implemented in `capture/landmarks.py`. `web/lib/recognition/features.ts` must do exactly the same:
- Before normalizing, multiply x (and z) by the image aspect ratio `width / height`, so x and y are in the same unit. Otherwise the shoulder-width scale is skewed on 16:9 video.
- Scale = 2D distance (x, y) between pose points 11 and 12.
- z is only divided by the scale, not shifted: MediaPipe gives z relative to each part (hips, wrist, face).
- Frames without pose are dropped/forward-filled (no shoulders, no normalization).
Proposal: add these lines to CLAUDE.md 6.2.

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

## 2026-10-10, from P2/P4 to P4 (+ team): avatar player API (CLAUDE.md 6.6), backward-compatible additions
- `playGloss(gloss, { onToken })`: optional 2nd parameter. `onToken(index)` is called with the gloss index of the token being signed, each time it changes (karaoke captions, `web/components/AvatarCaptions.tsx`). `playGloss(gloss)` alone still works as in 6.6.
- `mountAvatar(container)` (in `web/lib/avatar/player.ts`) renders the avatar into a div and returns `{ webgl, unmount }`. Without WebGL, `playGloss` still runs its timing and `onToken`, so captions keep working.
- A newer `playGloss` call interrupts the current one (which resolves).
- Windows: git checks out the `web/public/signs` symlink as a text file when `core.symlinks` is off, so `/signs/*` returns 404. Local fix, no repo change: `Remove-Item web/public/signs; cmd /c mklink /J web\public\signs <repo>\signs; git update-index --skip-worktree web/public/signs`. Needed on the demo laptop if it runs Windows.
Why: the guest screen needs to know which sign is playing, and must not crash on a machine without WebGL.

## 2026-10-10, from P2 to P3 (+ P1, P4): FS-CHECKOUT replaced by LEAVE
Fingerspelling C-H-E-C-K-O-U-T (8 letters) in 3 s was too long to sign consistently and to recognize.
- Classifier class `FS-CHECKOUT` -> `LEAVE` (ASL sign "leave", 2 s). Still 22 classes. Please update `recognition/labels.py`.
- Guest intents: `LEAVE TIME` = "What time is checkout?", `LATE LEAVE PLEASE` = "Could I have a late checkout?" (`/api/english` should map LEAVE to checkout in the hotel context).
- Staff glosses: `LEAVE TIME 11`, `LATE LEAVE FINE UNTIL 1` (`/api/gloss` should use `LEAVE` for "checkout", not `FS:CHECKOUT`).
- docs/vocabulary.md, CLAUDE.md 8.2 and capture/train_session.py are updated on p2-avatar.

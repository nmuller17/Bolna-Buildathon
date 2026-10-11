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

## 2026-10-10, from P4 (red-team fix stage; details in `docs/app-plan.md` section 10a)

### Red-team changes to teammate routes (please review)

The P4 teammate wrote `web/app/api/english/route.ts` and `web/app/api/tts/route.ts`. The fixes are kept minimal, and every change is marked `SECURITY:` in the code. Synthesis, intents, the Claude prompt and the `{text}` contracts are unchanged.

| File | Change | Finding |
|---|---|---|
| `english/route.ts` | `await req.json()` replaced by `guardLoopbackJsonPost()` (loopback via `server.mjs`, Host allowlist, same-origin, JSON only, 8 KB capped read, 10/min) | B1, B3, B4, D1 |
| `english/route.ts` | `isPredictionList`: at most 8 signs, labels at most 32 characters, `conf` finite in [0, 1]. After `normalize`, every label must be one of the 22 in `LABELS` (otherwise 400) | B4, B5, D1 |
| `english/route.ts` | Claude's reply must pass `cleanSentence()` (one plain sentence, at most 200 characters), otherwise the fallback sentence is used. The error is logged as `Claude API <status>` only, never the vendor body | B5, D1, D6 |
| `tts/route.ts` | `guardLoopbackJsonPost()` (4 KB, 20/min); text = `cleanSentence(raw, 300)` (otherwise 400) | B1, B3, B6, D2 |
| `tts/route.ts` | Only the 19 `INTENTS` sentences are cached. Other text is synthesised uncached, at most 2 at a time (503 when busy) | B6, D3 |
| `tts/route.ts` | Piper is spawned with an absolute interpreter (`PIPER_PYTHON`, else `../.venv`, else `python` with a warning) and an allowlisted environment (`PATH`, `HOME`, `LANG`, `LC_ALL`, temp dirs) instead of `{...process.env}` | B9, C3, D5 |
| `components/speakSigns.ts` | The browser fallback uses only an on-device voice (`localService`), or stays silent | D9 |
| `public/signs` symlink | Replaced by `app/signs/[...path]/route.ts`. Same URLs; `signer` is removed; nothing outside `signs/` is served | B2, D7 |
| `package.json` | `npm run dev` now runs `node server.mjs` (127.0.0.1 only); `dev:lan`, `start`, `start:lan`, `test:security`; `"type": "module"`; Node >= 22.18 | B1 |

Still recommended for the teammate: turn on the Claude path in `/api/english` only behind `ENGLISH_FALLBACK=1` (plan section 7). Move `/api/tts` to `{ id }` (plan RT5).

### Requests for paths P4 may not edit

| # | To | What | Finding |
|---|---|---|---|
| R1 | All (CLAUDE.md 11) | Setup: `cd web && npm ci` (not `npm install`), then `npm run dev` (it now runs `server.mjs`). Never run plain `next dev` / `next start` for the app; they bind every interface, and the loopback routes answer 403. Add `PIPER_PYTHON=` (absolute venv python) and the recognizer's `RECOGNITION_ALLOW_UNPINNED` (development only) to the environment list. Note that `web/public/signs` is now a route | B1, C7, B9 |
| R2 | Root `.env.example` | Add `PIPER_PYTHON=` (absolute path) and `BRIDGE_KEY=` (at least 32 characters) | B9, C3 |
| R3 | P3 + whoever freezes | At H13, run `python -m recognition.pin_model recognition/models/model.pt` and commit `recognition/model_pin.py`. Until then the recognizer refuses the model unless `RECOGNITION_ALLOW_UNPINNED=1` | A1, C4 |
| R4 | P2 (`capture/capture.py`) | Validate sign names against `^[A-Z0-9_-]+$` (no `/`, `..` or `\`) before they are used in a path, and validate `--user` the same way. Write an opaque signer id (for example `s1`), not a first name, into sign JSON | A9, C1 |
| R5 | P2 (`capture/landmarks.py`) | Verify the downloaded `.task` against SHA-256 `e2dab61191e2dcd0a15f943d8e3ed1dce13c82dfa597b9dd39f562975a50c3f8` (the value now pinned in `recognition/mediapipe_adapter.py`); the URL is a mutable `latest` | A1, C5 |
| R6 | P2 + all (`signs/`, `capture/reference/*.mp4` on `p2-avatar`) | Get written consent from every recorded team member before anything is public. Replace `signer` names with opaque ids, and consider lower coordinate precision. Remove the 12 full-face reference MP4s from the public repo (a history rewrite if consent is withdrawn) or keep them private. Add a `DATA_LICENSES` note: code MIT; recordings under their own terms; GISLR data, MediaPipe models and Tripo assets under theirs | C1, C11, D7 |
| R7 | Repo owner (GitHub settings) | Protect `main` and the deploy branch (PR + 1 review, no force push), require 2FA, enable Dependabot, secret scanning and push protection, add CODEOWNERS, and deploy the desk laptop only from a reviewed tag. Consider making the repo private | C6 |
| R8 | Each member | Set `user.email` to the GitHub noreply address and enable "Block command line pushes that expose my email" | C2 |
| R9 | All (`requirements.txt`) | Pin versions with hashes (`pip-compile --generate-hashes`, `pip install --require-hashes`); drop `opencv-python` from the p4 file (it conflicts with contrib) | C7 |
| R10 | All (root `.gitignore`) | Add `*.wav`, `*.jpg`, `*.jpeg`, `*.png` (allowlist real assets), `*.pem`, `*.key`, `*.crt`, `*.npy`, `*.parquet`, `*.onnx` (missing on p3), `**/.next/`, `*.tsbuildinfo`, `recognition/compare/reports/`; add a pre-commit hook for secrets (gitleaks), large files and media. `web/.gitignore` and `recognition/.gitignore` now cover their own folders | C8 |
| R11 | Benchmark owner (`recognition/benchmark.py`) | Write data paths relative to the repo (the committed reports leaked `/private/tmp/claude-502/...`; they are redacted now). The HTTP latency step should pass `allow_unpinned=True` to `create_app` (or pin first), because unpinned models now get 503. Loading `Predictor(checkpoint)` directly also skips the pin, which is fine offline but should not be copied into live code | C9, A1 |
| R12 | GISLR tooling (`recognition/tools/gislr_to_frames.py`) | Verify every `urlretrieve` download against a committed SHA-256 | C5 |

## 2026-10-10, from P2/P4 to P4 (+ team): avatar player API (CLAUDE.md 6.6), backward-compatible additions
- `playGloss(gloss, { onToken })`: optional 2nd parameter. `onToken(index)` is called with the gloss index of the token being signed, each time it changes (karaoke captions, `web/components/AvatarCaptions.tsx`). `playGloss(gloss)` alone still works as in 6.6.
- `mountAvatar(container)` (in `web/lib/avatar/player.ts`) renders the avatar into a div and returns `{ webgl, unmount }`. Without WebGL, `playGloss` still runs its timing and `onToken`, so captions keep working.
- A newer `playGloss` call interrupts the current one (which resolves).
- Windows: git checks out the `web/public/signs` symlink as a text file when `core.symlinks` is off, so `/signs/*` returns 404. Local fix, no repo change: `Remove-Item web/public/signs; cmd /c mklink /J web\public\signs <repo>\signs; git update-index --skip-worktree web/public/signs`. Needed on the demo laptop if it runs Windows.
  - (P4 merge note, 2026-10-10: on `p4-app` the symlink no longer exists; `/signs/*` is served by `web/app/signs/[...path]/route.ts` with the same URLs, so this Windows workaround is not needed there.)
Why: the guest screen needs to know which sign is playing, and must not crash on a machine without WebGL.

## 2026-10-10, from P2 to P3 (+ P1, P4): FS-CHECKOUT replaced by LEAVE
Fingerspelling C-H-E-C-K-O-U-T (8 letters) in 3 s was too long to sign consistently and to recognize.
- Classifier class `FS-CHECKOUT` -> `LEAVE` (ASL sign "leave", 2 s). Still 22 classes. Please update `recognition/labels.py`.
- Guest intents: `LEAVE TIME` = "What time is checkout?", `LATE LEAVE PLEASE` = "Could I have a late checkout?" (`/api/english` should map LEAVE to checkout in the hotel context).
- Staff glosses: `LEAVE TIME 11`, `LATE LEAVE FINE UNTIL 1` (`/api/gloss` should use `LEAVE` for "checkout", not `FS:CHECKOUT`).
- docs/vocabulary.md, CLAUDE.md 8.2 and capture/train_session.py are updated on p2-avatar.

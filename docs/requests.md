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

## 2026-10-10, from P4 (integration merge of p2-avatar and P1 voice into p4-app)

### P4 merge fixes to P1 routes (please review, Maya)

Merging `origin/p1-gloss-vocab` (which contains `origin/codex/p1-voice-gloss`) into `p4-app` broke one thing and left two routes without the red-team guard. The fixes are minimal and every change is marked `P4 MERGE FIX:` in the code. The intent mapping in `web/lib/voice/intents.ts` and the Whisper call are unchanged.

| File | Change | Why |
|---|---|---|
| `web/app/api/gloss/route.ts` | The sign index is read from `<repo>/signs/index.json` instead of `web/public/signs/index.json` | The `web/public/signs` symlink no longer exists on `p4-app` (red-team B2); without this fix `/api/gloss` silently lost its list of known signs |
| `web/app/api/gloss/route.ts` | `request.json()` replaced by `guardLoopbackJsonPost()` (loopback via `server.mjs`, Host allowlist, same-origin, JSON only, 4 KB capped read, 30 a minute); text longer than 300 characters gets 400 | RT1 says a route with no guard is a bug (B1, B3, B4) |
| `web/app/api/transcribe/route.ts` | New `guardLoopbackRawPost()` first: loopback, Host allowlist, same-origin, `multipart/form-data` only (415), Content-Length required (411) and at most 5 MB (413), 20 a minute | `request.formData()` has no size cap of its own, so a chunked body without Content-Length could be unbounded (B1, B4) |
| `web/app/api/transcribe/route.ts` | A Whisper error now returns `502` with the status number only; the vendor's error body is no longer sent to the browser | D6 / RT11: vendor bodies can echo the request |

### P4 merge fixes for LEAVE (Nath, P3)

| File | Change | Why |
|---|---|---|
| `web/app/api/english/intents.ts` | `FS-CHECKOUT` replaced by `LEAVE` in `LABELS` and in the two checkout intents; new `LABEL_ALIASES = { "FS-CHECKOUT": "LEAVE" }` | `docs/vocabulary.md` now says LEAVE; `/api/english` would otherwise answer 400 to every LEAVE sign |
| `web/app/api/english/route.ts` | `normalize()` maps a label through `LABEL_ALIASES` first | `recognition/labels.py` on `p3-recognition` still emits `FS-CHECKOUT` until the model is retrained; both labels now give the checkout sentences. Remove the alias once labels.py says LEAVE |
| P3 (request) | Please rename `FS-CHECKOUT` to `LEAVE` in `recognition/labels.py` when the model is retrained | Single source of truth |

### LAN path list now includes the avatar model

`web/lib/app/access.ts` `lanPathAllowed` now also lets the guest device `GET /avatar/<name>.glb`, because the bellhop avatar loads `/avatar/bellhop.glb` (P2). Without it the guest screen in LAN mode would get 403 for the model.

## 2026-10-10, from P4: consolidated app plan (docs/app-plan.md rewritten; decision record hand-off)

`docs/app-plan.md` is now the build plan for this build, and `web/lib/app/types.ts` was rewritten with it (nothing imported the old types yet). This entry supersedes the draft entries in `app_requests.patch`. It also completes the decision-record hand-off: the plan's RT2 (mkcert), RT3 (`?t=` ticket), RT7 (per-gloss `/signs` with a session) and section 7 now follow decision record D3, D5, D6 and D7. Full list in plan section 14.

| # | To | What | Why |
|---|---|---|---|
| 1 | All | Screen sync is a server SSE bus (`GET /api/events`, `POST /api/staff/action`, `POST /api/guest/action`), not `BroadcastChannel`; the 6.7 messages keep their names and gain fields (plan section 7) | The guest screen is a second device |
| 2 | All | No plain-HTTP guest listener ever. Mode 0 (wired second display, loopback only) or Mode C (one cable, HTTPS on `LAN_IP:3443`, event CA); Mode W only if gate G2 passes. `npm run dev:lan`/`start:lan` and `GUEST_LAN` are removed; `npm run start:guest-tls` replaces them | Decision record D3, D5 |
| 3 | P3 (Talha) | Please add an optional `skeleton` field to `sign` bridge events: one frame from the middle of the sign, pose 0 and 11 to 16 plus both hands, x and y only, 3 decimals, no face, under 2 KB (plan 6.2). The staff evidence panel shows it; it never reaches the guest device and is wiped with the session | Evidence for each recognised sign without video |
| 4 | P3 | Rename `FS-CHECKOUT` to `LEAVE` in `recognition/labels.py` at the next retrain (the app aliases it until then); set the final harm-weighted bars (provisional 0.75 for YES, NO, NAME, ROOM, HELP) from audited calibration; optionally poll `GET /api/guest/signs` for `{accepting}`; mark a benchmark report `cleared: true` with an audit reference before the app shows any figure (it says "not yet audited" until then) | Plan 6.3, DSH-6 |
| 5 | Nath | Please move `/api/tts` to `{ id }` (RT5). Until then the staff page sends only the fixed table sentence from the server's speak plan; names and typed text never reach `/api/tts` | Guest-supplied text never reaches a TTS vendor |
| 6 | Nath, P1 | `guard.ts` (P4) will also require the staff capability cookie on `/api/english`, `/api/tts`, `/api/gloss` and `/api/transcribe`. No change in your route files; open `/p1-test` and `/avatar-preview` from the same browser after "Start desk" | Decision record D6: loopback alone is not authentication |
| 7 | P2 (Cosme) | Please add `preloadSigns(bundle)` to `web/lib/avatar/lookup.ts`, so `loadIndex`/`loadSign` read from a bundle fetched once from `GET /signs/bundle`; and run one avatar rehearsal with the nonce CSP sent as Report-Only and list any violations | D6 removes per-gloss `/signs` from the guest listener (response sizes would leak the sentence); LT-25 |
| 8 | Talha | Accept or decline adding exactly `GET /avatar/bellhop.glb` to the D6 guest path list (a fixed 8 MB file, same for every guest). If declined, the guest uses the `hologram` style | D6 path list is exhaustive |
| 9 | Owner of `.env.example` | Add `BRIDGE_KEY`, `LAN_IP`, `LAN_NET`, `DESK_NAME`, `GUEST_PORT`, `TLS_KEY_FILE`, `TLS_CERT_FILE`, `TLS_PUBLIC_KEY_FILE`, `TLS_PUBLIC_CERT_FILE`, `GUEST_IPS`, `IDLE_WIPE_MS`, `SESSION_CAP_MS`, `PAIR_CODE_TTL_MS`, `SB_SIMULATE`, `VLM_FALLBACK`, `ENGLISH_FALLBACK`, `BENCHMARK_CLEARED_FILE`, `VRI_LABEL`, `VRI_URL`, `VRI_PHONE`, `EMERGENCY_NOTE`, `KIOSK`; remove `GUEST_LAN`. No `NEXT_PUBLIC_` variables | New configuration |
| 10 | All | CLAUDE.md 7.2 step 5: scripted guest sentences come from the fixed table with order-insensitive matching, confirmed by the guest; the Claude path of `/api/english` is a later fallback, never used during the engagement window (no vendor keys, D8) | Reliability, privacy, prompt injection |

## 2026-10-10 (22:00), from P4: app plan revision 2 (critique passes; tiers)

`docs/app-plan.md` revision 2 and `web/lib/app/types.ts` were revised after two critique passes (stage readiness, and the Deaf guest's point of view). Section 16 of the plan logs every finding. Only Tier 0 (the loopback stage MVP) is built tonight; TLS, pairing and the header move are Tier 1 (gate G1, isolated loaner).

| # | To | What | Why |
|---|---|---|---|
| 1 | Talha | **Decide now** which Mode 0 the stage uses: guest input on the second display (`SB_PROFILE=stage MODE0_GUEST_INPUT=1`, recommended) or display-only exactly as D3. A phone or second laptop is Mode C and cannot run on this Mac | Plan 0a and 15 q1 |
| 2 | P3 (Talha) | Add a random per-process `run` id to every bridge event | Replay detection on (`run`, `seq`); until then the app treats a lower `seq` as a restart (plan 6.1) |
| 3 | P3 | Re-send the current framing status every few seconds, not only on change | The app needs the current status right after the guest taps Sign (plan 6.1) |
| 4 | P3 | Split `CENTER` into `CENTER_LEFT` and `CENTER_RIGHT`, from the guest's point of view | There is no camera preview, so "move to the middle" has no direction (plan 6.4); the app already accepts both |
| 5 | P3, Nath | `needs_repeat` is now a hint only: the app recomputes the gate, so "Did you mean...?" works for a sign at 0.45 whose own label still matches | Plan 6.3 |
| 6 | P2 (Cosme) | `preloadSigns(bundle)` is needed before gate G1; until then Mode C shows captions and cards. Should `BROWS-UP` / `BROWS-DOWN` be drawn as tokens on the guest screen at all? | Plan 14 items 7 and 8 |
| 7 | Owner of `compromised_device.md` 2.4 (AS-23) | Change "The Emergency button" to "The Get staff now button", so the button and the notice share one name. `GUEST_NOTICE` in `types.ts` already uses it; the GST-1 check compares the document text with exactly this substitution | Plan C2-14 |
| 8 | AS owner | AS-5 rotation gets a 30 s grace and moves to Tier 2; AS-8 applies on every team-owned device and not on a guest's own phone (Mode W S3b); AS-21 "silent stop_signing or prefs" becomes a neutral staff log line plus a confirmation on the guest's own screen; consider a 5-minute engagement idle limit (WCAG 2.2.1) | Plan 9.2, 9.4, 6.6 |
| 9 | Nath | The staff page plays `/api/tts` WAVs through one `AudioContext` unlocked on "Start desk" (Chrome required), and `warmUpVoice()` finishes before `live.py` starts. No change to your files | Safari autoplay and CPU contention (plan C1-16) |
| 10 | Owner of `.env.example` | Also add `SB_PROFILE`, `MODE0_GUEST_INPUT`, `VRI_CONTACT_KIND`, `VRI_CONTACT` (replacing `VRI_PHONE`) | Plan 14 item 11 |
| 11 | All | Never type `BRIDGE_KEY` inline (use `read -s` or a `0600` file); never project the terminal that prints the `#k=` staff URL | Plan OPS-12 |
## 2026-10-10, from P4 (Nath) to all: BroadcastChannel addition (CLAUDE.md 6.7), backward compatible
- New message `{ type: "staff_status", state: "idle" | "listening" | "processing" }`, sent by `/staff` around push-to-talk so `/guest` can show that the receptionist is speaking. The three 6.7 messages are unchanged.
- Types and a `useSignbridgeChannel(onMessage)` hook are in `web/lib/channel.ts`, with the turn type shared by both directions: `{ from: "staff" | "guest", text, gloss?, signs?, at }`.

## 2026-10-10, from P4 (Nath) to P1: push-to-talk recorder lives in web/components for now
`web/lib/voice/recorder.ts` and `client.ts` were still empty, so `/staff` uses `web/components/usePushToTalk.ts` (MediaRecorder webm for `/api/transcribe`, plus the browser's Web Speech recognition in parallel as the Whisper fallback) and calls `/api/transcribe` and `/api/gloss` itself. P1 can move both into `web/lib/voice/` and P4 will switch the imports.

## 2026-10-10, from P4 (Nath) to all: the demo runs hands-free on one screen, /guest (CLAUDE.md 2 and 7.1)
- `/guest` now listens to the receptionist all the time: voice activity detection cuts each utterance (`web/components/voiceListener.ts`), then `/api/transcribe`, then `/api/gloss` per sentence, then the avatar signs with karaoke captions (`useHandsFreeSpeech`). No talk button, nothing of the pipeline on screen. If Whisper has no key or fails, Chrome's continuous Web Speech recognition takes over.
- `/staff` stays as an optional operator console (push-to-talk and a text field), sending `staff_utterance` to `/guest` over the BroadcastChannel as before.
- Proposal: update CLAUDE.md 2 and 7.1 to match (one screen for staff to guest, mic on the guest laptop).

## 2026-10-10, from P4 (Nath) to P1: /api/gloss drops the second intent after a comma
Whisper often writes "Welcome, do you have a reservation?" instead of "Welcome! Do you have a reservation?". `/api/gloss` then returns `HELLO WELCOME` only, so the question is never signed. With "!" it returns both intents. Could it return every intent of a sentence (the BROWS marker can go first), or split on the commas between intents? A Whisper `prompt` with demo sentences written with full stops would also help. `/guest` already sends one `/api/gloss` request per sentence (split on . ! ?).

## 2026-10-10, from P3 to P4: streaming recognition bridge

The backend closure adds immediate `sign` events, followed by `utterance` events, plus
`framing` and `status` events. The payload examples and timestamps are in
`recognition/README.md`, section "App bridge". `live.py --post` sends each event to
`/api/guest/signs` with `X-Bridge-Key`; it sends no images or landmarks.

The draft `p4-app` plan and `web/lib/app/types.ts` still accept only a `signs` batch.
Update the receiver and its validators for these four event types during the app build.
Display each sign immediately, use the completed utterance for the confirmation step,
and never speak an utterance marked `needs_repeat`, a mock result, or a stale event
from an ended guest session. Keep the bridge loopback-only and require the configured
key. Sequence numbers restart with the recognizer process; they are not session IDs.
Bind incoming events to the active guest session and reject stale/replayed events.
The transport is best effort and drops queued events under backpressure, so account
for missing sequence numbers. The protected `/predict` Frame[] contract is unchanged.

Validation and release remain separate: the current local checkpoint is synthetic,
benchmark accuracy is unaudited, and real held-out signer recordings are still needed.
No security attack testing should run on Talha's own Mac.

## 2026-10-10, from P4 (Nath) to P3 (+ team): guest -> staff bridge is built (recognizer events to the app)
- `POST /api/guest/signs` takes the recognizer's events: `sign`, `utterance` (live_key's `{ raw, labels, text, snapped }` and live.py's `{ signs, seqs, needs_repeat }`), `framing`, `status`. Loopback only, `X-Bridge-Key` checked when `BRIDGE_KEY` is set (timing-safe). Malformed events get a 400.
- `GET /api/guest/stream` (Server-Sent Events) pushes them to `/guest` and `/staff`. On (re)connect a page first gets the current state, marked `replay`, which is never spoken again.
- `text: null` goes through `/api/english` (intents table with `LEAVE`, then Claude, then the labels as words). An utterance with `needs_repeat`, a `NONE` label, or from a `mock` recognizer is never spoken: `/guest` asks "could you sign that again?".
- `/guest` shows each sign as a tag (label + confidence), then "You said: ...", with the tip line. `/staff` shows the sentence big, the corrected labels, the raw ones in grey when they differ, and speaks it (`/api/tts`, browser voice as fallback; first click on `/staff` unlocks sound).
- Not done (demo scope): binding events to a guest session and rejecting replays. Signs are provisional (an undo sends no event); the utterance's labels are what counts.
- Run: `npm run dev` in `web/` (for a hard loopback guarantee: `npx next dev -H 127.0.0.1`, plus a `BRIDGE_KEY` in `web/.env.local` and the same in the recognizer's shell), then `python -m recognition.live_key --camera 1 --post http://127.0.0.1:3000/api/guest/signs`. Open the pages as `http://localhost:3000/guest` and `/staff`: Next dev blocks its own scripts for pages opened as `127.0.0.1` (allowedDevOrigins).

## 2026-10-10, from P4 (Nath) to all: BroadcastChannel addition `voice_output` (CLAUDE.md 6.7), backward compatible
`{ type: "voice_output", playing: boolean }`: `/staff` sends it around speaking the guest's sentence, and `/guest` mutes its hands-free microphone meanwhile, so the avatar never signs our own voice back. `/guest` also posts `staff_utterance` for what it heard, so `/staff` shows what the avatar signed.

## 2026-10-11, from P4 (talha/app-shell, the alternative app; local branch) to P3 and Nath: one recognizer contract for both apps

`talha/app-shell` merged the shared pieces of `p4-app` (tts ElevenLabs-only, LEAVE intents, P1 comma split, P3 recognition, bellhop v2) and kept its own screens. Its bridge validator now accepts exactly what `p4-app`'s `/api/guest/signs` accepts from the recognizers: `t_sent` and the sign timestamps optional, both utterance shapes (live.py `{signs, seqs?, needs_repeat?, t_end?}` and live_key.py `{raw, labels, text, snapped}`), `framing` without `since`, `status` without `fps`/`t`, and the new `capture` event. Details in `docs/app-plan.md` 6.1 "Shared contract with p4-app".

| # | To | What | Why |
|---|---|---|---|
| 1 | P3 | Please make `live_key.py` POST `{"type": "status", "recognizer": "ok" \| "no_model", "fps": ..., "t": ...}` once a second while it runs (as `stream.py` does for live.py) | Without a status the app cannot tell the recognizer is up, so it cannot offer "Sign" to the guest (consent gate, plan 6.1) |
| 2 | P3 | Optionally add `seqs` to the live_key utterance (the seqs of the signs kept after BACKSPACE) | The app then joins each label with its sign event exactly instead of matching labels from the end |
| 3 | Nath | Your receiver and this branch now agree on the inbound events; the one behavioural difference is that this branch never speaks the recognizer's `text` (fixed table only) and offers a corrected sentence as "Did you mean...?" for the guest to confirm | Confirm before speaking (CLAUDE.md 7.2) |

## 2026-10-11, from P4 (talha/app-shell builder A, local branch) to Nath, P1 and the screens: Tier 0 server routes

The alternative app now has its server routes (plan 12.1a). What changes for the routes other people own, on this branch only:

| # | To | What | Why |
|---|---|---|---|
| 1 | Nath | `/api/tts` also accepts `{ "id": n }` (a guest intent 1 to 20, not NAME). With `{ text }`, only a fixed table sentence is ever sent to ElevenLabs; any other text goes to local Piper (`PIPER_FALLBACK=1`) or gets 500. Vendor error bodies are no longer logged | RT5, no guest text to vendors (D8), SRV-12 |
| 2 | Nath, P1 | `/api/tts`, `/api/english`, `/api/gloss` and `/api/transcribe` now need the staff cookie `sb_staff` and Host `127.0.0.1:PORT` (through `lib/app/guard.ts`). Open `/p1-test` on `http://127.0.0.1:3000` after claiming the staff link the server prints | SRV-10, decision record D6: loopback alone is not authentication |
| 3 | Everyone | `npm run dev:lan` and `start:lan` are gone; `node server.mjs --lan` exits with an error | D3, SRV-2a |

## 2026-10-11, from P4 (talha/app-shell builder B, local branch) to P3: the guest screen drives live_key.py through the app server

This branch now supports the single-screen demo path from ad90509. Start `server.mjs` with `LIVE_KEY_CONTROL_PORT=8765` and the same `BRIDGE_KEY` as the recognizer, then `python -m recognition.live_key --no-preview --control-port 8765 --post http://127.0.0.1:3000/api/guest/signs`. The guest's Record / Finish / Undo buttons go to the app server, which checks consent and forwards to `127.0.0.1:8765` (the browser never calls the control port, so the open CORS on it is not used). The server's 1-second `GET /health` probe stands in for a `status` event, so request 1 of the previous table is no longer blocking when the control port is used; it is still wanted for the OpenCV-window mode.

| # | To | What | Why |
|---|---|---|---|
| 1 | P3 | Optional: have `/health` answer `no_model` (or a non-200) when the pinned model did not load | The probe cannot tell a running live_key without a model from a working one |
| 2 | P3 | Optional: emit a `capture` `{"phase": "cancelled"}` when a recording is dropped (Q, or no frames) | The guest screen's buttons otherwise wait up to 8 s before coming back |

## 2026-10-11, from P4 (talha/app-shell builder S, local branch): features plan requests

From `docs/features-plan.md` (Talha asked for these features). Nothing here changes a teammate's code on this branch.

| # | To | What | Why |
|---|---|---|---|
| 1 | Talha (decision record owner) | Amend AS-1 so the guest reconnect snapshot may also carry the current fact tiles (room, Wi-Fi, breakfast and so on, typed by staff) | Today AS-1 limits the snapshot to the last caption and the pending proposal. After a guest reconnect the tiles are gone until staff tap "Send the facts again" (`resend_facts`). With the amendment the tiles come back on their own |
| 2 | P2 | Add `rate` (0.5 to 1.5) to `playGloss` options (`PlayOptions.rate`), next to `onToken` | Guest control "avatar speed" (features-plan F5, roadmap R5). Until then the guest has size and captions-only, not speed |
| 3 | P1 | No change needed. Live captions use `/api/transcribe` only as the second backend ("Cloud: OpenAI speech-to-text"), utterance at a time, only when `OPENAI_API_KEY` is set and the profile is `stage`. The local backend (`web/stt/local_stt.py`, faster-whisper on 127.0.0.1) is P4's | Features plan section 1: local first, cloud only on an explicit choice and labelled |
| 4 | Talha | Confirm or reject the SES-11 amendment in `dad4b47` (manifest on the guest page, no service worker, no storage) | AS-3 as written forbids the manifest; the features plan keeps it (F15) only if confirmed |

## 2026-10-11, from P4 (talha/app-shell builder G, local branch) to builder S: what the guest screen now sends

The guest screen (commit `f34d9f1`) sends these, exactly as typed in `web/lib/app/types.ts`. `validate.ts` refuses them until builder S accepts them, so these taps answer 400 until then.

| # | Action | Shape |
|---|---|---|
| 1 | `guest_choice` | `choice: "tap"` (first screen and header) |
| 2 | `guest_phrase` | optional `via: "board" \| "phrase_list" \| "typed_match"` |
| 3 | `guest_reply` | `reply: "say_another_way" \| "write_number"` |
| 4 | `guest_number` | `{ about: "nights" \| "room" \| "people" \| "other", value: "1".."999999" }` |
| 5 | `ack_alert` | `{ id }` (the guest removes the alert locally at once; staff "Seen" is best effort) |
| 6 | `interpreter_request` | optional `context: { language: SignLanguage \| null, topics: boolean }`, sent only after ticking; the first request from the guest never carries it |

The guest's preview of the interpreter card uses `interpreterCard()` and `interpreterCardLines()` in `web/lib/app/guestfeatures.ts`: topics are topic words of the fixed requests the guest sent (`topicsFromIntents`), never a name, typed text or a number, and "Last request" is the guest's last fixed sentence. For the desk's banner to show exactly what the guest saw, build the staff card with the same functions.

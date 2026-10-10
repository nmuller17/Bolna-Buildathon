# SignBridge AI — Project guide for Claude Code agents

This file is the shared source of truth for the 4-person team and their Claude Code agents.
Read it fully before writing code. If something here conflicts with a request, ask the human before acting.

## 1. What we are building

SignBridge AI is a two-way interpreter between a hotel receptionist (spoken English) and a Deaf guest (ASL), running on a laptop plus a guest-facing screen at a hotel front desk.

- **Staff to guest**: the receptionist speaks, a skeleton avatar signs the sentence in ASL for the guest, with English captions.
- **Guest to staff**: the guest signs in front of a webcam, the system recognizes the signs, turns them into a natural English sentence and speaks it aloud.

**Context**: 15-hour hackathon, 4 developers, each using Claude Code.
**Goal**: a convincing LIVE demo where a team member plays a Deaf guest checking into a hotel.
**Rule of thumb**: if a feature does not appear in the demo script (section 9), do not build it.

### Honest limitations (keep them in mind, mention them in the pitch)
- Concatenating dictionary signs is closer to Signed English than full ASL grammar (no spatial grammar, limited facial grammar).
- Recognition covers a closed vocabulary of 16 isolated signs, not continuous free signing.
- Team captures are made by hearing non-native signers. Signs come from ASL dictionaries.

## 2. Architecture

```
PREPARATION (offline, H0-H3)
  Public dataset videos ──► MediaPipe (Python) ──► signs/public/*.json      (P2)
  Team webcam captures  ──► capture.py          ──► signs/team/*.json        (P2, P3)
                                                └► data/train/<SIGN>/*.json (P2, P3)
  data/train ──► train.py (PyTorch GRU) ──► recognition/models/model.pt     (P3)

LIVE: STAFF ──► GUEST
  Mic (browser) ─► /api/transcribe (Whisper) ─► /api/gloss (Claude) ─► sign lookup
  ─► sequence + transitions ─► Three.js skeleton avatar + captions (guest screen)

LIVE: GUEST ──► STAFF
  Webcam (browser) ─► MediaPipe Holistic JS ─► segmenter ─► FastAPI /predict (PyTorch)
  ─► confidence check ─► /api/english (Claude) ─► /api/tts (ElevenLabs) ─► speaker + staff screen
```

Two browser windows on the same machine: `/staff` (laptop screen) and `/guest` (external monitor facing the guest, webcam on top). They sync through a `BroadcastChannel` named `signbridge`.

## 3. Team and ownership

Each person owns specific paths. **Agents must only edit files inside their owner's paths.** If a change is needed elsewhere, write a note in `docs/requests.md` and tell your human.

| Person | Role | Owned paths |
|---|---|---|
| P1 | Speech to gloss | `web/app/api/transcribe/`, `web/app/api/gloss/`, `web/lib/voice/` |
| P2 | Sign library and avatar | `capture/`, `dictionary/`, `signs/`, `web/lib/avatar/` |
| P3 | Sign recognition | `recognition/`, `web/lib/recognition/` (shares `capture/` with P2) |
| P4 | App, TTS, integration, demo | `web/app/` (except P1 API routes), `web/app/api/english/`, `web/app/api/tts/`, `web/components/`, `docs/` |

Shared and protected: `CLAUDE.md`, section 6 contracts, `fixtures/`. Change only with team agreement.

## 4. Repository structure

```
CamelHack/
├── CLAUDE.md                     # this file
├── .env.example                  # list of required keys, no values
├── .gitignore                    # must ignore .env*, data/, *.mp4, node_modules, __pycache__
├── requirements.txt              # Python deps (mediapipe, opencv-python, numpy, torch, fastapi, uvicorn)
├── docs/
│   ├── demo-script.md            # exact demo dialogue (P4)
│   └── requests.md               # cross-team change requests
├── fixtures/                     # small shared samples so everyone can mock other modules
│   ├── sign_BREAKFAST.json       # one sign file in the SignFile format
│   ├── utterance_frames.json     # a few seconds of raw frames for recognition tests
│   └── predictions.json          # example classifier output
├── capture/                      # P2 + P3
│   ├── capture.py                # webcam recorder: video + landmarks per sign
│   ├── landmarks.py              # MediaPipe extraction + normalization (Python reference impl)
│   └── clean.py                  # trim, forward-fill missing hands, smooth
├── dictionary/                   # P2
│   ├── build_dictionary.py       # run MediaPipe on public dataset videos
│   └── word_list.txt             # words to extract
├── signs/                        # P2, committed, served to the browser
│   ├── index.json                # { "BREAKFAST": "team/BREAKFAST.json", ... }
│   ├── team/                     # our own captures (highest priority)
│   ├── public/                   # extracted from public datasets
│   └── alphabet/                 # A.json ... Z.json, 0.json ... 10.json
├── data/                         # gitignored, raw captures and training data
│   └── train/<SIGN>/<signer>_<n>.json
├── recognition/                  # P3
│   ├── features.py               # frames -> feature tensor (must match web/lib/recognition/features.ts)
│   ├── model.py                  # GRU classifier
│   ├── train.py
│   ├── server.py                 # FastAPI, POST /predict on port 8000
│   └── models/model.pt
└── web/                          # Next.js app (App Router, TypeScript)
    ├── app/
    │   ├── staff/page.tsx        # receptionist screen (P4)
    │   ├── guest/page.tsx        # guest screen: avatar + webcam (P4 layout, P2/P3 components)
    │   └── api/
    │       ├── transcribe/route.ts   # P1
    │       ├── gloss/route.ts        # P1
    │       ├── english/route.ts      # P4
    │       └── tts/route.ts          # P4
    ├── lib/
    │   ├── voice/                # P1: recorder, API client
    │   ├── avatar/               # P2: lookup.ts, sequence.ts, skeleton.ts, player.ts
    │   ├── recognition/          # P3: landmarks.ts, features.ts, segmenter.ts, client.ts
    │   └── channel.ts            # P4: BroadcastChannel helpers
    ├── components/               # P4
    └── public/signs -> ../../signs   # symlink or copy step so the browser can fetch sign files
```

## 5. Tech stack

| Need | Tool | Notes |
|---|---|---|
| Frontend | Next.js (App Router), TypeScript | Two routes, `/staff` and `/guest` |
| Speech to text | OpenAI Whisper API (`whisper-1`) | Fallback: browser Web Speech API |
| English to gloss, gloss to English | Anthropic Claude API | Server-side only, in API routes |
| Text to speech | ElevenLabs API | Fallback: browser `speechSynthesis` |
| Landmarks (offline) | MediaPipe Holistic, Python | In `capture/` and `dictionary/` |
| Landmarks (live) | MediaPipe for web (`@mediapipe/tasks-vision`) | Use HolisticLandmarker if available in the installed version, else Pose + Hand + Face landmarkers |
| Classifier | PyTorch GRU, served by FastAPI + uvicorn | `http://localhost:8000/predict` |
| Avatar rendering | Three.js | Spheres for joints, lines for bones |
| Screen sync | `BroadcastChannel("signbridge")` | Same machine, two windows |
| Public sign videos | ASL Citizen or WLASL | Check license and download size first |

### Environment variables (`web/.env.local`, never committed)
```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
RECOGNITION_URL=http://localhost:8000
```

## 6. Data contracts (PROTECTED)

These formats are how modules talk to each other. Do not change them alone.

### 6.1 Landmark frame
```ts
type Point = [number, number, number];        // x, y, z after normalization
type Frame = {
  pose: Point[] | null;   // 33 MediaPipe pose points
  lh:   Point[] | null;   // 21 left hand points
  rh:   Point[] | null;   // 21 right hand points
  face: Point[] | null;   // 26 points, indices below, in this order
};
```
Face indices (MediaPipe face mesh), in order:
`[70,63,105,66,107,336,296,334,293,300,33,133,159,145,362,263,386,374,61,291,0,17,13,14,1,152]`
(eyebrows, eyes, mouth, nose tip, chin)

### 6.2 Normalization (identical in Python `capture/landmarks.py` and TS `web/lib/recognition/features.ts`)
1. Origin = midpoint of pose points 11 and 12 (shoulders).
2. Scale = distance between pose points 11 and 12. Divide all coordinates by it.
3. Apply to pose, both hands and face.
4. Raw MediaPipe image coordinates are y-down. Keep y-down in files. The renderer flips y.
5. Any change to this procedure must be done in both languages and checked against `fixtures/utterance_frames.json`.

### 6.3 Sign file (`signs/**/*.json`)
```json
{ "id": "BREAKFAST", "source": "team", "signer": "cosme", "fps": 30, "frames": [ /* Frame[] */ ] }
```
`source` is one of `team`, `public`, `alphabet`. Files are already cleaned (trimmed, hands forward-filled, 3-frame moving average).

### 6.4 Gloss
- Array of uppercase tokens: `["BREAKFAST", "7", "TO", "10"]`
- Unknown words are fingerspelled with the prefix `FS:` → `"FS:MARRIOTT"`
- Allowed tokens = keys of `signs/index.json` plus `FS:*`

### 6.5 API routes
| Route | Request | Response | Owner |
|---|---|---|---|
| `POST /api/transcribe` | audio blob (webm) | `{ "text": string }` | P1 |
| `POST /api/gloss` | `{ "text": string }` | `{ "gloss": string[] }` | P1 |
| `POST /api/english` | `{ "signs": Prediction[] }` | `{ "text": string }` | P4 |
| `POST /api/tts` | `{ "text": string }` | `audio/mpeg` | P4 |
| `POST {RECOGNITION_URL}/predict` | `{ "frames": Frame[] }` (one segmented sign) | `{ "top": Prediction[] }` (top 3) | P3 |

```ts
type Prediction = { label: string; conf: number };   // conf in [0, 1]
```

### 6.6 Avatar player API (P2, used by P4)
```ts
playGloss(gloss: string[]): Promise<void>   // resolves when the sequence finishes
```
Lookup priority for each token: `signs/team` → `signs/public` → fingerspell via `signs/alphabet`.
Transitions: 7 linearly interpolated frames between the last frame of a sign and the first of the next. Playback at 30 fps.

### 6.7 BroadcastChannel messages
```ts
{ type: "staff_utterance", text: string, gloss: string[] }   // staff spoke, guest screen plays avatar
{ type: "guest_utterance", signs: Prediction[], text: string } // guest signed, staff screen shows text
{ type: "repeat_request" }                                    // low confidence, guest screen asks to repeat
```

## 7. Workflows in detail

### 7.1 Staff to guest
1. Staff holds the talk button on `/staff`. Browser records audio (MediaRecorder).
2. `/api/transcribe` sends audio to Whisper, returns English text.
3. `/api/gloss` calls Claude with the text and the list of allowed tokens from `signs/index.json`. Claude returns an ASL gloss using only allowed tokens, `FS:` for proper nouns and unknown words. Numbers become digit tokens.
4. `/staff` posts `staff_utterance` on the channel.
5. `/guest` calls `playGloss(gloss)`. The player loads sign files, builds one frame list with transitions, and renders it with Three.js. The English text is shown as a caption under the avatar.

### 7.2 Guest to staff
1. `/guest` runs the webcam and MediaPipe in the browser, producing one `Frame` per video frame.
2. The segmenter cuts a sign when the hands enter the signing area, and closes it when the hands pause or drop for ~0.5 s. An utterance ends after ~1.5 s with hands down.
3. Each sign segment is sent to `/predict`, which returns the top 3 predictions.
4. Confidence check (P4): if the top prediction of any sign is below **0.6** or is `NONE`, post `repeat_request` and show "Could you repeat?" on the guest screen. Stop here.
5. Otherwise `/api/english` asks Claude to turn the sign list into one natural English sentence in the hotel context.
6. `/api/tts` speaks it. `/staff` shows the sentence and the recognized signs with scores.

### 7.3 Offline preparation
- **capture.py**: shows the sign name, 3 s countdown, records 2 s, saves video (`.mp4`, gitignored, backup only) and landmarks (`.json`). Args: `--signs`, `--reps`, `--user`, `--out`.
- **Training data**: each of the 4 team members records 20 takes per guest sign (section 8.2) into `data/train/`.
- **Output signs**: one team member records the demo signs, alphabet and numbers 0 to 10 (3 takes each, keep the best) into `signs/team/` and `signs/alphabet/`.
- **Public dictionary**: `build_dictionary.py` runs MediaPipe on dataset videos for words in `word_list.txt`, normalizes, cleans, writes to `signs/public/`. Run it in the background from H1.

## 8. Vocabulary

### 8.1 Staff intents covered by the demo (all must sign correctly with team captures)
| # | Example sentence |
|---|---|
| 1 | Welcome! |
| 2 | Do you have a reservation? |
| 3 | What's your name? |
| 4 | Can I see your ID? |
| 5 | You're in room 412. |
| 6 | The elevator is on your left. |
| 7 | Breakfast is from 7 to 10. |
| 8 | The Wi-Fi password is on your key card. |
| 9 | Checkout is at 11. |
| 10 | Late checkout is fine, until 1 PM. |
| 11 | I'll send towels to your room. |
| 12 | One moment, please. |
| 13 | Sorry, can you repeat? |
| 14 | Anything else? |
| 15 | Enjoy your stay! |

Any other sentence goes through the generic gloss path (public dictionary + fingerspelling).

### 8.2 Guest signs recognized by the classifier (17 classes)
`YES, NO, RESERVATION, NAME, THANK-YOU, WHERE, ELEVATOR, WIFI, PASSWORD, BREAKFAST, TIME, TOWEL, MORE, CHECKOUT, LATE, PLEASE, NONE`
`NONE` = idle hands, scratching, random movement. Record it like any other class.
Guest names are typed on a keyboard on the guest screen, not fingerspelled.

## 9. Demo script (summary, full version in `docs/demo-script.md`)
| Staff (voice) | Guest (signs) |
|---|---|
| Welcome! Do you have a reservation? | YES RESERVATION |
| What's your name? | NAME + types name |
| You're in room 412. The elevator is on your left. | THANK-YOU, WHERE ELEVATOR |
| (answer) | WIFI PASSWORD |
| The Wi-Fi password is on your key card. | BREAKFAST TIME |
| Breakfast is from 7 to 10. | MORE TOWEL PLEASE |
| (deliberately unclear sign) | system asks to repeat, then confirms |
| A juror says a free sentence into the mic | avatar signs it via the generic path |

## 10. Timeline and checkpoints
| Time | Milestone |
|---|---|
| H0-H1 | Repo, this file, fixtures, `capture.py` working |
| H1-H3 | All captures done, dictionary extraction running in background |
| H3-H6 | Each module works alone against fixtures and mocks |
| **H6** | **Checkpoint 1**: merge to main. Each module demoed alone. Cut scope if something fails |
| H6-H10 | End-to-end integration, staff to guest first, then guest to staff |
| **H10** | **Checkpoint 2**: full demo script runs end to end |
| H10-H13 | Error handling, visuals, generic gloss path |
| **H13** | **Checkpoint 3**: record a full backup video of the demo, freeze features |
| H13-H15 | Rehearsal, pitch |

## 11. Git workflow
- GitHub repo: `github.com/nmuller17/CamelHack`.
- Branches: `p1-voice`, `p2-avatar`, `p3-recognition`, `p4-app`. Never commit directly to `main`.
- Merge into `main` at checkpoints (H6, H10, H13), via pull request, after pulling `main` into your branch first.
- Small, frequent commits with clear messages: `avatar: add transition interpolation`.
- Never commit `.env*`, `data/`, `*.mp4`, model checkpoints over 50 MB.

### Setup commands
```bash
git clone https://github.com/nmuller17/CamelHack.git  # download the repo
cd CamelHack
python3 -m venv .venv && source .venv/bin/activate   # Python virtual env
pip install -r requirements.txt                       # Python deps for capture, dictionary, recognition
cd web && npm install                                 # JS deps for the Next.js app
cp ../.env.example .env.local                         # then fill in API keys
npm run dev                                           # app on http://localhost:3000
# in another terminal, from repo root:
uvicorn recognition.server:app --port 8000 --reload   # classifier server
```

## 12. Rules for agents
1. Stay inside your owner's paths (section 3). Do not refactor other people's code.
2. Never change section 6 contracts on your own. Propose changes in `docs/requests.md`.
3. Develop against `fixtures/` and simple mocks so you are never blocked by another module.
4. Keep Python normalization (`capture/landmarks.py`, `recognition/features.py`) and TS normalization (`web/lib/recognition/features.ts`) strictly identical.
5. API keys stay server-side (Next.js API routes). Never expose them to the browser.
6. Prefer the simplest working solution. This is a 15-hour demo, not production.
7. Every live step needs a fallback: Web Speech API for Whisper, `speechSynthesis` for ElevenLabs, MP4 playback for the avatar, manual retry for recognition.
8. Do not build features outside the demo script without asking your human.
9. When you finish a task, update the relevant part of this file only if your human agrees.

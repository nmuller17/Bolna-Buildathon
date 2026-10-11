# SignBridge

**A front-desk communication aid between a hearing hotel receptionist and a Deaf guest.**
The receptionist talks and a 3D bellhop signs it in American Sign Language (ASL), with captions. The guest signs
back in front of a webcam, and the laptop says the answer out loud. One laptop, one screen facing the guest; the
receptionist has no screen to look at.

Built in 15 hours at CamelHack (October 2026) by Maya, Cosme, Roni, Talha and Nath.

> **Run the demo:** [docs/DEMO.md](docs/DEMO.md) (setup, two commands, script, stage checklist, troubleshooting).

---

## The conversation loop

```
FRONT DESK TURN                                   GUEST TURN
receptionist holds Space and talks                camera frame turns green: "Your turn"
  -> Whisper transcript                             -> the guest signs a whole sentence, then rests the hands
  -> ASL gloss (+ the receptionist's intent)        -> MediaPipe landmarks -> sign classifier (sliding windows)
  -> the bellhop signs it, karaoke captions         -> the closest expected answer: "Could I have more towels, please?"
                                                    -> spoken out loud (ElevenLabs) and shown ("You said: ...")
          \___________________ back to the front desk ___________________/
```

The screen always shows the bellhop, the captions and the guest's own camera feed. The microphone is muted for the
whole guest turn.

### Example

| Receptionist says | Bellhop signs (gloss) | Guest signs | Laptop says |
|---|---|---|---|
| Welcome! Do you have a reservation? | HELLO WELCOME · *(brows up)* YOU HAVE RESERVATION | YES · NAME · S-A-M | Yes, my name is Sam. |
| Checkout is at 11. | LEAVE TIME 11 | LATE · LEAVE · PLEASE | Could I have a late checkout? |

The full 10-step demo script and the jury Q&A mode are in [docs/DEMO.md](docs/DEMO.md).

---

## How it works

### Receptionist -> guest (speech to signs)

1. **Push-to-talk** (`web/components/usePushToTalk.ts`): Space held records the laptop's built-in microphone only,
   so the noise of the room is never transcribed. An always-on mode exists (`?handsfree=1`).
2. **Speech to text**: OpenAI Whisper (`/api/transcribe`), with Chrome's speech recognition as fallback.
3. **Text to gloss** (`/api/gloss`, `web/lib/voice/intents.ts`): the 20 hotel sentences of
   [docs/vocabulary.md](docs/vocabulary.md) are recognized by keywords **and** by resemblance to the vocabulary
   sentence, then glossed carefully (word order, numbers, `BROWS-UP`/`BROWS-DOWN` facial markers for questions).
   Any other sentence is glossed word by word: known signs, synonyms and plurals, numbers, and unknown words
   fingerspelled (`FS:WORD`).
4. **Avatar** (`web/lib/avatar/`): the bellhop is a rigged 3D model (Tripo mesh, Mixamo skeleton with 3 phalanges
   per finger). It replays signs the team recorded with MediaPipe (`signs/`, 87 signs: 49 words, digits 0-11,
   letters A-Z), with interpolated transitions, retargeted onto the skeleton (two-bone arm IK, wrist from the
   knuckle basis, each phalanx aimed at the next landmark).

### Guest -> receptionist (signs to speech)

1. **Capture** (`recognition/live_key.py`): the recognizer owns the webcam, serves the live preview to the page
   (MJPEG), and records the guest's turn when the page asks for it (`POST /turn`). The turn ends when the hands
   rest for 2.5 s.
2. **Landmarks**: MediaPipe Holistic (pose, both hands, 26 face points), normalized on the shoulders
   (`capture/landmarks.py`, `capture/clean.py`), exactly as for the training data.
3. **Classifier** (`recognition/model.py`, `recognition/models/model.pt`): 22 classes (21 signs + NONE), trained on
   **1,320 takes** recorded by the 5 team members (12 per sign each, `capture/train_session.py`).
4. **Continuous sentences** (`recognition/sentence.py`): no cutting into words. Sliding 1 s windows are scored,
   then each candidate guest sentence is aligned on the window probabilities (monotonic dynamic programming) and
   the best one wins, so the sentence context fixes doubtful signs.
5. **Guided by the question** (`web/lib/voice/expectedAnswers.ts`): after each receptionist sentence the app sends
   the answers that make sense ("Do you have a reservation?" -> YES / NO / YES RESERVATION / YES NAME); in script
   mode, one answer per step.
6. **Voice**: ElevenLabs (`/api/tts`), with the browser's voice as fallback.

### Turn-taking

`web/lib/turns.ts` is a small, tested state machine: front desk -> requesting -> guest -> speaking -> front desk,
with timeouts if the recognizer does not answer. `app/page.tsx` runs its side effects.

---

## Results

| Measure | Result |
|---|---|
| Isolated signs, leave-one-signer-out (5 signers, baseline model) | **89.8 %** right, 97.1 % in the top 3, wrong sign spoken 4.0 % |
| Continuous sentences, held-out signer (model trained without them, 200 simulated sentences) | **≈ 90 %** right sentences |
| Live rehearsal, 8 scripted guest sentences signed by a team member, **no guidance** | **8 / 8** right (the signer is in the training data) |
| Live, guided by the script | cannot fail by design |

Reports: `recognition/reports/benchmark_team5.md`. During the demo, the guest recognition is guided by the
conversation script, and we say so.

---

## Honest limitations

- The guest can only say the **22 sentences** of the vocabulary (plus simple YES / NO / THANK-YOU answers to the
  jury): this is not free ASL translation.
- Chaining dictionary signs is closer to **Signed English** than to real ASL grammar (no use of signing space,
  limited facial grammar).
- The signs were recorded by **hearing, non-native signers** from ASL dictionaries (Lifeprint, Handspeak). A real
  product must be designed with Deaf people and native signers.
- The classifier was trained on 5 people; accuracy on new people, lighting and cameras will be lower.
- Speech-to-text and the voice use cloud services (OpenAI, ElevenLabs); the sign video never leaves the laptop
  (only landmarks are processed, locally).

---

## Repository

```
web/                    Next.js app (TypeScript): the single screen at "/"
  app/page.tsx            the demo screen (avatar, turns, push-to-talk, camera, voice)
  app/api/                transcribe (Whisper), gloss, english, tts (ElevenLabs), guest/signs + guest/stream (recognizer events)
  lib/avatar/             the bellhop: loader, retargeting, sequence of signs, captions
  lib/voice/              intents.ts (text -> gloss + intent), expectedAnswers.ts (answers per question, demo script)
  lib/turns.ts            turn-taking state machine
  public/avatar/          bellhop.glb (rigged)
recognition/            sign recognition (Python)
  live_key.py             live recognizer used in the demo (camera, turns, preview, events to the app)
  sentence.py             continuous sentence decoding;  intents.py  the guest sentences
  model.py, train.py, benchmark.py, server.py ...   classifier, training, evaluation, HTTP server
  models/model.pt         demo model (pinned in model_pin.py)
capture/                recording tools: capture.py (avatar signs), train_session.py (training takes), reference videos
signs/                  recorded signs played by the avatar (team/, alphabet/, index.json)
assets/avatar/          source 3D files of the bellhop (v1, v2)
docs/                   DEMO.md, vocabulary.md, requests.md (cross-team notes)
data/                   local only (gitignored): training takes, videos, rehearsal logs
CLAUDE.md               original project guide and data contracts
```

Not used by the final demo but kept: `recognition/live.py` and `live_window.py` (earlier live paths),
`web/app/avatar-preview` (avatar test page), `web/app/p1-test` (speech-to-gloss test page), `dictionary/`.

---

## Quick start

```bash
python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd web && npm install && npm run dev                      # http://localhost:3000/?script=1
python -m recognition.live_key --camera 1 --no-preview --control-port 8765 \
       --post http://127.0.0.1:3000/api/guest/signs     # second terminal, repo root
```

API keys go in `web/.env.local` (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`); never commit it.
Details and stage checklist: [docs/DEMO.md](docs/DEMO.md).

### Retraining the classifier

```bash
python capture/train_session.py --users <name> --reps 12     # record (each person, own laptop)
python -m recognition.benchmark --data data/train --tag team --no-open-set --no-latency
python -m recognition.train --data data/train --refit-all --model baseline
python -m recognition.pin_model recognition/models/model.pt  # pin the new model
```

---

## Team

| Role | Who |
|---|---|
| Speech to gloss (Whisper, receptionist intents) | Maya |
| Sign capture, avatar signs, training data, sentence recognition, demo app | Cosme |
| Avatar rendering and retargeting, app shell, voice | Nath |
| Sign classifier, recognition server, benchmarks | Talha, Roni |

Everyone recorded training data. License: MIT ([LICENSE](LICENSE)).

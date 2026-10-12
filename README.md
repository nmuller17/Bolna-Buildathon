# ConversAI

> 🏆 **Winner of CamelHack 2026.** ConversAI was built in 15 hours by Maya, Cosme, Roni, Talha and Nath during the
> CamelHack 2026 hackathon (October 2026), where it took first place.

**A two-way front-desk interpreter between a hearing hotel receptionist and a Deaf guest who signs in American Sign
Language (ASL).** The receptionist speaks and a 3D bellhop signs the sentence in ASL, with captions. The guest signs
back in front of a webcam, and the laptop says the answer out loud.

> **Run the demo:** [docs/DEMO.md](docs/DEMO.md) (setup, commands, demo script, troubleshooting).

---

## Goal

At a hotel front desk, a Deaf guest and a receptionist who does not sign usually fall back on pen and paper.
ConversAI lets them hold a short check-in conversation, each in their own language, on one laptop with one screen
facing the guest:

- **Receptionist -> guest (speech to signs):** speech is transcribed, turned into an ASL gloss, and signed by an
  avatar with karaoke captions.
- **Guest -> receptionist (signs to speech):** the guest's signing is recognized from body and hand landmarks,
  turned into a natural English sentence, and spoken.

The scope is deliberately narrow: the hotel check-in conversation in [docs/vocabulary.md](docs/vocabulary.md)
(21 receptionist sentences, plus any other sentence through a generic path; 22 guest sentences built from 21 signs).
It is a working demonstrator, not a general ASL translator (see [Limitations](#limitations)).

## How it works

```
RECEPTIONIST -> GUEST                                  GUEST -> RECEPTIONIST
push-to-talk audio                                     webcam (the guest signs a whole sentence)
  -> Whisper: English text                               -> MediaPipe Holistic: landmarks (video stays local)
  -> rules: ASL gloss + receptionist intent              -> sign classifier on sliding 1 s windows
  -> recorded signs, chained with transitions            -> best matching expected answer (sentence decoding)
  -> 3D bellhop signs it, karaoke captions               -> English sentence -> ElevenLabs voice + "You said: ..."
             \___________________ turn-taking state machine (web/lib/turns.ts) _________________/
```

What the receptionist says also tells the app which answers to expect from the guest ("Do you have a reservation?"
-> YES / NO / YES RESERVATION...), which guides the recognition.

---

## Models

| Step | Model | Kind | Runs on | Fallback |
|---|---|---|---|---|
| Receptionist speech -> text | OpenAI **Whisper** `whisper-1` | speech recognition | OpenAI API | Chrome Web Speech API |
| English text -> ASL gloss | *no ML model*: rules in `web/lib/voice/intents.ts` | keyword + similarity matching | Next.js server | word by word, fingerspelling |
| Gloss -> signing avatar | 87 recorded signs + **bellhop** 3D model (Tripo mesh, Mixamo rig) | animation retargeting | browser (Three.js) | none needed |
| Guest video -> landmarks | Google **MediaPipe Holistic Landmarker** (float16) | pose, hand and face landmarks | laptop CPU | none |
| Landmarks -> signs | ConversAI **sign classifier** (logistic regression, trained by the team) | 22-class classifier | laptop CPU (PyTorch) | none |
| Signs -> guest sentence | continuous decoding over the expected sentences | dynamic programming, no training | laptop | none |
| Unknown sign sequence -> English | Anthropic **Claude** `claude-haiku-5-5` | language model | Anthropic API | sign words read in order |
| English -> speech | **ElevenLabs** `eleven_flash_v2_5`, voice "Sarah" | text to speech | ElevenLabs API | browser voice; optional local Piper |

### Speech to text: Whisper

`/api/transcribe` sends the push-to-talk recording (webm) to OpenAI Whisper (`whisper-1`, English). If there is no
key or the call fails, Chrome's built-in speech recognition, running in parallel, provides the text.

### Text to gloss: rules, not a language model

`/api/gloss` (`web/lib/voice/intents.ts`) recognizes the 21 hotel sentences of the vocabulary by keywords and by
resemblance, and returns their hand-checked gloss: ASL word order, digits, and a `BROWS-UP` / `BROWS-DOWN` facial
marker for questions. Any other sentence is glossed word by word: known signs, synonyms and plurals, numbers, and
unknown words fingerspelled (`FS:WORD`). Rules were preferred to an LLM here: the output is predictable, instant,
and can only contain signs the team actually recorded.

### Avatar: recorded signs on a rigged 3D bellhop

- **Signs** (`signs/`): 87 recordings made by the team with MediaPipe (49 words, digits 0-11, letters A-Z), in the
  landmark format of [CLAUDE.md](CLAUDE.md) section 6. The player chains them with 7 interpolated transition frames
  and plays them at 30 fps (`web/lib/avatar/sequence.ts`, `player.ts`).
- **Bellhop** (`web/public/avatar/bellhop.glb`, sources in `assets/avatar/`): a mesh generated with Tripo, rigged
  with Mixamo (65 bones, 3 phalanges per finger). Every frame, the landmarks are retargeted onto the skeleton:
  two-bone IK for the arms (scaled to the bellhop's short arms and kept in front of its body), wrist orientation
  from the knuckles, each phalanx aimed at the next landmark (`web/lib/avatar/bellhop.ts`).
- Two procedural styles kept for comparison on `/avatar-preview`: *hologram* (glowing skeleton) and *concierge*
  (Sam, a toon receptionist built from Three.js shapes).

### Landmarks: MediaPipe Holistic

Google MediaPipe Holistic Landmarker (`holistic_landmarker.task`, float16, `mediapipe` 1.1.0) runs on the laptop
CPU and returns 33 pose points, 21 points per hand and the face mesh, of which 26 points are kept (brows, eyes,
mouth, nose, chin). Every frame is normalized on the shoulders (origin = shoulder midpoint, unit = shoulder width),
exactly the same way for the avatar signs, the training data and the live guest (`capture/landmarks.py`). Only
these coordinates reach the classifier: the guest's video never leaves the laptop.

### Sign classifier

`recognition/model.py`, trained on **1,320 takes**: 22 classes (21 signs + `NONE` for idle or random movement) x
12 takes x 5 team members, recorded with `capture/train_session.py`.

- **Features** (`recognition/features.py`): 141 numbers per frame (hand positions and shapes, upper body, nose; the
  face is not used), resampled to 32 time steps.
- **Two models**, both in `model.py`:
  - `Baseline`: multinomial logistic regression on per-take statistics of each feature (mean, standard deviation,
    min, max, plus the mean of each third of the take so it sees the direction of movement), fitted with L-BFGS.
  - `SignGRU`: 2-layer bidirectional GRU (128 units) over the features and their velocity, mean + max pooling.
- **Benchmark**, leave-one-signer-out over the 5 signers (`recognition/reports/benchmark_team5.md`):

  | Model | Top-1 accuracy | Top-3 accuracy |
  |---|---|---|
  | Baseline (shipped) | **89.8 %** | 97.1 % |
  | Bidirectional GRU | 88.0 % | 97.0 % |

  The baseline is as accurate, smaller and faster, so it is the demo model (`recognition/models/model.pt`).
- **Calibration**: a temperature fitted on a held-out signer softens overconfident probabilities and is never
  allowed to sharpen them.
- **Safety**: the server loads weights only, and the checkpoint is pinned by its SHA-256 in
  `recognition/model_pin.py`.

### Continuous sentences

The guest signs a whole sentence without pausing between signs, so there is no cutting into words
(`recognition/sentence.py`). The classifier scores sliding 1 s windows (one every ~0.13 s). Each expected guest
sentence is aligned on that sequence of probabilities (monotonic alignment, dynamic programming), and the best
sentence wins: the sentence context fixes doubtful signs. The candidates are the answers that make sense after the
receptionist's last sentence (`web/lib/voice/expectedAnswers.ts`).

### Signs to English: fixed sentences first, Claude as fallback

Recognized guest sentences map to fixed English sentences ("MORE TOWEL PLEASE" -> "Could I have more towels,
please?"). Only a sign sequence that matches no known sentence goes to `/api/english`, which asks Claude
(`claude-haiku-5-5`) for one natural first-person sentence in the hotel context, and falls back to reading the sign
words in order.

### Text to speech: ElevenLabs

`/api/tts` returns WAV audio from ElevenLabs (`eleven_flash_v2_5`, premade voice "Sarah"), cached in memory. If
it does not answer within 2.5 s, the browser's own voice speaks. A local, offline Piper voice
(`en_US-lessac-medium`) can be turned on with `PIPER_FALLBACK=1`.

---

## Repository structure

```
web/                     Next.js app (TypeScript): the single demo screen at "/"
  app/page.tsx             demo screen: avatar, turns, push-to-talk, guest camera, voice
  app/api/                 transcribe (Whisper), gloss (rules), english (Claude), tts (ElevenLabs),
                           guest/signs + guest/stream (events from the recognizer)
  app/avatar-preview/      avatar test page (bellhop, concierge, hologram)
  lib/avatar/              sign lookup, sequencing, landmark solver, bellhop retargeting, other styles
  lib/voice/               intents.ts (text -> gloss + intent), expectedAnswers.ts (answers per question)
  lib/turns.ts             turn-taking state machine (tested)
  components/              captions, guest camera slot, push-to-talk and voice hooks
  public/avatar/           bellhop.glb (rigged)
recognition/             sign recognition (Python)
  live_key.py              live recognizer used in the demo: camera, guest turns, preview, events to the app
  features.py, model.py    features, classifier models
  train.py, benchmark.py   training, leave-one-signer-out evaluation (reports/)
  sentence.py, intents.py  continuous sentence decoding, guest sentences
  server.py                HTTP /predict server
  models/model.pt          demo model, pinned in model_pin.py
capture/                 recording tools: train_session.py (training takes), capture.py (avatar signs),
                         landmarks.py + clean.py (MediaPipe extraction, normalization), reference videos
signs/                   recorded signs played by the avatar: team/, alphabet/, index.json
assets/avatar/           source 3D files of the bellhop
docs/                    DEMO.md, vocabulary.md (all signs and sentences), demo-script.md, requests.md
fixtures/                small shared samples for testing modules in isolation
data/                    local only (gitignored): training takes, videos
CLAUDE.md                original project guide and data contracts (landmark frame, sign file, gloss, APIs)
```

Kept but not used by the final demo: `recognition/live.py` and `live_window.py` (earlier live paths),
`web/lib/recognition/` (in-browser MediaPipe), `web/app/p1-test` (speech-to-gloss test page), `dictionary/`.

## Getting started

```bash
python3.12 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd web && npm install && npm run dev                       # http://localhost:3000/?script=1
# second terminal, repo root:
python -m recognition.live_key --camera 1 --no-preview --control-port 8765 \
       --post http://127.0.0.1:3000/api/guest/signs
```

API keys go in `web/.env.local` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`) and are never committed. Full instructions: [docs/DEMO.md](docs/DEMO.md). Recording
training data: [capture/README.md](capture/README.md). Training and evaluating the classifier:
[recognition/README.md](recognition/README.md).

## Limitations

- The guest can only use the 21 signs and 22 sentences of the vocabulary: this is not free ASL translation.
- Chaining dictionary signs is closer to Signed English than to real ASL grammar (no signing space, limited facial
  grammar).
- Signs were recorded by hearing, non-native signers from ASL dictionaries (Lifeprint, Handspeak). A real product
  must be designed with Deaf people and native signers.
- The classifier was trained on 5 people; accuracy on new people, lighting and cameras will be lower. During the
  demo, recognition is guided by the conversation script, and we say so.
- Speech to text and the voice use cloud services (OpenAI, ElevenLabs, and Claude as a fallback); the guest's video
  is processed locally and never sent anywhere.

## Team

| Role | Who |
|---|---|
| Speech to gloss (Whisper, receptionist intents) | Maya |
| Sign capture, avatar signs, training data, sentence recognition, demo app | Cosme |
| Avatar rendering and retargeting, app shell, voice | Nath |
| Sign classifier, recognition server, benchmarks | Talha, Roni |

Everyone recorded training data. License: [PolyForm Noncommercial 1.0.0](LICENSE): free for noncommercial use (personal, study, research, nonprofit and education).
For commercial use, contact muller17@mit.edu.

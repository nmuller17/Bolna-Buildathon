# Running the ConversAI demo

One laptop, one screen facing the Deaf guest. The receptionist has no screen: they hold **Space** while talking,
the bellhop avatar signs it, then the guest answers in ASL in front of the webcam and the laptop says the answer
out loud.

## 1. Setup (once per laptop)

```bash
git clone https://github.com/nmuller17/CamelHack.git && cd CamelHack     # or: git switch main && git pull
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd web && npm install && cd ..
```

API keys in `web/.env.local` (never commit it; `.env*` is gitignored):

```
OPENAI_API_KEY=sk-...          # Whisper: transcribes the receptionist
ELEVENLABS_API_KEY=sk_...      # the voice that says the guest's answer
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
```

Without them it still runs: Chrome's speech recognition and the browser's voice take over.
The recognition model (`recognition/models/model.pt`) is in git and pinned by `recognition/model_pin.py`.

## 2. Start (two terminals, from the repo root)

```bash
# Terminal 1: the app
cd web && npm run dev

# Terminal 2: the sign recognizer (webcam, no window)
source .venv/bin/activate
python -m recognition.live_key --camera 1 --no-preview --control-port 8765 \
       --post http://127.0.0.1:3000/api/guest/signs
```

Open **http://localhost:3000/?script=1** in **Chrome**, click **Start**, allow the microphone.
The guest's camera feed must show at the bottom right; if it says "Camera offline", check terminal 2.

## 3. During the demo

- **Receptionist:** hold **Space**, say the sentence, release. The bellhop signs it with captions.
- **Guest:** when "Your turn" shows and the camera frame turns **green**, sign the whole sentence in one go,
  then rest the hands **out of the picture** for 2.5 s. The answer appears ("You said: ...") and is spoken.
- **R** restarts the script at step 1. The corner shows `guided · step x/4`, then `Q&A`.

### The script (`?script=1`, one expected answer per step: the translation cannot fail)

| # | Receptionist says | Guest signs | Laptop says |
|---|---|---|---|
| 1 | Welcome! Do you have a reservation? | YES · NAME · S-A-M | Yes, my name is Sam. |
| 2 | Sam, you're in room 412. Here is your key card. | THANK-YOU · WHERE · ELEVATOR | Thank you. Where is the elevator? |
| 3 | The elevator is on your left. | FS-WIFI · PASSWORD | What's the Wi-Fi password? |
| 4 | Thank you. | THANK-YOU | Thank you. |

The reference video of each guest sign is in `capture/reference/`.

### After the script (corner shows `Q&A`)

The receptionist (or a team member repeating a juror's question) keeps talking with Space held.

- **Classic front-desk sentences keep a fixed answer** (`CLASSIC_ANSWERS` in `web/lib/voice/expectedAnswers.ts`):

  | Receptionist says | Guest signs | Laptop says |
  |---|---|---|
  | Can I see your ID? | YES | Yes. |
  | The Wi-Fi password is on your key card. | BREAKFAST · TIME | What time is breakfast? |
  | Breakfast is from 7 to 10. | LEAVE · TIME | What time is checkout? |
  | Checkout is at 11. | LATE · LEAVE · PLEASE | Could I have a late checkout? |
  | Late checkout is fine, until 1 PM. | MORE · TOWEL · PLEASE | Could I have more towels, please? |
  | I'll send towels to your room. Anything else? | NO · THANK-YOU | No, that's all, thank you. |
  | Enjoy your stay! | (no guest turn) | |

  The four script sentences keep their answers too if they are said again.
- **Any other question** (e.g. from the jury): the guest answers with a simple sentence: **YES**, **NO**,
  **THANK-YOU**, or a guest sentence on the topic of the question (taxi, help, name, breakfast, towels, room...).
- **A remark that is not a question** gets no guest turn.

Without `?script=1` the answer is chosen among the answers that make sense after the question
(`web/lib/voice/expectedAnswers.ts`), not forced: that is the real recognition. Tell the jury the demo's guest
recognition is guided by the conversation script.

## 4. Checklist before going on stage

- **AirPods off / disconnected** (they become the default mic and speaker). The app picks the MacBook mic, but
  sound output must be the laptop speakers.
- **iPhone away** or Continuity Camera off (it can take camera index 0). Camera 1 = FaceTime HD on Cosme's Mac.
- Guest framed head to waist, light in front, plain background, hands resting **below the picture**.
- One full run of the script, then **R**.
- Backup video of a full run on the desktop.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `mic: blocked` (bottom left) | Chrome address bar icon -> Microphone -> Allow, reload |
| Nothing happens when talking | hold Space **before** speaking, release **after**; check System Settings -> Sound -> Input |
| "Camera offline" | terminal 2 stopped: run it again; try `--camera 0` |
| Bellhop signs random sentences | someone else was talking during Space: say it again |
| No voice | click the page once (Start); check the output device |
| Script out of sync | press **R** and restart from step 1 |

## How it works (one paragraph)

Receptionist -> guest: push-to-talk audio -> Whisper (`/api/transcribe`) -> gloss + intents (`/api/gloss`,
`web/lib/voice/intents.ts`) -> the bellhop plays recorded MediaPipe sign captures (`signs/`, 87 signs, unknown
words fingerspelled). Guest -> receptionist: `recognition/live_key.py` records the guest's turn with MediaPipe
Holistic, scores sliding 1 s windows with the classifier trained on the team's 1,320 takes, aligns the expected
guest sentences on them (`recognition/sentence.py`), and posts the sentence to the app, which speaks it
(`/api/tts`). Turn-taking: `web/lib/turns.ts`.

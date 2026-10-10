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

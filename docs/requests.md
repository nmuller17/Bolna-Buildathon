# Cross-team change requests

One entry per request: date, from, to, what, why.

- 2026-10-10, from P4 (Nath), to all: text to speech switched from ElevenLabs to **Piper** (local, free, offline, no API key). `/api/tts` now returns `audio/wav` instead of `audio/mpeg`. `piper-tts` added to `requirements.txt`, voice files go in `voices/` (gitignored), env var `PIPER_VOICE` replaces `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`. CLAUDE.md updated accordingly. Why: no API key or credits, works without internet during the demo.
- 2026-10-10, from P4 (Nath), to all: text to speech is back on **ElevenLabs** as the main voice, with **Piper kept as an automatic backup** (then browser `speechSynthesis`). The `/api/tts` contract is unchanged: `{ text }` -> `audio/wav`. New env vars in `web/.env.local`: `ELEVENLABS_API_KEY` (ask Nath, never commit it) and `ELEVENLABS_VOICE_ID`; `PIPER_VOICE` is still needed for the backup. CLAUDE.md section 5 explains the setup. Why: ElevenLabs sounds much better and answers in ~0.3 s, while Piper keeps the demo working offline.

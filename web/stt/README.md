# Live captions on this laptop (`web/stt/`)

Live captions of the receptionist's speech, "On this laptop" (docs/features-plan.md F3). This is the first backend in the caption chain; the others are OpenAI through P1's `/api/transcribe` (only with a key, only in the `stage` profile), the browser's own speech recognition (only after the staff screen shows that the audio goes to Google or Apple), and typing, which is always there. The badge on both screens names the backend in use.

## How the audio travels

Staff microphone → staff page (AudioWorklet, 16 kHz PCM, energy gate) → `POST 127.0.0.1:3000/api/staff/stt` (staff cookie) → `POST 127.0.0.1:<LOCAL_STT_PORT>/transcribe` (`X-STT-Key`) → faster-whisper on the CPU → words back to the app → hygiene (NFKC, card numbers hidden) → `live_caption` events to both screens.

Nothing leaves the laptop. The guest page has no microphone. Audio and text are never written to disk and never logged.

## Install (once)

```bash
uv venv --python 3.13 /Users/trehman/.venvs/signbridge-stt          # its own venv, never the recognizer's
VIRTUAL_ENV=/Users/trehman/.venvs/signbridge-stt uv pip install -r web/stt/requirements.txt
```

The model `Systran/faster-whisper-small.en` must already be in `~/.cache/huggingface`. The process sets `HF_HUB_OFFLINE=1` and `HF_HUB_DISABLE_TELEMETRY=1` itself and opens the model with `local_files_only=True`, so it never downloads anything. If the model is missing it exits with a message and the captions badge stays on "Typed"; it never switches to a cloud backend by itself.

## Run

`scripts/demo.sh` starts it when the venv exists (`--no-stt` skips it, `--stt-port` changes the port, default 8790) and stops it by PID. By hand:

```bash
export LOCAL_STT_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"   # environment only
/Users/trehman/.venvs/signbridge-stt/bin/python web/stt/local_stt.py --port 8790 --no-parent-watch
# then start the app with LOCAL_STT_PORT=8790 and the same LOCAL_STT_KEY in its environment
```

## Hardening

- Binds `127.0.0.1` only; `--host` anything else exits.
- `X-STT-Key` on every request (at least 32 characters, from the environment, compared with `hmac.compare_digest`); a request with an `Origin` header or a foreign `Host` is refused.
- `POST /transcribe`: `Content-Type: application/octet-stream`, `Content-Length` required (411), at most 960 000 bytes (413), even length; at most 15 s of audio is decoded.
- One decoder thread, a queue of 2 (503 "busy" when full; the app drops interim requests, never finals), at most 8 open connections, a 10 s socket timeout.
- No request log (`log_message` is a no-op). Text is NFKC-normalised and control characters are removed before it is returned.
- Exits on SIGTERM/SIGINT and when its parent process is gone.

## Measured speed (2026-10-11, this Mac, int8 on the CPU, 4 threads)

The 20 receptionist sentences, rendered with macOS `say` at 16 kHz and sent whole: decode median 1539 ms, worst 1736 ms. Growing prefixes every 0.7 s (the interim pattern, 27 requests): median 1531 ms, worst 1785 ms. Decode time hardly depends on the utterance length (the encoder pads to 30 s), so the first words reach the guest about 1.5 to 2.3 s after speech starts, and the final line about 2 to 3.5 s after speech ends. 19 of 20 transcripts matched word for word; the others differed in punctuation or spacing only ("keycard", "10 p.m."). These are synthetic voices in a quiet room, not a lobby: accuracy with real staff voices and lobby noise has not been measured.

## Tests

```bash
python3 -m unittest web/stt/test_local_stt.py   # stub model; no venv needed
```

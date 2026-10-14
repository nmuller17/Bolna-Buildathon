# recognition/vlm — local vision-language model tools

This package tries four ways of using a vision-language model (VLM) in SignBridge. The idea comes
from ProtoCopilot (BroadHacks 2026), which compared Claude Opus 4.8 with a local Qwen2.5-VL using
one shared prompt. Everything here runs on the laptop with a small open model through Apple's
MLX library. The short verdict is that the local model does not read ASL well enough for the
live product. The one tool worth shipping, the "check my takes" QC tool, uses hand landmarks and
needs no model at all. The plain-language results for Talha are in
`/Users/trehman/CamelHack-handoff/VLM_RESULTS.md`.

## Privacy rules (read first)

1. **Guest video never leaves the laptop.** The product path may only use `LocalVLM`.
   `Fallback` refuses any engine that is not the local one, and nothing in this package creates a
   `ClaudeVLM`.
2. **Loading the model is offline.** `LocalVLM.load()` reads the model from the local Hugging Face
   cache at a pinned revision (`PINNED_REVISIONS`, Qwen3-VL-4B at `2fd8dacbdb8f…`). It also sets
   `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` before the Hugging Face libraries are
   imported. Without this, the review saw the load open `CONNECT huggingface.co:443` on every
   start. No video was sent, but a hotel captive portal could make the load crash, and an online
   update could change the model. After the fix, a load plus 2 inference calls with no offline
   variables set by the caller showed 0 network events: 0 Python socket audit events, 0 proxy
   requests, and no internet sockets in `lsof`. The product launcher should still export both
   variables before Python starts, in case some other module imports `huggingface_hub` first.
   Downloading a model is a deliberate, separate step: `SIGNBRIDGE_VLM_ALLOW_DOWNLOAD=1` or
   `LocalVLM(allow_download=True)`.
3. **`ClaudeVLM` is for consenting team clips in benchmarks only.** It refuses to start without
   `ANTHROPIC_API_KEY`, and also refuses without `consent_team_clips_only=True`. It prints
   "video leaves the laptop" when created and on every call. It has never been run here, because
   no API key is set.
4. **Frames stay in memory.** The fallback's `FrameRing` keeps about 4 s of downscaled frames in
   RAM (about 40 MB), never writes them to disk, and is cleared when the guest session ends. The
   `fallback` event that reaches the app carries words only, never frames.

## Machine rules

- **One inference at a time.** Both engines hold an exclusive `fcntl` lock on
  `/tmp/signbridge_vlm.lock` around every generate call.
- **One loaded model at a time.** `LocalVLM` holds `/tmp/signbridge_vlm_resident.lock` for as long
  as a model is loaded. The laptop has 16 GB, and the model needs about 4.3 GB at peak. When two
  processes each kept their own copy, model time inside the inference lock was p50 36.9 s
  (n=218 calls), against 8.0 s with only one copy loaded (n=274). Those hours also had other
  CPU-heavy jobs running, so this is an association, not a clean measurement. Batch jobs
  (`resident_timeout_s=None`, the default) wait for the other copy to unload. The live product
  should pass `resident_timeout_s=0`, so it refuses at once with `ModelResident` and runs
  without the fallback.
- **The recorder comes first.** Batch scripts wait, polling every 60 s, while Talha's recorder
  (`train_session.py`) runs, so recording does not drop frames. `recorder_running()` now only
  counts a Python process. A shell that merely has "train_session.py" in its command text, such
  as someone's `pgrep`, used to cause a false 60 s wait.

## Modules

| File | What it does |
|---|---|
| `engine.py` | `LocalVLM` (MLX, offline, pinned revision, deterministic temperature 0), `ClaudeVLM` (guarded), `inference_lock`, the resident-model lock, and the recorder wait. `generate(images, prompt)` returns a `VLMResult` with the text, latency, lock wait, token counts, peak memory and a timed-out flag. |
| `frames.py` | Samples N frames from where the hands move (`sample_frames`, `mode="motion"`), resized to 448 px on the long side. Also has grid and mirror helpers. |
| `prompts.py` | The 22 labels, plain descriptions of each sign, one shared prompt per task, and parsers that never raise. The closed-set free-text fallback is case-sensitive, so "No sign is visible." no longer reads as our sign NO. |
| `smoke.py` | Model and frame-count smoke benchmark. |
| `fallback.py` | Use 1: the meaning-suggestion fallback for unsure signs (`Fallback`, `FrameRing`, `should_fallback`), its evaluation, and `INTEGRATION_NOTE`, the proposal for `stream.py` and the app. Those files were not edited. |
| `qc_takes.py`, `landmark_qc.py`, `ref_landmarks.py` | Use 2: the "check my takes" QC tool. The landmark DTW method is the shipped one; the VLM verdict is experimental. |
| `closed_set.py` | Use 3: the closed-set Track B baseline, where the VLM picks 1 of our 22 labels. It also exports the Track B prediction files. |
| `facial.py` | Use 4: the facial-grammar feasibility check, plus a model-free landmark noise floor (`geometry`). |

## How to run

All commands run from `/Users/trehman/CamelHack` with the VLM venv
`/Users/trehman/.venvs/signbridge-vlm`. Do not install these dependencies into `CamelHack/.venv`.
Only the QC landmark method and the tests work in `CamelHack/.venv`.

```bash
PY=/Users/trehman/.venvs/signbridge-vlm/bin/python
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1      # belt and braces; load() also sets them

# Use 2 (ship this): rank one person's takes of one sign, flag likely-wrong ones (no model)
$PY -m recognition.vlm.qc_takes check --person talha --sign PASSWORD [--extra <dir> ...]

# Use 1: fallback evaluation on Talha's clips (results in CamelHack-handoff/vlm_fallback/)
$PY -m recognition.vlm.fallback eval --set talha --takes 1 2 --frames 4 --max-tokens 96 \
    --order shuffled --out /Users/trehman/CamelHack-handoff/vlm_fallback/x.jsonl
$PY -m recognition.vlm.fallback summarize /Users/trehman/CamelHack-handoff/vlm_fallback/x.jsonl

# Use 3: closed-set Track B baseline, then the summary and the Track B export
$PY -m recognition.vlm.closed_set --help

# Use 4: facial-grammar feasibility and the landmark noise floor
$PY -m recognition.vlm.facial --help

# Tests (no model needed)
$PY -m pytest -q recognition/tests/test_vlm_*.py
```

## Measured results and their scope

All results come from **one signer, Talha**, recorded on this laptop, plus the 21 reference videos.
None of this is a held-out-signer result. The model is Qwen3-VL-4B-Instruct-4bit, and decoding is
deterministic. Latencies are model time per call unless stated otherwise. Many runs shared the
machine with other workflows, so each figure states its conditions.

| Use | Main result | Clips | Latency |
|---|---|---|---|
| 1. Fallback, product path as shipped after the fixes (4 frames, 96 tokens, list shuffled on every call) | right meaning in the top 3 for 9/42 = 21.4% (95% CI 11.7–35.9%); "none of these" 0/42; the first pick was in the first 5 of 48 list positions on 20/42 calls (4.4 expected); only 4/42 clips got the same suggestions as an earlier run that differed only in list order (that run scored 5/42) | Talha takes 1–2 of 21 signs, 42 clips | p50 9.1 s, p95 10.3 s, max 11.1 s (load 4.8–17.3, no other model loaded) |
| 1. Fallback, 8 frames, shuffled per clip | right meaning in the top 3 for 21/105 = 20.0% (95% CI 13.5–28.6%); always offering the same 3 answers would score 14.3% | Talha takes 1–4 of 21 signs (84) plus 21 references | p50 39.0 s, p95 54.4 s (contended) |
| 1. Fallback with the right request removed from the list | said "none of these" on 0/42 | takes 1–2 of 21 signs | p50 32.8 s, p95 44.7 s (contended) |
| 1. Position bias | 48/104 of the model's first picks were in the first 5 of 48 list positions, where about 10.8 would be expected (p ≈ 2e-20) | 8-frame shuffled run | — |
| 2. QC, landmark `pool_dtw_all` | AUC 0.857 (bootstrap 95% CI 0.64–1.00); at the frozen threshold it flagged 0/7 known-wrong takes with 0/12 false alarms; 6 of its top 7 are wrong takes | 7 rejected vs 12 accepted PASSWORD takes | p50 0.09 s, p95 0.15 s per take |
| 2. QC, local VLM | flagged 7/7 wrong and 11/12 accepted takes; AUC 0.54 (CI 0.50–0.62), which is chance | same 19 takes | p50 41.8 s, p95 63.0 s (contended) |
| 3. Closed set, fixed label order | top-1 52/264 = 19.7% (CI 15.3–24.9%); 6/21 on references; chance is 4.5% | 22 classes × 12 Talha takes | p50 7.9 s, p95 8.8 s quiet (n=14); p50 8.7 s, p95 11.4 s with no other model loaded (n=268) |
| 3. Closed set, shuffled label order | 44/264 = 16.7%; no clear difference from fixed order (exact McNemar p = 0.13) | same | — |
| 4. Facial grammar | all 82 calls answered "neutral"; it never said raised, furrowed, shake or nod | 12 Talha takes × 5 conditions, plus 11 references × 2 | p50 33.6 s, p95 44.7 s (contended) |

Known limits:

- One signer only, and the accepted takes are assumed correct without re-checking.
- 6 of the 7 wrong PASSWORD takes were filmed from a different camera angle, so the QC ranking
  may partly reflect the angle rather than the error.
- The model states a confidence of 0.95 on every answer, right or wrong, so it cannot be used as
  a threshold.
- The `timeout_s` setting only stops decoding. Reading the images takes about 6–7 s and cannot be
  interrupted, so no call returns sooner than that.
- Track B files contain 21 rows with `signer: "reference"`, which the harness must filter by
  signer.

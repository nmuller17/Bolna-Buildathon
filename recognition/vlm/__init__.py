"""Local vision-language model (VLM) helpers for SignBridge, inspired by ProtoCopilot.

Four uses, one shared prompt per task for every engine (see prompts.py):
  1. open-set fallback: propose 2-3 meanings when the classifier is unsure; the guest confirms.
  2. QC of training takes against the reference video.
  3. closed-set baseline: pick 1 of our 22 labels from frames (Track B benchmark).
  4. facial-grammar hint: yes/no question, wh-question, negation, neutral.

Privacy: the product path uses LocalVLM only (MLX, on this laptop). ClaudeVLM is for consenting
team clips in benchmarks. Heavy deps (mlx, mlx-vlm) live in /Users/trehman/.venvs/signbridge-vlm
and are imported only when a model is actually loaded.
"""
from .engine import (ClaudeVLM, DEFAULT_LOCAL_MODEL, LOCK_PATH, LocalVLM, LockTimeout, VLMResult,
                     inference_lock, recorder_running, wait_for_recorder)
from .prompts import LABELS, TASKS

__all__ = ["ClaudeVLM", "DEFAULT_LOCAL_MODEL", "LOCK_PATH", "LocalVLM", "LockTimeout", "VLMResult",
           "inference_lock", "recorder_running", "wait_for_recorder", "LABELS", "TASKS"]

"""Smoke test of one local model: load time, per-call latency for several frame counts, peak
memory, and the closed-set answers on a few of Talha's clips (n is tiny; latency, not accuracy).

Run with the VLM venv, one model per process so memory is measured cleanly:
  /Users/trehman/.venvs/signbridge-vlm/bin/python -m recognition.vlm.smoke \
      --model mlx-community/Qwen3-VL-4B-Instruct-4bit --out /path/result.json
"""
from __future__ import annotations

import argparse
import json
import resource
import sys
import time
from pathlib import Path

from . import frames as F
from . import prompts as P
from .engine import LocalVLM, wait_for_recorder

DATA = Path("/Users/trehman/CamelHack-p2avatar/data/videos/train")
DEFAULT_CLIPS = ["YES/talha_1.mp4", "THANK-YOU/talha_1.mp4", "PASSWORD/talha_1.mp4"]


def _rss_gb() -> float:
    # macOS reports ru_maxrss in bytes
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--clips", nargs="*", default=DEFAULT_CLIPS)
    ap.add_argument("--frames", nargs="*", type=int, default=[4, 8, 16])
    ap.add_argument("--long-side", type=int, default=448)
    ap.add_argument("--mode", default="motion", choices=["even", "motion"])
    ap.add_argument("--layout", default="images", choices=["images", "grid"])
    ap.add_argument("--hints", type=int, default=1)
    ap.add_argument("--max-tokens", type=int, default=200)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    wait_for_recorder(poll_s=60, log=lambda m: print(m, flush=True))
    eng = LocalVLM(a.model, max_tokens=a.max_tokens, timeout_s=180, load=False)
    load_s = eng.load()
    print(f"[smoke] {a.model} loaded in {load_s:.1f} s (rss {_rss_gb():.2f} GB)", flush=True)

    # warm-up call (first call compiles kernels); excluded from the latency table, reported apart
    s0 = F.sample_frames(DATA / a.clips[0], n=2, mode=a.mode, long_side=a.long_side)
    w = eng.generate(s0.images, "Describe the person's hands in five words.", max_tokens=16)
    print(f"[smoke] warm-up {w.latency_s:.1f} s", flush=True)

    rows = []
    for n in a.frames:
        for clip in a.clips:
            wait_for_recorder(poll_s=60, log=lambda m: print(m, flush=True))
            truth = clip.split("/")[0]
            s = F.sample_frames(DATA / clip, n=n, mode=a.mode, long_side=a.long_side)
            imgs = [F.grid(s.images)] if a.layout == "grid" else s.images
            prompt = P.build_closed_set(n, hints=bool(a.hints))
            if a.layout == "grid":
                prompt = prompt.replace(f"{n} frames sampled in time order",
                                        f"one grid image of {n} numbered frames (read left to right, "
                                        "top to bottom) sampled in time order")
            r = eng.generate(imgs, prompt)
            parsed = P.parse_closed_set(r.text)
            row = {"n_frames": n, "clip": clip, "truth": truth, "pred": parsed["label"],
                   "top3": parsed["top3"], "confidence": parsed["confidence"], "format": parsed["format"],
                   "latency_s": round(r.latency_s, 2), "prompt_tokens": r.prompt_tokens,
                   "generation_tokens": r.generation_tokens,
                   "peak_mlx_gb": round(r.peak_memory_gb or 0, 2), "timed_out": r.timed_out,
                   "window": s.window, "n_total": s.n_total, "raw": r.text[:400]}
            rows.append(row)
            print(json.dumps({k: row[k] for k in ("n_frames", "clip", "pred", "latency_s",
                                                  "prompt_tokens", "peak_mlx_gb", "format")}), flush=True)
    out = {"model": a.model, "load_s": round(load_s, 1), "warmup_s": round(w.latency_s, 1),
           "max_rss_gb": round(_rss_gb(), 2), "long_side": a.long_side, "mode": a.mode,
           "layout": a.layout, "hints": bool(a.hints), "rows": rows,
           "when": time.strftime("%Y-%m-%d %H:%M:%S")}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, indent=1))
    print(f"[smoke] wrote {a.out}; max rss {out['max_rss_gb']} GB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

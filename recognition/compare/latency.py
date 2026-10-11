"""Track A latency, labelled by WHAT was timed, on one fold's first 100 in-vocabulary clips.

    python -m recognition.compare.latency [--run-dir data/compare/track_a] [--force]

Why this exists (fairness audit, finding 4): the first report put our GRU's 2 ms next to 40 ms for the
GISLR winner and read like an architecture gap. The 40 ms was our own unoptimised eager PyTorch PORT of
that network. The winner's released TFLite (the same architecture, compiled; reportedly an ensemble of
several seeds, which would make it slower, not faster) runs the same clips much faster. So this module times, on the SAME clips, one at a time, 2 threads:

  ours_gru, ours_baseline                    our product code (features.prepare + model), eager PyTorch
  islr1st_ourfeat, islr1st_retrained         "port, eager": our PyTorch port of the winner's network
  islr1st_released_tflite                    the winner's released TFLite (same architecture), in the bench venv

It records the 1/5/15-minute load average before and after and refuses to run when the 1-minute load is
above 2 unless --force, in which case the result is labelled as measured on a busy machine.
All numbers exclude MediaPipe landmark extraction, which every landmark-based system needs.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

from recognition import features
from recognition.compare import islr1st
from recognition.compare.track_a_gislr import BENCH_PY, EXT, LEGACY_OUT, ROOT, THREADS, TRAINED, fold_sets
from recognition.data import load_file
from recognition.labels import CLASSES
from recognition.model import Baseline, SignGRU

WHAT = {
    "ours_gru": "product code, eager PyTorch",
    "ours_baseline": "product code, eager PyTorch",
    "islr1st_ourfeat": "port, eager PyTorch (our port of the winner network)",
    "islr1st_retrained": "port, eager PyTorch (our port of the winner network + its preprocessing)",
    "islr1st_released_tflite": "the winner's released TFLite (same architecture), incl. its preprocessing",
}


def load_avg():
    try:
        return [round(x, 2) for x in os.getloadavg()]
    except OSError:
        return None


def _time(fn, xs):
    for x in xs[:5]:
        fn(x)
    ts = []
    for x in xs:
        t0 = time.perf_counter()
        fn(x)
        ts.append((time.perf_counter() - t0) * 1000)
    return {"p50_ms": round(float(np.median(ts)), 2), "p95_ms": round(float(np.percentile(ts, 95)), 2), "n": len(ts)}


def run(run_dir, n=100, force=False):
    torch.set_num_threads(THREADS)
    run_dir = Path(run_dir)
    start = load_avg()
    busy = bool(start and start[0] > 2.0)
    if busy and not force:
        sys.exit(f"machine busy (load {start}); measure latency idle, or pass --force to label it busy")
    idx = json.loads((run_dir / "index.json").read_text())
    fold = idx["signers"][0]
    _, te, _ = fold_sets(idx, fold)
    te = te[:n]
    res = {}
    for system in TRAINED:
        ck = torch.load(run_dir / "models" / f"{system}_{fold}.pt", map_location="cpu", weights_only=True)
        if system == "islr1st_retrained":
            m = islr1st.ISLR1st(n_classes=ck["n_classes"])
            m.load_state_dict(ck["state_dict"])
            m.eval()
            res[system] = _time(lambda x: islr1st.predict_logits(m, [x]), [islr1st.load_raw(ROOT / c["raw"]) for c in te])
        else:
            m = {"ours_gru": SignGRU, "ours_baseline": Baseline}.get(system)
            m = m() if m else islr1st.ISLR1stOnOurFeatures(features.FEATURE_DIM, len(CLASSES))
            m.load_state_dict(ck["state_dict"])
            m.eval()

            def fn(frames, m=m):
                with torch.inference_mode():
                    return m(torch.from_numpy(features.prepare(frames))[None]).numpy()
            res[system] = _time(fn, [load_file(ROOT / c["json"])["frames"] for c in te])
        res[system]["what"] = WHAT[system]
        print(system, res[system], flush=True)
    # the released TFLite on the same clips (bench venv; per-clip invoke time incl. its own preprocessing)
    tmp_index = run_dir / "latency_tflite_index.json"
    raw_out = run_dir / "latency_tflite_raw.jsonl"
    tmp_index.write_text(json.dumps({"clips": [{"clip_id": c["clip_id"], "raw": c["raw"]} for c in te]}))
    subprocess.run([str(BENCH_PY), str(Path(__file__).with_name("ext_islr1st_tflite.py")), "--index", str(tmp_index),
                    "--root", str(ROOT), "--model", str(EXT / "model.tflite"), "--map",
                    str(EXT / "sign_to_prediction_index_map.json"), "--out", str(raw_out), "--threads", str(THREADS)],
                   check=True, stdout=subprocess.DEVNULL)
    ts = [json.loads(l)["latency_ms"] for l in raw_out.read_text().splitlines() if l.strip()][5:]  # same 5-clip warm-up
    res["islr1st_released_tflite"] = {"p50_ms": round(float(np.median(ts)), 2),
                                      "p95_ms": round(float(np.percentile(ts, 95)), 2), "n": len(ts),
                                      "what": WHAT["islr1st_released_tflite"]}
    print("islr1st_released_tflite", res["islr1st_released_tflite"], flush=True)
    end = load_avg()
    res["_conditions"] = {"fold": fold, "clips": f"first {len(te)} in-vocabulary clips of signer {fold}",
                          "threads": THREADS, "load_avg_start": start, "load_avg_end": end, "cpu_count": os.cpu_count(),
                          "busy": bool(busy or (end and end[0] > 2.0)),
                          "measured": time.strftime("%Y-%m-%d %H:%M:%S %Z")}
    (run_dir / "latency_labelled.json").write_text(json.dumps(res, indent=1))
    print(f"wrote {run_dir / 'latency_labelled.json'}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-dir", default=str(LEGACY_OUT))
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    run(a.run_dir, a.n, a.force)


if __name__ == "__main__":
    main()

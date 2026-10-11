"""Run the published GISLR 1st-place model (TFLite) on raw GISLR parquets. Bench venv only.

    ~/.venvs/signbridge-bench/bin/python recognition/compare/ext_islr1st_tflite.py \
        --index data/compare/track_a/index.json --root . --model data/compare/ext/islr1st_hf/model.tflite \
        --map data/compare/ext/islr1st_hf/sign_to_prediction_index_map.json --out data/compare/track_a/ext_islr1st_pretrained_raw.jsonl

Standalone on purpose (numpy, pandas, pyarrow, ai_edge_litert): this model needs TensorFlow Lite,
which the product venv must not depend on. Model: huggingface.co/sign/kaggle-asl-signs-1st-place
(MIT), sha256 checked by the caller. Input [T, 543, 3] float32 in raw GISLR row order, NaN allowed
(the model does its own preprocessing); output 250 logits.

Per clip it writes the two distributions the comparison uses:
  p7_closed: softmax over the 7 shared signs' logits only (closed set, like our 7-class models)
  p8_reject: from the full 250-way softmax: the 7 shared signs' probabilities, and for NONE the
             probability of the best OTHER sign. So the 8-way argmax is "the 250-way top sign if it is one
             of the 7, else NONE", and the confidence is the model's own probability for that answer
             (the 8 values do not sum to 1). Summing the 243 others into NONE instead was also tried:
             it lowers this model's sign accuracy, so the more favourable rule is used. The model was
             trained on the other 243 signs, including the out-of-vocabulary test signs: an advantage.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from ai_edge_litert.interpreter import Interpreter

OURS = {"yes": "YES", "no": "NO", "thankyou": "THANK-YOU", "where": "WHERE", "time": "TIME",
        "please": "PLEASE", "room": "ROOM"}
SIGNS7 = ["YES", "NO", "THANK-YOU", "WHERE", "TIME", "PLEASE", "ROOM"]
OFFSET = {"face": 0, "left_hand": 468, "pose": 489, "right_hand": 522}


def load_raw(path):
    df = pd.read_parquet(path, columns=["frame", "type", "landmark_index", "x", "y", "z"])
    frames = np.sort(df["frame"].unique())
    pos = {f: i for i, f in enumerate(frames)}
    a = np.full((len(frames), 543, 3), np.nan, np.float32)
    row = df["type"].map(OFFSET).to_numpy() + df["landmark_index"].to_numpy().astype(int)
    a[df["frame"].map(pos).to_numpy(), row] = df[["x", "y", "z"]].to_numpy(np.float32)
    return a


def softmax(z):
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--map", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    s2i = json.loads(Path(a.map).read_text())
    i2s = {v: k for k, v in s2i.items()}
    our_idx = [s2i[g] for g in ["yes", "no", "thankyou", "where", "time", "please", "room"]]
    assert [OURS[i2s[i]] for i in our_idx] == SIGNS7
    interp = Interpreter(model_path=a.model, num_threads=a.threads)
    run = interp.get_signature_runner("serving_default")
    clips = json.loads(Path(a.index).read_text())["clips"]
    root = Path(a.root)
    with open(a.out, "w") as f:
        for k, c in enumerate(clips):
            x = load_raw(root / c["raw"])
            t0 = time.perf_counter()
            logits = np.asarray(run(inputs=x)["outputs"], dtype=np.float64).reshape(-1)
            ms = (time.perf_counter() - t0) * 1000
            p = softmax(logits)
            p7 = softmax(logits[our_idx])
            other = np.delete(p, our_idx)
            p8 = np.append(p[our_idx], other.max())
            f.write(json.dumps({"clip_id": c["clip_id"], "p7_closed": p7.round(6).tolist(),
                                "p8_reject": p8.round(6).tolist(),
                                "p_none_sum": round(float(1.0 - p[our_idx].sum()), 6), "top250": i2s[int(np.argmax(logits))],
                                "latency_ms": round(ms, 2)}) + "\n")
            if (k + 1) % 250 == 0:
                print(f"{k + 1}/{len(clips)}", flush=True)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()

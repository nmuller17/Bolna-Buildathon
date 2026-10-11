"""Stage 1: make the published GISLR 1st-place weights face-free by self-distillation on GISLR clips.

    python -m recognition.transfer.stage1 --epochs 15 --out data/transfer_runs/stage1

Sources (LICENCES.md, all USE): weights = Kaggle hoyso48/islr-models seed-42 .h5 (converted to .npz
by the compare workflow; Apache-2.0 winner licence + MIT code); clips = GISLR rerun set (Kaggle
sohier/461054610546105, CC0) as selected by fetch_gislr.py. No team or Talha data is used here, so
stage 1 cannot leak any test signer. The 30 data/gislr_oov signs are excluded (they stay an external
unknown-sign test). Participant VAL_PARTICIPANT is held out to choose the epoch and to report
teacher-vs-student accuracy.
"""
import argparse
import hashlib
import json
import platform
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from recognition.transfer import ffislr as FF
from recognition.transfer import islr1st_port as P

ROOT = Path(__file__).resolve().parents[2]
NPZ = Path("/Users/trehman/CamelHack/data/compare/ext/islr1st_h5/seed42_weights.npz")
SHARED = Path("/Users/trehman/CamelHack/data/gislr_raw")
LOCAL = ROOT / "data" / "gislr_transfer_raw"
VAL_PARTICIPANT = "6927"
KEEP_ROWS = np.array(sorted(set(P.POINTS) | set(range(468, 543))))  # face rows the teacher reads + hands + pose


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def expand(c):
    x = np.full((len(c), P.ROWS, 3), np.nan, np.float32)
    x[:, KEEP_ROWS] = c.astype(np.float32)
    return x


def load_clips(index, cache):
    if cache.exists():
        z = np.load(cache, allow_pickle=False)
        lens = z["lens"]
        flat = z["flat"]
        offs = np.concatenate([[0], np.cumsum(lens)])
        return [flat[offs[i]:offs[i + 1]] for i in range(len(lens))]
    out = []
    warnings.simplefilter("ignore")
    for k, c in enumerate(index):
        root = SHARED if c["where"] == "shared" else LOCAL
        x = P.filter_nans(P.load_raw(root / c["path"]))
        out.append(x[:, KEEP_ROWS].astype(np.float16))
        if k % 500 == 0:
            print(f"loaded {k}/{len(index)}", flush=True)
    np.savez(cache, flat=np.concatenate(out), lens=np.array([len(a) for a in out]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--out", default=str(ROOT / "data/transfer_runs/stage1"))
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="smoke test: use only this many training clips")
    a = ap.parse_args(argv)
    torch.set_num_threads(a.threads)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    idx = json.loads((LOCAL / "stage1_index.json").read_text())
    oov = set(idx["excluded_signs_oov_test"])
    lab = pd.read_parquet(SHARED / "labels.parqet")
    s2i = {s: i for i, s in enumerate(sorted(lab.sign.unique()))}  # = the competition's sign_to_prediction_index_map
    clips = [c for c in idx["clips"] if c["sign"] not in oov]
    assert len(clips) == len(idx["clips"])
    comp = load_clips(clips, out / "clips_cache.npz")
    y = np.array([s2i[c["sign"]] for c in clips])
    part = np.array([c["participant"] for c in clips])
    tr, va = np.flatnonzero(part != VAL_PARTICIPANT), np.flatnonzero(part == VAL_PARTICIPANT)
    if a.limit:
        tr = tr[:a.limit]
        va = va[:max(50, a.limit // 4)]
    raws_tr = [expand(comp[i]) for i in tr]
    raws_va_full = [expand(comp[i]) for i in va]
    raws_va = [FF.face_free(r) for r in raws_va_full]
    teacher = P.load_keras(NPZ)
    lt = P.predict_logits(teacher, raws_va_full)
    teacher_acc = float((lt.argmax(1) == y[va]).mean())
    print(f"{len(tr)} train clips, {len(va)} val clips (participant {VAL_PARTICIPANT}); teacher (with face) val acc {teacher_acc:.3f}", flush=True)
    student = FF.from_pretrained(NPZ)
    student, info = FF.distill(teacher, student, raws_tr, y[tr], a.epochs, val=(raws_va, y[va]),
                               log=lambda m: print(m, flush=True))
    ls = FF.logits(student, raws_va)
    torch.save(student.state_dict(), out / "ff_stage1.pt")
    man = {
        "what": "stage-1 face-free self-distillation of the GISLR 1st-place weights",
        "weights_npz": str(NPZ), "weights_npz_sha256": sha256(NPZ),
        "weights_source": "Kaggle hoyso48/islr-models islr-fp16-192-8-seed42-foldall-last.h5 (USE, partly verified; see LICENCES.md)",
        "clips": len(clips), "train_clips": int(len(tr)), "val_clips": int(len(va)), "val_participant": VAL_PARTICIPANT,
        "signs": len(set(c["sign"] for c in clips)), "excluded_oov_signs": sorted(oov),
        "clip_list_sha256": hashlib.sha256(json.dumps([c["path"] for c in clips]).encode()).hexdigest(),
        "teacher_val_acc_with_face": round(teacher_acc, 4),
        "student_val_acc_face_free_before": info["curve"][0]["val_acc"] if info["curve"] else None,
        "student_val_acc_face_free_after": round(float((ls.argmax(1) == y[va]).mean()), 4),
        "best_epoch": info["best_epoch"], "curve": info["curve"], "seconds": info["seconds"],
        "epochs": a.epochs, "limit": a.limit, "torch": torch.__version__, "python": platform.python_version(),
        "code_sha256": {p.name: sha256(p) for p in [Path(FF.__file__), Path(P.__file__), Path(__file__)]},
        "output_sha256": sha256(out / "ff_stage1.pt"),
    }
    (out / "stage1_manifest.json").write_text(json.dumps(man, indent=1))
    print(json.dumps({k: v for k, v in man.items() if k != "curve"}, indent=1))


if __name__ == "__main__":
    main()

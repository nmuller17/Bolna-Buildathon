"""Track A open-set test with outside signs chosen by a written rule, in three strata.

    python -m recognition.compare.oov_strata select      # freeze the selection (refuses to overwrite)
    python -m recognition.compare.oov_strata fetch       # raw parquets -> data/gislr_raw, SignFile JSON -> data/gislr_oov_strata
    python -m recognition.compare.oov_strata verify      # re-score the original outside clips with the saved fold models
    python -m recognition.compare.oov_strata score       # every saved fold model on its own held-out signer's clips
    python -m recognition.compare.oov_strata pretrained  # published TFLite on the same clips (bench venv; reference only)

Why: the first run's 30 outside signs (15 train NONE, 15 test) were picked by hand, mostly animals and
objects, with no written rule. The fairness audit showed that on outside signs that resemble our 7
signs, false accept is much higher. The open-set test therefore reports three strata separately:

  handpicked      the original 15 NONE_TEST signs (kept for continuity; no selection rule exists)
  random          PRE-REGISTERED: N_RANDOM signs drawn uniformly with RANDOM_SEED from every GISLR sign
                  that is neither one of our 7 shared signs nor one of the 15 NONE_TRAIN signs (228 signs),
                  then CLIPS_RANDOM clips per sign, round-robin over participants. This is the unbiased
                  estimate of "an outside sign"; it may overlap the other two strata, which is reported.
  near_neighbour  15 signs close to one of our 7 in location, handshape or meaning, listed by the audit
                  BEFORE it scored them (rationale in NEAR_NEIGHBOUR). Hand-chosen, so it is a sensitivity
                  test of the hard case, not an unbiased estimate. 15 clips per sign, round-robin.

No model is retrained: each clip is scored by the saved model of the fold whose held-out signer made the
clip, so every clip is new to its model in both sign and person (the NONE_TRAIN signs are excluded from
every stratum). The pretrained reference was trained on all 250 GISLR signs, so for it none of these is
an outside sign; its rows are listed only for completeness.
"""
import argparse
import hashlib
import io
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from recognition import features
from recognition.compare import common, islr1st
from recognition.compare.track_a_gislr import (BENCH_PY, EXT, LEGACY_OUT, MODES, ROOT, SYSTEMS, THREADS,
                                               TFLITE_SHA256, TRAINED, restrict, restrict_to)
from recognition.data import load_file, to_arrays
from recognition.labels import CLASSES, NONE
from recognition.model import Baseline, SignGRU, softmax

RAW_ROOT = ROOT / "data/gislr_raw"
LABELS = RAW_ROOT / "labels.parqet"  # sic
JSON_ROOT = ROOT / "data/gislr_oov_strata"
# The selection is frozen ONCE, independent of any run; each run folder gets its own strata predictions.
SELECTION = ROOT / "data/compare/oov_strata.json"
OUT = LEGACY_OUT  # run folder whose saved fold models are scored (main() --run-dir overrides)
RERUN_URL = "https://www.kaggle.com/api/v1/datasets/download/sohier/461054610546105/"
SHARED = ["yes", "no", "thankyou", "where", "time", "please", "room"]

RANDOM_SEED = 20261010   # fixed before any scoring of this stratum
N_RANDOM = 30            # signs
CLIPS_RANDOM = 10        # clips per sign (round-robin: one per participant when available)
CLIPS_NN = 15            # same count and rule as the audit's near-neighbour sensitivity test
NEAR_NEIGHBOUR = {       # sign -> which of our 7 it resembles and how (written by the audit before scoring)
    "hello": "THANK-YOU: flat hand moving out from the face", "bye": "THANK-YOU: flat hand near the face",
    "fine": "THANK-YOU: open hand, thumb at the chest/chin area", "minemy": "PLEASE: flat hand on the chest",
    "like": "PLEASE: hand at the chest", "bedroom": "ROOM: box shape (compound)", "closet": "ROOM: box/door shape",
    "who": "WHERE: index finger, question sign", "why": "WHERE: question sign at the face",
    "there": "WHERE: index finger pointing", "not": "NO: negation", "now": "TIME: both hands in front, short",
    "later": "TIME: time-line sign", "wait": "TIME: waiting, wrist area", "can": "YES: S/fist hands, nodding motion",
}
STRATA = ("handpicked", "random", "near_neighbour")


def _index(run_dir=None):
    return json.loads((Path(run_dir or OUT) / "index.json").read_text())


def _round_robin(meta, sign, k, seed):
    """k clips of one sign spread over participants: shuffle, rank within participant, take by rank."""
    sub = meta[meta.sign == sign].sample(frac=1, random_state=seed)
    sub = sub.assign(r=sub.groupby("pid").cumcount()).sort_values(["r", "pid"])
    return sub.head(k)


def select(force=False):
    import pandas as pd
    if SELECTION.exists() and not force:
        sys.exit(f"{SELECTION} exists: the selection is frozen (pass --force only to rebuild it before any scoring)")
    idx = _index()
    meta = pd.read_parquet(LABELS)
    meta["pid"] = meta.path.str.split("/").str[-2]
    signs = sorted(meta.sign.unique())
    none_train = set(idx["none_train_signs"])
    pool = [s for s in signs if s not in SHARED and s not in none_train]
    assert not set(NEAR_NEIGHBOUR) & (set(SHARED) | none_train)
    drawn = sorted(np.random.default_rng(RANDOM_SEED).choice(pool, N_RANDOM, replace=False).tolist())
    strata = {"random": [], "near_neighbour": []}
    for name, sign_list, k, seed in (("random", drawn, CLIPS_RANDOM, RANDOM_SEED),
                                     ("near_neighbour", sorted(NEAR_NEIGHBOUR), CLIPS_NN, 0)):
        for s in sign_list:
            for row in _round_robin(meta, s, k, seed).itertuples(index=False):
                seq = row.path.rsplit("/", 1)[-1].replace(".parquet", "")
                strata[name].append({"clip_id": f"{row.pid}_{seq}", "signer": row.pid, "label": NONE, "oov": True,
                                     "gislr_sign": s, "path": row.path,
                                     "raw": str((RAW_ROOT / row.path).relative_to(ROOT)),
                                     "json": str((JSON_ROOT / s / f"gislr{row.pid}_{seq}.json").relative_to(ROOT))})
    sel = {"created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "rule": {"random": f"{N_RANDOM} signs drawn uniformly (numpy default_rng({RANDOM_SEED}).choice, no "
                              f"replacement) from the {len(pool)} GISLR signs that are not our 7 shared signs and not "
                              f"NONE_TRAIN; {CLIPS_RANDOM} clips per sign, round-robin over participants",
                    "near_neighbour": f"the 15 signs in NEAR_NEIGHBOUR (chosen by the audit before scoring); "
                                      f"{CLIPS_NN} clips per sign, round-robin over participants (seed 0)",
                    "handpicked": "the original 15 NONE_TEST signs (hand-picked, no written rule)"},
           "pool_size": len(pool), "random_signs": drawn, "near_neighbour_signs": NEAR_NEIGHBOUR,
           "handpicked_signs": idx["none_test_signs"],
           "overlap": {"random&handpicked": sorted(set(drawn) & set(idx["none_test_signs"])),
                       "random&near_neighbour": sorted(set(drawn) & set(NEAR_NEIGHBOUR))},
           "strata": strata}
    SELECTION.write_text(json.dumps(sel, indent=0))
    sha = hashlib.sha256(SELECTION.read_bytes()).hexdigest()
    print(f"froze {SELECTION} sha256 {sha}\nrandom signs: {drawn}\noverlap {sel['overlap']}")
    for name, cl in strata.items():
        print(name, len(cl), "clips,", len({c['signer'] for c in cl}), "signers, per signer",
              dict(sorted(Counter(c['signer'] for c in cl).items())))


def load_selection():
    if not SELECTION.exists():
        sys.exit(f"run `select` first ({SELECTION} missing)")
    return json.loads(SELECTION.read_text())


def _get(path):
    """Download one rerun parquet; Kaggle serves larger files as a one-member zip. Checks the PAR1 magic."""
    dest = RAW_ROOT / path
    if dest.exists():
        return "kept"
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(6):
        try:
            b = urllib.request.urlopen(RERUN_URL + urllib.parse.quote(path, safe=""), timeout=90).read()
            if b[:2] == b"PK":
                z = zipfile.ZipFile(io.BytesIO(b))
                if len(z.namelist()) != 1:
                    raise ValueError(f"zip with {len(z.namelist())} members")
                b = z.read(z.namelist()[0])
            if b[:4] == b"PAR1" and b[-4:] == b"PAR1":
                tmp = dest.with_suffix(".part")
                tmp.write_bytes(b)
                tmp.rename(dest)
                return "downloaded"
        except Exception as e:  # retried with back-off (Kaggle answers 429 to bursts); reported if it never succeeds
            print(f"retry {path}: {type(e).__name__}: {e}", file=sys.stderr)
            time.sleep(5 * 2 ** attempt)
    return "failed"


def fetch(workers=2):
    import pandas as pd
    from recognition.tools.gislr_to_frames import df_to_signfile
    sel = load_selection()
    clips = {c["clip_id"] + c["gislr_sign"]: c for s in ("random", "near_neighbour") for c in sel["strata"][s]}
    with ThreadPoolExecutor(workers) as ex:
        st = Counter(ex.map(_get, [c["path"] for c in clips.values()]))
    print(f"raw files: {dict(st)}")
    if st.get("failed"):
        sys.exit("some downloads failed; rerun fetch")
    bad = []
    for c in clips.values():
        out = ROOT / c["json"]
        if out.exists():
            continue
        df = pd.read_parquet(ROOT / c["raw"], columns=["frame", "type", "landmark_index", "x", "y", "z"])
        doc, ok = df_to_signfile(df, NONE, f"gislr{c['signer']}")
        if not ok or not doc["frames"]:
            bad.append(c["clip_id"])
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(doc, separators=(",", ":")))
    if bad:  # never silently drop: the report would then compare on different clips
        sys.exit(f"{len(bad)} clips have no usable frames: {bad}")
    print(f"converted; JSON under {JSON_ROOT}")


# ---------- scoring with the saved fold models ----------

def load_model(system, fold):
    ck = torch.load(OUT / "models" / f"{system}_{fold}.pt", map_location="cpu", weights_only=True)
    if system == "islr1st_retrained":
        m = islr1st.ISLR1st(n_classes=ck["n_classes"])
    elif system == "ours_gru":
        m = SignGRU()
    elif system == "ours_baseline":
        m = Baseline()
    else:
        m = islr1st.ISLR1stOnOurFeatures(features.FEATURE_DIM, len(CLASSES))
    m.load_state_dict(ck["state_dict"])
    m.eval()
    return m, ck["temperature"]


def probs8(system, model, temp, clips):
    """Same arithmetic as track_a_gislr.run_job: 8-way distribution over MODES['R8'] per clip."""
    labels = MODES["R8"]
    if system == "islr1st_retrained":
        return softmax(islr1st.predict_logits(model, [islr1st.load_raw(ROOT / c["raw"]) for c in clips]))
    X = to_arrays([features.normalize(load_file(ROOT / c["json"]))[0] for c in clips])
    with torch.inference_mode():
        lg = model(torch.from_numpy(X)).numpy()
    return np.stack([restrict(p, labels) for p in softmax(lg, temp)])


def score_clips(system, clips, stratum):
    labels = MODES["R8"]
    out = {m: [] for m in MODES}
    for fold in sorted({c["signer"] for c in clips}, key=int):
        cs = [c for c in clips if c["signer"] == fold]
        model, temp = load_model(system, fold)
        P = probs8(system, model, temp, cs)
        for mode, ml in MODES.items():
            out[mode] += [common.record(system, c["clip_id"], c["signer"], NONE, ml, restrict_to(p, labels, ml),
                                        track="A", mode=mode, fold=fold, oov=True, oov_sign=c["gislr_sign"],
                                        stratum=stratum) for c, p in zip(cs, P)]
    return out


def verify():
    """Re-score the original hand-picked outside clips with the saved fold models; they must match the
    saved predictions from the training run (same model, same arithmetic)."""
    torch.set_num_threads(THREADS)
    idx = _index()
    clips = [c for c in idx["clips"] if c["oov"] and c["gislr_sign"] in idx["none_test_signs"]]
    worst = {}
    for system in TRAINED:
        saved = {r["clip_id"]: r for r in common.read_jsonl(sorted((OUT / "preds").glob(f"{system}_R8_*.jsonl")))
                 if r["oov"]}
        new = score_clips(system, clips, "handpicked")["R8"]
        top_match = sum(saved[r["clip_id"]]["top3"][0]["label"] == r["top3"][0]["label"] for r in new)
        dp = max(abs(saved[r["clip_id"]]["probs"][l] - r["probs"][l]) for r in new for l in r["probs"])
        worst[system] = {"n": len(new), "top1_match": top_match, "max_abs_prob_diff": float(dp),
                         "false_accept_saved": common.false_accept_rate(list(saved.values())),
                         "false_accept_rescored": common.false_accept_rate(new)}
        print(system, worst[system], flush=True)
    (OUT / "oov_strata_verify.json").write_text(json.dumps(worst, indent=1))
    if any(v["top1_match"] != v["n"] or v["max_abs_prob_diff"] > 1e-4 for v in worst.values()):
        sys.exit("re-scoring does NOT reproduce the saved predictions")


def score():
    torch.set_num_threads(THREADS)
    sel = load_selection()
    sha = hashlib.sha256(SELECTION.read_bytes()).hexdigest()
    for stratum in ("random", "near_neighbour"):
        for system in TRAINED:
            recs = score_clips(system, sel["strata"][stratum], stratum)
            for mode, rs in recs.items():
                for r in rs:
                    r["selection_sha256"] = sha
                common.write_jsonl(OUT / "preds_strata" / stratum / f"{system}_{mode}.jsonl", rs)
            print(stratum, system, {m: common.false_accept_rate(rs) for m, rs in recs.items()}, flush=True)


def pretrained():
    """The published TFLite on the strata clips (reference only: every GISLR sign is in its training set)."""
    model = EXT / "model.tflite"
    if hashlib.sha256(model.read_bytes()).hexdigest() != TFLITE_SHA256:
        sys.exit(f"{model} sha256 mismatch")
    sel = load_selection()
    uniq = {c["clip_id"]: c for s in ("random", "near_neighbour") for c in sel["strata"][s]}
    tmp_index = OUT / "oov_strata_tflite_index.json"
    tmp_index.write_text(json.dumps({"clips": list(uniq.values())}))
    raw_out = OUT / "ext_islr1st_pretrained_strata_raw.jsonl"
    subprocess.run([str(BENCH_PY), str(Path(__file__).with_name("ext_islr1st_tflite.py")), "--index", str(tmp_index),
                    "--root", str(ROOT), "--model", str(model), "--map", str(EXT / "sign_to_prediction_index_map.json"),
                    "--out", str(raw_out)], check=True)
    raw = {json.loads(l)["clip_id"]: json.loads(l) for l in raw_out.read_text().splitlines() if l.strip()}
    for stratum in ("random", "near_neighbour"):
        for mode, labels in MODES.items():
            recs = [common.record("islr1st_pretrained", c["clip_id"], c["signer"], NONE, labels,
                                  np.array(raw[c["clip_id"]]["p7_closed" if mode == "C7" else "p8_reject"]),
                                  track="A", mode=mode, fold=None, oov=True, oov_sign=c["gislr_sign"], stratum=stratum,
                                  pred250=raw[c["clip_id"]]["top250"])
                    for c in sel["strata"][stratum]]
            common.write_jsonl(OUT / "preds_strata" / stratum / f"islr1st_pretrained_{mode}.jsonl", recs)


def load_strata_preds(run_dir, base_recs, systems=SYSTEMS):
    """{stratum: {(system, mode): [records]}} for one run folder; handpicked = the run's own outside clips.
    A (system, mode) set is used only if it has exactly the frozen selection's clips, each scored by the model
    of the fold whose held-out signer made it; anything else is listed in the returned errors."""
    run_dir = Path(run_dir)
    out = {"handpicked": {}}
    for r in base_recs:
        if r["oov"]:
            out["handpicked"].setdefault((r["system"], r["mode"]), []).append({**r, "stratum": "handpicked"})
    errors = {}
    if not SELECTION.exists():
        return out, {"selection": f"{SELECTION} missing"}
    sel = load_selection()
    sha = hashlib.sha256(SELECTION.read_bytes()).hexdigest()
    for stratum in ("random", "near_neighbour"):
        want = {c["clip_id"]: c for c in sel["strata"][stratum]}
        out[stratum] = {}
        for system in systems:
            for mode in MODES:
                p = run_dir / "preds_strata" / stratum / f"{system}_{mode}.jsonl"
                if not p.exists():
                    errors[f"{stratum}/{system}/{mode}"] = "not scored"
                    continue
                rs = common.read_jsonl([p])
                ids = Counter(r["clip_id"] for r in rs)
                bad = [k for k, n in ids.items() if n > 1 or k not in want] + [k for k in want if k not in ids]
                bad += [r["clip_id"] for r in rs if r["signer"] != want.get(r["clip_id"], {}).get("signer")
                        or (system in TRAINED and (r["fold"] != r["signer"] or r.get("selection_sha256") != sha))]
                if bad:
                    errors[f"{stratum}/{system}/{mode}"] = f"{len(bad)} missing, duplicate, mis-folded or stale clips"
                    continue
                out[stratum][(system, mode)] = rs
    return out, errors


def main(argv=None):
    global OUT
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-dir", default=str(LEGACY_OUT), help="run folder with models/ and preds/ (default the "
                    "exploratory run data/compare/track_a; use data/compare/track_a_v1 for the protocol run)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("select")
    s.add_argument("--force", action="store_true")
    for name in ("fetch", "verify", "score", "pretrained"):
        sub.add_parser(name)
    a = ap.parse_args(argv)
    OUT = Path(a.run_dir)
    {"select": lambda: select(a.force), "fetch": fetch, "verify": verify, "score": score,
     "pretrained": pretrained}[a.cmd]()


if __name__ == "__main__":
    main()

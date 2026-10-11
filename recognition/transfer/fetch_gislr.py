"""Fetch a stage-1 (face-free adaptation) subset of the GISLR rerun set (Kaggle sohier/461054610546105, CC0).

    python -m recognition.transfer.fetch_gislr --per-sign 20 --workers 6

Selection (seed 0, deterministic): every GISLR sign that is NOT one of the 30 signs in
data/gislr_oov (kept out so that they stay an external unknown-sign test) gets up to
--per-sign clips, round-robin over participants. Clips already present in the shared
read-only data/gislr_raw are reused, not downloaded again. The 7 shared signs are always
taken in full from data/gislr_raw. Raw data never enters git (data/ is gitignored) and is
never redistributed (competition rules 7B are honoured even though the rerun set is CC0).

Kaggle serves files larger than about 1 MiB as a zip archive; the zip is unpacked here.
Writes data/gislr_transfer_raw/stage1_index.json (path, sign, participant, where).
"""
import argparse
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

URL = "https://www.kaggle.com/api/v1/datasets/download/sohier/461054610546105/"
SHARED = Path("/Users/trehman/CamelHack/data/gislr_raw")
OOV = Path("/Users/trehman/CamelHack/data/gislr_oov")
OUT = Path(__file__).resolve().parents[2] / "data" / "gislr_transfer_raw"
OURS = {"yes", "no", "please", "where", "thankyou", "room", "time"}


def fetch(path, dest):
    if dest.exists():
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(8):
        try:
            with urllib.request.urlopen(URL + urllib.parse.quote(path, safe=""), timeout=120) as r:
                blob = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 7:
                raise
            time.sleep(min(120, 5 * 2 ** attempt))  # rate limited: back off
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            names = [n for n in z.namelist() if n.endswith(".parquet")]
            blob = z.read(names[0])
    if blob[:4] != b"PAR1":
        raise ValueError(f"{path}: not a parquet file")
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(blob)
    tmp.rename(dest)
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-sign", type=int, default=20)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    lab = pd.read_parquet(SHARED / "labels.parqet")
    lab["participant"] = lab.path.str.split("/").str[1]
    oov = {p.name for p in OOV.iterdir() if p.is_dir()}
    assert len(oov) == 30, oov
    rows = []
    rng = np.random.default_rng(0)
    for sign, g in lab.groupby("sign", sort=True):
        if sign in oov:
            continue
        if sign in OURS:
            have = g[g.path.map(lambda p: (SHARED / p).exists())]
            rows += [dict(path=p, sign=sign, participant=q, where="shared") for p, q in zip(have.path, have.participant)]
            continue
        shared = g[g.path.map(lambda p: (SHARED / p).exists())]
        take = [dict(path=p, sign=sign, participant=q, where="shared") for p, q in zip(shared.path, shared.participant)]
        need = a.per_sign - len(take)
        if need > 0:
            rest = g[~g.path.isin(shared.path)]
            rest = rest.iloc[rng.permutation(len(rest))]
            rest = rest.assign(k=rest.groupby("participant").cumcount()).sort_values(["k", "participant"], kind="stable")
            take += [dict(path=p, sign=sign, participant=q, where="transfer") for p, q in zip(rest.path[:need], rest.participant[:need])]
        rows += take[:max(a.per_sign, len(shared))]
    todo = [r for r in rows if r["where"] == "transfer"]
    print(f"{len(rows)} clips, {len({r['sign'] for r in rows})} signs; {len(todo)} to download")
    if a.dry_run:
        return
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(a.workers) as ex:
        n = sum(ex.map(lambda r: fetch(r["path"], OUT / r["path"]), todo))
    print(f"downloaded {n}")
    (OUT / "stage1_index.json").write_text(json.dumps({"source": "Kaggle sohier/461054610546105 (CC0)",
                                                      "excluded_signs_oov_test": sorted(oov), "per_sign": a.per_sign,
                                                      "clips": rows}, indent=0))


if __name__ == "__main__":
    main()

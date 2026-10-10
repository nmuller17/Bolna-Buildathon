"""Convert Kaggle "Google - Isolated Sign Language Recognition" (GISLR) landmarks to our Frame JSON layout.

    pip install pandas pyarrow          # converter only, not needed by the server
    # labelled rerun copy, no Kaggle login: fetch only the 7 overlapping signs (~1,105 files, ~556 MB)
    python -m recognition.tools.gislr_to_frames --download --root data/gislr_raw
    python -m recognition.tools.gislr_to_frames --root data/gislr_raw --out data/gislr
    # or the competition train set (Kaggle account + rules): --root asl-signs (has train.csv)

Input: a labels table and one parquet per sequence. The table is <root>/train.csv
(path, participant_id, sequence_id, sign) or the rerun set's labels file (path, sign,
Usage; the participant is the folder name in path). Each parquet has columns frame
(int16), row_id, type, landmark_index (int16), x, y, z (float64), 543 rows per frame
in the order face 0-467, left_hand 0-20, pose 0-32, right_hand 0-20; a hand that was
not detected is 21 rows of NaN. Coordinates are image-normalized and y-down like ours.
Output: <out>/<OUR_LABEL>/gislr<participant>_<sequence>.json as SignFile dicts,
normalized per CLAUDE.md 6.2, face reduced to the 26 indices of 6.1, a part with any
NaN written as null. Only signs in GISLR_TO_OURS are converted, plus (with --oov-none N)
up to N takes of every other GISLR sign as NONE, to teach the model to reject signs
outside our vocabulary. Use the result with `--extra-data data/gislr`.

Licence: the data card says CC BY 4.0, but the competition rules forbid redistributing
the data. Keep raw and converted files in the gitignored data/ folder, never in signs/
or the repo; trained weights may be shared with attribution.

Caveats:
- MediaPipe x and y are divided by image width and height separately, and GISLR clips
  are phone videos (aspect ratio not given), so x is stretched or squeezed relative to y
  compared with our webcam.
- fps is not given in GISLR; 30 is written as an assumption.
- Some signers' dominant hand is labelled left_hand: features.assign_hands reassigns
  hands by the pose wrists, and training mirrors half the takes.
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from recognition import features

# Our label <- GISLR sign. Checked against the 250-sign sign_to_prediction_index_map.json
# downloaded from Kaggle (rerun set) and the dataset authors' list (Accessible-Technology-in-Sign/ISLR-ML
# meta/250_sign_list.txt). RESERVATION, NAME, ELEVATOR, FS-WIFI, PASSWORD, BREAKFAST, TOWEL, MORE,
# FS-CHECKOUT, LATE, PARKING, TAXI, HELP, RESTAURANT are not in GISLR.
GISLR_TO_OURS = {
    "yes": "YES",
    "no": "NO",
    "please": "PLEASE",
    "thankyou": "THANK-YOU",
    "where": "WHERE",
    "time": "TIME",
    "room": "ROOM",
}
TYPES = {"pose": ("pose", 33), "left_hand": ("lh", 21), "right_hand": ("rh", 21), "face": ("face", 468)}
RERUN_URL = "https://www.kaggle.com/api/v1/datasets/download/sohier/461054610546105/"
RERUN_LABELS = "labels.parqet"  # sic


def _pandas():
    try:
        import pandas as pd
        return pd
    except ImportError:
        sys.exit("gislr_to_frames needs pandas and pyarrow: pip install pandas pyarrow (not a server dependency)")


def read_labels(root, labels=None):
    """Labels table with columns path, participant_id, sequence_id, sign (derived from path if missing)."""
    pd = _pandas()
    root = Path(root)
    if labels is None:
        labels = root / "train.csv" if (root / "train.csv").exists() else root / RERUN_LABELS
    labels = Path(labels)
    meta = pd.read_csv(labels) if labels.suffix == ".csv" else pd.read_parquet(labels)
    parts = meta["path"].str.split("/")
    if "participant_id" not in meta:
        meta["participant_id"] = parts.str[-2]
    if "sequence_id" not in meta:
        meta["sequence_id"] = parts.str[-1].str.replace(".parquet", "", regex=False)
    return meta


def select(meta, oov_none=0):
    """Rows to convert: every take of an overlapping sign, plus up to oov_none takes of each other sign."""
    ours = meta[meta["sign"].isin(GISLR_TO_OURS)]
    if not oov_none:
        return ours
    other = meta[~meta["sign"].isin(GISLR_TO_OURS)].groupby("sign", group_keys=False).head(oov_none)
    return _pandas().concat([ours, other])


def download(root, oov_none=0, workers=8):
    """Fetch the rerun labels file and the selected parquet files into root (skips files already there)."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    lab = root / RERUN_LABELS
    if not lab.exists():
        urllib.request.urlretrieve(RERUN_URL + RERUN_LABELS, lab)
    rows = select(read_labels(root, lab), oov_none)

    def get(path):
        dest = root / path
        if dest.exists():
            return 0
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        urllib.request.urlretrieve(RERUN_URL + urllib.parse.quote(path, safe=""), tmp)
        tmp.rename(dest)
        return 1

    with ThreadPoolExecutor(workers) as ex:
        n = sum(ex.map(get, rows["path"]))
    return n, len(rows)


def df_to_seq(df):
    """GISLR landmark DataFrame (one sequence) -> raw Seq (face already reduced to the 26 indices)."""
    frame_ids = np.sort(df["frame"].unique())
    pos = {f: i for i, f in enumerate(frame_ids)}
    T = len(frame_ids)
    seq = {}
    for typ, (key, n) in TYPES.items():
        a = np.full((T, n, 3), np.nan, np.float32)
        sub = df[df["type"] == typ]
        if len(sub):
            ti = sub["frame"].map(pos).to_numpy()
            li = sub["landmark_index"].to_numpy().astype(int)
            ok = (li >= 0) & (li < n)
            a[ti[ok], li[ok]] = sub[["x", "y", "z"]].to_numpy(np.float32)[ok]
        seq[key] = a
    seq["face"] = seq["face"][:, features.FACE_INDICES]
    return seq


def df_to_signfile(df, label, signer):
    seq, ok = features.normalize(df_to_seq(df))
    return {"id": label, "source": "public", "signer": signer, "fps": 30,
            "frames": features.seq_to_frames(seq, ndigits=4)}, ok


def convert(root, out, max_per_sign=None, labels=None, oov_none=0):
    pd = _pandas()
    root, out = Path(root), Path(out)
    meta = read_labels(root, labels)
    if max_per_sign:
        meta = meta.groupby("sign", group_keys=False).head(max_per_sign)
    meta = select(meta, oov_none)
    n = skipped = 0
    for row in meta.itertuples(index=False):
        src = root / row.path
        if not src.exists():
            skipped += 1
            continue
        df = pd.read_parquet(src, columns=["frame", "type", "landmark_index", "x", "y", "z"])
        label, signer = GISLR_TO_OURS.get(row.sign, "NONE"), f"gislr{row.participant_id}"
        doc, ok = df_to_signfile(df, label, signer)
        if not ok or not doc["frames"]:
            skipped += 1
            continue
        d = out / label
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{signer}_{row.sequence_id}.json", "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        n += 1
    return n, skipped


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="folder with the labels table and the parquet files")
    ap.add_argument("--out", help="output folder in the data/train layout")
    ap.add_argument("--labels", help="labels table (default <root>/train.csv, else <root>/labels.parqet)")
    ap.add_argument("--max-per-sign", type=int, default=None)
    ap.add_argument("--oov-none", type=int, default=0, help="also convert up to N takes of each other sign as NONE")
    ap.add_argument("--download", action="store_true", help="download the selected rerun-set files into --root first")
    args = ap.parse_args(argv)
    if args.download:
        got, total = download(args.root, args.oov_none)
        print(f"downloaded {got} new files ({total} selected) into {args.root}")
    if args.out:
        n, skipped = convert(args.root, args.out, args.max_per_sign, args.labels, args.oov_none)
        print(f"wrote {n} files to {args.out} ({skipped} skipped: missing file, no pose or empty)")


if __name__ == "__main__":
    main()

import json

import numpy as np
import pytest

from recognition.features import FACE_INDICES

pd = pytest.importorskip("pandas")
from recognition.tools.gislr_to_frames import RERUN_LABELS, convert, df_to_seq, read_labels  # noqa: E402


def gislr_df(T=3, left_missing=True, seed=0):
    """Same schema as the real files: 543 rows per frame, face, left_hand, pose, right_hand."""
    rng = np.random.default_rng(seed)
    rows = []
    wrists = {"left_hand": (0.7, 0.8), "right_hand": (0.3, 0.8)}  # pose 15 / 16
    for f in range(T):
        for typ, n in (("face", 468), ("left_hand", 21), ("pose", 33), ("right_hand", 21)):
            for i in range(n):
                x, y, z = rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.7), rng.normal(0, 0.05)
                if typ in wrists:
                    x, y = np.add(wrists[typ], rng.normal(0, 0.03, 2))
                if typ == "pose" and i in (11, 12, 15, 16):
                    x, y, z = {11: (0.6, 0.6, 0.0), 12: (0.4, 0.6, 0.0), 15: (0.7, 0.8, 0.0), 16: (0.3, 0.8, 0.0)}[i]
                if typ == "face":
                    x = i / 1000.0  # encode the mesh index so the subset can be checked
                if typ == "left_hand" and left_missing:
                    x = y = z = np.nan
                rows.append((f + 20, f"{f + 20}-{typ}-{i}", typ, i, x, y, z))
    df = pd.DataFrame(rows, columns=["frame", "row_id", "type", "landmark_index", "x", "y", "z"])
    return df.astype({"frame": "int16", "landmark_index": "int16"})


def test_in_memory_conversion_layout():
    seq = df_to_seq(gislr_df())
    assert seq["pose"].shape == (3, 33, 3) and seq["face"].shape == (3, 26, 3)
    assert np.isnan(seq["lh"]).all() and np.isfinite(seq["rh"]).all()
    assert np.allclose(seq["face"][0, :, 0], np.array(FACE_INDICES) / 1000.0)


def test_convert_parquet_folder(tmp_path):
    pytest.importorskip("pyarrow")
    root = tmp_path / "asl-signs"
    (root / "train_landmark_files" / "26734").mkdir(parents=True)
    rows = []
    for k, sign in enumerate(["thankyou", "yes", "zebra"]):
        rel = f"train_landmark_files/26734/{1000 + k}.parquet"
        gislr_df(seed=k).to_parquet(root / rel)
        rows.append((rel, 26734, 1000 + k, sign))
    pd.DataFrame(rows, columns=["path", "participant_id", "sequence_id", "sign"]).to_csv(root / "train.csv", index=False)
    out = tmp_path / "out"
    n, skipped = convert(root, out)
    assert (n, skipped) == (2, 0)
    assert sorted(p.name for p in out.iterdir()) == ["THANK-YOU", "YES"]
    doc = json.loads((out / "THANK-YOU" / "gislr26734_1000.json").read_text())
    assert doc["id"] == "THANK-YOU" and doc["source"] == "public" and len(doc["frames"]) == 3
    f0 = doc["frames"][0]
    assert f0["lh"] is None and len(f0["rh"]) == 21 and len(f0["face"]) == 26 and len(f0["pose"]) == 33
    assert np.allclose(f0["pose"][11][:2], [0.5, 0.0], atol=1e-3) and np.allclose(f0["pose"][12][:2], [-0.5, 0.0], atol=1e-3)


def test_rerun_layout_and_oov_negatives(tmp_path):
    # Rerun set: labels file has path, sign, Usage; the participant is the folder name in path.
    pytest.importorskip("pyarrow")
    root = tmp_path / "gislr_raw"
    rows = []
    for k, sign in enumerate(["room", "zebra", "zebra", "dog"]):
        rel = f"test_landmark_files/{11672 + k}/{2000 + k}.parquet"
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        gislr_df(seed=k).to_parquet(root / rel)
        rows.append((rel, sign, "Public"))
    rows.append(("test_landmark_files/1/9.parquet", "yes", "Private"))  # listed but not downloaded
    pd.DataFrame(rows, columns=["path", "sign", "Usage"]).to_parquet(root / RERUN_LABELS)
    meta = read_labels(root)
    assert meta["participant_id"].tolist()[:2] == ["11672", "11673"] and meta["sequence_id"].tolist()[0] == "2000"
    out = tmp_path / "out"
    assert convert(root, out) == (1, 1)
    assert [p.name for p in (out / "ROOM").iterdir()] == ["gislr11672_2000.json"]
    assert convert(root, tmp_path / "out2", oov_none=1) == (3, 1)  # 1 zebra + 1 dog as NONE
    assert sorted(p.name for p in (tmp_path / "out2" / "NONE").iterdir()) == ["gislr11673_2001.json", "gislr11675_2003.json"]

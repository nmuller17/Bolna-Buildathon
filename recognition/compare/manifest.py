"""Per-run manifests for the pre-registered comparison (PROTOCOL.md).

Every (system, fold) job writes <run>/preds/<system>_<fold>.manifest.json after its predictions.
The report uses a prediction file only when a manifest exists, was written under the current
PROTOCOL.md, names the same clip index, lists exactly the training and test clips this fold must
have (equal exposure, no outside-vocabulary test sign in training, the test signer nowhere in
training or inner validation), and still matches the prediction files byte for byte.

A manifest cannot be written after the fact for old runs: it records the state of the code and
the machine at the time of the run. Legacy runs (data/compare/track_a) therefore have none and
are refused by the protocol report.
"""
import hashlib
import json
import os
import platform
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
PROTOCOL = HERE / "PROTOCOL.md"
SCHEMA = 1
# Files whose content decides what a trained model and its predictions are. The report requires
# them to be identical across every manifest it combines.
TRAINING_CODE = ["recognition/compare/common.py", "recognition/compare/islr1st.py",
                 "recognition/compare/track_a_gislr.py", "recognition/features.py", "recognition/model.py",
                 "recognition/train.py", "recognition/data.py", "recognition/labels.py"]


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


def sha256_ids(ids):
    """Order-free fingerprint of a list of clip IDs (one per line, sorted)."""
    return sha256_bytes("\n".join(sorted(map(str, ids))).encode())


def protocol_sha256():
    return sha256_file(PROTOCOL) if PROTOCOL.exists() else None


def index_fingerprint(idx):
    """Canonical fingerprint of the clip index: every clip's (id, signer, label, oov, gislr sign)
    and the NONE_TRAIN / NONE_TEST split. Independent of JSON formatting and clip order."""
    canon = {"clips": sorted([[c["clip_id"], c["signer"], c["label"], c["oov"], c["gislr_sign"]] for c in idx["clips"]]),
             "none_train": sorted(idx["none_train_signs"]), "none_test": sorted(idx["none_test_signs"])}
    return sha256_bytes(json.dumps(canon, separators=(",", ":"), sort_keys=True).encode())


def code_hashes(root=ROOT):
    files = sorted({str(p.relative_to(root)) for p in (root / "recognition/compare").glob("*.py")} | set(TRAINING_CODE)
                   | {"recognition/benchmark.py"})
    return {f: sha256_file(root / f) for f in files if (root / f).exists()}


def training_code_hashes(root=ROOT):
    """sha256 of the TRAINING_CODE files only (what the report requires to be identical across jobs)."""
    return {f: sha256_file(root / f) for f in TRAINING_CODE if (root / f).exists()}


def git_info(root=ROOT):
    def git(*args):
        try:
            return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=20).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    status = git("status", "--porcelain", "--untracked-files=no")
    return {"commit": git("rev-parse", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "modified_tracked_files": status.splitlines() if status else [],
            "note": "recognition/compare/ is untracked; its exact content is in code_sha256"}


def versions():
    out = {"python": sys.version.split()[0], "platform": platform.platform()}
    for mod in ("numpy", "torch", "pandas", "pyarrow"):
        try:
            out[mod] = __import__(mod).__version__
        except ImportError:
            out[mod] = None
    return out


def host_load():
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        load = None
    return {"loadavg_1_5_15": load, "cpu_count": os.cpu_count()}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def label_counts(clips):
    return dict(sorted(Counter(c["label"] for c in clips).items()))


def expected_fold(idx, fold, fold_sets):
    """What a protocol job for this outer fold must have trained and tested on."""
    return fold_data(*fold_sets(idx, fold))


def fold_data(tr, te, te_oov):
    """Signers, clip-list fingerprints and counts of one outer fold (recorded by the job, checked by the report)."""
    return {"train_signers": sorted({c["signer"] for c in tr}, key=int),
            "train_clips_sha256": sha256_ids(c["clip_id"] for c in tr), "n_train": len(tr),
            "test_clips_sha256": sha256_ids(c["clip_id"] for c in te), "n_test": len(te),
            "test_oov_clips_sha256": sha256_ids(c["clip_id"] for c in te_oov), "n_test_oov": len(te_oov),
            "train_gislr_signs": sorted({c["gislr_sign"] for c in tr if c["oov"]})}


def manifest_path(run_dir, system, fold):
    return Path(run_dir) / "preds" / f"{system}_{fold}.manifest.json"


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1) + "\n")
    tmp.replace(path)


def check(idx, system, fold, run_dir, fold_sets, pred_files, protocol=None):
    """Errors (list of strings; empty = usable) for one (system, fold) manifest.

    pred_files: the prediction files the report is about to use for this (system, fold)."""
    p = manifest_path(run_dir, system, fold)
    if not p.exists():
        return [f"{system}/{fold}: no manifest (results produced outside the protocol)"]
    m = json.loads(p.read_text())
    errors = []
    want_protocol = protocol if protocol is not None else protocol_sha256()
    if m.get("schema") != SCHEMA:
        errors.append(f"{system}/{fold}: manifest schema {m.get('schema')} != {SCHEMA}")
    if m.get("smoke"):
        errors.append(f"{system}/{fold}: smoke-test manifest, not a protocol run")
    if want_protocol is None:
        errors.append("PROTOCOL.md is missing: no result can be accepted")
    elif m.get("protocol_sha256") != want_protocol:
        errors.append(f"{system}/{fold}: written under a different PROTOCOL.md")
    if m.get("index_sha256") != index_fingerprint(idx):
        errors.append(f"{system}/{fold}: different clip index")
    if m.get("system") != system or str(m.get("fold")) != str(fold):
        errors.append(f"{system}/{fold}: manifest names {m.get('system')}/{m.get('fold')}")
    outputs = m.get("outputs", {})
    for f in pred_files:
        name = f"preds/{Path(f).name}"
        if name not in outputs:
            errors.append(f"{system}/{fold}: {name} not listed in the manifest")
        elif outputs[name] != sha256_file(f):
            errors.append(f"{system}/{fold}: {name} changed after the manifest was written")
    if system == "islr1st_pretrained":
        if m.get("rejection_rule", {}).get("R8") != "sum_of_other_signs":
            errors.append(f"{system}: R8 must use the pre-specified sum rule")
        return errors
    want = expected_fold(idx, fold, fold_sets)
    got = m.get("data", {})
    for key, value in want.items():
        if got.get(key) != value:
            errors.append(f"{system}/{fold}: {key} differs from the protocol fold")
    leak = set(got.get("train_gislr_signs", [])) & set(idx["none_test_signs"])
    if leak:
        errors.append(f"{system}/{fold}: outside-vocabulary TEST signs in training: {sorted(leak)}")
    end = m.get("code_sha256_end")
    if end is not None and any(m.get("code_sha256", {}).get(f) != end.get(f) for f in TRAINING_CODE):
        errors.append(f"{system}/{fold}: training code changed while the job was running")
    inner = m.get("inner", {})
    if str(fold) in got.get("train_signers", []) or str(fold) in inner.get("val_signers", []) \
            or str(fold) in inner.get("train_signers", []):
        errors.append(f"{system}/{fold}: outer test signer used in training or inner validation")
    if set(inner.get("val_signers", [])) - set(want["train_signers"]):
        errors.append(f"{system}/{fold}: inner validation signer outside the fold's training signers")
    tuning = m.get("tuning", {})
    if system != "ours_baseline" and (tuning.get("epochs_max") != 60 or tuning.get("rule") != "inner_val_loss_patience_12"):
        errors.append(f"{system}/{fold}: epochs not chosen by the pre-registered nested rule")
    return errors


def load(run_dir, system, fold):
    p = manifest_path(run_dir, system, fold)
    return json.loads(p.read_text()) if p.exists() else None


def code_consistency(manifests):
    """Errors when the manifests used together were produced by different training code."""
    seen = {}
    errors = []
    for name, m in manifests.items():
        key = tuple((f, m.get("code_sha256", {}).get(f)) for f in TRAINING_CODE)
        seen.setdefault(key, []).append(name)
    if len(seen) > 1:
        errors.append("manifests come from different training code: " +
                      " | ".join(", ".join(sorted(v)[:3]) + ("..." if len(v) > 3 else "") for v in seen.values()))
    return errors

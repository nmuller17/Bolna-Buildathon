"""Track B: our 22 classes, the same video clips for every system.

Clips: <clips>/<LABEL>/<signer>_<n>.mp4, LABEL one of the 22 classifier labels (NONE included), or
<clips>/_OOV/<signer>_<sign>_<n>.mp4 for real signs outside the vocabulary (scored as open-set:
the right answer is NONE). An optional <name>.json next to an mp4 (Frame[] or SignFile) is used
instead of running MediaPipe. Keep the clips in the gitignored data/ folder.

    python -m recognition.compare.track_b_video extract --clips data/track_b/clips [--frames 16 8]
    python -m recognition.compare.track_b_video ours --clips data/track_b/clips --checkpoint recognition/models/model.pt --name ours_gru
    python -m recognition.compare.track_b_video claude --clips data/track_b/clips --model claude-sonnet-5 --frames 16 --i-have-consent
    python -m recognition.compare.track_b_video template --clips data/track_b/clips --system rylo > data/track_b/rylo.csv
    python -m recognition.compare.track_b_video manual --csv data/track_b/rylo.csv --system rylo
    python -m recognition.compare.report --track b --tag team
    python -m recognition.compare.track_b_video smoke      # plumbing test on generated clips (no accuracy meaning)

Outputs go to data/compare/track_b/ (landmarks, sampled frames, preds/<system>.jsonl).
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from recognition.compare import common
from recognition.labels import CLASSES, NONE

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/compare/track_b"
BENCH_PY = Path.home() / ".venvs/signbridge-bench/bin/python"
HERE = Path(__file__).parent
OOV_DIR = "_OOV"

# Free text (as a human copies it from another product's screen) -> our label.
PHRASES = {
    "YES": ["yes"], "NO": ["no"], "RESERVATION": ["reservation", "reserved", "booking", "booked"],
    "NAME": ["name"], "THANK-YOU": ["thank you", "thanks", "thankyou"], "WHERE": ["where"],
    "ELEVATOR": ["elevator", "lift"], "FS-WIFI": ["wifi", "wi fi", "wi-fi", "internet"],
    "PASSWORD": ["password"], "BREAKFAST": ["breakfast"], "TIME": ["time", "what time"],
    "TOWEL": ["towel", "towels"], "MORE": ["more"], "FS-CHECKOUT": ["checkout", "check out", "check-out"],
    "LATE": ["late"], "PLEASE": ["please"], "PARKING": ["parking", "park"], "TAXI": ["taxi", "cab"],
    "HELP": ["help"], "ROOM": ["room"], "RESTAURANT": ["restaurant"],
}


def clips_of(clips_dir):
    """[(clip_id, signer, true_label, oov, mp4 path)] for <dir>/<LABEL>/<signer>_<n>.mp4."""
    out = []
    for mp4 in sorted(Path(clips_dir).glob("*/*.mp4")):
        label = mp4.parent.name
        if label != OOV_DIR and label not in CLASSES:
            print(f"WARNING: skipping {mp4}: folder is not one of the 22 labels or {OOV_DIR}", file=sys.stderr)
            continue
        signer = mp4.stem.split("_", 1)[0] if label == OOV_DIR else mp4.stem.rsplit("_", 1)[0]
        out.append((f"{label}/{mp4.stem}", signer, NONE if label == OOV_DIR else label, label == OOV_DIR, mp4))
    return out


def extract(clips_dir, frames=()):
    if not BENCH_PY.exists():
        sys.exit(f"bench venv not found at {BENCH_PY} (needs mediapipe + opencv-python-headless)")
    cmd = [str(BENCH_PY), str(HERE / "tb_extract.py"), "--clips", str(clips_dir), "--out", str(OUT)]
    if frames:
        cmd += ["--frames", *map(str, frames)]
    subprocess.run(cmd, check=True)


def prepare(doc, gate=True, waist="hips"):
    """One clip's landmark document -> (frames for Recognizer.predict or None, outcome).

    Uncleaned capture-parity documents (tb_extract.PIPELINE) go through what recognition.stream does
    for one sign: the framing gate over the hand-visible span (at least framing.MIN_OK_FRACTION of the
    frames OK, else rejected), then capture.clean.clean(frames, capture times in ms), at most MAX_FRAMES.
    A clip is one take, as capture.py records it, so the live segmenter is not part of this path.
    Pre-cleaned capture.py SignFiles are passed through unchanged (no framing information)."""
    from recognition import framing, mediapipe_adapter as mpa
    from recognition.compare.tb_extract import PIPELINE
    from recognition.recognizer import MAX_FRAMES
    if isinstance(doc, list) or doc.get("stage") == "cleaned":
        frames = doc if isinstance(doc, list) else doc["frames"]
        return (frames or None), ("precleaned" if frames else "empty")
    if doc.get("pipeline") != PIPELINE:
        raise ValueError("landmarks were not made by the capture-parity extractor; re-run track_b_video extract")
    frames, t_ms = doc["frames"], doc["t_ms"]
    hands = [i for i, f in enumerate(frames) if f is not None and (f["lh"] is not None or f["rh"] is not None)]
    if not hands:
        return None, "no_hands"            # live: no sign event, nothing spoken
    if gate:
        statuses = doc["framing"][waist][hands[0]:hands[-1] + 1]
        if not framing.segment_ok(statuses):
            return None, f"framing_rejected:{framing.dominant(statuses)}"   # live: NONE 0.0, asks to repeat
    _, clean = mpa.capture_modules()
    out = clean.clean(list(frames), list(t_ms))[:MAX_FRAMES]
    return (out or None), ("ok" if out else "empty_after_clean")


def run_ours(clips_dir, checkpoint, name, gate=True, waist="hips", allow_unpinned=False):
    """Our recognizer exactly as live uses it: prepare() then Recognizer(checkpoint).predict (model
    hash pin, validate, NONE without enough hands/pose). A clip the live path would not speak (no
    hands, framing rejected) is recorded as NONE with confidence 0, plus its outcome.
    allow_unpinned: development and smoke tests only (the report refuses unpinned non-smoke rows)."""
    import inspect

    from recognition import model_pin
    from recognition.compare import manifest
    from recognition.recognizer import Recognizer
    kw = {"allow_unpinned": True} if allow_unpinned and "allow_unpinned" in inspect.signature(Recognizer).parameters else {}
    rec = Recognizer(checkpoint, **kw)
    sha = manifest.sha256_file(checkpoint)
    pinned = bool(model_pin.EXPECTED_SHA256) and model_pin.EXPECTED_SHA256.lower() == sha
    recs, outcomes = [], {}
    for clip_id, signer, label, oov, mp4 in clips_of(clips_dir):
        lm = OUT / "landmarks" / mp4.parent.name / f"{mp4.stem}.json"
        if not lm.exists():
            recs.append(common.record(name, clip_id, signer, label, track="B", oov=oov))  # no answer
            outcomes["no_landmarks"] = outcomes.get("no_landmarks", 0) + 1
            continue
        t0 = time.perf_counter()
        frames, outcome = prepare(json.loads(lm.read_text()), gate, waist)
        top = rec.predict(frames) if frames else [{"label": NONE, "conf": 0.0}]
        ms = (time.perf_counter() - t0) * 1000
        outcomes[outcome.split(":")[0]] = outcomes.get(outcome.split(":")[0], 0) + 1
        recs.append(common.record(name, clip_id, signer, label, top=[(t["label"], t["conf"]) for t in top],
                                  track="B", oov=oov, latency_ms=round(ms, 2), live_outcome=outcome))
    path = OUT / "preds" / f"{name}.jsonl"
    common.write_jsonl(path, recs)
    manifest.write(OUT / "preds" / f"{name}.manifest.json", {
        "pipeline": "capture-parity-v1", "system": name, "created": manifest.now(),
        "checkpoint": {"path": str(checkpoint), "sha256": sha, "pinned": pinned},
        "framing_gate": gate, "waist": waist, "outcomes": outcomes, "n_clips": len(recs),
        "preds_sha256": manifest.sha256_file(path), "code_sha256": manifest.code_hashes(),
        "git": manifest.git_info(), "versions": manifest.versions()})
    print(f"{name}: {len(recs)} clips -> {path}; outcomes {outcomes}")


def run_claude(clips_dir, model, n_frames, consent):
    print("PRIVACY: this sends video frames of every clip, faces included, to the Anthropic API. Only use clips "
          "from people who gave written consent to third-party processing; never guest or production video.",
          file=sys.stderr)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(f"skipped {model}: ANTHROPIC_API_KEY is not set", file=sys.stderr)
        return False
    if not consent:
        sys.exit("refusing to send video frames without --i-have-consent")
    fdir = OUT / f"frames{n_frames}"
    if not fdir.exists():
        extract(clips_dir, [n_frames])
    raw = OUT / f"claude_{model}_{n_frames}f_raw.jsonl"
    subprocess.run([str(BENCH_PY), str(HERE / "tb_claude.py"), "--frames-dir", str(fdir), "--model", model,
                    "--out", str(raw)], check=True)
    rows = {}
    for line in raw.read_text().splitlines():
        r = json.loads(line)
        rows[r["clip_id"]] = r  # last attempt wins
    recs = []
    name = f"{model}" if n_frames == 16 else f"{model}-{n_frames}f"
    for clip_id, signer, label, oov, _ in clips_of(clips_dir):
        r = rows.get(clip_id, {})
        top = [(r["label"], None)] if r.get("label") else []  # its confidence is not calibrated: not used
        recs.append(common.record(name, clip_id, signer, label, top=top, track="B", oov=oov,
                                  latency_ms=r.get("latency_ms"), stated_confidence=r.get("confidence"),
                                  usd=r.get("usd"), input_tokens=r.get("input_tokens"),
                                  output_tokens=r.get("output_tokens"), error=r.get("error")))
    common.write_jsonl(OUT / "preds" / f"{name}.jsonl", recs)
    usd = sum(r.get("usd") or 0 for r in rows.values())
    print(f"{name}: {len(recs)} clips, ${usd:.2f} total")
    return True


def map_text(text):
    """Free text -> (label or None, note). None = no answer (empty output)."""
    t = " " + re.sub(r"[^a-z0-9\- ]+", " ", (text or "").lower()) + " "
    if not t.strip():
        return None, "empty"
    hits = sorted({lab for lab, ps in PHRASES.items() if any(f" {p} " in t for p in ps)})
    if len(hits) == 1:
        return hits[0], "mapped"
    if not hits:
        return NONE, "no-match"
    return NONE, "ambiguous:" + "|".join(hits)


def template(clips_dir, system):
    w = csv.writer(sys.stdout)
    w.writerow(["clip_id", "system", "output_text", "mapped_label", "notes"])
    for clip_id, *_ in clips_of(clips_dir):
        w.writerow([clip_id, system, "", "", ""])


def manual(csv_path, clips_dir, system):
    """Import a human-recorded results sheet. mapped_label (if filled) overrides the automatic mapping;
    an empty output_text and mapped_label means the product gave no answer."""
    truth = {c[0]: c for c in clips_of(clips_dir)}
    recs, notes = [], {}
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            if row.get("system") and row["system"] != system:
                continue
            clip_id = row["clip_id"]
            if clip_id not in truth:
                print(f"WARNING: {clip_id} not under {clips_dir}; ignored", file=sys.stderr)
                continue
            _, signer, label, oov, _ = truth[clip_id]
            manual_label = (row.get("mapped_label") or "").strip().upper()
            if manual_label:
                if manual_label not in CLASSES:
                    sys.exit(f"{clip_id}: mapped_label {manual_label!r} is not one of the 22 labels")
                pred, note = manual_label, "human-mapped"
            else:
                pred, note = map_text(row.get("output_text"))
            notes[note.split(":")[0]] = notes.get(note.split(":")[0], 0) + 1
            recs.append(common.record(system, clip_id, signer, label, top=[(pred, None)] if pred else [],
                                      track="B", oov=oov, output_text=row.get("output_text"), map_note=note))
    common.write_jsonl(OUT / "preds" / f"{system}.jsonl", recs)
    print(f"{system}: {len(recs)} rows imported, mapping {notes}")


def smoke():
    """Generate 6 tiny clips (no person in them), run every Track B step, write a report tagged smoke."""
    global OUT
    import shutil
    base = ROOT / "data/compare/track_b_smoke"
    shutil.rmtree(base, ignore_errors=True)      # regenerate everything (old outputs used legacy extraction)
    OUT = base / "out"
    clips = base / "clips"
    gen = ("import cv2, numpy as np, sys, pathlib\n"
           "root = pathlib.Path(sys.argv[1])\n"
           "for lab, n in [('YES', 2), ('THANK-YOU', 2), ('NONE', 1), ('_OOV', 1)]:\n"
           "    d = root / lab; d.mkdir(parents=True, exist_ok=True)\n"
           "    for k in range(n):\n"
           "        name = f'smoke_dog_{k}' if lab == '_OOV' else f'smoke_{k}'\n"
           "        w = cv2.VideoWriter(str(d / f'{name}.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 30, (320, 240))\n"
           "        for t in range(30):\n"
           "            img = np.full((240, 320, 3), 40, np.uint8)\n"
           "            cv2.circle(img, (40 + 8 * t, 120 + int(30 * np.sin(t / 4 + k))), 18, (200, 180, 160), -1)\n"
           "            w.write(img)\n"
           "        w.release()\n")
    subprocess.run([str(BENCH_PY), "-c", gen, str(clips)], check=True)
    # one clip gets pre-extracted landmarks (a real GISLR YES take) to exercise the JSON path and the model
    src = next((ROOT / "data/gislr/YES").glob("*.json"), None)
    if src:
        (clips / "YES" / "smoke_0.json").write_text(src.read_text())
    extract(clips, [8])
    ck = ROOT / "recognition/models/model.pt"
    if not ck.exists():
        sys.exit("smoke needs a checkpoint at recognition/models/model.pt")
    run_ours(clips, ck, "ours_gru", allow_unpinned=True)   # smoke only: the dev model may be unpinned
    run_claude(clips, "claude-sonnet-5", 8, consent=False)
    sheet = base / "manual.csv"
    with open(sheet, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["clip_id", "system", "output_text", "mapped_label", "notes"])
        for i, (clip_id, *_rest) in enumerate(clips_of(clips)):
            w.writerow([clip_id, "manual_demo", ["What is your name?", "thanks!", "", "Yes", "wifi password", "hello"][i % 6],
                        "", "made-up text to test the importer"])
    manual(sheet, clips, "manual_demo")
    from recognition.compare import report
    report.track_b(OUT / "preds", "smoke")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    e.add_argument("--clips", required=True)
    e.add_argument("--frames", type=int, nargs="*", default=[])
    o = sub.add_parser("ours")
    o.add_argument("--clips", required=True)
    o.add_argument("--checkpoint", default=str(ROOT / "recognition/models/model.pt"))
    o.add_argument("--name", default="ours_gru")
    o.add_argument("--no-gate", action="store_true", help="sensitivity analysis only: skip the framing gate")
    o.add_argument("--waist", choices=["hips", "none"], default="hips")
    o.add_argument("--allow-unpinned", action="store_true", help="development only; the report refuses unpinned rows")
    c = sub.add_parser("claude")
    c.add_argument("--clips", required=True)
    c.add_argument("--model", default="claude-sonnet-5", choices=["claude-sonnet-5", "claude-opus-5-5"])
    c.add_argument("--frames", type=int, default=16)
    c.add_argument("--i-have-consent", action="store_true")
    t = sub.add_parser("template")
    t.add_argument("--clips", required=True)
    t.add_argument("--system", required=True)
    m = sub.add_parser("manual")
    m.add_argument("--csv", required=True)
    m.add_argument("--clips", required=True)
    m.add_argument("--system", required=True)
    sub.add_parser("smoke")
    a = ap.parse_args(argv)
    if a.cmd == "extract":
        extract(a.clips, a.frames)
    elif a.cmd == "ours":
        run_ours(a.clips, a.checkpoint, a.name, gate=not a.no_gate, waist=a.waist, allow_unpinned=a.allow_unpinned)
    elif a.cmd == "claude":
        run_claude(a.clips, a.model, a.frames, a.i_have_consent)
    elif a.cmd == "template":
        template(a.clips, a.system)
    elif a.cmd == "manual":
        manual(a.csv, a.clips, a.system)
    else:
        smoke()


if __name__ == "__main__":
    main()

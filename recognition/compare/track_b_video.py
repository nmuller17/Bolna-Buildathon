"""Track B: our 22 classes, the same video clips for every system.

Clips: <clips>/<LABEL>/<signer>_<n>.mp4, LABEL one of the 22 classifier labels (NONE included), or
<clips>/_OOV/<signer>_<sign>_<n>.mp4 for real signs outside the vocabulary (scored as open-set:
the right answer is NONE). A <name>.json next to an mp4 (pre-cleaned Frame[] or SignFile) is accepted only by the
smoke test: it carries no framing information and bypasses the live path, so real runs refuse it. Our models are
scored on what recognition.stream would classify (replay_stream). Keep the clips in the gitignored data/ folder.

    python -m recognition.compare.track_b_video extract --clips data/track_b/clips [--frames 16 8]
    python -m recognition.compare.track_b_video ours --clips data/track_b/clips --checkpoint recognition/models/model.pt --name ours_gru
    python -m recognition.compare.track_b_video claude --clips data/track_b/clips --model claude-sonnet-5 --frames 16 --i-have-consent
    python -m recognition.compare.track_b_video template --clips data/track_b/clips --system rylo --sheet data/track_b/blind/rylo.csv
    python -m recognition.compare.track_b_video manual --csv data/track_b/blind/rylo.csv --clips data/track_b/clips --system rylo --key data/compare/track_b/blind_keys/rylo_key.json
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


class _SavedFraming:
    """Stands in for recognition.framing inside recognition.stream during a replay: check() returns the framing
    status tb_extract saved for that frame; everything else is the real module."""

    def __getattr__(self, name):
        from recognition import framing
        return getattr(framing, name)

    @staticmethod
    def check(result, aspect, waist):
        return result[1]


class _Recorder:
    """Recognizer stand-in for a replay: keeps the frames the live stream would classify."""

    def __init__(self):
        self.got = []

    def predict(self, frames):
        self.got.append(frames)
        return [{"label": NONE, "conf": 0.0}]


def replay_stream(doc, gate=True, waist="hips"):
    """Run the REAL recognition.stream.SignStream (segmenter, segment extent, framing gate with the COME_CLOSER
    memory, capture.clean.clean, MAX_FRAMES) over one clip's saved per-frame capture-parity frames and framing
    statuses, constructed as classify_video/live construct it. Only the two per-frame computations that need the
    raw MediaPipe result (FrameAdapter and framing.check) are replaced by their saved outputs; a test checks
    the replay against SignStream.push/flush on the raw results. Returns one entry per sign the live stream would
    emit, in order: {"frames": [...]} (classified) or {"rejected": framing status}."""
    from recognition import stream as live
    if not doc.get("image_size"):
        raise ValueError("landmark file has no image_size; re-run track_b_video extract")
    rec = _Recorder()
    st = live.SignStream(rec, tuple(doc["image_size"]), waist=waist, gate=gate)
    st.adapter = lambda result: result[0]
    statuses = doc["framing"][waist]
    events = []
    saved, live.framing = live.framing, _SavedFraming()
    try:
        for frame, status, t in zip(doc["frames"], statuses, doc["t_ms"]):
            events += st.push((frame, status), t / 1000.0)
        events += st.flush()
    finally:
        live.framing = saved
    out, k = [], 0
    for ev in events:
        if ev.get("type") == "sign":
            out.append({"frames": rec.got[k]})
            k += 1
        elif ev.get("type") == "framing" and "rejected_seq" in ev:
            out.append({"rejected": ev["status"]})
    return out


def prepare(doc, gate=True, waist="hips", how="stream", allow_precleaned=False):
    """One clip's landmark document -> (frames for Recognizer.predict or None, outcome).

    how="stream" (default, AMENDMENTS.md item 16): replay_stream(), i.e. what recognition.stream gives the
    recognizer live. One sign event -> "ok"; several -> "split:N" and the longest classified segment is used;
    no sign event -> "no_sign_event"; every segment rejected by the framing gate -> "framing_rejected:<status>".
    how="take" (sensitivity analysis): the whole clip as one capture.py take: framing gate over the
    hand-visible span (at least framing.MIN_OK_FRACTION OK), then capture.clean.clean(frames, t_ms), MAX_FRAMES.
    Pre-cleaned capture.py SignFiles carry no framing information and bypass the live path, so they are refused
    unless allow_precleaned (smoke runs only)."""
    from recognition import framing, mediapipe_adapter as mpa
    from recognition.compare.tb_extract import PIPELINE
    from recognition.recognizer import MAX_FRAMES
    if isinstance(doc, list) or doc.get("stage") == "cleaned":
        if not allow_precleaned:
            raise ValueError("pre-cleaned landmark file (no framing information, bypasses the live path): refused "
                             "outside smoke runs; remove the <name>.json next to the mp4 and re-run extract")
        frames = doc if isinstance(doc, list) else doc["frames"]
        return (frames or None), ("precleaned" if frames else "empty")
    if doc.get("pipeline") != PIPELINE:
        raise ValueError("landmarks were not made by the capture-parity extractor; re-run track_b_video extract")
    if how not in ("stream", "take"):
        raise ValueError("how must be 'stream' or 'take'")
    frames, t_ms = doc["frames"], doc["t_ms"]
    hands = [i for i, f in enumerate(frames) if f is not None and (f["lh"] is not None or f["rh"] is not None)]
    if not hands:
        return None, "no_hands"            # live: no sign event, nothing spoken
    if how == "stream":
        segs = replay_stream(doc, gate, waist)
        done = [x for x in segs if x.get("frames")]
        if not segs:
            return None, "no_sign_event"
        if not done:
            return None, f"framing_rejected:{segs[0]['rejected']}"
        best = max(done, key=lambda x: len(x["frames"]))
        return best["frames"], ("ok" if len(segs) == 1 else f"split:{len(segs)}")
    if gate:
        statuses = doc["framing"][waist][hands[0]:hands[-1] + 1]
        if not framing.segment_ok(statuses):
            return None, f"framing_rejected:{framing.dominant(statuses)}"   # live: NONE 0.0, asks to repeat
    _, clean = mpa.capture_modules()
    out = clean.clean(list(frames), list(t_ms))[:MAX_FRAMES]
    return (out or None), ("ok" if out else "empty_after_clean")


def run_ours(clips_dir, checkpoint, name, gate=True, waist="hips", allow_unpinned=False, how="stream",
             allow_precleaned=False):
    """Our recognizer exactly as live uses it: prepare() then Recognizer(checkpoint).predict (model
    hash pin, validate, NONE without enough hands/pose). A clip the live path would not speak (no
    hands, no sign event, framing rejected) is recorded as NONE with confidence 0, plus its outcome.
    allow_unpinned / allow_precleaned: development and smoke tests only (the report refuses such non-smoke rows)."""
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
        frames, outcome = prepare(json.loads(lm.read_text()), gate, waist, how, allow_precleaned)
        top = rec.predict(frames) if frames else [{"label": NONE, "conf": 0.0}]
        ms = (time.perf_counter() - t0) * 1000
        outcomes[outcome.split(":")[0]] = outcomes.get(outcome.split(":")[0], 0) + 1
        recs.append(common.record(name, clip_id, signer, label, top=[(t["label"], t["conf"]) for t in top],
                                  track="B", oov=oov, latency_ms=round(ms, 2), live_outcome=outcome))
    path = OUT / "preds" / f"{name}.jsonl"
    common.write_jsonl(path, recs)
    manifest.write(OUT / "preds" / f"{name}.manifest.json", {
        "pipeline": "capture-parity-v1", "segmentation": "stream-replay-v1" if how == "stream" else "whole-clip-take",
        "system": name, "created": manifest.now(),
        "checkpoint": {"path": str(checkpoint), "sha256": sha, "pinned": pinned},
        "framing_gate": gate, "waist": waist, "allow_precleaned": bool(allow_precleaned), "outcomes": outcomes,
        "n_clips": len(recs), "preds_sha256": manifest.sha256_file(path), "code_sha256": manifest.code_hashes(),
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
    """Free text -> (labels in order of first mention, note). [] = no answer (empty output); ["NONE"] = the
    text names none of our signs. Several signs are kept (never turned into NONE): a sentence that names our
    signs is something the product said, so on an outside-vocabulary clip it is a false accept."""
    t = " " + re.sub(r"[^a-z0-9\- ]+", " ", (text or "").lower()) + " "
    t = re.sub(r" +", " ", t)
    if not t.strip():
        return [], "empty"
    pos = {}
    for lab, ps in PHRASES.items():
        hits = [t.find(f" {p} ") for p in ps if f" {p} " in t]
        if hits:
            pos[lab] = min(hits)
    labs = sorted(pos, key=lambda l: (pos[l], l))
    if not labs:
        return [NONE], "no-match"
    return labs, ("mapped" if len(labs) == 1 else "multi:" + "|".join(labs))


def template(clips_dir, system, sheet, key_dir=None):
    """Write a BLINDED results sheet for a human who records another product's output by hand: the clips are
    copied under random tokens next to the sheet (no label, signer or file name in it, shuffled order), and the
    token -> clip key goes to a separate folder (default data/compare/track_b/blind_keys/) that the person filling
    the sheet must not open. Returns the key path."""
    import random
    import secrets
    import shutil
    sheet = Path(sheet)
    clip_dir = sheet.parent / f"{system}_clips"
    clip_dir.mkdir(parents=True, exist_ok=True)
    clips = clips_of(clips_dir)
    tokens = {}
    for clip_id, *_rest, mp4 in clips:
        tok = secrets.token_hex(4)
        while tok in tokens:
            tok = secrets.token_hex(4)
        tokens[tok] = clip_id
        shutil.copyfile(mp4, clip_dir / f"{tok}{mp4.suffix}")
    order = list(tokens)
    random.SystemRandom().shuffle(order)
    with open(sheet, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["token", "system", "output_text", "mapped_label", "notes"])
        for tok in order:
            w.writerow([tok, system, "", "", ""])
    key = Path(key_dir or OUT / "blind_keys") / f"{system}_key.json"
    key.parent.mkdir(parents=True, exist_ok=True)
    key.write_text(json.dumps({"system": system, "sheet": str(sheet), "tokens": tokens}, indent=1))
    print(f"blinded sheet {sheet} + clips in {clip_dir}; key (do not show to the person filling the sheet): {key}")
    return key


def manual(csv_path, clips_dir, system, key=None):
    """Import a human-recorded results sheet (blinded: rows carry a token and `key` maps it back; unblinded:
    rows carry clip_id). mapped_label (if filled) overrides the automatic mapping; an empty output_text and
    mapped_label means the product gave no answer, which the report counts as wrong."""
    truth = {c[0]: c for c in clips_of(clips_dir)}
    tokens = json.loads(Path(key).read_text())["tokens"] if key else None
    recs, notes = [], {}
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            if row.get("system") and row["system"] != system:
                continue
            clip_id = tokens.get(row.get("token", "")) if tokens is not None else row.get("clip_id")
            if clip_id not in truth:
                print(f"WARNING: {row.get('token') or clip_id} not under {clips_dir}; ignored", file=sys.stderr)
                continue
            _, signer, label, oov, _ = truth[clip_id]
            manual_label = (row.get("mapped_label") or "").strip().upper()
            if manual_label:
                if manual_label not in CLASSES:
                    sys.exit(f"{clip_id}: mapped_label {manual_label!r} is not one of the 22 labels")
                preds, note = [manual_label], "human-mapped"
            else:
                preds, note = map_text(row.get("output_text"))
            notes[note.split(":")[0]] = notes.get(note.split(":")[0], 0) + 1
            recs.append(common.record(system, clip_id, signer, label, top=[(p_, None) for p_ in preds],
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
    run_ours(clips, ck, "ours_gru", allow_unpinned=True, allow_precleaned=True)   # smoke only
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
    o.add_argument("--how", choices=["stream", "take"], default="stream",
                   help="stream (default): replay recognition.stream on the clip; take: whole clip as one take (sensitivity)")
    c = sub.add_parser("claude")
    c.add_argument("--clips", required=True)
    c.add_argument("--model", default="claude-sonnet-5", choices=["claude-sonnet-5", "claude-opus-5-5"])
    c.add_argument("--frames", type=int, default=16)
    c.add_argument("--i-have-consent", action="store_true")
    t = sub.add_parser("template")
    t.add_argument("--clips", required=True)
    t.add_argument("--system", required=True)
    t.add_argument("--sheet", required=True, help="where to write the blinded sheet (clips are copied next to it)")
    m = sub.add_parser("manual")
    m.add_argument("--csv", required=True)
    m.add_argument("--clips", required=True)
    m.add_argument("--system", required=True)
    m.add_argument("--key", help="the blinding key written by template (rows then carry tokens, not clip IDs)")
    sub.add_parser("smoke")
    a = ap.parse_args(argv)
    if a.cmd == "extract":
        extract(a.clips, a.frames)
    elif a.cmd == "ours":
        run_ours(a.clips, a.checkpoint, a.name, gate=not a.no_gate, waist=a.waist, allow_unpinned=a.allow_unpinned,
                 how=a.how)
    elif a.cmd == "claude":
        run_claude(a.clips, a.model, a.frames, a.i_have_consent)
    elif a.cmd == "template":
        template(a.clips, a.system, a.sheet)
    elif a.cmd == "manual":
        manual(a.csv, a.clips, a.system, a.key)
    else:
        smoke()


if __name__ == "__main__":
    main()

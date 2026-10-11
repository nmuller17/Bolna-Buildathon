"""Experiment 4: facial-grammar FEASIBILITY (not accuracy). Can a LOCAL VLM describe eyebrow
position and head movement consistently? There is no labelled data: every team capture is made
with a neutral face, so this module measures only

  1. consistency  - does the answer stay the same when the input changes in ways that should not
                    matter: mirrored frames, frames shifted by 2 (jitter), and face crop vs full
                    frame. Identical input twice is also checked (greedy decoding should repeat).
  2. false alarms - on Talha's takes, recorded with a neutral face by protocol, how often the model
                    reports a question or negation face anyway (assumes the protocol held; not
                    verified frame by frame).
  3. agreement with geometry - the landmark files already hold 26 face points per frame
                    (CLAUDE.md 6.1: brows, eyes, mouth, nose tip, chin, shoulder-normalised), so
                    brow-to-eye distance and nose-tip motion give a model-free reading to compare
                    with the VLM's "brows" and "head" answers.

Accuracy for yes/no-question, wh-question and negation cannot be measured without labelled clips.

Privacy: face crops are made in memory from local files and never written to disk; results
store only the model's words and numbers. A product version would need guest opt-in.

Run (VLM venv, from /Users/trehman/CamelHack):
  /Users/trehman/.venvs/signbridge-vlm/bin/python -m recognition.vlm.facial eval \
      --out /Users/trehman/CamelHack-handoff/vlm_facial/facial_qwen3vl4b.jsonl
  ... -m recognition.vlm.facial summarize /Users/trehman/CamelHack-handoff/vlm_facial/facial_qwen3vl4b.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Sequence

import cv2
import numpy as np

from . import frames as F
from . import prompts as P
from .fallback import REF_DIR, TALHA_DIR, _num, wilson

JSON_DIR = Path("/Users/trehman/CamelHack-p2avatar/data/train")
CONDITIONS = ["crop", "crop_repeat", "crop_mirror", "crop_jitter", "full"]
# Positions inside the 26-point face list (CLAUDE.md 6.1 order).
BROW_IDX = list(range(0, 10))      # 70,63,105,66,107 | 336,296,334,293,300
EYE_IDX = list(range(10, 18))      # 33,133,159,145 | 362,263,386,374
NOSE_TIP = 24                      # mesh point 1


# ------------------------------------------------------------------------------------ geometry
def face_geometry(frames: Sequence[dict]) -> dict | None:
    """Model-free face reading from one landmark file's frames (shoulder-normalised, y down).
    brow_raise = mean eye y - mean brow y (bigger = brows higher above the eyes).
    nose_x_range / nose_y_range = spread (max - min) of the nose tip, a proxy for shake / nod."""
    raise_, nx, ny = [], [], []
    for fr in frames:
        face = fr.get("face") if isinstance(fr, dict) else None
        if not face or len(face) < 26:
            continue
        a = np.asarray(face, dtype=float)
        raise_.append(float(a[EYE_IDX, 1].mean() - a[BROW_IDX, 1].mean()))
        nx.append(float(a[NOSE_TIP, 0]))
        ny.append(float(a[NOSE_TIP, 1]))
    if len(raise_) < 3:
        return None
    r = np.asarray(raise_)
    return {"n_face_frames": len(r), "brow_raise_median": float(np.median(r)),
            "brow_raise_range": float(np.percentile(r, 95) - np.percentile(r, 5)),
            "nose_x_range": float(np.ptp(nx)), "nose_y_range": float(np.ptp(ny))}


# ------------------------------------------------------------------------------------ face crop
# OpenCV 5 dropped the Haar cascades, so faces are found with YuNet (OpenCV model zoo, MIT,
# 232 KB, sha256 8f2383e4...52fa4), kept outside the repo next to the VLM venv.
YUNET_PATH = Path("/Users/trehman/.venvs/signbridge-vlm/models/face_detection_yunet_2023mar.onnx")
_DET: dict = {}


def _detect_faces(bgr: np.ndarray) -> np.ndarray:
    """YuNet detections as rows [x, y, w, h, ...landmarks..., score]; empty array if none."""
    H, W = bgr.shape[:2]
    det = _DET.get((W, H))
    if det is None:
        det = cv2.FaceDetectorYN.create(str(YUNET_PATH), "", (W, H), 0.7, 0.3, 50)
        _DET[(W, H)] = det
    _, faces = det.detect(bgr)
    return faces if faces is not None else np.zeros((0, 15), dtype=np.float32)


def face_box(frames_bgr: Sequence[np.ndarray], n_probe: int = 8, expand_w: float = 2.0,
             expand_h: float = 2.2) -> tuple[int, int, int, int] | None:
    """One fixed (x0, y0, x1, y1) box around the face for the whole clip: the median of the
    largest face detection in n_probe evenly spaced frames, expanded so brows, forehead and a
    head shake stay inside. None when no face is found in any probe frame."""
    if not frames_bgr or not YUNET_PATH.exists():
        return None
    H, W = frames_bgr[0].shape[:2]
    boxes = []
    for i in F.even_indices(len(frames_bgr), n_probe):
        found = _detect_faces(frames_bgr[i])
        if len(found):
            boxes.append(max(found[:, :4].tolist(), key=lambda b: b[2] * b[3]))
    if not boxes:
        return None
    x, y, w, h = np.median(np.asarray(boxes, dtype=float), axis=0)
    cx, cy = x + w / 2, y + h / 2 - 0.1 * h          # shift up a little: brows and forehead
    hw, hh = w * expand_w / 2, h * expand_h / 2
    side = max(hw, hh)                                # square crop
    x0, x1 = int(max(0, cx - side)), int(min(W, cx + side))
    y0, y1 = int(max(0, cy - side)), int(min(H, cy + side))
    return (x0, y0, x1, y1)


def crop_images(frames_bgr: Sequence[np.ndarray], idx: Sequence[int], box, size: int = 336,
                mirror: bool = False):
    x0, y0, x1, y1 = box
    out = [frames_bgr[i][y0:y1, x0:x1] for i in idx]
    return F.to_pil(out, long_side=size, mirror=mirror)


def condition_inputs(frames_bgr: list[np.ndarray], cond: str, n: int = 8, box=None,
                     jitter: int = 2, crop_size: int = 336, full_long_side: int = 448):
    """Images for one test condition. All conditions share the same motion-window indices except
    crop_jitter, which moves every index by +jitter frames (clamped)."""
    win = F.motion_window(F.motion_energy(frames_bgr))
    idx = F.even_indices(len(frames_bgr), n, win[0], win[1])
    if cond == "full":
        return F.to_pil([frames_bgr[i] for i in idx], long_side=full_long_side), idx
    if box is None:
        raise ValueError("no face box")
    if cond == "crop_jitter":
        idx = [min(len(frames_bgr) - 1, i + jitter) for i in idx]
    return crop_images(frames_bgr, idx, box, size=crop_size, mirror=(cond == "crop_mirror")), idx


def build_facial_crop_prompt(n: int) -> str:
    """The shared facial prompt, with the opening adjusted to say the images are face crops."""
    return P.build_facial(n).replace(
        f"You are looking at {n} frames sampled in time order from a short webcam video",
        f"You are looking at {n} close-up crops of the head and face, sampled in time order from a "
        "short webcam video", 1)


# ------------------------------------------------------------------------------------ eval
def eval_clips(takes: Sequence[int] = (1, 2), with_reference: bool = True) -> list[dict]:
    out = []
    for d in sorted(p for p in TALHA_DIR.iterdir() if p.is_dir()):
        mp4s = sorted(d.glob("talha_*.mp4"), key=lambda p: _num(p.stem))
        if len(mp4s) < 12:
            continue
        for m in mp4s:
            if _num(m.stem) in takes:
                js = JSON_DIR / d.name / f"{m.stem}.json"
                out.append({"clip": f"{d.name}/{m.stem}", "sign": d.name, "path": str(m),
                            "json": str(js) if js.exists() else None, "protocol": "neutral_face"})
    if with_reference:
        for m in sorted(REF_DIR.glob("*.mp4")):
            out.append({"clip": f"reference/{m.stem}", "sign": m.stem, "path": str(m), "json": None,
                        "protocol": "unknown"})
    return out


def _run_eval(a) -> int:
    from .engine import LocalVLM
    from .fallback import wait_for_recorder_strict as wait_for_recorder
    clips = eval_clips(tuple(a.takes), with_reference=not a.no_reference)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        done = {(r["clip"], r["condition"]) for r in map(json.loads, out.read_text().splitlines()) if r}
    log = lambda m: print(m, flush=True)  # noqa: E731
    wait_for_recorder(poll_s=60, log=log)
    eng = LocalVLM(a.model, max_tokens=a.max_tokens, timeout_s=120, load=False)
    log(f"[facial] {len(clips)} clips x {len(a.conditions)} conditions; {len(done)} done; "
        f"{a.model} loaded in {eng.load():.1f} s")
    warm = False
    with out.open("a") as fh:
        for ci, c in enumerate(clips):
            todo = [k for k in a.conditions if (c["clip"], k) not in done]
            if not todo:
                continue
            frames, _fps = F.read_video(c["path"])
            box = face_box(frames)
            geo = None
            if c["json"]:
                geo = face_geometry(json.loads(Path(c["json"]).read_text()).get("frames", []))
            for cond in todo:
                wait_for_recorder(poll_s=60, log=log)
                if cond != "full" and box is None:
                    row = {"clip": c["clip"], "condition": cond, "status": "no_face"}
                    fh.write(json.dumps(row) + "\n")
                    continue
                imgs, idx = condition_inputs(frames, "crop" if cond == "crop_repeat" else cond,
                                             n=a.frames, box=box)
                prompt = P.build_facial(len(imgs)) if cond == "full" else build_facial_crop_prompt(len(imgs))
                if not warm:
                    eng.generate(imgs[:2], "Describe the face in five words.", max_tokens=12)
                    warm = True
                r = eng.generate(imgs, prompt)
                p = P.parse_facial(r.text)
                row = {"clip": c["clip"], "sign": c["sign"], "protocol": c["protocol"], "condition": cond,
                       "status": "ok" if p["ok"] else p["format"], "marker": p["marker"],
                       "brows": p.get("brows"), "head": p.get("head"), "confidence": p.get("confidence"),
                       "box": box, "indices": idx, "geometry": geo, "latency_s": round(r.latency_s, 2),
                       "prompt_tokens": r.prompt_tokens, "timed_out": r.timed_out,
                       "model": a.model, "raw": r.text[:400]}
                fh.write(json.dumps(row) + "\n")
                fh.flush()
                log(f"[{ci + 1}/{len(clips)}] {c['clip']:<24} {cond:<12} {p['marker']} brows={p.get('brows')} "
                    f"head={p.get('head')} {r.latency_s:.1f}s")
            del frames
    eng.unload()
    return 0


def _norm(v):
    return str(v).strip().lower() if v is not None else None


def summarize(rows: list[dict]) -> dict:
    by = {}
    for r in rows:
        by.setdefault(r["clip"], {})[r["condition"]] = r
    res = {"n_clips": len(by)}
    for field in ("marker", "brows", "head"):
        agree = {}
        for other in ("crop_repeat", "crop_mirror", "crop_jitter", "full"):
            pairs = [(c["crop"], c[other]) for c in by.values()
                     if c.get("crop", {}).get("status") == "ok" and c.get(other, {}).get("status") == "ok"]
            k = sum(1 for x, y in pairs if _norm(x.get(field)) == _norm(y.get(field)))
            agree[other] = {"agree": k, "n": len(pairs), "ci": wilson(k, len(pairs))}
        res[f"{field}_agreement_vs_crop"] = agree
    ok = [r for r in rows if r.get("status") == "ok"]
    for grp, sel in (("talha", lambda r: r["protocol"] == "neutral_face"),
                     ("reference", lambda r: r["protocol"] == "unknown")):
        g = [r for r in ok if sel(r)]
        res[f"{grp}_markers_by_condition"] = {
            cond: dict(Counter(r["marker"] for r in g if r["condition"] == cond)) for cond in CONDITIONS}
        res[f"{grp}_brows_by_condition"] = {
            cond: dict(Counter(_norm(r["brows"]) for r in g if r["condition"] == cond)) for cond in CONDITIONS}
        res[f"{grp}_head_by_condition"] = {
            cond: dict(Counter(_norm(r["head"]) for r in g if r["condition"] == cond)) for cond in CONDITIONS}
    t = [r for r in ok if r["protocol"] == "neutral_face" and r["condition"] == "crop"]
    fa = sum(1 for r in t if r["marker"] != "neutral")
    res["talha_false_alarm_crop"] = {"non_neutral": fa, "n": len(t), "ci": wilson(fa, len(t))}
    # geometry vs words: does "raised" go with a larger brow_raise, "shake" with larger nose x range?
    geo = [r for r in t if r.get("geometry")]
    def _split(field, value, metric):
        a = [r["geometry"][metric] for r in geo if _norm(r[field]) == value]
        b = [r["geometry"][metric] for r in geo if _norm(r[field]) != value]
        return {"said": value, "n_said": len(a), "n_other": len(b),
                "median_said": float(np.median(a)) if a else None,
                "median_other": float(np.median(b)) if b else None}
    res["geometry_vs_words"] = [_split("brows", "raised", "brow_raise_median"),
                                _split("brows", "furrowed", "brow_raise_median"),
                                _split("head", "shake", "nose_x_range"),
                                _split("head", "nod", "nose_y_range")]
    lat = [r["latency_s"] for r in ok]
    lat_crop = [r["latency_s"] for r in ok if r["condition"] != "full"]
    lat_full = [r["latency_s"] for r in ok if r["condition"] == "full"]
    res["latency_s"] = {"all_p50": float(np.percentile(lat, 50)) if lat else None,
                        "all_p95": float(np.percentile(lat, 95)) if lat else None,
                        "crop_p50": float(np.percentile(lat_crop, 50)) if lat_crop else None,
                        "crop_p95": float(np.percentile(lat_crop, 95)) if lat_crop else None,
                        "full_p50": float(np.percentile(lat_full, 50)) if lat_full else None,
                        "full_p95": float(np.percentile(lat_full, 95)) if lat_full else None,
                        "n_crop": len(lat_crop), "n_full": len(lat_full)}
    res["not_ok"] = dict(Counter(r.get("status") for r in rows if r.get("status") != "ok"))
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("eval")
    e.add_argument("--takes", nargs="*", type=int, default=[1, 2])
    e.add_argument("--no-reference", action="store_true")
    e.add_argument("--conditions", nargs="*", default=CONDITIONS)
    e.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
    e.add_argument("--frames", type=int, default=8)
    e.add_argument("--max-tokens", type=int, default=100)
    e.add_argument("--out", required=True)
    s = sub.add_parser("summarize")
    s.add_argument("path")
    a = ap.parse_args(argv)
    if a.cmd == "eval":
        return _run_eval(a)
    rows = [json.loads(l) for l in Path(a.path).read_text().splitlines() if l.strip()]
    print(json.dumps(summarize(rows), indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

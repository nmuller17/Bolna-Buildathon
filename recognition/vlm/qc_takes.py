"""'Check my takes': flag training takes that may not match the reference sign. Never deletes.

Two methods, same take/reference pairs:
  (A) vlm      - the local VLM (LocalVLM, on this laptop) sees 8 frames of the reference video and
                 8 frames of the take and answers the shared QC prompt (prompts.build_qc):
                 same sign or not, plus a 0-1 score.
  (B) landmark - dynamic time warping (DTW) on the MediaPipe hand landmarks (landmark_qc.py):
                 ref_dtw  = distance to the reference video's landmarks,
                 pool_dtw = median distance to the same person's other takes of the sign,
                 ref_rel  = ref_dtw / median ref_dtw of that person's takes of the sign.
                 Optional --features shape compares handshape only (points relative to the wrist).

Usage (landmark path runs in any venv with numpy; the VLM path needs the VLM venv):
  python -m recognition.vlm.qc_takes check --person talha --sign PASSWORD \
      [--extra /path/to/more/takes ...] [--method landmark|vlm|both]
  python -m recognition.vlm.qc_takes experiment --out /Users/trehman/CamelHack-handoff/vlm_qc

check prints a ranked list of suspicious takes; it never moves or deletes a file.

Result of `experiment` (2026-10-10/11, Talha's takes, Qwen3-VL-4B-4bit): ship the landmark method
(pool_dtw_all) as the default. It catches takes recorded as the wrong sign and costs ~0.1 s per take.
It does NOT reliably catch subtle errors: at the frozen threshold it caught 0 of the 7 known-wrong
PASSWORD takes, which start late or are cut short, though it ranked them high (AUC 0.857). The VLM
said 'not the same sign' for 11 of 12 accepted PASSWORD takes (AUC 0.54), so it is not used to flag.
Reference landmarks come from ref_landmarks.py (MediaPipe, p2-avatar venv); they are cached
in --ref-landmarks and extracted automatically if missing.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import landmark_qc as LQ

P2 = Path("/Users/trehman/CamelHack-p2avatar")
TRAIN_JSON = P2 / "data" / "train"
TRAIN_VIDEO = P2 / "data" / "videos" / "train"
REF_VIDEO = P2 / "capture" / "reference"
DISCARDED = P2 / "data" / "discarded"
HANDOFF = Path("/Users/trehman/CamelHack-handoff")
REF_LM = HANDOFF / "vlm_qc" / "ref_landmarks"
P2_PY = P2 / ".venv" / "bin" / "python"
WRONG_DIRS = [DISCARDED / "PASSWORD_talha_wrong", DISCARDED / "PASSWORD_talha_wrong_2"]

# Operating thresholds for `check`. Each is the 95th percentile of the score over Talha's 144
# accepted takes of the 12 complete classes other than PASSWORD (so about 5% of good takes get
# flagged), fitted by `experiment` on 2026-10-10 and then frozen here; PASSWORD was held out.
# Re-fit with `experiment` when more people have recorded.
DEFAULT_THRESHOLDS = {
    "pool_dtw_all": 0.2684,     # median DTW to own other takes, hand location + handshape
    "pool_dtw_shape": 0.1405,   # same, handshape only (variant picked after looking at PASSWORD)
    "ref_rel_all": 1.5317,      # DTW to the reference / that person's median DTW to it
}
# Ranking key for `check`. pool_dtw_all was specified before looking at the 7 wrong PASSWORD takes
# (ranking AUC 0.857 on them); the handshape-only variant scored 0.917 but was chosen after seeing
# the same 19 takes, so it is shown as a second column, not used to rank.
RECOMMENDED = "pool_dtw_all"

_SAME_RE = re.compile(r'"same_sign"\s*:\s*(true|false)', re.I)
_SCORE_RE = re.compile(r'"score"\s*:\s*([0-9]*\.?[0-9]+)')


def salvage_truncated(raw: str) -> dict | None:
    """The model sometimes runs out of tokens inside a long "issues" list, so the JSON never
    closes and parse_qc gives up. same_sign and score come first in the schema, so read them
    from the opening of the reply. Returns None when they are not there either."""
    m = _SAME_RE.search(raw or "")
    if not m:
        return None
    sc = _SCORE_RE.search(raw)
    score = min(1.0, max(0.0, float(sc.group(1)))) if sc else None
    return {"same_sign": m.group(1).lower() == "true", "score": score}


def _suspicion(same, score):
    if score is not None:
        return 1.0 - score
    if same is not None:
        return 0.0 if same else 1.0
    return None


@dataclass
class Take:
    sign: str
    person: str
    json_path: Path
    mp4_path: Path | None
    status: str = "unknown"      # experiment ground truth: ok | wrong | unknown

    @property
    def name(self) -> str:
        return f"{self.json_path.parent.name}/{self.json_path.name}"


def _num(p: Path) -> int:
    try:
        return int(p.stem.rsplit("_", 1)[1])
    except (IndexError, ValueError):
        return 10 ** 6


def list_takes(person: str, sign: str, extra_dirs=(), status: str = "unknown",
               extra_status: str = "unknown") -> list[Take]:
    out = []
    for p in sorted((TRAIN_JSON / sign).glob(f"{person}_*.json"), key=_num):
        mp4 = TRAIN_VIDEO / sign / f"{p.stem}.mp4"
        out.append(Take(sign, person, p, mp4 if mp4.exists() else None, status))
    for d in extra_dirs:
        d = Path(d)
        for p in sorted(d.glob(f"{person}_*.json"), key=_num):
            mp4 = p.with_suffix(".mp4")
            out.append(Take(sign, person, p, mp4 if mp4.exists() else None, extra_status))
    return out


def complete_classes(person: str, min_takes: int = 12) -> list[str]:
    return sorted(d.name for d in TRAIN_JSON.iterdir()
                  if d.is_dir() and len(list(d.glob(f"{person}_*.json"))) >= min_takes)


def ensure_ref_landmarks(signs, ref_dir: Path = REF_LM) -> None:
    missing = [s for s in signs if not (ref_dir / f"{s}.json").exists() and (REF_VIDEO / f"{s}.mp4").exists()]
    if not missing:
        return
    print(f"[qc] extracting reference landmarks for {missing} with MediaPipe ({P2_PY})", flush=True)
    subprocess.run([str(P2_PY), str(Path(__file__).with_name("ref_landmarks.py")),
                    "--out-dir", str(ref_dir), "--signs", *missing], check=True)


def load_ref(sign: str, ref_dir: Path = REF_LM) -> np.ndarray | None:
    p = ref_dir / f"{sign}.json"
    return LQ.to_array(LQ.load_frames(p)) if p.exists() else None


# ------------------------------------------------------------------------------ landmark method
def landmark_scores(takes: list[Take], ref: np.ndarray | None, features: str = "all") -> list[dict]:
    """Scores for every take of ONE person and ONE sign (the pool). Timing is per take."""
    arrs = [LQ.to_array(LQ.load_frames(t.json_path)) for t in takes]
    rows = []
    for i, t in enumerate(takes):
        t0 = time.perf_counter()
        r = LQ.dtw_distance(arrs[i], ref, features=features) if ref is not None else float("nan")
        others = [LQ.dtw_distance(arrs[i], arrs[j], features=features) for j in range(len(takes)) if j != i]
        pool = LQ.pool_median(others) if len(others) >= 3 else float("nan")
        rows.append({"take": t.name, "status": t.status, "n_frames": len(arrs[i]),
                     "ref_dtw": r, "pool_dtw": pool, "seconds": time.perf_counter() - t0})
    refs = [x["ref_dtw"] for x in rows if np.isfinite(x["ref_dtw"])]
    med = float(np.median(refs)) if refs else float("nan")
    for x in rows:
        x["ref_rel"] = x["ref_dtw"] / med if med and np.isfinite(med) else float("nan")
    return rows


# ------------------------------------------------------------------------------ VLM method
def vlm_judge(engine, take_mp4: Path, ref_sign: str, n: int = 8, hints: bool = True,
              long_side: int = 448) -> dict:
    from . import frames as F
    from . import prompts as P

    ref = F.sample_frames(REF_VIDEO / f"{ref_sign}.mp4", n=n, mode="motion", long_side=long_side)
    tk = F.sample_frames(take_mp4, n=n, mode="motion", long_side=long_side)
    prompt = P.build_qc(ref_sign, n, n, hints=hints)
    r = engine.generate(ref.images + tk.images, prompt)
    q = P.parse_qc(r.text)
    if q["format"] == "unparsed":
        sv = salvage_truncated(r.text)
        if sv is not None:
            q = {**q, **sv, "format": "truncated_salvaged"}
    susp = _suspicion(q["same_sign"], q["score"])
    return {"same_sign": q["same_sign"], "score": q["score"], "suspicion": susp,
            "flag": (q["same_sign"] is False) if q["same_sign"] is not None else None,
            "issues": q["issues"], "format": q["format"], "latency_s": r.latency_s,
            "lock_wait_s": r.lock_wait_s, "prompt_tokens": r.prompt_tokens,
            "peak_mlx_gb": r.peak_memory_gb, "timed_out": r.timed_out, "raw": r.text[:600]}


# ------------------------------------------------------------------------------ check (the tool)
def cmd_check(a) -> int:
    takes = list_takes(a.person, a.sign, a.extra)
    if not takes:
        print(f"No takes of {a.sign} by {a.person} in {TRAIN_JSON / a.sign}")
        return 1
    th = dict(DEFAULT_THRESHOLDS)
    if a.thresholds:
        th.update(json.loads(Path(a.thresholds).read_text()))
    rows = {}
    if a.method in ("landmark", "both"):
        ensure_ref_landmarks([a.sign], Path(a.ref_landmarks))
        ref = load_ref(a.sign, Path(a.ref_landmarks))
        for feat in ("shape", "all"):
            for x in landmark_scores(takes, ref, feat):
                d = rows.setdefault(x["take"], {"take": x["take"], "n_frames": x["n_frames"]})
                d[f"pool_dtw_{feat}"] = x["pool_dtw"]
                d[f"ref_dtw_{feat}"] = x["ref_dtw"]
                d[f"ref_rel_{feat}"] = x["ref_rel"]
    if a.method in ("vlm", "both"):
        from .engine import LocalVLM, wait_for_recorder
        eng = LocalVLM(a.model, max_tokens=200, timeout_s=120)
        for t in takes:
            if t.mp4_path is None:
                continue
            wait_for_recorder(poll_s=60)
            v = vlm_judge(eng, t.mp4_path, a.sign)
            d = rows.setdefault(t.name, {"take": t.name})
            d["vlm_same_sign"], d["vlm_score"], d["vlm_issues"] = v["same_sign"], v["score"], v["issues"]
        eng.unload()
    out = list(rows.values())

    def finite(v):
        return isinstance(v, (int, float)) and v is not None and np.isfinite(v)
    if a.method == "vlm":
        key = "vlm_score"
    elif any(finite(d.get(RECOMMENDED)) for d in out):
        key = RECOMMENDED
    else:   # fewer than 4 takes: no pool to compare with, fall back to distance to the reference
        key = "ref_rel_all"
    for d in out:
        # Only the ranking score decides the flag (one threshold ~ 5% false alarms on good takes);
        # the other scores are printed as notes so the union does not multiply false alarms.
        t = th.get(key)
        d["suspicious"] = bool(t is not None and finite(d.get(key)) and d[key] > t)
        if key == "vlm_score":
            d["suspicious"] = d.get("vlm_same_sign") is False
        notes = [f"{k}={d[k]:.3f}>{v:.3f}" for k, v in th.items()
                 if k != key and v is not None and finite(d.get(k)) and d[k] > v]
        d["why"] = (f"{key}={d[key]:.3f}>{t:.3f}" if d["suspicious"] and key != "vlm_score"
                    else ("vlm: not the same sign" if d["suspicious"] else ""))
        d["notes"] = "; ".join(notes)
    rev = key != "vlm_score"
    out.sort(key=lambda d: (d.get(key) if finite(d.get(key)) else -1), reverse=rev)
    if a.method in ("vlm", "both"):
        print("NOTE: in the 2026-10-10 test the local VLM said 'not the same sign' for 11 of 12 accepted "
              "PASSWORD takes; treat its verdict as unreliable.")
    print(f"Takes of {a.sign} by {a.person}: {len(takes)}. Ranked most suspicious first by {key}. "
          "Nothing is deleted; look at the flagged ones and re-record if needed.")
    cols = [c for c in ("pool_dtw_all", "pool_dtw_shape", "ref_rel_all", "vlm_score") if any(c in d for d in out)]
    print(f"{'take':34s} " + " ".join(f"{c:>14s}" for c in cols) + "  flag")
    for d in out:
        vals = " ".join(f"{d[c]:14.3f}" if isinstance(d.get(c), (int, float)) and d.get(c) is not None
                        else f"{'-':>14s}" for c in cols)
        flag = "SUSPICIOUS: " + d["why"] if d["suspicious"] else ""
        if d["notes"]:
            flag += ("  " if flag else "") + "(also high: " + d["notes"] + ")"
        print(f"{d['take']:34s} {vals}  {flag}")
    print("Scores: higher = less like the other takes / the reference. The 7 known-wrong PASSWORD takes "
          "(late start, cut short) were NOT caught by the threshold in testing; use the order, not just "
          "the flag, and look at the top few takes.")
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(out, indent=1, default=float))
    return 0


# ------------------------------------------------------------------------------ experiment
def _pct(vals, q):
    v = [x for x in vals if x is not None and np.isfinite(x)]
    return float(np.percentile(v, q)) if v else None


def _metrics(scores_pos, scores_neg, thr):
    pos = [s for s in scores_pos if s is not None and np.isfinite(s)]
    neg = [s for s in scores_neg if s is not None and np.isfinite(s)]
    m = {"n_pos": len(pos), "n_neg": len(neg), "auc": LQ.auc(pos, neg)}
    if thr is not None:
        m["recall"] = f"{sum(s > thr for s in pos)}/{len(pos)}"
        m["false_alarm"] = f"{sum(s > thr for s in neg)}/{len(neg)}"
    return m


def _lat(vals):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return None
    return {"n": len(v), "p50": float(np.percentile(v, 50)), "p95": float(np.percentile(v, 95)),
            "max": float(v[-1])}


def landmark_experiment(person: str, classes: list[str], ref_signs: list[str], out: Path, log) -> dict:
    """All pairs: every accepted take vs own reference (ok), the 7 wrong PASSWORD takes vs the
    PASSWORD reference (wrong), every accepted take vs every other reference (mismatch)."""
    takes = {c: list_takes(person, c, status="ok") for c in classes}
    takes["PASSWORD"] = list_takes(person, "PASSWORD", WRONG_DIRS, status="ok", extra_status="wrong")
    refs = {s: load_ref(s) for s in ref_signs}
    all_takes = [t for c in classes for t in takes[c]]
    arr = {t.name: LQ.to_array(LQ.load_frames(t.json_path)) for t in all_takes}
    result = {}
    for feat in ("all", "shape", "wrist"):
        t0 = time.monotonic()
        # distances take -> every reference
        dref = {(t.name, s): (LQ.dtw_distance(arr[t.name], refs[s], features=feat) if refs[s] is not None
                              else float("nan")) for t in all_takes for s in ref_signs}
        # pool distances: take -> every take of every complete class (needed for constructed pools)
        dpool = {}
        for t in all_takes:
            for c in classes:
                for u in takes[c]:
                    if u.name == t.name:
                        continue
                    k = tuple(sorted((t.name, u.name)))
                    if k not in dpool:
                        dpool[k] = LQ.dtw_distance(arr[t.name], arr[u.name], features=feat)

        def pool_of(t, c):
            return LQ.pool_median([dpool[tuple(sorted((t.name, u.name)))] for u in takes[c] if u.name != t.name])

        med_ref = {c: float(np.median([dref[(u.name, c)] for u in takes[c]])) for c in classes}
        rows = []
        for c in classes:
            for t in takes[c]:
                rows.append({"take": t.name, "take_sign": c, "ref_sign": c,
                             "label": "wrong" if t.status == "wrong" else "ok",
                             "ref_dtw": dref[(t.name, c)], "pool_dtw": pool_of(t, c),
                             "ref_rel": dref[(t.name, c)] / med_ref[c]})
                if t.status == "wrong":
                    continue
                for y in ref_signs:
                    if y == c:
                        continue
                    rows.append({"take": t.name, "take_sign": c, "ref_sign": y, "label": "mismatch",
                                 "ref_dtw": dref[(t.name, y)],
                                 "pool_dtw": pool_of(t, y) if y in takes else float("nan"),
                                 "ref_rel": dref[(t.name, y)] / med_ref[y] if y in med_ref else float("nan")})
        log(f"[qc] landmark features={feat}: {len(dref) + len(dpool)} DTWs in {time.monotonic() - t0:.0f} s")
        res = {"rows": rows}
        for score in ("ref_dtw", "pool_dtw", "ref_rel"):
            calib_ok = [r[score] for r in rows if r["label"] == "ok" and r["take_sign"] != "PASSWORD"]
            thr = _pct(calib_ok, 95)
            pw_wrong = [r[score] for r in rows if r["label"] == "wrong"]
            pw_ok = [r[score] for r in rows if r["label"] == "ok" and r["take_sign"] == "PASSWORD"]
            mm = [r[score] for r in rows if r["label"] == "mismatch" and r["ref_sign"] in classes]
            mm_any = [r[score] for r in rows if r["label"] == "mismatch"]
            oks = [r[score] for r in rows if r["label"] == "ok"]
            res[score] = {
                "threshold_p95_ok_non_password": thr,
                "real_password_7wrong_vs_12ok": _metrics(pw_wrong, pw_ok, thr),
                "constructed_mismatch_complete_refs_vs_all_ok": _metrics(mm, oks, thr),
                "constructed_mismatch_all_refs_vs_all_ok": _metrics(mm_any, oks, thr),
            }
            log(f"[qc]   {score:8s} thr={thr:.3f} real AUC={res[score]['real_password_7wrong_vs_12ok']['auc']:.3f} "
                f"recall={res[score]['real_password_7wrong_vs_12ok']['recall']} "
                f"FA={res[score]['real_password_7wrong_vs_12ok']['false_alarm']} | constructed AUC="
                f"{res[score]['constructed_mismatch_complete_refs_vs_all_ok']['auc']:.3f}")
        result[feat] = res
    # per-take latency of the check tool on the realistic PASSWORD pool (19 takes, shape + all)
    lat = {}
    for feat in ("all", "shape"):
        rows = landmark_scores(takes["PASSWORD"], refs.get("PASSWORD"), feat)
        lat[feat] = _lat([r["seconds"] for r in rows])
    result["latency_per_take_s_password_pool_of_19"] = lat
    (out / "landmark_results.json").write_text(json.dumps(result, indent=1, default=float))
    return result


def vlm_pairs(person: str, classes: list[str], ref_signs: list[str], seed: int = 0) -> list[dict]:
    rng = random.Random(seed)
    pairs = []
    for t in list_takes(person, "PASSWORD", WRONG_DIRS, status="ok", extra_status="wrong"):
        pairs.append({"take": t.name, "mp4": str(t.mp4_path), "take_sign": "PASSWORD", "ref_sign": "PASSWORD",
                      "label": t.status if t.status == "wrong" else "ok", "set": "real"})
    for c in classes:
        tk = {t.json_path.stem: t for t in list_takes(person, c, status="ok")}
        if c != "PASSWORD":
            for s in ("talha_2", "talha_8"):
                t = tk[s.replace("talha", person)]
                pairs.append({"take": t.name, "mp4": str(t.mp4_path), "take_sign": c, "ref_sign": c,
                              "label": "ok", "set": "constructed"})
        for s in ("talha_3", "talha_9"):
            t = tk[s.replace("talha", person)]
            y = rng.choice([r for r in ref_signs if r != c])
            pairs.append({"take": t.name, "mp4": str(t.mp4_path), "take_sign": c, "ref_sign": y,
                          "label": "mismatch", "set": "constructed"})
    return pairs


def vlm_experiment(pairs: list[dict], out: Path, model: str, hints: bool, log) -> list[dict]:
    from .engine import LocalVLM, wait_for_recorder

    path = out / f"vlm_qc_{'hints' if hints else 'nohints'}.jsonl"
    done = {}
    if path.exists():
        for line in path.read_text().splitlines():
            r = json.loads(line)
            done[(r["take"], r["ref_sign"])] = r
    todo = [p for p in pairs if (p["take"], p["ref_sign"]) not in done]
    log(f"[qc] VLM {model} hints={hints}: {len(done)} done, {len(todo)} to run")
    if todo:
        wait_for_recorder(poll_s=60, log=log)
        eng = LocalVLM(model, max_tokens=200, timeout_s=120, load=False)
        log(f"[qc] loaded in {eng.load():.1f} s")
        from . import frames as F
        s0 = F.sample_frames(todo[0]["mp4"], n=2, long_side=448)
        w = eng.generate(s0.images, "Describe the hands in five words.", max_tokens=16)
        log(f"[qc] warm-up {w.latency_s:.1f} s (excluded)")
        with path.open("a") as fh:
            for k, p in enumerate(todo):
                wait_for_recorder(poll_s=60, log=log)
                v = vlm_judge(eng, Path(p["mp4"]), p["ref_sign"], hints=hints)
                r = {**p, **v, "model": model, "hints": hints}
                fh.write(json.dumps(r) + "\n")
                fh.flush()
                done[(p["take"], p["ref_sign"])] = r
                log(f"[qc] {k + 1}/{len(todo)} {p['label']:8s} {p['take']} vs ref {p['ref_sign']}: "
                    f"same={v['same_sign']} score={v['score']} {v['latency_s']:.1f} s (lock wait {v['lock_wait_s']:.1f} s)")
        eng.unload()
    return [done[(p["take"], p["ref_sign"])] for p in pairs if (p["take"], p["ref_sign"]) in done]


def summarize_vlm(rows: list[dict], lm: dict) -> dict:
    for r in rows:   # rows stored before salvage_truncated existed: recover them the same way
        if r.get("format") == "unparsed":
            sv = salvage_truncated(r.get("raw", ""))
            if sv is not None:
                r.update(sv, format="truncated_salvaged", suspicion=_suspicion(sv["same_sign"], sv["score"]),
                         flag=sv["same_sign"] is False)
    def flags(sel):
        return [r for r in rows if sel(r)]
    real_w = flags(lambda r: r["label"] == "wrong")
    real_ok = flags(lambda r: r["set"] == "real" and r["label"] == "ok")
    c_mm = flags(lambda r: r["label"] == "mismatch")
    c_ok = flags(lambda r: r["set"] == "constructed" and r["label"] == "ok")

    def block(pos, neg):
        return {"n_pos": len(pos), "n_neg": len(neg),
                "recall": f"{sum(r['flag'] is True for r in pos)}/{len(pos)}",
                "false_alarm": f"{sum(r['flag'] is True for r in neg)}/{len(neg)}",
                "auc_on_1_minus_score": LQ.auc([r["suspicion"] for r in pos], [r["suspicion"] for r in neg]),
                "unparsed": sum(r["same_sign"] is None for r in pos + neg),
                "salvaged_from_truncated_reply": sum(r.get("format") == "truncated_salvaged" for r in pos + neg),
                "said_same_sign": f"{sum(r['same_sign'] is True for r in pos + neg)}/{len(pos + neg)}"}
    s = {"real_password_7wrong_vs_12ok": block(real_w, real_ok),
         "constructed_mismatch_vs_ok_subset": block(c_mm, c_ok + real_ok),
         "latency_s": _lat([r["latency_s"] for r in rows]),
         "lock_wait_s": _lat([r["lock_wait_s"] for r in rows]),
         "score_values": sorted({r["score"] for r in rows if r["score"] is not None}),
         "same_sign_true_share": f"{sum(r['same_sign'] is True for r in rows)}/{len(rows)}"}
    # landmark scores on exactly the VLM pairs (apples to apples)
    same = {}
    for feat in ("all", "shape"):
        idx = {(r["take"], r["ref_sign"]): r for r in lm[feat]["rows"]}
        for score in ("pool_dtw", "ref_rel"):
            thr = lm[feat][score]["threshold_p95_ok_non_password"]
            get = lambda rr: idx.get((rr["take"], rr["ref_sign"]), {}).get(score)  # noqa: E731
            same[f"{score}_{feat}"] = {
                "real": _metrics([get(r) for r in real_w], [get(r) for r in real_ok], thr),
                "constructed": _metrics([get(r) for r in c_mm], [get(r) for r in c_ok + real_ok], thr)}
    s["landmark_on_same_pairs"] = same
    return s


def cmd_experiment(a) -> int:
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    logf = (out / "experiment.log").open("a")

    def log(m):
        print(m, flush=True)
        logf.write(m + "\n")
        logf.flush()

    classes = a.classes or complete_classes(a.person)
    ref_signs = sorted(p.stem for p in REF_VIDEO.glob("*.mp4"))
    ensure_ref_landmarks(ref_signs)
    log(f"[qc] {time.strftime('%Y-%m-%d %H:%M:%S')} person={a.person} complete classes ({len(classes)}): {classes}; "
        f"references: {len(ref_signs)}")
    cached = out / "landmark_results.json"
    if a.reuse_landmark and cached.exists():
        lm = json.loads(cached.read_text())
        log(f"[qc] reusing {cached}")
    else:
        lm = landmark_experiment(a.person, classes, ref_signs, out, log)
    summary = {"classes": classes, "landmark": {f: {k: v for k, v in lm[f].items() if k != "rows"}
                                                for f in ("all", "shape", "wrist")},
               "landmark_latency": lm["latency_per_take_s_password_pool_of_19"]}
    if a.vlm:
        pairs = vlm_pairs(a.person, classes, ref_signs)
        if a.vlm_small:   # one ok + one mismatch per class (drops the talha_8 / talha_9 pairs)
            pairs = [p for p in pairs if p["set"] == "real"
                     or not p["take"].endswith(("_8.json", "_9.json"))]
        if a.vlm_limit:
            pairs = pairs[:a.vlm_limit]
        (out / "vlm_pairs.json").write_text(json.dumps(pairs, indent=1))
        for hints in ([True, False] if a.both_hints else [True]):
            sel = pairs if hints else [p for p in pairs if p["set"] == "real"]
            rows = vlm_experiment(sel, out, a.model, hints, log)
            summary[f"vlm_{'hints' if hints else 'nohints'}"] = summarize_vlm(rows, lm)
    (out / "summary.json").write_text(json.dumps(summary, indent=1, default=float))
    log(f"[qc] wrote {out / 'summary.json'}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="rank one person's takes of one sign; never deletes")
    c.add_argument("--person", required=True)
    c.add_argument("--sign", required=True)
    c.add_argument("--extra", nargs="*", default=[], help="more folders of <person>_<n>.json/.mp4 takes")
    c.add_argument("--method", default="landmark", choices=["landmark", "vlm", "both"])
    c.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
    c.add_argument("--ref-landmarks", default=str(REF_LM))
    c.add_argument("--thresholds", default=None, help="JSON file overriding DEFAULT_THRESHOLDS")
    c.add_argument("--json-out", default=None)
    e = sub.add_parser("experiment", help="measure both methods against the known-wrong takes")
    e.add_argument("--person", default="talha")
    e.add_argument("--out", default=str(HANDOFF / "vlm_qc"))
    e.add_argument("--vlm", type=int, default=1)
    e.add_argument("--vlm-limit", type=int, default=0)
    e.add_argument("--classes", nargs="*", default=None,
                   help="pin the class list (default: every class with >= 12 takes by --person)")
    e.add_argument("--vlm-small", type=int, default=0,
                   help="19 real pairs + 1 ok and 1 mismatch per class (44 calls instead of 69)")
    e.add_argument("--reuse-landmark", type=int, default=1, help="load landmark_results.json if present")
    e.add_argument("--both-hints", type=int, default=1, help="also run the 19 real pairs without sign hints")
    e.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
    a = ap.parse_args(argv)
    return cmd_check(a) if a.cmd == "check" else cmd_experiment(a)


if __name__ == "__main__":
    sys.exit(main())

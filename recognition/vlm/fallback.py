"""Experiment 1: out-of-vocabulary fallback. When the classifier is unsure about one sign, a LOCAL
vision-language model looks at that sign's frames and proposes up to 3 plain-English meanings
from an open list of hotel front-desk requests (HOTEL_REQUESTS, 48 entries: our 21 signs plus 27
common requests that are NOT in our vocabulary). The guest must tap one, or "None of these";
nothing is spoken or sent to staff before that tap.

Hook (product path, see INTEGRATION_NOTE at the bottom of this file):
  should_fallback(top)   True when the classifier's top-1 is NONE or its confidence is below 0.6
                         (the same rule as recognizer.needs_repeat, applied to one sign).
  FrameRing              in-memory ring of recent camera frames, already downscaled; never
                         written to disk. ring.segment(t0, t1) returns that sign's frames.
  Fallback.propose(...)  LocalVLM only (refuses an engine whose .engine is not "local-mlx").
                         Returns a "fallback" event dict ready to send to the app.

Evaluation (Talha's own consented clips, all local):
  /Users/trehman/.venvs/signbridge-vlm/bin/python -m recognition.vlm.fallback eval \
      --set talha --frames 8 --hints 1 --out /Users/trehman/CamelHack-handoff/vlm_fallback/x.jsonl
  ... -m recognition.vlm.fallback summarize /Users/trehman/CamelHack-handoff/vlm_fallback/*.jsonl

Sign descriptions ("hint") for the 27 requests outside our vocabulary are approximate common
ASL dictionary forms written by the developer, not checked by a Deaf signer; regional and
personal variants exist. The smoke test showed the model only reads our signs when such
descriptions are in the prompt (0 of 3 without), so the list carries them.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import threading
import time
import zlib
from collections import Counter, deque
from pathlib import Path
from typing import Sequence

import numpy as np

from . import frames as F
from . import prompts as P

REPEAT_BELOW = 0.6          # recognizer.REPEAT_BELOW (the app's 0.6 / NONE rule)
NONE_LABEL = "NONE"
NONE_OF_THESE = "NONE-OF-THESE"
TALHA_DIR = Path("/Users/trehman/CamelHack-p2avatar/data/videos/train")
REF_DIR = Path("/Users/trehman/CamelHack-p2avatar/capture/reference")
OUT_DIR = Path("/Users/trehman/CamelHack-handoff/vlm_fallback")
SHUFFLE_SEED = 20261010

# id (ASL-style gloss), english (what the guest confirms), sign (our classifier label or None),
# hint (plain description of the common dictionary form). Grouped by topic, fixed order.
HOTEL_REQUESTS: list[dict] = [
    # arrival / departure
    {"id": "CHECK-IN", "english": "I want to check in.", "sign": None,
     "hint": "often fingerspelled C-H-E-C-K I-N, or SIGN (H-hand fingers slap onto the other flat palm)"},
    {"id": "RESERVATION", "english": "I have a reservation.", "sign": "RESERVATION",
     "hint": P.SIGN_HINTS["RESERVATION"]},
    {"id": "NAME", "english": "My name is ...", "sign": "NAME", "hint": P.SIGN_HINTS["NAME"]},
    {"id": "LEAVE", "english": "I want to check out.", "sign": "LEAVE", "hint": P.SIGN_HINTS["LEAVE"]},
    {"id": "LATE", "english": "Can I have a late checkout? / I will be late.", "sign": "LATE",
     "hint": P.SIGN_HINTS["LATE"]},
    {"id": "KEY", "english": "I need a room key (my key does not work).", "sign": None,
     "hint": "bent index knuckle twists against the other flat palm, like turning a key"},
    {"id": "ROOM", "english": "About my room.", "sign": "ROOM", "hint": P.SIGN_HINTS["ROOM"]},
    {"id": "LUGGAGE", "english": "Can you keep my luggage?", "sign": None,
     "hint": "fist hangs down at the side and bobs as if carrying a suitcase"},
    {"id": "PAY", "english": "I want to pay the bill.", "sign": None,
     "hint": "index finger flicks forward off the other flat palm"},
    {"id": "CREDIT-CARD", "english": "Can I pay by card?", "sign": None,
     "hint": "fist slides back and forth across the other flat palm (card imprint)"},
    # getting around
    {"id": "WHERE", "english": "Where is ...?", "sign": "WHERE", "hint": P.SIGN_HINTS["WHERE"]},
    {"id": "ELEVATOR", "english": "Where is the elevator?", "sign": "ELEVATOR",
     "hint": P.SIGN_HINTS["ELEVATOR"]},
    {"id": "BATHROOM", "english": "Where is the bathroom?", "sign": None,
     "hint": "T-hand (thumb between index and middle finger) shakes side to side"},
    {"id": "PARKING", "english": "Where can I park my car?", "sign": "PARKING",
     "hint": P.SIGN_HINTS["PARKING"]},
    {"id": "TAXI", "english": "Please call me a taxi.", "sign": "TAXI", "hint": P.SIGN_HINTS["TAXI"]},
    {"id": "AIRPORT", "english": "How do I get to the airport?", "sign": None,
     "hint": "hand with thumb, index and pinky out (airplane) moves forward and up"},
    {"id": "POOL", "english": "Where is the pool?", "sign": None,
     "hint": "both flat hands sweep forward and apart, like a swimming stroke"},
    {"id": "GYM", "english": "Where is the gym?", "sign": None,
     "hint": "both fists pump up and down like lifting weights"},
    # food
    {"id": "BREAKFAST", "english": "When is breakfast?", "sign": "BREAKFAST",
     "hint": P.SIGN_HINTS["BREAKFAST"]},
    {"id": "RESTAURANT", "english": "Is there a restaurant?", "sign": "RESTAURANT",
     "hint": P.SIGN_HINTS["RESTAURANT"]},
    {"id": "EAT", "english": "Where can I get food?", "sign": None,
     "hint": "fingertips of a flat-O hand tap the mouth repeatedly"},
    {"id": "WATER", "english": "Can I have some water?", "sign": None,
     "hint": "W-hand (three fingers up) taps the chin with the index finger"},
    {"id": "COFFEE", "english": "Is there coffee?", "sign": None,
     "hint": "one fist circles on top of the other fist, like grinding"},
    # room needs
    {"id": "TOWEL", "english": "I need more towels.", "sign": "TOWEL", "hint": P.SIGN_HINTS["TOWEL"]},
    {"id": "MORE", "english": "More, please.", "sign": "MORE", "hint": P.SIGN_HINTS["MORE"]},
    {"id": "CLEAN", "english": "Please clean my room.", "sign": None,
     "hint": "flat hand wipes across the other flat palm, from heel to fingertips"},
    {"id": "BED", "english": "There is a problem with the bed / I want to sleep.", "sign": None,
     "hint": "head tilts onto a flat hand held beside the cheek"},
    {"id": "COLD", "english": "My room is too cold.", "sign": None,
     "hint": "both fists shiver side to side in front of the chest"},
    {"id": "HOT", "english": "My room is too hot.", "sign": None,
     "hint": "claw hand at the mouth twists and pulls away"},
    {"id": "NOISE", "english": "It is too noisy.", "sign": None,
     "hint": "index finger points to the ear, then both open hands shake outward"},
    {"id": "WAKE-UP", "english": "I want a wake-up call.", "sign": None,
     "hint": "pinched fingers beside the eyes spring open (eyes opening)"},
    {"id": "FS-WIFI", "english": "What is the Wi-Fi?", "sign": "FS-WIFI", "hint": P.SIGN_HINTS["FS-WIFI"]},
    {"id": "PASSWORD", "english": "What is the Wi-Fi password?", "sign": "PASSWORD",
     "hint": P.SIGN_HINTS["PASSWORD"]},
    {"id": "PHONE", "english": "Can I use a phone / please call someone.", "sign": None,
     "hint": "Y-hand (thumb and pinky out) held at the ear like a phone"},
    {"id": "TIME", "english": "What time ...?", "sign": "TIME", "hint": P.SIGN_HINTS["TIME"]},
    # help / health
    {"id": "HELP", "english": "I need help.", "sign": "HELP", "hint": P.SIGN_HINTS["HELP"]},
    {"id": "DOCTOR", "english": "I need a doctor.", "sign": None,
     "hint": "fingertips of a bent hand tap the inside of the other wrist (pulse)"},
    {"id": "SICK", "english": "I feel sick.", "sign": None,
     "hint": "middle fingers touch the forehead and the stomach at the same time"},
    {"id": "LOST", "english": "I lost something.", "sign": None,
     "hint": "both hands, fingertips together, drop and spring open downward"},
    # conversation
    {"id": "YES", "english": "Yes.", "sign": "YES", "hint": P.SIGN_HINTS["YES"]},
    {"id": "NO", "english": "No.", "sign": "NO", "hint": P.SIGN_HINTS["NO"]},
    {"id": "PLEASE", "english": "Please.", "sign": "PLEASE", "hint": P.SIGN_HINTS["PLEASE"]},
    {"id": "THANK-YOU", "english": "Thank you.", "sign": "THANK-YOU", "hint": P.SIGN_HINTS["THANK-YOU"]},
    {"id": "HELLO", "english": "Hello.", "sign": None, "hint": "flat hand salutes outward from the forehead"},
    {"id": "GOODBYE", "english": "Goodbye.", "sign": None, "hint": "open hand waves, fingers folding down and up"},
    {"id": "SORRY", "english": "Sorry.", "sign": None, "hint": "fist circles on the chest"},
    {"id": "WAIT", "english": "Please wait a moment.", "sign": None,
     "hint": "both open hands held palms up, fingers wiggling"},
    {"id": "NOT-UNDERSTAND", "english": "I do not understand. Please repeat.", "sign": None,
     "hint": "index finger beside the forehead flicks up, often with a head shake"},
]
REQUEST_BY_ID = {r["id"]: r for r in HOTEL_REQUESTS}
REQUEST_BY_SIGN = {r["sign"]: r for r in HOTEL_REQUESTS if r["sign"]}
_ID_SYNONYMS = {
    "THANK YOU": "THANK-YOU", "THANKS": "THANK-YOU", "WIFI": "FS-WIFI", "WI-FI": "FS-WIFI",
    "CHECKOUT": "LEAVE", "CHECK-OUT": "LEAVE", "CHECK OUT": "LEAVE", "FS-CHECKOUT": "LEAVE",
    "CHECKIN": "CHECK-IN", "CHECK IN": "CHECK-IN", "TOILET": "BATHROOM", "RESTROOM": "BATHROOM",
    "FOOD": "EAT", "CAB": "TAXI", "APPOINTMENT": "RESERVATION", "BOOKING": "RESERVATION",
    "BAGS": "LUGGAGE", "SUITCASE": "LUGGAGE", "BILL": "PAY", "CARD": "CREDIT-CARD",
    "SLEEP": "BED", "SWIM": "POOL", "EXERCISE": "GYM", "HI": "HELLO", "BYE": "GOODBYE",
    "AGAIN": "NOT-UNDERSTAND", "REPEAT": "NOT-UNDERSTAND", "PRIVATE WORD": "PASSWORD",
    "NONE": NONE_OF_THESE, "NONE OF THESE": NONE_OF_THESE, "NONE-OF-THESE": NONE_OF_THESE,
    "NONE_OF_THESE": NONE_OF_THESE,
}

assert len(HOTEL_REQUESTS) == len(REQUEST_BY_ID), "duplicate request id"
assert set(REQUEST_BY_SIGN) == set(P.LABELS) - {NONE_LABEL}, "every one of our 21 signs needs a request"


# ------------------------------------------------------------------------------------ prompt
def build_fallback_prompt(n_frames: int, requests: Sequence[dict] = HOTEL_REQUESTS, hints: bool = True,
                          k: int = 3) -> str:
    """One prompt for every engine: pick up to k request ids from the list, or none of these."""
    if hints:
        lines = "\n".join(f"- {r['id']}: \"{r['english']}\" Sign: {r['hint']}" for r in requests)
    else:
        lines = "\n".join(f"- {r['id']}: \"{r['english']}\"" for r in requests)
    return (
        P._PREAMBLE.format(n=n_frames) + "\n\n"
        f"Task: a hotel guest made one sign that an automatic recogniser could not read. Pick up to "
        f"{k} requests from the list below that the sign most likely means, most likely first. The "
        "guest will see your choices and tap the right one, so include a second and third guess "
        "when they are plausible. If no request fits, or no sign is visible (hands resting or out "
        f"of frame), answer {NONE_OF_THESE}.\n\n"
        "Requests (id: what the guest would mean, then the usual ASL form):\n" + lines + "\n\n"
        + P._JSON_RULE + "\n"
        'Schema: {"candidates": ["<request id copied exactly>", ...], "none_of_these": <true or false>, '
        '"what_i_see": "<one short sentence describing the hands>"}'
    )


def normalize_request(raw, requests_by_id: dict = REQUEST_BY_ID) -> str | None:
    if not isinstance(raw, str):
        return None
    s = re.sub(r"\s+", " ", raw.strip().strip(".'\"`").upper().replace("_", "-"))
    s = s.split(":")[0].strip()                     # "TOWEL: I need more towels" -> TOWEL
    if s in requests_by_id:
        return s
    for cand in (s, s.replace("-", " "), s.replace(" ", "-")):
        if cand in _ID_SYNONYMS:
            return _ID_SYNONYMS[cand]
        if cand in requests_by_id:
            return cand
    return None


def parse_fallback(text: str, k: int = 3, requests_by_id: dict = REQUEST_BY_ID) -> dict:
    """{"ok", "candidates": [ids], "none_of_these": bool, "format", "dropped": [unknown ids]}.
    Never raises. Falls back to scanning the text for ids when there is no JSON."""
    obj = P.parse_json(text or "")
    dropped: list[str] = []
    cands: list[str] = []
    if obj is None:
        # case-sensitive on purpose: ids are capitals, so "no idea" must not read as NO
        up = text or ""
        hits = []
        for rid in list(requests_by_id) + [NONE_OF_THESE]:
            m = re.search(r"(?<![A-Z-])" + re.escape(rid) + r"(?![A-Z-])", up)
            if m:
                hits.append((m.start(), rid))
        ids = [rid for _, rid in sorted(hits)]
        cands = [i for i in ids if i != NONE_OF_THESE][:k]
        none = NONE_OF_THESE in ids and not cands
        return {"ok": bool(cands) or none, "candidates": cands, "none_of_these": not cands,
                "model_none": NONE_OF_THESE in ids,
                "format": "free_text" if (cands or none) else "unparsed", "dropped": [],
                "what_i_see": None, "raw": text}
    raw_list = obj.get("candidates") or obj.get("meanings") or []
    if isinstance(raw_list, str):
        raw_list = [raw_list]
    saw_none = False
    for c in raw_list:
        if isinstance(c, dict):
            c = c.get("id") or c.get("gloss") or c.get("request")
        rid = normalize_request(c, requests_by_id)
        if rid == NONE_OF_THESE:
            saw_none = True
        elif rid and rid not in cands:
            cands.append(rid)
        elif rid is None and c:
            dropped.append(str(c))
    model_none = bool(P._as_bool(obj.get("none_of_these"))) or saw_none
    # none_of_these = the model proposed nothing usable; model_none = the model ticked the flag
    # (it sometimes ticks it while still listing candidates; candidates are still shown then).
    return {"ok": True, "candidates": cands[:k], "none_of_these": not cands, "model_none": model_none,
            "format": "json", "dropped": dropped, "what_i_see": obj.get("what_i_see"), "raw": text}


# ------------------------------------------------------------------------------------ hook
def should_fallback(top: Sequence[dict], threshold: float = REPEAT_BELOW) -> bool:
    """The classifier's top-3 list for one sign -> True when the VLM fallback should run."""
    if not top:
        return True
    p = top[0]
    try:
        conf = float(p.get("conf", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    return p.get("label") == NONE_LABEL or not (conf >= threshold)


class FrameRing:
    """Last `seconds` of camera frames in memory only, downscaled on push (long side `long_side`)
    so 4 s at 30 fps costs about 40 MB. Nothing is ever written to disk; clear() drops it all."""

    def __init__(self, seconds: float = 4.0, fps: float = 30.0, long_side: int = 448):
        self.long_side = long_side
        self._buf: deque = deque(maxlen=max(2, int(round(seconds * fps))))
        self._lock = threading.Lock()

    def push(self, bgr: np.ndarray, t: float) -> None:
        small = F._resize_long(bgr, self.long_side)
        with self._lock:
            self._buf.append((float(t), small.copy() if small is bgr else small))

    def segment(self, t_start: float, t_end: float) -> list[np.ndarray]:
        with self._lock:
            return [f for t, f in self._buf if t_start <= t <= t_end]

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()

    def __len__(self) -> int:
        return len(self._buf)


class Fallback:
    """Product-path wrapper. Holds a LocalVLM; propose() never blocks on another VLM job longer
    than lock_timeout_s (QC or a benchmark may hold the machine lock) and never raises."""

    def __init__(self, engine, n_frames: int = 4, hints: bool = True, k: int = 3,
                 timeout_s: float = 12.0, lock_timeout_s: float = 0.5, max_tokens: int = 96):
        if getattr(engine, "engine", None) != "local-mlx":
            raise ValueError("the product fallback runs only on a LOCAL engine (guest video must not "
                             "leave the laptop)")
        self.engine, self.n, self.hints, self.k = engine, n_frames, hints, k
        self.timeout_s, self.lock_timeout_s, self.max_tokens = timeout_s, lock_timeout_s, max_tokens

    def propose(self, frames_bgr: list[np.ndarray], seq: int | None = None,
                classifier_top: Sequence[dict] | None = None) -> dict:
        ev = {"type": "fallback", "seq": seq, "status": "ok", "candidates": [],
              "none_of_these_option": True, "needs_confirmation": True,
              "classifier_top": list(classifier_top or []), "latency_s": None}
        if len(frames_bgr) < 2:
            ev["status"] = "no_frames"
            return ev
        s = F.sample_frames_from_arrays(frames_bgr, n=self.n, mode="motion", long_side=None)
        prompt = build_fallback_prompt(len(s.images), hints=self.hints, k=self.k)
        from .engine import LockTimeout
        old = self.engine.lock_timeout_s
        self.engine.lock_timeout_s = self.lock_timeout_s
        try:
            r = self.engine.generate(s.images, prompt, max_tokens=self.max_tokens, timeout_s=self.timeout_s)
        except LockTimeout:
            ev["status"] = "busy"
            return ev
        except Exception as e:  # never crash the camera loop
            ev["status"] = f"error: {type(e).__name__}"
            return ev
        finally:
            self.engine.lock_timeout_s = old
            del s
        p = parse_fallback(r.text, self.k)
        ev["latency_s"] = round(r.latency_s, 2)
        if r.timed_out:
            ev["status"] = "timeout"
        if not p["ok"]:
            ev["status"] = "unparsed"
        ev["candidates"] = [{"id": c, "english": REQUEST_BY_ID[c]["english"],
                             "sign": REQUEST_BY_ID[c]["sign"]} for c in p["candidates"]]
        return ev


# ------------------------------------------------------------------------------------ stats
def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for k successes out of n."""
    if n <= 0:
        return (float("nan"), float("nan"))
    ph = k / n
    den = 1 + z * z / n
    centre = (ph + z * z / (2 * n)) / den
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def pct(xs: Sequence[float], q: float) -> float:
    return float(np.percentile(np.asarray(xs, dtype=float), q)) if len(xs) else float("nan")


def score_rows(rows: list[dict]) -> dict:
    """rows have truth (request id) and candidates. Returns hit rates, wrong-and-confident rate,
    abstentions, latency p50/p95 and the most common top-1 picks (position-bias check)."""
    n = len(rows)
    top1 = sum(1 for r in rows if r["candidates"][:1] == [r["truth"]])
    top3 = sum(1 for r in rows if r["truth"] in r["candidates"][:3])
    abstain = sum(1 for r in rows if not r["candidates"])
    wrong = sum(1 for r in rows if r["candidates"] and r["truth"] not in r["candidates"][:3])
    unparsed = sum(1 for r in rows if r.get("format") == "unparsed")
    lat = [r["latency_s"] for r in rows]
    return {
        "n": n, "top1": top1, "top1_rate": top1 / n if n else None, "top1_ci": wilson(top1, n),
        "top3": top3, "top3_rate": top3 / n if n else None, "top3_ci": wilson(top3, n),
        "abstained": abstain, "wrong_no_abstain": wrong, "wrong_no_abstain_rate": wrong / n if n else None,
        "wrong_no_abstain_ci": wilson(wrong, n), "unparsed": unparsed,
        "mean_candidates": float(np.mean([len(r["candidates"]) for r in rows])) if n else None,
        "latency_p50_s": pct(lat, 50), "latency_p95_s": pct(lat, 95),
        "top1_picks": Counter(r["candidates"][0] if r["candidates"] else NONE_OF_THESE
                              for r in rows).most_common(6),
        "chance_top3": 3 / len(HOTEL_REQUESTS),
        # a model that ignores the video and always shows the same 3 requests, picked in hindsight
        # as the 3 most frequent truths of these rows (3/21 = 0.143 on a balanced set of our signs)
        "constant_top3_best": (sum(c for _, c in Counter(r["truth"] for r in rows).most_common(3)) / n
                               if n else None),
        # where in the presented list the top-1 pick sat (0 = first); uniform would be ~23.5
        "top1_list_pos_median": (float(np.median([r["cand_pos"][0] for r in rows if r.get("cand_pos")]))
                                 if any(r.get("cand_pos") for r in rows) else None),
        "top1_in_first5_of_list": sum(1 for r in rows if r.get("cand_pos") and r["cand_pos"][0] < 5),
        **video_blind_baseline(rows),
    }


def video_blind_baseline(rows: list[dict], n_perm: int = 10000, seed: int = 0) -> dict:
    """Chance level that keeps the model's own answer habits. Shuffle which truth belongs to which
    clip (the candidates stay as the model gave them) and recount top-3 hits. A model that leans
    on a few favourite answers (WHERE, KEY, ...) scores above 3/48 without looking at the video;
    this baseline includes that. p = share of shuffles with at least the observed hits."""
    n = len(rows)
    if n == 0:
        return {"blind_top3_rate": None, "blind_top3_p": None}
    truths = [r["truth"] for r in rows]
    freq = Counter(truths)
    # exact expectation when each clip gets a truth drawn from the same truth mix
    exp_rate = float(np.mean([sum(freq[c] for c in set(r["candidates"][:3])) / n for r in rows]))
    obs = sum(1 for r in rows if r["truth"] in r["candidates"][:3])
    rng = random.Random(seed)
    cand_sets = [set(r["candidates"][:3]) for r in rows]
    ge = 0
    t = list(truths)
    for _ in range(n_perm):
        rng.shuffle(t)
        if sum(1 for tr, cs in zip(t, cand_sets) if tr in cs) >= obs:
            ge += 1
    return {"blind_top3_rate": exp_rate, "blind_top3_p": (ge + 1) / (n_perm + 1)}


# ------------------------------------------------------------------------------------ eval
def recorder_python_running(pattern: str = "train_session.py") -> bool:
    """Stricter than engine.recorder_running: only a PYTHON process whose command line names the
    recorder counts. engine.recorder_running also matches any shell whose command text merely
    contains the pattern (for example another agent's `pgrep -f train_session.py`), which made
    the eval pause 60 s for nothing."""
    import os
    import subprocess
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    for pid in r.stdout.split():
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            comm = subprocess.run(["ps", "-o", "comm=", "-p", pid], capture_output=True, text=True,
                                  timeout=10).stdout.strip().lower()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if "python" in Path(comm).name:
            return True
    return False


def wait_for_recorder_strict(poll_s: float = 60.0, log=print) -> float:
    t0 = time.monotonic()
    announced = False
    while recorder_python_running():
        if not announced:
            log(f"[vlm] recorder (train_session.py) is running; waiting, poll {poll_s:.0f} s")
            announced = True
        time.sleep(poll_s)
    return time.monotonic() - t0


def _num(stem: str) -> int:
    m = re.search(r"(\d+)$", stem)
    return int(m.group(1)) if m else 0


def eval_clips(which: str, takes: Sequence[int] | None = None, min_clips: int = 12) -> list[dict]:
    out = []
    if which == "talha":
        for d in sorted(p for p in TALHA_DIR.iterdir() if p.is_dir()):
            lab = P.normalize_label(d.name)
            mp4s = sorted(d.glob("talha_*.mp4"), key=lambda p: _num(p.stem))
            if lab is None or lab == NONE_LABEL or len(mp4s) < min_clips:
                continue
            for m in mp4s:
                if takes and _num(m.stem) not in takes:
                    continue
                out.append({"clip": f"{d.name}/{m.stem}", "truth": REQUEST_BY_SIGN[lab]["id"], "path": str(m)})
    elif which == "none":           # NONE class takes (idle hands, scratching): right answer = propose nothing
        d = TALHA_DIR / NONE_LABEL
        for m in sorted(d.glob("talha_*.mp4"), key=lambda p: _num(p.stem)) if d.exists() else []:
            if takes and _num(m.stem) not in takes:
                continue
            out.append({"clip": f"NONE/{m.stem}", "truth": NONE_OF_THESE, "path": str(m)})
    elif which == "reference":
        for m in sorted(REF_DIR.glob("*.mp4")):
            lab = P.normalize_label(m.stem)
            if lab and lab != NONE_LABEL:
                out.append({"clip": f"reference/{m.stem}", "truth": REQUEST_BY_SIGN[lab]["id"], "path": str(m)})
    else:
        raise ValueError(which)
    return out


def _run_eval(a) -> int:
    from .engine import LocalVLM
    wait_for_recorder = wait_for_recorder_strict
    clips = []
    for s in a.set:
        clips += eval_clips(s, a.takes)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        done = {json.loads(l)["clip"] for l in out.read_text().splitlines() if l.strip()}
    todo = [c for c in clips if c["clip"] not in done]
    print(f"[fallback] {len(clips)} clips, {len(done)} already done, {len(todo)} to run -> {out}", flush=True)
    if not todo:
        return 0
    log = lambda m: print(m, flush=True)  # noqa: E731
    wait_for_recorder(poll_s=60, log=log)
    eng = LocalVLM(a.model, max_tokens=a.max_tokens, timeout_s=120, load=False)
    print(f"[fallback] {a.model} loaded in {eng.load():.1f} s", flush=True)
    s0 = F.sample_frames(todo[0]["path"], n=2, long_side=a.long_side)
    eng.generate(s0.images, "Describe the hands in five words.", max_tokens=12)   # warm-up, not scored
    with out.open("a") as fh:
        for i, c in enumerate(todo):
            wait_for_recorder(poll_s=60, log=log)
            reqs = list(HOTEL_REQUESTS)
            if getattr(a, "drop_truth", 0):   # out-of-list simulation: the right request is absent
                reqs = [q for q in reqs if q["id"] != c["truth"]]
            if a.order == "shuffled":      # reproducible per clip: exposes position bias
                random.Random(zlib.crc32(c["clip"].encode()) ^ SHUFFLE_SEED).shuffle(reqs)
            order = [q["id"] for q in reqs]
            prompt = build_fallback_prompt(a.frames, reqs, hints=bool(a.hints), k=3)
            s = F.sample_frames(c["path"], n=a.frames, mode="motion", long_side=a.long_side)
            r = eng.generate(s.images, prompt)
            p = parse_fallback(r.text)
            row = {"clip": c["clip"], "truth": c["truth"], "candidates": p["candidates"],
                   "none_of_these": p["none_of_these"], "model_none": p.get("model_none"),
                   "format": p["format"], "dropped": p["dropped"],
                   "what_i_see": p.get("what_i_see"), "latency_s": round(r.latency_s, 2),
                   "lock_wait_s": round(r.lock_wait_s, 2), "prompt_tokens": r.prompt_tokens,
                   "generation_tokens": r.generation_tokens, "peak_mlx_gb": round(r.peak_memory_gb or 0, 2),
                   "timed_out": r.timed_out, "n_frames": a.frames, "hints": bool(a.hints),
                   "order": a.order, "drop_truth": bool(getattr(a, "drop_truth", 0)),
                   "truth_pos": order.index(c["truth"]) if c["truth"] in order else None,
                   "cand_pos": [order.index(x) for x in p["candidates"]],
                   "model": a.model, "raw": r.text[:600]}
            fh.write(json.dumps(row) + "\n")
            fh.flush()
            hit = "HIT" if c["truth"] in p["candidates"] else "miss"
            print(f"[{i + 1}/{len(todo)}] {c['clip']:<26} {hit:<4} {p['candidates']} {r.latency_s:.1f}s", flush=True)
    eng.unload()
    return 0


def _summarize(paths: Sequence[str]) -> dict:
    res = {}
    for path in paths:
        rows = [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
        for r in rows:          # re-parse the stored reply so every row uses the current parser
            if r.get("raw") is not None:
                q = parse_fallback(r["raw"])
                r["candidates"], r["format"] = q["candidates"], q["format"]
            if "cand_pos" not in r:   # rows from the first run used the fixed list order
                fixed = [x["id"] for x in HOTEL_REQUESTS]
                r["cand_pos"] = [fixed.index(x) for x in r["candidates"]]
        dropped_rows = [r for r in rows if r.get("drop_truth")]
        rows = [r for r in rows if not r.get("drop_truth")]
        none_rows = [r for r in rows if r["truth"] == NONE_OF_THESE]
        rows = [r for r in rows if r["truth"] != NONE_OF_THESE]
        groups = {"all": rows}
        groups["talha"] = [r for r in rows if not r["clip"].startswith("reference/")]
        groups["reference"] = [r for r in rows if r["clip"].startswith("reference/")]
        res[Path(path).name] = {g: score_rows(v) for g, v in groups.items() if v}
        if none_rows:   # idle-hands clips: the right behaviour is to propose nothing
            k = sum(1 for r in none_rows if not r["candidates"])
            res[Path(path).name]["none_clips"] = {
                "n": len(none_rows), "abstained": k, "abstain_ci": wilson(k, len(none_rows)),
                "proposed_something": len(none_rows) - k,
                "picks": Counter(r["candidates"][0] for r in none_rows if r["candidates"]).most_common(5),
                "latency_p50_s": pct([r["latency_s"] for r in none_rows], 50),
                "latency_p95_s": pct([r["latency_s"] for r in none_rows], 95)}
        if dropped_rows:  # right request removed from the list: the honest answer is "none of these"
            k = sum(1 for r in dropped_rows if not r["candidates"])
            res[Path(path).name]["truth_removed"] = {
                "n": len(dropped_rows), "abstained": k, "abstain_ci": wilson(k, len(dropped_rows)),
                "proposed_wrong": len(dropped_rows) - k,
                "proposed_wrong_ci": wilson(len(dropped_rows) - k, len(dropped_rows)),
                "picks": Counter(r["candidates"][0] for r in dropped_rows if r["candidates"]).most_common(6),
                "latency_p50_s": pct([r["latency_s"] for r in dropped_rows], 50),
                "latency_p95_s": pct([r["latency_s"] for r in dropped_rows], 95)}
        per_class = {}
        for r in groups.get("talha", []):
            per_class.setdefault(r["truth"], []).append(r["truth"] in r["candidates"][:3])
        res[Path(path).name]["talha_top3_by_class"] = {k: f"{sum(v)}/{len(v)}" for k, v in sorted(per_class.items())}
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("eval")
    e.add_argument("--set", nargs="+", default=["talha"], choices=["talha", "reference", "none"])
    e.add_argument("--takes", nargs="*", type=int, default=None, help="only these take numbers (talha set)")
    e.add_argument("--model", default="mlx-community/Qwen3-VL-4B-Instruct-4bit")
    e.add_argument("--frames", type=int, default=8)
    e.add_argument("--hints", type=int, default=1)
    e.add_argument("--long-side", type=int, default=448)
    e.add_argument("--max-tokens", type=int, default=120)
    e.add_argument("--order", default="shuffled", choices=["fixed", "shuffled"])
    e.add_argument("--drop-truth", type=int, default=0,
                   help="1 = remove the clip's own request from the list (simulates a sign outside the list)")
    e.add_argument("--out", required=True)
    s = sub.add_parser("summarize")
    s.add_argument("paths", nargs="+")
    a = ap.parse_args(argv)
    if a.cmd == "eval":
        return _run_eval(a)
    print(json.dumps(_summarize(a.paths), indent=1, default=str))
    return 0


INTEGRATION_NOTE = """
Integration plan for recognition/live.py, recognition/stream.py and the app. Nothing in those
files was edited; this is the proposal for their owners.

1. Frames. live.py keeps one FrameRing(seconds=4, fps=30, long_side=448) and pushes every
   UNMIRRORED camera frame (the bgr it already passes to stream.detect) with the same monotonic
   time t. The ring is memory only (about 40 MB), is cleared when the guest session ends, and is
   never written to disk or sent anywhere. stream.py needs no change: its "sign" event already
   carries t_sign_start / t_sign_end, which are clock + stream.offset, so the ring window is
   ring.segment(t_sign_start - offset - 0.3, t_sign_end - offset + 0.1).
2. Trigger. Only for a "sign" event where should_fallback(ev["top"]) is True (top-1 NONE or
   conf < 0.6, the recognizer.needs_repeat rule for one sign). Never for a "framing" event with
   rejected_seq: a badly framed sign gets the framing prompt, not the VLM.
3. Worker. One daemon thread with a queue of length 1 (a newer unsure sign replaces a waiting
   one). It calls Fallback.propose(frames, seq=ev["seq"], classifier_top=ev["top"]). The camera
   loop never waits. Fallback refuses any engine that is not the local MLX engine, so guest video
   cannot be sent to a cloud model through this path. If QC or a benchmark holds the machine-wide
   VLM lock, propose() returns status "busy" after 0.5 s instead of queueing behind it. The model
   is loaded once at live.py start (about 4-6 s, about 4.3 GB peak) and only when a --vlm-fallback
   flag is given.
4. Event (new type, posted through the existing Poster):
     {"type": "fallback", "seq": 7, "status": "ok" | "busy" | "timeout" | "unparsed" |
      "no_frames" | "error: <name>", "candidates": [{"id": "TOWEL", "english": "I need more
      towels.", "sign": "TOWEL"}, ...], "none_of_these_option": true, "needs_confirmation": true,
      "classifier_top": [...], "latency_s": 6.1}
   Poster.priority() must include "fallback"; today an unknown type is coalesced, sent with the
   0.3 s light timeout, and dropped after STALE_SEC = 5 s. The event holds words only, never
   frames or landmarks.
5. Timing. The utterance event (needs_repeat = true) arrives about 1.5 s after the hands drop,
   long before the VLM answers. The app shows the usual "Could you repeat?" immediately and adds
   a small "Checking what you might mean..." line. When a fallback event for one of that
   utterance's seqs arrives within the timeout, the app offers the choices; a late event (after
   the timeout, or after the guest has already signed again) is ignored.
   Timeout: see the measured latency in PROGRESS_LIVE_vlm.md; the generate call itself stops
   decoding at timeout_s but cannot be interrupted while it reads the images.
6. Guest screen copy:
     "Did you mean...?"
     [ I need more towels. ]  [ More, please. ]  [ Please. ]
     [ None of these - I'll sign again ]
   Staff screen shows nothing from the fallback until the guest taps. A tapped candidate
   replaces that sign in the utterance, marked "confirmed by guest", and only then may it be
   sent to /api/english and spoken. "None of these" keeps the normal repeat request. Choices
   that are not one of our 21 signs (for example "Can you keep my luggage?") are spoken as the
   English text directly, since there is no classifier label for them.
7. The proposals are guesses from a model that, on Talha's clips, rarely puts the right meaning
   in its top 3 (see the evaluation). The UI must never pre-select a candidate or speak one on a
   timer.
"""


if __name__ == "__main__":
    sys.exit(main())

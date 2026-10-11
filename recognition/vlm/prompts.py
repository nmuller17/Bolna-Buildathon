"""One shared prompt per task, used unchanged by every engine (ProtoCopilot style).

Four tasks:
  closed_set  - pick 1 of our 22 classifier labels from a few frames of one clip.
  open_set    - propose 2-3 possible meanings when the sign may be outside our vocabulary.
  qc          - compare a training take with the reference video of the same sign.
  facial      - read the non-manual marker (yes/no question, wh-question, negation, neutral).

Each task has a build_* function that returns the prompt text and a parse_* function that turns
the model's raw reply into a validated dict. Parsers never raise on bad model output: they return
a dict with "ok": False and the reason, so a caller can count format failures honestly.

Label list: docs/vocabulary.md section 3 on the p2-avatar branch, where checkout is LEAVE.
recognition/labels.py on this branch still says FS-CHECKOUT; the parser maps FS-CHECKOUT,
CHECKOUT and CHECK-OUT to LEAVE so both spellings land on the same class.
"""
from __future__ import annotations

import json
import re
from typing import Any

LABELS: list[str] = [
    "YES", "NO", "RESERVATION", "NAME", "THANK-YOU", "WHERE", "ELEVATOR",
    "FS-WIFI", "PASSWORD", "BREAKFAST", "TIME", "TOWEL", "MORE", "LEAVE",
    "LATE", "PLEASE", "PARKING", "TAXI", "HELP", "ROOM", "RESTAURANT", "NONE",
]

# Typical dictionary form of each sign, written in plain words for the model. These are the
# common ASL-dictionary forms; a team recording can differ, so hints are optional (hints=False).
SIGN_HINTS: dict[str, str] = {
    "YES": "fist nods up and down at the wrist, like a head nodding",
    "NO": "index and middle fingers snap shut onto the thumb, once or twice",
    "RESERVATION": "one hand circles above the other wrist, then lands on it (APPOINTMENT)",
    "NAME": "two H-hands (index+middle fingers out), one taps across the other twice",
    "THANK-YOU": "flat hand starts at the chin or lips and moves forward and down",
    "WHERE": "index finger points up and wags side to side",
    "ELEVATOR": "E-hand moves straight up and down along the other hand's raised index finger",
    "FS-WIFI": "fingerspelled W-I-F-I with one hand near the shoulder",
    "PASSWORD": "compound: PRIVATE (A-hand thumb taps the lips) then WORD (G-hand at the other index finger)",
    "BREAKFAST": "compound: EAT (fingertips to mouth) then MORNING (forearm rises like the sun)",
    "TIME": "index finger taps the back of the other wrist, where a watch would be",
    "TOWEL": "two fists move back and forth as if drying the back with a towel",
    "MORE": "fingertips of both flat-O hands tap together in front of the body",
    "LEAVE": "both open hands pull back toward the body and close (leave / checkout)",
    "LATE": "open hand down at the side of the waist flaps backward (NOT-YET / LATE)",
    "PLEASE": "flat hand circles on the chest",
    "PARKING": "3-hand (vehicle) set down on the flat palm of the other hand",
    "TAXI": "C-hand taps the top of the head (cab light) or fingerspelled T-A-X-I",
    "HELP": "fist (thumb up) sits on the other flat palm and both lift up together",
    "ROOM": "two flat or R-hands outline the sides of a box",
    "RESTAURANT": "R-hand touches one corner of the mouth then the other",
    "NONE": "no sign: hands resting, idle, fidgeting, or a sign that is not in this list",
}

# Words a model tends to write instead of our exact label.
_SYNONYMS: dict[str, str] = {
    "THANK YOU": "THANK-YOU", "THANKYOU": "THANK-YOU", "THANKS": "THANK-YOU",
    "WIFI": "FS-WIFI", "WI-FI": "FS-WIFI", "FS:WIFI": "FS-WIFI", "FS WIFI": "FS-WIFI",
    "W-I-F-I": "FS-WIFI",
    "CHECKOUT": "LEAVE", "CHECK-OUT": "LEAVE", "CHECK OUT": "LEAVE", "FS-CHECKOUT": "LEAVE",
    "PASS WORD": "PASSWORD", "PRIVATE WORD": "PASSWORD", "PRIVATE-WORD": "PASSWORD",
    "CAB": "TAXI", "NOTHING": "NONE", "NO SIGN": "NONE", "NO-SIGN": "NONE", "IDLE": "NONE",
    "APPOINTMENT": "RESERVATION", "BOOKING": "RESERVATION",
}

FACIAL_MARKERS = ["yes_no_question", "wh_question", "negation", "neutral"]

_PREAMBLE = (
    "You are looking at {n} frames sampled in time order from a short webcam video of one person "
    "signing American Sign Language (ASL) at a hotel front desk. Frame 1 is the earliest. "
    "The video may be mirrored (left and right swapped). Look at handshape, palm orientation, "
    "location relative to the face and body, movement across frames, and the face."
)

_JSON_RULE = (
    "Answer with ONE JSON object and nothing else: no markdown, no code fence, no text before "
    "or after it."
)


# --------------------------------------------------------------------------------------- build
def build_closed_set(n_frames: int, labels: list[str] | None = None, hints: bool = True) -> str:
    labels = list(labels or LABELS)
    if hints:
        lines = "\n".join(f"- {lab}: {SIGN_HINTS.get(lab, '')}".rstrip(": ") for lab in labels)
        label_block = "Allowed labels, with the typical dictionary form of each:\n" + lines
    else:
        label_block = "Allowed labels: " + ", ".join(labels)
    return (
        _PREAMBLE.format(n=n_frames) + "\n\n"
        "Task: decide which ONE sign from the allowed list is being performed. "
        "If none of them fits, answer NONE.\n\n"
        + label_block + "\n\n"
        + _JSON_RULE + "\n"
        'Schema: {"label": "<one allowed label, copied exactly>", "confidence": <number 0 to 1>, '
        '"top3": ["<label>", "<label>", "<label>"], "reason": "<one short sentence>"}'
    )


def build_open_set(n_frames: int, k: int = 3, context: str = "a hotel front desk") -> str:
    return (
        _PREAMBLE.format(n=n_frames) + "\n\n"
        f"Task: the sign may be ANY ASL sign, not only hotel words. Propose the {k} most likely "
        f"meanings, most likely first, as a guest would mean them at {context}. For each, give "
        "the ASL gloss in capitals and a short English sentence the receptionist could read out "
        "for the guest to confirm. If you cannot see a sign at all (hands resting or out of "
        'frame), set "is_sign" to false and give an empty list.\n\n'
        + _JSON_RULE + "\n"
        'Schema: {"is_sign": true, "meanings": [{"gloss": "<GLOSS>", "english": "<sentence>", '
        '"confidence": <0 to 1>}], "what_i_see": "<one short sentence describing the hands>"}'
    )


def build_qc(sign: str, n_reference: int, n_take: int, hints: bool = True) -> str:
    hint = f" Its typical dictionary form: {SIGN_HINTS[sign]}." if hints and sign in SIGN_HINTS else ""
    return (
        f"You are checking a training recording of the American Sign Language sign {sign}.{hint}\n"
        f"The first {n_reference} images are frames from the REFERENCE video (correct sign), in "
        f"time order. The next {n_take} images are frames from the TAKE (new recording), in time "
        "order. The two people, cameras, distances and mirroring may differ; ignore those. "
        "Judge only whether the TAKE performs the same sign as the REFERENCE: same handshape(s), "
        "same location on the body, same movement path and repetitions, same number of hands, "
        "same parts in the same order for a compound sign.\n\n"
        + _JSON_RULE + "\n"
        'Schema: {"same_sign": <true or false>, "score": <0 to 1, 1 = clearly the same sign>, '
        '"handshape_ok": <true/false>, "location_ok": <true/false>, "movement_ok": <true/false>, '
        '"issues": ["<short problem>", ...]}'
    )


def build_facial(n_frames: int) -> str:
    return (
        _PREAMBLE.format(n=n_frames) + "\n\n"
        "Task: ignore the hands and read the face and head only. In ASL, raised eyebrows with "
        "the head tilted forward mark a yes/no question; furrowed (lowered, squeezed) eyebrows "
        "mark a wh-question (who, what, where, when, why, how); a side-to-side head shake, often "
        "with a frown, marks negation. Otherwise the face is neutral.\n\n"
        + _JSON_RULE + "\n"
        'Schema: {"marker": "<yes_no_question | wh_question | negation | neutral>", '
        '"brows": "<raised | furrowed | neutral>", "head": "<shake | nod | tilt_forward | none>", '
        '"confidence": <0 to 1>}'
    )


# --------------------------------------------------------------------------------------- parse
_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S | re.I)
_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)


def _balanced_objects(text: str) -> list[str]:
    """All top-level {...} substrings, honouring strings and escapes."""
    out, depth, start, in_str, esc = [], 0, None, False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                out.append(text[start:i + 1])
                start = None
    return out


def _loads_lenient(s: str) -> Any:
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    t = re.sub(r",\s*([}\]])", r"\1", s)                       # trailing commas
    t = re.sub(r"\bTrue\b", "true", t)
    t = re.sub(r"\bFalse\b", "false", t)
    t = re.sub(r"\bNone\b", "null", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    if "'" in t and '"' not in t:                               # python-style single quotes
        try:
            return json.loads(t.replace("'", '"'))
        except json.JSONDecodeError:
            pass
    raise ValueError("not JSON")


def parse_json(text: str) -> dict | None:
    """First JSON object found in a model reply, or None. Handles fences, <think>, chatter."""
    if not text:
        return None
    body = _THINK.sub("", text)
    candidates = [m.group(1) for m in _FENCE.finditer(body)] + [body]
    for cand in candidates:
        for obj in _balanced_objects(cand):
            try:
                val = _loads_lenient(obj)
            except ValueError:
                continue
            if isinstance(val, dict):
                return val
    return None


def normalize_label(raw: Any, labels: list[str] | None = None) -> str | None:
    """Map a model's label string onto our exact label, or None if it is not one of ours."""
    if not isinstance(raw, str):
        return None
    labels = list(labels or LABELS)
    s = raw.strip().strip(".'\"`").upper().replace("_", "-")
    s = re.sub(r"\s+", " ", s)
    if s in labels:
        return s
    if s in _SYNONYMS and _SYNONYMS[s] in labels:
        return _SYNONYMS[s]
    s2 = s.replace(" ", "-")
    if s2 in labels:
        return s2
    return None


def _clip01(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    if 1.0 < v <= 100.0:   # a model that answered in percent
        v = v / 100.0
    return min(1.0, max(0.0, v))


def _as_bool(x: Any) -> bool | None:
    if isinstance(x, bool):
        return x
    if isinstance(x, str) and x.strip().lower() in ("true", "yes", "1"):
        return True
    if isinstance(x, str) and x.strip().lower() in ("false", "no", "0"):
        return False
    return None


def _scan_labels(text: str, labels: list[str]) -> str | None:
    """Fallback when there is no JSON: the first allowed label (or synonym) named in the text."""
    up = text.upper()
    best: tuple[int, str] | None = None
    keys = [(lab, lab) for lab in labels] + [(k, v) for k, v in _SYNONYMS.items() if v in labels]
    for key, lab in keys:
        m = re.search(r"(?<![A-Z-])" + re.escape(key) + r"(?![A-Z-])", up)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), lab)
    return best[1] if best else None


def parse_closed_set(text: str, labels: list[str] | None = None) -> dict:
    labels = list(labels or LABELS)
    obj = parse_json(text)
    if obj is None:
        lab = _scan_labels(text or "", labels)
        return {"ok": lab is not None, "label": lab, "confidence": None, "top3": [lab] if lab else [],
                "format": "free_text" if lab else "unparsed", "raw": text}
    lab = normalize_label(obj.get("label"), labels)
    top3 = []
    for t in obj.get("top3") or []:
        n = normalize_label(t, labels)
        if n and n not in top3:
            top3.append(n)
    if lab and (not top3 or top3[0] != lab):
        top3 = [lab] + [t for t in top3 if t != lab]
    return {"ok": lab is not None, "label": lab, "confidence": _clip01(obj.get("confidence")),
            "top3": top3[:3], "reason": obj.get("reason"),
            "format": "json" if lab else "json_bad_label", "raw": text}


def parse_open_set(text: str, k: int = 3) -> dict:
    obj = parse_json(text)
    if obj is None:
        return {"ok": False, "is_sign": None, "meanings": [], "format": "unparsed", "raw": text}
    meanings = []
    for m in obj.get("meanings") or []:
        if isinstance(m, dict) and (m.get("gloss") or m.get("english")):
            meanings.append({"gloss": str(m.get("gloss") or "").strip().upper(),
                             "english": str(m.get("english") or "").strip(),
                             "confidence": _clip01(m.get("confidence"))})
        elif isinstance(m, str) and m.strip():
            meanings.append({"gloss": m.strip().upper(), "english": "", "confidence": None})
    is_sign = _as_bool(obj.get("is_sign"))
    if is_sign is None:
        is_sign = bool(meanings)
    return {"ok": True, "is_sign": is_sign, "meanings": meanings[:k],
            "what_i_see": obj.get("what_i_see"), "format": "json", "raw": text}


def parse_qc(text: str) -> dict:
    obj = parse_json(text)
    if obj is None:
        return {"ok": False, "same_sign": None, "score": None, "issues": [], "format": "unparsed",
                "raw": text}
    same = _as_bool(obj.get("same_sign"))
    score = _clip01(obj.get("score"))
    if same is None and score is not None:
        same = score >= 0.5
    issues = obj.get("issues") or []
    if isinstance(issues, str):
        issues = [issues]
    return {"ok": same is not None, "same_sign": same, "score": score,
            "handshape_ok": _as_bool(obj.get("handshape_ok")),
            "location_ok": _as_bool(obj.get("location_ok")),
            "movement_ok": _as_bool(obj.get("movement_ok")),
            "issues": [str(i) for i in issues][:6], "format": "json", "raw": text}


def parse_facial(text: str) -> dict:
    obj = parse_json(text)
    if obj is None:
        return {"ok": False, "marker": None, "format": "unparsed", "raw": text}
    raw = str(obj.get("marker") or "").strip().lower().replace("-", "_").replace("/", "_")
    raw = re.sub(r"\s+", "_", raw)
    alias = {"yes_no": "yes_no_question", "yn_question": "yes_no_question", "yes_no_q": "yes_no_question",
             "wh": "wh_question", "wh_q": "wh_question", "neg": "negation", "none": "neutral"}
    marker = raw if raw in FACIAL_MARKERS else alias.get(raw)
    return {"ok": marker is not None, "marker": marker, "brows": obj.get("brows"),
            "head": obj.get("head"), "confidence": _clip01(obj.get("confidence")),
            "format": "json" if marker else "json_bad_marker", "raw": text}


TASKS = {
    "closed_set": (build_closed_set, parse_closed_set),
    "open_set": (build_open_set, parse_open_set),
    "qc": (build_qc, parse_qc),
    "facial": (build_facial, parse_facial),
}

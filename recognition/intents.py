"""Sentence-level correction: snap a sequence of predicted signs to the closest guest intent.

Each sign comes with the model's probabilities over the 22 classes. Instead of taking each
sign's top label on its own, decode() scores every guest sentence of docs/vocabulary.md
section 2 with the same number of signs (sum of log probabilities of its labels, NONE left out
and the rest renormalized) and keeps the best one, so a sign the model got wrong is fixed by
the others: [YES, TIME (RESERVATION 3rd)] -> "YES RESERVATION".

MIN_PROB: the snap is refused (raw top labels kept) when one of the sentence's signs has a
probability below it. 0 for the demo (always snap to a known sentence): on a held-out signer
(model trained without talha, 500 simulated sentences) 0.02 gives 94.2% right sentences,
0.005 and below 95.8%, against 84% without correction.
"""
import math

import numpy as np

from recognition.labels import CLASSES, INDEX, NONE

# docs/vocabulary.md section 2 (checkout = LEAVE), with the sentence spoken to the staff.
GUEST_INTENTS = [
    (["YES"], "Yes."),
    (["NO"], "No."),
    (["YES", "RESERVATION"], "Yes, I have a reservation."),
    (["NAME"], "My name is"),
    (["THANK-YOU"], "Thank you."),
    (["WHERE", "ELEVATOR"], "Where is the elevator?"),
    (["FS-WIFI", "PASSWORD"], "What's the Wi-Fi password?"),
    (["BREAKFAST", "TIME"], "What time is breakfast?"),
    (["WHERE", "BREAKFAST"], "Where is breakfast served?"),
    (["MORE", "TOWEL", "PLEASE"], "Could I have more towels, please?"),
    (["LEAVE", "TIME"], "What time is checkout?"),
    (["LATE", "LEAVE", "PLEASE"], "Could I have a late checkout?"),
    (["WHERE", "PARKING"], "Where can I park?"),
    (["TAXI", "PLEASE"], "Could you call me a taxi?"),
    (["HELP", "PLEASE"], "I need some help, please."),
    (["WHERE", "ROOM"], "Where is my room?"),
    (["ROOM", "HELP"], "There's a problem with my room."),
    (["WHERE", "RESTAURANT"], "Where is the restaurant?"),
    (["RESTAURANT", "TIME"], "When is the restaurant open?"),
    (["NO", "THANK-YOU"], "No, that's all, thank you."),
]
MIN_PROB = 0.0


def without_none(probs):
    """Probabilities over the 22 classes -> same vector with NONE removed and renormalized."""
    p = np.asarray(probs, dtype=float).copy()
    p[INDEX[NONE]] = 0.0
    total = p.sum()
    return p / total if total > 0 else p


def decode(sign_probs):
    """List of per-sign probability vectors (22 classes, CLASSES order) -> dict:
    raw: top label per sign (NONE excluded), labels: corrected labels, text: English sentence
    or None, snapped: whether an intent was used, score: mean log probability of the result."""
    probs = [without_none(p) for p in sign_probs]
    raw = [CLASSES[int(np.argmax(p))] for p in probs]
    best = None
    for labels, text in GUEST_INTENTS:
        if len(labels) != len(probs):
            continue
        ps = [p[INDEX[label]] for p, label in zip(probs, labels)]
        if MIN_PROB and min(ps) < MIN_PROB:
            continue
        score = sum(math.log(max(x, 1e-12)) for x in ps) / len(ps)
        if best is None or score > best[0]:
            best = (score, labels, text)
    if best is None:
        score = sum(math.log(max(p.max(), 1e-9)) for p in probs) / max(len(probs), 1)
        return {"raw": raw, "labels": raw, "text": None, "snapped": False, "score": score}
    return {"raw": raw, "labels": best[1], "text": best[2], "snapped": True, "score": best[0]}

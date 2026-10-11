"""Continuous sentence decoding (recognition.sentence) on synthetic window probabilities."""
import numpy as np

from recognition.labels import CLASSES, INDEX
from recognition.intents import GUEST_INTENTS
from recognition.sentence import candidate_intents, decode_continuous


def windows(*runs):
    """runs of (label, count, p): windows where `label` gets probability p, the rest shared."""
    out = []
    for label, count, p in runs:
        for _ in range(count):
            v = np.full(len(CLASSES), (1 - p) / (len(CLASSES) - 1))
            v[INDEX[label]] = p
            out.append(v)
    return out


def test_clear_sentence_is_found():
    r = decode_continuous(windows(("MORE", 8, 0.8), ("TOWEL", 8, 0.8), ("PLEASE", 8, 0.8)))
    assert r["labels"] == ["MORE", "TOWEL", "PLEASE"]
    assert r["text"] == "Could I have more towels, please?"


def test_misread_sign_without_context_gives_another_sentence():
    # RESERVATION read as TIME: without context the best sentence is not YES RESERVATION.
    probs = windows(("YES", 8, 0.7), ("TIME", 8, 0.6))
    assert decode_continuous(probs)["labels"] != ["YES", "RESERVATION"]


def test_expected_answers_restrict_the_choice():
    probs = windows(("YES", 8, 0.7), ("TIME", 8, 0.6))
    r = decode_continuous(probs, candidates=[["YES"], ["NO"], ["YES", "RESERVATION"]])
    assert r["labels"] in (["YES"], ["YES", "RESERVATION"])
    r = decode_continuous(probs, candidates=[["YES", "RESERVATION"]])
    assert r["labels"] == ["YES", "RESERVATION"] and r["text"] == "Yes, I have a reservation."


def test_unknown_or_empty_candidates_fall_back_to_all():
    n = len(GUEST_INTENTS)
    assert len(candidate_intents(None)) == n
    assert len(candidate_intents([])) == n
    assert len(candidate_intents([["NOT-A-SENTENCE"]])) == n
    assert len(candidate_intents([["YES"], ["NO", "THANK-YOU"]])) == 2

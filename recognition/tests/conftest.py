"""Shared pytest setup for recognition tests.

The tests build their own throwaway checkpoints, so they cannot match the committed pin in
recognition/model_pin.py (the demo model). For the whole session (module-scoped fixtures load
models too) the pin is set aside and the development opt-in RECOGNITION_ALLOW_UNPINNED=1 is on,
exactly as a developer would run an unpinned checkpoint. Tests that check pinning set the pin
themselves (monkeypatch), tests/security/ removes the opt-in wherever it checks the fail-closed
behaviour, and test_recognizer.py checks that the committed model.pt matches the committed pin.
"""
import os

import pytest

from recognition import model_pin

COMMITTED_PIN = model_pin.EXPECTED_SHA256


@pytest.fixture(scope="session", autouse=True)
def _allow_unpinned_test_checkpoints():
    old = os.environ.get("RECOGNITION_ALLOW_UNPINNED")
    os.environ["RECOGNITION_ALLOW_UNPINNED"] = "1"
    model_pin.EXPECTED_SHA256 = None
    yield
    model_pin.EXPECTED_SHA256 = COMMITTED_PIN
    if old is None:
        os.environ.pop("RECOGNITION_ALLOW_UNPINNED", None)
    else:
        os.environ["RECOGNITION_ALLOW_UNPINNED"] = old

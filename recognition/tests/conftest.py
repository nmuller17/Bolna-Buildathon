"""Shared pytest setup for recognition tests.

The tests build their own throwaway checkpoints, so they cannot match the committed pin in
recognition/model_pin.py (the demo model). For the whole session (module-scoped fixtures load
models too) the pin is set aside and the development opt-in RECOGNITION_ALLOW_UNPINNED=1 is on,
exactly as a developer would run an unpinned checkpoint. Tests that check pinning set the pin
themselves (monkeypatch), tests/security/ removes the opt-in wherever it checks the fail-closed
behaviour, and test_recognizer.py checks that the committed model.pt matches the committed pin.
"""
import pytest

from recognition import model_pin

COMMITTED_PIN = model_pin.EXPECTED_SHA256


@pytest.fixture(scope="session", autouse=True)
def _allow_unpinned_test_checkpoints():
    """Session-wide monkeypatch (undone at the end): pin set aside, development opt-in on.
    Production code is unchanged; tests/security/ checks the committed pin and the fail-closed default."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("RECOGNITION_ALLOW_UNPINNED", "1")
        mp.setattr(model_pin, "EXPECTED_SHA256", None)
        yield
    assert model_pin.EXPECTED_SHA256 == COMMITTED_PIN

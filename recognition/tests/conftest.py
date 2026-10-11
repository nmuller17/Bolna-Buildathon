"""Shared test setup.

recognition/model_pin.py pins the demo model's hash. The tests build their own small checkpoints, so every test
starts unpinned; the tests about pinning set EXPECTED_SHA256 themselves (monkeypatch), as before the freeze.
"""
import pytest

from recognition import model_pin

# Module- and session-scoped fixtures (the server tests build their app once) are created before any function
# fixture runs: unpin at import too.
model_pin.EXPECTED_SHA256 = None


@pytest.fixture(autouse=True)
def unpinned(monkeypatch):
    monkeypatch.setattr(model_pin, "EXPECTED_SHA256", None)

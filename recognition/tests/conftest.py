"""Shared pytest setup for recognition tests.

The loader fails closed while recognition/model_pin.py is None (red-team A1/C4). The tests build
their own throwaway checkpoints, so they opt in to the development mode for the whole session
(module-scoped fixtures load models too), exactly as a developer would with
RECOGNITION_ALLOW_UNPINNED=1. tests/security/ removes it again, per test, wherever it checks the
fail-closed behaviour.
"""
import os

import pytest


@pytest.fixture(scope="session", autouse=True)
def _allow_unpinned_test_checkpoints():
    old = os.environ.get("RECOGNITION_ALLOW_UNPINNED")
    os.environ["RECOGNITION_ALLOW_UNPINNED"] = "1"
    yield
    if old is None:
        os.environ.pop("RECOGNITION_ALLOW_UNPINNED", None)
    else:
        os.environ["RECOGNITION_ALLOW_UNPINNED"] = old

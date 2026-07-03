"""Unit tests for the VPS feature-check harness pure logic (E2 Phase 4).

The harness (scripts/feature_check.py) drives a live gateway, but its
event-classification + result-shaping logic is pure and testable offline.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

# scripts/ isn't a package — load the module by path under a unique name.
# The module MUST be registered in sys.modules before exec_module, or the
# @dataclass in it fails (dataclasses does sys.modules.get(cls.__module__)).
_PATH = (
    pathlib.Path(__file__).resolve().parents[2] / "scripts" / "feature_check.py"
)
_spec = importlib.util.spec_from_file_location("_cc_feature_check", str(_PATH))
assert _spec is not None and _spec.loader is not None
fc = importlib.util.module_from_spec(_spec)
sys.modules["_cc_feature_check"] = fc
_spec.loader.exec_module(fc)


def test_event_types_extracts_type_set():
    events = [
        {"type": "TEXT_MESSAGE_CONTENT", "delta": "hi"},
        {"type": "TOOL_CALL_START"},
        {"type": "RUN_FINISHED"},
        {"no_type": True},
    ]
    types = fc._event_types(events)
    assert "TEXT_MESSAGE_CONTENT" in types
    assert "RUN_FINISHED" in types
    assert "" in types  # the typeless event maps to ""


def test_check_result_defaults():
    r = fc.CheckResult("chat_maf", True)
    assert r.name == "chat_maf"
    assert r.ok is True
    assert r.run_id is None
    assert r.events == 0
    assert r.extra == {}


def test_registered_checks_present():
    # The four surfaces we sweep must all be wired.
    for name in ("health", "debug_api", "chat_maf", "chat_copilot"):
        assert name in fc._CHECKS

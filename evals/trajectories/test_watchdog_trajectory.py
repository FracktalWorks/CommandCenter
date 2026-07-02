"""Golden trajectories: the unified watchdog policy + loop detector.

Locks the watchdog VALUES + native tier-selection rule (previously scattered as
inline os.environ.get reads across three executor call sites) and the tool-loop
guard, so they can't drift silently. See orchestrator/watchdog.py.
"""
from __future__ import annotations

from orchestrator.watchdog import LoopDetector, WatchdogPolicy, default_watchdog


def test_idle_timeout_tier_selection_ordering():
    """HITL wins over tool-open wins over bare idle — the exact native rule."""
    p = WatchdogPolicy(idle=120, tool_open=600, hitl_pending=3600)
    assert p.idle_timeout(hitl_pending=False, tools_open=0) == 120
    assert p.idle_timeout(hitl_pending=False, tools_open=1) == 600
    assert p.idle_timeout(hitl_pending=False, tools_open=3) == 600
    # HITL pending takes priority even while a tool is also open.
    assert p.idle_timeout(hitl_pending=True, tools_open=1) == 3600
    assert p.idle_timeout(hitl_pending=True, tools_open=0) == 3600


def test_default_watchdog_reads_env(monkeypatch):
    # default_watchdog() reads the environment fresh on each call (no reload).
    monkeypatch.setenv("NATIVE_STREAM_IDLE_TIMEOUT_SECONDS", "45")
    monkeypatch.setenv("NATIVE_TOOL_IDLE_TIMEOUT_SECONDS", "300")
    monkeypatch.setenv("HITL_IDLE_TIMEOUT_SECONDS", "1800")
    monkeypatch.setenv("COPILOT_TOOL_TIMEOUT_SECONDS", "90")
    p = default_watchdog()
    assert (p.idle, p.tool_open, p.hitl_pending, p.tool_execution) == (
        45.0, 300.0, 1800.0, 90.0,
    )


def test_default_watchdog_falls_back_on_bad_env(monkeypatch):
    monkeypatch.setenv("NATIVE_STREAM_IDLE_TIMEOUT_SECONDS", "not-a-number")
    monkeypatch.delenv("HITL_IDLE_TIMEOUT_SECONDS", raising=False)
    p = default_watchdog()
    assert p.idle == 120.0        # invalid → default
    assert p.hitl_pending == 3600.0  # missing → default


def test_loop_detector_trips_on_identical_repeats():
    d = LoopDetector(max_repeats=3)
    # Same name + same args → trips on the 3rd.
    assert d.record("query_inbox", '{"account":"a1"}') is False
    assert d.record("query_inbox", '{"account":"a1"}') is False
    assert d.record("query_inbox", '{"account":"a1"}') is True


def test_loop_detector_ignores_distinct_args():
    d = LoopDetector(max_repeats=3)
    # Same tool, DIFFERENT args each time — a legitimate scan, never trips.
    for i in range(10):
        assert d.record("read_email", f'{{"id":{i}}}') is False


def test_loop_detector_separate_signatures_counted_independently():
    d = LoopDetector(max_repeats=2)
    assert d.record("a", "x") is False
    assert d.record("b", "y") is False   # different sig — own counter
    assert d.record("a", "x") is True    # 2nd 'a(x)' trips

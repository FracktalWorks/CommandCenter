"""Unit tests for the live activity bus (E2 live observability).

The bus (`acb_common.activity`) publishes one small event per agent run / model
call to a global Redis stream so the /observability feed can show activations in
real time. These tests cover the pure event-shaping + the best-effort,
non-blocking publish contract WITHOUT needing a live Redis (the Redis IO is
monkeypatched / exercised only on the no-loop swallow path).
"""
from __future__ import annotations

import asyncio

from acb_common import bind_run_context, clear_run_context, publish_activity
from acb_common.activity import _build_event

# ── Event shaping (pure) ─────────────────────────────────────────────────────

def test_build_event_inherits_run_context():
    # A model call inside an agent run inherits that run's attribution so the
    # feed can show WHO/WHICH-app triggered the model call.
    bind_run_context(run_id="r1", thread_id="t1", agent="sales",
                     user="u@x", source="email")
    try:
        evt = _build_event({"kind": "model", "model": "gpt-x", "tier": "2"})
    finally:
        clear_run_context()
    assert evt["kind"] == "model"
    assert evt["model"] == "gpt-x"
    assert evt["agent"] == "sales"
    assert evt["user"] == "u@x"
    assert evt["source"] == "email"
    assert evt["run_id"] == "r1"
    assert "ts" in evt  # always stamped


def test_build_event_explicit_fields_win_over_context():
    bind_run_context(agent="sales", source="chat")
    try:
        evt = _build_event({"kind": "agent", "agent": "triage", "source": "tasks"})
    finally:
        clear_run_context()
    assert evt["agent"] == "triage"
    assert evt["source"] == "tasks"


def test_build_event_drops_none_values():
    evt = _build_event({"kind": "model", "model": "m", "tier": None, "tokens": None})
    assert "tier" not in evt
    assert "tokens" not in evt


def test_source_is_bound_into_run_context():
    from acb_common import get_run_context
    bind_run_context(run_id="r2", agent="a", source="email")
    try:
        ctx = get_run_context()
        assert ctx["source"] == "email"
    finally:
        clear_run_context()
    # Cleared symmetrically — no leak into the next run.
    assert "source" not in get_run_context()


# ── Publish contract ─────────────────────────────────────────────────────────

def test_publish_schedules_write_on_the_running_loop(monkeypatch):
    recorded: list[dict] = []

    async def _fake_axadd(evt):
        recorded.append(evt)

    monkeypatch.setattr("acb_common.activity._axadd", _fake_axadd)

    async def _run():
        publish_activity(kind="agent", phase="start", agent="sales", run_id="r9")
        # Let the scheduled task run (create_task defers to the loop).
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(_run())
    assert recorded, "publish_activity should schedule a stream write"
    assert recorded[0]["kind"] == "agent"
    assert recorded[0]["phase"] == "start"
    assert recorded[0]["run_id"] == "r9"


def test_publish_never_raises_even_if_shaping_fails(monkeypatch):
    def _boom(_fields):
        raise RuntimeError("shape failed")

    monkeypatch.setattr("acb_common.activity._build_event", _boom)
    # Must swallow — a broken feed can never take down the run that emitted it.
    publish_activity(kind="model", model="x")


def test_publish_write_failure_is_swallowed(monkeypatch):
    async def _fake_axadd(_evt):
        raise ConnectionError("no redis")

    monkeypatch.setattr("acb_common.activity._axadd", _fake_axadd)

    async def _run():
        publish_activity(kind="model", model="x", tier="1")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    # The scheduled task raises internally; the done-callback retrieves the
    # exception so it never surfaces as an unhandled error.
    asyncio.run(_run())


# ── Cost rollup ──────────────────────────────────────────────────────────────

def test_split_field_parses_rollup_hash_fields():
    from acb_common.activity import _split_field
    assert _split_field("total|cost") == ("total", "", "cost")
    assert _split_field("total|tokens") == ("total", "", "tokens")
    # Provider-prefixed model names contain "/" but never "|".
    assert _split_field("model|deepseek/deepseek-chat|cost") == (
        "model", "deepseek/deepseek-chat", "cost")
    assert _split_field("source|email|calls") == ("source", "email", "calls")


def test_cost_summary_aggregates_daily_rollups(monkeypatch):
    from acb_common import activity

    today = activity._today()

    class _FakeRedis:
        async def hgetall(self, key):
            if key == activity._cost_key(today):
                return {
                    "total|cost": "0.5",
                    "total|tokens": "1500",
                    "total|calls": "3",
                    "model|gpt-4o-mini|cost": "0.2",
                    "model|gpt-4o-mini|tokens": "1000",
                    "model|gpt-4o-mini|calls": "2",
                    "model|deepseek/deepseek-chat|cost": "0.3",
                    "model|deepseek/deepseek-chat|calls": "1",
                    "source|email|cost": "0.2",
                    "source|chat|cost": "0.3",
                }
            return {}

    monkeypatch.setattr(activity, "_get_client", lambda: _FakeRedis())

    out = asyncio.run(activity.cost_summary(days=3))
    assert out["window_days"] == 3
    assert len(out["days"]) == 3
    assert out["days"][-1]["date"] == today          # newest last (chart L→R)
    assert out["days"][-1]["cost"] == 0.5
    assert out["totals"]["cost"] == 0.5
    assert out["totals"]["calls"] == 3
    assert out["by_model"]["gpt-4o-mini"]["cost"] == 0.2
    assert out["by_model"]["deepseek/deepseek-chat"]["calls"] == 1
    assert out["by_source"]["email"]["cost"] == 0.2
    assert out["by_source"]["chat"]["cost"] == 0.3


def test_cost_summary_empty_history_is_all_zero(monkeypatch):
    from acb_common import activity

    class _Empty:
        async def hgetall(self, key):
            return {}

    monkeypatch.setattr(activity, "_get_client", lambda: _Empty())
    out = asyncio.run(activity.cost_summary(days=7))
    assert out["totals"] == {"cost": 0.0, "tokens": 0, "calls": 0}
    assert out["by_model"] == {}

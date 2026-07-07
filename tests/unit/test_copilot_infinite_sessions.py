"""Regression tests for the Copilot infinite-session context-window fix.

Bug (2026-07-03, technical-project-planner run 5b8c5836): a Copilot-SDK agent on
DeepSeek-V4-Pro (real 1M context) hit a false "context length exceeded" on a
short, ~15-tool run. Root cause: the Copilot backend's infinite-session
auto-compaction keys its 0.80/0.95 thresholds to the model's context window, but
for our BYOK model it can't learn the real window (its list_models() talks to
api.githubcopilot.com, which has no entry for our gateway-routed model), so it
uses a small default and its 0.95 buffer-exhaustion guard blocks prematurely.

Fix: inject an ``infinite_sessions`` SessionConfig block that relaxes (or
disables) those guards. The agent-framework wrapper's ``_create_session`` drops
``infinite_sessions``, so we wrap it to merge our block into the config the
underlying ``client.create_session`` receives. These tests lock both the config
policy and the wrap plumbing.
"""
from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import orchestrator.executor as ex


# ---------------------------------------------------------------------------
# _copilot_infinite_session_config — env-driven policy
# ---------------------------------------------------------------------------

def test_relaxed_thresholds_by_default(monkeypatch) -> None:
    """With no env override, the block relaxes both thresholds (no early trip)."""
    for k in ("COPILOT_INFINITE_SESSIONS", "COPILOT_COMPACTION_THRESHOLD",
              "COPILOT_BUFFER_THRESHOLD"):
        monkeypatch.delenv(k, raising=False)
    cfg = ex._copilot_infinite_session_config()
    assert cfg is not None
    assert cfg["enabled"] is True
    # Relaxed well above the SDK's premature 0.80/0.95 defaults.
    assert cfg["background_compaction_threshold"] >= 0.90
    assert cfg["buffer_exhaustion_threshold"] >= 0.98


def test_off_disables_backend_compaction(monkeypatch) -> None:
    monkeypatch.setenv("COPILOT_INFINITE_SESSIONS", "off")
    cfg = ex._copilot_infinite_session_config()
    assert cfg == {"enabled": False}


def test_default_opts_out_leaving_sdk_defaults(monkeypatch) -> None:
    """`default` means 'don't touch the SDK's own defaults' → returns None."""
    monkeypatch.setenv("COPILOT_INFINITE_SESSIONS", "default")
    assert ex._copilot_infinite_session_config() is None


def test_custom_thresholds_from_env(monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    monkeypatch.setenv("COPILOT_COMPACTION_THRESHOLD", "0.5")
    monkeypatch.setenv("COPILOT_BUFFER_THRESHOLD", "0.7")
    cfg = ex._copilot_infinite_session_config()
    assert cfg["background_compaction_threshold"] == 0.5
    assert cfg["buffer_exhaustion_threshold"] == 0.7


def test_bad_threshold_falls_back_and_clamps(monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    monkeypatch.setenv("COPILOT_COMPACTION_THRESHOLD", "not-a-number")
    monkeypatch.setenv("COPILOT_BUFFER_THRESHOLD", "5.0")  # out of band → clamp to 1.0
    cfg = ex._copilot_infinite_session_config()
    assert 0.0 < cfg["background_compaction_threshold"] <= 1.0
    assert cfg["buffer_exhaustion_threshold"] == 1.0


# ---------------------------------------------------------------------------
# _apply_copilot_infinite_sessions — the wrap plumbing
# ---------------------------------------------------------------------------

class _FakeClient:
    """Stands in for the Copilot SDK client; records what create_session got."""
    def __init__(self) -> None:
        self.received_config: dict | None = None

    async def create_session(self, config: dict):
        self.received_config = config
        return MagicMock(session_id="sess-1")


class _FakeCopilotAgent:
    """Minimal shape mirroring the agent-framework Copilot agent: a _client and a
    _create_session that builds a fixed SessionConfig (dropping infinite_sessions,
    exactly like the real wrapper) and calls client.create_session."""
    def __init__(self, *, byok: bool = False) -> None:
        self._client = _FakeClient()
        # Mimic the BYOK provider dict set by _apply_byok_provider_for_copilot_sdk.
        self._default_options: dict = {
            "provider": {"type": "openai", "base_url": "http://gw/v1", "api_key": "k"}
        } if byok else {}

    async def _create_session(self, streaming: bool, runtime_options=None):
        # Mirrors the real _create_session: a FIXED key set, no infinite_sessions.
        config = {"streaming": streaming, "model": "tier-balanced"}
        return await self._client.create_session(config)


def test_wrap_injects_infinite_sessions_into_client_config(monkeypatch) -> None:
    """After the wrap, the config the CLIENT receives carries infinite_sessions —
    even though the agent's own _create_session never sets it."""
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    monkeypatch.delenv("COPILOT_COMPACTION_THRESHOLD", raising=False)
    monkeypatch.delenv("COPILOT_BUFFER_THRESHOLD", raising=False)

    agent = _FakeCopilotAgent()  # no provider → Copilot-native path
    applied = ex._apply_copilot_infinite_sessions(agent)
    assert applied is True
    assert getattr(agent, "__cc_inf_sessions__", False) is True

    asyncio.run(agent._create_session(True, None))
    cfg = agent._client.received_config
    assert cfg is not None
    assert "infinite_sessions" in cfg, "wrap must inject infinite_sessions"
    assert cfg["infinite_sessions"]["enabled"] is True
    assert cfg["infinite_sessions"]["buffer_exhaustion_threshold"] >= 0.98
    # Fixed keys preserved.
    assert cfg["model"] == "tier-balanced"

    # client.create_session restored to the original after the call (no leak).
    assert agent._client.create_session.__name__ == "create_session"


def test_byok_agent_disables_compaction(monkeypatch) -> None:
    """BYOK agent (provider set in _default_options) always gets enabled:False
    regardless of threshold env vars — the backend's wrong ~90K window estimate
    makes any threshold×90K useless against a 1M-window model."""
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    monkeypatch.delenv("COPILOT_COMPACTION_THRESHOLD", raising=False)
    monkeypatch.delenv("COPILOT_BUFFER_THRESHOLD", raising=False)

    agent = _FakeCopilotAgent(byok=True)
    applied = ex._apply_copilot_infinite_sessions(agent)
    assert applied is True

    asyncio.run(agent._create_session(True, None))
    cfg = agent._client.received_config
    assert cfg["infinite_sessions"] == {"enabled": False}, (
        "BYOK agent must disable backend compaction, not just relax thresholds"
    )


def test_byok_detection_at_call_time(monkeypatch) -> None:
    """Provider set AFTER the wrap (mirroring real execution order where
    _inject_agent_tools wraps _create_session before BYOK provider is applied)
    must still produce enabled:False at call time."""
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)

    agent = _FakeCopilotAgent()  # no provider yet
    ex._apply_copilot_infinite_sessions(agent)  # wrap applied before provider

    # Now simulate BYOK provider being set (as _apply_byok_provider_for_copilot_sdk does).
    agent._default_options["provider"] = {
        "type": "openai", "base_url": "http://gw/v1", "api_key": "k",
    }

    asyncio.run(agent._create_session(True, None))
    assert agent._client.received_config["infinite_sessions"] == {"enabled": False}, (
        "BYOK detected at call time even though wrap was applied before provider was set"
    )


def test_non_byok_uses_relaxed_thresholds(monkeypatch) -> None:
    """Copilot-native agent (no provider) uses relaxed thresholds, not disabled."""
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    monkeypatch.delenv("COPILOT_COMPACTION_THRESHOLD", raising=False)
    monkeypatch.delenv("COPILOT_BUFFER_THRESHOLD", raising=False)

    agent = _FakeCopilotAgent()  # no provider → native Copilot
    ex._apply_copilot_infinite_sessions(agent)

    asyncio.run(agent._create_session(True, None))
    inf = agent._client.received_config["infinite_sessions"]
    assert inf["enabled"] is True, "Copilot-native should keep compaction enabled"
    assert inf["background_compaction_threshold"] >= 0.90
    assert inf["buffer_exhaustion_threshold"] >= 0.98


def test_wrap_is_idempotent(monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_INFINITE_SESSIONS", raising=False)
    agent = _FakeCopilotAgent()
    assert ex._apply_copilot_infinite_sessions(agent) is True
    # Second application is a no-op (guard flag set).
    assert ex._apply_copilot_infinite_sessions(agent) is False


def test_wrap_noop_when_opted_out(monkeypatch) -> None:
    monkeypatch.setenv("COPILOT_INFINITE_SESSIONS", "default")
    agent = _FakeCopilotAgent()
    # Opted out → no wrap, no flag, original method intact.
    assert ex._apply_copilot_infinite_sessions(agent) is False
    assert getattr(agent, "__cc_inf_sessions__", False) is False


def test_off_flows_through_to_client(monkeypatch) -> None:
    monkeypatch.setenv("COPILOT_INFINITE_SESSIONS", "off")
    agent = _FakeCopilotAgent()
    assert ex._apply_copilot_infinite_sessions(agent) is True
    asyncio.run(agent._create_session(True, None))
    assert agent._client.received_config["infinite_sessions"] == {"enabled": False}

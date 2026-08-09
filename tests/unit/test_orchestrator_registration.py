"""The orchestrator is reachable through the named-agent path.

Spec: ``project-docs/specs/agent_architecture.md`` §11.1.1.

``apps/agents/agent-orchestrator/`` was written to "eliminate the separate
``/copilot/chat`` endpoint path in main.py and the ``isOrchestrator`` branching
in route.ts" — but it was never added to the registry, so
``_validate_agent_name("orchestrator")`` returned 422 and the wrapper was
unreachable. Deleting the frontend branch before fixing that would have broken
the default chat agent outright.

These tests lock the registration in, so the wrapper can't silently become
unreachable again before the frontend flip lands.
"""
from __future__ import annotations

from pathlib import Path

import pytest

routes_agent = pytest.importorskip(
    "gateway.routes.agent", reason="gateway not installed in this environment",
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _registry_entry(name: str) -> dict | None:
    return next(
        (e for e in routes_agent._AGENT_REGISTRY if e.get("name") == name), None,
    )


# ---------------------------------------------------------------------------
# Reachability — the regression
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["orchestrator", "agent-orchestrator", "ORCHESTRATOR"])
def test_orchestrator_passes_the_agent_allowlist(name: str) -> None:
    """The 422 that made the wrapper unreachable.

    ``_validate_agent_name`` accepts the bare name, the ``agent-`` prefixed form,
    and any casing — all three are shapes a caller or a stored session can carry.
    """
    assert routes_agent._validate_agent_name(name) == "orchestrator"


def test_orchestrator_is_registered() -> None:
    assert _registry_entry("orchestrator") is not None, (
        "orchestrator missing from _AGENT_REGISTRY — the named-agent path will "
        "422 and apps/agents/agent-orchestrator/ becomes unreachable again"
    )


def test_registry_entry_points_at_a_real_agent_directory() -> None:
    """The executor reads ``local_path`` from this entry to load the agent."""
    entry = _registry_entry("orchestrator")
    assert entry is not None
    agent_dir = REPO_ROOT / entry["local_path"]
    assert agent_dir.is_dir(), f"{entry['local_path']} does not exist"
    assert (agent_dir / "agents.py").is_file()
    assert (agent_dir / "config.json").is_file()


def test_orchestrator_is_declared_maf_not_copilot() -> None:
    """Labelling it github-copilot routes it through the Copilot SDK and 402s —
    the same trap called out on the email- and whatsapp-assistant entries."""
    entry = _registry_entry("orchestrator")
    assert entry is not None
    assert entry["agent_runtime"] == "maf"


# ---------------------------------------------------------------------------
# No self-delegation
# ---------------------------------------------------------------------------

def test_orchestrator_is_not_a_delegation_target_of_itself() -> None:
    """Registering it makes it visible to the specialist-tool loader.

    ``_load_specialist_agents_as_tools`` already skips it (``skip_names``), so
    registration cannot turn the router into a delegate of itself — assert that
    guard holds rather than trusting it.
    """
    orchestrator_agents = pytest.importorskip(
        "orchestrator.agents", reason="orchestrator not installed",
    )
    tools = orchestrator_agents._mod._load_specialist_agents_as_tools()
    names = {getattr(t, "name", "") for t in tools}
    assert "orchestrator" not in names
    assert names, "no specialist tools loaded at all — registry lookup broke"


# ---------------------------------------------------------------------------
# The wrapper actually builds
# ---------------------------------------------------------------------------

def test_wrapper_builds_one_native_maf_agent() -> None:
    """End to end: the thing the named-agent path would load."""
    agent_framework = pytest.importorskip("agent_framework")
    import importlib.util

    agents_py = REPO_ROOT / "apps" / "agents" / "agent-orchestrator" / "agents.py"
    if not agents_py.is_file():
        pytest.skip("agent-orchestrator not on disk")

    spec = importlib.util.spec_from_file_location("_probe_orchestrator", agents_py)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    built = module.build_agents()
    assert len(built) == 1
    agent = built[0]

    assert isinstance(agent, agent_framework.Agent)
    assert agent.name == "orchestrator"
    # A Copilot-SDK agent would carry _default_options; a native MAF one doesn't.
    assert not hasattr(agent, "_default_options")
    # Left unset so the executor injects the risk-aware handler (B6). Setting it
    # in a factory is exactly the bypass two agents shipped.
    assert getattr(agent, "_permission_handler", None) is None
    assert (agent.default_options or {}).get("tools"), "built with no tools"

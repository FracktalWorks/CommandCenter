"""Agent manifest — derivation, validation, and equivalence with today.

Spec: ``ai-company-brain/specs/agent_architecture.md``.

The manifest is introduced as a PARALLEL representation: it computes values the
platform currently derives from ``config.json`` plus hardcoded defaults, but is
not yet wired into the run path.  The load-bearing tests here are the
*equivalence* ones — they assert that adopting the manifest changes nothing for
any existing agent, which is what makes the later flip provable rather than
hopeful.

Two properties matter most:

1. ``resolve_tool_surface`` must match ``_tool_injection._resolve_injected_scope``
   for every first-party config, including its fail-open ``None`` case.
2. ``memory_scope`` for a legacy (no ``sharing`` block) agent must be the bare
   ``agent:<slug>`` key that ``scope_key(agent=...)`` produces today — otherwise
   adopting the manifest would silently re-partition live memory.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from acb_skills.manifest import (
    SHELL_TOOLS,
    AgentManifest,
    CapabilitySpec,
    SharingSpec,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = REPO_ROOT / "apps" / "agents"


def _first_party_configs() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    if not AGENTS_DIR.is_dir():
        return out
    for cfg_path in sorted(AGENTS_DIR.glob("*/config.json")):
        try:
            out.append((cfg_path.parent.name, json.loads(cfg_path.read_text("utf-8"))))
        except Exception:
            out.append((cfg_path.parent.name, {}))
    return out


FIRST_PARTY = _first_party_configs()


# ---------------------------------------------------------------------------
# Equivalence with the current platform
# ---------------------------------------------------------------------------

#: The real resolver the executor uses.  Imported rather than restated so this
#: is a genuine equivalence test — if ``_resolve_injected_scope`` ever changes,
#: these fail instead of drifting silently.
_orchestrator = pytest.importorskip(
    "orchestrator._tool_injection",
    reason="orchestrator not installed in this environment",
)
_resolve_injected_scope = _orchestrator._resolve_injected_scope
CORE_FLOOR = _orchestrator._CORE_STANDARD_TOOL_NAMES


@pytest.mark.skipif(not FIRST_PARTY, reason="no first-party agents on disk")
@pytest.mark.parametrize("dirname,cfg", FIRST_PARTY, ids=[d for d, _ in FIRST_PARTY])
def test_tool_surface_matches_injection_resolver(dirname: str, cfg: dict) -> None:
    """The manifest must resolve exactly what the executor injects today.

    This is the load-bearing equivalence check: it compares against the real
    ``_resolve_injected_scope``, so the manifest can take over this computation
    without any agent's tool surface changing by a single name.
    """
    m = AgentManifest.from_config(cfg, name=dirname)
    expected = _resolve_injected_scope(cfg.get("tool_scope"))
    actual = m.resolve_tool_surface(CORE_FLOOR)
    if expected is None:
        assert actual is None, f"{dirname}: manifest narrowed an open scope"
    else:
        assert actual == frozenset(expected), f"{dirname}: tool surface drifted"


def test_equivalence_holds_for_synthetic_scopes() -> None:
    """The parametrised test above only covers scopes our agents happen to use."""
    for scope in (None, [], ["ask_questions"], ["code_task", "web_search"]):
        m = AgentManifest.from_config({"name": "x", "tool_scope": scope}, name="x")
        expected = _resolve_injected_scope(scope)
        actual = m.resolve_tool_surface(CORE_FLOOR)
        assert (actual is None) == (expected is None)
        if expected is not None:
            assert actual == frozenset(expected)


@pytest.mark.skipif(not FIRST_PARTY, reason="no first-party agents on disk")
@pytest.mark.parametrize("dirname,cfg", FIRST_PARTY, ids=[d for d, _ in FIRST_PARTY])
def test_legacy_config_keeps_todays_memory_partition(dirname: str, cfg: dict) -> None:
    """A config with no ``sharing`` block must derive the bare agent scope.

    ``scope_key(agent="sales")`` -> ``"agent:sales"``.  If the manifest produced
    anything else for a legacy agent, adopting it would strand every memory that
    agent has already written.
    """
    m = AgentManifest.from_config(cfg, name=dirname)
    if m.legacy:
        assert m.sharing.instancing == "shared"
        assert m.memory_scope("anyone@fracktal.in") == f"agent:{m.slug}"
        assert m.blob_instance("anyone@fracktal.in") == ""


@pytest.mark.skipif(not FIRST_PARTY, reason="no first-party agents on disk")
@pytest.mark.parametrize("dirname,cfg", FIRST_PARTY, ids=[d for d, _ in FIRST_PARTY])
def test_first_party_manifests_are_valid(dirname: str, cfg: dict) -> None:
    m = AgentManifest.from_config(cfg, name=dirname)
    assert m.validate() == [], f"{dirname}: {m.validate()}"


#: Agents whose DECLARED instancing differs from the shared bucket they use
#: today.  Wiring the manifest into the memory/blob path re-partitions these —
#: their existing ``agent:<slug>`` memories and ``instance=''`` blob rows become
#: invisible to every instance, which is the quarantine problem in
#: ``memory_architecture.md`` §5 and ``agent_platform_hardening_2026-07.md`` H4.
#:
#: This list is a canary, not a config: changing it must be a deliberate edit
#: made together with the data migration, never a side effect of editing a
#: config.json.
PENDING_INSTANCE_MIGRATION = {
    "agent-app-builder",
    "agent-email-assistant",
    "agent-orchestrator",
    "agent-task-manager",
    "agent-whatsapp-assistant",
}


@pytest.mark.skipif(not FIRST_PARTY, reason="no first-party agents on disk")
def test_pending_instance_migrations_are_tracked() -> None:
    """Declaring non-shared instancing is inert until the manifest is wired in.

    The declaration is the decision; the data migration is the work.  This test
    exists so the gap between them stays visible rather than becoming a surprise
    for whoever flips the switch.
    """
    declared_non_shared = {
        dirname
        for dirname, cfg in FIRST_PARTY
        if AgentManifest.from_config(cfg, name=dirname).sharing.instancing != "shared"
    }
    assert declared_non_shared == PENDING_INSTANCE_MIGRATION, (
        "An agent's declared instancing changed. Adopting it re-partitions live "
        "memory and files — pair the change with a quarantine migration and "
        "update PENDING_INSTANCE_MIGRATION in the same commit."
    )


@pytest.mark.skipif(not FIRST_PARTY, reason="no first-party agents on disk")
@pytest.mark.parametrize("dirname,cfg", FIRST_PARTY, ids=[d for d, _ in FIRST_PARTY])
def test_declared_sharing_is_explicit(dirname: str, cfg: dict) -> None:
    """Every first-party agent states its own sharing model.

    An absent block still derives safely (``shared``, today's behaviour), but a
    silent default is how ``runtime`` became decorative — so first-party agents
    declare rather than inherit.
    """
    m = AgentManifest.from_config(cfg, name=dirname)
    assert not m.legacy, f"{dirname}: no sharing block declared"


# ---------------------------------------------------------------------------
# Instance keying
# ---------------------------------------------------------------------------

def test_personal_instancing_partitions_per_user() -> None:
    m = AgentManifest.from_config(
        {"name": "coach", "sharing": {"instancing": "personal", "visibility": "private"}},
        name="coach",
    )
    assert m.memory_scope("vijay@fracktal.in") == "agent:coach#u:vijay@fracktal.in"
    assert m.memory_scope("sanjay@fracktal.in") == "agent:coach#u:sanjay@fracktal.in"
    assert m.memory_scope("vijay@fracktal.in") != m.memory_scope("sanjay@fracktal.in")
    assert m.blob_instance("vijay@fracktal.in") == "u:vijay@fracktal.in"


def test_team_instancing_partitions_per_team() -> None:
    m = AgentManifest.from_config(
        {
            "name": "sales",
            "sharing": {"instancing": "team", "visibility": "team", "team": "sales"},
        },
        name="sales",
    )
    assert m.memory_scope("anyone@fracktal.in") == "agent:sales#t:sales"
    # Every member of the team resolves to the same partition.
    assert m.memory_scope("a@x.com") == m.memory_scope("b@x.com")


def test_shared_instancing_is_the_bare_key() -> None:
    m = AgentManifest.from_config(
        {"name": "reconciler", "sharing": {"instancing": "shared"}}, name="reconciler",
    )
    assert m.memory_scope("anyone@x.com") == "agent:reconciler"
    assert m.blob_instance("anyone@x.com") == ""


def test_memory_mode_none_keeps_no_compartment() -> None:
    m = AgentManifest.from_config(
        {"name": "formatter", "memory": {"mode": "none"}}, name="formatter",
    )
    assert m.memory_scope("anyone@x.com") is None


# ---------------------------------------------------------------------------
# Isolation tiers — hardening Part 1
# ---------------------------------------------------------------------------

def test_absent_tool_scope_is_container_tier() -> None:
    """No tool_scope means every tool is injected, including the shell ones."""
    m = AgentManifest.from_config({"name": "x"}, name="x")
    assert m.resolve_tool_surface() is None
    assert m.isolation_tier() == "T2"


@pytest.mark.parametrize("shell_tool", sorted(SHELL_TOOLS))
def test_any_shell_tool_forces_container_tier(shell_tool: str) -> None:
    m = AgentManifest.from_config(
        {"name": "x", "tool_scope": ["ask_questions", shell_tool]}, name="x",
    )
    assert m.isolation_tier() == "T2"


def test_read_only_surface_is_in_process() -> None:
    m = AgentManifest.from_config(
        {"name": "x", "tool_scope": ["ask_questions", "recall_notes"]}, name="x",
    )
    assert m.isolation_tier() == "T0"


def test_write_tools_or_integrations_are_confined_tier() -> None:
    writes = AgentManifest.from_config(
        {"name": "x", "tool_scope": ["ask_questions", "write_artifact"]}, name="x",
    )
    assert writes.isolation_tier() == "T1"

    integrated = AgentManifest.from_config(
        {"name": "y", "tool_scope": ["ask_questions"], "integrations": ["zoho-crm"]},
        name="y",
    )
    assert integrated.isolation_tier() == "T1"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def test_declarative_agent_must_declare_a_tool_scope() -> None:
    """Hardening C1: fail-open is tolerable for in-repo code, never for a
    creator-authored declarative agent."""
    m = AgentManifest.from_config({"name": "x", "kind": "declarative"}, name="x")
    assert any("tool_scope" in p for p in m.validate())

    ok = AgentManifest.from_config(
        {"name": "x", "kind": "declarative", "tool_scope": ["ask_questions"]}, name="x",
    )
    assert ok.validate() == []


def test_team_instancing_without_a_team_is_invalid() -> None:
    m = AgentManifest.from_config(
        {"name": "x", "sharing": {"instancing": "team"}}, name="x",
    )
    assert any("requires sharing.team" in p for p in m.validate())


def test_unknown_enum_values_are_reported() -> None:
    m = AgentManifest.from_config(
        {"name": "x", "sharing": {"instancing": "everyone"}}, name="x",
    )
    assert any("instancing" in p for p in m.validate())


def test_self_delegation_is_reported() -> None:
    m = AgentManifest.from_config(
        {"name": "sales", "agents": [{"slug": "sales", "mode": "call"}]}, name="sales",
    )
    assert any("itself" in p for p in m.validate())


def test_bad_delegation_mode_is_reported() -> None:
    m = AgentManifest.from_config(
        {"name": "a", "agents": [{"slug": "b", "mode": "teleport"}]}, name="a",
    )
    assert any("call|handoff|background" in p for p in m.validate())


def test_open_tool_scope_warns() -> None:
    m = AgentManifest.from_config({"name": "x"}, name="x")
    assert any("no tool_scope" in w for w in m.warnings())


def test_legacy_derivation_warns() -> None:
    m = AgentManifest.from_config({"name": "x", "tool_scope": ["a"]}, name="x")
    assert m.legacy is True
    assert any("no sharing block" in w for w in m.warnings())

    declared = AgentManifest.from_config(
        {"name": "x", "tool_scope": ["a"], "sharing": {"instancing": "shared"}}, name="x",
    )
    assert declared.legacy is False


# ---------------------------------------------------------------------------
# Shape
# ---------------------------------------------------------------------------

def test_from_config_tolerates_empty_and_none() -> None:
    for cfg in (None, {}):
        m = AgentManifest.from_config(cfg, name="x")
        assert m.slug == "x"
        assert isinstance(m.sharing, SharingSpec)
        assert isinstance(m.capabilities, CapabilitySpec)


def test_mcp_servers_dict_becomes_a_sorted_name_list() -> None:
    m = AgentManifest.from_config(
        {"name": "x", "mcp_servers": {"drawio": {}, "atlassian": {}}}, name="x",
    )
    assert m.capabilities.mcp_servers == ["atlassian", "drawio"]

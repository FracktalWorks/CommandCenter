"""Agent code and per-tenant state resolve to separate directories.

Spec: ai-company-brain/specs/agent_architecture.md §2

Two properties carry the whole design:

1. **``instance=''`` is byte-identical to today.** Asserted against the REAL
   ``_canonical_workspace_dir`` rather than a restatement of it, so the day
   someone changes that function this test fails instead of silently drifting.
   Every agent that has not declared ``sharing.instancing`` takes this path,
   which is what makes the change safe to land before anything is migrated.
2. **Distinct instances never share a directory.** Sharing one is precisely
   the leak the split exists to prevent, so it is tested including the cases
   where naive slugging would collide.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from acb_skills.agent_paths import (
    agent_code_dir,
    agent_state_dir,
    clone_root,
    instance_slug,
    state_root,
)


@pytest.fixture
def clone_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point acb_common settings at a temp clone root for the whole module."""
    from acb_common import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "agents_clone_dir", str(tmp_path), raising=False)
    get_settings.cache_clear() if hasattr(get_settings, "cache_clear") else None
    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    return tmp_path


# ---------------------------------------------------------------------------
# 1. The shared default is unchanged
# ---------------------------------------------------------------------------

def test_empty_instance_is_the_code_dir(clone_dir: Path) -> None:
    assert agent_state_dir("email-assistant") == agent_code_dir("email-assistant")
    assert agent_state_dir("email-assistant", "") == agent_code_dir("email-assistant")


def test_code_dir_is_the_loaders_clone_path(clone_dir: Path) -> None:
    assert agent_code_dir("task-manager") == clone_dir / "repos" / "task-manager"


def test_shared_path_matches_the_real_canonical_workspace_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The equivalence that makes this safe, proven against the live function.

    ``_canonical_workspace_dir`` is what the file browser, the artifact viewer
    and the never-run-agent fallback all use today. If ``agent_state_dir(a, '')``
    ever stops agreeing with it, agents that never opted in would silently move.
    """
    from acb_common import get_settings
    from gateway.routes.workspace import _canonical_workspace_dir

    settings = get_settings()
    monkeypatch.setattr(settings, "agents_clone_dir", str(tmp_path), raising=False)

    for name in ("email-assistant", "task-manager", "orchestrator", "agent-weird"):
        assert agent_state_dir(name, "") == _canonical_workspace_dir(name)


# ---------------------------------------------------------------------------
# 2. Instances are isolated
# ---------------------------------------------------------------------------

def test_two_people_get_two_directories(clone_dir: Path) -> None:
    alice = agent_state_dir("email-assistant", "u:alice@fracktal.in")
    bob = agent_state_dir("email-assistant", "u:bob@fracktal.in")
    assert alice != bob


def test_a_personal_dir_is_never_the_shared_dir(clone_dir: Path) -> None:
    """The failure that would reintroduce the leak wholesale."""
    shared = agent_state_dir("email-assistant", "")
    alice = agent_state_dir("email-assistant", "u:alice@fracktal.in")
    assert alice != shared
    assert shared not in alice.parents


def test_state_lives_outside_the_clone_root(clone_dir: Path) -> None:
    """``repos/`` is disposable — a re-clone or ``git clean`` must never be able
    to take a tenant's accumulated data with it."""
    alice = agent_state_dir("email-assistant", "u:alice@fracktal.in")
    assert clone_root() not in alice.parents
    assert state_root() in alice.parents


def test_agents_do_not_share_a_tenant_directory(clone_dir: Path) -> None:
    """Same person, two personal agents — separate workspaces."""
    key = "u:alice@fracktal.in"
    assert agent_state_dir("email-assistant", key) != agent_state_dir(
        "whatsapp-assistant", key,
    )


def test_team_instances_are_shared_within_the_team(clone_dir: Path) -> None:
    a = agent_state_dir("sales", "t:sales")
    b = agent_state_dir("sales", "t:sales")
    assert a == b
    assert a != agent_state_dir("sales", "t:support")


# ---------------------------------------------------------------------------
# Slugging — filesystem safety and collision resistance
# ---------------------------------------------------------------------------

def test_slug_drops_characters_that_break_filesystems() -> None:
    """':' is illegal in Windows filenames and awkward in shell paths."""
    slug = instance_slug("u:alice@fracktal.in")
    assert ":" not in slug
    assert "@" not in slug
    assert "/" not in slug
    assert "alice" in slug  # still greppable by eye


def test_slug_of_the_shared_key_is_empty() -> None:
    assert instance_slug("") == ""


def test_keys_that_sanitise_alike_still_differ() -> None:
    """Both sanitise to 'a_b_x.com'. Without the digest they would collide —
    and a collision here means two people sharing one workspace."""
    assert instance_slug("u:a+b@x.com") != instance_slug("u:a_b@x.com")


def test_long_keys_stay_distinct_after_truncation() -> None:
    """The readable part is truncated; the digest is over the full key, so two
    addresses differing only past the cutoff still get separate directories."""
    base = "u:" + "x" * 60
    assert instance_slug(base + "alice@fracktal.in") != instance_slug(
        base + "bob@fracktal.in",
    )


def test_slug_is_stable_across_calls() -> None:
    """It names a directory that must be found again on the next run."""
    key = "u:alice@fracktal.in"
    assert instance_slug(key) == instance_slug(key)


def test_slug_length_is_bounded(clone_dir: Path) -> None:
    """Filenames over 255 bytes fail on ext4."""
    assert len(instance_slug("u:" + "a" * 500 + "@example.com")) < 100


# ---------------------------------------------------------------------------
# The manifest supplies the key
# ---------------------------------------------------------------------------

def test_manifest_instance_key_feeds_the_path_resolver(clone_dir: Path) -> None:
    """No fixture couples these two modules, so assert they agree: whatever the
    manifest resolves has to be something ``agent_state_dir`` can key on."""
    from acb_skills.manifest import AgentManifest

    personal = AgentManifest.from_config(
        {"name": "email-assistant", "sharing": {"instancing": "personal"}},
        name="email-assistant",
    )
    shared = AgentManifest.from_config(
        {"name": "task-manager", "sharing": {"instancing": "shared"}},
        name="task-manager",
    )

    alice = agent_state_dir(
        "email-assistant", personal.instance_key("alice@fracktal.in"),
    )
    bob = agent_state_dir("email-assistant", personal.instance_key("bob@fracktal.in"))
    assert alice != bob

    # A shared agent resolves to '' for ANY actor, so it keeps the old path.
    assert agent_state_dir(
        "task-manager", shared.instance_key("alice@fracktal.in"),
    ) == agent_code_dir("task-manager")


def test_personal_agent_without_an_actor_falls_back_to_shared(clone_dir: Path) -> None:
    """A background/cron run has no acting user. It must land on the shared
    partition rather than inventing a private one nobody can reach again."""
    from acb_skills.manifest import AgentManifest

    personal = AgentManifest.from_config(
        {"name": "email-assistant", "sharing": {"instancing": "personal"}},
        name="email-assistant",
    )
    assert personal.instance_key(None) == ""
    assert agent_state_dir(
        "email-assistant", personal.instance_key(None),
    ) == agent_code_dir("email-assistant")

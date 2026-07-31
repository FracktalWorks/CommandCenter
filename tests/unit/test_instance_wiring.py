"""The instance key flows run path → disk → store, and back through the gateway.

Spec: ai-company-brain/specs/memory_architecture.md §5.3
      ai-company-brain/specs/agent_architecture.md §2

This is the flip that makes instancing real: migrations 132/133 partitioned
the store, ``agent_paths`` split the disk, and this wiring makes every seam
agree on ONE key per run. What is asserted here:

1. **The executor resolves the same key the manifest declares** — and only
   for a real email. Background runs and the legacy ``user_id='default'``
   must never mint a ``u:default`` partition nobody can reach again.
2. **Directory precedence is exact** — session override > instance >
   ``workspace_root`` > clone dir — and the shared key resolves the clone
   dir byte-identically (the no-regression guarantee for every agent that
   didn't opt in).
3. **A state directory can name its own partition** (the ``.cc-instance``
   marker), because the slug is one-way and "whoever is asking" is the wrong
   answer the moment a shared session lets someone open another member's
   workspace.
4. **The gateway resolves the viewer to the same directory the run used**,
   so the file manager, artifact viewer and email attachment flow all open
   the partition the member's runs write to.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# 1+2. Executor resolution
# ---------------------------------------------------------------------------

PERSONAL_CFG = {"name": "x", "sharing": {"instancing": "personal"}}
SHARED_CFG = {"name": "x", "sharing": {"instancing": "shared"}}


def test_executor_resolves_the_manifests_key() -> None:
    from orchestrator.executor import _resolve_agent_instance

    assert _resolve_agent_instance(
        PERSONAL_CFG, "email-assistant", "alice@fracktal.in",
    ) == "u:alice@fracktal.in"
    assert _resolve_agent_instance(
        SHARED_CFG, "task-manager", "alice@fracktal.in",
    ) == ""


@pytest.mark.parametrize("actor", ["", "default", "system", None])
def test_non_email_actors_resolve_to_the_shared_partition(actor) -> None:
    """A cron/webhook payload with no member, or the legacy 'default' user id,
    must not create a private bucket keyed to a non-identity."""
    from orchestrator.executor import _resolve_agent_instance

    assert _resolve_agent_instance(PERSONAL_CFG, "email-assistant", actor) == ""


def test_unparseable_config_means_shared() -> None:
    from orchestrator.executor import _resolve_agent_instance

    assert _resolve_agent_instance(
        {"sharing": {"instancing": ["not", "a", "string"]}},
        "x", "alice@fracktal.in",
    ) in ("", )


def test_directory_precedence_is_exact(tmp_path: Path, monkeypatch) -> None:
    """session override > instance > workspace_root > clone dir."""
    from orchestrator.executor import _resolve_effective_agent_dir

    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    clone = tmp_path / "repos" / "email-assistant"
    clone.mkdir(parents=True)
    external = tmp_path / "external"
    external.mkdir()
    cfg = {"workspace_root": str(external)}

    # Session override beats everything.
    assert _resolve_effective_agent_dir(
        clone, cfg, session_override="/x/session", instance="u:a@b.com",
    ) == "/x/session"
    # Instance beats workspace_root: a personal run must never land in a
    # shared external repo.
    inst = _resolve_effective_agent_dir(clone, cfg, instance="u:a@b.com")
    assert str(tmp_path / "state" / "email-assistant") in inst
    # workspace_root still wins for shared agents.
    assert _resolve_effective_agent_dir(clone, cfg) == str(external)
    # And the bare default is the clone dir, byte-identically.
    assert _resolve_effective_agent_dir(clone, {}) == str(clone)


def test_instanced_dir_is_created_and_stamped(tmp_path: Path, monkeypatch) -> None:
    from orchestrator.executor import _resolve_effective_agent_dir

    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    clone = tmp_path / "repos" / "email-assistant"
    clone.mkdir(parents=True)

    out = Path(_resolve_effective_agent_dir(clone, {}, instance="u:a@b.com"))
    assert out.is_dir()
    assert (out / ".cc-instance").read_text() == "u:a@b.com"


# ---------------------------------------------------------------------------
# 3. The marker round-trip
# ---------------------------------------------------------------------------

def test_workspace_blob_key_round_trips(tmp_path: Path, monkeypatch) -> None:
    from acb_skills.agent_paths import ensure_state_dir, workspace_blob_key

    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    d = ensure_state_dir("email-assistant", "u:alice@fracktal.in")
    assert workspace_blob_key(d) == ("email-assistant", "u:alice@fracktal.in")


def test_workspace_blob_key_for_a_clone_dir_is_the_old_rule(
    tmp_path: Path, monkeypatch,
) -> None:
    """Shared workspaces keep keying by basename — the pre-instance contract."""
    from acb_skills.agent_paths import workspace_blob_key

    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    clone = tmp_path / "repos" / "task-manager"
    clone.mkdir(parents=True)
    assert workspace_blob_key(clone) == ("task-manager", "")


def test_a_state_dir_missing_its_marker_degrades_to_shared(
    tmp_path: Path, monkeypatch,
) -> None:
    """A hand-made or damaged state dir must not crash the mirror; it falls
    back to the shared partition rather than guessing an identity."""
    from acb_skills.agent_paths import workspace_blob_key

    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    orphan = tmp_path / "state" / "email-assistant" / "mystery-dir"
    orphan.mkdir(parents=True)
    assert workspace_blob_key(orphan) == ("email-assistant", "")


# ---------------------------------------------------------------------------
# 4. Gateway viewer resolution
# ---------------------------------------------------------------------------

def _seed_clone(tmp_path: Path, name: str, instancing: str) -> Path:
    import json

    clone = tmp_path / "repos" / name
    clone.mkdir(parents=True)
    (clone / "config.json").write_text(
        json.dumps({"name": name, "sharing": {"instancing": instancing}}),
        encoding="utf-8",
    )
    return clone


@pytest.fixture
def gw(tmp_path: Path, monkeypatch):
    """Point BOTH the gateway's settings lookup and agent_paths at tmp."""
    from acb_common import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "agents_clone_dir", str(tmp_path), raising=False)
    monkeypatch.setattr(
        "acb_skills.agent_paths._configured_clone_dir", lambda: tmp_path,
    )
    return tmp_path


def test_gateway_resolves_the_viewers_partition(gw: Path) -> None:
    from gateway.routes.workspace import _agent_workspace_dir

    _seed_clone(gw, "email-assistant", "personal")

    alice = _agent_workspace_dir("email-assistant", "alice@fracktal.in")
    bob = _agent_workspace_dir("email-assistant", "bob@fracktal.in")
    nobody = _agent_workspace_dir("email-assistant")

    assert alice is not None and bob is not None and nobody is not None
    assert alice != bob
    assert nobody == gw / "repos" / "email-assistant"
    # The gateway's answer is the run path's answer — one directory per tenant.
    from acb_skills.agent_paths import agent_state_dir

    assert alice == agent_state_dir("email-assistant", "u:alice@fracktal.in")


def test_gateway_keeps_shared_agents_byte_identical(gw: Path) -> None:
    from gateway.routes.workspace import _agent_workspace_dir

    clone = _seed_clone(gw, "task-manager", "shared")
    assert _agent_workspace_dir("task-manager", "alice@fracktal.in") == clone
    assert _agent_workspace_dir("task-manager") == clone


def test_gateway_without_a_config_stays_shared(gw: Path) -> None:
    """A clone with no config.json (or none readable) is a legacy agent —
    resolution must not invent an instance for it."""
    from gateway.routes.workspace import _agent_workspace_dir

    clone = gw / "repos" / "mystery-agent"
    clone.mkdir(parents=True)
    assert _agent_workspace_dir("mystery-agent", "alice@fracktal.in") == clone


def test_mirror_key_follows_the_marker_not_the_asker(gw: Path) -> None:
    """The shared-session case: Bob opens a session whose workspace_path points
    at Alice's state dir. The mirror must key by the DIRECTORY's partition —
    Alice's — not re-derive from Bob."""
    from acb_skills.agent_paths import ensure_state_dir
    from gateway.routes.workspace import _blob_key_for_workspace

    d = ensure_state_dir("email-assistant", "u:alice@fracktal.in")
    assert _blob_key_for_workspace(d) == ("email-assistant", "u:alice@fracktal.in")

"""Where an agent's code lives, and where each tenant's state lives.

Spec: ai-company-brain/specs/agent_architecture.md §2
      ai-company-brain/specs/memory_architecture.md §5.3

THE PROBLEM THIS SOLVES
-----------------------
``{agents_clone_dir}/repos/{agent}/`` has always been one directory doing two
jobs::

    repos/email-assistant/
        agents.py, config.json, instructions.md   CODE  — versioned, identical
                                                          for every user
        agent-data/, inputs/, outputs/            STATE — mutable, and different
                                                          for every user

Those have opposite lifecycles. Code is replaced wholesale by a ``git pull``;
state must survive one. Code is the same for everyone; state is the thing that
must NOT be. Conflating them is why a personal agent could not get its own
workspace without also forking its source checkout, and why
:func:`acb_memory.blob_store.rehydrate_workspace` restoring into a shared
directory leaks one person's notes in front of the next person's run.

THE SPLIT
---------
::

    code   {agents_clone_dir}/repos/{agent}/            one per agent
    state  {agents_clone_dir}/repos/{agent}/            when instance == ''
           {agents_clone_dir}/state/{agent}/{slug}/     when instance != ''

``instance`` is the key migration 130 added to ``agent_blob``; this module is
the disk agreeing with the database. The vocabulary is the manifest's
(:meth:`acb_skills.manifest.AgentManifest.instance_key`): ``''`` shared,
``u:<email>`` personal, ``t:<team>`` team.

WHY ``instance=''`` RETURNS THE OLD PATH
----------------------------------------
Deliberately, and it is the whole safety argument. Every agent that has not
declared ``sharing.instancing`` resolves to ``''``, so
:func:`agent_state_dir` hands back *byte-identically* the path the loader,
the file browsers and the artifact viewer already use. Those agents cannot
regress, because nothing about them changed. Only an agent that explicitly
declares itself ``personal`` or ``team`` gets a new directory.

That the runtime tolerates "working directory is not the code directory" is
not a hope: ``config.json``'s ``workspace_root`` has always pointed agents at
external repos, and :func:`orchestrator.executor._resolve_effective_agent_dir`
has always honoured it.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

__all__ = [
    "agent_code_dir",
    "agent_state_dir",
    "clone_root",
    "instance_slug",
    "state_root",
]

# Anything outside this set is replaced in a slug. ':' (in ``u:``/``t:``) is
# illegal in Windows filenames and awkward in shell paths everywhere.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# Keep the readable part short enough that {slug} sits far inside the 255-byte
# filename limit even for a long team name or address. Collisions introduced by
# truncation are resolved by the digest, which is computed over the FULL key.
_SLUG_READABLE_MAX = 48


def _configured_clone_dir() -> Path:
    """The configured clone root, matching every other consumer's fallback."""
    from acb_common import get_settings  # noqa: PLC0415

    settings = get_settings()
    return Path(
        getattr(settings, "agents_clone_dir", str(Path.home() / ".acb" / "agents"))
    )


def clone_root() -> Path:
    """``{agents_clone_dir}/repos`` — where agent checkouts live."""
    return _configured_clone_dir() / "repos"


def state_root() -> Path:
    """``{agents_clone_dir}/state`` — where per-tenant workspaces live.

    A sibling of ``repos/`` rather than a child, so a ``git clean`` or a
    re-clone inside ``repos/`` can never take a tenant's data with it.
    """
    return _configured_clone_dir() / "state"


def instance_slug(instance: str) -> str:
    """A filesystem-safe, collision-free directory name for an instance key.

    ``"u:alice@fracktal.in"`` → ``"u_alice_fracktal.in-3f2a9c11"``

    Readable enough to debug by ``ls``, and suffixed with a digest of the FULL
    key so two instances can never share a directory — which matters because
    sharing one would be exactly the leak this module exists to prevent.
    Distinct keys that sanitise to the same string (``a+b@x.com`` and
    ``a_b@x.com``) still get distinct directories.
    """
    if not instance:
        return ""
    digest = hashlib.sha256(instance.encode("utf-8")).hexdigest()[:8]
    readable = _UNSAFE.sub("_", instance)[:_SLUG_READABLE_MAX].strip("._-")
    return f"{readable}-{digest}" if readable else digest


def agent_code_dir(agent_name: str) -> Path:
    """The agent's source checkout — shared by every user of the agent.

    Equals ``{agents_clone_dir}/repos/{agent_name}``, which is what
    ``loader.load_agent`` always clones to and what
    ``gateway.routes.workspace._canonical_workspace_dir`` already returns.
    """
    return clone_root() / agent_name


def agent_state_dir(agent_name: str, instance: str = "") -> Path:
    """The working directory for one tenant of *agent_name*.

    ``instance=""`` returns :func:`agent_code_dir` unchanged — see the module
    docstring. Any other key returns a private directory that holds only the
    three durable folders (``agent-data``/``inputs``/``outputs``, i.e.
    ``blob_store.STORE_FOLDERS``) and never any source.
    """
    if not instance:
        return agent_code_dir(agent_name)
    return state_root() / agent_name / instance_slug(instance)

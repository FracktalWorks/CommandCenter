"""Resident Agent Cache — clone once, pull on demand (CommandCenter v2).

Design change from original v2:
  Previously, every event triggered a full ``git clone`` (~2–5 s latency).
  Now repos are maintained as **persistent local clones** under
  ``{agents_clone_dir}/repos/{repo-name}/``.  On each ``load_agent`` call:

    1. If the clone does not exist → ``git clone`` (first use only).
    2. If it does exist → ``git pull --ff-only`` (fast, typically < 0.5 s).
    3. ``graph.py`` is imported with a **unique module name per run_id** so
       concurrent executions of the same agent never share Python module state.
    4. ``LoadedAgent.cleanup()`` removes only the sys.path injection and the
       in-memory module; the local clone is preserved for the next event.

Authentication — private repos (ADR-020):
  Primary:  ``GITHUB_TOKEN`` (PAT with ``repo`` scope) embedded in the clone
            URL and refreshed before every pull via ``git remote set-url``.
  Upgrade path (not yet active):  GitHub App (``GITHUB_APP_ID`` +
            ``GITHUB_APP_PRIVATE_KEY_PATH``) — short-lived installation tokens,
            scoped to the org.  Swap ``_get_auth_token()`` when ready.

Bot identity (ADR-021):
  Every local clone is configured with ``git config user.name`` /
  ``user.email`` from ``GITHUB_BOT_NAME`` / ``GITHUB_BOT_EMAIL``.
  This means any commit created inside the clone (by Self_Mutation_Node or
  eval scripts) carries the bot identity automatically.

Security note (ADR-020):
  Only repos under the configured ``github_org`` are ever cloned.  The
  ``agent`` field in an event payload is validated against an allowlist
  before this function is called.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

from acb_common import get_logger, get_settings

_log = get_logger("acb_skills.loader")


class AgentLoadError(Exception):
    """Raised when an agent or skill repo cannot be cloned or imported."""


# ---------------------------------------------------------------------------
# Persistent clone cache (module-level, lives for the process lifetime)
# ---------------------------------------------------------------------------

# Guards the _repo_locks dict itself (created lazily per repo name).
_cache_meta_lock = threading.Lock()
# Per-repo locks prevent concurrent clone/pull races for the same repo.
_repo_locks: dict[str, threading.Lock] = {}


def _get_repo_lock(repo_name: str) -> threading.Lock:
    with _cache_meta_lock:
        if repo_name not in _repo_locks:
            _repo_locks[repo_name] = threading.Lock()
        return _repo_locks[repo_name]


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def _build_github_url(org: str, repo: str, token: str | None) -> str:
    """Return an authenticated (or public) GitHub HTTPS clone URL."""
    if token:
        return f"https://x-token:{token}@github.com/{org}/{repo}.git"
    return f"https://github.com/{org}/{repo}.git"


# Environment passed to every git subprocess: suppresses credential popups and
# GUI password prompts (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never) so the
# process fails fast rather than hanging waiting for user input.
_GIT_ENV: dict[str, str] = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "echo",
    "GCM_INTERACTIVE": "never",
    "GCM_CREDENTIAL_STORE": "plaintext",
}


def _run_git(args: list[str], *, cwd: Path, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_GIT_ENV,
        timeout=timeout,
    )


def _clone_repo(url: str, dest: Path) -> None:
    """Full clone of *url* into *dest*.  Raises :class:`AgentLoadError` on failure."""
    # Remove a stale/partial directory that has no .git — git clone refuses to
    # clone into a non-empty directory, leaving agents in a broken state.
    if dest.exists() and not (dest / ".git").exists():
        import shutil
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "clone", url, str(dest)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_GIT_ENV,
        timeout=120,
    )
    if result.returncode != 0:
        raise AgentLoadError(
            f"git clone failed for {url.split('@')[-1]!r}:\n{result.stderr.strip()}"
        )
    # If the checked-out working tree is empty (e.g. the default branch is an
    # empty placeholder while all code lives on another branch), try to checkout
    # the first remote branch that has actual files.
    tracked = subprocess.run(
        ["git", "ls-files"], cwd=str(dest), capture_output=True, text=True, encoding="utf-8"
    )
    if not tracked.stdout.strip():
        branches_r = subprocess.run(
            ["git", "branch", "-r", "--sort=-committerdate"],
            cwd=str(dest), capture_output=True, text=True, encoding="utf-8",
        )
        for branch_line in branches_r.stdout.splitlines():
            branch = branch_line.strip()
            if "HEAD" in branch or not branch:
                continue
            co = subprocess.run(
                ["git", "checkout", branch, "--", "."],
                cwd=str(dest), capture_output=True, text=True, encoding="utf-8",
            )
            if co.returncode == 0:
                # Verify we actually got files
                verify = subprocess.run(
                    ["git", "ls-files"], cwd=str(dest), capture_output=True, text=True, encoding="utf-8"
                )
                if verify.stdout.strip():
                    _log.info("loader.fallback_branch", dest=dest.name, branch=branch)
                    break


def _configure_bot_identity(repo_dir: Path, settings: Any) -> None:
    """Set git user.name / user.email in the local clone to the bot identity."""
    bot_name: str = getattr(settings, "github_bot_name", "commandcenter-bot")
    bot_email: str = getattr(settings, "github_bot_email", "") or f"{bot_name}@users.noreply.github.com"
    _run_git(["config", "user.name", bot_name], cwd=repo_dir)
    _run_git(["config", "user.email", bot_email], cwd=repo_dir)


def _refresh_remote_auth(repo_dir: Path, org: str, repo_name: str, token: str | None) -> None:
    """Update the remote URL so short-lived or rotated tokens stay current."""
    url = _build_github_url(org, repo_name, token)
    _run_git(["remote", "set-url", "origin", url], cwd=repo_dir)


def _pull_latest(repo_dir: Path) -> None:
    """``git pull --ff-only`` — non-fatal on diverged histories (uses local state)."""
    result = _run_git(["pull", "--ff-only"], cwd=repo_dir, timeout=30)
    if result.returncode != 0:
        _log.warning(
            "loader.pull_failed",
            repo=repo_dir.name,
            stderr=result.stderr.strip()[:200],
            hint="Using cached clone; next merge may fix this.",
        )


def _sync_new_skills(agent_dir: Path, settings: Any) -> None:
    """Detect scripts in skills/*/scripts/ not yet referenced in agents.py and add wrappers.

    After each git pull, scans the agent repo for Python scripts that don't yet
    appear as tool functions in agents.py.  For each new script, injects an async
    subprocess wrapper and adds it to tools=[...].  Commits and pushes directly to
    the current branch so the update is live on the next run.

    Non-fatal — if agents.py doesn't exist, has no tools=[...], or the push fails,
    the loader continues normally; the sync will be retried on the next pull.
    """
    import re  # noqa: PLC0415

    agents_file = agent_dir / "agents.py"
    if not agents_file.exists():
        return

    current = agents_file.read_text(encoding="utf-8", errors="replace")

    # Discover scripts in skills/*/scripts/ whose stem doesn't appear in agents.py
    new_scripts: list[Path] = []
    for script in sorted(agent_dir.glob("skills/*/scripts/*.py")):
        if script.stem.startswith("_"):
            continue
        if script.stem not in current:
            new_scripts.append(script)

    if not new_scripts:
        return

    _log.info(
        "loader.auto_sync_new_skills",
        agent=agent_dir.name,
        new=[s.stem for s in new_scripts],
    )

    # Build async tool wrappers (subprocess pattern — safe for scripts with own deps)
    tool_defs: list[str] = []
    tool_names: list[str] = []
    for script in new_scripts:
        fn = re.sub(r"[^a-z0-9_]", "_", script.stem.lower())
        rel = script.relative_to(agent_dir).as_posix()
        skill_name = script.parent.parent.name
        tool_defs.append(
            f"\nasync def {fn}(*args: str) -> str:\n"
            f'    """Run {script.stem} ({skill_name}). Pass CLI args as strings."""\n'
            f"    import asyncio as _a, subprocess as _s, sys as _sys\n"
            f"    from pathlib import Path as _P\n"
            f"    _d = _P(__file__).parent.resolve()\n"
            f'    _cmd = [_sys.executable, str(_d / "{rel}")] + list(args)\n'
            f"    _r = await _a.to_thread(_s.run, _cmd, capture_output=True, text=True, cwd=str(_d))\n"
            f"    if _r.returncode != 0:\n"
            f"        raise RuntimeError(_r.stderr[:500] or \"Script exited non-zero\")\n"
            f"    return _r.stdout or \"(no output)\"\n"
        )
        tool_names.append(fn)

    # Insert new tool defs immediately before build_agents()
    marker = "\ndef build_agents("
    if marker not in current:
        return  # unexpected structure — skip silently

    auto_block = "\n# ── Auto-synced tools (added by CommandCenter) ──────────────────────────\n"
    auto_block += "".join(tool_defs)
    updated = current.replace(marker, auto_block + marker, 1)

    # Append new tool names to the tools=[...] list inside build_agents
    def _add_to_tools(m: re.Match) -> str:  # type: ignore[type-arg]
        inner = m.group(1).strip().rstrip(",")
        additions = ",\n            ".join(tool_names)
        sep = ",\n            " if inner else ""
        return f"tools=[{inner}{sep}{additions}]"

    updated = re.sub(r"tools=\[([^\]]*)\]", _add_to_tools, updated, count=1)

    agents_file.write_text(updated, encoding="utf-8")

    # Commit and push directly to the current branch
    bot_name: str = getattr(settings, "github_bot_name", "commandcenter-bot")
    bot_email: str = getattr(settings, "github_bot_email", "") or f"{bot_name}@users.noreply.github.com"
    _run_git(["config", "user.name", bot_name], cwd=agent_dir)
    _run_git(["config", "user.email", bot_email], cwd=agent_dir)
    _run_git(["add", "agents.py"], cwd=agent_dir)
    names_summary = ", ".join(s.stem for s in new_scripts[:5])
    if len(new_scripts) > 5:
        names_summary += f" (+{len(new_scripts) - 5} more)"
    commit_r = _run_git(
        ["commit", "-m",
         f"auto-sync: add {len(new_scripts)} new tool(s) to agents.py\n\nAdded: {names_summary}"],
        cwd=agent_dir,
        timeout=30,
    )
    if commit_r.returncode == 0:
        push_r = _run_git(["push", "origin", "HEAD"], cwd=agent_dir, timeout=30)
        if push_r.returncode != 0:
            _log.warning(
                "loader.auto_sync_push_failed",
                agent=agent_dir.name,
                stderr=push_r.stderr.strip()[:200],
            )
        else:
            _log.info(
                "loader.auto_sync_committed",
                agent=agent_dir.name,
                tools=tool_names,
            )
    else:
        # Nothing staged (e.g. git noticed no effective diff) — restore original
        _run_git(["checkout", "--", "agents.py"], cwd=agent_dir)


def _ensure_repo(
    repo_name: str,
    *,
    org: str,
    token: str | None,
    cache_root: Path,
    settings: Any,
    clone_as: str | None = None,
) -> Path:
    """Return a path to an up-to-date local clone of *org/repo_name*.

    Args:
        repo_name:  The GitHub repository name (e.g. ``"sales-prospector"``).
        clone_as:   Local folder name override. Defaults to *repo_name*.
                    Use this when the GitHub repo name differs from the logical
                    agent name — e.g. clone ``"sales-prospector"`` into the
                    ``"sales-prospector"`` folder even when the agent_name is
                    ``"sales-prospector"`` (no ``agent-`` prefix on GitHub).

    Thread-safe: a per-repo lock ensures only one thread clones/pulls at a time.
    All other concurrent callers wait and then reuse the refreshed clone.
    """
    local_name = clone_as or repo_name
    lock = _get_repo_lock(local_name)
    with lock:
        clone_dir = cache_root / local_name
        if clone_dir.exists() and (clone_dir / ".git").exists():
            # Already cloned — refresh auth token in remote URL, then pull
            _refresh_remote_auth(clone_dir, org, repo_name, token)
            _pull_latest(clone_dir)
        else:
            # First use — full clone
            _log.info("loader.clone_new", repo=repo_name, org=org, local=local_name)
            url = _build_github_url(org, repo_name, token)
            _clone_repo(url, clone_dir)
            _configure_bot_identity(clone_dir, settings)
        # After every pull/clone, auto-sync any new skill scripts into agents.py
        _sync_new_skills(clone_dir, settings)
        return clone_dir


# ---------------------------------------------------------------------------
# Module import helpers
# ---------------------------------------------------------------------------

def _import_module_file(agent_dir: Path, filename: str, *, module_name: str) -> Any:
    """Load *filename* from *agent_dir* as an isolated Python module named *module_name*."""
    module_file = agent_dir / filename
    if not module_file.exists():
        raise AgentLoadError(f"No {filename} found in {agent_dir}")

    spec = importlib.util.spec_from_file_location(module_name, module_file)
    if spec is None or spec.loader is None:
        raise AgentLoadError(f"importlib could not build a spec for {module_file}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module  # register so relative imports inside the file work
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except Exception as exc:
        del sys.modules[module_name]
        raise AgentLoadError(
            f"{filename} exec failed for module {module_name!r}: {exc}"
        ) from exc

    return module


def _import_graph_module(agent_dir: Path, *, module_name: str) -> Any:
    """Load ``graph.py`` from *agent_dir* (deprecated — prefer _import_module_file)."""
    return _import_module_file(agent_dir, "graph.py", module_name=module_name)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class LoadedAgent:
    """Holds a successfully loaded agent for the duration of a single run.

    Use as a context manager::

        with load_agent("task-manager", run_id=run_id) as agent:
            graph = agent.build_graph()
            ...
        # sys.path entries removed, module unregistered.
        # The local clone on disk is preserved for the next event.

    Attributes:
        agent_name:  Bare agent name, e.g. ``"task-manager"``.
        run_id:      Unique execution ID.
        agent_dir:   Path to the local clone of ``agent-{agent_name}``.
                     Pass this to Self_Mutation_Node so it can push PRs
                     directly from the existing authenticated clone.
        config:      Parsed ``config.json`` dict (empty dict if absent/unparseable).
    """

    def __init__(
        self,
        agent_name: str,
        run_id: str,
        agent_dir: Path,
        graph_module: Any,
        injected_paths: list[str],
        module_name: str,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.agent_name = agent_name
        self.run_id = run_id
        self.agent_dir = agent_dir  # exposed so mutation.py can push from here
        self.config: dict[str, Any] = config or {}
        self._graph_module = graph_module
        self._injected_paths = injected_paths
        self._module_name = module_name

    def build_agents(self) -> list[Any]:
        """Load ``agents.py`` and return its ``build_agents()`` result (MAF convention).

        Agent repos **must** export ``build_agents() -> list[Agent]`` in ``agents.py``.
        See ``_templates/agent-template/agents.py`` for the required structure.

        Raises:
            :class:`AgentLoadError` if ``agents.py`` is missing or does not export
            ``build_agents``.
        """
        agents_file = self.agent_dir / "agents.py"
        if not agents_file.exists():
            graph_file = self.agent_dir / "graph.py"
            if graph_file.exists():
                raise AgentLoadError(
                    f"Agent {self.agent_name!r} has graph.py but not agents.py. "
                    "This is a LangGraph-style agent that needs to be migrated. "
                    "Add agents.py exporting build_agents() -> list[Agent] using MAF. "
                    "See _templates/agent-template/agents.py for the required structure."
                )
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: no agents.py found in {self.agent_dir}. "
                "Agent repos must export build_agents() -> list[Agent] in agents.py."
            )

        module_name = f"_agent_{self.run_id.replace('-', '_')}_agents"
        agents_module = _import_module_file(
            self.agent_dir, "agents.py", module_name=module_name
        )
        if not hasattr(agents_module, "build_agents"):
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: agents.py must export a "
                "`build_agents()` function returning a list of MAF agents."
            )
        result = agents_module.build_agents()
        if not isinstance(result, list):
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: build_agents() must return a list, "
                f"got {type(result).__name__}."
            )
        return result

    def build_graph(self) -> Any:
        """Deprecated — load ``graph.py`` and return its StateGraph.

        New agent repos should use ``build_agents()`` instead.
        """
        if self._graph_module is None:
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: no graph.py (MAF agent — use build_agents() instead)."
            )
        if not hasattr(self._graph_module, "build_graph"):
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: graph.py must export a "
                "`build_graph()` function returning a StateGraph."
            )
        return self._graph_module.build_graph()

    def cleanup(self) -> None:
        """Remove injected sys.path entries and unregister the run module.

        Does NOT delete the local clone — it is reused by future events.
        """
        sys.modules.pop(self._module_name, None)
        for p in self._injected_paths:
            try:
                sys.path.remove(p)
            except ValueError:
                pass

    def __enter__(self) -> "LoadedAgent":
        return self

    def __exit__(self, *_: object) -> None:
        self.cleanup()


def load_agent(
    agent_name: str,
    *,
    run_id: str | None = None,
    repo_name: str | None = None,
    local_path: str | None = None,
) -> LoadedAgent:
    """Ensure the agent repo is up-to-date locally, then import its graph.

    On first call:  full ``git clone`` (~5–20 s depending on repo size).
    On subsequent calls:  ``git pull --ff-only`` (< 0.5 s typically).

    Args:
        agent_name: Bare agent name, e.g. ``"task-manager"``.
                    The repo resolved will be ``{github_org}/agent-{agent_name}``
                    unless *repo_name* overrides it.
        run_id:     Unique ID for this execution (auto-generated if ``None``).
                    Used only for the Python module name — the filesystem path
                    is *not* namespaced by run_id (it is shared across runs).
        repo_name:  Optional override for the GitHub repository name.
                    Use when the repo is not named ``agent-{agent_name}``
                    (e.g. ``repo_name="sales-prospector"`` for a repo that
                    lives at ``FracktalWorks/sales-prospector``).
        local_path: Absolute path to a local agent directory.  When supplied,
                    no git clone is performed — the directory is used as-is.
                    Takes priority over *repo_name*.  Useful during development
                    when the agent lives at e.g.
                    ``C:/Users/dev/Github/sales-prospector``.

    Returns:
        A :class:`LoadedAgent` context manager.

    Raises:
        :class:`AgentLoadError` if clone/pull or import fails.
    """
    settings = get_settings()
    run_id = run_id or str(uuid.uuid4())

    org: str = getattr(settings, "github_org", "FracktalWorks")
    token: str | None = _get_auth_token(settings)
    cache_root = Path(getattr(settings, "agents_clone_dir", "/tmp/acb_agents")) / "repos"

    # ── Local-path fast path ────────────────────────────────────────────────
    # When a local_path is registered (e.g. during local development) we skip
    # the entire git-clone machinery and use the directory directly.
    if local_path:
        agent_dir = Path(local_path)
        if not agent_dir.is_dir():
            raise AgentLoadError(
                f"local_path {local_path!r} does not exist or is not a directory."
            )
        config_path = agent_dir / "config.json"
        config: dict[str, Any] = {}
        skill_repos: list[str] = []
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text(encoding="utf-8", errors="replace"))
                skill_repos = config.get("skill_repos", [])
            except Exception as exc:  # noqa: BLE001
                _log.warning("loader.config_parse_error", agent=agent_name, error=str(exc))

        injected_paths: list[str] = []
        for skill_repo_name in skill_repos:
            skill_dir = _ensure_repo(
                skill_repo_name,
                org=org,
                token=token,
                cache_root=cache_root,
                settings=settings,
            )
            skill_src = skill_dir / "src"
            skill_path = str(skill_src if skill_src.exists() else skill_dir)
            sys.path.insert(0, skill_path)
            injected_paths.append(skill_path)

        agent_path = str(agent_dir)
        sys.path.insert(0, agent_path)
        injected_paths.append(agent_path)

        module_name = f"_agent_{run_id.replace('-', '_')}_graph"
        if (agent_dir / "agents.py").exists():
            graph_module: Any = None
        else:
            graph_module = _import_graph_module(agent_dir, module_name=module_name)
        _log.info("loader.agent_ready_local", agent=agent_name, run_id=run_id, path=local_path)
        return LoadedAgent(
            agent_name=agent_name,
            run_id=run_id,
            agent_dir=agent_dir,
            graph_module=graph_module,
            injected_paths=injected_paths,
            module_name=module_name,
            config=config,
        )

    # ── GitHub clone path ───────────────────────────────────────────────────

    # Resolve the GitHub repo name.
    # Priority: explicit kwarg → default "agent-{name}"
    agent_repo = repo_name or f"agent-{agent_name}"
    agent_dir = _ensure_repo(
        agent_repo,
        org=org,
        token=token,
        cache_root=cache_root,
        settings=settings,
        clone_as=agent_name,  # always cache under the logical agent name
    )

    # Read config.json → discover skill repos, declared integrations, and optional
    # repo_name override (allows repos not named "agent-{name}" to be loaded).
    config_path = agent_dir / "config.json"
    config: dict[str, Any] = {}
    skill_repos: list[str] = []
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8", errors="replace"))
            skill_repos = config.get("skill_repos", [])
        except Exception as exc:  # noqa: BLE001
            _log.warning("loader.config_parse_error", agent=agent_name, error=str(exc))

    injected_paths: list[str] = []

    # Ensure each skill repo is present and up-to-date
    for skill_repo_name in skill_repos:
        skill_dir = _ensure_repo(
            skill_repo_name,
            org=org,
            token=token,
            cache_root=cache_root,
            settings=settings,
        )
        skill_src = skill_dir / "src"
        skill_path = str(skill_src if skill_src.exists() else skill_dir)
        sys.path.insert(0, skill_path)
        injected_paths.append(skill_path)

    # Inject agent repo path
    agent_path = str(agent_dir)
    sys.path.insert(0, agent_path)
    injected_paths.append(agent_path)

    # Import graph.py with a unique module name per run_id
    # (concurrent runs of the same agent each get their own Python module object)
    # MAF agents use agents.py (not graph.py) — skip the graph import if agents.py exists.
    # The repo may contain both files (old graph.py + new agents.py during migration);
    # agents.py always wins when present.
    module_name = f"_agent_{run_id.replace('-', '_')}_graph"
    agents_file = agent_dir / "agents.py"
    if agents_file.exists():
        # MAF agent repo — graph_module is unused; build_agents() handles import.
        graph_module: Any = None
    else:
        graph_module = _import_graph_module(agent_dir, module_name=module_name)

    _log.info(
        "loader.agent_ready",
        agent=agent_name,
        run_id=run_id,
        skills=skill_repos,
        agent_dir=str(agent_dir),
    )

    return LoadedAgent(
        agent_name=agent_name,
        run_id=run_id,
        agent_dir=agent_dir,
        graph_module=graph_module,
        injected_paths=injected_paths,
        module_name=module_name,
        config=config,
    )


# ---------------------------------------------------------------------------
# Auth token resolution — swap body of _get_auth_token() to enable GitHub App
# ---------------------------------------------------------------------------

def _get_auth_token(settings: Any) -> str | None:
    """Resolve the best available auth token for GitHub operations.

    Current strategy: PAT from ``GITHUB_TOKEN`` env var.

    Upgrade path — GitHub App (short-lived, scoped tokens):
      1. Set ``GITHUB_APP_ID``, ``GITHUB_APP_PRIVATE_KEY_PATH``,
         ``GITHUB_INSTALLATION_ID`` in .env.
      2. Replace the body of this function with::

             return _get_github_app_token(settings)

      where ``_get_github_app_token`` generates a JWT, exchanges it for an
      installation access token via the GitHub Apps API, and caches the token
      until it expires (tokens are valid for 1 hour).
    """
    return getattr(settings, "github_token", None) or None

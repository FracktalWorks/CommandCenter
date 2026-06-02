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


def _run_git(args: list[str], *, cwd: Path, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _clone_repo(url: str, dest: Path) -> None:
    """Full clone of *url* into *dest*.  Raises :class:`AgentLoadError` on failure."""
    dest.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "clone", url, str(dest)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise AgentLoadError(
            f"git clone failed for {url.split('@')[-1]!r}:\n{result.stderr.strip()}"
        )


def _configure_bot_identity(repo_dir: Path, settings: Any) -> None:
    """Set git user.name / user.email in the local clone to the bot identity."""
    bot_name: str = getattr(settings, "github_bot_name", "jannet-bot")
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


def _ensure_repo(
    repo_name: str,
    *,
    org: str,
    token: str | None,
    cache_root: Path,
    settings: Any,
) -> Path:
    """Return a path to an up-to-date local clone of *org/repo_name*.

    Thread-safe: a per-repo lock ensures only one thread clones/pulls at a time.
    All other concurrent callers wait and then reuse the refreshed clone.
    """
    lock = _get_repo_lock(repo_name)
    with lock:
        clone_dir = cache_root / repo_name
        if clone_dir.exists() and (clone_dir / ".git").exists():
            # Already cloned — refresh auth token in remote URL, then pull
            _refresh_remote_auth(clone_dir, org, repo_name, token)
            _pull_latest(clone_dir)
        else:
            # First use — full clone
            _log.info("loader.clone_new", repo=repo_name, org=org)
            url = _build_github_url(org, repo_name, token)
            _clone_repo(url, clone_dir)
            _configure_bot_identity(clone_dir, settings)
        return clone_dir


# ---------------------------------------------------------------------------
# Module import helpers
# ---------------------------------------------------------------------------

def _import_graph_module(agent_dir: Path, *, module_name: str) -> Any:
    """Load ``graph.py`` from *agent_dir* as an isolated module named *module_name*."""
    graph_file = agent_dir / "graph.py"
    if not graph_file.exists():
        raise AgentLoadError(f"No graph.py found in {agent_dir}")

    spec = importlib.util.spec_from_file_location(module_name, graph_file)
    if spec is None or spec.loader is None:
        raise AgentLoadError(f"importlib could not build a spec for {graph_file}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module  # register so relative imports inside graph.py work
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except Exception as exc:
        del sys.modules[module_name]
        raise AgentLoadError(
            f"graph.py exec failed for module {module_name!r}: {exc}"
        ) from exc

    return module


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
    """

    def __init__(
        self,
        agent_name: str,
        run_id: str,
        agent_dir: Path,
        graph_module: Any,
        injected_paths: list[str],
        module_name: str,
    ) -> None:
        self.agent_name = agent_name
        self.run_id = run_id
        self.agent_dir = agent_dir  # exposed so mutation.py can push from here
        self._graph_module = graph_module
        self._injected_paths = injected_paths
        self._module_name = module_name

    def build_graph(self) -> Any:
        """Return the agent's StateGraph (not yet compiled).

        The agent's ``graph.py`` **must** export a zero-argument ``build_graph``
        function.  The executor compiles it with a ``PostgresSaver`` checkpointer.
        """
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


def load_agent(agent_name: str, *, run_id: str | None = None) -> LoadedAgent:
    """Ensure the agent repo is up-to-date locally, then import its graph.

    On first call:  full ``git clone`` (~5–20 s depending on repo size).
    On subsequent calls:  ``git pull --ff-only`` (< 0.5 s typically).

    Args:
        agent_name: Bare agent name, e.g. ``"task-manager"``.
                    The repo resolved will be ``{github_org}/agent-{agent_name}``.
        run_id:     Unique ID for this execution (auto-generated if ``None``).
                    Used only for the Python module name — the filesystem path
                    is *not* namespaced by run_id (it is shared across runs).

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

    agent_repo = f"agent-{agent_name}"
    agent_dir = _ensure_repo(
        agent_repo, org=org, token=token, cache_root=cache_root, settings=settings
    )

    # Read config.json → discover skill repos
    config_path = agent_dir / "config.json"
    skill_repos: list[str] = []
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
            skill_repos = config.get("skill_repos", [])
        except Exception as exc:  # noqa: BLE001
            _log.warning("loader.config_parse_error", agent=agent_name, error=str(exc))

    injected_paths: list[str] = []

    # Ensure each skill repo is present and up-to-date
    for skill_repo_name in skill_repos:
        skill_dir = _ensure_repo(
            skill_repo_name, org=org, token=token, cache_root=cache_root, settings=settings
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
    module_name = f"_agent_{run_id.replace('-', '_')}_graph"
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

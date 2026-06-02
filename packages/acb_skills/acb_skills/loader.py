"""Dynamic Agent Loader — the core of CommandCenter v2.

At event time (not server startup) this module:

1. Clones the target ``agent-<name>`` repo from GitHub.
2. Reads ``config.json`` and clones each declared ``skill-<name>`` repo.
3. Injects cloned paths into ``sys.path`` for the duration of the run.
4. Imports ``graph.py`` via ``importlib`` (isolated module name per run).
5. Returns a :class:`LoadedAgent` context manager that cleans up on exit.

Why runtime cloning instead of baking agents into the Core image?
  Each agent repo is independently versioned.  A merged PR in ``agent-task-manager``
  should be picked up on the very next event — without restarting the Core server.
  Dynamic loading is the only way to achieve zero-redeploy agent updates.

Security note (ADR-020):
  Only repos under the configured ``github_org`` are ever cloned.  The ``agent``
  field in an event payload is validated against an allowlist before this function
  is called.  Never pass arbitrary user-supplied repo URLs here.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from acb_common import get_logger, get_settings

_log = get_logger("acb_skills.loader")


class AgentLoadError(Exception):
    """Raised when an agent or skill repo cannot be cloned or imported."""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_github_url(org: str, repo: str, token: str | None) -> str:
    """Return an authenticated (or public) GitHub HTTPS clone URL."""
    if token:
        return f"https://x-token:{token}@github.com/{org}/{repo}.git"
    return f"https://github.com/{org}/{repo}.git"


def _clone_repo(url: str, dest: Path, *, depth: int = 1) -> None:
    """Shallow-clone *url* into *dest*.  Raises :class:`AgentLoadError` on failure."""
    cmd = ["git", "clone", "--depth", str(depth), url, str(dest)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AgentLoadError(
            f"git clone failed for {url.split('@')[-1]!r}:\n{result.stderr.strip()}"
        )


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
    """Holds a successfully loaded agent and manages its lifecycle.

    Use as a context manager::

        with load_agent("task-manager") as agent:
            graph = agent.build_graph()
            ...
        # sys.path restored, clone directory removed
    """

    def __init__(
        self,
        agent_name: str,
        run_id: str,
        run_dir: Path,
        graph_module: Any,
        injected_paths: list[str],
        module_name: str,
    ) -> None:
        self.agent_name = agent_name
        self.run_id = run_id
        self.run_dir = run_dir
        self._graph_module = graph_module
        self._injected_paths = injected_paths
        self._module_name = module_name

    # -- StateGraph factory --------------------------------------------------

    def build_graph(self) -> Any:
        """Call the agent's ``build_graph()`` factory to get a compiled StateGraph.

        The agent's ``graph.py`` **must** export a zero-argument ``build_graph``
        function that returns a LangGraph ``StateGraph`` (not yet compiled).
        The executor compiles it with a ``PostgresSaver`` checkpointer.
        """
        if not hasattr(self._graph_module, "build_graph"):
            raise AgentLoadError(
                f"Agent {self.agent_name!r}: graph.py must export a "
                "`build_graph()` function returning a StateGraph."
            )
        return self._graph_module.build_graph()

    # -- Lifecycle -----------------------------------------------------------

    def cleanup(self) -> None:
        """Remove injected ``sys.path`` entries, unregister the module, and delete clones."""
        # Unregister the isolated module
        sys.modules.pop(self._module_name, None)

        # Remove injected path entries
        for p in self._injected_paths:
            try:
                sys.path.remove(p)
            except ValueError:
                pass

        # Delete the transient clone directory
        try:
            shutil.rmtree(self.run_dir, ignore_errors=True)
        except Exception as exc:  # noqa: BLE001
            _log.warning("loader.cleanup_failed", run_id=self.run_id, error=str(exc))

    def __enter__(self) -> "LoadedAgent":
        return self

    def __exit__(self, *_: object) -> None:
        self.cleanup()


def load_agent(agent_name: str, *, run_id: str | None = None) -> LoadedAgent:
    """Clone, path-inject, and import a named agent repo.

    Args:
        agent_name: Bare agent name, e.g. ``"task-manager"``.
                    The repo cloned will be ``agent-{agent_name}``.
        run_id:     Unique ID for this execution (auto-generated if ``None``).
                    Used to namespace the clone directory and the module name
                    so concurrent runs of the same agent do not collide.

    Returns:
        A :class:`LoadedAgent` that acts as a context manager.
        Call ``agent.build_graph()`` inside the ``with`` block.

    Raises:
        :class:`AgentLoadError` if cloning or import fails.
    """
    settings = get_settings()
    run_id = run_id or str(uuid.uuid4())
    org: str = getattr(settings, "github_org", "FracktalWorks")
    token: str | None = getattr(settings, "github_token", None) or None
    clone_base = Path(getattr(settings, "agents_clone_dir", "/tmp/acb_agents"))

    run_dir = clone_base / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    agent_repo = f"agent-{agent_name}"
    agent_dir = run_dir / "agent"

    _log.info("loader.clone_agent", agent=agent_repo, run_id=run_id, org=org)
    _clone_repo(_build_github_url(org, agent_repo, token), agent_dir)

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

    # Clone + inject each skill repo
    for skill_repo_name in skill_repos:
        skill_dir = run_dir / "skills" / skill_repo_name
        _log.info("loader.clone_skill", skill=skill_repo_name, run_id=run_id)
        _clone_repo(_build_github_url(org, skill_repo_name, token), skill_dir)

        # Skills are pip packages: prefer src/ layout, fall back to repo root
        skill_src = skill_dir / "src"
        skill_path = str(skill_src if skill_src.exists() else skill_dir)
        sys.path.insert(0, skill_path)
        injected_paths.append(skill_path)

    # Inject agent repo path
    agent_path = str(agent_dir)
    sys.path.insert(0, agent_path)
    injected_paths.append(agent_path)

    # Import graph.py with a unique module name (avoids cross-run cache collisions)
    module_name = f"_agent_{run_id.replace('-', '_')}_graph"
    graph_module = _import_graph_module(agent_dir, module_name=module_name)

    _log.info(
        "loader.agent_loaded",
        agent=agent_name,
        run_id=run_id,
        skills=skill_repos,
    )

    return LoadedAgent(
        agent_name=agent_name,
        run_id=run_id,
        run_dir=run_dir,
        graph_module=graph_module,
        injected_paths=injected_paths,
        module_name=module_name,
    )

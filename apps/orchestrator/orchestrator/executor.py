"""Agent executor — runs a dynamically loaded agent's MAF agent list.

Flow (ADR-013, ADR-016, ADR-018, WBS 0.7):

1. Delegate to :func:`load_agent` to clone repos + import ``agents.py``.
2. Call ``loaded.build_agents()`` to get the agent's MAF ``list[Agent]``.
3. Run ``_run_with_maf_agent`` — calls ``agents[0].run(message)`` via MAF.
   No PostgresSaver / LangGraph checkpointer needed; MAF AgentSession is
   in-memory for background runs; RedisHistoryProvider handles chat persistence.
4. On any unhandled exception, call :func:`~orchestrator.mutation.attempt_self_mutation`
   (ADR-006, ADR-021) which enforces ``max_mutation_attempts = 1``.
5. Cleanup happens in the :class:`~acb_skills.loader.LoadedAgent` context manager.

Usage::

    from orchestrator.executor import run_agent, run_agent_stream

    # Batch (existing):
    result = await run_agent("task-manager", {"clickup_event": {...}})

    # Streaming SSE (new — for /agent/run/stream endpoint):
    async for line in run_agent_stream("task-manager", payload, run_id=..., thread_id=...):
        yield line  # each line is a complete "data: {...}\\n\\n" SSE frame
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings
from acb_skills.integrations import build_integrations
from acb_skills.loader import AgentLoadError, load_agent

# Max self-anneal retries before giving up and falling back to LLM recovery.
_MAX_ANNEAL_ATTEMPTS = 2

_log = get_logger("orchestrator.executor")

# ContextVar that holds the active SSE queue for the current agent run.
# Set by run_agent_stream so that call_agent (injected as a tool) can push
# SUB_AGENT_* events into the parent stream, making sub-agent progress visible
# in the UI in real time.
_active_run_queue: contextvars.ContextVar["asyncio.Queue[dict[str, Any] | None] | None"] = (
    contextvars.ContextVar("_active_run_queue", default=None)
)

# ContextVar that holds the current thread_id for stream relay tee-ing.
# When set, every _sse() call automatically pushes the event to Redis Stream
# so the reconnect endpoint can replay missed events after a disconnect.
_stream_relay_thread_id: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("_stream_relay_thread_id", default=None)
)


async def _push_sse_to_stream(thread_id: str, sse_line: str) -> None:
    """Push an SSE line to the Redis stream for reconnection support.

    Best-effort: failures are silently swallowed so the SSE stream is never
    interrupted by Redis issues.
    """
    try:
        from orchestrator.stream_relay import push_sse_event  # noqa: PLC0415
        await push_sse_event(thread_id, sse_line)
    except Exception:  # noqa: BLE001
        pass


# Per-thread chains of in-flight Redis pushes.  Each new push awaits the
# previous one so events land in Redis in EXACT emission order (bare
# fire-and-forget create_task calls can interleave under load).
_push_chains: dict[str, "asyncio.Task[None]"] = {}


def _tee_sse_line(line: str) -> None:
    """Schedule an ordered, best-effort push of an SSE line to the Redis
    stream for the current relay thread (no-op when relay is unset)."""
    tid = _stream_relay_thread_id.get(None)
    if tid is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # No running event loop — skip relay
    prev = _push_chains.get(tid)

    async def _chained() -> None:
        if prev is not None:
            try:
                await prev
            except Exception:  # noqa: BLE001
                pass
        await _push_sse_to_stream(tid, line)

    task = loop.create_task(_chained())
    _push_chains[tid] = task
    task.add_done_callback(
        lambda t, _tid=tid: (
            _push_chains.pop(_tid, None)
            if _push_chains.get(_tid) is t
            else None
        )
    )


# ── Todo-list tracking (VS Code Copilot parity) ────────────────────────────
# The Copilot CLI manages the agent's plan via its built-in `sql` tool
# against a `todos` table (INSERT INTO todos ... / UPDATE todos SET status).
# VS Code renders its Todos panel by tracking those mutations; we do the
# same: parse the SQL in TOOL_CALL args and emit structured TODO_LIST
# events the frontend can render.

_TODO_INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+todos\b.*?VALUES\s*(.+)",
    re.I | re.S,
)
_TODO_ROW_RE = re.compile(
    r"\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,"
    r"\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)",
    re.S,
)
_TODO_UPDATE_RE = re.compile(
    r"UPDATE\s+todos\s+SET\s+status\s*=\s*'([^']+)'"
    r"(?:.*?WHERE\s+id\s*(?:=\s*'([^']+)'|IN\s*\(([^)]+)\)))?",
    re.I | re.S,
)


class _TodoTracker:
    """Accumulates todo state from the CLI's sql-tool mutations."""

    def __init__(self) -> None:
        self.items: dict[str, dict[str, str]] = {}
        self.order: list[str] = []

    def feed(self, tool_name: str, args: Any) -> bool:
        """Parse a tool call; return True if todo state changed."""
        if tool_name != "sql":
            return False
        query = ""
        if isinstance(args, dict):
            query = str(args.get("query") or "")
        elif isinstance(args, str):
            try:
                query = str(json.loads(args).get("query") or "")
            except (json.JSONDecodeError, AttributeError):
                query = args
        if "todos" not in query.lower():
            return False
        changed = False
        m = _TODO_INSERT_RE.search(query)
        if m:
            for row in _TODO_ROW_RE.finditer(m.group(1)):
                tid, title, _desc, status = (
                    v.replace("''", "'") for v in row.groups()
                )
                if tid not in self.items:
                    self.order.append(tid)
                self.items[tid] = {"id": tid, "title": title,
                                   "status": status or "pending"}
                changed = True
        for m in _TODO_UPDATE_RE.finditer(query):
            status, single_id, in_list = m.groups()
            ids: list[str] = []
            if single_id:
                ids = [single_id]
            elif in_list:
                ids = [s.strip().strip("'") for s in in_list.split(",")]
            else:
                ids = list(self.order)  # UPDATE without WHERE = all
            for tid in ids:
                if tid in self.items:
                    self.items[tid]["status"] = status
                    changed = True
        return changed

    def snapshot(self) -> list[dict[str, str]]:
        return [self.items[tid] for tid in self.order if tid in self.items]


def _build_injected_tools_addendum() -> str:
    """Return a system-prompt addendum describing the CommandCenter-injected tools.

    Appended to every GitHub Copilot agent's system message at run time so the
    LLM knows the injected tools exist, when to use them, and what valid agent
    names are.  MAF agents receive these instructions via the MAF instructions
    field directly; this is only needed for the Copilot SDK path where the agent's
    own ``instructions.md`` was written without knowledge of CommandCenter injection.
    """
    # Fetch the live agent registry so the model sees the exact names.
    agent_lines: list[str] = []
    try:
        from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
        from gateway.routes.agent import _load_dynamic_agents
        all_agents = _load_dynamic_agents() + _AGENT_REGISTRY
        for a in all_agents:
            name = a.get("name", "")
            desc = a.get("description", "")
            if name:
                agent_lines.append(f"  - {name!r}: {desc}")
    except Exception:  # noqa: BLE001
        pass

    registry_block = (
        "Registered agents you can delegate to:\n" + "\n".join(agent_lines)
        if agent_lines
        else "Registered agents: check with the orchestrator if unsure."
    )

    return f"""
---
## CommandCenter Platform Tools (injected at runtime)

In addition to your own tools, the following tools have been injected by the
CommandCenter platform and are available to you in every session:

### Inter-agent delegation
- **call_agent(agent_name, message)** — Delegate a task to another agent and
  wait for its full response. Use when you need the result before continuing.
- **call_agents_parallel(tasks)** — Run multiple agents concurrently (JSON array
  of {{\"agent\": \"name\", \"message\": \"...\"}} objects). Use for independent
  sub-tasks that can run simultaneously.
- **call_agent_background(agent_name, message)** — Fire-and-forget delegation.
  Returns immediately. Use when the result is not needed synchronously.

{registry_block}

### Web access (no API key required)
- **web_search(query, max_results=5)** — Search the web via DuckDuckGo. Use for
  current information, company research, news, or anything outside your training data.
- **fetch_page(url, max_chars=8000)** — Fetch any public web page as clean text
  via Jina Reader. Use when you have a specific URL to read.

### Memory & knowledge graph (active read/write)
These tools give you direct access to CommandCenter's persistent memory systems.
Use them to maintain continuity across conversations and build up knowledge over time.

- **remember(query)** — Search episodic memory for past facts about the current
  user. Call BEFORE making claims about user preferences, history, or context.
  Example: `remember("Vijay's reporting preferences")`
- **recall_timeline(entity_name, query)** — Search the bi-temporal knowledge graph
  for time-stamped facts about an entity (deal, person, project, company).
  Use for "when did X happen?" or "what's the history of Y?" questions.
  Example: `recall_timeline("ABC Corp", "deal stage changes and follow-ups")`
- **save_memory(fact)** — Persist a single important fact about the current user
  to episodic memory. Future conversations will automatically recall this.
  Example: `save_memory("Vijay prefers weekly Monday reports in bullet format")`
- **save_episode(name, content, source?)** — Record a time-stamped episode in the
  knowledge graph. Graphiti extracts entities, relationships, and timestamps.
  Example: `save_episode("Deal closed", "ABC Corp signed ₹50L PO", source="agent-sales")`

When to save vs. let the platform handle it:
  - **Actively save** when you learn a NEW fact the user explicitly shares, or
    when a significant event occurs (deal stage change, meeting outcome, etc.).
  - **Trust the platform** for routine conversation turns — the gateway
    automatically extracts memories after each run. Active save is for
    high-signal facts you want to guarantee are captured.

### Workspace folders & file writing
Your workspace has three folders.  ONLY files in these folders are visible to
the operator in the Files Viewer sidebar:

  - **outputs/** — DEFAULT for all agent-generated files (reports, scripts,
    spreadsheets, PDFs, images, exports, etc.).  ``write_artifact`` auto-places
    files here unless you specify otherwise.
  - **inputs/** — User-uploaded files and attachments.  Read from here, do NOT
    write here unless the user explicitly asks you to modify an uploaded file.
  - **agent-data/** — Permanent reference data, templates, catalogues, and
    knowledge that makes you better at your job.  If you discover or generate
    information worth reusing across sessions, save it here.

- **write_artifact(path, content, encoding?)** — Write a file to the workspace.
  If *path* doesn't start with ``inputs/``, ``outputs/``, or ``agent-data/``,
  the file is automatically placed in ``outputs/``.  Accepts text (default
  UTF-8) or raw bytes (set ``encoding=None``).

  **CRITICAL — embed the download link:**  The tool returns a ``download_url``
  field.  You MUST include a clickable link in your response text so the
  operator can download the file.  Example pattern:

  ```
  result = await write_artifact("q2_report.md", report_markdown)
  # Then in your reply, write:
  # Here is the report: [📄 Download Q2 Report]({result["download_url"]})
  ```

  For multiple files, list each with its download link:
  ```
  - [📄 Sales Report]({result1["download_url"]})
  - [📊 Chart (PNG)]({result2["download_url"]})
  ```

### Self-improvement & committing
When you make changes to your own repository (new skills, bug fixes, improvements
to agents.py or prompts), you MUST commit those changes using git so they can be
reviewed and pushed by a human operator.

**How to commit your changes:**
1. Make your changes in the repository (the local clone is already checked out and
   authenticated — do NOT re-clone).
2. Stage your changes: `git add -A` (or target specific files).
3. Commit on the **current branch** — do NOT create a new branch, do NOT push:
   ```
   git commit -m "feat: <short description of what changed and why>"
   ```
4. After committing, print the following sentinel lines so the platform records them:
   ```
   COMMIT_SHA: <output of: git rev-parse HEAD>
   ```
   Printing `COMMIT_SHA:` is mandatory — without it the platform cannot register
   your commit in the approval queue.
5. **Do NOT run `git push`.** Pushes are blocked at the hook level. Your commit
   will appear in the Control Plane inbox where a human can review the diff and
   click **Approve** to push it, or **Reject** to discard it.

**When to self-commit:**
- You add or update a skill script in `skills/*/scripts/`.
- You add or update a tool function in `agents.py`.
- You fix a bug in your own code.
- You update `prompts/system.md` or a `skills/*/SKILL.md` file.
- Any time you modify files in your repository as part of completing a task.

**Bot identity is already configured** in the local clone — you do not need to
set `git config user.name` or `git config user.email`.

**Important constraints:**
- Commit minimal, targeted changes — do not refactor unrelated code.
- Never amend a previous commit; always make a new commit.
- A single task should produce at most one commit.
- If `git commit` reports "nothing to commit", you have no unstaged changes —
  this is fine, just skip the commit step.
---"""


def _inject_agent_tools(agents: list[Any]) -> None:
    """Inject cross-agent delegation tools into every loaded agent.

    Adds ``call_agent`` and ``call_agent_background`` from ``acb_skills.agent_tools``
    so that any agent — MAF or GitHub Copilot SDK — can delegate sub-tasks to
    other registered agents without any changes to the external agent repo.

    Injection is best-effort: failures are silently swallowed so they never
    block the main agent execution path.

    Injection targets:
        MAF Agent                — appends to ``agent.tools`` (list)
        GitHubCopilotAgent       — appends to ``agent._tools`` (list built at init;
                                   merged into SessionConfig.tools at session creation)
                                   + appends tool guidance to ``_default_options.system_message``
        Legacy Copilot SDK path  — appends to ``agent._default_options.tools`` (list)
    """
    try:
        from acb_skills.agent_tools import call_agent  # noqa: PLC0415
        from acb_skills.agent_tools import (call_agent_background,
                                            call_agents_parallel)
        _extra_tools = [call_agent, call_agents_parallel, call_agent_background]
    except ImportError:
        return  # acb_skills not installed in this env — skip silently

    # Zero-credential web tools — always available, no integration config needed.
    try:
        from acb_skills.web_tools import fetch_page  # noqa: PLC0415
        from acb_skills.web_tools import web_search
        _extra_tools = _extra_tools + [web_search, fetch_page]
    except ImportError:
        pass  # duckduckgo-search / httpx not installed — skip gracefully

    # File-writing artifact tool — surfaces created files in the UI sidebar.
    try:
        from acb_skills.write_artifact import write_artifact  # noqa: PLC0415
        _extra_tools = _extra_tools + [write_artifact]
    except ImportError:
        pass

    # Memory tools — active read/write to Mem0 + Graphiti knowledge graph.
    # Gives agents the ability to query past facts and persist new knowledge
    # on demand, rather than relying solely on passive context injection.
    try:
        from acb_skills.memory_tools import (
            remember,
            recall_timeline,
            save_memory,
            save_episode,
        )
        _extra_tools = _extra_tools + [
            remember, recall_timeline, save_memory, save_episode,
        ]
    except ImportError:
        pass  # acb_memory not installed — skip gracefully

    for agent in agents:
        injected = False

        # ── GitHubCopilotAgent (agent-framework-ag-ui) ──────────────────────
        # Stores tools in self._tools (a list); fed into SessionConfig at run time.
        # Must be patched BEFORE the MAF path because GitHubCopilotAgent also
        # sets self.tools = [] (empty) via its base class — we don't want to
        # append to that empty list and skip the real _tools.
        #
        # IMPORTANT: _prepare_tools() (called at session creation) only converts
        # FunctionTool / CopilotTool / MutableMapping — plain async callables are
        # silently skipped.  We must wrap each function with normalize_tools() first
        # so the Copilot SDK actually registers them and the LLM can call them.
        try:
            if hasattr(agent, "_tools") and isinstance(agent._tools, list):
                # Try to import normalize_tools for FunctionTool wrapping.
                try:
                    from agent_framework._tools import \
                        normalize_tools as _norm  # noqa: PLC0415
                except ImportError:
                    _norm = None  # type: ignore[assignment]

                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in agent._tools
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        # Wrap as FunctionTool so _prepare_tools() picks it up.
                        wrapped = _norm([fn])[0] if _norm is not None else fn
                        agent._tools.append(wrapped)

                # Append tool guidance to the system message so the LLM knows
                # these tools exist, what they do, and what agent names are valid.
                # The agent's own instructions.md was written before CommandCenter
                # injection and has no mention of call_agent / web_search / etc.
                #
                # _default_options is a plain dict; system_message inside it has
                # the form {'mode': 'append', 'content': '<text>'}.  We must use
                # dict access (not setattr) and preserve the nested structure.
                try:
                    addendum = _build_injected_tools_addendum()
                    opts = getattr(agent, "_default_options", None)
                    if isinstance(opts, dict):
                        existing_sys = opts.get("system_message")
                        if isinstance(existing_sys, dict):
                            # Preserve mode:'append'; extend content field.
                            existing_sys["content"] = (existing_sys.get("content") or "") + addendum
                        elif isinstance(existing_sys, str):
                            opts["system_message"] = {"mode": "append", "content": existing_sys + addendum}
                        else:
                            opts["system_message"] = {"mode": "append", "content": addendum}
                except Exception:  # noqa: BLE001
                    pass

                injected = True
        except Exception:  # noqa: BLE001
            pass

        if injected:
            continue

        # ── MAF Agent (agent-framework) ─────────────────────────────────────
        # agent.tools is a list[FunctionTool | callable].  MAF accepts plain
        # async functions directly, so we can append without wrapping.
        try:
            if hasattr(agent, "tools") and isinstance(agent.tools, list):
                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in agent.tools
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        agent.tools.append(fn)
                continue
        except Exception:  # noqa: BLE001
            pass

        # ── Legacy: _default_options.tools (older Copilot SDK wrapper) ──────
        # Same wrapping requirement as _tools above: raw callables are silently
        # skipped by the SDK.  Wrap each function with normalize_tools() so they
        # appear in the session's tool schema and the LLM can call them.
        try:
            opts = getattr(agent, "_default_options", None)
            if opts is not None:
                try:
                    from agent_framework._tools import \
                        normalize_tools as _norm_legacy  # noqa: PLC0415
                except ImportError:
                    _norm_legacy = None  # type: ignore[assignment]

                existing = list(getattr(opts, "tools", []) or [])
                existing_names = {
                    getattr(getattr(fn, "func", fn), "__name__", None) for fn in existing
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        wrapped = _norm_legacy([fn])[0] if _norm_legacy is not None else fn
                        existing.append(wrapped)
                opts.tools = existing
        except Exception:  # noqa: BLE001
            pass


async def _inject_mcp_servers(agent: Any, agent_name: str) -> None:
    """Query the MCP server registry and inject matching servers into the agent.

    Reads the ``mcp_servers`` Postgres table, resolves any credential
    references through the Integration Registry, and merges the MCP
    server config into ``agent._default_options["mcp_servers"]``.

    Only servers whose ``agent_scope`` includes ``"*"`` or the current
    agent name are injected.

    Best-effort: failures are silently swallowed so MCP issues never
    block agent execution.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            rows = s.execute(
                text("SELECT name, transport, command, url, env_vars, headers, "
                "agent_scope FROM mcp_servers WHERE enabled = true")
            ).fetchall()
    except Exception:  # noqa: BLE001
        return  # Table may not exist yet — skip gracefully

    mcp_config: dict[str, dict[str, Any]] = {}
    for r in rows:
        name, transport, command, url, env_vars, headers, scope = r
        # Check agent scope
        scope_list: list = scope if isinstance(scope, list) else (
            scope if isinstance(scope, str) else ["*"]
        )
        if isinstance(scope_list, str):
            scope_list = [scope_list]
        if "*" not in scope_list and agent_name not in scope_list:
            continue

        entry: dict[str, Any] = {"transport": transport}
        if transport == "stdio" and command:
            entry["command"] = command
            # Resolve env var values from Integration Registry
            resolved_env: dict[str, str] = {}
            raw_env = env_vars or {}
            for k, v in (raw_env if isinstance(raw_env, dict) else {}).items():
                resolved_env[k] = str(v)
            if resolved_env:
                entry["env"] = resolved_env
        elif transport == "http-sse" and url:
            entry["url"] = url
            raw_headers = headers or {}
            resolved_headers: dict[str, str] = {}
            for k, v in (raw_headers if isinstance(raw_headers, dict) else {}).items():
                resolved_headers[k] = str(v)
            if resolved_headers:
                entry["headers"] = resolved_headers
        else:
            continue

        mcp_config[name] = entry

    if not mcp_config:
        return

    # Merge into agent's default_options
    try:
        opts = getattr(agent, "_default_options", None)
        if isinstance(opts, dict):
            existing = opts.get("mcp_servers") or {}
            if isinstance(existing, dict):
                existing.update(mcp_config)
            else:
                existing = mcp_config
            opts["mcp_servers"] = existing
    except Exception:  # noqa: BLE001
        pass


class AgentRunError(Exception):
    """Raised after an agent run fails (mutation already attempted if applicable)."""

    def __init__(
        self,
        message: str,
        *,
        agent_name: str,
        run_id: str,
        original: Exception,
        mutation_pr: str | None = None,
    ) -> None:
        super().__init__(message)
        self.agent_name = agent_name
        self.run_id = run_id
        self.original = original
        self.mutation_pr = mutation_pr


async def _run_sub_agent_streaming(
    agent_name: str,
    message_str: str,
    run_id: str,
    event_queue: "asyncio.Queue[dict[str, Any] | None]",
) -> str:
    """Run a sub-agent and forward its streaming events to *event_queue*.

    Called by ``call_agent`` when there is an active parent SSE queue so that
    the sub-agent's progress is visible in the UI in real time.

    Supports GitHub Copilot SDK agents (native stream) and MAF agents (batch
    run with a single result delta at the end).

    Returns the final text response.
    """
    settings = get_settings()
    _repo_name: str | None = None
    _local_path: str | None = None
    _runtime: str = "maf"
    try:
        from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
        from gateway.routes.agent import _load_dynamic_agents
        _all = _load_dynamic_agents() + _AGENT_REGISTRY
        entry = next((e for e in _all if e["name"] == agent_name), None)
        if entry:
            raw = entry.get("repo_name") or ""
            # Pass the full org/repo slug — load_agent splits it when needed
            _repo_name = raw if raw else None
            _local_path = entry.get("local_path")
            _runtime = entry.get("agent_runtime", "maf")
    except (ImportError, Exception):  # noqa: BLE001
        pass

    # Initialised before try so the finally block always has access
    # even when load_agent() or build_agents() raises early.
    _saved_artifact_ctx: dict[str, str] = {}

    try:
        with load_agent(agent_name, run_id=run_id, repo_name=_repo_name, local_path=_local_path) as loaded:
            mandatory = loaded.config.get("integrations", [])
            optional = loaded.config.get("optional_integrations", [])
            integrations, _ = build_integrations(mandatory, optional, settings)
            _inject_integrations_to_env(integrations)
            agents = loaded.build_agents()
            _inject_agent_tools(agents)
            if not agents:
                return f"({agent_name!r} returned empty agent list)"
            agent = agents[0]

            # Apply permission handler for GitHub Copilot SDK agents.
            try:
                from copilot import PermissionHandler as _PH  # noqa: PLC0415
                for _a in agents:
                    if hasattr(_a, "_permission_handler") and _a._permission_handler is None:
                        _a._permission_handler = _PH.approve_all
            except Exception:  # noqa: BLE001
                pass

            # ── Set working directory for Copilot SDK sub-agents ──────────
            # The Copilot SDK CLI defaults to the gateway process CWD
            # unless working_directory is explicitly set.  Without this,
            # shell commands, file reads, AGENTS.md, and skill resolution
            # all happen in the wrong directory.
            _sub_agent_dir = str(loaded.agent_dir)
            if (
                _runtime == "github-copilot"
                and hasattr(agent, "_default_options")
                and agent._default_options is not None
            ):
                agent._default_options["working_directory"] = _sub_agent_dir

            # ── Point write_artifact at sub-agent's own workspace ────────
            # Save orchestrator's context, switch to sub-agent workspace so
            # artifacts land in the sub-agent's repo (visible in the Files
            # sidebar).  Restored after sub-agent completes.
            try:
                from acb_skills.write_artifact import \
                    _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
                for _k in ("workspace_root", "session_id"):
                    _saved_artifact_ctx[_k] = _WRITE_ARTIFACT_CONTEXT.get(
                        _k, ""
                    )
                _WRITE_ARTIFACT_CONTEXT["workspace_root"] = _sub_agent_dir
                # session_id stays as orchestrator's so download URLs
                # resolve correctly in the parent chat window.
            except Exception:  # noqa: BLE001
                pass

            text_parts: list[str] = []

            if _runtime == "github-copilot" and hasattr(agent, "run"):
                # Resolve model with priority:
                #   1. copilot_chat_model (global setting)
                #   2. Agent's model_tier from config.json
                _model = (
                    getattr(settings, "copilot_chat_model", "") or ""
                ).strip() or (
                    loaded.config.get("model_tier") or ""
                ).strip()

                if _model:
                    try:
                        if (
                            hasattr(agent, "_default_options")
                            and agent._default_options is not None
                        ):
                            # BYOK: if the model is a LiteLLM model (contains
                            # '/' or starts with 'tier'), route through the
                            # gateway's /v1 endpoint so the Copilot SDK session
                            # uses the BYOK provider instead of the default
                            # api.githubcopilot.com endpoint.
                            _is_sub_byok = (
                                "/" in _model
                                or _model.lower().startswith("tier")
                            )
                            if _is_sub_byok:
                                _gw_base = (
                                    getattr(
                                        settings, "litellm_base_url", ""
                                    )
                                    or "http://127.0.0.1:8080"
                                ).rstrip("/")
                                _gw_key = (
                                    getattr(
                                        settings, "litellm_master_key", ""
                                    )
                                    or "sk-local"
                                ).strip()
                                agent._default_options["provider"] = {
                                    "type": "openai",
                                    "base_url": f"{_gw_base}/v1",
                                    "api_key": _gw_key,
                                }
                                agent._default_options["model"] = _model
                                _log.info(
                                    "executor.sub_agent_byok",
                                    agent=agent_name,
                                    model=_model,
                                    base_url=_gw_base,
                                )
                            else:
                                agent._default_options["model"] = _model
                    except Exception:  # noqa: BLE001
                        pass

                async with agent:
                    stream = agent.run(message_str, stream=True)
                    async for update in stream:
                        for content in (update.contents or []):
                            ct = getattr(content, "type", "")
                            if ct == "text":
                                delta = content.text or ""
                                if delta:
                                    text_parts.append(delta)
                                    await event_queue.put({
                                        "type": "SUB_AGENT_TEXT_DELTA",
                                        "agentName": agent_name,
                                        "runId": run_id,
                                        "delta": delta,
                                    })
                            elif ct == "function_call":
                                call_id = getattr(content, "call_id", run_id)
                                tname = getattr(content, "name", "tool")
                                args_val = getattr(content, "arguments", None)
                                args_str = ""
                                if args_val is not None:
                                    try:
                                        args_str = json.dumps(args_val) if not isinstance(args_val, str) else args_val
                                    except Exception:  # noqa: BLE001
                                        args_str = str(args_val)
                                await event_queue.put({
                                    "type": "SUB_AGENT_TOOL_CALL_START",
                                    "agentName": agent_name,
                                    "toolCallId": call_id,
                                    "toolCallName": tname,
                                    "args": args_str,
                                })
                            elif ct == "function_result":
                                call_id = getattr(content, "call_id", run_id)
                                exc_val = getattr(content, "exception", None)
                                result_val = getattr(content, "result", "") or ""
                                await event_queue.put({
                                    "type": "SUB_AGENT_TOOL_CALL_RESULT",
                                    "agentName": agent_name,
                                    "toolCallId": call_id,
                                    "content": str(exc_val) if exc_val else str(result_val),
                                    "success": exc_val is None,
                                })
            else:
                # MAF or unknown runtime: batch run, emit one result delta.
                result = await run_agent(
                    agent_name,
                    {"message": message_str, "mode": "sub_task"},
                    run_id=run_id,
                )
                text = result.get("result") or result.get("answer") or ""
                if isinstance(text, dict):
                    text = text.get("content", str(text))
                final_text = str(text) if text else ""
                if final_text:
                    text_parts.append(final_text)
                    await event_queue.put({
                        "type": "SUB_AGENT_TEXT_DELTA",
                        "agentName": agent_name,
                        "runId": run_id,
                        "delta": final_text,
                    })

            return "".join(text_parts) or f"({agent_name!r} returned an empty response)"

    except Exception as exc:  # noqa: BLE001
        await event_queue.put({
            "type": "SUB_AGENT_ERROR",
            "agentName": agent_name,
            "runId": run_id,
            "error": str(exc),
        })
        return f"Sub-task to {agent_name!r} failed: {exc}"
    finally:
        # Restore orchestrator's artifact context so subsequent tool calls
        # (including write_artifact) target the correct workspace.
        if _saved_artifact_ctx:
            try:
                from acb_skills.write_artifact import \
                    _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
                for _key, _val in _saved_artifact_ctx.items():
                    if _val:
                        _WRITE_ARTIFACT_CONTEXT[_key] = _val
            except Exception:  # noqa: BLE001
                pass


async def _get_current_head(agent_dir: str) -> str:
    """Return the current HEAD SHA of *agent_dir*, or '' on error."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD",
            cwd=agent_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return out.decode(errors="replace").strip() if proc.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


async def _install_push_guard(agent_dir: str) -> None:
    """Install a git pre-push hook that rejects all pushes from the local clone.

    Called once per clone.  Copilot SDK agents must commit locally; the
    human-approval gateway endpoint handles the push.  This prevents an agent
    from bypassing the inbox by pushing directly.

    Non-fatal — if the hook already exists or the write fails, execution
    continues; the post-run commit scan still catches any new commits.
    """
    try:
        hooks_dir = Path(agent_dir) / ".git" / "hooks"
        if not hooks_dir.is_dir():
            return
        hook_file = hooks_dir / "pre-push"
        if hook_file.exists():
            return  # already installed
        hook_file.write_text(
            "#!/bin/sh\n"
            "echo 'Direct push blocked: commits are queued for human approval'\n"
            "echo 'Approve via the CommandCenter Control Plane inbox.'\n"
            "exit 1\n",
            encoding="utf-8",
        )
        hook_file.chmod(0o755)
    except Exception as exc:  # noqa: BLE001
        _log.warning("executor.push_guard_install_failed", agent=agent_dir, error=str(exc))


async def _detect_agent_commits(
    agent_name: str,
    agent_dir: str | None,
    run_id: str,
    *,
    since_sha: str | None = None,
) -> None:
    """After a GitHub Copilot agent run, register any new commits for inbox approval.

    Two detection modes:
    - ``since_sha`` provided (preferred): detects ALL commits since that SHA,
      whether pushed or not (``git log {since_sha}..HEAD``).
    - No ``since_sha``: falls back to local-only detection
      (``git log origin/HEAD..HEAD``), which misses commits that were pushed.

    Only called for ``agent_runtime == "github-copilot"``; MAF agents don't
    commit to the repo during a run.

    Non-fatal — any subprocess or DB error is logged and swallowed.
    """
    if not agent_dir:
        return

    try:
        if since_sha:
            # Detect all new commits since before the run (even if already pushed)
            git_range = f"{since_sha}..HEAD"
            proc = await asyncio.create_subprocess_exec(
                "git", "log", git_range, "--format=%H|%s",
                cwd=agent_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                return
        else:
            # Fallback: only local-only commits (misses pushed ones)
            proc = await asyncio.create_subprocess_exec(
                "git", "log", "origin/HEAD..HEAD", "--format=%H|%s",
                cwd=agent_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode != 0:
                err = stderr_bytes.decode(errors="replace")
                if "unknown revision" in err or "ambiguous argument" in err:
                    for base in ("origin/main", "origin/master"):
                        proc2 = await asyncio.create_subprocess_exec(
                            "git", "log", f"{base}..HEAD", "--format=%H|%s",
                            cwd=agent_dir,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.DEVNULL,
                        )
                        out2, _ = await asyncio.wait_for(proc2.communicate(), timeout=10)
                        if proc2.returncode == 0:
                            stdout_bytes = out2
                            break
                    else:
                        return
                else:
                    return

        lines = stdout_bytes.decode(errors="replace").strip().splitlines()
        if not lines:
            return  # nothing new — agent didn't commit during this run

        _log.info(
            "executor.agent_commits_detected",
            agent=agent_name,
            run_id=run_id,
            count=len(lines),
        )

        from orchestrator.mutation import _git_diff  # noqa: PLC0415
        from orchestrator.mutation import _register_pending_commit

        # Load existing commit SHAs for this agent so we don't double-register.
        _existing_shas: set[str] = set()
        try:
            from acb_graph import get_session as _gs  # noqa: PLC0415
            from sqlalchemy import text as _txt  # noqa: PLC0415
            with _gs() as _s:
                _rows = _s.execute(
                    _txt("SELECT commit_sha FROM pending_commit WHERE agent_name = :a"),
                    {"a": agent_name},
                ).fetchall()
                _existing_shas = {r[0] for r in _rows}
        except Exception:  # noqa: BLE001
            pass

        for raw_line in lines:
            parts = raw_line.split("|", 1)
            commit_sha = parts[0].strip()
            commit_message = parts[1].strip() if len(parts) > 1 else commit_sha[:8]
            if not commit_sha or commit_sha in _existing_shas:
                continue  # skip already-registered commits

            # Capture the diff for inline review
            diff_text = await _git_diff(agent_dir, commit_sha)

            await _register_pending_commit(
                agent_name=agent_name,
                run_id=run_id,
                local_clone_dir=agent_dir,
                commit_sha=commit_sha,
                commit_message=commit_message,
                diff_text=diff_text,
                test_summary="(agent self-improvement — no test run)",
            )

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_self_commit_detected",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "commit_count": len(lines),
                    "commits": [ln.split("|", 1)[0].strip()[:12] for ln in lines],
                },
            )
        )

    except Exception as exc:  # noqa: BLE001
        _log.warning(
            "executor.detect_commits_failed",
            agent=agent_name,
            run_id=run_id,
            error=str(exc),
        )


async def run_agent(
    agent_name: str,
    event_payload: dict[str, Any],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Dynamically load and execute a named agent.

    Args:
        agent_name:    Bare agent name, e.g. ``"task-manager"``.
        event_payload: Arbitrary event data injected as the initial state.
        run_id:        Unique execution ID (auto-generated if ``None``).
        thread_id:     Conversation thread ID (defaults to ``"{agent_name}:{run_id}"``).

        The final MAF agent result dict.

    Raises:
        :class:`AgentRunError` on failure (includes mutation PR URL if one was opened).
    """
    settings = get_settings()
    run_id = run_id or str(uuid.uuid4())
    thread_id = thread_id or f"{agent_name}:{run_id}"

    record(
        AuditEvent(
            actor="system:gateway",
            action="agent_run_start",
            target=f"agent:{agent_name}",
            payload={"run_id": run_id, "event_keys": list(event_payload.keys())},
        )
    )

    try:
        _agent_dir: str | None = None

        # Look up optional repo_name override from the gateway's agent registry.
        # This allows repos not following the "agent-{name}" naming convention
        # (e.g. FracktalWorks/sales-prospector instead of agent-sales-prospector).
        # Checks dynamic agents (agents.json) first, then falls back to static registry.
        _registry_repo_name: str | None = None
        _registry_local_path: str | None = None
        try:
            from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
            from gateway.routes.agent import _load_dynamic_agents
            _all_entries = _load_dynamic_agents() + _AGENT_REGISTRY
            _registry_entry = next(
                (e for e in _all_entries if e["name"] == agent_name), None
            )
            if _registry_entry:
                raw_repo = _registry_entry.get("repo_name") or ""
                # repo_name may be stored as "owner/repo" (full slug from registration)
                # or just "repo". Pass the full slug — load_agent splits when needed.
                _registry_repo_name = raw_repo if raw_repo else None
                _registry_local_path = _registry_entry.get("local_path")
        except ImportError:
            pass

        with load_agent(
            agent_name,
            run_id=run_id,
            repo_name=_registry_repo_name,
            local_path=_registry_local_path,
        ) as loaded:
            _agent_dir = str(loaded.agent_dir)

            # For GitHub Copilot SDK agents: install the push guard (prevents
            # direct pushes; commits stay local until operator approves) and
            # record the current HEAD so we can detect new commits after the run.
            _head_before: str = ""
            _is_copilot_agent = False
            try:
                from gateway.routes.agent import _AGENT_REGISTRY
                from gateway.routes.agent import \
                    _load_dynamic_agents as _lda  # noqa: PLC0415
                _ea = next(
                    (e for e in _lda() + _AGENT_REGISTRY if e["name"] == agent_name),
                    None,
                )
                if _ea and _ea.get("agent_runtime") == "github-copilot":
                    _is_copilot_agent = True
                    await _install_push_guard(_agent_dir)
                    _head_before = await _get_current_head(_agent_dir)
            except Exception:  # noqa: BLE001
                pass

            # Resolve credentials for both mandatory and optional integrations.
            # Never raises — partial configs are fine.  Missing integrations are
            # passed to the agent via integration_warnings so it can inform the
            # user at tool-call time rather than blocking the entire run.
            mandatory_integrations: list[str] = loaded.config.get("integrations", [])
            optional_integrations: list[str] = loaded.config.get("optional_integrations", [])
            integrations, integration_warnings = build_integrations(
                mandatory_integrations, optional_integrations, settings
            )
            if integration_warnings:
                _log.warning(
                    "executor.integrations_partial",
                    agent=agent_name,
                    run_id=run_id,
                    unavailable=list(integration_warnings.keys()),
                )

            agents = loaded.build_agents()
            _inject_agent_tools(agents)  # inject call_agent / call_agent_background

            # Set write_artifact context + ensure visible workspace dirs exist.
            try:
                from acb_skills.write_artifact import \
                    _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
                _WRITE_ARTIFACT_CONTEXT["session_id"] = thread_id or run_id
                _WRITE_ARTIFACT_CONTEXT["workspace_root"] = str(loaded.agent_dir)
                _WRITE_ARTIFACT_CONTEXT["gateway_url"] = str(
                    getattr(settings, "gateway_base_url", "http://127.0.0.1:8000")
                )
                _WRITE_ARTIFACT_CONTEXT["gateway_token"] = str(
                    getattr(settings, "litellm_master_key", "")
                    or getattr(settings, "gateway_internal_token",
                               "sk-local-dev-change-me")
                )
                _ws_root = loaded.agent_dir
                for _d in ("inputs", "outputs", "agent-data"):
                    (_ws_root / _d).mkdir(parents=True, exist_ok=True)
            except Exception:  # noqa: BLE001
                pass

            # ── Set working directory for Copilot SDK agents ────────────
            # The Copilot SDK CLI defaults to the gateway CWD unless
            # working_directory is explicitly set.  Point it at the agent's
            # cloned repo so shell commands, file I/O, AGENTS.md, and
            # skill resolution all work correctly.
            if _is_copilot_agent:
                for _ag in agents:
                    try:
                        if (
                            hasattr(_ag, "_default_options")
                            and _ag._default_options is not None
                        ):
                            _ag._default_options["working_directory"] = (
                                _agent_dir
                            )
                    except Exception:  # noqa: BLE001
                        pass

            final_state = await _run_with_maf_agent(
                agents,
                agent_name=agent_name,
                run_id=run_id,
                thread_id=thread_id,
                event_payload={
                    **event_payload,
                    "integration_warnings": integration_warnings,
                },
                integrations=integrations,
            )

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_run_complete",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "result_keys": list(final_state.keys()),
                },
            )
        )
        # Post-run: detect commits the agent made during this run (github-copilot only)
        _registry_runtime = "maf"
        try:
            from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
            from gateway.routes.agent import _load_dynamic_agents
            _e = next(
                (e for e in _load_dynamic_agents() + _AGENT_REGISTRY if e["name"] == agent_name),
                None,
            )
            if _e:
                _registry_runtime = _e.get("agent_runtime", "maf")
        except Exception:  # noqa: BLE001
            pass
        if _registry_runtime == "github-copilot":
            await _detect_agent_commits(
                agent_name, _agent_dir, run_id,
                since_sha=_head_before if _head_before else None,
            )
        return final_state

    except AgentLoadError as exc:
        _log.error("executor.load_error", agent=agent_name, run_id=run_id, error=str(exc))
        record(
            AuditEvent(
                actor="system:executor",
                action="agent_load_error",
                target=f"agent:{agent_name}",
                payload={"run_id": run_id, "error": str(exc)},
            )
        )
        # Structural incompatibility (missing agents.py, no tools, LangGraph remnant, etc.)
        # Trigger the Copilot SDK mutation sandbox to auto-fix the repo and open a PR.
        # The sandbox receives the full error + the agent_repo_compatibility.md guide
        # so the SDK agent knows exactly what the repo needs to look like.
        from orchestrator.mutation import \
            attempt_self_mutation  # noqa: PLC0415
        mutation_result = await attempt_self_mutation(
            agent_name=agent_name,
            run_id=run_id,
            error=exc,
            agent_dir=_agent_dir,
            incompatibility=True,
        )
        pr_url = mutation_result.pr_url if mutation_result else None
        raise AgentRunError(
            f"Agent repo incompatible — self-repair PR opened: {pr_url}" if pr_url
            else str(exc),
            agent_name=agent_name,
            run_id=run_id,
            original=exc,
            mutation_pr=pr_url,
        ) from exc

    except Exception as exc:
        _log.error("executor.run_error", agent=agent_name, run_id=run_id, error=str(exc))

        # ── Self-annealing: detect → fix in-process → retry → LLM recovery ──
        recovery = await _self_anneal(
            agent_name=agent_name,
            run_id=run_id,
            thread_id=thread_id,
            event_payload=event_payload,
            agent_dir=_agent_dir,
            error=exc,
        )
        if recovery is not None:
            return recovery

        # All anneal attempts exhausted — attempt self-mutation (ADR-021)
        from orchestrator.mutation import \
            attempt_self_mutation  # noqa: PLC0415

        mutation_result = await attempt_self_mutation(
            agent_name=agent_name,
            run_id=run_id,
            error=exc,
            agent_dir=_agent_dir,  # pass persistent clone path for authenticated push
        )
        pr_url = mutation_result.pr_url if mutation_result else None

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_run_error",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "error": str(exc),
                    "mutation_pr": pr_url,
                },
            )
        )
        raise AgentRunError(
            str(exc),
            agent_name=agent_name,
            run_id=run_id,
            original=exc,
            mutation_pr=pr_url,
        ) from exc


# ---------------------------------------------------------------------------
# Streaming executor — yields AG-UI SSE events for /agent/run/stream
# ---------------------------------------------------------------------------

# Monotonic counter for local event IDs.  Combined with a timestamp so the
# frontend can track ``lastEventId`` even for initial streams (where the Redis
# entry ID isn't yet known).  Format: ``local-<ms>-<seq>``.
_sse_seq: int = 0


def _sse(payload: dict[str, Any]) -> str:
    """Return a single SSE frame as a string.

    When ``_stream_relay_thread_id`` context var is set, also schedules a
    background push to the Redis Stream so reconnection can replay events.

    Includes a local ``_stream_id`` in every event so the frontend always
    has a cursor to resume from, even before the Redis push completes.
    """
    global _sse_seq
    import time as _time
    _sse_seq += 1
    _local_id = f"local-{int(_time.time() * 1000)}-{_sse_seq}"
    payload["_stream_id"] = _local_id

    line = f"data: {json.dumps(payload)}\n\n"

    # Tee to Redis Stream for reconnection support (ordered, best-effort).
    _tee_sse_line(line)

    return line


async def run_agent_stream(
    agent_name: str,
    event_payload: dict[str, Any],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """Load a named agent and yield AG-UI SSE events while it runs.

    Strategy (two-tier with automatic fallback):

    Tier 1 — MAF AG-UI streaming (preferred)
        If ``agent_framework.ag_ui`` exposes a ``stream_agent_response`` helper,
        delegate to it.  This forwards native TOOL_CALL_START / TOOL_CALL_ARGS /
        TOOL_CALL_END / TEXT_MESSAGE_CONTENT / RUN_FINISHED events — exactly what
        the Next.js translation layer already handles.

    Tier 2 — Instrumented batch fallback
        Wraps each tool function on the agent with a thin shim that pushes
        TOOL_CALL_START / TOOL_CALL_END events onto an asyncio.Queue while the
        main run executes in a background task.  The final text result is then
        word-streamed as TEXT_MESSAGE_CONTENT deltas so the UI renders the
        response progressively rather than all-at-once.

    Either way the caller (FastAPI StreamingResponse or the Next.js route) sees
    a standards-compliant AG-UI event stream.
    """
    run_id = run_id or str(uuid.uuid4())
    thread_id = thread_id or f"{agent_name}:{run_id}"

    settings = get_settings()

    # ── Stream relay: tee all SSE events to Redis for reconnection support ─
    _relay_token = _stream_relay_thread_id.set(thread_id)
    _relay_mark_inactive = None  # type: ignore[assignment]
    try:
        from orchestrator.stream_relay import (  # noqa: PLC0415
            mark_active as _relay_mark_active,
            mark_inactive as _relay_mark_inactive,
        )
        await _relay_mark_active(thread_id)
    except Exception:  # noqa: BLE001
        pass

    # ── Resolve agent metadata ──────────────────────────────────────────────
    _registry_repo_name: str | None = None
    _registry_local_path: str | None = None
    _agent_runtime: str = "maf"
    try:
        from gateway.routes.agent import _AGENT_REGISTRY  # noqa: PLC0415
        from gateway.routes.agent import _load_dynamic_agents
        _all = _load_dynamic_agents() + _AGENT_REGISTRY
        entry = next((e for e in _all if e["name"] == agent_name), None)
        if entry:
            raw = entry.get("repo_name") or ""
            # Pass the full org/repo slug — load_agent splits when needed
            _registry_repo_name = raw if raw else None
            _registry_local_path = entry.get("local_path")
            _agent_runtime = entry.get("agent_runtime", "maf")
    except ImportError:
        pass

    # Emit RUN_STARTED immediately so the UI can show ThinkingContainer at once.
    yield _sse({"type": "RUN_STARTED", "runId": run_id, "threadId": thread_id})

    try:
        with load_agent(
            agent_name,
            run_id=run_id,
            repo_name=_registry_repo_name,
            local_path=_registry_local_path,
        ) as loaded:
            mandatory = loaded.config.get("integrations", [])
            optional = loaded.config.get("optional_integrations", [])
            integrations, integration_warnings = build_integrations(
                mandatory, optional, settings
            )
            _inject_integrations_to_env(integrations)
            agents = loaded.build_agents()
            _inject_agent_tools(agents)  # inject call_agent / call_agent_background
            # Inject MCP servers from the registry into every agent at runtime
            for _a in agents:
                await _inject_mcp_servers(_a, agent_name)

            # Set write_artifact context so the tool knows which session to
            # report files to and where the workspace root lives.
            try:
                from acb_skills.write_artifact import \
                    _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
                _WRITE_ARTIFACT_CONTEXT["session_id"] = thread_id or run_id
                _WRITE_ARTIFACT_CONTEXT["workspace_root"] = str(loaded.agent_dir)
                _WRITE_ARTIFACT_CONTEXT["gateway_url"] = str(
                    getattr(settings, "gateway_base_url", "http://127.0.0.1:8000")
                )
                _WRITE_ARTIFACT_CONTEXT["gateway_token"] = str(
                    getattr(settings, "litellm_master_key", "")
                    or getattr(settings, "gateway_internal_token", "sk-local-dev-change-me")
                )

                # Ensure the three visible workspace directories exist so the
                # Files Viewer sidebar shows them even before the agent writes
                # its first artefact.
                _ws_root = loaded.agent_dir
                for _d in ("inputs", "outputs", "agent-data"):
                    (_ws_root / _d).mkdir(parents=True, exist_ok=True)
            except Exception:  # noqa: BLE001
                pass

            if not agents:
                raise ValueError(f"Agent {agent_name!r}: build_agents() returned empty list.")

            agent = agents[0]

            # ── Session continuity: restore Copilot SDK session if available ─
            # Storing the service_session_id allows MAF's _get_or_create_session
            # to call resume_session() instead of create_session(), maintaining
            # server-side conversation state across browser restarts.
            _copilot_session_id: str | None = None
            if _agent_runtime == "github-copilot" and thread_id:
                _copilot_session_id = _get_stored_session_id(thread_id)
                if _copilot_session_id:
                    _log.debug("executor.session_restore",
                               thread_id=thread_id,
                               copilot_session=_copilot_session_id[:12])

            # Ensure permission handler is set for GitHubCopilotAgent before ANY
            # execution path — repos often omit it from default_options.
            try:
                from copilot import PermissionHandler as _PH  # noqa: PLC0415
                for _a in agents:
                    if hasattr(_a, "_permission_handler") and _a._permission_handler is None:
                        _a._permission_handler = _PH.approve_all
            except Exception:  # noqa: BLE001
                pass

            # ── BYOK early detection (must happen BEFORE tier selection) ────
            # When a LiteLLM model is requested (contains '/' or starts with
            # 'tier') AND the agent uses the GitHub Copilot SDK runtime, the
            # BYOK provider must be configured on the agent before any MAF
            # streaming path runs — otherwise the Copilot SDK session will
            # reject the unknown model name.
            #
            # Model priority:
            #   1. Request ``model`` parameter (explicit user override)
            #   2. Global ``copilot_chat_model`` setting (env / .env)
            #   3. Agent's ``model_tier`` from config.json (per-agent default)
            _requested_model_early = (model or "").strip()
            _configured_model_early = (
                getattr(settings, "copilot_chat_model", "") or ""
            ).strip()
            _agent_model_tier = (
                loaded.config.get("model_tier") or ""
            ).strip()
            _final_model_early = (
                _requested_model_early
                or _configured_model_early
                or _agent_model_tier
            )
            _is_byok_early = bool(
                _final_model_early
                and (
                    "/" in _final_model_early
                    or _final_model_early.lower().startswith("tier")
                )
            )
            _byok_provider_early: dict[str, Any] | None = None
            _byok_model_id_early = _final_model_early
            if _is_byok_early and _agent_runtime == "github-copilot":
                _gw_base = (
                    getattr(settings, "litellm_base_url", "")
                    or "http://127.0.0.1:8080"
                ).rstrip("/")
                _gw_key = (
                    getattr(settings, "litellm_master_key", "") or "sk-local"
                ).strip()
                _byok_provider_early = {
                    "type": "openai",
                    "base_url": f"{_gw_base}/v1",
                    "api_key": _gw_key,
                }
                agent._default_options["provider"] = _byok_provider_early
                agent._default_options["model"] = _byok_model_id_early
                _log.info(
                    "executor.copilot_maf_byok_early",
                    agent=agent_name,
                    model=_byok_model_id_early,
                    base_url=_gw_base,
                )
            elif _final_model_early and _agent_runtime == "github-copilot":
                agent._default_options["model"] = _final_model_early

            # ── Set working directory for Copilot SDK agents ────────────
            # The Copilot SDK CLI defaults to the gateway CWD unless
            # working_directory is explicitly set.  Point it at the agent's
            # cloned repo so shell commands, file I/O, AGENTS.md, and
            # skill resolution all work correctly.
            if _agent_runtime == "github-copilot":
                _stream_agent_dir = str(loaded.agent_dir)
                for _ag in agents:
                    try:
                        if (
                            hasattr(_ag, "_default_options")
                            and _ag._default_options is not None
                        ):
                            _ag._default_options[
                                "working_directory"
                            ] = _stream_agent_dir
                    except Exception:  # noqa: BLE001
                        pass

            # ── Per-message model switching ────────────────────────────
            # If the user switches models mid-thread, the Copilot SDK
            # session is bound to the old model.  Invalidate the stored
            # session so a new one is created with the new model.  The
            # conversation continuity fallback prepends messages[] history
            # so the LLM sees full context despite the new session.
            if (_agent_runtime == "github-copilot"
                    and _copilot_session_id
                    and _final_model_early
                    and thread_id):
                _prev_model = _copilot_model_store.get(thread_id)
                if _prev_model and _prev_model != _final_model_early:
                    _log.info(
                        "executor.model_switch",
                        agent=agent_name,
                        previous=_prev_model,
                        requested=_final_model_early,
                    )
                    _copilot_session_id = None  # force new session

            # ── Tier 1: try native MAF AG-UI streaming ──────────────────────
            # Skip Tier 1 for BYOK GitHub Copilot agents — the MAF AG-UI path
            # calls agent.run() which creates a Copilot SDK session without the
            # BYOK provider routing, causing the SDK to reject unknown models.
            # Instead, fall through to Tier 1.5 where CommandCenterCopilotAgent
            # properly forwards the provider config to the Copilot SDK.
            if not (_is_byok_early and _agent_runtime == "github-copilot"):
                try:
                    from agent_framework.ag_ui import \
                        stream_agent_response  # noqa: PLC0415
                    message = _build_event_message(
                        agent_name, run_id, event_payload, integrations
                    )
                    async for line in stream_agent_response(
                        agent, message, run_id=run_id
                    ):
                        # Tee to Redis: this path yields pre-encoded AG-UI
                        # frames that bypass _sse(), so tee explicitly.
                        _tee_sse_line(line)
                        yield line
                    return
                except (ImportError, AttributeError):
                    pass  # MAF AG-UI streaming not available → fall through

            # ── Tier 1.5: GitHubCopilotAgent native streaming ───────────────
            # agent.run(stream=True) uses _stream_updates() which subscribes to
            # the Copilot session event bus — no 60s timeout, genuine token-by-
            # token streaming, live tool events.  This is the correct path for
            # any GitHub-sourced agent.
            #
            # BYOK provider + model already resolved in the early-detection
            # block above (before Tier 1).  Reuse those values here so the
            # GitHub Copilot SDK path doesn't duplicate the lookup.
            #
            # Queue-based approach (not direct yield): the agent runs in a
            # background task that pushes events to a queue.  The main loop
            # drains the queue and yields SSE.  This allows tool calls
            # (including call_agent sub-delegation) to push SUB_AGENT_* events
            # into the same queue while the main loop is waiting — giving
            # real-time visibility of sub-agent progress in the UI.

            # ── GitHub Copilot path (MAF-wrapped via CommandCenterCopilotAgent) ─
            if _agent_runtime == "github-copilot":
                from orchestrator.copilot_agent import CommandCenterCopilotAgent  # noqa: PLC0415

                # Patch the loaded agent with enhanced BYOK + streaming methods.
                agent.start = CommandCenterCopilotAgent.start.__get__(
                    agent, type(agent)
                )
                agent._create_session = CommandCenterCopilotAgent._create_session.__get__(
                    agent, type(agent)
                )
                agent._resume_session = CommandCenterCopilotAgent._resume_session.__get__(
                    agent, type(agent)
                )
                agent._stream_updates = CommandCenterCopilotAgent._stream_updates.__get__(
                    agent, type(agent)
                )

                # Install push guard + capture HEAD for post-run commit detection.
                await _install_push_guard(str(loaded.agent_dir))
                _stream_head_before = await _get_current_head(str(loaded.agent_dir))

                # BYOK provider + model already resolved in the early-
                # detection block.  Reuse pre-computed values.
                _is_byok = _is_byok_early
                _byok_provider = _byok_provider_early
                _byok_model_id = _byok_model_id_early

                # Ensure permission handler.
                try:
                    from copilot import PermissionHandler as _PH  # noqa: PLC0415
                    if hasattr(agent, "_permission_handler") and agent._permission_handler is None:
                        agent._permission_handler = _PH.approve_all
                except Exception:  # noqa: BLE001
                    pass

                _msg_text = event_payload.get("message") or event_payload.get("user_query") or ""

                # ── Conversation continuity fallback ──────────────────────
                # If no stored Copilot SDK session exists for this thread
                # (first message, or session record was lost due to gateway
                # restart / Copilot CLI process death), the Copilot SDK will
                # create a brand-new session that only sees _msg_text — losing
                # all prior conversation context.
                #
                # As a safety net, prepend recent conversation history from
                # the payload's messages[] array.  When the session IS alive
                # (_copilot_session_id found), this block is skipped — the
                # Copilot SDK already has full history in its session state.
                #
                # Stale session (gateway restart / Copilot CLI death): handled
                # via _session_retry_attempted in the streaming block below —
                # on resume failure the run retries with a fresh session and
                # history injected from messages[].
                if not _copilot_session_id:
                    _prior = event_payload.get("messages") or []
                    if _prior:
                        _history_lines: list[str] = []
                        for m in _prior[-20:]:  # last 10 exchanges
                            role = m.get("role", "user")
                            content = (m.get("content") or "").strip()
                            if not content:
                                continue
                            label = (
                                "User" if role == "user" else "Assistant"
                            )
                            short = (
                                content if len(content) <= 300
                                else content[:300] + "..."
                            )
                            _history_lines.append(f"{label}: {short}")
                        if _history_lines:
                            _msg_text = (
                                "## Prior conversation (for context)\n"
                                + "\n".join(_history_lines)
                                + f"\n\n## Current message\n{_msg_text}"
                            )
                            _log.debug(
                                "executor.copilot_context_fallback",
                                agent=agent_name,
                                history_turns=len(_history_lines),
                            )

                # ── Memory context injection (pre-enriched by the route handler) ──
                _memory_context = event_payload.get("memory_context") or ""
                if _memory_context:
                    try:
                        _opts = agent.default_options
                        if isinstance(_opts, dict):
                            _existing = (
                                _opts.get("instructions")
                                or _opts.get("system_message")
                                or ""
                            )
                            _merged = (
                                f"{_existing}\n\n{_memory_context}"
                            )
                            # MAF Agent base class uses "instructions"
                            _opts["instructions"] = _merged

                            # GitHubCopilotAgent uses "system_message" in
                            # a SEPARATE _default_options dict.  Merge with
                            # any existing content (tool addendum injected
                            # earlier by _inject_agent_tools) rather than
                            # overwriting — otherwise the tool guidance
                            # addendum that tells the LLM about call_agent,
                            # web_search, write_artifact, etc. is lost.
                            _copilot_opts = getattr(
                                agent, "_default_options", None
                            )
                            if isinstance(_copilot_opts, dict):
                                _existing_copilot = _copilot_opts.get(
                                    "system_message"
                                )
                                if isinstance(_existing_copilot, dict):
                                    # Preserve mode:'append'; extend content
                                    _prev = (
                                        _existing_copilot.get("content")
                                        or ""
                                    )
                                    _copilot_opts["system_message"] = {
                                        "mode": "append",
                                        "content": (
                                            f"{_prev}\n\n{_memory_context}"
                                        ),
                                    }
                                elif isinstance(_existing_copilot, str):
                                    _copilot_opts["system_message"] = (
                                        f"{_existing_copilot}\n\n"
                                        f"{_memory_context}"
                                    )
                                else:
                                    _copilot_opts["system_message"] = (
                                        _merged
                                    )
                    except Exception:  # noqa: BLE001
                        pass

                # ── Thinking mode (Auto / Thinking / Max) ──
                # reasoning_effort unlocks the model's full token-level
                # chain-of-thought stream (ASSISTANT_REASONING_DELTA) — the
                # same verbose stream-of-consciousness VS Code Copilot shows.
                # Without it most models emit only sparse fragments, so Auto
                # defaults to "low" rather than omitting it entirely.
                # _create_session() retries without the option if the model
                # rejects it, so unsupported models degrade gracefully.
                _think_mode = event_payload.get("think_mode") or "auto"
                try:
                    _opts = agent.default_options
                    if isinstance(_opts, dict):
                        _effort = {"thinking": "medium", "max": "high"}.get(
                            _think_mode, "low"
                        )
                        _opts["reasoning_effort"] = _effort
                except Exception:  # noqa: BLE001
                    pass

                _msg_id: str | None = None
                _text_started = False
                _todo_tracker = _TodoTracker()
                # Retry state — set to True after a stale-session recovery so
                # the second attempt is never retried again (max 1 retry).
                _session_retry_attempted = False
                _effective_msg = _msg_text

                # ── Inner async generator: one Copilot streaming attempt ───
                # Extracted so the retry loop below can call it twice without
                # duplicating the ~100-line event-translation body.
                # _agent_sess=None forces a new Copilot SDK session;
                # passing a session object resumes an existing one.
                async def _run_copilot_attempt(
                    _eff: str, _agent_sess: Any
                ) -> AsyncIterator[str]:  # type: ignore[return]
                    nonlocal _msg_id, _text_started, _todo_tracker
                    async with agent:
                        _run_opts_inner: dict[str, Any] = {}
                        if _is_byok and _byok_provider:
                            _run_opts_inner["model"] = _byok_model_id
                        elif _final_model_early:
                            _run_opts_inner["model"] = _final_model_early
                        _stream = agent.run(
                            _eff, stream=True,
                            options=_run_opts_inner if _run_opts_inner else None,
                            session=_agent_sess,
                        )
                        async for _update in _stream:
                            _upd_role = getattr(_update, "role", None)
                            _upd_role = getattr(_upd_role, "value", _upd_role)
                            for _c in (_update.contents or []):
                                _ct = getattr(_c, "type", None)
                                if _ct == "text":
                                    _delta = _c.text or ""
                                    if not _delta:
                                        continue
                                    # Tool-role text frames (progress lines,
                                    # partial terminal output) belong in the
                                    # thinking timeline — NOT the visible
                                    # assistant message.
                                    if _upd_role == "tool":
                                        # Partial output / progress carrying a
                                        # tool_call_id streams INTO that tool's
                                        # row (live terminal output, VS Code
                                        # style); anonymous frames fall back to
                                        # the generic progress header line.
                                        _raw_ev = _update.raw_representation
                                        _ptc_id = ""
                                        try:
                                            _raw_t = str(getattr(_raw_ev, "type", ""))
                                            if ("PARTIAL_RESULT" in _raw_t
                                                    or "PROGRESS" in _raw_t):
                                                _ptc_id = getattr(
                                                    getattr(_raw_ev, "data", None),
                                                    "tool_call_id", "",
                                                ) or ""
                                        except Exception:  # noqa: BLE001
                                            pass
                                        _pmsg = _delta
                                        if _pmsg.startswith("[progress] "):
                                            _pmsg = _pmsg[len("[progress] "):]
                                        if _ptc_id:
                                            yield _sse({"type": "TOOL_CALL_PARTIAL",
                                                        "toolCallId": _ptc_id,
                                                        "delta": _pmsg[:2000]})
                                        else:
                                            yield _sse({"type": "PROGRESS_UPDATE",
                                                        "message": _pmsg[:200]})
                                        continue
                                    if not _text_started:
                                        _text_started = True
                                        _msg_id = _update.message_id or str(uuid.uuid4())
                                        _log.debug(
                                            "sse_text_start: msg_id=%s",
                                            _msg_id[:12],
                                        )
                                        yield _sse({"type": "TEXT_MESSAGE_START",
                                                    "messageId": _msg_id, "role": "assistant"})
                                    _log.debug(
                                        "sse_text_delta: len=%d msg_id=%s",
                                        len(_delta), (_msg_id or "")[:12],
                                    )
                                    yield _sse({"type": "TEXT_MESSAGE_CONTENT",
                                                "messageId": _msg_id, "delta": _delta})
                                elif _ct == "text_reasoning":
                                    _delta = _c.text or ""
                                    if _delta:
                                        yield _sse({"type": "THINKING_TEXT_MESSAGE_CONTENT",
                                                    "delta": _delta})
                                elif _ct == "function_call":
                                    _tc_id = _c.call_id or ""
                                    _tc_name = _c.name or ""
                                    _tc_args = _c.arguments
                                    _args_str = (json.dumps(_tc_args) if isinstance(_tc_args, dict)
                                                 else str(_tc_args or ""))
                                    # Track CLI todo mutations (sql tool on
                                    # the todos table) → structured panel.
                                    try:
                                        if _todo_tracker.feed(_tc_name, _tc_args):
                                            yield _sse({"type": "TODO_LIST",
                                                        "todos": _todo_tracker.snapshot()})
                                    except Exception:  # noqa: BLE001
                                        pass
                                    yield _sse({"type": "TOOL_CALL_START",
                                                "toolCallId": _tc_id,
                                                "toolCallName": _tc_name,
                                                "args": _args_str})
                                    if _tc_args:
                                        yield _sse({"type": "TOOL_CALL_ARGS",
                                                    "toolCallId": _tc_id,
                                                    "delta": _args_str})
                                elif _ct == "function_result":
                                    _tc_id = _c.call_id or ""
                                    _tc_result = _c.result or ""
                                    _tc_ok = not _c.exception
                                    yield _sse({"type": "TOOL_CALL_RESULT",
                                                "toolCallId": _tc_id,
                                                "content": str(_tc_result)[:2000],
                                                "success": _tc_ok})
                            # Agent intent from raw events
                            _raw = _update.raw_representation
                            if _raw is not None:
                                try:
                                    _raw_type = str(_raw.type)
                                    if "INTENT" in _raw_type:
                                        _intent = getattr(_raw.data, "intent", "") or ""
                                        if _intent:
                                            yield _sse({"type": "TOOL_CALL_START",
                                                        "toolCallId": f"{run_id}:intent:{_intent[:20]}",
                                                        "toolCallName": _intent})
                                except Exception:  # noqa: BLE001
                                    pass

                        # ── Save Copilot session ID before context exits ──
                        # The CopilotClient is closed when async with agent:
                        # exits.  Capture the session ID while still inside
                        # the context manager block.
                        if _agent_runtime == "github-copilot" and thread_id:
                            try:
                                _last_sid = await agent._client.get_last_session_id()
                                _log.info(
                                    "executor.store_copilot_session",
                                    thread_id=thread_id[:12],
                                    sid=str(_last_sid)[:12] if _last_sid else "None",
                                )
                                if _last_sid:
                                    _store_session_id(thread_id, _last_sid)
                                    # Record the model used for this session
                                    # so future requests can detect switches.
                                    _copilot_model_store[thread_id] = (
                                        _final_model_early
                                    )
                            except Exception:  # noqa: BLE001
                                _log.exception("executor.store_session_failed")

                # ── Retry loop: at most 2 attempts ─────────────────────────
                # Attempt 0: normal run (may use a stored Copilot session).
                # Attempt 1 (only if attempt 0 raised a stale-session error):
                #   cleared stale session + history injected as context.
                for _attempt in range(2):
                    _ag_sess: Any = None
                    if _copilot_session_id and not _session_retry_attempted:
                        try:
                            _ag_sess = agent.get_session(_copilot_session_id)
                        except Exception:  # noqa: BLE001
                            pass
                    try:
                        async for _line in _run_copilot_attempt(_effective_msg, _ag_sess):
                            yield _line
                        break  # success — exit retry loop
                    except Exception as _exc:  # noqa: BLE001
                        # ── Gap-1 fix: stale Copilot session ─────────────
                        # After a gateway restart the Copilot CLI process is
                        # dead, so resume_session() raises
                        # "Failed to create GitHub Copilot session: ..."
                        # Detect this, wipe the stale record, inject prior
                        # conversation history, and retry with a new session.
                        _is_resume_err = (
                            not _session_retry_attempted
                            and bool(_copilot_session_id)
                            and (
                                "Failed to create GitHub Copilot session" in str(_exc)
                                or "resume_session" in str(_exc).lower()
                                or (
                                    "session" in str(_exc).lower()
                                    and "error" in str(_exc).lower()
                                )
                            )
                        )
                        if not _is_resume_err:
                            _log.exception(
                                "executor.copilot_maf_stream_error",
                                agent=agent_name,
                            )
                            yield _sse({"type": "RUN_ERROR", "runId": run_id,
                                        "message": str(_exc)})
                            return
                        # Stale session — clear it and prepare a retry.
                        _log.warning(
                            "executor.stale_session_clear",
                            agent=agent_name,
                            thread_id=(thread_id or "")[:16],
                            error=str(_exc)[:120],
                        )
                        _session_retry_attempted = True
                        _copilot_session_id = None  # type: ignore[assignment]
                        _copilot_session_store.pop(thread_id or "", None)
                        _clear_stored_session_id(thread_id)
                        # Inject conversation history so the new session has
                        # context despite losing the Copilot SDK session.
                        _msg_base = (
                            event_payload.get("message")
                            or event_payload.get("user_query")
                            or ""
                        )
                        _prior_msgs = event_payload.get("messages") or []
                        if _prior_msgs:
                            _hist: list[str] = []
                            for _hm in _prior_msgs[-20:]:
                                _hr = _hm.get("role", "user")
                                _hc = (_hm.get("content") or "").strip()
                                if _hc:
                                    _hl = "User" if _hr == "user" else "Assistant"
                                    _hs = _hc if len(_hc) <= 300 else _hc[:300] + "..."
                                    _hist.append(f"{_hl}: {_hs}")
                            if _hist:
                                _effective_msg = (
                                    "## Prior conversation (for context)\n"
                                    + "\n".join(_hist)
                                    + f"\n\n## Current message\n{_msg_base}"
                                )
                                _log.debug(
                                    "executor.session_retry_history_injected",
                                    agent=agent_name,
                                    history_turns=len(_hist),
                                )
                        # Reset streaming state for a clean second attempt.
                        _msg_id = None
                        _text_started = False
                        _todo_tracker = _TodoTracker()
                        # continue → next iteration of retry loop

                if _msg_id and _text_started:
                    yield _sse({"type": "TEXT_MESSAGE_END", "messageId": _msg_id})
                yield _sse({"type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id})

                await _detect_agent_commits(
                    agent_name, str(loaded.agent_dir), run_id,
                    since_sha=_stream_head_before if _stream_head_before else None,
                )
                return

            # ── Tier 2: instrumented batch fallback ─────────────────────────
            # (orphaned old code removed — see CommandCenterCopilotAgent path above)

            # ── Tier 2: instrumented batch fallback ─────────────────────────
            # Wrap every callable tool on the agent so it pushes tool events
            # onto a queue that we drain while the run executes in a task.
            queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
            _t2_token = _active_run_queue.set(queue)  # expose to call_agent for sub-streaming

            _tool_counter: list[int] = [0]

            def _make_tool_shim(original_fn: Any, tool_name: str) -> Any:
                """Return an async wrapper that emits TOOL_CALL_* events."""
                import functools  # noqa: PLC0415
                import inspect  # noqa: PLC0415

                @functools.wraps(original_fn)
                async def _shim(*args: Any, **kwargs: Any) -> Any:
                    _tool_counter[0] += 1
                    tool_call_id = f"{run_id}:{_tool_counter[0]}"

                    # Serialise the arguments for the UI
                    try:
                        call_args: dict[str, Any] = {}
                        sig = inspect.signature(original_fn)
                        bound = sig.bind(*args, **kwargs)
                        bound.apply_defaults()
                        for k, v in bound.arguments.items():
                            try:
                                json.dumps(v)  # only include JSON-serialisable values
                                call_args[k] = v
                            except (TypeError, ValueError):
                                call_args[k] = str(v)
                    except Exception:  # noqa: BLE001
                        call_args = {}

                    await queue.put({
                        "type": "TOOL_CALL_START",
                        "toolCallId": tool_call_id,
                        "toolCallName": tool_name,
                    })
                    # Emit args as a single TOOL_CALL_ARGS frame
                    if call_args:
                        await queue.put({
                            "type": "TOOL_CALL_ARGS",
                            "toolCallId": tool_call_id,
                            "delta": json.dumps(call_args),
                        })

                    try:
                        if inspect.iscoroutinefunction(original_fn):
                            result = await original_fn(*args, **kwargs)
                        else:
                            result = original_fn(*args, **kwargs)
                    except Exception as exc:
                        await queue.put({
                            "type": "TOOL_CALL_RESULT",
                            "toolCallId": tool_call_id,
                            "content": f"Error: {exc}",
                            "success": False,
                        })
                        raise
                    else:
                        result_str = str(result) if result is not None else ""
                        await queue.put({
                            "type": "TOOL_CALL_RESULT",
                            "toolCallId": tool_call_id,
                            "content": result_str[:2000],  # truncate for SSE safety
                            "success": True,
                        })
                        return result

                return _shim

            # Discover and patch tools on the agent.
            # MAF agents expose tools as `agent.tools` (list) or as annotated
            # methods decorated with @tool.  Try both patterns.
            import inspect  # noqa: PLC0415
            patched: list[tuple[str, str, Any]] = []  # (attr, name, original)

            _tool_attrs: list[str] = []
            if hasattr(agent, "tools") and isinstance(agent.tools, (list, tuple)):
                for t in agent.tools:
                    fn = getattr(t, "func", t) if not callable(t) else t
                    attr = getattr(fn, "__name__", None)
                    if attr and hasattr(agent, attr):
                        _tool_attrs.append(attr)
            # Also look for methods marked with @tool decorator (common MAF pattern)
            for name in dir(agent):
                if name.startswith("_"):
                    continue
                val = getattr(type(agent), name, None)
                if val and (
                    getattr(val, "_is_tool", False)
                    or getattr(val, "is_tool", False)
                    or getattr(val, "__tool__", False)
                ):
                    _tool_attrs.append(name)

            for attr in set(_tool_attrs):
                original = getattr(agent, attr, None)
                if original and callable(original):
                    shim = _make_tool_shim(original, attr)
                    try:
                        object.__setattr__(agent, attr, shim)
                        patched.append((attr, attr, original))
                    except (AttributeError, TypeError):
                        pass  # some agents use __slots__ or properties — skip

            # Shim injected tools that live only in agent.tools (not as agent attributes).
            # These include call_agent, web_search, fetch_page — appended by
            # _inject_agent_tools.  They are NOT reachable via getattr(agent, name), so
            # the loop above misses them.  We shim them in-place in the list so the
            # Tier 2 stream also shows TOOL_CALL_START/END events for delegation and
            # web calls.
            _shimmed_list_indices: list[tuple[int, Any]] = []  # (index, original)
            if hasattr(agent, "tools") and isinstance(agent.tools, (list, tuple)):
                _tools_list = agent.tools
                for _idx, _t in enumerate(_tools_list):
                    _fn = getattr(_t, "func", _t)
                    _fn_name = getattr(_fn, "__name__", None)
                    if _fn_name and not hasattr(agent, _fn_name) and callable(_fn):
                        _shim = _make_tool_shim(_fn, _fn_name)
                        try:
                            _tools_list[_idx] = _shim
                            _shimmed_list_indices.append((_idx, _t))
                        except (AttributeError, TypeError):
                            pass

            # Run the agent in a background task.
            message = _build_event_message(agent_name, run_id, event_payload, integrations)

            import contextlib  # noqa: PLC0415

            async def _run_task() -> str:
                async with contextlib.AsyncExitStack() as stack:
                    # Pre-configure CopilotClient to deny the built-in shell tool.
                    # On Windows the shell tool requires pwsh.exe (PowerShell 7+) which
                    # may not be installed.  Our Python tools (e.g. zoho_crm) work fine
                    # without it, and we don't want the LLM to fall back to shell execution.
                    try:
                        from copilot import \
                            CopilotClient as _CopilotClient  # noqa: PLC0415
                        if hasattr(agent, "_client") and agent._client is None:
                            _agent_settings = getattr(agent, "_settings", {}) or {}
                            _cli_opts: dict[str, Any] = {}
                            # For GitHub Copilot agents (repo-sourced), allow all tools
                            # including shell — pwsh 7.6.2 is installed. For local/built-in
                            # MAF agents with Python tools, deny shell to prevent the LLM
                            # from bypassing structured Python tools with raw shell calls.
                            if _agent_runtime != "github-copilot":
                                _cli_opts["cli_args"] = ["--deny-tool", "shell"]
                            _cli_path = _agent_settings.get("cli_path")
                            if _cli_path:
                                _cli_opts["cli_path"] = _cli_path
                            _log_level = _agent_settings.get("log_level")
                            if _log_level:
                                _cli_opts["log_level"] = _log_level
                            # Headless auth: explicit Copilot token (servers
                            # have no logged-in copilot CLI user).
                            _cop_tok = (
                                os.environ.get("COPILOT_GITHUB_TOKEN")
                                or os.environ.get("GITHUB_COPILOT_TOKEN")
                                or ""
                            ).strip()
                            if _cop_tok:
                                _cli_opts["github_token"] = _cop_tok
                            agent._client = _CopilotClient(_cli_opts if _cli_opts else None)
                            agent._owns_client = True
                    except Exception:  # noqa: BLE001
                        pass

                    if hasattr(type(agent), "__aenter__"):
                        await stack.enter_async_context(agent)
                    # Apply approve_all permission handler if needed (GitHubCopilotAgent)
                    try:
                        from copilot import \
                            PermissionHandler as _PH  # noqa: PLC0415
                        if hasattr(agent, "_permission_handler") and agent._permission_handler is None:
                            agent._permission_handler = _PH.approve_all
                    except Exception:  # noqa: BLE001
                        pass
                    # For BYOK MAF agents, pass history as proper MAF Message objects
                    # so the LLM sees full user/assistant turn structure (not just a
                    # flat string). Falls back to string-only for other runtimes.
                    # Cap at last 10 exchanges (20 msgs) to stay within provider limits —
                    # Groq free tier has a 6000-token hard limit; even paid tiers benefit
                    # from a tighter window when tools inject large schemas.
                    _history_msgs = event_payload.get("messages") or []
                    _current_msg_text = event_payload.get("message") or event_payload.get("user_query") or ""
                    if _is_byok_early and _history_msgs:
                        try:
                            from agent_framework import \
                                Message as _MAFMsg  # noqa: PLC0415
                            _maf_messages: list[Any] = []
                            # Keep only the last 20 prior messages (10 exchanges)
                            for _h in _history_msgs[-20:]:
                                _h_role = _h.get("role", "user")
                                _h_content = (_h.get("content") or "").strip()
                                if not _h_content:
                                    continue
                                # Skip the current user message if already in history
                                if _h_role == "user" and _h_content == _current_msg_text.strip():
                                    continue
                                _maf_messages.append(_MAFMsg(role=_h_role, content=_h_content))
                            # Append the current user message
                            if _current_msg_text.strip():
                                _maf_messages.append(_MAFMsg(role="user", content=_current_msg_text.strip()))
                            response = await agent.run(_maf_messages if _maf_messages else message)
                        except Exception:  # noqa: BLE001
                            response = await agent.run(message)  # fallback
                    else:
                        response = await agent.run(message)
                return getattr(response, "text", "") or ""

            run_task = asyncio.create_task(_run_task())

            # Drain the queue until the task finishes.
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=0.1)
                    if ev is None:
                        break
                    yield _sse(ev)
                except asyncio.TimeoutError:
                    if run_task.done():
                        # Drain any remaining events
                        while not queue.empty():
                            ev = queue.get_nowait()
                            if ev:
                                yield _sse(ev)
                        break

            _active_run_queue.reset(_t2_token)  # restore after drain

            # Restore patched tools (attribute-based)
            for attr, _, original in patched:
                try:
                    object.__setattr__(agent, attr, original)
                except Exception:  # noqa: BLE001
                    pass

            # Restore shimmed list entries
            if hasattr(agent, "tools") and isinstance(agent.tools, (list, tuple)):
                for _idx, _orig in _shimmed_list_indices:
                    try:
                        agent.tools[_idx] = _orig
                    except Exception:  # noqa: BLE001
                        pass

            # Get the final text result
            try:
                text = await run_task
            except AgentRunError:
                raise
            except Exception as exc:
                raise exc

            # Strip integration setup tokens (same as batch path)
            setup_token_re = __import__("re").compile(r"<<<SETUP:[^>]+>>>")
            raw_matches = __import__("re").findall(
                r"<<<SETUP:([^:]+):([A-Z0-9_]+)=([^>]+)>>>", text
            )
            if raw_matches:
                text = setup_token_re.sub("", text).strip()
                vars_to_save = [{"key": k, "value": v.strip()} for _, k, v in raw_matches if v.strip()]
                if vars_to_save:
                    _GATEWAY_URL = settings.gateway_base_url if hasattr(settings, "gateway_base_url") else "http://127.0.0.1:8000"
                    _token = getattr(settings, "gateway_internal_token", "") or getattr(settings, "litellm_master_key", "")
                    try:
                        import httpx  # noqa: PLC0415
                        async with httpx.AsyncClient(timeout=5) as c:
                            await c.post(
                                f"{_GATEWAY_URL}/integrations/configure",
                                json={"vars": vars_to_save},
                                headers={"Authorization": f"Bearer {_token}"},
                            )
                    except Exception:  # noqa: BLE001
                        pass

            # Emit the final text as TOKEN-STREAMED TEXT_MESSAGE_CONTENT deltas
            # (word-by-word so the UI renders progressively instead of all at once).
            words = text.split(" ")
            msg_id = str(uuid.uuid4())
            yield _sse({
                "type": "TEXT_MESSAGE_START",
                "messageId": msg_id,
                "role": "assistant",
            })
            chunk: list[str] = []
            for word in words:
                chunk.append(word)
                if len(chunk) >= 3:
                    yield _sse({
                        "type": "TEXT_MESSAGE_CONTENT",
                        "messageId": msg_id,
                        "delta": " ".join(chunk) + " ",
                    })
                    chunk = []
                    await asyncio.sleep(0)  # yield event loop so SSE flushes
            if chunk:
                yield _sse({
                    "type": "TEXT_MESSAGE_CONTENT",
                    "messageId": msg_id,
                    "delta": " ".join(chunk),
                })
            yield _sse({"type": "TEXT_MESSAGE_END", "messageId": msg_id})
            # RUN_FINISHED must be emitted INSIDE the try block — the finally
            # below resets the relay contextvar and marks the thread inactive,
            # so a later yield would never reach Redis (reconnecting clients
            # would hang waiting for the run to finish).
            yield _sse({"type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id})

    except AgentRunError:
        raise
    except Exception as exc:
        yield _sse({
            "type": "RUN_ERROR",
            "message": str(exc),
            "code": type(exc).__name__,
        })
        return
    finally:
        # Deactivate stream relay so the reconnect endpoint knows the run
        # has finished and can drain remaining events from the Redis stream.
        # Wait for any in-flight ordered pushes first so RUN_FINISHED lands
        # in Redis BEFORE the active flag is cleared.
        _pending_push = _push_chains.get(thread_id)
        if _pending_push is not None:
            try:
                await _pending_push
            except Exception:  # noqa: BLE001
                pass
        _stream_relay_thread_id.reset(_relay_token)
        if _relay_mark_inactive is not None:
            try:
                await _relay_mark_inactive(thread_id)
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# Self-annealing engine  DETECT → FIX → RETRY → LLM RECOVERY
# ---------------------------------------------------------------------------

def _classify_error(exc: Exception) -> str:
    """Return a short error class label used to pick the right fix strategy."""
    msg = str(exc).lower()
    etype = type(exc).__name__
    if isinstance(exc, UnicodeDecodeError):
        return "encoding"
    if isinstance(exc, (IndexError, KeyError)):
        return "index"
    if isinstance(exc, ImportError):
        return "import"
    if any(t in msg for t in ("rate limit", "ratelimit", "429", "overload")):
        return "rate_limit"
    if any(t in msg for t in ("timeout", "connection", "503", "unavailable")):
        return "transient"
    if "no choices" in msg or "choices" in msg:
        return "empty_choices"
    if "api key" in msg or "authentication" in msg or "unauthorized" in msg:
        return "auth"
    return f"unknown:{etype}"


def _fix_encoding_in_dir(agent_dir: str | None) -> bool:
    """Replace cp1252 smart-quote bytes with their UTF-8 equivalents in all
    .md and .py files under *agent_dir*. Returns True if anything was fixed."""
    if not agent_dir:
        return False
    _CP1252_MAP = {
        b"\x96": "\u2013".encode(),   # en-dash
        b"\x97": "\u2014".encode(),   # em-dash
        b"\x91": "\u2018".encode(),   # left single quote
        b"\x92": "\u2019".encode(),   # right single quote
        b"\x93": "\u201c".encode(),   # left double quote
        b"\x94": "\u201d".encode(),   # right double quote
        b"\x85": "\u2026".encode(),   # ellipsis
    }
    fixed_any = False
    for p in Path(agent_dir).rglob("*"):
        if p.suffix not in {".md", ".py", ".txt"} or not p.is_file():
            continue
        raw = p.read_bytes()
        if not any(b in raw for b in _CP1252_MAP):
            continue
        patched = raw
        for bad, good in _CP1252_MAP.items():
            patched = patched.replace(bad, good)
        try:
            patched.decode("utf-8")   # verify the result is valid UTF-8
            p.write_bytes(patched)
            fixed_any = True
            _log.info("self_anneal.encoding_fixed", file=str(p))
        except UnicodeDecodeError:
            pass   # skip files with more exotic encodings
    return fixed_any


async def _self_anneal(
    *,
    agent_name: str,
    run_id: str,
    thread_id: str,
    event_payload: dict[str, Any],
    agent_dir: str | None,
    error: Exception,
) -> dict[str, Any] | None:
    """Self-annealing loop.

    1. Classify the error.
    2. Apply an in-process fix if one exists for this error class.
    3. Retry the graph (up to _MAX_ANNEAL_ATTEMPTS times).
    4. If all retries fail, ask the LLM to explain + suggest next steps.
    5. Return None only when even the LLM call fails — caller then raises.
    """
    error_class = _classify_error(error)
    _log.info(
        "self_anneal.start",
        agent=agent_name, run_id=run_id,
        error_class=error_class, error=str(error)[:200],
    )

    # ── In-process fixes ──────────────────────────────────────────────────
    if error_class == "encoding":
        if _fix_encoding_in_dir(agent_dir):
            _log.info("self_anneal.encoding_fix_applied", agent=agent_name)
            # Reload the agent and retry
            for attempt in range(_MAX_ANNEAL_ATTEMPTS):
                await asyncio.sleep(0.5 * (attempt + 1))
                try:
                    from acb_skills.integrations import \
                        build_integrations as _bi  # noqa: PLC0415
                    from acb_skills.loader import \
                        load_agent as _load  # noqa: PLC0415
                    settings = get_settings()
                    with _load(agent_name, run_id=run_id) as loaded:
                        integrations, integration_warnings = _bi(
                            loaded.config.get("integrations", []),
                            loaded.config.get("optional_integrations", []),
                            settings,
                        )
                        agents = loaded.build_agents()
                        _inject_agent_tools(agents)
                        result = await _run_with_maf_agent(
                            agents,
                            agent_name=agent_name,
                            run_id=run_id,
                            thread_id=thread_id,
                            event_payload={
                                **event_payload,
                                "integration_warnings": integration_warnings,
                            },
                            integrations=integrations,
                        )
                    _log.info("self_anneal.retry_success",
                              agent=agent_name, attempt=attempt + 1)
                    return result
                except Exception as retry_exc:  # noqa: BLE001
                    _log.warning("self_anneal.retry_failed",
                                 agent=agent_name, attempt=attempt + 1,
                                 error=str(retry_exc)[:200])
                    error = retry_exc  # update for LLM recovery below

    elif error_class in ("transient", "rate_limit", "empty_choices"):
        for attempt in range(_MAX_ANNEAL_ATTEMPTS):
            wait = 2 ** (attempt + 1)   # 2 s, 4 s
            _log.info("self_anneal.transient_retry",
                      agent=agent_name, attempt=attempt + 1, wait=wait)
            await asyncio.sleep(wait)
            try:
                settings = get_settings()
                from acb_skills.integrations import \
                    build_integrations as _bi  # noqa: PLC0415
                from acb_skills.loader import \
                    load_agent as _load  # noqa: PLC0415
                with _load(agent_name, run_id=run_id) as loaded:
                    integrations, integration_warnings = _bi(
                        loaded.config.get("integrations", []),
                        loaded.config.get("optional_integrations", []),
                        settings,
                    )
                    agents = loaded.build_agents()
                    _inject_agent_tools(agents)
                    result = await _run_with_maf_agent(
                        agents,
                        agent_name=agent_name,
                        run_id=run_id,
                        thread_id=thread_id,
                        event_payload={
                            **event_payload,
                            "integration_warnings": integration_warnings,
                        },
                        integrations=integrations,
                    )
                _log.info("self_anneal.retry_success",
                          agent=agent_name, attempt=attempt + 1)
                return result
            except Exception as retry_exc:  # noqa: BLE001
                _log.warning("self_anneal.retry_failed",
                             agent=agent_name, attempt=attempt + 1,
                             error=str(retry_exc)[:200])
                error = retry_exc

    # ── LLM recovery: explain the error in plain language ─────────────────
    return await _llm_recovery(agent_name, event_payload, error, error_class)


async def _llm_recovery(
    agent_name: str,
    event_payload: dict[str, Any],
    error: Exception,
    error_class: str,
) -> dict[str, Any] | None:
    """Ask the LLM to produce a helpful natural-language recovery reply."""
    # Map known error classes to user-facing hints so the LLM can be specific.
    _HINTS: dict[str, str] = {
        "auth": (
            "The problem is a missing or invalid API key. "
            "Tell the user which integration needs to be configured and how to do it "
            "using the <<<SETUP:service:ENV_VAR=value>>> token."
        ),
        "encoding": (
            "The problem was a file encoding error (bad bytes in a config or skill file). "
            "The system has already attempted an automatic fix. "
            "Ask the user to try their request again."
        ),
        "rate_limit": (
            "The LLM provider hit a rate limit. "
            "Suggest the user waits 30 seconds and tries again."
        ),
        "import": (
            "A required Python package is missing. "
            "Tell the user which package and suggest installing it."
        ),
    }
    hint = _HINTS.get(error_class, "")

    try:
        from acb_llm import LLMTier, complete  # noqa: PLC0415

        messages: list[dict[str, str]] = list(event_payload.get("messages", []))
        latest: str = event_payload.get("message", "")

        system = (
            f"You are {agent_name}, a helpful AI assistant. "
            "An internal error just occurred. "
            "Respond directly to the user's last message as helpfully as possible. "
            "Apologise briefly (one sentence), then either complete the task "
            "using a simpler approach, or tell the user exactly what to do next. "
            f"{hint} "
            "Never show raw Python tracebacks or variable names. Be concise."
        )
        recovery_msgs: list[dict[str, str]] = [
            {"role": "system", "content": system},
            *messages,
            *(
                [{"role": "user", "content": latest}]
                if latest and (not messages or messages[-1].get("role") != "user")
                else []
            ),
            {
                "role": "user",
                "content": (
                    f"[Internal error — do not repeat to user] "
                    f"{type(error).__name__}: {str(error)[:300]}"
                ),
            },
        ]

        content = await complete(
            tier=LLMTier.TIER_2,
            messages=recovery_msgs,
            max_tokens=400,
        )
        _log.info("self_anneal.llm_recovery_success", agent=agent_name)
        return {"result": {"role": "assistant", "content": content}}
    except Exception as llm_exc:  # noqa: BLE001
        _log.warning("self_anneal.llm_recovery_failed",
                     agent=agent_name, error=str(llm_exc))
        return None


# ---------------------------------------------------------------------------
# Internal: run a MAF agent list (replaces LangGraph _execute_graph)
# ---------------------------------------------------------------------------

def _inject_integrations_to_env(integrations: dict[str, Any]) -> None:
    """Export resolved integration credentials into os.environ.

    Skill scripts call os.getenv("ZOHO_CLIENT_ID") etc. directly.  The executor
    resolves credentials into a structured dict but never writes them to the
    process environment — so subprocesses spawned by agent tool functions can't
    find them.  This function closes that gap by mapping the structured dict
    fields back to the canonical env var names.

    Only sets vars that are not already in os.environ (gateway .env takes
    precedence; this fills in anything that pydantic-settings loaded but didn't
    export).
    """
    import os  # noqa: PLC0415

    _FIELD_TO_ENV: dict[str, list[tuple[str, str]]] = {
        # (integration_name): [(field_in_dict, ENV_VAR_NAME), ...]
        "zoho-crm": [
            ("client_id",     "ZOHO_CLIENT_ID"),
            ("client_secret", "ZOHO_CLIENT_SECRET"),
            ("refresh_token", "ZOHO_REFRESH_TOKEN"),
            ("api_domain",    "ZOHO_API_DOMAIN"),
            ("accounts_url",  "ZOHO_ACCOUNTS_URL"),
            ("region",        "ZOHO_REGION"),
        ],
        "clickup": [
            ("api_token",   "CLICKUP_API_TOKEN"),
            ("workspace_id", "CLICKUP_WORKSPACE_ID"),
        ],
        "apollo":        [("api_key", "APOLLO_API_KEY")],
        "serpapi":       [("api_key", "SERPAPI_API_KEY")],
        "apify":         [("api_token", "APIFY_API_TOKEN")],
        "anymailfinder": [("api_key", "ANYMAILFINDER_API_KEY")],
        "instantly":     [("api_key", "INSTANTLY_API_KEY")],
        "gmail":         [("sa_json_path", "GMAIL_SA_JSON_PATH"), ("default_user", "GMAIL_DEFAULT_USER")],
        "gmail-send":    [("sa_json_path", "GMAIL_SA_JSON_PATH"), ("default_user", "GMAIL_DEFAULT_USER")],
        "smtp":          [("host", "SMTP_HOST"), ("username", "SMTP_USERNAME"), ("password", "SMTP_PASSWORD")],
        "google-sheets": [("sa_json_path", "GOOGLE_SHEETS_SA_JSON_PATH")],
        "litellm":       [("base_url", "LITELLM_BASE_URL"), ("api_key", "LITELLM_API_KEY")],
    }

    for service, creds in integrations.items():
        if not isinstance(creds, dict):
            continue
        for field, env_var in _FIELD_TO_ENV.get(service, []):
            val = creds.get(field, "")
            if val and not os.environ.get(env_var):
                os.environ[env_var] = str(val)


async def _run_with_maf_agent(
    agents: list[Any],
    *,
    agent_name: str,
    run_id: str,
    thread_id: str,
    event_payload: dict[str, Any],
    integrations: dict[str, Any],
) -> dict[str, Any]:
    """Execute the primary agent from *agents* via MAF and return a normalised result dict.

    Accepts any MAF ``BaseAgent`` subclass including ``GitHubCopilotAgent``.
    Automatically calls ``start()`` / ``stop()`` if the agent supports it.
    """
    import contextlib  # noqa: PLC0415

    if not agents:
        raise ValueError(f"Agent {agent_name!r}: build_agents() returned an empty list.")

    agent = agents[0]

    # GitHubCopilotAgent requires on_permission_request to approve tool calls.
    # Agent repos often omit it; patch _permission_handler directly so sessions
    # are created without raising AgentException.
    # PermissionHandler lives in the underlying `copilot` SDK package.
    try:
        from copilot import PermissionHandler as _PH  # noqa: PLC0415
        for _a in agents:
            if hasattr(_a, "_permission_handler") and _a._permission_handler is None:
                _a._permission_handler = _PH.approve_all
    except Exception:  # noqa: BLE001
        pass

    # Build the input for agent.run().
    # For chat events that carry a prior message history (payload["messages"]),
    # pass the full conversation as a Sequence[Message] so the LLM has proper
    # multi-turn context. For webhook / event-driven payloads (no "messages" key),
    # fall back to the single-string path which serialises the event payload.
    run_input: Any
    prior_msgs: list[dict[str, str]] = event_payload.get("messages") or []
    current_msg: str = event_payload.get("message") or event_payload.get("user_query") or ""

    if prior_msgs and current_msg:
        # Chat path: reconstruct proper Message sequence so the LLM sees the
        # full conversation window, not just the latest turn.
        try:
            from agent_framework._types import \
                Message as _Message  # noqa: PLC0415

            # Build the preamble (integrations / warnings) as a system message.
            system_parts: list[str] = []
            integration_warnings: dict[str, str] = event_payload.get("integration_warnings", {})
            if integrations:
                system_parts.append(
                    "Connected integrations: " + ", ".join(sorted(integrations.keys())) + "."
                )
            if integration_warnings:
                missing = ", ".join(sorted(integration_warnings.keys()))
                system_parts.append(
                    f"Missing integrations (not yet configured): {missing}. "
                    "If the user task requires one of these, ask them to provide the credential. "
                    "When they do, output: <<<SETUP:service_name:ENV_VAR_NAME=value>>>"
                )

            messages_for_run: list[Any] = []
            if system_parts:
                messages_for_run.append(_Message("system", ["\n".join(system_parts)]))

            # Prior turns — cap at last 50 to stay within context windows.
            for m in prior_msgs[-50:]:
                role = m.get("role", "user")
                content = m.get("content", "")
                if content.strip() and role in ("user", "assistant", "system"):
                    messages_for_run.append(_Message(role, [content]))

            # Append current user message (may already be the last item in
            # prior_msgs, but prior_msgs is sent BEFORE the new message is added).
            messages_for_run.append(_Message("user", [current_msg]))

            run_input = messages_for_run
        except Exception:  # noqa: BLE001
            # Fallback: MAF version mismatch — use plain string
            run_input = _build_event_message(agent_name, run_id, event_payload, integrations)
    else:
        # Webhook / event path: single string prompt.
        run_input = _build_event_message(agent_name, run_id, event_payload, integrations)

    # Inject resolved integration credentials into os.environ so that tool
    # subprocesses (e.g. zoho_crm.py calling os.getenv("ZOHO_CLIENT_ID")) can
    # read them. This bridges the gap between the structured integrations dict
    # and the env-var-based credential reading in skill scripts.
    _inject_integrations_to_env(integrations)

    async with contextlib.AsyncExitStack() as stack:
        # GitHubCopilotAgent (and any agent with lifecycle) requires start/stop.
        # Standard Agent has a no-op __aenter__/__aexit__ — both are safe here.
        if hasattr(type(agent), "__aenter__"):
            await stack.enter_async_context(agent)
        response = await agent.run(run_input)

    text: str = getattr(response, "text", "") or ""
    return {"answer": text, "run_id": run_id, "agent": agent_name, "result": text}


def _build_event_message(
    agent_name: str,
    run_id: str,
    event_payload: dict[str, Any],
    integrations: dict[str, Any],
) -> str:
    """Compose a prompt string from an event payload dict.

    Handles both interactive chat events (payload has ``message`` key) and
    webhook events (arbitrary payload keys).

    When ``messages`` is present in the payload (chat history from the frontend),
    it is prepended as conversation context so the agent has full continuity
    regardless of which model/runtime processed previous turns.
    """
    integration_warnings: dict[str, str] = event_payload.get("integration_warnings", {})
    parts: list[str] = []

    # Integration availability context (mirrors old _build_initial_state system message)
    if integrations:
        parts.append("Connected integrations: " + ", ".join(sorted(integrations.keys())) + ".")
    if integration_warnings:
        missing = ", ".join(sorted(integration_warnings.keys()))
        parts.append(
            f"Missing integrations (not yet configured): {missing}. "
            "If the user task requires one of these, ask them to provide the credential. "
            "When they do, output: <<<SETUP:service_name:ENV_VAR_NAME=value>>>"
        )

    # Conversation history — prepend prior turns so model switching mid-chat
    # preserves full context even when switching between CLI / BYOK / MAF paths.
    history: list[dict[str, str]] = event_payload.get("messages") or []
    current_msg = event_payload.get("message") or event_payload.get("user_query") or ""

    # Memory context (pre-enriched by the route handler from Mem0) —
    # inject as a system-level preamble so Tier 2 agents also benefit.
    memory_ctx = event_payload.get("memory_context") or ""
    if memory_ctx:
        parts.append("## Memory from past conversations\n" + memory_ctx)
    if history:
        history_lines: list[str] = []
        # Cap at last 20 messages (10 exchanges) to avoid context/payload limits.
        for m in history[-20:]:
            role = m.get("role", "user")
            content = (m.get("content") or "").strip()
            if not content:
                continue
            # Skip the current message if it's already in history (frontend may append it)
            if role == "user" and content == current_msg.strip():
                continue
            label = "User" if role == "user" else "Assistant"
            # Truncate very long assistant messages (e.g. tool output dumps)
            short = content if len(content) <= 800 else content[:800] + "…"
            history_lines.append(f"{label}: {short}")
        if history_lines:
            parts.append("Conversation history:\n" + "\n".join(history_lines))

    # Main user message — prefer explicit "message" or "user_query" keys
    if current_msg:
        parts.append(current_msg)
    else:
        # Webhook / event-driven path: serialise key payload fields as context
        import json  # noqa: PLC0415
        skip = {"integration_warnings", "messages"}
        keys = [k for k in event_payload if k not in skip]
        if keys:
            parts.append(
                f"Event payload: {json.dumps({k: event_payload[k] for k in keys[:10]}, default=str)}"
            )

    return "\n".join(parts) if parts else f"[Agent run: {agent_name} / {run_id}]"


# ---------------------------------------------------------------------------
# Copilot SDK session continuity — store/restore service_session_id so
# MAF's _get_or_create_session can call resume_session() across requests.
# ---------------------------------------------------------------------------

# In-memory store: thread_id → Copilot service_session_id
# Survives browser disconnects within the same gateway process.
_copilot_session_store: dict[str, str] = {}

# Companion store: thread_id → model name used for that session.
# Used to detect model switches mid-thread so a new Copilot SDK
# session can be created with the updated model while injecting
# conversation history from messages[].
_copilot_model_store: dict[str, str] = {}


def _get_stored_session_id(thread_id: str) -> str | None:
    """Return the previously stored Copilot service_session_id for this thread."""
    sid = _copilot_session_store.get(thread_id)
    # Also try Postgres for cross-restart durability
    if not sid:
        try:
            from acb_graph import get_session as _db_session  # noqa: PLC0415
            from sqlalchemy import text  # noqa: PLC0415
            with _db_session() as s:
                row = s.execute(
                    text("SELECT service_session_id FROM chat_session WHERE id = :id"),
                    {"id": thread_id},
                ).fetchone()
            if row and row.service_session_id:
                sid = row.service_session_id
                _copilot_session_store[thread_id] = sid
        except Exception:  # noqa: BLE001
            pass
    return sid


def _store_session_id(thread_id: str, service_session_id: str) -> None:
    """Persist the Copilot service_session_id for future requests."""
    _copilot_session_store[thread_id] = service_session_id
    # Also persist to Postgres — use UPSERT so the row is created if it
    # doesn't exist yet (the chat_session may be created by the frontend
    # AFTER the agent finishes, or never at all for named-agent chats).
    try:
        from acb_graph import get_session as _db_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        def _write():
            with _db_session() as s:
                s.execute(
                    text(
                        "INSERT INTO chat_session "
                        "(id, user_id, agent_name, service_session_id) "
                        "VALUES (:id, :uid, :agent, :sid) "
                        "ON CONFLICT (id) DO UPDATE SET "
                        "service_session_id = EXCLUDED.service_session_id, "
                        "updated_at = now()"
                    ),
                    {
                        "id": thread_id,
                        "uid": "system",
                        "agent": "unknown",
                        "sid": service_session_id,
                    },
                )
                s.commit()
        import asyncio as _aio
        _aio.get_event_loop().run_in_executor(None, _write)
    except Exception:  # noqa: BLE001
        pass


def _clear_stored_session_id(thread_id: str | None) -> None:
    """Delete the stored Copilot service_session_id for *thread_id*.

    Called when a resume fails (stale session after gateway restart) so
    the next request creates a fresh Copilot SDK session instead of
    retrying a dead service_session_id.
    """
    if not thread_id:
        return
    _copilot_session_store.pop(thread_id, None)
    try:
        from acb_graph import get_session as _db_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        def _write() -> None:
            with _db_session() as s:
                s.execute(
                    text(
                        "UPDATE chat_session "
                        "SET service_session_id = NULL, updated_at = now() "
                        "WHERE id = :id"
                    ),
                    {"id": thread_id},
                )
                s.commit()

        import asyncio as _aio
        _aio.get_event_loop().run_in_executor(None, _write)
    except Exception:  # noqa: BLE001
        pass


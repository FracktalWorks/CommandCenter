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
import contextlib
import contextvars
import functools
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

# ── Tool execution timeout ────────────────────────────────────────────────
# When the agent calls a tool (shell command, sub-agent, web fetch, etc.),
# the tool runs inside the Copilot SDK's async event loop.  If the tool
# hangs (infinite loop, waiting for stdin, network partition), the entire
# stream blocks forever.  This timeout bounds individual tool execution so
# a hung tool is detected and surfaced as an error instead of a silent hang.
# Set via COPILOT_TOOL_TIMEOUT_SECONDS (default 300 = 5 min).
_TOOL_EXECUTION_TIMEOUT: float = float(
    os.environ.get("COPILOT_TOOL_TIMEOUT_SECONDS", "300")
)

# ── Elicitation bridge: track which tool_call_id maps to a pending
# ask_questions Future so cleanup only fires for the matching result.
_elicitation_tc_ids: dict[str, str] = {}

_log = get_logger("orchestrator.executor")

# Pre-compiled regex for tool result clearing (technique #1).
# Matches tool-result code blocks embedded in assistant messages so they can
# be stripped from old history turns — avoids re-sending 5k-token API dumps.
_TOOL_RESULT_RE = re.compile(
    r"\n?(?:Tool call|\[tool\]|```json)[^`]*```", re.S
)

# ContextVar that holds the active SSE queue for the current agent run.
# Set by run_agent_stream so that call_agent (injected as a tool) can push
# SUB_AGENT_* events into the parent stream, making sub-agent progress visible
# in the UI in real time.
_active_run_queue: contextvars.ContextVar["asyncio.Queue[dict[str, Any] | None] | None"] = (
    contextvars.ContextVar("_active_run_queue", default=None)
)

# ContextVar that bridges the executor's ask_questions detection with the
# ask_questions tool function.  When the executor sees the Copilot SDK about
# to call ask_questions, it generates a request_id, creates a
# _pending_user_input Future, and sets this ContextVar so the tool function
# can find the Future and block on it (instead of returning immediately via
# the non-blocking Path B which causes the chat to die without output).
_active_elicitation_request_id: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("_active_elicitation_request_id", default=None)
)

# ContextVar that holds the current thread_id for stream relay tee-ing.
# When set, every _sse() call automatically pushes the event to Redis Stream
# so the reconnect endpoint can replay missed events after a disconnect.
_stream_relay_thread_id: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("_stream_relay_thread_id", default=None)
)

# ContextVar that holds the resolved model/tier of the CURRENT agent run, so
# sub-agents spawned via call_agent / call_agents_parallel / delegate_to_agent
# inherit the parent's tier instead of silently falling back to their own
# config default. Set inside run_agent_stream once the model is resolved.
_active_run_model: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("_active_run_model", default=None)
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


# ── Native HITL (Copilot SDK ask_user) ─────────────────────────────────────
# The Copilot SDK's built-in ``ask_user`` tool is enabled by registering an
# ``on_user_input_request`` handler.  The handler is awaited by the SDK and
# BLOCKS the agent turn until it returns the user's answer — this is the
# correct way to pause/resume a run (unlike the fire-and-forget custom
# ``ask_questions`` tool, which forced the user's reply to queue as a new
# message).  The handler emits a ``user_input_requested`` SSE frame to the
# live stream and parks on an asyncio.Future until the frontend POSTs the
# answer to ``/agent/respond-input`` (which calls :func:`resolve_user_input`).
_pending_user_input: dict[str, "asyncio.Future[dict[str, Any]]"] = {}

# How long the agent waits for a human answer before giving up (seconds).
_USER_INPUT_TIMEOUT = int(os.environ.get("ASK_USER_TIMEOUT", "3600"))


def resolve_user_input(
    request_id: str, answer: str, was_freeform: bool = True
) -> bool:
    """Resolve a pending ``ask_user`` request with the user's answer.

    Called by the gateway ``/agent/respond-input`` route.  Returns True when
    a matching pending request was found and resolved, False otherwise.
    """
    fut = _pending_user_input.get(request_id)
    if fut is None or fut.done():
        return False
    payload = {"answer": answer, "wasFreeform": was_freeform}
    try:
        loop = fut.get_loop()
    except Exception:  # noqa: BLE001
        if not fut.done():
            fut.set_result(payload)
        return True
    loop.call_soon_threadsafe(
        lambda: (not fut.done()) and fut.set_result(payload)
    )
    return True


def _make_user_input_handler(thread_id: str) -> Any:
    """Build an ``on_user_input_request`` handler bound to *thread_id*.

    The returned coroutine emits a ``user_input_requested`` event straight to
    the Redis relay (the streaming generator is parked awaiting ``agent.run``
    and cannot yield this frame itself) and blocks until the answer arrives.
    """

    async def _handler(request: Any, _ctx: Any) -> dict[str, Any]:
        global _sse_seq
        import time as _time  # noqa: PLC0415
        import uuid as _uuid  # noqa: PLC0415

        if isinstance(request, dict):
            question = request.get("question", "") or ""
            choices = request.get("choices") or []
            allow_freeform = request.get("allowFreeform", True)
        else:
            question = getattr(request, "question", "") or ""
            choices = getattr(request, "choices", None) or []
            allow_freeform = getattr(request, "allowFreeform", True)

        request_id = _uuid.uuid4().hex
        payload: dict[str, Any] = {
            "type": "CUSTOM",
            "name": "user_input_requested",
            "value": {
                "request_id": request_id,
                "question": str(question),
                "choices": [str(c) for c in choices],
                "allowFreeform": bool(allow_freeform),
            },
        }
        _sse_seq += 1
        payload["_stream_id"] = f"local-{int(_time.time() * 1000)}-{_sse_seq}"
        line = f"data: {json.dumps(payload)}\n\n"

        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        _pending_user_input[request_id] = fut

        # Push to the relay so the live HTTP subscriber receives the prompt.
        await _push_sse_to_stream(thread_id, line)

        try:
            result = await asyncio.wait_for(
                fut, timeout=_USER_INPUT_TIMEOUT
            )
        except (asyncio.TimeoutError, asyncio.CancelledError):
            result = {"answer": "", "wasFreeform": True}
        finally:
            _pending_user_input.pop(request_id, None)

        return {
            "answer": str(result.get("answer", "")),
            "wasFreeform": bool(result.get("wasFreeform", True)),
        }

    return _handler


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


def _unwrap_json_param(raw: Any, param_name: str) -> Any:
    """Parse a tool parameter that may be a JSON string with double-wrapping.

    Our injected tools take ``str`` parameters that are themselves JSON
    (e.g. ``manage_todo_list(todoList: str)``).  The LLM naturally
    constructs ``{"todoList": [...]}`` and passes it as the string value
    of the ``todoList`` parameter, creating a double-wrap:

        _tc_args = {"todoList": '{"todoList": [...]}' }

    This helper detects the pattern, JSON-parses the outer string, and if
    the result is a dict containing only the param_name key, unwraps it.

    Returns the unwrapped value (list, dict, or parsed primitive), or the
    original raw value if no unwrapping was needed.
    """
    if not isinstance(raw, str) or not raw.strip():
        return raw
    try:
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001
        return raw
    # Double-wrap: LLM passed param_name=json_string where the JSON
    # itself is a dict with a param_name key containing the real data.
    if isinstance(parsed, dict) and param_name in parsed:
        inner = parsed[param_name]
        if isinstance(inner, (list, dict)):
            return inner
    return parsed


def _build_injected_tools_addendum(*, is_sub_agent: bool = False) -> str:
    """Return a system-prompt addendum describing the CommandCenter-injected tools.

    Appended to every GitHub Copilot agent's system message at run time so the
    LLM knows the injected tools exist, when to use them, and what valid agent
    names are.  MAF agents receive these instructions via the MAF instructions
    field directly; this is only needed for the Copilot SDK path where the agent's
    own ``instructions.md`` was written without knowledge of CommandCenter injection.

    When ``is_sub_agent=True`` (the agent is called via call_agent from a parent),
    a compact version is returned — tool names only, no workspace/commit instructions.
    This saves ~700 tokens per sub-agent invocation.

    The full addendum is module-level cached after first build (the registry
    only changes on gateway restart) to keep the system-prompt prefix byte-stable
    across turns — required for KV-cache hits.
    """
    registry_block = _build_registry_block()

    # ── Compact version for sub-agents ──────────────────────────────────────
    if is_sub_agent:
        return f"""
---
## CommandCenter Platform Tools
call_agent(name,msg), call_agents_parallel(tasks), call_agent_background(name,msg)
web_search(query), fetch_page(url)
write_artifact(path,content) — files go to outputs/
share_artifact(path) — show a file you already wrote as a download/preview card
remember(query), recall_timeline(entity,query), save_memory(fact), save_episode(name,content)
manage_todo_list(todoList) — structured task tracking panel (JSON array)
ask_user(question,choices?) — HITL: pause and ask the user one question (blocking; the run resumes with their answer)
get_errors(filePaths?) — check Python files for syntax/lint errors
install_dependency(packages) — install Python package(s) into the agent venv at runtime
save_note(path,fact), recall_notes(path,query?) — repo-scoped working memory
query_history(sql) — SELECT-only query against chat history DB
github_search(q,scope?,max?), github_repo_search(repo,q?) — code search

{registry_block}
---"""

    return f"""
---
## CommandCenter Platform Tools (injected at runtime)

### Inter-agent delegation
- **call_agent(agent_name, message)** — Delegate to another agent; waits for its response.
- **call_agents_parallel(tasks)** — Run multiple agents concurrently (JSON array of {{"agent","message"}} objects).
- **call_agent_background(agent_name, message)** — Fire-and-forget; use when result is not needed now.

{registry_block}

### Web access (no API key required)
- **web_search(query, max_results=5)** — DuckDuckGo search. Use for current info, news, company research.
- **fetch_page(url, max_chars=8000)** — Fetch a public URL as clean text via Jina Reader.

### Memory & knowledge graph
- **remember(query)** — Search episodic memory for past facts about the user. Call before making claims about history or preferences.
- **recall_timeline(entity, query)** — Bi-temporal knowledge graph: "when did X happen?" or entity history.
- **save_memory(fact)** — Persist a high-signal user fact. Routine turns are handled automatically.
- **save_episode(name, content, source?)** — Record a time-stamped episode; Graphiti extracts entities & relationships.

### Workspace & file writing
Workspace folders visible in the Files Viewer: **outputs/** (default for generated files), **inputs/** (user uploads, read-only), **agent-data/** (reusable reference data).
- **write_artifact(path, content, encoding?, overwrite?)** — Write a file to outputs/ (if path has no prefix). The chat shows a Download/preview card **automatically** — you do NOT need to build or paste any URL; just say what the file is. It never clobbers an existing file by default (it auto-versions to ``name (1).ext`` and returns the real ``path``); pass ``overwrite=true`` only when you deliberately want to replace a file in place.
- **share_artifact(path)** — If you created a file with your OWN tools (shell, editor, a script you ran) instead of write_artifact, call this with that file's path (or a folder) to surface it as a Download/preview card. The card appears automatically; do NOT hand-construct links.

**Delivering files to the user:** to give the user a downloadable/previewable file, call ``write_artifact`` (for content you generate) or ``share_artifact`` (for a file you already wrote). That is ALL you need — the card renders itself. Never try to guess or assemble a download URL yourself.

### Task planning & progress tracking
- **manage_todo_list(todoList)** — Update the live "Todos (n/m)" panel above the chat input.  Takes a JSON object with ``"todoList"`` (the COMPLETE array of all items) and optional ``"operation"`` (``"write"`` or ``"read"``).  Each item: ``id`` (number, sequential from 1), ``title`` (string, 3-7 words), ``status`` (``"not-started"``, ``"in-progress"``, or ``"completed"``).  Use this tool VERY frequently.  CRITICAL workflow: 1) Plan tasks with specific items. 2) Mark ONE as ``"in-progress"`` before starting. 3) Mark it ``"completed"`` immediately after finishing. 4) Move to next.  Do NOT use for trivial single-step requests.  The user sees this panel update in real time.

**MANDATORY — You MUST call these functions. Do NOT use other tools for these purposes.**
- For todo/task tracking: call ``manage_todo_list`` — do NOT use ``remember``, ``task_manager``, ClickUp, or any other tool.
- For clarifying questions: call ``ask_user`` (native, blocking) or ``ask_questions`` — do NOT just ask in text.
- For checking code: call ``get_errors``.
- For notes: call ``save_note`` / ``recall_notes``.
- For history: call ``query_history``.
- For code search: call ``github_search`` / ``github_repo_search``.
Function calls trigger real-time UI (TodoPanel, ElicitationCard) — text does nothing.

### Human-in-the-Loop (HITL) elicitation
- **ask_user(question, choices?, allowFreeform?)** — Pause the run and ask the user ONE clarifying question via an interactive card.  This BLOCKS the agent turn: execution truly pauses and resumes automatically with the user's answer (no separate message turn).  ``choices`` is an optional list of suggested answers (rendered as buttons); ``allowFreeform`` (default true) lets the user type a custom answer.  Use when you need to disambiguate, a parameter is missing, or a decision has important implications.  Prefer ONE focused question per call.
- **ask_questions(questions)** — Alternative for asking SEVERAL questions at once via a multi-question card (JSON object with a ``"questions"`` array; each has ``header``, ``question``, optional ``options``/``multiSelect``/``allowFreeformInput``).  Prefer ``ask_user`` for single blocking questions.

### Code quality & error checking
- **get_errors(filePaths?)** — Check Python files for syntax, type, and lint errors.  Call after editing or creating files.  Pass a JSON array of file paths (e.g. ``'["executor.py"]'``) or ``'[]'`` to auto-discover recently changed files.  Runs ``py_compile`` (syntax) and ``ruff`` (lint, if installed).  Returns structured errors or ``"No errors found."``.

### Runtime dependencies
- **install_dependency(packages)** — Install Python package(s) into the agent runtime so your imports/tools work.  Use this when you hit a ``ModuleNotFoundError`` or know a task needs a package that isn't installed.  Pass space- or comma-separated specs, e.g. ``"pandas openpyxl"`` or ``"requests==2.31.0"`` (plain names + optional version; no flags/URLs).  Installs into the shared agent venv via ``uv``; the package is importable immediately.  Prefer this over shell ``pip install`` (the venv has no pip).

### Working memory (repo-scoped notes)
- **save_note(path, fact)** — Append a dated bullet to a markdown notes file under ``agent-data/``.  Your canonical working memory is ``agent-data/NOTES.md`` — read it at session start with ``recall_notes("NOTES.md")``.
- **recall_notes(path, query?)** — Read back a notes file, optionally filtered by a search query.  Use to restore context from previous sessions.

### Conversation history
- **query_history(query)** — Run a SELECT-only SQL query against the chat history database (tables: ``chat_session``, ``chat_message``).  Use to recall what was discussed in prior sessions, find past decisions, or resume work on a known thread.

### GitHub code search
- **github_search(query, scope?, maxResults?)** — Lexical search across public GitHub repositories.  Supports ``language:python``, ``repo:owner/name``, ``path:src/`` filters.
- **github_repo_search(repo, query?)** — Search within a specific GitHub repository for code snippets and implementation patterns.

### Working memory (NOTES.md pattern)
Maintain **`agent-data/NOTES.md`** as your cross-session working memory.
- At the START of each session: read this file if it exists to restore context.
- After each significant discovery, decision, or milestone: append a dated bullet (e.g. `- 2026-06-16: Closed ABC Corp deal at ₹50L`).
- Keep entries concise — one line per fact. This file survives context compaction and session resets.

### Self-improvement & committing
To persist changes to your own repo: `git add -A`, then `git commit -m "feat: ..."`, then print `COMMIT_SHA: <git rev-parse HEAD>`. Never amend; one commit per task.
- **By default, do NOT push** — direct pushes are blocked and the commit queues for human approval in the Control Plane inbox.
- **If the user explicitly tells you to push (e.g. "commit and push") in this conversation**, then after committing run `git push --no-verify origin HEAD`. The `--no-verify` flag is required to bypass the approval hook. That commit is then recorded as already-approved — the user does not need to approve it again on the Agents page.
---"""


@functools.lru_cache(maxsize=1)
def _build_registry_block() -> str:
    """Build the agent registry listing, cached for the lifetime of the process.

    The registry only changes when a new agent is registered (gateway restart
    or dynamic registration endpoint).  Caching keeps the system-prompt prefix
    byte-stable across turns — required for KV-cache hits (10x cost reduction
    per Manus benchmarks).

    Call ``_build_registry_block.cache_clear()`` after registering a new agent.
    """
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
    return (
        "Registered agents:\n" + "\n".join(agent_lines)
        if agent_lines
        else "Registered agents: check with the orchestrator if unsure."
    )


def _inject_agent_tools(agents: list[Any], *, is_sub_agent: bool = False, tool_scope: list[str] | None = None) -> None:
    """Inject cross-agent delegation tools into every loaded agent.

    Adds ``call_agent`` and ``call_agent_background`` from ``acb_skills.agent_tools``
    so that any agent — MAF or GitHub Copilot SDK — can delegate sub-tasks to
    other registered agents without any changes to the external agent repo.

    When ``is_sub_agent=True``, a compact addendum is appended to Copilot SDK
    agents instead of the full workspace/commit guidance (~700 token saving per
    sub-agent invocation).

    When ``tool_scope`` is provided (from ``config.json: tool_scope``), only the
    named tools are injected.  This prevents the Berkeley leaderboard failure mode
    where every additional tool degrades model accuracy — inject only what the
    agent actually needs.  ``None`` means inject all tools (default).

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
        _all_tools = [call_agent, call_agents_parallel, call_agent_background]
    except ImportError:
        return  # acb_skills not installed in this env — skip silently

    # Zero-credential web tools — always available, no integration config needed.
    try:
        from acb_skills.web_tools import fetch_page  # noqa: PLC0415
        from acb_skills.web_tools import web_search
        _all_tools = _all_tools + [web_search, fetch_page]
    except ImportError:
        pass  # duckduckgo-search / httpx not installed — skip gracefully

    # File-writing artifact tool — surfaces created files in the UI sidebar.
    # share_artifact surfaces a file the agent already wrote (via shell/editor)
    # as a download/preview card so it never hand-builds links.
    try:
        from acb_skills.write_artifact import (  # noqa: PLC0415
            share_artifact, write_artifact,
        )
        _all_tools = _all_tools + [write_artifact, share_artifact]
    except ImportError:
        pass

    # Memory tools — active read/write to Mem0 + Graphiti knowledge graph.
    try:
        from acb_skills.memory_tools import (
            remember,
            recall_timeline,
            save_memory,
            save_episode,
        )
        _all_tools = _all_tools + [
            remember, recall_timeline, save_memory, save_episode,
        ]
    except ImportError:
        pass  # acb_memory not installed — skip gracefully

    # Todo-list tracking — VS Code Copilot parity panel above chat input.
    try:
        from acb_skills.todo_tools import manage_todo_list  # noqa: PLC0415
        _all_tools = _all_tools + [manage_todo_list]
    except ImportError:
        pass

    # HITL elicitation — agent asks user clarifying questions mid-stream.
    try:
        from acb_skills.ask_tools import ask_questions  # noqa: PLC0415
        _all_tools = _all_tools + [ask_questions]
    except ImportError:
        pass

    # Code error checking — lint/syntax/type checks after edits.
    try:
        from acb_skills.error_tools import get_errors  # noqa: PLC0415
        _all_tools = _all_tools + [get_errors]
    except ImportError:
        pass

    # Runtime dependency install — agents can add a Python package mid-task
    # (installed into the shared agent venv, importable immediately).
    try:
        from acb_skills.dep_tools import install_dependency  # noqa: PLC0415
        _all_tools = _all_tools + [install_dependency]
    except ImportError:
        pass

    # Repo-scoped notes — agents maintain durable working memory.
    try:
        from acb_skills.note_tools import save_note  # noqa: PLC0415
        from acb_skills.note_tools import recall_notes
        _all_tools = _all_tools + [save_note, recall_notes]
    except ImportError:
        pass

    # Session history query — recall past conversations.
    try:
        from acb_skills.history_tools import query_history  # noqa: PLC0415
        _all_tools = _all_tools + [query_history]
    except ImportError:
        pass

    # GitHub code search — lexical + semantic search across repos.
    try:
        from acb_skills.github_tools import github_search  # noqa: PLC0415
        from acb_skills.github_tools import github_repo_search
        _all_tools = _all_tools + [github_search, github_repo_search]
    except ImportError:
        pass

    # ── Dynamic tool scoping (technique #3: inject only what agent needs) ──
    # If tool_scope is set (from config.json), filter to the named subset.
    # This prevents the "too many tools" accuracy degradation documented by
    # the Berkeley Function-Calling Leaderboard (every model degrades, no exceptions).
    if tool_scope:
        scope_set = set(tool_scope)
        _extra_tools = [fn for fn in _all_tools if fn.__name__ in scope_set]
        if not _extra_tools:
            # Scope list doesn't match any known tool names — fall back to all
            _log.warning(
                "executor.tool_scope_no_match",
                requested=tool_scope,
                available=[fn.__name__ for fn in _all_tools],
            )
            _extra_tools = _all_tools
    else:
        _extra_tools = _all_tools

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
                    addendum = _build_injected_tools_addendum(is_sub_agent=is_sub_agent)
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

        # ── Native agent_framework Agent (current MAF API) ──────────────────
        # The current Agent (agent_framework._agents.Agent) has no top-level
        # `.tools`; its tools live in `default_options["tools"]` (a list). MAF
        # accepts plain async callables, so append without wrapping. Used by the
        # email-assistant (a native MAF agent).
        try:
            _do = getattr(agent, "default_options", None)
            if isinstance(_do, dict) and isinstance(_do.get("tools"), list):
                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in _do["tools"]
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        _do["tools"].append(fn)
                # Give native MAF agents the LIVE agent registry so they can
                # discover and delegate to ALL registered specialists via
                # call_agent (Copilot-SDK agents get this through the
                # system-message addendum; native MAF agents otherwise only know
                # the agents hard-named in their instructions.md, so a newly
                # registered specialist — e.g. a product-planner — is invisible).
                if not is_sub_agent and any(
                    fn.__name__ == "call_agent" for fn in _extra_tools
                ):
                    try:
                        _reg = _build_registry_block()
                        _prev = _do.get("instructions") or ""
                        if _reg and "Delegatable agents" not in _prev:
                            _do["instructions"] = (
                                _prev
                                + "\n\n## Delegatable agents (call_agent)\n"
                                "Hand off to any of these registered specialist "
                                "agents with call_agent(name, message) and use "
                                "their reply (e.g. to gather context before "
                                "drafting):\n" + _reg
                            )
                    except Exception:
                        pass
                continue
        except Exception:  # noqa: BLE001
            pass

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
    event_queue: "asyncio.Queue[dict[str, Any] | None] | None" = None,
    model: str | None = None,
) -> str:
    """Run a sub-agent and forward its streaming events to *event_queue*.

    Called by ``call_agent`` when there is an active parent SSE queue so that
    the sub-agent's progress is visible in the UI in real time.

    *model* is the parent run's resolved tier; when set it takes priority over
    the sub-agent's own config default so a delegated task inherits the tier the
    user chose for the parent (both Copilot SDK and native MAF sub-agents).

    Supports GitHub Copilot SDK agents (native stream) and MAF agents (batch
    run with a single result delta at the end).

    When *event_queue* is ``None`` but ``_stream_relay_thread_id`` is set
    (Tier 1 / Tier 1.5 / any path without a queue), events are pushed
    directly to the Redis relay so the frontend subscriber receives them.

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

    # ── Redis relay fallback for paths without _active_run_queue ──────
    # Tier 1 (MAF AG-UI) and Tier 1.5 (Copilot SDK) don't set
    # _active_run_queue, so call_agent passes event_queue=None.  In that
    # case we push SUB_AGENT_* events directly to the Redis relay so the
    # frontend subscriber receives them in real time (same pattern as
    # ask_questions Path C).
    _relay_tid = _stream_relay_thread_id.get(None)
    _push_to_relay = bool(_relay_tid and event_queue is None)

    async def _emit_sub_event(evt: dict[str, Any]) -> None:
        """Push to queue (if available) and/or Redis relay."""
        if event_queue is not None:
            await event_queue.put(evt)
        if _push_to_relay:
            import json as _json_sub  # noqa: PLC0415
            _payload = _json_sub.dumps(evt, default=str)
            _line = f"data: {_payload}\n\n"
            await _push_sse_to_stream(_relay_tid, _line)  # type: ignore[arg-type]

    try:
        with load_agent(agent_name, run_id=run_id, repo_name=_repo_name, local_path=_local_path) as loaded:
            mandatory = loaded.config.get("integrations", [])
            optional = loaded.config.get("optional_integrations", [])
            integrations, _ = build_integrations(mandatory, optional, settings)
            _inject_integrations_to_env(integrations)
            agents = loaded.build_agents()
            # Honour .github/agents/<name>.agent.md instructions for sub-agents
            # too, so a delegated Copilot SDK agent keeps its authored identity.
            _agent_md_spec = _apply_agent_md_overrides(
                agents, loaded.agent_dir, agent_name,
            )
            # Technique #3: read tool_scope from config.json to inject only the
            # tools this sub-agent actually needs (avoids the Berkeley leaderboard
            # accuracy degradation from too many tools).
            _sub_tool_scope = (
                loaded.config.get("tool_scope") or None
                if hasattr(loaded, "config")
                else None
            )
            _inject_agent_tools(
                agents,
                is_sub_agent=True,
                tool_scope=_sub_tool_scope,
            )
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

            # Max chars returned from a sub-agent to the parent (technique #5).
            # Research: sub-agents explore deeply (10k+ tokens) but the parent
            # only needs a condensed 1-2k token summary.  Prevents single
            # sub-agent calls from bloating the orchestrator's context.
            _MAX_SUB_RESULT_CHARS = int(
                os.environ.get("SUB_AGENT_MAX_RESULT_CHARS", "8000")
            )

            if _runtime == "github-copilot" and hasattr(agent, "run"):
                # Resolve model with priority:
                #   1. parent run's resolved tier (model arg) — tier inheritance
                #   2. copilot_chat_model (global setting)
                #   3. .github/agents/<name>.agent.md model (authored choice)
                #   4. Agent's model_tier from config.json
                _model = (model or "").strip() or (
                    getattr(settings, "copilot_chat_model", "") or ""
                ).strip() or (
                    (_agent_md_spec.model or "").strip()
                    if _agent_md_spec is not None else ""
                ) or (
                    loaded.config.get("model_tier") or ""
                ).strip()
                # BYOK-by-default: normalise bare/empty names to the default
                # tier and force gateway routing (mirrors the chat path).
                _model, _is_sub_byok = _byok_default_model(_model, settings)

                if _model:
                    try:
                        if (
                            hasattr(agent, "_default_options")
                            and agent._default_options is not None
                        ):
                            # BYOK: route LiteLLM-gateway models through the
                            # gateway's /v1 endpoint so the Copilot SDK session
                            # uses the BYOK provider instead of the default
                            # api.githubcopilot.com endpoint.
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
                                    await _emit_sub_event({
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
                                await _emit_sub_event({
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
                                await _emit_sub_event({
                                    "type": "SUB_AGENT_TOOL_CALL_RESULT",
                                    "agentName": agent_name,
                                    "toolCallId": call_id,
                                    "content": str(exc_val) if exc_val else str(result_val),
                                    "success": exc_val is None,
                                })
            else:
                # MAF or unknown runtime: batch run, emit one result delta.
                # Forward the parent's resolved tier so native MAF sub-agents
                # inherit it (run_agent applies it via default_options["model"]).
                result = await run_agent(
                    agent_name,
                    {"message": message_str, "mode": "sub_task"},
                    run_id=run_id,
                    model=model,
                )
                text = result.get("result") or result.get("answer") or ""
                if isinstance(text, dict):
                    text = text.get("content", str(text))
                final_text = str(text) if text else ""
                if final_text:
                    text_parts.append(final_text)
                    await _emit_sub_event({
                        "type": "SUB_AGENT_TEXT_DELTA",
                        "agentName": agent_name,
                        "runId": run_id,
                        "delta": final_text,
                    })

            # ── Technique #5: sub-agent result compression ───────────────
            # Anthropic multi-agent research: sub-agents explore with 10k+
            # tokens but the parent only needs a 1-2k summary.  Cap here to
            # prevent single sub-agent calls from bloating the orchestrator.
            raw_result = "\n".join(text_parts)
            if not raw_result:
                return f"({agent_name!r} returned an empty response)"
            if len(raw_result) > _MAX_SUB_RESULT_CHARS:
                trimmed = raw_result[:_MAX_SUB_RESULT_CHARS]
                last_nl = trimmed.rfind("\n")
                if last_nl > _MAX_SUB_RESULT_CHARS // 2:
                    trimmed = trimmed[:last_nl]
                _log.debug(
                    "executor.sub_agent_result_truncated",
                    agent=agent_name,
                    original=len(raw_result),
                    capped=_MAX_SUB_RESULT_CHARS,
                )
                return (
                    trimmed
                    + f"\n\n[Sub-agent result truncated to"
                    f" {_MAX_SUB_RESULT_CHARS} chars]"
                )
            return raw_result

    except Exception as exc:  # noqa: BLE001
        await _emit_sub_event({
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


def _resolve_effective_agent_dir(
    agent_dir: Path, agent_config: dict[str, Any]
) -> str:
    """Resolve the effective working directory for an agent.

    By default this is the agent's clone directory.  If the agent config
    specifies ``workspace_root`` (optionally as an env-var reference like
    ``"$SOME_REPO_ROOT"``), that directory is used instead — provided it
    exists on disk.

    This lets an agent opt in to working on an external repo while its
    agent definition stays in its own clone, exactly like every other
    Copilot SDK agent.  When unset (the default), the agent operates in
    its own cloned repo directory.
    """
    raw = agent_config.get("workspace_root") or ""
    if not raw:
        return str(agent_dir)

    # Resolve $ENV_VAR references
    resolved = raw
    if raw.startswith("$"):
        var_name = raw[1:]
        resolved = os.environ.get(var_name, "")

    if resolved and Path(resolved).is_dir():
        return resolved

    # Fall back to the agent clone if the workspace_root is not available
    _log.debug(
        "executor.workspace_root_unavailable",
        configured=raw,
        resolved=resolved,
        fallback=str(agent_dir),
    )
    return str(agent_dir)


def _apply_agent_md_overrides(
    agents: list[Any],
    agent_dir: Path,
    agent_name: str,
) -> Any | None:
    """Honour ``.github/agents/<name>.agent.md`` for a loaded agent.

    Copilot SDK agents are wrapped inside MAF and author their identity in
    ``.github/agents/<name>.agent.md`` (instructions, model, tool affinity).
    Historically the runtime ignored that file and built the agent purely
    from ``agents.py`` / ``instructions.md``.  This applies the authored
    definition so a live chat (or any run) reflects it.

    Behaviour (per product decision):
      * **Instructions** — the inline markdown body *overrides* the repo's
        ``instructions.md`` content.  It replaces the ``system_message``
        content while preserving the SDK's append ``mode`` so the Copilot
        CLI base prompt is retained.  Called *before* tool injection so the
        platform-tools addendum still appends on top.
      * **Tools** — the frontmatter ``tools`` list uses VS Code Copilot's
        vocabulary and is treated as *advisory*: it is logged but never
        restricts the agent.  Copilot SDK agents keep their native tools and
        still receive every MAF platform-injected tool (additive).

    Returns the parsed :class:`AgentMd` (so the caller can fold its ``model``
    into the model-priority chain), or ``None`` when no usable file exists.
    Fully defensive — never raises.
    """
    try:
        from acb_skills.agent_md import load_agent_md  # noqa: PLC0415
        spec = load_agent_md(agent_dir, agent_name)
    except Exception as exc:  # noqa: BLE001
        _log.debug("executor.agent_md_load_failed", agent=agent_name, error=str(exc))
        return None
    if spec is None:
        return None

    if spec.body:
        for _ag in agents:
            try:
                opts = getattr(_ag, "_default_options", None)
                if isinstance(opts, dict):
                    # Preserve the SDK's system_message mode (default "append").
                    prev = opts.get("system_message")
                    mode = prev.get("mode", "append") if isinstance(prev, dict) else "append"
                    opts["system_message"] = {"mode": mode, "content": spec.body}
                # Pure-MAF agents expose ``instructions`` directly.
                if hasattr(_ag, "instructions"):
                    try:
                        _ag.instructions = spec.body
                    except (AttributeError, TypeError):
                        pass
            except Exception:  # noqa: BLE001
                pass

    _log.info(
        "executor.agent_md_applied",
        agent=agent_name,
        source=str(spec.path) if spec.path else None,
        model=spec.model,
        tools_advisory=spec.tools,
        body_chars=len(spec.body),
    )
    return spec


# The ONLY tier aliases the gateway /v1 actually resolves (see
# v1_compat._TIER_NAME_TO_ID). A bare ``tier…`` name that is NOT one of these
# (e.g. ``tier1-local-qwen3``) is NOT gateway-routable — litellm would 400 with
# "LLM Provider NOT provided" — so it must be treated as unknown and coerced to
# the safe default by _byok_default_model, not passed through.
_GATEWAY_TIER_ALIASES = frozenset({"tier-fast", "tier-balanced", "tier-powerful"})


def _is_gateway_model(model: str) -> bool:
    """True when *model* is a LiteLLM-gateway id: a known tier alias
    (tier-fast/balanced/powerful) or an explicit ``provider/model``."""
    m = (model or "").strip().lower()
    return bool(m) and ("/" in m or m in _GATEWAY_TIER_ALIASES)


def _byok_default_model(model: str, settings: Any) -> tuple[str, bool]:
    """Apply the BYOK-by-default policy to a resolved model string.

    Returns ``(model, is_byok)``.  When ``copilot_byok_default`` is on (the
    default), every Copilot SDK agent is BYOK-routed through the LiteLLM
    gateway: a gateway-recognised id (``tier-*`` or ``provider/model``) is kept
    as-is, while a bare name the gateway does not expose (e.g. an ``.agent.md``
    ``claude-sonnet-4-5``) — or an empty model — is normalised to
    ``copilot_chat_model`` (default ``tier-balanced``) so it always resolves.

    With the flag off, the legacy rule applies: only ``tier-*`` / ``provider/``
    models are BYOK; bare names hit api.githubcopilot.com direct.
    """
    model = (model or "").strip()
    byok_default = bool(getattr(settings, "copilot_byok_default", True))
    # The coercion target must be a model the gateway actually exposes.  Honour
    # ``copilot_chat_model`` only when it is itself a gateway id (tier-* /
    # provider/model); a bare value there (e.g. ``gpt-4o``) is not gateway-
    # routable, so fall back to the guaranteed ``tier-balanced`` alias.
    configured = (getattr(settings, "copilot_chat_model", "") or "").strip()
    default_tier = configured if _is_gateway_model(configured) else "tier-balanced"
    if byok_default:
        if not _is_gateway_model(model):
            if model and model != default_tier:
                _log.info(
                    "executor.byok_model_coerced",
                    requested=model,
                    coerced_to=default_tier,
                )
            model = default_tier
        return model, True
    return model, _is_gateway_model(model)


def _apply_byok_provider_for_copilot_sdk(
    agent: Any, requested_model: str, settings: Any,
    *, agent_md_model: str = "", agent_model_tier: str = "",
) -> str:
    """Pin a Copilot-SDK agent to the gateway /v1 (BYOK) and set its resolved
    model so ``agent.run()`` routes through litellm instead of opening a NATIVE
    Copilot session (which 402s). No-op for genuine MAF agents (no
    ``_default_options``). Used by the non-streaming run path; the streaming path
    has its own inline early-detection block. Returns the resolved model.
    """
    if not (hasattr(agent, "_default_options")
            and agent._default_options is not None):
        return (requested_model or "").strip()
    configured = (getattr(settings, "copilot_chat_model", "") or "").strip()
    final = (
        (requested_model or "").strip()
        or configured or agent_md_model or agent_model_tier
    )
    final, is_byok = _byok_default_model(final, settings)
    if is_byok:
        gw_base = (
            getattr(settings, "litellm_base_url", "") or "http://127.0.0.1:8080"
        ).rstrip("/")
        gw_key = (
            getattr(settings, "litellm_master_key", "") or "sk-local"
        ).strip()
        agent._default_options["provider"] = {
            "type": "openai", "base_url": f"{gw_base}/v1", "api_key": gw_key,
        }
    if final:
        agent._default_options["model"] = final
    return final


def _apply_model_for_maf_agent(
    agent: Any, requested_model: str, settings: Any,
    *, agent_model_tier: str = "",
) -> str:
    """Pin the resolved LiteLLM tier on a NATIVE MAF agent's default_options.

    Native MAF agents read their model from ``default_options["model"]`` (merged
    over the build-time client model at run time). Without setting it the agent
    SILENTLY IGNORES the requested/inherited tier and keeps the build-time
    default (tier-balanced) — so the per-account model and the chat-app tier
    picker have no effect. This is the MAF counterpart of
    ``_apply_byok_provider_for_copilot_sdk``: a no-op for Copilot-SDK agents
    (they own ``_default_options`` and are handled there). Returns the resolved
    model (also used to seed the sub-agent model ContextVar).
    """
    final = (requested_model or "").strip() or (agent_model_tier or "").strip()
    final, _ = _byok_default_model(final, settings)
    # Skip Copilot-SDK agents — the BYOK provider helper owns those.
    if hasattr(agent, "_default_options") and agent._default_options is not None:
        return final
    opts = getattr(agent, "default_options", None)
    if final and isinstance(opts, dict):
        opts["model"] = final
    return final


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


async def _commit_on_remote(agent_dir: str, commit_sha: str) -> bool:
    """True if *commit_sha* is already on a remote (the agent pushed it).

    A successful ``git push`` updates the local ``origin/<branch>`` tracking ref,
    so ``git branch -r --contains <sha>`` lists a remote ref when the commit was
    pushed. Used to auto-approve a commit the user told the agent to push from
    chat (it lands on origin, so it needs no separate Control-Plane approval).
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "branch", "-r", "--contains", commit_sha,
            cwd=agent_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return proc.returncode == 0 and bool(out.decode(errors="replace").strip())
    except Exception:  # noqa: BLE001
        return False


async def _install_push_guard(agent_dir: str) -> None:
    """Install git hooks for commit-gate workflow.

    Installs two hooks (idempotent — skips if already present):

    1. **pre-push**: Rejects all direct pushes.  The human-approval gateway
       endpoint handles the push, or the operator may tell the agent to
       ``git push --no-verify`` from chat to bypass this hook explicitly.

    2. **post-commit**: Appends the new commit SHA to ``.git/cc-commits-queue``.
       The post-run commit scanner reads this file to detect commits made
       *during* a chat session (before ``run_agent`` returns) so they appear
       in the Self Mutation Commits UI immediately after the run.

    Non-fatal — if any hook write fails, execution continues; the post-run
    commit scan (including catch-up) still catches new commits.
    """
    try:
        hooks_dir = Path(agent_dir) / ".git" / "hooks"
        if not hooks_dir.is_dir():
            return
        # --- pre-push hook ---
        pre_push = hooks_dir / "pre-push"
        if not pre_push.exists():
            pre_push.write_text(
                "#!/bin/sh\n"
                "echo 'Direct push blocked: commits are queued for human approval'\n"
                "echo 'Approve via the CommandCenter Control Plane inbox, or tell the agent you approve and it will push with --no-verify.'\n"
                "exit 1\n",
                encoding="utf-8",
            )
            pre_push.chmod(0o755)
        # --- post-commit hook ---
        post_commit = hooks_dir / "post-commit"
        if not post_commit.exists():
            post_commit.write_text(
                "#!/bin/sh\n"
                "# Append the new commit SHA to the queue file.\n"
                "# The executor reads this file at end-of-run to register commits\n"
                "# that were made *during* the chat session.\n"
                "echo \"$(git rev-parse HEAD)\" >> \"$(git rev-parse --git-dir)/cc-commits-queue\"\n",
                encoding="utf-8",
            )
            post_commit.chmod(0o755)
    except Exception as exc:  # noqa: BLE001
        _log.warning("executor.push_guard_install_failed", agent=agent_dir, error=str(exc))


async def _detect_agent_commits(
    agent_name: str,
    agent_dir: str | None,
    run_id: str,
    *,
    since_sha: str | None = None,
) -> None:
    """After an agent run, register any new commits for inbox approval.

    Detection strategy (layered — catches orphaned commits from prior runs):

    0. **Queue-file scan** (real-time, fastest path): reads
       ``.git/cc-commits-queue`` written by the post-commit hook.
       Dequeues all SHAs, deduplicates them, registers any that are not
       already in ``pending_commit``, then truncates the file.  This
       catches commits made *during* the chat session so they appear in
       the Self Mutation Commits UI immediately after the run.

    1. **Since-sha scan**: detects commits made during THIS run
       (``git log {since_sha}..HEAD``).  This catches all new commits
       that may have been missed by the post-commit hook.

    2. **Catch-up scan** (always runs): scans the last 50 commits and
       registers any missing from ``pending_commit``.  This recovers
       commits orphaned by a previous detection failure, DB outage, or
       gateway restart.

    All phases are deduplicated against ``pending_commit.commit_sha``
    so no commit is ever registered twice.

    Called for **all** agents (not just github-copilot).  MAF agents that
    do not commit simply produce empty scans.

    Non-fatal — any subprocess or DB error is logged and swallowed.
    """
    if not agent_dir:
        return

    try:
        # ── Load existing commit SHAs for dedup ─────────────────────────
        _existing_shas: set[str] = set()
        try:
            from acb_graph import get_session as _gs  # noqa: PLC0415
            from sqlalchemy import text as _txt  # noqa: PLC0415
            with _gs() as _s:
                _rows = _s.execute(
                    _txt(
                        "SELECT commit_sha FROM pending_commit "
                        "WHERE agent_name = :a"
                    ),
                    {"a": agent_name},
                ).fetchall()
                _existing_shas = {r[0] for r in _rows}
        except Exception:  # noqa: BLE001
            pass

        all_lines: list[str] = []

        # ── Phase 0: queue-file scan (post-commit hook) ─────────────────
        # The post-commit hook appends each new SHA to this file.  We read
        # it, deduplicate, register any unseen SHAs, then truncate so they
        # are not re-registered on the next scan.
        queue_file = Path(agent_dir) / ".git" / "cc-commits-queue"
        if queue_file.exists():
            try:
                raw = queue_file.read_text(encoding="utf-8").strip()
                if raw:
                    queue_shas: list[str] = []
                    seen_queue: set[str] = set()
                    for line in raw.splitlines():
                        sha = line.strip()
                        # Must be a full 40-char SHA
                        if sha and len(sha) == 40 and sha not in seen_queue:
                            seen_queue.add(sha)
                            if sha not in _existing_shas:
                                queue_shas.append(sha)
                    if queue_shas:
                        _log.info(
                            "executor.commits_queue_file",
                            agent=agent_name,
                            count=len(queue_shas),
                        )
                        # Fetch the full message for each queued SHA inline.
                        for sha in queue_shas:
                            _existing_shas.add(sha)
                            msg = ""
                            try:
                                p = await asyncio.create_subprocess_exec(
                                    "git", "log", "-1", "--format=%s", sha,
                                    cwd=agent_dir,
                                    stdout=asyncio.subprocess.PIPE,
                                    stderr=asyncio.subprocess.DEVNULL,
                                )
                                out, _ = await asyncio.wait_for(p.communicate(), timeout=5)
                                msg = out.decode(errors="replace").strip()
                            except Exception:  # noqa: BLE001
                                msg = sha[:12]
                            all_lines.append(f"{sha}|{msg}")
                # Truncate so SHAs are not re-registered on next scan.
                queue_file.write_text("", encoding="utf-8")
            except Exception as exc:  # noqa: BLE001
                _log.warning(
                    "executor.commit_scan_queue_failed",
                    agent=agent_name, error=str(exc),
                )

        # ── Phase 1: since-sha scan (this run's commits) ────────────────
        if since_sha:
            proc = await asyncio.create_subprocess_exec(
                "git", "log", f"{since_sha}..HEAD", "--format=%H|%s",
                cwd=agent_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=10,
            )
            if proc.returncode == 0:
                phase1 = stdout_bytes.decode(errors="replace").strip()
                if phase1:
                    all_lines.extend(phase1.splitlines())
                    _log.info(
                        "executor.commits_since_sha",
                        agent=agent_name, count=len(phase1.splitlines()),
                    )
            else:
                _log.debug(
                    "executor.since_sha_failed",
                    agent=agent_name,
                    stderr=stderr_bytes.decode(errors="replace")[:200],
                )

        # ── Phase 2: catch-up scan (orphaned from prior runs) ───────────
        # Scans the last 50 commits in the repo and registers any that
        # are missing from pending_commit.  This recovers commits that were
        # missed by a previous detection attempt (silent exception, DB
        # outage, gateway restart) OR were pushed before the push guard
        # was installed.  Capped at 50 to keep it fast; older history is
        # assumed already reviewed or irrelevant.
        catchup_proc = await asyncio.create_subprocess_exec(
            "git", "log", "HEAD", "-n", "50", "--format=%H|%s",
            cwd=agent_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        catchup_out, _ = await asyncio.wait_for(
            catchup_proc.communicate(), timeout=10,
        )
        if catchup_proc.returncode == 0:
            catchup_text = catchup_out.decode(errors="replace").strip()
            if catchup_text:
                # Merge with Phase 1, dedup by SHA, skip already-registered
                seen = {ln.split("|", 1)[0].strip() for ln in all_lines}
                new_from_catchup = 0
                # ── System-generated commit messages to skip ──────────
                # (duplicated from the registration loop below so the
                # catch-up scan doesn't even log them as "recovered".)
                _CATCHUP_SKIP_PREFIXES = (
                    "initial: seeded from local source",
                )
                for ln in catchup_text.splitlines():
                    sha = ln.split("|", 1)[0].strip()
                    msg = ln.split("|", 1)[1].strip() if "|" in ln else ""
                    if (
                        sha and sha not in seen
                        and sha not in _existing_shas
                        and not msg.lower().startswith(_CATCHUP_SKIP_PREFIXES)
                    ):
                        all_lines.append(ln)
                        seen.add(sha)
                        new_from_catchup += 1
                if new_from_catchup:
                    _log.info(
                        "executor.commits_catchup",
                        agent=agent_name,
                        new_count=new_from_catchup,
                        hint=(
                            "Recovered orphaned commits from prior runs "
                            "(pushed before guard or missed by detector)."
                        ),
                    )

        if not all_lines:
            return  # nothing new

        _log.info(
            "executor.agent_commits_detected",
            agent=agent_name,
            run_id=run_id,
            count=len(all_lines),
        )

        from orchestrator.mutation import _git_diff  # noqa: PLC0415
        from orchestrator.mutation import _register_pending_commit

        # ── System-generated commit messages to skip ──────────────────
        # These are infrastructure commits (initial clones, auto-seeds,
        # sync baselines) that should never surface for human approval.
        _SYSTEM_COMMIT_PREFIXES = (
            "initial: seeded from local source",
        )

        for raw_line in all_lines:
            parts = raw_line.split("|", 1)
            commit_sha = parts[0].strip()
            commit_message = (
                parts[1].strip() if len(parts) > 1 else commit_sha[:8]
            )
            if not commit_sha or commit_sha in _existing_shas:
                continue

            # Skip system-generated baseline commits — these are infra
            # artefacts, not agent-authored changes worth reviewing.
            if commit_message.lower().startswith(_SYSTEM_COMMIT_PREFIXES):
                _log.debug(
                    "executor.skip_system_commit",
                    agent=agent_name,
                    commit_sha=commit_sha[:8],
                    commit_message=commit_message[:80],
                )
                continue

            # Capture the diff for inline review
            diff_text = await _git_diff(agent_dir, commit_sha)

            # If the agent already pushed this commit (the user told it to
            # "commit and push" in chat, so it ran `git push --no-verify`), it's
            # on origin — record it as already-approved instead of queuing it for
            # a redundant Control-Plane approval.
            pushed = await _commit_on_remote(agent_dir, commit_sha)

            await _register_pending_commit(
                agent_name=agent_name,
                run_id=run_id,
                local_clone_dir=agent_dir,
                commit_sha=commit_sha,
                commit_message=commit_message,
                diff_text=diff_text,
                test_summary="(agent self-improvement — no test run)",
                status="approved" if pushed else "pending",
                reviewed_by="chat:autopush" if pushed else None,
            )

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_self_commit_detected",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "commit_count": len(all_lines),
                    "commits": [
                        ln.split("|", 1)[0].strip()[:12]
                        for ln in all_lines
                    ],
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
    model: str | None = None,
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

    # Set the memory/user ContextVar from the payload so user-scoped tools and
    # memory resolve the acting user (mirrors run_agent_stream).
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _mu = str(
            event_payload.get("user_email")
            or event_payload.get("user_id") or ""
        ) if isinstance(event_payload, dict) else ""
        if _mu:
            _set_memory_user_id(_mu)
            os.environ["ACB_AGENT_USER_EMAIL"] = _mu
    except Exception:  # noqa: BLE001
        pass

    record(
        AuditEvent(
            actor="system:gateway",
            action="agent_run_start",
            target=f"agent:{agent_name}",
            payload={"run_id": run_id, "event_keys": list(event_payload.keys())},
        )
    )

    try:
        _effective_agent_dir: str | None = None

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
            # ── Resolve effective workspace directory ──────────────────
            # Agents may optionally specify workspace_root in config.json to
            # work on an external repo.  All directory operations — push
            # guard, HEAD capture, working directory, commit detection — use
            # this resolved path so they stay consistent.  When unset, the
            # agent operates in its own clone directory.
            _effective_agent_dir = _resolve_effective_agent_dir(
                loaded.agent_dir, loaded.config,
            )

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
                # Install push guard + capture HEAD for ALL agents (not just
                # github-copilot).  MAF agents may also generate commits during
                # a run, and the guard protects against unapproved pushes.
                await _install_push_guard(_effective_agent_dir)
                _head_before = await _get_current_head(_effective_agent_dir)
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
            # Honour .github/agents/<name>.agent.md (instructions override).
            _apply_agent_md_overrides(agents, loaded.agent_dir, agent_name)
            _inject_agent_tools(
                agents,
                tool_scope=loaded.config.get("tool_scope") or None,
            )  # inject call_agent / call_agent_background

            # Set write_artifact context + ensure visible workspace dirs exist.
            try:
                from acb_skills.write_artifact import \
                    _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
                _WRITE_ARTIFACT_CONTEXT["session_id"] = thread_id or run_id
                _WRITE_ARTIFACT_CONTEXT["workspace_root"] = _effective_agent_dir
                _WRITE_ARTIFACT_CONTEXT["gateway_url"] = str(
                    getattr(settings, "gateway_base_url", "http://127.0.0.1:8000")
                )
                _WRITE_ARTIFACT_CONTEXT["gateway_token"] = str(
                    getattr(settings, "litellm_master_key", "")
                    or getattr(settings, "gateway_internal_token",
                               "sk-local-dev-change-me")
                )
                _ws_root = Path(_effective_agent_dir)
                for _d in ("inputs", "outputs", "agent-data"):
                    (_ws_root / _d).mkdir(parents=True, exist_ok=True)
            except Exception:  # noqa: BLE001
                pass

            # ── Set working directory for Copilot SDK agents ────────────
            # The Copilot SDK CLI defaults to the gateway CWD unless
            # working_directory is explicitly set.  Point it at the agent's
            # effective workspace (clone dir or workspace_root) so shell
            # commands, file I/O, AGENTS.md, and skill resolution all work.
            if _is_copilot_agent:
                for _ag in agents:
                    try:
                        if (
                            hasattr(_ag, "_default_options")
                            and _ag._default_options is not None
                        ):
                            _ag._default_options["working_directory"] = (
                                _effective_agent_dir
                            )
                    except Exception:  # noqa: BLE001
                        pass

            # Resolve + apply the run model to the agent (batch path).
            #  - Copilot-SDK agents: pin to gateway /v1 (BYOK) + set model so
            #    agent.run() routes through litellm (no native Copilot 402).
            #  - Native MAF agents: _apply_byok_… is a no-op, so set
            #    default_options["model"] here — the MAF client otherwise keeps
            #    its build-time model and ignores the requested/inherited tier.
            if agents:
                _agent0 = agents[0]
                _cfg_tier = (loaded.config.get("model_tier") or "")
                try:
                    # Copilot-SDK agents: pin gateway /v1 (BYOK) + model.
                    _apply_byok_provider_for_copilot_sdk(
                        _agent0, model or "", settings,
                        agent_model_tier=_cfg_tier,
                    )
                    # Native MAF agents: set default_options["model"] so the
                    # requested/inherited tier is honoured (no-op for Copilot SDK).
                    _apply_model_for_maf_agent(
                        _agent0, model or "", settings,
                        agent_model_tier=_cfg_tier,
                    )
                except Exception as _be:  # noqa: BLE001
                    _log.warning("executor.byok_apply_failed",
                                 agent=agent_name, error=str(_be)[:160])

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
        # Post-run: detect commits the agent made during this run (ALL agents)
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
        await _detect_agent_commits(
            agent_name, _effective_agent_dir, run_id,
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
            agent_dir=_effective_agent_dir,
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
            agent_dir=_effective_agent_dir,
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
            agent_dir=_effective_agent_dir,  # pass persistent clone path for authenticated push
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


class _FcStreamState:
    """Per-run state for de-duplicating streamed tool-call ids.

    See :func:`_native_fc_events`.  One instance per native-MAF run.
    """

    __slots__ = ("run_id", "seen", "last_id", "counter")

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.seen: set[str] = set()
        self.last_id: str | None = None
        self.counter = 0


def _native_fc_events(
    content: Any, state: "_FcStreamState"
) -> list[dict[str, Any]]:
    """Map one agent-framework ``function_call`` content to TOOL_CALL_* event
    payloads, collapsing the OpenAI streaming quirk where a tool call's id is
    sent only on its FIRST chunk — the argument-streaming chunks that follow
    carry ``call_id=""``.

    Without this, each empty-id continuation chunk minted a fresh synthetic id,
    so one streamed tool call rendered as several rows in the consciousness
    timeline.  Continuation chunks are now attributed to the in-flight call, so
    one tool call → one row.  Returns 0+ event payload dicts (no ``_stream_id``;
    the caller wraps them with ``_sse``).
    """
    cid = getattr(content, "call_id", None) or ""
    targs = getattr(content, "arguments", None)
    # Streamed args arrive in pieces and are concatenated downstream, so forward
    # a partial fragment verbatim (never JSON-parse a fragment).
    delta = (
        targs if isinstance(targs, str)
        else json.dumps(targs) if isinstance(targs, dict)
        else str(targs or "")
    )
    if not cid:
        # Continuation chunk for the in-flight call — stream its args, no new row.
        if state.last_id is not None:
            return (
                [{"type": "TOOL_CALL_ARGS",
                  "toolCallId": state.last_id, "delta": delta}]
                if delta else []
            )
        # No call started yet (defensive) — mint a synthetic id.
        state.counter += 1
        cid = f"{state.run_id}:fc:{state.counter}"
    # A re-sent id for an already-started call: the row exists, don't duplicate.
    if cid in state.seen:
        return []
    state.seen.add(cid)
    state.last_id = cid
    name = getattr(content, "name", "") or "tool"
    out: list[dict[str, Any]] = [{
        "type": "TOOL_CALL_START",
        "toolCallId": cid, "toolCallName": name, "args": delta,
    }]
    if delta:
        out.append({"type": "TOOL_CALL_ARGS", "toolCallId": cid, "delta": delta})
    return out


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

    # ── User context for tools/memory ──────────────────────────────────────
    # Set the memory ContextVar HERE (inside the generator, before any agent
    # task spawns) from the payload, so user-scoped tools and memory see the
    # acting user. Setting it in the calling route doesn't survive into the
    # streaming/agent execution context.
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _mu = ""
        if isinstance(event_payload, dict):
            _mu = str(
                event_payload.get("user_email")
                or event_payload.get("user_id") or ""
            )
        if _mu:
            _set_memory_user_id(_mu)
            # Fallback for tool callbacks the Copilot SDK runs outside this
            # ContextVar's reach (single-user deployments).
            os.environ["ACB_AGENT_USER_EMAIL"] = _mu
    except Exception:  # noqa: BLE001
        pass

    # ── Stream relay: tee all SSE events to Redis for reconnection support ─
    _relay_token = _stream_relay_thread_id.set(thread_id)
    # Expose the run's model so sub-agents inherit the parent tier. Seed with the
    # raw requested model now; refined to the fully-resolved tier once known.
    _model_token = _active_run_model.set((model or "").strip() or None)
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
            # Honour .github/agents/<name>.agent.md (Copilot SDK definition):
            # override instructions + capture model, BEFORE tool injection so
            # the platform-tools addendum appends on top of the authored body.
            _agent_md_spec = _apply_agent_md_overrides(
                agents, loaded.agent_dir, agent_name,
            )
            _inject_agent_tools(
                agents,
                tool_scope=loaded.config.get("tool_scope") or None,
            )  # inject call_agent / call_agent_background
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

            # Detect Copilot-SDK-backed agents by capability, NOT the registry
            # runtime label. Some agents (e.g. email-assistant) are built with
            # GitHubCopilotAgent but registered as runtime "maf"; they still need
            # BYOK provider routing or agent.run() opens a NATIVE Copilot session
            # (→ 402). A genuine MAF agent has no ``_default_options``.
            _is_copilot_sdk = (
                _agent_runtime == "github-copilot"
                or (hasattr(agent, "_default_options")
                    and agent._default_options is not None)
            )

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
            # .github/agents/<name>.agent.md model wins over config.json's
            # model_tier (the repo's authored choice) but never over an
            # explicit request/global override, keeping BYOK routing intact.
            _agent_md_model = (
                (_agent_md_spec.model or "").strip()
                if _agent_md_spec is not None
                else ""
            )
            _final_model_early = (
                _requested_model_early
                or _configured_model_early
                or _agent_md_model
                or _agent_model_tier
            )
            # BYOK-by-default: route every Copilot SDK agent through the LiteLLM
            # gateway and normalise any bare/empty model to the default tier.
            _final_model_early, _is_byok_early = _byok_default_model(
                _final_model_early, settings,
            )
            # Refine the run's model ContextVar to the fully-resolved tier so
            # sub-agents spawned during this run inherit it (call_agent etc.).
            if _final_model_early:
                _active_run_model.set(_final_model_early)
            _byok_provider_early: dict[str, Any] | None = None
            _byok_model_id_early = _final_model_early
            if _is_byok_early and _is_copilot_sdk:
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
                    runtime=_agent_runtime,
                    model=_byok_model_id_early,
                    base_url=_gw_base,
                )
            elif _final_model_early and _is_copilot_sdk:
                agent._default_options["model"] = _final_model_early
            elif _final_model_early and not _is_copilot_sdk:
                # Native MAF agent (e.g. email-assistant, orchestrator): make it
                # honour the resolved tier via default_options["model"] — the
                # Tier-1 stream_agent_response path otherwise keeps the build-time
                # client model and silently ignores the requested tier.
                try:
                    _apply_model_for_maf_agent(
                        agent, _final_model_early, settings,
                    )
                    _log.info(
                        "executor.maf_model_override",
                        agent=agent_name,
                        runtime=_agent_runtime,
                        model=_final_model_early,
                    )
                except Exception:  # noqa: BLE001
                    pass

            # ── Set working directory for Copilot SDK agents ────────────
            # The Copilot SDK CLI defaults to the gateway CWD unless
            # working_directory is explicitly set.  Point it at the agent's
            # effective workspace (clone dir or workspace_root from config)
            # so shell commands, file I/O, AGENTS.md, and skill resolution
            # all work correctly.
            _effective_agent_dir = _resolve_effective_agent_dir(
                loaded.agent_dir, loaded.config,
            )
            if _agent_runtime == "github-copilot":
                for _ag in agents:
                    try:
                        if (
                            hasattr(_ag, "_default_options")
                            and _ag._default_options is not None
                        ):
                            _ag._default_options[
                                "working_directory"
                            ] = _effective_agent_dir
                            # Native HITL: register the blocking ask_user
                            # handler bound to this run's relay thread so the
                            # agent can pause for human input mid-turn.
                            _ag._default_options[
                                "on_user_input_request"
                            ] = _make_user_input_handler(thread_id)
                    except Exception:  # noqa: BLE001
                        pass
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

            # ── Tier 1: native MAF agent live streaming ─────────────────────
            # The intended ``agent_framework.ag_ui.stream_agent_response`` is not
            # exported by the installed ``agent_framework_ag_ui``, and the Tier
            # 1.5 Copilot path below is gated to Copilot-SDK agents.  Without this
            # branch a native MAF agent (e.g. email-assistant) falls to the Tier
            # 2 BATCH path: no streamed reasoning, and the answer appears only
            # once the whole run finishes.  Here we stream MAF's native run and
            # translate its content deltas into the SAME AG-UI events the Copilot
            # path emits — live text, reasoning, and tool calls — while draining
            # ``_active_run_queue`` so injected-tool events (artifacts / todos /
            # elicitation) still surface live.
            #
            # Safety net: if streaming raises BEFORE emitting anything, fall
            # through to the proven Tier 2 batch path below.
            if not _is_copilot_sdk and hasattr(agent, "run"):
                _native_input = _compose_maf_run_input(
                    agent_name, run_id, event_payload, integrations,
                    is_byok=_is_byok_early,
                )
                _nq: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
                _nq_token = _active_run_queue.set(_nq)
                _n_msg_id: str | None = None
                _n_text_started = False
                _n_emitted = False
                # Tool-call id/dedup state (collapses OpenAI's streamed-id quirk
                # where a call's id arrives only on its first chunk).
                _fc_state = _FcStreamState(run_id)
                # Idle watchdog: if the native stream yields no update for this
                # many seconds, treat the agent as stalled and error out rather
                # than hold the SSE open until the HTTP-level abort (~5 min).
                _native_idle = False
                _idle_to = float(
                    os.environ.get("NATIVE_STREAM_IDLE_TIMEOUT_SECONDS", "120")
                )
                try:
                    async with contextlib.AsyncExitStack() as _nstack:
                        if hasattr(type(agent), "__aenter__"):
                            await _nstack.enter_async_context(agent)
                        _agen = agent.run(
                            _native_input, stream=True,
                        ).__aiter__()
                        while True:
                            try:
                                _u = await asyncio.wait_for(
                                    _agen.__anext__(), timeout=_idle_to,
                                )
                            except StopAsyncIteration:
                                break
                            except TimeoutError:
                                # No update for _idle_to seconds → the agent is
                                # wedged.  Stop and let the post-loop emit a
                                # RUN_ERROR instead of hanging the stream.
                                _native_idle = True
                                with contextlib.suppress(Exception):
                                    await _agen.aclose()
                                break
                            for _c in (getattr(_u, "contents", None) or []):
                                _ct = getattr(_c, "type", None)
                                if _ct == "text":
                                    _d = getattr(_c, "text", "") or ""
                                    if not _d:
                                        continue
                                    if not _n_text_started:
                                        _n_text_started = True
                                        _n_msg_id = (
                                            getattr(_u, "message_id", None)
                                            or str(uuid.uuid4())
                                        )
                                        yield _sse({
                                            "type": "TEXT_MESSAGE_START",
                                            "messageId": _n_msg_id,
                                            "role": "assistant",
                                        })
                                    _n_emitted = True
                                    yield _sse({
                                        "type": "TEXT_MESSAGE_CONTENT",
                                        "messageId": _n_msg_id, "delta": _d,
                                    })
                                elif _ct == "text_reasoning":
                                    _d = getattr(_c, "text", "") or ""
                                    if _d:
                                        _n_emitted = True
                                        yield _sse({
                                            "type":
                                                "THINKING_TEXT_MESSAGE_CONTENT",
                                            "delta": _d,
                                        })
                                elif _ct == "function_call":
                                    for _ev in _native_fc_events(_c, _fc_state):
                                        _n_emitted = True
                                        yield _sse(_ev)
                                elif _ct == "function_result":
                                    _tcid = getattr(_c, "call_id", None) or ""
                                    _exc = getattr(_c, "exception", None)
                                    _res = getattr(_c, "result", "") or ""
                                    yield _sse({
                                        "type": "TOOL_CALL_RESULT",
                                        "toolCallId": _tcid,
                                        "content": (
                                            str(_exc) if _exc else str(_res)
                                        )[:2000],
                                        "success": _exc is None,
                                    })
                            # Surface injected-tool events (write_artifact,
                            # manage_todo_list, ask_questions) live as pushed.
                            while not _nq.empty():
                                _qev = _nq.get_nowait()
                                if _qev:
                                    _n_emitted = True
                                    yield _sse(_qev)
                    # Drain any events that landed as the stream closed.
                    while not _nq.empty():
                        _qev = _nq.get_nowait()
                        if _qev:
                            yield _sse(_qev)
                    if _n_text_started and _n_msg_id:
                        yield _sse({
                            "type": "TEXT_MESSAGE_END", "messageId": _n_msg_id,
                        })
                    if _native_idle:
                        _log.warning(
                            "executor.native_maf_stream_idle_timeout",
                            agent=agent_name, idle_seconds=_idle_to,
                        )
                        yield _sse({
                            "type": "RUN_ERROR", "runId": run_id,
                            "message": (
                                f"Agent produced no output for {int(_idle_to)}s "
                                "and was stopped (possible stall)."
                            ),
                        })
                    else:
                        yield _sse({
                            "type": "RUN_FINISHED", "runId": run_id,
                            "threadId": thread_id,
                        })
                    _active_run_queue.reset(_nq_token)
                    return
                except Exception as _nexc:
                    with contextlib.suppress(Exception):
                        _active_run_queue.reset(_nq_token)
                    if _n_emitted:
                        _log.exception(
                            "executor.native_maf_stream_error",
                            agent=agent_name,
                        )
                        # Close any open text message first so the UI bubble
                        # doesn't hang in "streaming" before the error lands.
                        if _n_text_started and _n_msg_id:
                            yield _sse({
                                "type": "TEXT_MESSAGE_END",
                                "messageId": _n_msg_id,
                            })
                        yield _sse({
                            "type": "RUN_ERROR", "runId": run_id,
                            "message": str(_nexc),
                        })
                        return
                    # Nothing emitted yet — fall through to Tier 2 batch.
                    _log.warning(
                        "executor.native_maf_stream_fallback",
                        agent=agent_name, error=str(_nexc)[:200],
                    )

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
            # Covers BOTH github-copilot-runtime agents and Copilot-SDK agents
            # registered as "maf" (e.g. email-assistant) so they get BYOK
            # provider forwarding instead of a native Copilot session.
            if _is_copilot_sdk:
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
                await _install_push_guard(_effective_agent_dir)
                _stream_head_before = await _get_current_head(_effective_agent_dir)

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
                        for m in _prior[-12:]:  # last 6 exchanges
                            role = m.get("role", "user")
                            content = (m.get("content") or "").strip()
                            if not content:
                                continue
                            label = (
                                "User" if role == "user" else "Assistant"
                            )
                            short = (
                                content if len(content) <= 200
                                else content[:200] + "..."
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
                        # ── Forward max_tokens to prevent model truncation ─
                        _copilot_max_tok = os.environ.get(
                            "COPILOT_MAX_OUTPUT_TOKENS", ""
                        ).strip()
                        if _copilot_max_tok:
                            _run_opts_inner["max_tokens"] = int(_copilot_max_tok)
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
                                    # Copilot SDK may pass arguments as a
                                    # JSON string (EXTERNAL_TOOL_REQUESTED
                                    # events) — normalise to dict for the
                                    # tool-name checks below.
                                    if isinstance(_tc_args, str) and _tc_args.strip():
                                        try:
                                            _tc_args = json.loads(_tc_args)
                                        except Exception:  # noqa: BLE001
                                            pass
                                    _args_str = (json.dumps(_tc_args) if isinstance(_tc_args, dict)
                                                 else str(_tc_args or ""))
                                    # ── Structured todo-list tracking ─────
                                    # Two paths to the same TODO_LIST event:
                                    # 1. manage_todo_list tool (direct call
                                    #    from the agent — primary path for
                                    #    all agent types).
                                    # 2. sql tool on the todos table (Copilot
                                    #    CLI legacy path — kept as fallback).
                                    try:
                                        _emitted = False
                                        if _tc_name == "manage_todo_list":
                                            _todos = _unwrap_json_param(
                                                _tc_args.get("todoList", "[]")
                                                if isinstance(_tc_args, dict)
                                                else "[]",
                                                "todoList",
                                            )
                                            if isinstance(_todos, list):
                                                _cleaned: list[dict] = []
                                                for _t in _todos:
                                                    if isinstance(_t, dict):
                                                        _cleaned.append({
                                                            "id": str(_t.get("id", "")),
                                                            "title": str(_t.get("title", "")),
                                                            "status": str(_t.get("status", "not-started")),
                                                        })
                                                yield _sse({"type": "TODO_LIST",
                                                            "todos": _cleaned})
                                                _emitted = True
                                        # HITL elicitation — validate before
                                        # rendering so the ElicitationCard
                                        # never shows broken/malformed data.
                                        if _tc_name == "ask_questions":
                                            try:
                                                _qs = _unwrap_json_param(
                                                    _tc_args.get("questions", "[]")
                                                    if isinstance(_tc_args, dict)
                                                    else "[]",
                                                    "questions",
                                                )
                                                if isinstance(_qs, list):
                                                    # Per-item validation
                                                    # (mirrors ask_tools.py).
                                                    _valid: list[dict] = []
                                                    for _qi, _q in enumerate(_qs):
                                                        if not isinstance(_q, dict):
                                                            continue
                                                        _qh = str(_q.get("header", f"Q{_qi + 1}")).strip()[:50]
                                                        _qt = str(_q.get("question", "")).strip()[:200]
                                                        if not _qt:
                                                            continue
                                                        _valid.append({
                                                            "header": _qh,
                                                            "question": _qt,
                                                            "multiSelect": bool(_q.get("multiSelect", False)),
                                                            "allowFreeformInput": bool(_q.get("allowFreeformInput", True)),
                                                            "options": _q.get("options") if isinstance(_q.get("options"), list) and len(_q["options"]) > 0 else None,
                                                        })
                                                    if _valid:
                                                        # ── Bridge to blocking HITL ──────────
                                                        # Generate a request_id and park a
                                                        # Future so the ask_questions tool
                                                        # function can block until the user
                                                        # answers.  Without this the tool
                                                        # returns immediately via Path B, the
                                                        # LLM stops without producing text,
                                                        # and the chat "dies" with no output.
                                                        import uuid as _uuid  # noqa: PLC0415
                                                        _req_id = _uuid.uuid4().hex
                                                        _active_elicitation_request_id.set(
                                                            _req_id)
                                                        _loop = asyncio.get_running_loop()
                                                        _fut: "asyncio.Future[dict[str, Any]]" = (
                                                            _loop.create_future())
                                                        _pending_user_input[_req_id] = _fut
                                                        # ── Track which tool_call_id maps to
                                                        # this elicitation so cleanup only fires
                                                        # for the matching function_result.
                                                        _elicitation_tc_ids[
                                                            _req_id] = _tc_id
                                                        _log.debug(
                                                            "executor.elicitation_parked",
                                                            request_id=_req_id[:12],
                                                            question_count=len(_valid),
                                                            tool_call_id=_tc_id[:12],
                                                        )
                                                        yield _sse({
                                                            "type": "CUSTOM",
                                                            "name": "elicitation_requested",
                                                            "value": {
                                                                "questions": _valid,
                                                                "request_id": _req_id,
                                                            },
                                                        })
                                            except Exception:  # noqa: BLE001
                                                pass
                                        if not _emitted and _todo_tracker.feed(_tc_name, _tc_args):
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
                                    # ── Clean up elicitation bridge ──────
                                    # Only clear when this function_result
                                    # belongs to a pending ask_questions
                                    # call (matched by tool_call_id stored
                                    # alongside the Future).  Previously
                                    # ANY function_result would reset the
                                    # ContextVar, causing a race where a
                                    # second tool's completion cleared the
                                    # bridge before ask_questions could
                                    # park on the Future.
                                    _elic_id = (
                                        _active_elicitation_request_id.get(
                                            None))
                                    if _elic_id:
                                        # Only clear if this result matches
                                        # the elicitation's tool_call_id
                                        # or if no tool_call_id was stored
                                        # (defensive: clear anyway).
                                        _elic_tc_id = _elicitation_tc_ids.get(
                                            _elic_id)
                                        if (_elic_tc_id is None
                                                or _elic_tc_id == _tc_id):
                                            _active_elicitation_request_id.set(
                                                None)
                                            _pending_user_input.pop(
                                                _elic_id, None)
                                            _elicitation_tc_ids.pop(
                                                _elic_id, None)
                                            _log.debug(
                                                "executor.elicitation_cleaned",
                                                request_id=_elic_id[:12],
                                                tool_call_id=_tc_id[:12],
                                            )
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

                # ── Artifact event relay ─────────────────────────────────
                # Create a queue and expose it via _active_run_queue so the
                # write_artifact tool (and any other tool) can push CUSTOM
                # events (artifact_created, etc.) into the active SSE stream.
                # Without this the Copilot SDK path never forwards artifact
                # events — they silently drop because _active_run_queue is None.
                _artifact_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
                _t15_token = _active_run_queue.set(_artifact_queue)

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
                            # ── Drain artifact events (write_artifact pushes
                            # artifact_created CUSTOM events here) ──────────
                            while not _artifact_queue.empty():
                                _aev = _artifact_queue.get_nowait()
                                if _aev:
                                    yield _sse(_aev)
                        # Drain any remaining artifact events after stream ends
                        while not _artifact_queue.empty():
                            _aev = _artifact_queue.get_nowait()
                            if _aev:
                                yield _sse(_aev)
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

                # ── Drain any late-arriving artifact events + reset queue ─
                while not _artifact_queue.empty():
                    _aev = _artifact_queue.get_nowait()
                    if _aev:
                        yield _sse(_aev)
                _active_run_queue.reset(_t15_token)

                # ── Premature stream-end detection ───────────────────────
                # If text was started but no tool call completed after it,
                # the model likely stopped mid-thought (token limit reached,
                # content filter, provider error).  Log a warning so
                # operators can diagnose and tune COPILOT_MAX_OUTPUT_TOKENS.
                if _text_started and not _msg_id:
                    _log.warning(
                        "executor.copilot_premature_end",
                        agent=agent_name,
                        run_id=run_id,
                        hint=(
                            "Model emitted text but stream ended before "
                            "completion.  Try increasing "
                            "COPILOT_MAX_OUTPUT_TOKENS (current default "
                            "16000) or check provider logs for content "
                            "filter / rate-limit events."
                        ),
                    )
                if _msg_id and _text_started:
                    yield _sse({"type": "TEXT_MESSAGE_END", "messageId": _msg_id})
                elif not _text_started:
                    # Stream ended without any assistant text — surface as
                    # a warning so the frontend doesn't show an empty bubble.
                    _log.warning(
                        "executor.copilot_no_text",
                        agent=agent_name,
                        run_id=run_id,
                    )
                    yield _sse({
                        "type": "RUN_ERROR",
                        "runId": run_id,
                        "message": (
                            "The agent produced no text output.  The "
                            "underlying model may have hit a token limit, "
                            "content filter, or provider error.  Check "
                            "gateway logs for details."
                        ),
                        "code": "NO_OUTPUT",
                    })
                    return
                yield _sse({"type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id})

                await _detect_agent_commits(
                    agent_name, _effective_agent_dir, run_id,
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
                    _system_context = event_payload.get("system_context") or ""
                    if _is_byok_early and _history_msgs:
                        try:
                            from agent_framework import \
                                Message as _MAFMsg  # noqa: PLC0415
                            _maf_messages: list[Any] = []
                            # Lead with the caller's system context (persona / app
                            # context) so multi-turn BYOK runs keep it too — the
                            # string `message` path (used on the first turn) carries
                            # it via _build_event_message, but the structured
                            # message-list path here would otherwise drop it.
                            if _system_context.strip():
                                _maf_messages.append(
                                    _MAFMsg(role="system", content=_system_context.strip())
                                )
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
        _active_run_model.reset(_model_token)
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
                        _apply_agent_md_overrides(
                            agents, loaded.agent_dir, agent_name,
                        )
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
                    _apply_agent_md_overrides(
                        agents, loaded.agent_dir, agent_name,
                    )
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


def _compose_maf_run_input(
    agent_name: str,
    run_id: str,
    event_payload: dict[str, Any],
    integrations: dict[str, Any],
    *,
    is_byok: bool,
) -> Any:
    """Build the input passed to a native MAF ``agent.run(...)`` call.

    Mirrors the Tier 2 batch path's message construction so the streaming and
    batch paths feed the agent identically:

    * BYOK + history present → a structured ``list[Message]`` (the caller's
      ``system_context`` as a leading system message, then the last ~10
      exchanges, then the current user turn) so the model sees full turn
      structure.
    * Otherwise → the composed prompt string from :func:`_build_event_message`
      (which already folds in memory_context + system_context + history).
    """
    message = _build_event_message(agent_name, run_id, event_payload, integrations)
    history_msgs = event_payload.get("messages") or []
    current_msg_text = (
        event_payload.get("message") or event_payload.get("user_query") or ""
    )
    system_context = event_payload.get("system_context") or ""
    if is_byok and history_msgs:
        try:
            from agent_framework import Message as _MAFMsg
            maf_messages: list[Any] = []
            if system_context.strip():
                maf_messages.append(
                    _MAFMsg(role="system", content=system_context.strip())
                )
            for _h in history_msgs[-20:]:
                _h_role = _h.get("role", "user")
                _h_content = (_h.get("content") or "").strip()
                if not _h_content:
                    continue
                if _h_role == "user" and _h_content == current_msg_text.strip():
                    continue
                maf_messages.append(_MAFMsg(role=_h_role, content=_h_content))
            if current_msg_text.strip():
                maf_messages.append(
                    _MAFMsg(role="user", content=current_msg_text.strip())
                )
            return maf_messages if maf_messages else message
        except Exception:
            return message
    return message


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

    # Caller-supplied system context (persona / app context — e.g. the email
    # app's currently-selected account + open email).  Injected as a preamble so
    # the agent operates with that context without the user having to repeat it.
    system_ctx = event_payload.get("system_context") or ""
    if system_ctx:
        parts.append("## Current context\n" + system_ctx)
    if history:
        history_lines: list[str] = []
        # Cap at last 16 messages (8 exchanges) to avoid context/payload limits.
        # Technique #1 (tool result clearing): strip raw tool-call JSON from old
        # assistant messages — the LLM doesn't need to re-read 5k-token API
        # dumps that are deep in history; only final prose answers matter.
        _sliced = history[-16:]
        total = len(_sliced)
        for idx, m in enumerate(_sliced):
            role = m.get("role", "user")
            content = (m.get("content") or "").strip()
            if not content:
                continue
            # Skip the current message if it's already in history
            if role == "user" and content == current_msg.strip():
                continue
            label = "User" if role == "user" else "Assistant"
            # For older messages (not last 3), strip embedded tool result blocks
            is_recent = idx >= total - 3
            if not is_recent and role == "assistant":
                content = _TOOL_RESULT_RE.sub("", content).strip()
            short = content if len(content) <= 600 else content[:600] + "…"
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


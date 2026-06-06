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
        Legacy Copilot SDK path  — appends to ``agent._default_options.tools`` (list)
    """
    try:
        from acb_skills.agent_tools import (  # noqa: PLC0415
            call_agent,
            call_agent_background,
        )
        _extra_tools = [call_agent, call_agent_background]
    except ImportError:
        return  # acb_skills not installed in this env — skip silently

    for agent in agents:
        injected = False

        # ── GitHubCopilotAgent (agent-framework-ag-ui) ──────────────────────
        # Stores tools in self._tools (a list); fed into SessionConfig at run time.
        # Must be patched BEFORE the MAF path because GitHubCopilotAgent also
        # sets self.tools = [] (empty) via its base class — we don't want to
        # append to that empty list and skip the real _tools.
        try:
            if hasattr(agent, "_tools") and isinstance(agent._tools, list):
                existing_names = {
                    getattr(getattr(t, "func", t), "__name__", None)
                    for t in agent._tools
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        agent._tools.append(fn)
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
        try:
            opts = getattr(agent, "_default_options", None)
            if opts is not None:
                existing = list(getattr(opts, "tools", []) or [])
                existing_names = {
                    getattr(fn, "__name__", None) for fn in existing
                }
                for fn in _extra_tools:
                    if fn.__name__ not in existing_names:
                        existing.append(fn)
                opts.tools = existing
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
        from gateway.routes.agent import (  # noqa: PLC0415
            _AGENT_REGISTRY,
            _load_dynamic_agents,
        )
        _all = _load_dynamic_agents() + _AGENT_REGISTRY
        entry = next((e for e in _all if e["name"] == agent_name), None)
        if entry:
            raw = entry.get("repo_name") or ""
            _repo_name = raw.split("/")[-1] if raw else None
            _local_path = entry.get("local_path")
            _runtime = entry.get("agent_runtime", "maf")
    except (ImportError, Exception):  # noqa: BLE001
        pass

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

            text_parts: list[str] = []

            if _runtime == "github-copilot" and hasattr(agent, "run"):
                # Apply model override.
                _model = (getattr(settings, "copilot_chat_model", "") or "").strip()
                if _model:
                    try:
                        if hasattr(agent, "_default_options") and agent._default_options is not None:
                            agent._default_options.model = _model
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
            from gateway.routes.agent import (_AGENT_REGISTRY,  # noqa: PLC0415
                                              _load_dynamic_agents)
            _all_entries = _load_dynamic_agents() + _AGENT_REGISTRY
            _registry_entry = next(
                (e for e in _all_entries if e["name"] == agent_name), None
            )
            if _registry_entry:
                raw_repo = _registry_entry.get("repo_name") or ""
                # repo_name may be stored as "owner/repo" (full slug from registration)
                # or just "repo". load_agent expects only the repo portion.
                _registry_repo_name = raw_repo.split("/")[-1] if raw_repo else None
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
        from orchestrator.mutation import attempt_self_mutation  # noqa: PLC0415
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

def _sse(payload: dict[str, Any]) -> str:
    """Return a single SSE frame as a string."""
    return f"data: {json.dumps(payload)}\n\n"


async def run_agent_stream(
    agent_name: str,
    event_payload: dict[str, Any],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
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

    # ── Resolve agent metadata ──────────────────────────────────────────────
    _registry_repo_name: str | None = None
    _registry_local_path: str | None = None
    _agent_runtime: str = "maf"
    try:
        from gateway.routes.agent import (_AGENT_REGISTRY,  # noqa: PLC0415
                                          _load_dynamic_agents)
        _all = _load_dynamic_agents() + _AGENT_REGISTRY
        entry = next((e for e in _all if e["name"] == agent_name), None)
        if entry:
            raw = entry.get("repo_name") or ""
            _registry_repo_name = raw.split("/")[-1] if raw else None
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

            if not agents:
                raise ValueError(f"Agent {agent_name!r}: build_agents() returned empty list.")

            agent = agents[0]

            # Ensure permission handler is set for GitHubCopilotAgent before ANY
            # execution path — repos often omit it from default_options.
            try:
                from copilot import PermissionHandler as _PH  # noqa: PLC0415
                for _a in agents:
                    if hasattr(_a, "_permission_handler") and _a._permission_handler is None:
                        _a._permission_handler = _PH.approve_all
            except Exception:  # noqa: BLE001
                pass

            # ── Tier 1: try native MAF AG-UI streaming ──────────────────────
            try:
                from agent_framework.ag_ui import (  # noqa: PLC0415
                    stream_agent_response,
                )
                message = _build_event_message(agent_name, run_id, event_payload, integrations)
                async for line in stream_agent_response(agent, message, run_id=run_id):
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
            # Queue-based approach (not direct yield): the agent runs in a
            # background task that pushes events to a queue.  The main loop
            # drains the queue and yields SSE.  This allows tool calls
            # (including call_agent sub-delegation) to push SUB_AGENT_* events
            # into the same queue while the main loop is waiting — giving
            # real-time visibility of sub-agent progress in the UI.
            if _agent_runtime == "github-copilot" and hasattr(agent, "run"):
                try:
                    # Inject model override from settings (copilot_chat_model).
                    _configured_model = (getattr(settings, "copilot_chat_model", "") or "").strip()
                    if _configured_model:
                        for _a in agents:
                            try:
                                if hasattr(_a, "_default_options") and _a._default_options is not None:
                                    _a._default_options.model = _configured_model
                            except Exception:  # noqa: BLE001
                                pass

                    message = _build_event_message(agent_name, run_id, event_payload, integrations)

                    _sdk_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
                    _sdk_token = _active_run_queue.set(_sdk_queue)

                    async def _run_copilot_stream() -> None:  # noqa: PLR0912
                        try:
                            async with agent:
                                response_stream = agent.run(message, stream=True)
                                async for update in response_stream:
                                    for content in (update.contents or []):
                                        ct = getattr(content, "type", "")
                                        if ct == "text":
                                            await _sdk_queue.put({
                                                "type": "TEXT_MESSAGE_CONTENT",
                                                "messageId": run_id,
                                                "delta": content.text or "",
                                            })
                                        elif ct == "function_call":
                                            call_id = getattr(content, "call_id", run_id)
                                            tool_name_fc = getattr(content, "name", "tool")
                                            args_fc = getattr(content, "arguments", None)
                                            await _sdk_queue.put({
                                                "type": "TOOL_CALL_START",
                                                "toolCallId": call_id,
                                                "toolCallName": tool_name_fc,
                                            })
                                            if args_fc is not None:
                                                try:
                                                    args_str_fc = json.dumps(args_fc) if not isinstance(args_fc, str) else args_fc
                                                except Exception:  # noqa: BLE001
                                                    args_str_fc = str(args_fc)
                                                await _sdk_queue.put({
                                                    "type": "TOOL_CALL_ARGS",
                                                    "toolCallId": call_id,
                                                    "delta": args_str_fc,
                                                })
                                        elif ct == "function_result":
                                            call_id = getattr(content, "call_id", run_id)
                                            result_fr = getattr(content, "result", "") or ""
                                            exc_fr = getattr(content, "exception", None)
                                            await _sdk_queue.put({
                                                "type": "TOOL_CALL_RESULT",
                                                "toolCallId": call_id,
                                                "content": str(exc_fr) if exc_fr else str(result_fr),
                                                "success": exc_fr is None,
                                            })
                        except Exception as _e:  # noqa: BLE001
                            await _sdk_queue.put({
                                "type": "RUN_ERROR",
                                "runId": run_id,
                                "message": str(_e),
                            })
                        finally:
                            await _sdk_queue.put(None)  # sentinel

                    _sdk_task = asyncio.create_task(_run_copilot_stream())
                    try:
                        while True:
                            try:
                                ev = await asyncio.wait_for(_sdk_queue.get(), timeout=0.1)
                                if ev is None:
                                    break
                                yield _sse(ev)
                            except asyncio.TimeoutError:
                                if _sdk_task.done():
                                    while not _sdk_queue.empty():
                                        ev = _sdk_queue.get_nowait()
                                        if ev:
                                            yield _sse(ev)
                                    break
                    finally:
                        _active_run_queue.reset(_sdk_token)
                    yield _sse({"type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id})
                    return
                except Exception as _sdk_exc:  # noqa: BLE001
                    _log.warning("executor.sdk_stream_failed", agent=agent_name, error=str(_sdk_exc))
                    yield _sse({"type": "RUN_ERROR", "runId": run_id, "message": str(_sdk_exc)})
                    return

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
                        from copilot import CopilotClient as _CopilotClient  # noqa: PLC0415
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
                            agent._client = _CopilotClient(_cli_opts if _cli_opts else None)
                            agent._owns_client = True
                    except Exception:  # noqa: BLE001
                        pass

                    if hasattr(type(agent), "__aenter__"):
                        await stack.enter_async_context(agent)
                    # Apply approve_all permission handler if needed (GitHubCopilotAgent)
                    try:
                        from copilot import PermissionHandler as _PH  # noqa: PLC0415
                        if hasattr(agent, "_permission_handler") and agent._permission_handler is None:
                            agent._permission_handler = _PH.approve_all
                    except Exception:  # noqa: BLE001
                        pass
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

            # Restore patched tools
            for attr, _, original in patched:
                try:
                    object.__setattr__(agent, attr, original)
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

    except AgentRunError:
        raise
    except Exception as exc:
        yield _sse({
            "type": "RUN_ERROR",
            "message": str(exc),
            "code": type(exc).__name__,
        })
        return

    yield _sse({"type": "RUN_FINISHED", "runId": run_id, "threadId": thread_id})


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
        "anthropic":     [("api_key", "ANTHROPIC_API_KEY")],
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
            from agent_framework._types import Message as _Message  # noqa: PLC0415

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

    # Main user message — prefer explicit "message" or "user_query" keys
    msg = event_payload.get("message") or event_payload.get("user_query") or ""
    if msg:
        parts.append(msg)
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


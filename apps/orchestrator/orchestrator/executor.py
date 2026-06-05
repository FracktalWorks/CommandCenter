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

    from orchestrator.executor import run_agent

    result = await run_agent("task-manager", {"clickup_event": {...}})
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings
from acb_skills.integrations import build_integrations
from acb_skills.loader import AgentLoadError, load_agent

# Max self-anneal retries before giving up and falling back to LLM recovery.
_MAX_ANNEAL_ATTEMPTS = 2

_log = get_logger("orchestrator.executor")


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
    message = _build_event_message(agent_name, run_id, event_payload, integrations)

    async with contextlib.AsyncExitStack() as stack:
        # GitHubCopilotAgent (and any agent with lifecycle) requires start/stop.
        # Standard Agent has a no-op __aenter__/__aexit__ — both are safe here.
        if hasattr(type(agent), "__aenter__"):
            await stack.enter_async_context(agent)
        response = await agent.run(message)

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


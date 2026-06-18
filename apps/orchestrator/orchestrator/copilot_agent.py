from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from typing import Any, AsyncIterable

from agent_framework import AgentResponseUpdate, Content, Message
from agent_framework.exceptions import AgentException
from agent_framework_github_copilot import GitHubCopilotAgent
from copilot import CopilotClient, CopilotSession, SessionEvent
from copilot.session import SessionEventType

logger = logging.getLogger(__name__)


class CommandCenterCopilotAgent(GitHubCopilotAgent):
    """GitHubCopilotAgent with BYOK provider forwarding and rich event streaming.

    Extends the standard GitHubCopilotAgent to:
    1. Forward ``provider`` config for BYOK (Bring Your Own Key) support
    2. Emit additional event types: reasoning/thinking, tool progress,
       partial terminal output, agent intent/status
    3. Store ``raw_representation`` on every AgentResponseUpdate for
       downstream AG-UI event translation
    4. Headless auth: pass COPILOT_GITHUB_TOKEN explicitly to the Copilot
       CLI (servers have no logged-in ``copilot`` CLI user)
    """

    async def start(self) -> None:
        """Start the Copilot client with explicit token auth when available.

        The upstream GitHubCopilotAgent.start() relies on the CLI's
        logged-in user, which does not exist on headless servers.  When
        COPILOT_GITHUB_TOKEN (preferred) or GITHUB_COPILOT_TOKEN is set,
        construct the client with ``github_token`` so the SDK forwards it
        as COPILOT_SDK_AUTH_TOKEN to the CLI subprocess.
        """
        token = (
            os.environ.get("COPILOT_GITHUB_TOKEN")
            or os.environ.get("GITHUB_COPILOT_TOKEN")
            or ""
        ).strip()
        if self._client is None and token:
            client_options: dict[str, Any] = {"github_token": token}
            cli_path = self._settings.get("cli_path")
            if cli_path:
                client_options["cli_path"] = cli_path
            log_level = self._settings.get("log_level")
            if log_level:
                client_options["log_level"] = log_level
            self._client = CopilotClient(client_options)
            logger.info("Copilot client using explicit token auth")
        # Explicit base call (not super()): this method is monkey-patched
        # onto plain GitHubCopilotAgent instances, where zero-arg super()
        # raises "obj must be an instance or subtype of type".
        await GitHubCopilotAgent.start(self)

    async def _create_session(
        self,
        streaming: bool,
        runtime_options: dict[str, Any] | None = None,
    ) -> CopilotSession:
        """Create Copilot session with BYOK provider support."""
        if not self._client:
            raise RuntimeError("GitHub Copilot client not initialized. Call start() first.")

        opts = runtime_options or {}
        config: dict[str, Any] = {"streaming": streaming}

        model = opts.get("model") or self._default_options.get("model") or self._settings.get("model")
        if model:
            config["model"] = model

        system_message = opts.get("system_message") or self._default_options.get("system_message")
        if system_message:
            config["system_message"] = system_message

        if self._tools:
            config["tools"] = self._prepare_tools(self._tools)

        permission_handler = opts.get("on_permission_request") or self._permission_handler
        if permission_handler:
            config["on_permission_request"] = permission_handler

        mcp_servers = opts.get("mcp_servers") or self._mcp_servers
        if mcp_servers:
            config["mcp_servers"] = mcp_servers

        # === BYOK: forward provider config to Copilot SDK ===
        provider = opts.get("provider") or self._default_options.get("provider")
        if provider:
            config["provider"] = provider

        # === Reasoning: forward effort so thinking deltas stream ===
        effort = (
            opts.get("reasoning_effort")
            or self._default_options.get("reasoning_effort")
        )
        if effort:
            config["reasoning_effort"] = effort
            try:
                return await self._client.create_session(config)
            except Exception:  # noqa: BLE001
                # Model may not support reasoning_effort — retry without.
                logger.warning(
                    "create_session failed with reasoning_effort=%s; "
                    "retrying without", effort,
                )
                config.pop("reasoning_effort", None)

        return await self._client.create_session(config)

    async def _resume_session(
        self,
        session_id: str,
        streaming: bool,
    ) -> CopilotSession:
        """Resume a Copilot session, re-applying the agent's identity.

        The upstream ``_resume_session`` forwards only ``tools``,
        ``on_permission_request`` and ``mcp_servers`` — it drops
        ``system_message`` (the agent's instructions / identity),
        ``provider`` (BYOK routing) and ``model``.  On page refresh or
        when re-opening an old chat the stored session is resumed, so
        without these the agent loses its persona and reverts to the
        generic GitHub Copilot CLI identity.  Re-apply them here so a
        resumed session behaves identically to a freshly created one.
        """
        if not self._client:
            raise RuntimeError(
                "GitHub Copilot client not initialized. Call start() first."
            )

        config: dict[str, Any] = {"streaming": streaming}

        model = self._default_options.get("model") or self._settings.get("model")
        if model:
            config["model"] = model

        system_message = self._default_options.get("system_message")
        if system_message:
            config["system_message"] = system_message

        if self._tools:
            config["tools"] = self._prepare_tools(self._tools)

        if self._permission_handler:
            config["on_permission_request"] = self._permission_handler

        mcp_servers = self._mcp_servers
        if mcp_servers:
            config["mcp_servers"] = mcp_servers

        # === BYOK: forward provider config so resumed sessions route correctly
        provider = self._default_options.get("provider")
        if provider:
            config["provider"] = provider

        # === Reasoning: forward effort so thinking deltas keep streaming ===
        effort = self._default_options.get("reasoning_effort")
        if effort:
            config["reasoning_effort"] = effort
            try:
                return await self._client.resume_session(session_id, config)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "resume_session failed with reasoning_effort=%s; "
                    "retrying without", effort,
                )
                config.pop("reasoning_effort", None)

        return await self._client.resume_session(session_id, config)

    async def _stream_updates(
        self,
        messages=None,
        *,
        session=None,
        options=None,
        _ctx_holder=None,
    ) -> AsyncIterable[AgentResponseUpdate]:
        """Stream updates with full event type coverage.

        Handles ALL Copilot SDK event types:
        - Text deltas (ASSISTANT_MESSAGE_DELTA)
        - Reasoning/thinking (ASSISTANT_REASONING_DELTA, ASSISTANT_REASONING)
        - Tool execution (TOOL_EXECUTION_START, TOOL_EXECUTION_COMPLETE,
          TOOL_EXECUTION_PROGRESS, TOOL_EXECUTION_PARTIAL_RESULT)
        - Agent intent/status (ASSISTANT_INTENT)
        - Final messages (ASSISTANT_MESSAGE)
        - Session lifecycle (SESSION_IDLE, SESSION_ERROR)
        """
        if not self._started:
            await self.start()

        if not session:
            session = self.create_session()

        opts: dict[str, Any] = dict(options) if options else {}

        from agent_framework import normalize_messages

        input_messages = normalize_messages(messages)

        session_context = await self._run_before_providers(
            session=session, input_messages=input_messages, options=opts
        )

        copilot_session = await self._get_or_create_session(
            session, streaming=True, runtime_options=opts
        )

        if _ctx_holder is not None:
            _ctx_holder["session_context"] = session_context
            _ctx_holder["session"] = session

        context_messages = session_context.get_messages(include_input=True)
        prompt = "\n".join([m.text for m in context_messages])
        if session_context.instructions:
            prompt = "\n".join(session_context.instructions) + "\n" + prompt

        queue: asyncio.Queue[AgentResponseUpdate | Exception | None] = asyncio.Queue()

        # Reasoning blocks already streamed as deltas — used to skip the
        # duplicate full-content ASSISTANT_REASONING event at block end.
        _streamed_reasoning_ids: set[str] = set()

        # Accumulated assistant text from deltas — used to detect and skip
        # the duplicate full-content ASSISTANT_MESSAGE event at turn end.
        _accumulated_text: str = ""

        def _on_event(event: SessionEvent) -> None:
            """Translate Copilot SDK events to AgentResponseUpdate objects."""
            nonlocal _accumulated_text
            try:
                t = event.type
                d = event.data

                # ── Debug: log every event type and content-bearing data ──
                _dbg_extra: dict[str, Any] = {}
                _has_delta = getattr(d, "delta_content", None)
                _has_content = getattr(d, "content", None)
                if _has_delta:
                    _dbg_extra["delta_len"] = len(str(_has_delta))
                if _has_content:
                    _dbg_extra["content_len"] = len(str(_has_content))
                _dbg_extra["accum_len"] = len(_accumulated_text)
                logger.debug(
                    "copilot_event: %s", t.value,
                    extra=_dbg_extra,
                )

                if t == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                    if d.delta_content:
                        _accumulated_text += (d.delta_content or "")
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text(d.delta_content)],
                            response_id=d.message_id,
                            message_id=d.message_id,
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_REASONING_DELTA:
                    delta = getattr(d, "delta_content", "") or ""
                    if delta:
                        _rid = (
                            getattr(d, "reasoning_id", None)
                            or getattr(d, "id", None)
                            or "_default"
                        )
                        _streamed_reasoning_ids.add(str(_rid))
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text_reasoning(text=delta)],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_REASONING:
                    content = getattr(d, "content", "") or ""
                    _rid = (
                        getattr(d, "reasoning_id", None)
                        or getattr(d, "id", None)
                        or "_default"
                    )
                    # Skip if this block already streamed as deltas —
                    # emitting it again would duplicate the thinking text.
                    if content and str(_rid) not in _streamed_reasoning_ids:
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text_reasoning(text=content)],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_INTENT:
                    intent = getattr(d, "intent", "") or ""
                    if intent:
                        # No text content — the executor translates the raw
                        # INTENT event into a timeline entry.  Emitting text
                        # here would pollute the visible assistant message.
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.TOOL_EXECUTION_START:
                    tc_id = getattr(d, "tool_call_id", "") or ""
                    tc_name = getattr(d, "tool_name", "") or ""
                    args = getattr(d, "arguments", None)
                    queue.put_nowait(AgentResponseUpdate(
                        role="assistant",
                        contents=[Content.from_function_call(
                            call_id=tc_id,
                            name=tc_name,
                            arguments=args,
                            raw_representation=d,
                        )],
                        raw_representation=event,
                    ))

                elif t == SessionEventType.TOOL_EXECUTION_COMPLETE:
                    tc_id = getattr(d, "tool_call_id", "") or ""
                    result_obj = getattr(d, "result", None)
                    result_text = getattr(result_obj, "content", "") if result_obj else ""
                    success = getattr(d, "success", None)
                    error_val = getattr(d, "error", None)
                    exception = None
                    if success is False and error_val is not None:
                        exception = (
                            error_val.message
                            if hasattr(error_val, "message")
                            else str(error_val)
                        )
                    queue.put_nowait(AgentResponseUpdate(
                        role="tool",
                        contents=[Content.from_function_result(
                            call_id=tc_id,
                            result=result_text or "",
                            exception=exception,
                            raw_representation=d,
                        )],
                        raw_representation=event,
                    ))

                # ── External / custom tool execution (our injected tools) ──
                # Custom tools registered via _register_tools() use the
                # EXTERNAL_TOOL_REQUESTED / EXTERNAL_TOOL_COMPLETED event
                # pair instead of the built-in TOOL_EXECUTION_* events.
                # Without these handlers, our injected tools (manage_todo_list,
                # ask_questions, etc.) execute but are invisible to the
                # streaming loop — no TODO_LIST events, no UI updates.
                elif t == SessionEventType.EXTERNAL_TOOL_REQUESTED:
                    tc_id = getattr(d, "tool_call_id", "") or ""
                    tc_name = getattr(d, "tool_name", "") or ""
                    args = getattr(d, "arguments", None)
                    queue.put_nowait(AgentResponseUpdate(
                        role="assistant",
                        contents=[Content.from_function_call(
                            call_id=tc_id,
                            name=tc_name,
                            arguments=args,
                            raw_representation=d,
                        )],
                        raw_representation=event,
                    ))

                elif t == SessionEventType.EXTERNAL_TOOL_COMPLETED:
                    tc_id = getattr(d, "tool_call_id", "") or ""
                    result_obj = getattr(d, "result", None)
                    result_text = (
                        getattr(result_obj, "content", "")
                        if result_obj else ""
                    )
                    success = getattr(d, "success", None)
                    error_val = getattr(d, "error", None)
                    exception = None
                    if success is False and error_val is not None:
                        exception = (
                            error_val.message
                            if hasattr(error_val, "message")
                            else str(error_val)
                        )
                    queue.put_nowait(AgentResponseUpdate(
                        role="tool",
                        contents=[Content.from_function_result(
                            call_id=tc_id,
                            result=result_text or "",
                            exception=exception,
                            raw_representation=d,
                        )],
                        raw_representation=event,
                    ))

                elif t == SessionEventType.TOOL_EXECUTION_PROGRESS:
                    progress = (
                        getattr(d, "progress_message", None)
                        or getattr(d, "progress", None)
                        or getattr(d, "message", None)
                        or ""
                    )
                    if progress:
                        queue.put_nowait(AgentResponseUpdate(
                            role="tool",
                            contents=[Content.from_text(f"[progress] {progress}")],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.TOOL_EXECUTION_PARTIAL_RESULT:
                    partial = (
                        getattr(d, "partial_output", None)
                        or getattr(d, "partialOutput", None)
                        or ""
                    )
                    if partial:
                        queue.put_nowait(AgentResponseUpdate(
                            role="tool",
                            contents=[Content.from_text(partial)],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_MESSAGE:
                    content = getattr(d, "content", "") or ""
                    # In streaming mode, ASSISTANT_MESSAGE is always a
                    # duplicate of the deltas already streamed above.
                    # Skip it unconditionally when deltas were seen.
                    # When no deltas fired (non-streaming fallback),
                    # emit the full message as the sole content source.
                    # Set _accumulated_text so a second ASSISTANT_MESSAGE
                    # for the same turn is also blocked.
                    if content and not _accumulated_text:
                        _accumulated_text = content
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text(content)],
                            response_id=d.message_id,
                            message_id=d.message_id,
                            raw_representation=event,
                        ))

                elif t == SessionEventType.SESSION_IDLE:
                    queue.put_nowait(None)

                elif t == SessionEventType.SESSION_ERROR:
                    error_msg = getattr(d, "message", "") or "Unknown error"
                    queue.put_nowait(
                        AgentException(f"GitHub Copilot session error: {error_msg}")
                    )

            except Exception:
                logger.exception(
                    "Error in CommandCenterCopilotAgent event handler"
                )

        copilot_session.on(_on_event)

        try:
            await copilot_session.send({"prompt": prompt})

            while True:
                update = await queue.get()
                if update is None:
                    break
                if isinstance(update, Exception):
                    raise update
                yield update
        finally:
            with contextlib.suppress(Exception):
                copilot_session.off(_on_event)

    async def _run_impl(
        self,
        messages=None,
        *,
        session=None,
        options=None,
    ):
        """Non-streaming run that inherits BYOK forwarding from _create_session."""
        return await super()._run_impl(
            messages=messages, session=session, options=options
        )

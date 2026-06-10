from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, AsyncIterable

from agent_framework import AgentResponseUpdate, Content, Message
from agent_framework.exceptions import AgentException
from agent_framework_github_copilot import GitHubCopilotAgent
from copilot import CopilotSession, SessionEvent
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
    """

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

        return await self._client.create_session(config)

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

        def _on_event(event: SessionEvent) -> None:
            """Translate Copilot SDK events to AgentResponseUpdate objects."""
            try:
                t = event.type
                d = event.data

                if t == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                    if d.delta_content:
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
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text_reasoning(delta)],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_REASONING:
                    content = getattr(d, "content", "") or ""
                    if content:
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text_reasoning(content)],
                            raw_representation=event,
                        ))

                elif t == SessionEventType.ASSISTANT_INTENT:
                    intent = getattr(d, "intent", "") or ""
                    if intent:
                        queue.put_nowait(AgentResponseUpdate(
                            role="assistant",
                            contents=[Content.from_text(f"[Intent] {intent}")],
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
                    if content:
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

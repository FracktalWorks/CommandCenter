"""HITL elicitation tool — agent asks the user clarifying questions mid-stream.

Provides ``ask_questions`` which mirrors VS Code Copilot Chat's
``vscode_askQuestions`` tool.  The agent pauses execution, the Control Plane
renders an interactive card with structured questions, and the user's answers
are injected as the next user message so the agent can continue with context.

Design (VS Code parity)
-----------------------
- Accepts an array of question objects, each with a ``header``, ``question``
  text, optional ``options`` (single/multi-select), and optional freeform input.
- One question can be marked ``recommended`` to highlight the default choice.
- The tool emits a ``CUSTOM`` AG-UI event (``elicitation_requested``) into the
  active SSE queue; the frontend renders an ``ElicitationCard`` inline.
- The agent MUST stop after calling this tool — the user's response will
  arrive as the next chat message.

Usage by agents::

    await ask_questions(json.dumps({
        "questions": [
            {
                "header": "Target Environment",
                "question": "Should I deploy to staging or production?",
                "options": [
                    {"label": "Staging", "recommended": true},
                    {"label": "Production"}
                ]
            }
        ]
    }))
"""
from __future__ import annotations

import json as _json


async def ask_questions(questions: str) -> str:
    """Ask the user one or more clarifying questions before proceeding.

    The questions are rendered as interactive cards in the chat UI.  The user
    can select options, type freeform answers, or both.  Their answers will
    be sent as the next chat message for you to process.

    **Use this tool when:**
    - You need to disambiguate between multiple possible interpretations
    - The user's request is missing a required parameter
    - You want the user to choose from a known set of options
    - A decision has security, cost, or irreversibility implications

    **Do NOT use for:**
    - Simple yes/no confirmations (use your best judgment)
    - Questions you can answer yourself with a web search or tool call

    **After calling this tool, STOP and wait.**  The user's response will
    arrive as the next message in the conversation.

    Args:
        questions: JSON string with the shape:
            {
              "questions": [
                {
                  "header": "Short label (max 50 chars)",
                  "question": "The full question text (max 200 chars)",
                  "multiSelect": false,
                  "allowFreeformInput": true,
                  "options": [
                    {"label": "Option A", "description": "What this means",
                     "recommended": true},
                    {"label": "Option B"}
                  ]
                }
              ]
            }
            - ``header`` (string, required): Short identifier, max 50 chars.
            - ``question`` (string, required): The question, max 200 chars.
            - ``multiSelect`` (bool, optional): Allow multiple selections.
            - ``allowFreeformInput`` (bool, optional): Allow freeform text
              in addition to options.  Default true when no options, false
              when options provided.
            - ``options`` (array, optional): List of selectable choices.
              Each option has a ``label`` (required) and optional
              ``description`` and ``recommended`` fields.

    Returns:
        ``"Questions displayed to the user. Waiting for response."``
        The agent MUST stop after receiving this and let the user answer.
    """
    try:
        data = _json.loads(questions)
    except (_json.JSONDecodeError, TypeError):
        return (
            "Error: questions must be valid JSON, e.g. "
            '\'{"questions":[{"header":"Confirm","question":"Proceed?"}]}\''
        )

    if not isinstance(data, dict):
        return "Error: questions must be a JSON object with a 'questions' key"

    qs = data.get("questions", [])
    if not isinstance(qs, list) or len(qs) == 0:
        return "Error: 'questions' must be a non-empty array"

    cleaned: list[dict] = []
    for i, q in enumerate(qs):
        if not isinstance(q, dict):
            return f"Error: question {i} is not an object"
        header = str(q.get("header", f"Question {i + 1}")).strip()[:50]
        question = str(q.get("question", "")).strip()[:200]
        if not question:
            return f"Error: question {i} has no question text"

        opts_raw = q.get("options", [])
        options: list[dict] = []
        if isinstance(opts_raw, list):
            for o in opts_raw:
                if isinstance(o, dict) and o.get("label"):
                    options.append({
                        "label": str(o["label"]).strip()[:100],
                        "description": str(o.get("description", "")).strip()[:200] or None,
                        "recommended": bool(o.get("recommended", False)),
                    })

        has_options = len(options) > 0
        cleaned.append({
            "header": header,
            "question": question,
            "multiSelect": bool(q.get("multiSelect", False)),
            "allowFreeformInput": bool(q.get(
                "allowFreeformInput", not has_options,
            )),
            "options": options if has_options else None,
        })

    # ── Emit elicitation event ──────────────────────────────────────────
    # Two paths, unified on the same _pending_user_input mechanism as the
    # Copilot SDK's native ask_user tool:
    #
    # Path A — MAF Tier 2 (blocking):  When _active_run_queue is set we
    #   are running inside the executor's instrumented batch path.  We
    #   create a Future, park on it, and return the user's answer directly
    #   as the tool result.  The agent truly blocks — same reliability as
    #   the Copilot SDK's native ask_user.  The frontend POSTs to
    #   /api/agent/respond-input to resolve the Future.
    #
    # Path B — Copilot SDK / standalone (non-blocking):  The elicitation
    #   card renders and the answer arrives as the next chat message.
    #   The agent must self-regulate (stop after the tool call).
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _active_run_queue,
            _pending_user_input,
        )
        queue = _active_run_queue.get(None)
    except Exception:  # noqa: BLE001
        queue = None

    if queue is not None:
        # ── Path A: blocking Future (MAF Tier 2) ─────────────────────
        import asyncio as _asyncio
        import uuid as _uuid

        _request_id = _uuid.uuid4().hex
        _loop = _asyncio.get_running_loop()
        _fut: "_asyncio.Future[dict[str, object]]" = _loop.create_future()
        _pending_user_input[_request_id] = _fut

        await queue.put({
            "type": "CUSTOM",
            "name": "elicitation_requested",
            "value": {"questions": cleaned, "request_id": _request_id},
        })

        try:
            _result = await _asyncio.wait_for(
                _fut, timeout=3600,
            )
        except _asyncio.TimeoutError:
            _pending_user_input.pop(_request_id, None)
            return "User did not respond in time."

        _answer = str(_result.get("answer", "") or "").strip()
        if not _answer:
            return "User provided an empty response."
        return f"User response: {_answer}"

    # ── Path B: Copilot SDK / standalone ──────────────────────────────
    # Two sub-paths:
    #
    # B1 — Executor-bridged blocking (preferred):  When the executor
    #   detected this ask_questions call and pre-created a Future in
    #   _pending_user_input (signalled via _active_elicitation_request_id
    #   ContextVar), we block on that Future.  The user's answer resolves
    #   the Future; we return the answer as the tool result; the LLM
    #   continues and produces text.  This prevents the "chat dies without
    #   output" bug that occurred when Path B returned immediately.
    #
    # B2 — Legacy non-blocking (fallback):  When no Future was pre-created
    #   (standalone use or executor bridge unavailable), emit the CUSTOM
    #   event (if queue available) and return immediately.  The answer
    #   arrives as the next chat message.
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _active_elicitation_request_id,
            _pending_user_input,
        )
        _req_id = _active_elicitation_request_id.get(None)
        # ── Poll for the executor bridge ──────────────────────────
        # The Copilot SDK fires tool execution concurrently with the
        # executor's streaming loop.  If we check _req_id before the
        # executor has processed the EXTERNAL_TOOL_REQUESTED event
        # and set the ContextVar, we fall through to the non-blocking
        # Path B2 and the agent doesn't pause.  Poll for up to 3s at
        # 50 ms intervals — same pattern used by the Copilot SDK's
        # native ask_user bridge.
        if _req_id is None:
            import asyncio as _asyncio
            _deadline = _asyncio.get_running_loop().time() + 3.0
            while _req_id is None:
                await _asyncio.sleep(0.05)
                _req_id = _active_elicitation_request_id.get(None)
                if _asyncio.get_running_loop().time() >= _deadline:
                    break
        if _req_id:
            _fut = _pending_user_input.get(_req_id)
            if _fut is not None:
                # ── B1: blocking bridge ──────────────────────────
                import asyncio as _asyncio
                try:
                    _result = await _asyncio.wait_for(
                        _fut, timeout=3600,
                    )
                except _asyncio.TimeoutError:
                    return "User did not respond in time."
                _answer = str(
                    _result.get("answer", "") or "").strip()
                if not _answer:
                    return "User provided an empty response."
                return f"User response: {_answer}"
    except Exception:  # noqa: BLE001
        pass

    # ── Path C: self-contained blocking (universal fallback) ──────────
    # Works when neither _active_run_queue (Tier 2) nor
    # _active_elicitation_request_id (Tier 1.5) is set — covers
    # Tier 1 MAF AG-UI streaming and standalone calls.  Pushes the
    # elicitation event directly to the Redis relay and blocks on
    # a self-created Future until the user answers.
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _pending_user_input,
            _stream_relay_thread_id,
            _push_sse_to_stream,
        )
        _tid = _stream_relay_thread_id.get(None)
        if _tid:
            import asyncio as _asyncio
            import uuid as _uuid

            _request_id = _uuid.uuid4().hex
            _loop = _asyncio.get_running_loop()
            _fut: "_asyncio.Future[dict[str, object]]" = (
                _loop.create_future())
            _pending_user_input[_request_id] = _fut

            _payload = _json.dumps({
                "type": "CUSTOM",
                "name": "elicitation_requested",
                "value": {
                    "questions": cleaned,
                    "request_id": _request_id,
                },
            })
            _line = f"data: {_payload}\n\n"
            await _push_sse_to_stream(_tid, _line)

            try:
                _result = await _asyncio.wait_for(
                    _fut, timeout=3600,
                )
            except _asyncio.TimeoutError:
                _pending_user_input.pop(_request_id, None)
                return "User did not respond in time."
            finally:
                _pending_user_input.pop(_request_id, None)

            _answer = str(
                _result.get("answer", "") or "").strip()
            if not _answer:
                return "User provided an empty response."
            return f"User response: {_answer}"
    except Exception:  # noqa: BLE001
        pass

    # ── B2: legacy non-blocking (last resort) ─────────────────────────
    try:
        from orchestrator.executor import _active_run_queue  # noqa: PLC0415
        queue_b = _active_run_queue.get(None)
        if queue_b is not None:
            await queue_b.put({
                "type": "CUSTOM",
                "name": "elicitation_requested",
                "value": {"questions": cleaned},
            })
    except Exception:  # noqa: BLE001
        pass

    return (
        "Questions displayed to the user. "
        "Waiting for response — do NOT continue until you receive "
        "the user's answers in the next message."
    )


async def request_confirmation(
    title: str, detail: str = "", context: str = "",
) -> bool:
    """Emit a HITL confirmation card and BLOCK until the user approves/rejects.

    Renders a ``ConfirmationCard`` inline in the chat with Approve / Reject
    buttons and parks the agent on a Future (same blocking mechanism as
    :func:`ask_questions`).  Use this to gate an outward-facing or irreversible
    action — e.g. before actually sending an email.

    Args:
        title: short card heading, e.g. ``"Send this email?"``.
        detail: one-line summary, e.g. ``"To a@b.com · Subject: Hi"``.
        context: longer preformatted body shown in a scrollable block
            (e.g. the email body the user is about to send).

    Returns:
        ``True`` if the user approved, ``False`` if they rejected or did not
        respond.  When there is no active stream to deliver the card (a
        non-interactive run), returns ``True`` so automated callers proceed.
    """
    _title = str(title or "Confirm action").strip()[:120]
    _detail = str(detail or "").strip()[:500]
    _context = str(context or "").strip()[:4000]

    def _event(request_id: str) -> dict:
        return {
            "type": "CUSTOM",
            "name": "confirmation_requested",
            "value": {
                "title": _title,
                "detail": _detail,
                "context": _context,
                "request_id": request_id,
            },
        }

    async def _block_on(_fut, _rid, _pending) -> bool:
        import asyncio as _asyncio
        try:
            _result = await _asyncio.wait_for(_fut, timeout=3600)
        except _asyncio.TimeoutError:
            return False
        finally:
            _pending.pop(_rid, None)
        return str(_result.get("answer", "")).strip().upper() == "APPROVE"

    # ── Path A: _active_run_queue (native MAF / Tier 2 blocking) ──────────
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _active_run_queue,
            _pending_user_input,
        )
        queue = _active_run_queue.get(None)
    except Exception:  # noqa: BLE001
        queue = None
    if queue is not None:
        import asyncio as _asyncio
        import uuid as _uuid

        _rid = _uuid.uuid4().hex
        _fut = _asyncio.get_running_loop().create_future()
        _pending_user_input[_rid] = _fut
        await queue.put(_event(_rid))
        return await _block_on(_fut, _rid, _pending_user_input)

    # ── Path C: Redis relay (native MAF when queue not in context) ───────
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _pending_user_input,
            _push_sse_to_stream,
            _stream_relay_thread_id,
        )
        _tid = _stream_relay_thread_id.get(None)
        if _tid:
            import asyncio as _asyncio
            import uuid as _uuid

            _rid = _uuid.uuid4().hex
            _fut = _asyncio.get_running_loop().create_future()
            _pending_user_input[_rid] = _fut
            _line = f"data: {_json.dumps(_event(_rid))}\n\n"
            await _push_sse_to_stream(_tid, _line)
            return await _block_on(_fut, _rid, _pending_user_input)
    except Exception:  # noqa: BLE001
        pass

    # No delivery channel (non-interactive run) — don't block automation.
    return True

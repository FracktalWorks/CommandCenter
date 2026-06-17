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

    # Push CUSTOM event into the active SSE queue.
    try:
        from orchestrator.executor import _active_run_queue  # noqa: PLC0415
        queue = _active_run_queue.get(None)
        if queue is not None:
            await queue.put({
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

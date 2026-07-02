"""Server-side fold of a run's AG-UI event log into a persisted chat message.

Phase 1 of core-loop unification (specs/core_loop_unification.md): the gateway
becomes the authoritative persistence owner. The per-thread Redis stream is
the append-only source of truth; at run end the detached task replays it and
folds it into the same ``chat_message`` row shape the Next.js translator
writes, so a client that never reconnects still gets the complete turn
(review P0-3 — tail loss after browser close).

The fold helpers here are event-for-event ports of
``workbench/control_plane/src/lib/chatStream.ts`` (fold/unfold/grouping) and
``src/app/api/agent/chat/route.ts`` (event loop). Until Phase 3 makes the
protocol message-id-native and deletes the heuristic family, THESE MUST STAY
SEMANTICALLY IDENTICAL — the fold-parity trajectory evals in
``evals/trajectories/test_chat_fold_trajectory.py`` are the contract.

Timestamps derive from each event's Redis ``_stream_id`` (``<ms>-<seq>``), so
the fold is a pure function of the log (replay-safe, no wall clock).
"""
from __future__ import annotations

import json
import re
from typing import Any

from acb_common import get_logger

_log = get_logger("gateway.chat_fold")

_PROGRESS_MAX = 20  # mirror route.ts progressLines cap


# ── Fold helpers (ports of lib/chatStream.ts) ────────────────────────────────

def group_reasoning_blocks(blocks: list[str], chunk: str) -> list[str]:
    """Append a streamed reasoning chunk into paragraph-grouped blocks.

    Port of ``groupReasoningBlocks``: tokens append to the current block; a
    new block starts only at a paragraph break (2+ newlines). Keeps a trailing
    empty segment (an in-progress block) but drops interior empty ones.
    """
    if not chunk:
        return list(blocks)
    if not blocks:
        return [chunk]
    merged = blocks[-1] + chunk
    parts = re.split(r"\n{2,}", merged)
    parts = [p for i, p in enumerate(parts) if p.strip() or i == len(parts) - 1]
    return [*blocks[:-1], *parts]


def fold_for_tool_start(
    blocks: list[str], narration: str,
) -> tuple[list[str], int]:
    """Fold pre-tool answer text into the reasoning timeline.

    Port of ``foldForToolStart``. Returns ``(blocks, cutoff)`` where cutoff is
    the reasoning-block count at this tool's start (persisted as
    ``reasoningCutoff`` for chronological interleaving).
    """
    folded = [*blocks, narration] if narration else list(blocks)
    if not folded:
        return folded, 0
    if not folded[-1].strip():
        # Trailing empty sentinel from a previous tool — reuse it.
        return folded, len(folded) - 1
    # Seal the current block so later reasoning starts a NEW block.
    return [*folded, ""], len(folded)


def unfold_trailing_answer(
    content: str, blocks: list[str], folded_answer_idx: int,
) -> tuple[str, list[str]]:
    """Restore the genuine answer when the turn ended on a tool call.

    Port of ``unfoldTrailingAnswer``: promote the last folded block back to
    ``content`` and blank it (kept as an empty sentinel so every tool's
    ``reasoningCutoff`` index stays aligned).
    """
    if content.strip() or folded_answer_idx < 0:
        return content, blocks
    if not (0 <= folded_answer_idx < len(blocks)):
        return content, blocks
    candidate = blocks[folded_answer_idx]
    if not candidate.strip():
        return content, blocks
    return candidate, [
        "" if i == folded_answer_idx else b for i, b in enumerate(blocks)
    ]


def parse_tool_args(raw: str | None) -> dict[str, Any]:
    """Port of ``parseToolArgs`` — tolerant parse of streamed JSON args."""
    if not raw or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {"_raw": raw}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def _stream_id_ms(event: dict[str, Any]) -> int | None:
    """Epoch-ms from a Redis stream id (``<ms>-<seq>``), if present."""
    sid = str(event.get("_stream_id") or "")
    ms, _, _ = sid.partition("-")
    return int(ms) if ms.isdigit() else None


# ── The fold (port of route.ts translateAndPersistStream accumulation) ──────

def fold_run_events(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Fold one run's AG-UI events into the persisted-message shape.

    Returns ``None`` when the run produced nothing worth persisting (same
    guard as the Next translator). Output keys match ``MessageRecord``:
    ``content, timestamp, tool_events, progress_lines, reasoning,
    agent_state, custom_events``.
    """
    tool_names: dict[str, str] = {}
    tool_args: dict[str, str] = {}
    tool_cutoffs: dict[str, int] = {}
    tool_starts: dict[str, int | None] = {}
    tool_events: list[dict[str, Any]] = []
    reasoning_blocks: list[str] = []
    progress_lines: list[str] = []
    custom_events: list[dict[str, Any]] = []
    latest_todos: list[dict[str, Any]] = []
    sub_agent: dict[str, Any] = {"name": "", "text": "", "tools": []}
    # Real message segments (Phase 3a) — ground truth for narration-vs-answer
    # when the runtime emitted per-segment ids; [] on legacy id-less streams.
    segments: list[dict[str, str]] = []
    content = ""
    folded_answer_idx = -1
    last_ms: int | None = None

    def _segment_append(msg_id: str, delta: str) -> None:
        for seg in segments:
            if seg["id"] == msg_id:
                seg["text"] += delta
                return
        segments.append({"id": msg_id, "text": delta})

    for ev in events:
        t = str(ev.get("type") or "")
        ms = _stream_id_ms(ev)
        if ms is not None:
            last_ms = ms

        if t == "TEXT_MESSAGE_START":
            msg_id = str(ev.get("messageId") or "")
            if msg_id and not any(s["id"] == msg_id for s in segments):
                segments.append({"id": msg_id, "text": ""})

        elif t == "TEXT_MESSAGE_CONTENT":
            delta = str(ev.get("delta") or "")
            content += delta
            if delta.strip():
                folded_answer_idx = -1
            msg_id = str(ev.get("messageId") or "")
            if msg_id:
                _segment_append(msg_id, delta)

        elif t in ("REASONING_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_CONTENT"):
            chunk = str(ev.get("delta") or "")
            if chunk:
                reasoning_blocks = group_reasoning_blocks(reasoning_blocks, chunk)

        elif t == "PROGRESS_UPDATE":
            msg = str(ev.get("message") or "")
            if msg:
                progress_lines.append(msg)
                del progress_lines[:-_PROGRESS_MAX]

        elif t == "TODO_LIST":
            todos = ev.get("todos") or []
            if isinstance(todos, list):
                latest_todos = todos

        elif t == "TOOL_CALL_START":
            tc_id = str(ev.get("toolCallId") or "")
            name = str(ev.get("toolCallName") or ev.get("tool_call_name") or "tool")
            tool_names[tc_id] = name
            tool_args[tc_id] = ""
            narration = content.strip()
            reasoning_blocks, cutoff = fold_for_tool_start(
                reasoning_blocks, narration,
            )
            tool_cutoffs[tc_id] = cutoff
            if narration:
                folded_answer_idx = cutoff - 1
                content = ""
            tool_starts[tc_id] = ms
            progress_lines.append(name)
            del progress_lines[:-_PROGRESS_MAX]

        elif t == "TOOL_CALL_ARGS":
            tc_id = str(ev.get("toolCallId") or "")
            tool_args[tc_id] = tool_args.get(tc_id, "") + str(ev.get("delta") or "")

        elif t in ("TOOL_CALL_END", "TOOL_CALL_RESULT"):
            tc_id = str(ev.get("toolCallId") or "")
            name = tool_names.get(tc_id, "tool")
            result = str(ev.get("result") or ev.get("content") or "")
            is_delegate = "call_agent" in name.lower()
            sub_fields: dict[str, Any] = {}
            if is_delegate and (
                sub_agent["name"] or sub_agent["text"] or sub_agent["tools"]
            ):
                sub_fields = {
                    "subAgentName": sub_agent["name"],
                    "subAgentText": sub_agent["text"],
                    "subAgentTools": sub_agent["tools"],
                }
                sub_agent = {"name": "", "text": "", "tools": []}
            tool_events.append({
                "id": tc_id,
                "name": name,
                "args": parse_tool_args(tool_args.get(tc_id)),
                "result": result,
                # Honour the real outcome — never hardcode "done" (P0-5).
                "status": "done" if ev.get("success") is not False else "error",
                "reasoningCutoff": tool_cutoffs.get(tc_id, 0),
                "startedAt": tool_starts.get(tc_id),
                "endedAt": ms,
                **sub_fields,
            })

        elif t == "CUSTOM":
            custom_events.append({
                "name": str(ev.get("name") or ""),
                "value": ev.get("value"),
            })

        elif t == "SUB_AGENT_TEXT_DELTA":
            sub_agent["name"] = sub_agent["name"] or str(ev.get("agentName") or "")
            sub_agent["text"] += str(ev.get("delta") or "")

        elif t == "SUB_AGENT_TOOL_CALL_START":
            sub_agent["name"] = sub_agent["name"] or str(ev.get("agentName") or "")
            sub_agent["tools"].append({
                "id": str(ev.get("toolCallId") or ""),
                "name": str(ev.get("toolCallName") or "tool"),
                "status": "running",
            })

        elif t == "SUB_AGENT_TOOL_CALL_RESULT":
            st_id = str(ev.get("toolCallId") or "")
            ok = ev.get("success") is not False
            for st in sub_agent["tools"]:
                if st["id"] == st_id:
                    st["result"] = str(ev.get("content") or "")
                    st["status"] = "done" if ok else "error"
                    break

        elif t == "SUB_AGENT_ERROR":
            err = str(ev.get("error") or "Sub-agent error")
            sep = "\n" if sub_agent["text"] else ""
            sub_agent["text"] += f"{sep}[error] {err}"

        elif t == "RUN_FINISHED":
            content, reasoning_blocks = unfold_trailing_answer(
                content, reasoning_blocks, folded_answer_idx,
            )

    # ── Segment ground truth (Phase 3a) ─────────────────────────────────────
    # When the runtime emitted real message segments, the LAST segment's text
    # IS the answer — no inference. If the fold heuristic left the answer
    # stranded in the timeline (its known failure class: runs ending on a
    # tool call with a cursor miss), promote it back, blanking the matching
    # folded block so every tool's reasoningCutoff index stays aligned.
    if segments and not content.strip():
        last_text = segments[-1]["text"]
        if last_text.strip():
            for i in range(len(reasoning_blocks) - 1, -1, -1):
                if reasoning_blocks[i].strip() == last_text.strip():
                    reasoning_blocks[i] = ""
                    break
            content = last_text

    if not (
        content.strip() or tool_events or reasoning_blocks
        or latest_todos or custom_events
    ):
        return None

    agent_state: dict[str, Any] = {}
    if latest_todos:
        agent_state["todos"] = latest_todos
    if segments:
        # Persisted for 3b's segment-native rendering on reload.
        agent_state["segments"] = segments

    return {
        "content": content,
        "timestamp": last_ms or 0,
        "tool_events": tool_events,
        "progress_lines": progress_lines,
        # JSON serialization matches serializeReasoning (never "---"-joined).
        "reasoning": json.dumps(reasoning_blocks) if reasoning_blocks else None,
        "agent_state": agent_state or None,
        "custom_events": custom_events,
    }


# ── Persistence entry point (run_detached on_complete hook) ─────────────────

async def persist_final_assistant_message(
    thread_id: str,
    message_id: str,
    *,
    user_id: str = "",
    agent_name: str = "orchestrator",
) -> dict[str, Any] | None:
    """Replay the run's event log and upsert the authoritative message row.

    Called from the detached task's ``finally`` — the run is over (finished,
    errored, or cancelled) and every event it emitted is in Redis. Idempotent
    with the Next translator's live-path checkpoints: same row id, upsert.

    Self-sufficient: ensures the parent ``chat_session`` row exists first
    (owned by ``user_id``) so a first-turn client-death can't lose the message
    to the chat_message → chat_session foreign key — the exact failure P0-3
    persistence exists to prevent.

    Best-effort: never raises. Returns the folded message dict on success
    (callers chain run-boundary work like memory extraction off it), else
    ``None``.
    """
    try:
        from orchestrator.stream_relay import replay_events  # noqa: PLC0415

        events = await replay_events(thread_id, since_id="0-0", count=10_000)
        folded = fold_run_events(events)
        if folded is None:
            return None

        from gateway.routes.chat import (  # noqa: PLC0415
            MessageRecord,
            _ensure_session,
            _upsert_messages,
        )
        import asyncio  # noqa: PLC0415

        # Parent session must exist before the message FK insert.
        await asyncio.to_thread(
            _ensure_session, thread_id, user_id, agent_name,
        )

        record = MessageRecord(
            id=message_id,
            role="assistant",
            **folded,
        )
        await asyncio.to_thread(_upsert_messages, thread_id, [record])
        _log.info(
            "chat_fold.persisted",
            thread_id=thread_id[:12],
            message_id=message_id[:40],
            tools=len(folded["tool_events"]),
            chars=len(folded["content"]),
        )
        return folded
    except Exception as exc:  # noqa: BLE001 — persistence must never kill the relay
        _log.warning(
            "chat_fold.persist_failed",
            thread_id=thread_id[:12],
            error=str(exc),
        )
        return None

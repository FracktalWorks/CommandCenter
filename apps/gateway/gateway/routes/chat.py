"""Chat history CRUD — Postgres-backed sessions and messages.

Endpoints
---------
GET    /chat/sessions                          List all sessions for the caller
POST   /chat/sessions                          Upsert a session (create or update metadata)
PATCH  /chat/sessions/{session_id}             Update session title / preview / count
DELETE /chat/sessions/{session_id}             Delete session + all its messages (CASCADE)

GET    /chat/sessions/{session_id}/messages    Fetch all messages for a session
POST   /chat/sessions/{session_id}/messages    Upsert a batch of messages
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

_log = get_logger("gateway.chat")

router = APIRouter(prefix="/chat", tags=["chat"])

# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------

class SessionUpsertRequest(BaseModel):
    id: str
    agent_name: str = "orchestrator"
    title: str | None = None
    last_preview: str | None = None
    message_count: int = 0


class SessionPatchRequest(BaseModel):
    title: str | None = None
    last_preview: str | None = None
    message_count: int | None = None


class MessageRecord(BaseModel):
    id: str
    role: str
    content: str
    timestamp: int          # epoch-ms in JS; stored as timestamp_ms
    tool_events: list[Any] = []
    progress_lines: list[str] = []
    reasoning: str | None = None
    agent_state: dict[str, Any] | None = None
    custom_events: list[Any] = []


# ---------------------------------------------------------------------------
# Thin sync helpers (run in a thread to stay non-blocking)
# ---------------------------------------------------------------------------

def _get_sessions(user_id: str) -> list[dict]:
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    with get_session() as s:
        rows = s.execute(
            text(
                "SELECT id, agent_name, title, last_preview, message_count, "
                "created_at, updated_at "
                "FROM chat_session "
                "WHERE user_id = :uid "
                "ORDER BY updated_at DESC"
            ),
            {"uid": user_id},
        ).fetchall()
    return [
        {
            "id": r.id,
            "agentName": r.agent_name,
            "title": r.title,
            "lastPreview": r.last_preview,
            "messageCount": r.message_count,
            "createdAt": r.created_at.isoformat(),
            "updatedAt": r.updated_at.isoformat(),
        }
        for r in rows
    ]


def _upsert_session(user_id: str, req: SessionUpsertRequest) -> None:
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    with get_session() as s:
        s.execute(
            text(
                """
                INSERT INTO chat_session (id, user_id, agent_name, title, last_preview, message_count)
                VALUES (:id, :uid, :agent_name, :title, :last_preview, :message_count)
                ON CONFLICT (id) DO UPDATE SET
                    agent_name    = EXCLUDED.agent_name,
                    title         = COALESCE(EXCLUDED.title,        chat_session.title),
                    last_preview  = COALESCE(EXCLUDED.last_preview, chat_session.last_preview),
                    message_count = EXCLUDED.message_count,
                    updated_at    = now()
                """
            ),
            {
                "id": req.id,
                "uid": user_id,
                "agent_name": req.agent_name,
                "title": req.title,
                "last_preview": req.last_preview,
                "message_count": req.message_count,
            },
        )


def _patch_session(session_id: str, user_id: str, req: SessionPatchRequest) -> bool:
    """Apply partial update; returns False if session not found."""
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    sets: list[str] = ["updated_at = now()"]
    params: dict = {"id": session_id, "uid": user_id}
    if req.title is not None:
        sets.append("title = :title")
        params["title"] = req.title
    if req.last_preview is not None:
        sets.append("last_preview = :last_preview")
        params["last_preview"] = req.last_preview
    if req.message_count is not None:
        sets.append("message_count = :message_count")
        params["message_count"] = req.message_count

    with get_session() as s:
        result = s.execute(
            text(
                f"UPDATE chat_session SET {', '.join(sets)} "  # noqa: S608
                "WHERE id = :id AND user_id = :uid"
            ),
            params,
        )
        return result.rowcount > 0


def _delete_session(session_id: str, user_id: str) -> bool:
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    with get_session() as s:
        result = s.execute(
            text("DELETE FROM chat_session WHERE id = :id AND user_id = :uid"),
            {"id": session_id, "uid": user_id},
        )
        return result.rowcount > 0


def _get_messages(
    session_id: str,
    user_id: str,
    limit: int | None = None,
    before: int | None = None,
) -> list[dict]:
    """Fetch messages for a session, always returned oldest→newest.

    When ``limit`` is given, returns only the most recent ``limit`` messages
    (windowed lazy-load).  ``before`` is a ``timestamp_ms`` cursor: only
    messages strictly older than it are returned, so the frontend can page
    backwards through history by passing the oldest timestamp it already has.

    When ``limit`` is omitted the full history is returned (backward compatible
    with callers that expect every message, e.g. compaction).
    """
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    with get_session() as s:
        # Verify session belongs to this user.
        owns = s.execute(
            text("SELECT 1 FROM chat_session WHERE id = :id AND user_id = :uid"),
            {"id": session_id, "uid": user_id},
        ).first()
        if not owns:
            return []

        cols = (
            "SELECT id, role, content, timestamp_ms, tool_events, progress_lines, "
            "reasoning, agent_state, custom_events FROM chat_message WHERE session_id = :sid"
        )
        params: dict = {"sid": session_id}
        if before is not None:
            cols += " AND timestamp_ms < :before"
            params["before"] = before

        if limit is not None and limit > 0:
            # Newest-first with LIMIT, then reverse to oldest→newest below.
            # Secondary sort by id keeps ties (messages sharing a timestamp_ms,
            # e.g. a user turn and its assistant reply stamped the same ms)
            # deterministic across reads instead of arbitrary.
            cols += " ORDER BY timestamp_ms DESC, id DESC LIMIT :limit"
            params["limit"] = limit
        else:
            cols += " ORDER BY timestamp_ms ASC, id ASC"

        rows = s.execute(text(cols), params).fetchall()

    # When we fetched newest-first (limit path), reverse to chronological order.
    if limit is not None and limit > 0:
        rows = list(reversed(rows))

    return [
        {
            "id": r.id,
            "role": r.role,
            "content": r.content,
            "timestamp": r.timestamp_ms,
            "toolEvents": r.tool_events or [],
            "progressLines": r.progress_lines or [],
            "reasoning": r.reasoning,
            "agentState": r.agent_state,
            "customEvents": r.custom_events or [],
        }
        for r in rows
    ]


def _upsert_messages(session_id: str, messages: list[MessageRecord]) -> None:
    from acb_graph import get_session  # noqa: PLC0415
    from sqlalchemy import text  # noqa: PLC0415

    if not messages:
        return

    with get_session() as s:
        for m in messages:
            s.execute(
                text(
                    """
                    INSERT INTO chat_message
                        (id, session_id, role, content, timestamp_ms,
                         tool_events, progress_lines, reasoning, agent_state, custom_events)
                    VALUES
                        (:id, :sid, :role, :content, :ts,
                         CAST(:tool_events AS jsonb), CAST(:progress_lines AS jsonb),
                         :reasoning, CAST(:agent_state AS jsonb), CAST(:custom_events AS jsonb))
                    ON CONFLICT (session_id, id) DO UPDATE SET
                        content        = EXCLUDED.content,
                        tool_events    = EXCLUDED.tool_events,
                        progress_lines = EXCLUDED.progress_lines,
                        reasoning      = EXCLUDED.reasoning,
                        agent_state    = EXCLUDED.agent_state,
                        custom_events  = EXCLUDED.custom_events
                    """
                ),
                {
                    "id": m.id,
                    "sid": session_id,
                    "role": m.role,
                    "content": m.content,
                    "ts": m.timestamp,
                    "tool_events": json.dumps(m.tool_events),
                    "progress_lines": json.dumps(m.progress_lines),
                    "reasoning": m.reasoning,
                    "agent_state": json.dumps(m.agent_state) if m.agent_state is not None else None,
                    "custom_events": json.dumps(m.custom_events),
                },
            )


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

@router.get("/sessions", summary="List chat sessions")
async def list_sessions(
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    return await asyncio.to_thread(_get_sessions, user.email or "default")


@router.post("/sessions", status_code=status.HTTP_200_OK, summary="Upsert a chat session")
async def upsert_session(
    req: SessionUpsertRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    await asyncio.to_thread(_upsert_session, user.email or "default", req)
    return {"ok": True, "id": req.id}


@router.patch("/sessions/{session_id}", summary="Update session metadata")
async def patch_session(
    session_id: str,
    req: SessionPatchRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    found = await asyncio.to_thread(_patch_session, session_id, user.email or "default", req)
    if not found:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    found = await asyncio.to_thread(_delete_session, session_id, user.email or "default")
    if not found:
        raise HTTPException(status_code=404, detail="Session not found")


@router.get("/sessions/{session_id}/messages", summary="Fetch messages for a session")
async def get_messages(
    session_id: str,
    user: UserContext = Depends(get_current_user),
    limit: int | None = None,
    before: int | None = None,
) -> list[dict]:
    """Return messages oldest→newest.

    Optional query params enable windowed lazy-loading:
    - ``limit``: return only the most recent N messages.
    - ``before``: a ``timestamp_ms`` cursor; only messages older than it are
      returned (used together with ``limit`` to page backwards on scroll-up).
    """
    return await asyncio.to_thread(
        _get_messages, session_id, user.email or "default", limit, before
    )


@router.post(
    "/sessions/{session_id}/messages",
    status_code=status.HTTP_200_OK,
    summary="Upsert a batch of messages",
)
async def save_messages(
    session_id: str,
    messages: list[MessageRecord],
    user: UserContext = Depends(get_current_user),
) -> dict:
    if len(messages) > 500:
        raise HTTPException(status_code=400, detail="Maximum 500 messages per upsert")
    await asyncio.to_thread(_upsert_messages, session_id, messages)
    return {"ok": True, "saved": len(messages)}


@router.get(
    "/active-sessions",
    summary="List session IDs that currently have an active (running) agent",
)
async def list_active_sessions(
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return sessions whose agents are currently executing.

    Scans Redis ``cc:active:*`` keys (set by the executor's stream relay)
    and cross-references with the ``chat_session`` table to include
    agent names and titles.  Falls back to an empty list when Redis is
    unavailable — the frontend will rely on its local chatStore in that
    case.

    Used by the conversations sidebar to show a pulsing green dot next
    to sessions that are still running in the background, even after a
    browser refresh.
    """
    user_id = user.email or "default"
    active_threads: list[str] = []

    # ── Scan Redis for cc:active:* keys ────────────────────────────────
    try:
        import redis.asyncio as aioredis  # noqa: PLC0415
        settings = get_settings()
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        try:
            cursor = 0
            while True:
                cursor, keys = await r.scan(
                    cursor, match="cc:active:*", count=100
                )
                for k in keys:
                    # Strip the "cc:active:" prefix to recover the thread_id.
                    tid = k.removeprefix("cc:active:")
                    if tid:
                        active_threads.append(tid)
                if cursor == 0:
                    break
        finally:
            await r.aclose()
    except Exception:  # noqa: BLE001
        _log.warning("chat.active_sessions_redis_failed", exc_info=True)
        return []  # Redis unavailable — frontend falls back to local store

    if not active_threads:
        return []

    # ── Cross-reference with Postgres for agent name + title ───────────
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as s:
            rows = s.execute(
                text(
                    "SELECT id, agent_name, title "
                    "FROM chat_session "
                    "WHERE id = ANY(:ids) AND user_id = :uid"
                ),
                {"ids": active_threads, "uid": user_id},
            ).fetchall()

        found_ids = {r.id for r in rows}
        result = [
            {
                "threadId": r.id,
                "agentName": r.agent_name,
                "title": r.title,
            }
            for r in rows
        ]
        # Include threads that are active in Redis but not yet in Postgres
        # (race condition: agent started but session row not yet upserted).
        for tid in active_threads:
            if tid not in found_ids:
                result.append({
                    "threadId": tid,
                    "agentName": "unknown",
                    "title": None,
                })
        return result
    except Exception:  # noqa: BLE001
        # Postgres unavailable — return thread IDs without metadata.
        return [
            {"threadId": tid, "agentName": "unknown", "title": None}
            for tid in active_threads
        ]

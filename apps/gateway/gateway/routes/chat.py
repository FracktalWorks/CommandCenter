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
from acb_common import get_logger
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


def _get_messages(session_id: str, user_id: str) -> list[dict]:
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

        rows = s.execute(
            text(
                "SELECT id, role, content, timestamp_ms, tool_events, progress_lines, "
                "reasoning, agent_state, custom_events "
                "FROM chat_message "
                "WHERE session_id = :sid "
                "ORDER BY timestamp_ms ASC"
            ),
            {"sid": session_id},
        ).fetchall()

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
                         :tool_events::jsonb, :progress_lines::jsonb,
                         :reasoning, :agent_state::jsonb, :custom_events::jsonb)
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
    return await asyncio.to_thread(_get_sessions, user.user_id)


@router.post("/sessions", status_code=status.HTTP_200_OK, summary="Upsert a chat session")
async def upsert_session(
    req: SessionUpsertRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    await asyncio.to_thread(_upsert_session, user.user_id, req)
    return {"ok": True, "id": req.id}


@router.patch("/sessions/{session_id}", summary="Update session metadata")
async def patch_session(
    session_id: str,
    req: SessionPatchRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    found = await asyncio.to_thread(_patch_session, session_id, user.user_id, req)
    if not found:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    found = await asyncio.to_thread(_delete_session, session_id, user.user_id)
    if not found:
        raise HTTPException(status_code=404, detail="Session not found")


@router.get("/sessions/{session_id}/messages", summary="Fetch messages for a session")
async def get_messages(
    session_id: str,
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    return await asyncio.to_thread(_get_messages, session_id, user.user_id)


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

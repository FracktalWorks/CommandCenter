"""Memory API endpoints — Mem0 episodic memory (WBS 2.5).

Endpoints
---------
GET    /memory/{user_id}                  List stored memories for a user
POST   /memory/{user_id}/search           Semantic search over stored memories
DELETE /memory/{user_id}/{memory_id}      Delete a single memory
POST   /memory/{user_id}/add              Manually save a conversation to Mem0
"""
from __future__ import annotations

import asyncio
from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

_log = get_logger("gateway.memory")

router = APIRouter(prefix="/memory", tags=["memory"])


class SearchRequest(BaseModel):
    query: str
    limit: int = 8


class AddRequest(BaseModel):
    messages: list[dict[str, str]]
    agent_id: str = "orchestrator"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_mem0() -> Any:
    """Return the MemoryClient, or None if Mem0 is disabled."""
    try:
        from acb_memory import get_memory_client  # noqa: PLC0415
        return get_memory_client()
    except ImportError:
        return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/{user_id}", summary="List all memories for a user")
async def list_memories(
    user_id: str,
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return all stored episodic memories for the given user_id."""
    client = _get_mem0()
    if client is None:
        return []
    return await client.get_all(user_id)


@router.post("/{user_id}/search", summary="Semantic search over memories")
async def search_memories(
    user_id: str,
    req: SearchRequest,
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return memories semantically relevant to the query."""
    client = _get_mem0()
    if client is None:
        return []
    return await client.search(user_id, req.query, limit=req.limit)


@router.delete("/{user_id}/{memory_id}", status_code=204, summary="Delete a memory")
async def delete_memory(
    user_id: str,
    memory_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    """Delete a single stored memory by ID."""
    client = _get_mem0()
    if client is None:
        return
    await client.delete(memory_id)


@router.post("/{user_id}/add", status_code=202, summary="Save a conversation to Mem0")
async def add_memories(
    user_id: str,
    req: AddRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Extract and store facts from the provided messages.

    This endpoint is called by the Control Plane after a session ends.
    The extraction runs asynchronously — returns 202 immediately.
    """
    client = _get_mem0()
    if client is None:
        return {"status": "mem0_disabled"}
    # Fire-and-forget: don't block the response
    asyncio.create_task(
        client.add(user_id, req.messages, agent_id=req.agent_id)
    )
    return {"status": "queued", "message_count": len(req.messages)}


@router.get("/{user_id}/status", summary="Memory system status")
async def memory_status(
    user_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Return the status of both memory layers for this user."""
    from acb_common import get_settings  # noqa: PLC0415

    settings = get_settings()
    mem0_enabled: bool = getattr(settings, "mem0_enabled", False)
    graphiti_enabled: bool = getattr(settings, "graphiti_enabled", False)

    mem0_count = 0
    if mem0_enabled:
        client = _get_mem0()
        if client:
            memories = await client.get_all(user_id)
            mem0_count = len(memories)

    return {
        "mem0": {
            "enabled": mem0_enabled,
            "memory_count": mem0_count,
        },
        "graphiti": {
            "enabled": graphiti_enabled,
            "neo4j_url": getattr(settings, "neo4j_url", "") if graphiti_enabled else None,
        },
    }

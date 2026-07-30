"""Memory API endpoints — Mem0 episodic memory (WBS 2.5).

Endpoints
---------
GET    /memory/{scope}                    List stored memories in a scope
POST   /memory/{scope}/search             Semantic search over a scope
DELETE /memory/{scope}/{memory_id}        Delete a single memory
POST   /memory/{scope}/add                Manually save a conversation to Mem0

Authorization
-------------
The path parameter is a **scope key**, not a user id — ``acb_memory.scope_key``
mints three shapes and this router must answer for all of them:

    a@b.com        that person's private episodic memory
    agent:<name>   memory shared across every user of that agent
    org:global     organisation-wide memory

``require_internal_auth`` was doing the whole job here, and it was the wrong
job. It proves the CALLER IS THE PLATFORM — which the Next.js BFF is, on behalf
of every signed-in user (``src/app/api/memory/[...path]/route.ts`` forwards the
internal token and the caller's identity headers together). So it stopped
outsiders and nobody else: any member could read, search, or delete any
colleague's private memories by putting their email in a URL, and the code
comment saying "would otherwise be an anonymous IDOR" was right about the shape
and wrong about who was excluded. See ``docs/multiplayer/memory-clearance.md``
§2.1 and ``docs/multiplayer/README.md`` §8 (Phase 0).

Both dependencies now apply: the token proves the request came through the
platform, ``_authorize_scope`` proves this person may touch this scope.
"""
from __future__ import annotations

import asyncio
from typing import Any

from acb_auth import UserContext, get_current_user, require_internal_auth
from acb_auth.roles import UserRole
from acb_common import get_logger
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

_log = get_logger("gateway.memory")

router = APIRouter(
    prefix="/memory", tags=["memory"],
    dependencies=[Depends(require_internal_auth)],
)

#: Mirrors ``acb_memory.scope_key``. Duplicated as constants rather than
#: imported so authorization still works when Mem0 is not installed — a router
#: that fails open because an optional dependency is missing is not a gate.
AGENT_SCOPE_PREFIX = "agent:"
ORG_SCOPE_KEY = "org:global"


def _authorize_scope(scope: str, user: UserContext, *, write: bool) -> None:
    """Raise 403 unless *user* may touch this memory scope.

    One rule per scope shape, and an unrecognised shape is refused rather than
    waved through — a scope vocabulary that grows must fail closed here, not
    quietly become world-readable.

    * **A person's own memory** is theirs alone. Deliberately not readable by
      admins either: administering members is not the same as reading what
      they told an agent in private, and nothing in the product needs it. If
      that changes it should arrive as a named feature with an audit trail,
      not as a side effect of holding ``admin:members:manage``.
    * **Agent memory** is shared across the agent's users by design, so the
      question is whether you are one of them — the same
      ``agents:run:<name>`` check the run path already enforces.
    * **Org memory** uses the permissions migration 131 seeded: everyone with
      a role reads it, contributing to it is the gated act.
    """
    scope = (scope or "").strip()
    if not scope:
        raise HTTPException(status_code=404, detail="Unknown memory scope")

    # The platform acting as itself (cron, service-to-service). It holds "*",
    # so agent and org scopes pass as they do at every other enforcement seam.
    #
    # A PERSON'S scope is the exception, and deliberately so. `deps.py` §1b
    # argues a narrower service grant is theatre because the token holder can
    # assert any `X-User-Email` anyway — true, and beside the point here. The
    # difference is between asserting an identity and *omitting* one: this bug
    # existed because `lib/memory.ts` forgot the header and silently received
    # god mode. Requiring the assertion makes that omission fail closed, and
    # makes "who read this person's memory" answerable afterwards. Nothing
    # in-process needs it — every production read and write goes through
    # `acb_memory` directly, never over HTTP.
    is_service = user.role is UserRole.AGENT and user.has_permission("*")
    if is_service and "@" not in scope:
        return

    if scope == ORG_SCOPE_KEY:
        needed = "memory:write_org" if write else "memory:read_org"
        if not user.has_permission(needed):
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: organisation memory needs '{needed}'.",
            )
        return

    if scope.startswith(AGENT_SCOPE_PREFIX):
        agent = scope[len(AGENT_SCOPE_PREFIX):]
        if not agent or not user.can_run_agent(agent):
            raise HTTPException(
                status_code=403,
                detail=f"Forbidden: no access to agent '{agent}'.",
            )
        return

    if "@" in scope:
        if is_service:
            _log.warning("memory.service_call_without_identity", scope=scope[:40])
            raise HTTPException(
                status_code=403,
                detail=(
                    "Forbidden: reading a person's memory requires acting as "
                    "that person — send X-User-Email alongside the token."
                ),
            )
        if scope.strip().lower() != (user.email or "").strip().lower():
            _log.warning(
                "memory.cross_user_denied",
                actor=(user.email or "")[:40], scope=scope[:40],
            )
            raise HTTPException(
                status_code=403,
                detail="Forbidden: that is somebody else's private memory.",
            )
        return

    raise HTTPException(status_code=404, detail="Unknown memory scope")


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

@router.get("/{scope}", summary="List all memories in a scope")
async def list_memories(
    scope: str,
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return all stored episodic memories in *scope*."""
    _authorize_scope(scope, user, write=False)
    client = _get_mem0()
    if client is None:
        return []
    return await client.get_all(scope)


@router.post("/{scope}/search", summary="Semantic search over memories")
async def search_memories(
    scope: str,
    req: SearchRequest,
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return memories in *scope* semantically relevant to the query."""
    _authorize_scope(scope, user, write=False)
    client = _get_mem0()
    if client is None:
        return []
    return await client.search(scope, req.query, limit=req.limit)


@router.delete("/{scope}/{memory_id}", status_code=204, summary="Delete a memory")
async def delete_memory(
    scope: str,
    memory_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    """Delete a single stored memory by ID, from a scope you may write.

    Two checks, because ``MemoryClient.delete`` takes only a memory id and so
    cannot enforce anything itself: authorize the scope, then confirm the
    memory is actually IN it. Without the second, naming your own scope and
    somebody else's memory id would delete their memory — the same IDOR one
    level down, and the one a path-parameter check alone would leave open.
    """
    _authorize_scope(scope, user, write=True)
    client = _get_mem0()
    if client is None:
        return
    owned = {
        str(m.get("id"))
        for m in await client.get_all(scope)
        if isinstance(m, dict) and m.get("id")
    }
    if memory_id not in owned:
        # 404, not 403: whether a memory id exists elsewhere is itself
        # something the caller should not be able to probe for.
        raise HTTPException(status_code=404, detail="Memory not found")
    await client.delete(memory_id)


@router.post("/{scope}/add", status_code=202, summary="Save a conversation to Mem0")
async def add_memories(
    scope: str,
    req: AddRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Extract and store facts from the provided messages.

    This endpoint is called by the Control Plane after a session ends.
    The extraction runs asynchronously — returns 202 immediately.
    """
    _authorize_scope(scope, user, write=True)
    client = _get_mem0()
    if client is None:
        return {"status": "mem0_disabled"}
    # Fire-and-forget: don't block the response
    asyncio.create_task(
        client.add(scope, req.messages, agent_id=req.agent_id)
    )
    return {"status": "queued", "message_count": len(req.messages)}


@router.get("/{scope}/status", summary="Memory system status")
async def memory_status(
    scope: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Return the status of both memory layers for *scope*.

    Gated like the others: the count alone tells you how much a colleague has
    stored, which is not much and is still not yours to know.
    """
    _authorize_scope(scope, user, write=False)
    from acb_common import get_settings  # noqa: PLC0415

    settings = get_settings()
    mem0_enabled: bool = getattr(settings, "mem0_enabled", False)
    graphiti_enabled: bool = getattr(settings, "graphiti_enabled", False)

    mem0_count = 0
    if mem0_enabled:
        client = _get_mem0()
        if client:
            memories = await client.get_all(scope)
            mem0_count = len(memories)

    return {
        "mem0_enabled": mem0_enabled,
        "graphiti_enabled": graphiti_enabled,
        "count": mem0_count,
    }

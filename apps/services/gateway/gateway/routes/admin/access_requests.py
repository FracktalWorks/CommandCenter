"""SCAFFOLD — routes exist so the red-first run fails on the claim, not import."""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext
from fastapi import Depends
from pydantic import BaseModel, Field

from gateway.routes.admin._common import (  # noqa: F401
    get_db,
    invalidate_for,
    record_admin_change,
    require_admin_user,
)
from gateway.routes.admin._common import router


class AccessRequestEntry(BaseModel):
    email: str
    display_name: str = ""
    first_seen_at: str = ""
    last_seen_at: str = ""
    attempt_count: int = 0
    status: str = "pending"


class ApproveRequest(BaseModel):
    roles: list[str] = Field(default_factory=list)


class ApproveResult(BaseModel):
    email: str
    status: str = ""
    roles: list[str] = Field(default_factory=list)


@router.get("/members/requests")
async def list_access_requests(admin: Any = None) -> list[AccessRequestEntry]:
    return []


@router.post("/members/requests/{email}/approve")
async def approve_access_request(
    email: str, req: ApproveRequest, admin: Any = None,
) -> ApproveResult:
    return ApproveResult(email=email)


@router.post("/members/requests/{email}/deny")
async def deny_access_request(email: str, admin: Any = None) -> dict[str, str]:
    return {"email": email, "status": ""}


_ = (Depends, UserContext)

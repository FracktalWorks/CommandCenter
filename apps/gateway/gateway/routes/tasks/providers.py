"""Provider interface layer — the PM-agnostic contract + connectors (§5.2/§5.5).

Everything above this module (schema, routes, agent, UI) is provider-agnostic:
routes call ``provider_for_account(row, creds)`` and get a ``BaseTaskProvider``.
ClickUp is the first API connector; Asana/Jira/Linear and a generic MCP
connector slot in beside it later without touching the routes.

Credentials are per-account (decrypted from ``task_accounts``), NOT process-wide
env vars — that is what lets several ClickUp workspaces/companies coexist, each
connected with its own token (multi-account, like email_accounts).

Writes to a provider are user-approved only (constraint C-04: staged as
``sync_state='pending'`` until the user explicitly pushes; the Action Broker
takes over the gating in Phase 4).
"""

from __future__ import annotations

import contextlib
from abc import ABC, abstractmethod
from typing import Any

import httpx
from acb_common import get_logger
from fastapi import HTTPException

_log = get_logger("gateway.tasks.providers")

_CLICKUP = "https://api.clickup.com/api/v2"


class ProviderError(HTTPException):
    """A provider call failed — surfaced with the upstream detail."""

    def __init__(self, provider: str, detail: str, status_code: int = 502):
        super().__init__(status_code=status_code, detail=f"{provider}: {detail}")


class BaseTaskProvider(ABC):
    """The canonical contract every connector implements (§5.5).

    Only the calls the capture/clarify slice needs are in v1; sync/webhooks
    grow here later. All methods are async and raise ``ProviderError`` on
    upstream failure.
    """

    provider: str = "base"

    @abstractmethod
    async def verify(self) -> dict[str, Any]:
        """Validate credentials → {user: {name, email, provider_user_id}}."""

    @abstractmethod
    async def list_workspaces(self) -> list[dict[str, Any]]:
        """Workspaces/teams this credential can reach → [{id, name, member_count}]."""

    @abstractmethod
    async def get_schema(self, workspace_id: str) -> dict[str, Any]:
        """The fetched-beforehand schema (§2.2.1) for one workspace:
        {projects: [{id, name, space}], members: [PersonDict], statuses: [str]}."""

    @abstractmethod
    async def create_task(
        self, project_ref: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a task in the tool (user-approved push) →
        {provider_task_id, provider_url, provider_status}."""


# ── ClickUp (reference API connector) ────────────────────────────────────────

class ClickUpProvider(BaseTaskProvider):
    """ClickUp REST v2. One instance per connected workspace account.

    ClickUp needs two pieces to operate (not just a token): the personal API
    token AND the workspace/team id. ``list_workspaces`` is the discovery step
    between them — the connect flow verifies the token, shows the token's
    workspaces, and stores one account row per chosen workspace.
    """

    provider = "clickup"

    def __init__(self, token: str, workspace_id: str | None = None):
        self._token = token
        self._workspace_id = workspace_id

    def _headers(self) -> dict[str, str]:
        return {"Authorization": self._token, "Content-Type": "application/json"}

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        async with httpx.AsyncClient(timeout=20.0) as http:
            r = await http.get(f"{_CLICKUP}{path}", headers=self._headers(),
                               params=params or {})
        if r.status_code == 401:
            raise ProviderError("clickup", "invalid API token", status_code=401)
        if r.status_code >= 400:
            raise ProviderError("clickup", f"GET {path} → {r.status_code}")
        return r.json()

    async def verify(self) -> dict[str, Any]:
        data = await self._get("/user")
        u = data.get("user") or {}
        return {"user": {
            "name": u.get("username") or u.get("email") or "ClickUp user",
            "email": u.get("email"),
            "provider_user_id": str(u.get("id", "")),
        }}

    async def list_workspaces(self) -> list[dict[str, Any]]:
        data = await self._get("/team")
        return [
            {
                "id": str(t.get("id", "")),
                "name": t.get("name", "Workspace"),
                "member_count": len(t.get("members") or []),
            }
            for t in data.get("teams") or []
        ]

    async def get_schema(self, workspace_id: str) -> dict[str, Any]:
        """Projects = every list in every space (foldered + folderless);
        members from the team record; statuses from each space's workflow."""
        members: list[dict[str, Any]] = []
        teams = (await self._get("/team")).get("teams") or []
        for t in teams:
            if str(t.get("id")) != str(workspace_id):
                continue
            for m in t.get("members") or []:
                u = m.get("user") or {}
                if not (u.get("username") or u.get("email")):
                    continue
                members.append({
                    "name": u.get("username") or u.get("email"),
                    "email": u.get("email"),
                    "provider_user_id": str(u.get("id", "")),
                })

        projects: list[dict[str, Any]] = []
        statuses: list[str] = []
        spaces = (await self._get(
            f"/team/{workspace_id}/space", {"archived": "false"}
        )).get("spaces") or []
        for space in spaces:
            for st in space.get("statuses") or []:
                name = (st.get("status") or "").strip()
                if name and name.lower() not in (s.lower() for s in statuses):
                    statuses.append(name)
            sid, sname = space.get("id"), space.get("name", "")
            folderless = (await self._get(
                f"/space/{sid}/list", {"archived": "false"}
            )).get("lists") or []
            folders = (await self._get(
                f"/space/{sid}/folder", {"archived": "false"}
            )).get("folders") or []
            for lst in folderless:
                projects.append({"id": str(lst["id"]), "name": lst.get("name", ""),
                                 "space": sname})
            for folder in folders:
                for lst in folder.get("lists") or []:
                    projects.append({
                        "id": str(lst["id"]), "name": lst.get("name", ""),
                        "space": f"{sname} / {folder.get('name', '')}",
                    })

        return {"projects": projects, "members": members, "statuses": statuses}

    async def create_task(
        self, project_ref: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"name": payload.get("title") or "Untitled"}
        if payload.get("description"):
            body["description"] = payload["description"]
        if payload.get("status"):
            body["status"] = payload["status"]
        if payload.get("due_at_ms"):
            body["due_date"] = int(payload["due_at_ms"])
        if payload.get("assignee_id"):
            with contextlib.suppress(TypeError, ValueError):
                body["assignees"] = [int(payload["assignee_id"])]
        async with httpx.AsyncClient(timeout=20.0) as http:
            r = await http.post(
                f"{_CLICKUP}/list/{project_ref}/task",
                headers=self._headers(), json=body,
            )
        if r.status_code >= 400:
            raise ProviderError("clickup", f"create task → {r.status_code}: {r.text[:200]}")
        t = r.json()
        return {
            "provider_task_id": str(t.get("id", "")),
            "provider_url": t.get("url"),
            "provider_status": (t.get("status") or {}).get("status"),
        }


# ── Registry ─────────────────────────────────────────────────────────────────

_CONNECTORS: dict[str, type[BaseTaskProvider]] = {
    "clickup": ClickUpProvider,
}


def connector_names() -> list[str]:
    return sorted(_CONNECTORS)


def build_provider(
    provider: str, creds: dict[str, Any], workspace_id: str | None = None
) -> BaseTaskProvider:
    """Instantiate a connector from its name + decrypted credentials."""
    cls = _CONNECTORS.get(provider)
    if cls is None:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    token = creds.get("api_token") or creds.get("token") or ""
    if not token:
        raise HTTPException(status_code=400, detail=f"{provider}: missing api_token")
    return cls(token, workspace_id)

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

    async def update_task(
        self, provider_task_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Back-sync an edit to an existing task (user-initiated). ``payload``
        carries only the changed fields (any of: title, description, status,
        due_at_ms, assignee_id, clear_assignee) → returns the refreshed
        {provider_task_id, provider_url, provider_status}. Default raises so a
        connector that hasn't implemented writes fails loudly rather than
        silently dropping the edit."""
        raise ProviderError(self.provider, "update_task not supported", 501)

    @abstractmethod
    async def list_members(self, workspace_id: str) -> list[dict[str, Any]]:
        """CURRENT workspace members → [{name, email, provider_user_id}].
        The live source of truth for the delegate picker — people removed in
        the tool must disappear here (schema_cache is just the warm copy)."""

    @abstractmethod
    async def create_project(
        self, workspace_id: str, name: str,
        space_id: str, folder_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a project/list in the tool under the given space (and
        optional folder) → {id, name, space_id, space_name?, folder_id?}.
        A user-approved write (invoked from the explicit "create project"
        UI action, same posture as push)."""

    @abstractmethod
    async def list_tasks(
        self, workspace_id: str, *, updated_since_ms: int | None = None
    ) -> list[dict[str, Any]]:
        """Pull the workspace's tasks (the sync read, §5.5) as canonical dicts:

        {provider_task_id, provider_url, title, description, status,
         status_type ('open'|'closed'|…), assignees: [{name, email,
         provider_user_id}], due_at_ms, created_at_ms, updated_at_ms,
         closed_at_ms, project_ref}

        ``updated_since_ms`` enables incremental pulls (only tasks updated
        after that epoch-ms); ``None`` = full pull. Closed tasks ARE included
        so completions propagate to the GTD overlay.
        """


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
        # Structured hierarchy for the picker accordion: mirrors ClickUp's
        # navigation exactly (space → folder → list).
        hierarchy: list[dict[str, Any]] = []
        spaces = (await self._get(
            f"/team/{workspace_id}/space", {"archived": "false"}
        )).get("spaces") or []
        for space in spaces:
            for st in space.get("statuses") or []:
                name = (st.get("status") or "").strip()
                if name and name.lower() not in (s.lower() for s in statuses):
                    statuses.append(name)
            sid, sname = str(space.get("id") or ""), space.get("name", "")
            space_node: dict[str, Any] = {
                "id": sid, "name": sname, "folders": [], "lists": [],
            }
            folderless = (await self._get(
                f"/space/{sid}/list", {"archived": "false"}
            )).get("lists") or []
            folders = (await self._get(
                f"/space/{sid}/folder", {"archived": "false"}
            )).get("folders") or []
            for lst in folderless:
                entry = {"id": str(lst["id"]), "name": lst.get("name", ""),
                         "space": sname, "space_id": sid,
                         "folder_id": None, "folder_name": None}
                projects.append(entry)
                space_node["lists"].append(
                    {"id": entry["id"], "name": entry["name"]})
            for folder in folders:
                fid, fname = str(folder.get("id") or ""), folder.get("name", "")
                folder_node: dict[str, Any] = {
                    "id": fid, "name": fname, "lists": [],
                }
                for lst in folder.get("lists") or []:
                    entry = {
                        "id": str(lst["id"]), "name": lst.get("name", ""),
                        "space": f"{sname} / {fname}", "space_id": sid,
                        "folder_id": fid, "folder_name": fname,
                    }
                    projects.append(entry)
                    folder_node["lists"].append(
                        {"id": entry["id"], "name": entry["name"]})
                space_node["folders"].append(folder_node)
            hierarchy.append(space_node)

        return {"projects": projects, "members": members,
                "statuses": statuses, "hierarchy": hierarchy}

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

    async def update_task(
        self, provider_task_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """PUT the changed fields to ClickUp. Field edits (name/description/
        status/due) go on the task; assignee changes use ClickUp's add/rem
        assignee delta on the same PUT."""
        body: dict[str, Any] = {}
        if "title" in payload:
            body["name"] = payload["title"] or "Untitled"
        if "description" in payload:
            body["description"] = payload["description"] or ""
        if payload.get("status"):
            body["status"] = payload["status"]
        if "due_at_ms" in payload:
            body["due_date"] = (int(payload["due_at_ms"])
                                if payload["due_at_ms"] else None)
        # Assignees are a delta on ClickUp: {add: [...], rem: [...]}.
        if payload.get("clear_assignee") and payload.get("prev_assignee_id"):
            with contextlib.suppress(TypeError, ValueError):
                body["assignees"] = {"rem": [int(payload["prev_assignee_id"])]}
        elif payload.get("assignee_id"):
            with contextlib.suppress(TypeError, ValueError):
                add = [int(payload["assignee_id"])]
                rem = ([int(payload["prev_assignee_id"])]
                       if payload.get("prev_assignee_id")
                       and str(payload["prev_assignee_id"])
                       != str(payload["assignee_id"]) else [])
                body["assignees"] = {"add": add, "rem": rem}
        if not body:
            # Nothing ClickUp-writable changed (e.g. a local-only field).
            return {"provider_task_id": provider_task_id}
        async with httpx.AsyncClient(timeout=20.0) as http:
            r = await http.put(
                f"{_CLICKUP}/task/{provider_task_id}",
                headers=self._headers(), json=body,
            )
        if r.status_code >= 400:
            raise ProviderError(
                "clickup", f"update task → {r.status_code}: {r.text[:200]}")
        t = r.json()
        return {
            "provider_task_id": str(t.get("id", provider_task_id)),
            "provider_url": t.get("url"),
            "provider_status": (t.get("status") or {}).get("status"),
        }

    async def list_members(self, workspace_id: str) -> list[dict[str, Any]]:
        members: list[dict[str, Any]] = []
        for t in (await self._get("/team")).get("teams") or []:
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
        return members

    async def create_project(
        self, workspace_id: str, name: str,
        space_id: str, folder_id: str | None = None,
    ) -> dict[str, Any]:
        """ClickUp: a project = a List, created in a folder when given,
        else directly in the space (folderless)."""
        path = (f"/folder/{folder_id}/list" if folder_id
                else f"/space/{space_id}/list")
        async with httpx.AsyncClient(timeout=20.0) as http:
            r = await http.post(f"{_CLICKUP}{path}", headers=self._headers(),
                                json={"name": name})
        if r.status_code >= 400:
            raise ProviderError(
                "clickup", f"create list → {r.status_code}: {r.text[:200]}")
        lst = r.json()
        return {
            "id": str(lst.get("id", "")),
            "name": lst.get("name", name),
            "space_id": space_id,
            "folder_id": folder_id,
        }

    async def list_tasks(
        self, workspace_id: str, *, updated_since_ms: int | None = None
    ) -> list[dict[str, Any]]:
        """Filtered team-tasks endpoint, paginated (100/page, last_page flag).

        include_closed=true so upstream completions flow into the mirror;
        order_by=updated + date_updated_gt gives cheap incremental pulls.
        """
        def _ms(val: Any) -> int | None:
            try:
                return int(val) if val not in (None, "") else None
            except (TypeError, ValueError):
                return None

        out: list[dict[str, Any]] = []
        page = 0
        while True:
            params: dict[str, Any] = {
                "page": page,
                "include_closed": "true",
                "subtasks": "false",
                "order_by": "updated",
                "reverse": "true",
            }
            if updated_since_ms:
                params["date_updated_gt"] = int(updated_since_ms)
            data = await self._get(f"/team/{workspace_id}/task", params)
            tasks = data.get("tasks") or []
            for t in tasks:
                status = t.get("status") or {}
                out.append({
                    "provider_task_id": str(t.get("id", "")),
                    "provider_url": t.get("url"),
                    "title": t.get("name") or "Untitled",
                    "description": (t.get("text_content")
                                    or t.get("description") or None),
                    "status": (status.get("status") or "").strip() or None,
                    "status_type": (status.get("type") or "").strip() or None,
                    "assignees": [
                        {
                            "name": a.get("username") or a.get("email") or "",
                            "email": a.get("email"),
                            "provider_user_id": str(a.get("id", "")),
                        }
                        for a in t.get("assignees") or []
                        if a.get("username") or a.get("email")
                    ],
                    "due_at_ms": _ms(t.get("due_date")),
                    "created_at_ms": _ms(t.get("date_created")),
                    "updated_at_ms": _ms(t.get("date_updated")),
                    "closed_at_ms": _ms(t.get("date_closed")),
                    "project_ref": str((t.get("list") or {}).get("id") or "") or None,
                })
            if data.get("last_page", True) or not tasks:
                break
            page += 1
            if page > 100:  # hard stop: 10k tasks per sync run
                _log.warning("clickup.list_tasks.page_cap",
                             workspace_id=workspace_id)
                break
        return out


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

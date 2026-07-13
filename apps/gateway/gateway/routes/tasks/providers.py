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


def _broker_enforced(action: str) -> bool:
    """Whether ``ACTION_BROKER_ENFORCE`` routes *action* to the approval QUEUE.

    Default (unset / ``none`` / ``off``) → ``False`` → writes AUTO-APPLY: they
    are already user-approved (staged ``sync_state='pending'`` → the user pushes),
    so the broker only audits + chokepoints them. Set the env var to
    ``1``/``all``/``on`` to queue every write, or to a comma-list of action names
    to queue specific ones. This is the kill-switch — flip it without a redeploy
    (env var + service restart). NOTE: the queue path needs a persistent handler
    to execute on approval (a follow-up); until then, enforcing queues a write
    but it won't run until that lands.
    """
    import os

    raw = (os.environ.get("ACTION_BROKER_ENFORCE") or "").strip().lower()
    if not raw or raw in ("0", "none", "off", "false"):
        return False
    if raw in ("1", "all", "on", "true"):
        return True
    return action in {a.strip() for a in raw.split(",") if a.strip()}


class BaseTaskProvider(ABC):
    """The canonical contract every connector implements (§5.5).

    Only the calls the capture/clarify slice needs are in v1; sync/webhooks
    grow here later. All methods are async and raise ``ProviderError`` on
    upstream failure.
    """

    provider: str = "base"

    def _broker_actor(self) -> str:
        """Identity recorded on the audit/proposal for an outward write.
        Never a secret — subclasses may add a workspace/account id."""
        return f"tasks:{self.provider}"

    async def _broker_gate(
        self, action: str, target: str,
        audit_payload: dict[str, Any], do_write,
    ) -> dict[str, Any]:
        """Route an outward provider write through the Action Broker — the single
        audited chokepoint for source-of-truth writes (AGENTS.md #4).

        These writes are already user-approved (staged → the user pushes), so the
        DEFAULT disposition AUTO-APPLIES: the broker audits the write and
        ``do_write`` runs immediately, returning the provider result unchanged.
        ``ACTION_BROKER_ENFORCE`` can flip an action to the approval QUEUE
        (returns a ``pending`` marker; the write does not run until approved).

        Fail-safe: a broker-layer error never blocks a user-approved write —
        ``do_write`` still runs. ``do_write`` executes **exactly once** (its own
        errors, e.g. an HTTP failure, propagate untouched).
        """
        try:
            from action_broker import (
                AuthorityTier,
                Disposition,
                enqueue,
                propose,
            )

            queued = _broker_enforced(action)
            proposal = propose(
                self._broker_actor(), action, target, audit_payload,
                authority=(AuthorityTier.SUGGEST_APPLY if queued
                           else AuthorityTier.AUTONOMOUS),
                destructive=queued,
            )
            disposition = proposal.disposition
        except Exception as exc:  # broker unavailable → never lose a user write
            _log.warning("broker.gate_bypass", action=action, error=str(exc))
            return await do_write()

        if disposition == Disposition.NEEDS_APPROVAL:
            action_id = None
            with contextlib.suppress(Exception):
                action_id = enqueue(proposal)
            _log.info("broker.write_queued", action=action, action_id=action_id)
            return {"pending": True, "pending_action_id": action_id,
                    "provider_task_id": ""}
        if disposition == Disposition.REJECTED:
            raise ProviderError(
                self.provider, f"write {action} rejected by authority policy")
        return await do_write()

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

    async def get_task_detail(self, provider_task_id: str) -> dict[str, Any]:
        """Fetch the rich, on-demand detail of one task for the detail view:

        {comments: [{id, author, text, created_at_ms}],
         attachments: [{id, name, url, mime, size}],
         subtasks: [{provider_task_id, title, status, status_type,
                     assignees:[...], provider_url}]}

        Read-only; called when a task's detail panel opens. Default returns
        empty sections so a connector without rich detail degrades gracefully."""
        return {"comments": [], "attachments": [], "subtasks": []}

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

    def _broker_actor(self) -> str:
        # Workspace id is a non-secret account discriminator (never the token).
        ws = self._workspace_id or "?"
        return f"tasks:clickup:ws:{ws}"

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
        # A subtask: ClickUp models children via the task's `parent` id. The
        # subtask still POSTs to its parent's LIST, so project_ref = the list.
        if payload.get("parent"):
            body["parent"] = str(payload["parent"])

        async def _do() -> dict[str, Any]:
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

        return await self._broker_gate(
            "clickup.create_task", f"list:{project_ref}",
            {"title": body.get("name"), "status": body.get("status"),
             "parent": body.get("parent")},
            _do,
        )

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
        # Mark done → set the task's list's closed-type status (its name varies
        # per workspace: Complete / Closed / Done …). Look it up from the task.
        if payload.get("mark_done") and "status" not in body:
            closed = await self._closed_status_for(provider_task_id)
            if closed:
                body["status"] = closed
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
            # Nothing ClickUp-writable changed (e.g. a local-only field) — no
            # outward write, so it does not go through the broker.
            return {"provider_task_id": provider_task_id}

        async def _do() -> dict[str, Any]:
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

        return await self._broker_gate(
            "clickup.update_task", f"task:{provider_task_id}",
            {"fields": sorted(body.keys())},
            _do,
        )

    async def _closed_status_for(self, provider_task_id: str) -> str | None:
        """The closed/done-type status name of a task's list (varies per
        workspace). Best-effort: returns None if it can't be resolved."""
        with contextlib.suppress(ProviderError, KeyError, TypeError):
            task = await self._get(f"/task/{provider_task_id}")
            list_id = str((task.get("list") or {}).get("id") or "")
            if not list_id:
                return None
            lst = await self._get(f"/list/{list_id}")
            for st in lst.get("statuses") or []:
                if (st.get("type") or "").lower() in ("closed", "done"):
                    return st.get("status")
        return None

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

        async def _do() -> dict[str, Any]:
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

        return await self._broker_gate(
            "clickup.create_project",
            f"space:{space_id}" + (f"/folder:{folder_id}" if folder_id else ""),
            {"name": name},
            _do,
        )

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

    async def get_task_detail(self, provider_task_id: str) -> dict[str, Any]:
        """One GET /task (with subtasks+attachments) + one GET /task/comment."""
        def _ms(val: Any) -> int | None:
            try:
                return int(val) if val not in (None, "") else None
            except (TypeError, ValueError):
                return None

        def _person(u: dict[str, Any]) -> dict[str, Any]:
            return {
                "name": u.get("username") or u.get("email") or "",
                "email": u.get("email"),
                "provider_user_id": str(u.get("id", "")),
            }

        task = await self._get(
            f"/task/{provider_task_id}",
            {"include_subtasks": "true", "include_markdown_description": "false"},
        )
        attachments = [
            {
                "id": str(a.get("id", "")),
                "name": a.get("title") or a.get("name") or "attachment",
                "url": a.get("url") or a.get("url_w_query"),
                "mime": a.get("mimetype") or a.get("extension"),
                "size": a.get("size"),
            }
            for a in task.get("attachments") or []
            if a.get("url") or a.get("url_w_query")
        ]
        subtasks = [
            {
                "provider_task_id": str(s.get("id", "")),
                "title": s.get("name") or "Untitled",
                "status": ((s.get("status") or {}).get("status") or "").strip()
                or None,
                "status_type": ((s.get("status") or {}).get("type") or "").strip()
                or None,
                "provider_url": s.get("url"),
                "assignees": [_person(a) for a in s.get("assignees") or []
                              if a.get("username") or a.get("email")],
            }
            for s in task.get("subtasks") or []
        ]

        comments: list[dict[str, Any]] = []
        with contextlib.suppress(ProviderError):
            cdata = await self._get(f"/task/{provider_task_id}/comment")
            for c in cdata.get("comments") or []:
                comments.append({
                    "id": str(c.get("id", "")),
                    "author": (c.get("user") or {}).get("username")
                    or (c.get("user") or {}).get("email") or "Someone",
                    "text": c.get("comment_text") or "",
                    "created_at_ms": _ms(c.get("date")),
                })

        return {"comments": comments, "attachments": attachments,
                "subtasks": subtasks}


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

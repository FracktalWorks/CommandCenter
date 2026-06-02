"""Minimal ClickUp REST client. Auth via personal token (env: CLICKUP_API_TOKEN)."""
from __future__ import annotations

from typing import Any

import httpx

from acb_common import get_settings

_BASE = "https://api.clickup.com/api/v2"


def _headers() -> dict[str, str]:
    return {"Authorization": get_settings().clickup_api_token, "Content-Type": "application/json"}


async def _get(http: httpx.AsyncClient, path: str, **params: Any) -> dict[str, Any]:
    r = await http.get(f"{_BASE}{path}", headers=_headers(), params=params or None)
    r.raise_for_status()
    return r.json()  # type: ignore[no-any-return]


async def _put(http: httpx.AsyncClient, path: str, json: dict[str, Any]) -> dict[str, Any]:
    r = await http.put(f"{_BASE}{path}", headers=_headers(), json=json)
    r.raise_for_status()
    return r.json() if r.content else {}  # type: ignore[no-any-return]


async def _post(
    http: httpx.AsyncClient,
    path: str,
    json: dict[str, Any],
    **params: Any,
) -> dict[str, Any]:
    r = await http.post(
        f"{_BASE}{path}", headers=_headers(), json=json, params=params or None
    )
    r.raise_for_status()
    return r.json() if r.content else {}  # type: ignore[no-any-return]


async def list_teams() -> list[dict[str, Any]]:
    """ClickUp 'teams' are workspaces."""
    async with httpx.AsyncClient(timeout=30.0) as http:
        return (await _get(http, "/team")).get("teams", [])


async def list_spaces(team_id: str, *, archived: bool = False) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as http:
        return (await _get(http, f"/team/{team_id}/space", archived=str(archived).lower())).get(
            "spaces", []
        )


async def list_folders(space_id: str, *, archived: bool = False) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as http:
        return (await _get(http, f"/space/{space_id}/folder", archived=str(archived).lower())).get(
            "folders", []
        )


async def list_folderless_lists(space_id: str, *, archived: bool = False) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as http:
        return (await _get(http, f"/space/{space_id}/list", archived=str(archived).lower())).get(
            "lists", []
        )


async def list_lists_in_folder(folder_id: str, *, archived: bool = False) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as http:
        return (await _get(http, f"/folder/{folder_id}/list", archived=str(archived).lower())).get(
            "lists", []
        )


async def list_tasks(
    list_id: str,
    *,
    archived: bool = False,
    include_closed: bool = True,
    subtasks: bool = True,
) -> list[dict[str, Any]]:
    """List tasks in a ClickUp list, paginating through every page.

    Page size is fixed by ClickUp at 100; iterate until `last_page` is true or
    a short page is returned.
    """
    out: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=30.0) as http:
        page = 0
        while True:
            data = await _get(
                http,
                f"/list/{list_id}/task",
                archived=str(archived).lower(),
                include_closed=str(include_closed).lower(),
                subtasks=str(subtasks).lower(),
                page=page,
            )
            tasks = data.get("tasks", [])
            out.extend(tasks)
            if data.get("last_page") is True or len(tasks) < 100:
                break
            page += 1
    return out


# ---------- Write-back (Phase 0.5 actuator) --------------------------------
#
# Every function below MUTATES ClickUp. Callers MUST audit-log via
# `acb_audit.record(...)` and SHOULD only fire on explicit user confirmation.
# Endpoint reference: https://clickup.com/api/clickupreference/

async def get_task(task_id: str) -> dict[str, Any]:
    """Fetch a single task (used to read-back after a mutation)."""
    async with httpx.AsyncClient(timeout=30.0) as http:
        return await _get(http, f"/task/{task_id}")


async def update_task(
    task_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    status: str | None = None,
    priority: int | None = None,
    add_assignees: list[int] | None = None,
    remove_assignees: list[int] | None = None,
) -> dict[str, Any]:
    """PUT /task/{task_id} — partial update. Only non-None fields are sent.

    ``status`` must be one of the list's configured status names
    (e.g. "in progress", "complete"). Assignee ids are ClickUp user ids (ints).
    """
    body: dict[str, Any] = {}
    if name is not None:
        body["name"] = name
    if description is not None:
        body["description"] = description
    if status is not None:
        body["status"] = status
    if priority is not None:
        body["priority"] = priority
    if add_assignees or remove_assignees:
        body["assignees"] = {
            "add": list(add_assignees or []),
            "rem": list(remove_assignees or []),
        }
    if not body:
        raise ValueError("update_task called with no fields to change")
    async with httpx.AsyncClient(timeout=30.0) as http:
        return await _put(http, f"/task/{task_id}", body)


async def add_comment(
    task_id: str,
    *,
    comment_text: str,
    assignee_id: int | None = None,
    notify_all: bool = False,
) -> dict[str, Any]:
    """POST /task/{task_id}/comment — append a comment to the task."""
    body: dict[str, Any] = {"comment_text": comment_text, "notify_all": notify_all}
    if assignee_id is not None:
        body["assignee"] = assignee_id
    async with httpx.AsyncClient(timeout=30.0) as http:
        return await _post(http, f"/task/{task_id}/comment", body)

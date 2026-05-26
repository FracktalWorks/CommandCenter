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

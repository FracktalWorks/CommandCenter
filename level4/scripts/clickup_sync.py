"""Walk every ClickUp workspace/space/folder/list reachable by the configured
personal token and ingest all tasks into the graph mirror.

Run:  uv run python -m scripts.clickup_sync
Idempotent: keyed by clickup_id on every upsert.
"""
from __future__ import annotations

import asyncio
from typing import Any

import structlog

from acb_audit import AuditEvent, record
from acb_graph import get_session
from ingestion.sources.clickup import client
from ingestion.sources.clickup.normaliser import normalise_tasks

_log = structlog.get_logger(__name__)


async def _ingest_list(lst: dict[str, Any], team_name: str, space_name: str) -> dict[str, int]:
    list_id = str(lst["id"])
    list_name = lst.get("name", f"list-{list_id}")
    try:
        tasks = await client.list_tasks(list_id)
    except Exception as exc:  # pragma: no cover - surface in summary
        _log.warning("clickup.list.fetch_failed", list_id=list_id, error=str(exc))
        return {"project": 0, "person": 0, "task": 0, "errors": 1}
    if not tasks:
        return {"project": 0, "person": 0, "task": 0, "errors": 0}
    with get_session() as s:
        counts = normalise_tasks(s, tasks)
    counts["errors"] = 0
    _log.info(
        "clickup.list.ingested",
        team=team_name,
        space=space_name,
        list=list_name,
        tasks=len(tasks),
        **counts,
    )
    return counts


async def _walk_space(team_name: str, space: dict[str, Any]) -> dict[str, int]:
    space_id = str(space["id"])
    space_name = space.get("name", f"space-{space_id}")
    totals = {"project": 0, "person": 0, "task": 0, "errors": 0, "lists": 0}

    # folder -> lists
    try:
        folders = await client.list_folders(space_id)
    except Exception as exc:
        _log.warning("clickup.folders.fetch_failed", space_id=space_id, error=str(exc))
        folders = []
    for folder in folders:
        folder_id = str(folder["id"])
        try:
            lists = await client.list_lists_in_folder(folder_id)
        except Exception as exc:
            _log.warning("clickup.folder_lists.fetch_failed", folder_id=folder_id, error=str(exc))
            continue
        for lst in lists:
            totals["lists"] += 1
            c = await _ingest_list(lst, team_name, space_name)
            for k, v in c.items():
                totals[k] = totals.get(k, 0) + v

    # folderless lists
    try:
        flists = await client.list_folderless_lists(space_id)
    except Exception as exc:
        _log.warning("clickup.folderless.fetch_failed", space_id=space_id, error=str(exc))
        flists = []
    for lst in flists:
        totals["lists"] += 1
        c = await _ingest_list(lst, team_name, space_name)
        for k, v in c.items():
            totals[k] = totals.get(k, 0) + v

    return totals


async def main() -> None:
    teams = await client.list_teams()
    grand = {"project": 0, "person": 0, "task": 0, "errors": 0, "lists": 0, "spaces": 0}
    for team in teams:
        team_id = str(team["id"])
        team_name = team.get("name", f"team-{team_id}")
        try:
            spaces = await client.list_spaces(team_id)
        except Exception as exc:
            _log.warning("clickup.spaces.fetch_failed", team_id=team_id, error=str(exc))
            continue
        for space in spaces:
            grand["spaces"] += 1
            sub = await _walk_space(team_name, space)
            for k, v in sub.items():
                grand[k] = grand.get(k, 0) + v

    record(
        AuditEvent(
            actor="job:clickup_sync",
            action="full_sync",
            target="source:clickup",
            payload=grand,
        )
    )
    print("=== ClickUp sync complete ===")
    for k, v in grand.items():
        print(f"  {k:>8}: {v}")


if __name__ == "__main__":
    asyncio.run(main())
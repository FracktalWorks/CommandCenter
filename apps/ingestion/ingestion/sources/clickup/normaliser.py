"""Normalise raw ClickUp REST payloads -> upserts into the graph.

Input: list of task JSON dicts from `client.list_tasks()`.
Behaviour: idempotent upsert of project + members + tasks keyed by ClickUp ids.
Phase-0 keeps it deliberately shallow — comments, subtasks, custom fields are
ignored until WBS 0.3 lands the full reconciler.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from acb_graph import repo


def _epoch_ms_to_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _stage_age_days(stage_entered: datetime | None) -> int | None:
    if stage_entered is None:
        return None
    delta = datetime.now(timezone.utc) - stage_entered
    return max(delta.days, 0)


def normalise_tasks(session: Session, tasks: list[dict[str, Any]]) -> dict[str, int]:
    """Upsert a list of ClickUp task dicts. Returns counts by entity type."""
    counts = {"project": 0, "person": 0, "task": 0}
    project_cache: dict[str, Any] = {}

    for raw in tasks:
        # ---- project (ClickUp list) --------------------------------------
        lst = raw.get("list") or {}
        list_id = lst.get("id")
        project = None
        if list_id:
            if list_id in project_cache:
                project = project_cache[list_id]
            else:
                project = repo.upsert_project(
                    session,
                    clickup_id=str(list_id),
                    name=lst.get("name") or f"List {list_id}",
                    status=(raw.get("space") or {}).get("name"),
                )
                project_cache[list_id] = project
                counts["project"] += 1

        # ---- owner (first assignee wins for Phase 0) ---------------------
        owner = None
        assignees = raw.get("assignees") or []
        if assignees:
            a = assignees[0]
            owner = repo.upsert_person(
                session,
                clickup_id=str(a.get("id")),
                canonical_name=a.get("username") or a.get("email") or f"user-{a.get('id')}",
                email=a.get("email"),
            )
            counts["person"] += 1

        # ---- task --------------------------------------------------------
        stage_entered = _epoch_ms_to_dt(raw.get("date_updated"))
        repo.upsert_task(
            session,
            clickup_id=str(raw["id"]),
            title=raw.get("name") or "(untitled)",
            owner_id=owner.id if owner else None,
            project_id=project.id if project else None,
            stage=(raw.get("status") or {}).get("status"),
            stage_entered_at=stage_entered,
            days_in_stage=_stage_age_days(stage_entered),
        )
        counts["task"] += 1

    return counts


__all__ = ["normalise_tasks"]
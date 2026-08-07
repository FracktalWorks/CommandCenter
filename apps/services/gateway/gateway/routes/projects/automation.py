"""Projects · the seam automation writes through — WS-27f / `workflows_app.md` §13 U1.

**Transport-free on purpose.** The `/workflows` engine imports
:func:`apply_task_patch` and nothing else from this app; there is no HTTP hop,
no second validation path, and no route here. That is Paca's discipline stated
as code (research §4): an automation must *mutate through the ordinary task
service* so its edit gets identical validation and an identical timeline entry
— an engine that wrote `pm_tasks` directly would produce tasks whose history
does not explain how they got that way.

Three things this owes, and each is load-bearing:

1. **A status move is a TRANSITION**, delegated to
   :func:`core.apply_status_transition`, never written as a column. That helper
   owns `completed_at` and the `status_change` activity; skipping it looks
   right in the UI and silently empties the timeline.
2. **"Already in target state" is a no-op**, not a write (research §9). It is
   what makes a crashed automation walk safe to retry, and it is why the run
   step records `skipped` rather than inventing a field change that did not
   happen.
3. **Status is named, never keyed.** A workflow says `"Done"`, not a UUID.
   Statuses are per-project rows, so a graph pinned to one project's status id
   is a graph that can only ever automate that project — the opposite of what
   an automation is for.

**Who this acts as.** `system:workflow:<workflow_id>`, inside the existing
`email | agent:<name>` actor vocabulary (D-PM-4), and **not** member-scoped:
there is deliberately no visibility check here. A published workflow is an
org-level artifact — publishing requires the `workflows:publish` capability —
so its writes are the platform's, not any one member's. Scoping them to
whoever happened to trigger the run would mean the same automation silently
did different things depending on who tripped it, which is worse than either
consistent answer.
"""

from __future__ import annotations

from typing import Any

from gateway.routes.projects.core import (
    apply_status_transition,
    coerce_write_values,
    diff_changes,
    record_activity,
    require_row,
    update_row,
)
from sqlalchemy import text

#: The fields an automation may patch. A deliberately SHORT list: everything
#: here is a plain column on the task. Structural moves (`project_id`,
#: `parent_task_id`) are excluded because they re-stamp `root_project_id` across
#: a subtree and belong to the move endpoint, and `status_id` is excluded
#: because a status move is a transition — see the module docstring.
PATCHABLE_FIELDS: tuple[str, ...] = (
    "title", "description", "importance", "due_at", "start_date", "estimate_mins",
)

#: Mirrors `tasks.py::_TRACKED_TASK_FIELDS` for the subset above — the same
#: fields earn the same `field_change` activity whoever wrote them.
_TRACKED: tuple[str, ...] = PATCHABLE_FIELDS


class TaskPatchError(Exception):
    """The patch cannot be applied; the message is safe to show in a run."""


def workflow_actor(workflow_id: str) -> str:
    """The actor string an automation writes under.

    One vocabulary for every species that can act on a task — a person by
    email, an agent as `agent:<name>`, an automation as
    `system:workflow:<id>`. A fourth shape would fork the field that the
    timeline, the activity spine and every report already read.
    """
    return f"system:workflow:{workflow_id}"


async def resolve_status(db: Any, root_project_id: str, wanted: str) -> Any:
    """Find a status in this task's project by NAME, then by category.

    Name first because that is what a maker types and sees on the board;
    category as the fallback so `"done"` keeps working on a project whose lane
    is called "Shipped". Both are case-insensitive.

    A miss raises with the project's actual lane names in the message. The
    alternative — failing with "status not found" — sends the maker to guess at
    a vocabulary that is one query away.
    """
    rows = (await db.execute(
        text(
            "SELECT * FROM pm_task_statuses WHERE project_id = CAST(:pid AS uuid) "
            "ORDER BY position"
        ),
        {"pid": root_project_id},
    )).fetchall()
    target = (wanted or "").strip().lower()
    if not target:
        raise TaskPatchError("status must name a lane")
    for row in rows:
        if str(row.name).strip().lower() == target:
            return row
    for row in rows:
        if str(row.category).strip().lower() == target:
            return row
    names = ", ".join(str(r.name) for r in rows) or "none"
    raise TaskPatchError(f"no status '{wanted}' in this project (has: {names})")


async def apply_task_patch(
    db: Any,
    task_id: str,
    fields: dict[str, Any],
    *,
    actor: str,
) -> dict[str, Any]:
    """Patch a task the way a human PATCH would, and report what changed.

    ONE multi-field node, not one node per field — Paca merged five
    single-field actions into `update_task` and recorded it as a consolidation
    lesson (research §4). Adopting the end state directly is cheaper than
    rediscovering it.

    Returns ``{task_id, changed: [field…], status: name|None, skipped: bool}``.
    ``skipped`` is true when the task was already in the requested state, which
    the run step records instead of a phantom edit.
    """
    unknown = [
        k for k in fields
        if k != "status" and k not in PATCHABLE_FIELDS
    ]
    if unknown:
        raise TaskPatchError(
            f"cannot set {sorted(unknown)} — one of "
            f"{[*PATCHABLE_FIELDS, 'status']}"
        )

    task = await require_row(db, "pm_tasks", task_id, "Task")
    wanted_status = fields.get("status")
    values = {k: v for k, v in fields.items() if k in PATCHABLE_FIELDS}

    changed: list[str] = []
    after = task
    if values:
        # Compare BEFORE writing so an unchanged field is not a write. Without
        # this, an automation that fires on every task update rewrites the same
        # value forever and fills the timeline with edits nobody made.
        pending = {
            k: v for k, v in values.items()
            if _differs(getattr(task, k, None), v)
        }
        if pending:
            after = await update_row(db, "pm_tasks", task_id, coerce_write_values(pending))
            diffs = diff_changes(task, after, _TRACKED)
            changed = [str(d["field"]) for d in diffs]
            if diffs:
                await record_activity(
                    db, activity_type="field_change", created_by=actor,
                    task_id=task_id, meta={"changes": diffs},
                )

    status_name: str | None = None
    if wanted_status is not None:
        target = await resolve_status(db, str(after.root_project_id), str(wanted_status))
        if str(target.id) != str(after.status_id):
            moved = await apply_status_transition(
                db, after, str(target.id), created_by=actor,
            )
            after = moved["row"]
            changed.append("status")
            status_name = str(moved["to"].name)
        else:
            status_name = str(target.name)

    return {
        "task_id": task_id,
        "changed": changed,
        "status": status_name,
        "skipped": not changed,
    }


def _differs(current: Any, wanted: Any) -> bool:
    """Loose inequality for the pre-write comparison.

    Deliberately stringly for non-null values: the DB hands back a `datetime`
    or a `Decimal` where the graph carries the ISO string or int the maker
    typed, and a strict `!=` would call every one of those a change and rewrite
    it on every single run.
    """
    if current is None or wanted is None:
        return current is not wanted
    return str(current) != str(wanted)

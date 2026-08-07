"""Projects · import the ClickUp mirror the Tasks app already holds.

Spec: ``ai-company-brain/specs/project_management_app.md`` §7.1 · WS-27b.

    POST /projects/import/from-tasks   → one department, everything under it

**Why a second importer.** ``import_clickup.py`` talks to the live ClickUp
tenant: it needs a working token, spends LLM budget proposing a Center per
Space, and asks the owner to confirm a mapping before anything is written. That
is the right shape for the real migration and the wrong shape for "show me my
work in this app today" — the mapping is a decision about who may see what, and
being forced to make it before you have seen the data is backwards.

This one reads the **local mirror** instead. ``gtd_projects`` and ``gtd_items``
already hold the synced ClickUp lists and tasks, so:

* no ClickUp API call, no token, no rate limit, no LLM;
* it works when the connector is stale or disconnected;
* it is fast enough to run in front of an audience.

**One department, deliberately.** Everything lands under a single root the
caller names, because that is a shape nobody has to decide anything to get.

Beneath it the real ClickUp shape is rebuilt — **Space → Folder → List**, each a
project carrying its own ``clickup_id`` and ``clickup_kind`` — which is the same
flattening ``import_clickup`` performs, so the two paths produce one shape. That
tree is what makes the department split a later, reversible act: promoting a
Space node to a root is one ``/move``, not a re-import.

⚠️ The placement comes from ``task_accounts.schema_cache->'hierarchy'``, NOT from
``gtd_projects.space_id``. Migration 60's ``space_id``/``folder_id`` are for
LOCAL projects only and are **always NULL** on the synced rows read here — the
first version of this file believed otherwise and wrote ``{"space_id": null}``
into a ``clickup_snapshot`` column that ``pm_projects`` does not even have.

**The root is org-granted, and that is a narrower disclosure than it sounds.**
``import_clickup`` deliberately does NOT org-grant unmapped Spaces — bulk
granting a whole tenant org-wide is a big implicit decision. Here the caller has
named one department and asked for their workspace inside it, which is the same
act as creating a project by hand (``tree.create_node`` org-grants for exactly
this reason: a solo org must not be locked out of the thing it just made).

**Idempotent by ``clickup_id``.** Re-running adopts what is already there and
reports it, so a second run is a refresh rather than a duplicate.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user, require_permission
from acb_common import get_logger
from fastapi import Depends
from gateway.routes.projects.core import (
    _get_db,
    actor,
    insert_row,
    next_task_number,
    record_activity,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.projects.import_tasks")

#: Same gate as the ClickUp importer — this writes projects and tasks for the
#: whole org, which is an administrative act however local the source is.
require_import_admin = require_permission("admin:access:manage")

#: ClickUp status names → our semantic category. Matched case-insensitively on
#: the mirrored `provider_status`, which is the tool's own label ("Backlog",
#: "In Progress"). Anything unrecognised becomes `todo` rather than being
#: dropped: a status we cannot classify is still a status tasks are sitting in.
CATEGORY_BY_NAME: dict[str, str] = {
    "backlog": "todo",
    "to do": "todo",
    "todo": "todo",
    "open": "todo",
    "planned": "todo",
    "in progress": "in_progress",
    "in review": "in_progress",
    "review": "in_progress",
    # NOT a `blocked` category — migration 146's CHECK has no such value, and
    # emitting one makes `_ensure_lane` raise a CheckViolation that rolls the
    # whole import back. `in_progress` is the honest reading anyway: blocked
    # work is started and stuck, not queued and not finished. The LANE keeps
    # ClickUp's own name, so the board still says "Blocked".
    "blocked": "in_progress",
    "on hold": "in_progress",
    "done": "done",
    "complete": "done",
    "completed": "done",
    "closed": "done",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}

#: The lane a task lands in when the mirror recorded no status at all.
FALLBACK_STATUS = "To do"


class ImportFromTasksIn(BaseModel):
    #: The one department everything lands under.
    department: str = "Company"
    #: Restrict to one connected account. ``None`` takes every synced row,
    #: which is what a single-workspace org wants.
    account_id: str | None = None
    #: Report what would happen and write nothing.
    dry_run: bool = False


def categorise(status_name: str | None) -> str:
    """A ClickUp status name → one of our categories.

    Lower-cased and trimmed because the mirror stores the provider's own
    casing, and "In Progress" vs "in progress" is not a distinction anybody
    means to make.
    """
    return CATEGORY_BY_NAME.get((status_name or "").strip().lower(), "todo")


def lane_name(status_name: str | None) -> str:
    """The lane a mirrored status becomes.

    The provider's own label is kept — renaming somebody's "Backlog" to our
    "To do" would make the board stop matching the tool it came from, which is
    the one thing a migration must not do on day one.
    """
    clean = (status_name or "").strip()
    return clean or FALLBACK_STATUS


def index_hierarchy(hierarchy: Any) -> dict[str, dict[str, Any]]:
    """``{list_id: {space_id, space_name, folder_id, folder_name}}``.

    The ClickUp Space→Folder→List tree lives in
    ``task_accounts.schema_cache->'hierarchy'``, NOT on ``gtd_projects``:
    migration 60's ``space_id``/``folder_id`` are for LOCAL projects only and
    are always NULL on the synced rows this importer reads. Believing otherwise
    is how the first version of this file promised each project "remembers
    which Space it came from" while writing ``{"space_id": null}`` every time.
    """
    out: dict[str, dict[str, Any]] = {}

    def place(node: Any, space: Any, folder: Any = None) -> None:
        if not isinstance(node, dict) or node.get("id") is None:
            return
        out[str(node["id"])] = {
            "space_id": str(space.get("id")) if space.get("id") is not None else None,
            "space_name": (space.get("name") or "").strip() or None,
            "folder_id": (
                str(folder["id"]) if isinstance(folder, dict)
                and folder.get("id") is not None else None
            ),
            "folder_name": (
                (folder.get("name") or "").strip() or None
                if isinstance(folder, dict) else None
            ),
        }

    for space in hierarchy or []:
        if not isinstance(space, dict):
            continue
        for lst in space.get("lists") or []:
            place(lst, space)
        for folder in space.get("folders") or []:
            if not isinstance(folder, dict):
                continue
            for lst in folder.get("lists") or []:
                place(lst, space, folder)
    return out


def assignee_email(assignee: Any) -> str | None:
    """The email out of the mirror's ``assignee`` JSONB, lowercased (R10).

    ``pm_task_assignees`` keys on an address, so a row with only a display name
    contributes nothing — better an unassigned task than one assigned to a
    string that matches no person.
    """
    if not isinstance(assignee, dict):
        return None
    email = (assignee.get("email") or "").strip().lower()
    return email or None


class _Tally:
    def __init__(self) -> None:
        self.projects_created = 0
        self.projects_existing = 0
        self.tasks_created = 0
        self.tasks_existing = 0
        self.lanes_created = 0
        self.skipped_no_list: int = 0

    def as_dict(self, *, department: str, dry_run: bool) -> dict[str, Any]:
        return {
            "dry_run": dry_run,
            "department": department,
            "projects": {
                "created": self.projects_created,
                "already_present": self.projects_existing,
            },
            "tasks": {
                "created": self.tasks_created,
                "already_present": self.tasks_existing,
            },
            "lanes_created": self.lanes_created,
            # Counted and named rather than silently dropped: a mirrored task
            # with no list is real work, and "412 imported" when 30 were left
            # behind is the kind of number that gets trusted and shouldn't be.
            "tasks_without_a_list": self.skipped_no_list,
        }


async def _root_department(
    db: Any, name: str, created_by: str, tally: _Tally, dry_run: bool,
) -> str | None:
    """Find or create the one department. Returns its id, or None on a dry run.

    Matched by NAME among import-sourced roots, so a second run lands in the
    same department instead of stacking a duplicate beside it.
    """
    row = (await db.execute(
        text(
            "SELECT id FROM pm_projects "
            "WHERE parent_project_id IS NULL AND lower(name) = :name "
            "ORDER BY created_at LIMIT 1"
        ),
        {"name": name.strip().lower()},
    )).fetchone()
    if row is not None:
        tally.projects_existing += 1
        return str(row.id)
    tally.projects_created += 1
    if dry_run:
        return None

    from gateway.routes.projects.tree import _seed_root

    created = await insert_row(db, "pm_projects", {
        "name": name.strip(), "created_by": created_by, "source": "import",
        "description": "Imported from the Tasks app's ClickUp mirror.",
    })
    project_id = str(created.id)
    await _seed_root(db, project_id, created_by)
    # Org-granted for the same reason `create_node` org-grants a hand-made root:
    # the caller named this department and asked for their work inside it, so
    # locking everyone out of it would defeat the request.
    await insert_row(db, "pm_project_grants", {
        "project_id": project_id, "subject": "org", "created_by": created_by,
    })
    return project_id


async def _lanes(db: Any, root_id: str) -> dict[str, str]:
    """``{lower(lane name): status id}`` for the department."""
    rows = (await db.execute(
        text("SELECT id, name FROM pm_task_statuses WHERE project_id = CAST(:p AS uuid)"),
        {"p": root_id},
    )).fetchall()
    return {str(r.name).strip().lower(): str(r.id) for r in rows}


async def _ensure_lane(
    db: Any, root_id: str, name: str, lanes: dict[str, str], tally: _Tally,
) -> str:
    """The status id for a lane, creating it if the board has no such column."""
    key = name.strip().lower()
    if key in lanes:
        return lanes[key]
    tally.lanes_created += 1
    row = await insert_row(db, "pm_task_statuses", {
        "project_id": root_id, "name": name.strip(),
        "color": "#8b8b8b", "position": 500.0 + len(lanes),
        "category": categorise(name), "is_default": False,
    })
    lanes[key] = str(row.id)
    return lanes[key]



async def _load_placement(db: Any, account_id: str | None) -> dict[str, dict[str, Any]]:
    """``{list_id: placement}`` across the relevant accounts."""
    clause = " WHERE id = CAST(:acct AS uuid)" if account_id else ""
    params = {"acct": account_id} if account_id else {}
    rows = (await db.execute(
        text(f"SELECT schema_cache FROM task_accounts{clause}"), params,
    )).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        cache = getattr(row, "schema_cache", None)
        if isinstance(cache, str):
            import json

            try:
                cache = json.loads(cache)
            except ValueError:
                cache = None
        if isinstance(cache, dict):
            out.update(index_hierarchy(cache.get("hierarchy")))
    return out


async def _container(
    db: Any, *, root_id: str, where: dict[str, Any], who: str,
    containers: dict[str, str], tally: _Tally, dry_run: bool = False,
) -> str:
    """The project a list hangs under: its Folder, its Space, or the department.

    Mirrors `import_clickup`'s flattening so both paths produce the same shape —
    a Space is a project, a Folder is its child, a List is a child of whichever
    contains it. Created lazily, so a Space with no imported lists never appears
    as an empty node.
    """
    parent = root_id
    space_id = where.get("space_id")
    if space_id:
        key = f"space:{space_id}"
        if key not in containers:
            tally.projects_created += 1
            if dry_run:
                containers[key] = ""
            else:
                node = await insert_row(db, "pm_projects", {
                    "name": where.get("space_name") or "Space",
                    "parent_project_id": root_id, "created_by": who,
                    "source": "import", "clickup_id": str(space_id),
                    "clickup_kind": "space",
                })
                containers[key] = str(node.id)
        parent = containers[key]
    folder_id = where.get("folder_id")
    if folder_id:
        key = f"folder:{folder_id}"
        if key not in containers:
            tally.projects_created += 1
            if dry_run:
                containers[key] = ""
            else:
                node = await insert_row(db, "pm_projects", {
                    "name": where.get("folder_name") or "Folder",
                    "parent_project_id": parent, "created_by": who,
                    "source": "import", "clickup_id": str(folder_id),
                    "clickup_kind": "folder",
                })
                containers[key] = str(node.id)
        parent = containers[key]
    return parent

@router.post("/import/from-tasks", dependencies=[require_import_admin])
async def import_from_tasks(
    payload: ImportFromTasksIn, user: UserContext = Depends(get_current_user),
) -> dict:
    """Project the Tasks app's ClickUp mirror into one department.

    Reads ``gtd_projects`` (the synced lists) and ``gtd_items`` (the synced
    tasks). Writes nothing outside ``pm_*`` — the Tasks app's own rows are the
    mirror and stay exactly as they are, so this can be re-run and so nothing
    here can damage the personal task manager.
    """
    who = actor(user)
    tally = _Tally()
    department = (payload.department or "Company").strip() or "Company"

    db = await _get_db()
    try:
        root_id = await _root_department(
            db, department, who, tally, payload.dry_run,
        )

        account_clause = ""
        params: dict[str, Any] = {}
        if payload.account_id:
            account_clause = " AND p.account_id = CAST(:acct AS uuid)"
            params["acct"] = payload.account_id

        lists = (await db.execute(
            text(
                "SELECT p.id, p.outcome AS name, p.provider_ref, p.space_id "
                "  FROM gtd_projects p "
                " WHERE p.source <> 'LOCAL' AND p.provider_ref IS NOT NULL"
                f"{account_clause} "
                " ORDER BY p.outcome"
            ),
            params,
        )).fetchall()

        lanes = await _lanes(db, root_id) if root_id else {}
        by_gtd_project: dict[str, str] = {}
        placement = await _load_placement(db, payload.account_id)
        # Space and Folder nodes, created lazily so an empty one never appears.
        containers: dict[str, str] = {}

        for row in lists:
            name = (getattr(row, "name", None) or "Untitled list").strip()
            clickup_id = str(row.provider_ref)
            existing = (await db.execute(
                text("SELECT id FROM pm_projects WHERE clickup_id = :cid"),
                {"cid": clickup_id},
            )).fetchone()
            if existing is not None:
                tally.projects_existing += 1
                by_gtd_project[str(row.id)] = str(existing.id)
                continue
            tally.projects_created += 1
            # Resolved even on a dry run, so the preview counts the Space and
            # Folder nodes it would create. Skipping this made the preview say
            # "4 projects" where the real run made 7 — a number somebody would
            # have read out loud.
            where = placement.get(clickup_id, {})
            pretend = payload.dry_run or root_id is None
            parent = await _container(
                db, root_id=root_id or "", where=where, who=who,
                containers=containers, tally=tally, dry_run=pretend,
            )
            if pretend:
                continue
            child = await insert_row(db, "pm_projects", {
                "name": name, "parent_project_id": parent, "created_by": who,
                "source": "import", "clickup_id": clickup_id,
                "clickup_kind": "list",
            })
            by_gtd_project[str(row.id)] = str(child.id)

        await _import_items(
            db, root_id=root_id, by_gtd_project=by_gtd_project, lanes=lanes,
            who=who, tally=tally, dry_run=payload.dry_run,
            account_clause=account_clause, params=params,
        )

        if not payload.dry_run and root_id is not None:
            await record_activity(
                db, activity_type="system", created_by=who, project_id=root_id,
                body=(
                    f"Imported {tally.tasks_created} tasks from the Tasks app's "
                    f"ClickUp mirror into '{department}'"
                ),
            )
            await db.commit()
    finally:
        await db.close()

    return tally.as_dict(department=department, dry_run=payload.dry_run)


async def _import_items(
    db: Any, *, root_id: str | None, by_gtd_project: dict[str, str],
    lanes: dict[str, str], who: str, tally: _Tally, dry_run: bool,
    account_clause: str, params: dict[str, Any],
) -> None:
    """One ``gtd_items`` row → one ``pm_tasks`` row, idempotently."""
    items = (await db.execute(
        text(
            "SELECT i.id, i.title, i.description, i.provider_task_id, "
            "       i.provider_status, i.assignee, i.due_at, i.completed_at, "
            "       i.project_id "
            "  FROM gtd_items i "
            "  JOIN gtd_projects p ON p.id = i.project_id "
            " WHERE i.source <> 'LOCAL' AND i.provider_task_id IS NOT NULL"
            f"{account_clause} "
            " ORDER BY i.created_at"
        ),
        params,
    )).fetchall()

    for item in items:
        target = by_gtd_project.get(str(getattr(item, "project_id", "") or ""))
        if target is None and not dry_run:
            # A mirrored task whose list did not come across. Counted rather
            # than dropped in silence.
            tally.skipped_no_list += 1
            continue
        clickup_id = str(item.provider_task_id)
        existing = (await db.execute(
            text("SELECT id FROM pm_tasks WHERE clickup_id = :cid"),
            {"cid": clickup_id},
        )).fetchone()
        if existing is not None:
            tally.tasks_existing += 1
            continue
        tally.tasks_created += 1
        if dry_run or root_id is None or target is None:
            continue

        status_id = await _ensure_lane(
            db, root_id, lane_name(getattr(item, "provider_status", None)),
            lanes, tally,
        )
        task = await insert_row(db, "pm_tasks", {
            "project_id": target, "root_project_id": root_id,
            "task_number": await next_task_number(db, root_id),
            "status_id": status_id,
            "title": (getattr(item, "title", None) or "Untitled").strip(),
            "description": getattr(item, "description", None),
            "due_at": getattr(item, "due_at", None),
            "completed_at": getattr(item, "completed_at", None),
            "created_by": who, "source": "import", "clickup_id": clickup_id,
        })
        email = assignee_email(getattr(item, "assignee", None))
        if email:
            await db.execute(
                text(
                    "INSERT INTO pm_task_assignees (task_id, assignee, assigned_by) "
                    "VALUES (CAST(:tid AS uuid), :who, :by) "
                    "ON CONFLICT (task_id, assignee) DO NOTHING"
                ),
                {"tid": str(task.id), "who": email, "by": who},
            )

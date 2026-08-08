"""Projects · ClickUp import — plan, then apply.

Spec: ``ai-company-brain/specs/project_management_app.md`` §7.1 · **D-PM-10** ·
ticket WS-27b.

    POST /projects/import/clickup/plan     → proposes a Center per Space, WRITES NOTHING
    POST /projects/import/clickup          → applies the owner's confirmed mapping

**Two endpoints, because the mapping is the owner's act.** An agent may propose
a Center for each Space and must never apply one: a wrong auto-map grants a
Center visibility of another department's work, and that is the single error
class this app cannot make silently. The plan is a read; the import writes only
what came back in ``mappings``.

**The flattening.** ClickUp's container zoo — Space → Folder → List — becomes
depth in the one ``pm_projects`` self-FK (§3.1): a Space is a root project, a
Folder is its child, a List is a child of whichever of the two contains it.
``clickup_kind`` remembers which was which, for the sync and for retirement.

**Unmapped Spaces still import, in full.** They receive no ``group:`` grant, so
they stay reachable in ``/projects`` for ``data:org:read`` holders and for
anyone assigned to their tasks, and mapping one later is a grant write rather
than a re-import. Refusing to import them would make the mapping a precondition
of seeing the data the owner needs in order to decide the mapping.

⚠️ **Both endpoints are OWNER-GATE to run** (`work_plan.md` §6): the plan reads
the live ClickUp tenant and spends LLM budget; the import writes the live DB.
Building them is agent-safe; executing them is not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from acb_auth import UserContext, get_current_user, require_permission
from acb_common import get_logger
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    _get_db,
    actor,
    insert_row,
    record_activity,
    require_organization_of,
    router,
)
from gateway.routes.projects.mapping import (
    load_centers,
    load_group_members,
    suggest_center,
)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.projects.import")

#: The floor for both endpoints. **Not** ``integrations:use:clickup``: migration
#: 131 grants `member` ``integrations:use:*``, so the integration slug gates
#: nothing — the WS-26b finding, and it applies here unchanged.
require_import_admin = require_permission("admin:access:manage")

#: ClickUp status *types* → our ``pm_task_statuses.category``. ClickUp's
#: vocabulary is small and stable; anything unrecognised lands in `todo` rather
#: than being dropped, because a status we cannot classify is still a status
#: tasks are sitting in.
CATEGORY_BY_CLICKUP_TYPE: dict[str, str] = {
    "open": "todo",
    "custom": "in_progress",
    "done": "done",
    "closed": "done",
}


class PlanIn(BaseModel):
    account_id: str
    #: Skip the LLM signal. The two deterministic signals still run — useful
    #: when the owner wants a plan without spending model budget.
    use_llm: bool = True


class SpaceMapping(BaseModel):
    space_id: str
    #: A Center slug, or ``None`` for "import it, map it to nothing".
    center: str | None = None


class ImportIn(BaseModel):
    account_id: str
    mappings: list[SpaceMapping] = []
    #: Report what would happen and write nothing. Distinct from the plan: this
    #: exercises the whole import path, including the flattening.
    dry_run: bool = False


@dataclass
class _SpaceFacts:
    """What one Space looks like, gathered once and used by both endpoints."""

    space_id: str
    name: str
    lists: list[dict[str, Any]] = field(default_factory=list)
    folders: list[dict[str, Any]] = field(default_factory=list)
    task_count: int = 0
    assignees: set[str] = field(default_factory=set)
    titles: list[str] = field(default_factory=list)
    #: ``{status name: category}`` observed on this Space's tasks.
    statuses: dict[str, str] = field(default_factory=dict)


async def _resolve_provider(account_id: str) -> Any:
    """Rebuild the ClickUp provider from a ``task_accounts`` row.

    Reuses the Tasks app's connector rather than adding a second ClickUp client:
    that provider already owns the token decryption, the pagination and the
    canonical task shape, and a second client is a second thing to retire at
    WS-27g. Tokens are never persisted here — they are re-read and decrypted per
    call, exactly as ``broker_handlers._resolve_provider`` does.
    """
    import json

    from gateway.routes.tasks.core import _key_store
    from gateway.routes.tasks.providers import build_provider

    db = await _get_db()
    try:
        row = (await db.execute(
            text(
                "SELECT provider, workspace_id, credentials_encrypted "
                "FROM task_accounts WHERE id = :id"
            ),
            {"id": account_id},
        )).mappings().first()
    finally:
        await db.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Task account not found")
    if row["provider"] != "clickup":
        raise HTTPException(
            status_code=422,
            detail=f"Account {account_id} is a '{row['provider']}' account, "
                   "not ClickUp.",
        )
    creds = json.loads(_key_store().decrypt(row["credentials_encrypted"]))
    return build_provider(row["provider"], creds, row["workspace_id"], account_id)


async def _gather(provider: Any, workspace_id: str) -> dict[str, _SpaceFacts]:
    """One read of the workspace → per-Space facts.

    ``get_schema`` already returns the Space → Folder → List hierarchy without
    extra API calls, and ``list_tasks`` returns every task with its list ref,
    assignees and status type. Between them that is the whole import, so this
    makes exactly two provider calls no matter how many Spaces there are.
    """
    schema = await provider.get_schema(workspace_id)
    facts: dict[str, _SpaceFacts] = {}
    list_to_space: dict[str, str] = {}

    for node in schema.get("hierarchy") or []:
        space_id = str(node.get("id") or "")
        if not space_id:
            continue
        facts[space_id] = _SpaceFacts(
            space_id=space_id,
            name=node.get("name") or "Untitled space",
            lists=list(node.get("lists") or []),
            folders=list(node.get("folders") or []),
        )
        for entry in node.get("lists") or []:
            list_to_space[str(entry.get("id"))] = space_id
        for folder in node.get("folders") or []:
            for entry in folder.get("lists") or []:
                list_to_space[str(entry.get("id"))] = space_id

    for task in await provider.list_tasks(workspace_id):
        space_id = list_to_space.get(str(task.get("project_ref") or ""))
        if space_id is None or space_id not in facts:
            continue
        fact = facts[space_id]
        fact.task_count += 1
        if task.get("title"):
            fact.titles.append(str(task["title"]))
        for person in task.get("assignees") or []:
            email = str((person or {}).get("email") or "").strip().lower()
            if email:
                fact.assignees.add(email)
        name = str(task.get("status") or "").strip()
        if name:
            # First type wins per name: a status carries one type in ClickUp, and
            # re-deriving it per task would let one odd row reclassify a lane.
            fact.statuses.setdefault(
                name,
                CATEGORY_BY_CLICKUP_TYPE.get(
                    str(task.get("status_type") or "").lower(), "todo",
                ),
            )
    return facts


# ── Plan ────────────────────────────────────────────────────────────────────

@router.post("/import/clickup/plan", dependencies=[require_import_admin])
async def plan_import(
    payload: PlanIn, user: UserContext = Depends(get_current_user),
) -> dict:
    """Propose a Center for each Space. **Writes nothing.**

    Pre-filled from the grants that already exist, so re-running after a
    confirmed import proposes the same mapping — without that, a second import
    could silently re-map a Space the owner had already decided.
    """
    provider = await _resolve_provider(payload.account_id)
    workspace_id = getattr(provider, "_workspace_id", None)
    facts = await _gather(provider, str(workspace_id))

    db = await _get_db()
    try:
        centers = await load_centers(db)
        group_members = await load_group_members(db)
        existing = await _existing_mappings(db)

        rows: list[dict[str, Any]] = []
        for fact in facts.values():
            current = existing.get(fact.space_id)
            suggestion = await suggest_center(
                space_name=fact.name,
                assignees=fact.assignees,
                titles=fact.titles,
                group_members=group_members,
                centers=centers,
                use_llm=payload.use_llm,
            )
            rows.append({
                "space_id": fact.space_id,
                "name": fact.name,
                "list_count": len(fact.lists)
                + sum(len(f.get("lists") or []) for f in fact.folders),
                "folder_count": len(fact.folders),
                "task_count": fact.task_count,
                "assignee_count": len(fact.assignees),
                # The confirmed mapping wins over the proposal: an owner
                # decision must not be re-litigated by a later plan.
                "current_mapping": current,
                "suggestion": (
                    {"center": current, "confidence": 1.0,
                     "evidence": ["already mapped — confirmed previously"],
                     "scores": {}}
                    if current
                    else suggestion.as_dict()
                ),
            })
    finally:
        await db.close()

    return {
        "account_id": payload.account_id,
        "workspace_id": str(workspace_id),
        "spaces": sorted(rows, key=lambda r: r["name"].lower()),
        "total": len(rows),
    }


async def _existing_mappings(db: Any) -> dict[str, str]:
    """``{clickup space id: center slug}`` for Spaces already imported+mapped."""
    rows = (await db.execute(
        text(
            "SELECT p.clickup_id AS space_id, g.subject AS subject "
            "FROM pm_projects p "
            "JOIN pm_project_grants g ON g.project_id = p.id "
            "WHERE p.clickup_kind = 'space' AND p.clickup_id IS NOT NULL "
            "  AND g.subject LIKE 'group:%'"
        ),
        {},
    )).fetchall()
    return {
        str(r.space_id): str(r.subject)[len("group:"):]
        for r in rows
        if getattr(r, "space_id", None)
    }


# ── Import ──────────────────────────────────────────────────────────────────

@router.post("/import/clickup", dependencies=[require_import_admin])
async def import_clickup(
    payload: ImportIn, user: UserContext = Depends(get_current_user),
) -> dict:
    """Import the workspace, applying the confirmed mapping as grants."""
    provider = await _resolve_provider(payload.account_id)
    workspace_id = str(getattr(provider, "_workspace_id", None))
    facts = await _gather(provider, workspace_id)
    chosen = {m.space_id: m.center for m in payload.mappings}

    db = await _get_db()
    try:
        centers = await load_centers(db)
        unknown = sorted(
            {c for c in chosen.values() if c and c not in centers}
        )
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown Center(s): {unknown}. One of: {list(centers)}.",
            )

        organization_id = await require_organization_of(db, actor(user).lower())
        summary = _Summary()
        for fact in facts.values():
            await _import_space(
                db, provider, workspace_id, fact,
                center=chosen.get(fact.space_id),
                created_by=actor(user),
                summary=summary,
                dry_run=payload.dry_run,
                organization_id=organization_id,
            )
        if payload.dry_run:
            # Nothing is committed, and the caller is told so in the response
            # rather than left to infer it from a counts-only payload.
            return {"dry_run": True, **summary.as_dict(facts)}
        await db.commit()
        return {"dry_run": False, **summary.as_dict(facts)}
    finally:
        await db.close()


@dataclass
class _Summary:
    projects_created: int = 0
    projects_existing: int = 0
    tasks_created: int = 0
    tasks_existing: int = 0
    statuses_created: int = 0
    grants_applied: list[str] = field(default_factory=list)
    unmapped: list[str] = field(default_factory=list)

    def as_dict(self, facts: dict[str, _SpaceFacts]) -> dict[str, Any]:
        return {
            "projects": {
                "created": self.projects_created,
                "already_present": self.projects_existing,
            },
            "tasks": {
                "created": self.tasks_created,
                "already_present": self.tasks_existing,
            },
            "statuses_created": self.statuses_created,
            "grants_applied": sorted(self.grants_applied),
            # Named, not counted: "3 Spaces were not mapped" is a number the
            # owner cannot act on, and these are exactly the ones they may want
            # to revisit.
            "unmapped_spaces": sorted(self.unmapped),
            "parity": sorted(
                (
                    {"space": f.name, "clickup_tasks": f.task_count}
                    for f in facts.values()
                ),
                key=lambda r: str(r["space"]).lower(),
            ),
        }


async def _upsert_project(
    db: Any, *, name: str, clickup_id: str, kind: str,
    parent_id: str | None, created_by: str, summary: _Summary,
    dry_run: bool, organization_id: str,
) -> str | None:
    """One ClickUp container → one ``pm_projects`` row, idempotently.

    Keyed on ``clickup_id``, so a re-import updates the name in place instead of
    creating a second project — the property that makes this re-runnable during
    coexistence (§7.1).

    ⚠️ The key is ``(clickup_id, organization_id)`` here, not ``clickup_id``
    alone (WS-29b). Without the tenant arm the second organization to import a
    workspace would ADOPT the first one's projects and then UPDATE their names
    — a cross-tenant write that no read predicate sees. `clickup_id` is still
    globally UNIQUE in the schema, so that organization's import now fails on
    the constraint instead; migration 158 §6 records why widening it is a
    separate ticket.
    """
    existing = (await db.execute(
        text(
            "SELECT id FROM pm_projects "
            "WHERE clickup_id = :cid AND organization_id = CAST(:org AS uuid)"
        ),
        {"cid": clickup_id, "org": organization_id},
    )).fetchone()
    if existing is not None:
        summary.projects_existing += 1
        if not dry_run:
            await db.execute(
                text(
                    "UPDATE pm_projects SET name = :name, updated_at = now() "
                    "WHERE id = :id"
                ),
                {"name": name, "id": str(existing.id)},
            )
        return str(existing.id)

    summary.projects_created += 1
    if dry_run:
        return None
    row = await insert_row(db, "pm_projects", {
        "name": name,
        "parent_project_id": parent_id,
        "clickup_id": clickup_id,
        "clickup_kind": kind,
        "source": "import",
        "created_by": created_by,
        # A Space is a ROOT project, so the trigger has no parent to derive
        # from. Folders and lists carry it too, and migration 158's trigger then
        # REFUSES the row if it disagrees with the parent it was grafted onto.
        "organization_id": organization_id,
    })
    return str(row.id)


async def _import_space(
    db: Any, provider: Any, workspace_id: str, fact: _SpaceFacts, *,
    center: str | None, created_by: str, summary: _Summary, dry_run: bool,
    organization_id: str,
) -> None:
    """One Space → a root project, its statuses, its containers and its tasks."""
    root_id = await _upsert_project(
        db, name=fact.name, clickup_id=fact.space_id, kind="space",
        parent_id=None, created_by=created_by, summary=summary, dry_run=dry_run,
        organization_id=organization_id,
    )

    # The grant IS the mapping: granting the root to `group:<slug>` is the whole
    # mechanism by which the Space becomes that Center's slice (§3.2).
    if center and root_id and not dry_run:
        await db.execute(
            text(
                "INSERT INTO pm_project_grants (project_id, subject, created_by) "
                "VALUES (CAST(:pid AS uuid), :subject, :who) "
                "ON CONFLICT (project_id, subject) DO NOTHING"
            ),
            {"pid": root_id, "subject": f"group:{center}", "who": created_by},
        )
    if center:
        summary.grants_applied.append(f"{fact.name} → {center}")
    else:
        summary.unmapped.append(fact.name)

    status_ids = await _import_statuses(
        db, fact, root_id, summary=summary, dry_run=dry_run,
    )

    # Folders and lists, in that order, so a list inside a folder finds its
    # parent already present.
    container_ids: dict[str, str | None] = {}
    for folder in fact.folders:
        folder_id = str(folder.get("id") or "")
        if not folder_id:
            continue
        container_ids[folder_id] = await _upsert_project(
            db, name=folder.get("name") or "Untitled folder",
            clickup_id=folder_id, kind="folder", parent_id=root_id,
            created_by=created_by, summary=summary, dry_run=dry_run,
            organization_id=organization_id,
        )

    list_parents: dict[str, str | None] = {}
    for entry in fact.lists:
        list_id = str(entry.get("id") or "")
        if list_id:
            list_parents[list_id] = await _upsert_project(
                db, name=entry.get("name") or "Untitled list",
                clickup_id=list_id, kind="list", parent_id=root_id,
                created_by=created_by, summary=summary, dry_run=dry_run,
                organization_id=organization_id,
            )
    for folder in fact.folders:
        parent = container_ids.get(str(folder.get("id") or ""))
        for entry in folder.get("lists") or []:
            list_id = str(entry.get("id") or "")
            if list_id:
                list_parents[list_id] = await _upsert_project(
                    db, name=entry.get("name") or "Untitled list",
                    clickup_id=list_id, kind="list", parent_id=parent,
                    created_by=created_by, summary=summary, dry_run=dry_run,
                    organization_id=organization_id,
                )

    if dry_run or root_id is None:
        summary.tasks_created += fact.task_count
        return

    await _import_tasks(
        db, provider, workspace_id, fact, root_id=root_id,
        list_parents=list_parents, status_ids=status_ids,
        created_by=created_by, summary=summary,
    )
    await record_activity(
        db, activity_type="sync", created_by="system:import:clickup",
        project_id=root_id,
        body=f"Imported {fact.task_count} task(s) from ClickUp",
        meta={"space_id": fact.space_id, "center": center},
    )


async def _import_statuses(
    db: Any, fact: _SpaceFacts, root_id: str | None, *,
    summary: _Summary, dry_run: bool,
) -> dict[str, str]:
    """The Space's real status names become this project's lanes (D-CRM-2).

    Derived from the tasks rather than from the space workflow, because that is
    where the *type* lives — and a status no task is in does not need to exist
    for the import to be faithful. If a Space has no tasks at all it gets one
    ``To do`` lane, since ``pm_tasks.status_id`` is NOT NULL and a project with
    no status can never receive one.
    """
    observed = dict(fact.statuses) or {"To do": "todo"}
    out: dict[str, str] = {}
    for position, (name, category) in enumerate(observed.items(), start=1):
        if dry_run or root_id is None:
            summary.statuses_created += 1
            continue
        existing = (await db.execute(
            text(
                "SELECT id FROM pm_task_statuses "
                "WHERE project_id = CAST(:root AS uuid) AND name = :name"
            ),
            {"root": root_id, "name": name},
        )).fetchone()
        if existing is not None:
            out[name.lower()] = str(existing.id)
            continue
        row = await insert_row(db, "pm_task_statuses", {
            "project_id": root_id,
            "name": name,
            "category": category,
            "position": position * 10,
            # The first lane created is the default, so a task whose status we
            # cannot resolve still lands somewhere deterministic.
            "is_default": position == 1,
        })
        out[name.lower()] = str(row.id)
        summary.statuses_created += 1
    return out


async def _import_tasks(
    db: Any, provider: Any, workspace_id: str, fact: _SpaceFacts, *,
    root_id: str, list_parents: dict[str, str | None],
    status_ids: dict[str, str], created_by: str, summary: _Summary,
) -> None:
    """The Space's tasks, with provenance and their assignees.

    Subtasks are **not** wired here: ClickUp's task payload carries a parent id
    only on a detail fetch, so linking them would cost one API call per task.
    They import as top-level tasks of the right list and WS-27c's sync — which
    already fetches detail — re-parents them. Recorded rather than silently
    skipped, because "subtasks became top-level tasks" is exactly the kind of
    surprise an importer must not spring.
    """
    if not status_ids:
        return
    fallback_status = next(iter(status_ids.values()))

    for task in await provider.list_tasks(workspace_id):
        list_ref = str(task.get("project_ref") or "")
        project_id = list_parents.get(list_ref)
        if project_id is None:
            continue

        clickup_id = str(task.get("provider_task_id") or "")
        if not clickup_id:
            continue
        existing = (await db.execute(
            text("SELECT id FROM pm_tasks WHERE clickup_id = :cid"),
            {"cid": clickup_id},
        )).fetchone()
        if existing is not None:
            summary.tasks_existing += 1
            continue

        status_id = status_ids.get(
            str(task.get("status") or "").strip().lower(), fallback_status,
        )
        number = (await db.execute(
            text(
                "INSERT INTO pm_task_counters (project_id, last_value) "
                "VALUES (CAST(:root AS uuid), 1) "
                "ON CONFLICT (project_id) DO UPDATE "
                "SET last_value = pm_task_counters.last_value + 1 "
                "RETURNING last_value"
            ),
            {"root": root_id},
        )).fetchone()

        row = await insert_row(db, "pm_tasks", {
            "project_id": project_id,
            "root_project_id": root_id,
            "task_number": int(getattr(number, "last_value", 1) or 1),
            "status_id": status_id,
            "title": str(task.get("title") or "Untitled"),
            "description": task.get("description"),
            "completed_at": _ms_to_dt(task.get("closed_at_ms")),
            "due_at": _ms_to_dt(task.get("due_at_ms")),
            "source": "import",
            "clickup_id": clickup_id,
            "clickup_synced_at": _now(),
            "created_by": created_by,
        })
        summary.tasks_created += 1

        for person in task.get("assignees") or []:
            email = str((person or {}).get("email") or "").strip().lower()
            if not email:
                continue
            await db.execute(
                text(
                    "INSERT INTO pm_task_assignees "
                    "(task_id, assignee, assigned_by) "
                    "VALUES (CAST(:tid AS uuid), :who, :by) "
                    "ON CONFLICT (task_id, assignee) DO NOTHING"
                ),
                {"tid": str(row.id), "who": email, "by": "system:import:clickup"},
            )


def _ms_to_dt(value: Any) -> Any:
    """ClickUp epoch-milliseconds → an aware datetime, or None."""
    from datetime import UTC, datetime

    if value in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=UTC)
    except (TypeError, ValueError, OSError):
        return None


def _now() -> Any:
    from datetime import UTC, datetime

    return datetime.now(UTC)

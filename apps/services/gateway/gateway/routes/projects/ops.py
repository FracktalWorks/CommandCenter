"""Projects · ops — the management aggregates.

Spec: `ProjectApp_Plan.md` §25 · rules in `operations.py`.

    GET /projects/ops/summary
    GET /projects/ops/attention?limit=
    GET /projects/ops/pipeline
    GET /projects/ops/blockers/breakdown
    GET /projects/ops/workload?period=day|week
    GET /projects/ops/list?state=blocked|awaiting|paused|active

**Every number here is computed in SQL, never in the browser** (plan §28). The
portfolio is hundreds of rows today and will be thousands; shipping it to the
client to be counted there is the design that works in the demo and dies in
production.

**Every read is visibility-scoped.** `task_visibility_clause` is applied to all
of them, so an aggregate cannot leak the existence of work the caller has no
grant on — a count is a disclosure too, and "12 blocked projects" from someone
who can see three is an information leak with a friendly face.

⚠️ **Every percentage states its basis** (acceptance 39). The workload figures
divide by a DEFAULT capacity that no schema column holds yet (plan §26, owed to
S14), and the response says so rather than presenting a guess as a measurement.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, Query
from gateway.routes.projects import operations as ops
from gateway.routes.projects.core import (
    _tenant_session,
    from_jsonb,
    now,
    resolve_visibility,
    router,
    task_visibility_clause,
    triage_exclusion_clause,
)
from sqlalchemy import text

#: The open-work predicate every aggregate shares. Archived and closed work is
#: not "the portfolio" — it is history, and including it makes every count grow
#: forever. Declared once so the tiles, the lists and the breakdown cannot
#: quietly disagree about what they are counting.
_OPEN = (
    "t.archived_at IS NULL AND t.completed_at IS NULL "
    "AND s.category NOT IN ('done', 'cancelled')"
)


def _scope(vis: Any) -> tuple[str, dict[str, Any]]:
    """The FROM/WHERE every aggregate starts from, and its binds."""
    where = (
        "FROM pm_tasks t "
        "JOIN pm_task_statuses s ON s.id = t.status_id "
        "JOIN pm_projects p ON p.id = t.project_id "
        f"WHERE {task_visibility_clause(vis)} AND {triage_exclusion_clause()} "
        f"AND {_OPEN}"
    )
    return where, dict(vis.params)


@router.get("/ops/summary")
async def ops_summary(user: UserContext = Depends(get_current_user)) -> dict:
    """The KPI tiles: one row, one query.

    Counted with FILTER rather than five round trips, so the tiles cannot
    disagree with each other — five separate queries can land either side of a
    pause and show 12 in progress out of a total of 11.
    """
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        row = (await db.execute(
            text(
                "SELECT count(*) AS total, "
                " count(*) FILTER (WHERE s.category = 'in_progress') AS in_progress, "
                " count(*) FILTER (WHERE s.category = 'blocked')     AS blocked, "
                " count(*) FILTER (WHERE s.category = 'paused')      AS paused, "
                " count(*) FILTER (WHERE s.category IN ('todo','backlog')) AS not_started, "
                " count(*) FILTER (WHERE t.due_at < now())           AS overdue, "
                " count(*) FILTER (WHERE t.health = 'at_risk')       AS at_risk, "
                " count(*) FILTER (WHERE t.health = 'critical')      AS critical, "
                " count(*) FILTER (WHERE t.next_action IS NULL)      AS no_next_action, "
                "  count(*) FILTER (WHERE EXISTS ("
                "     SELECT 1 FROM pm_blockers b WHERE b.task_id = t.id "
                "       AND b.resolved_at IS NULL "
                "       AND b.kind IN ('client_input','client_approval'))) AS awaiting_client "
                f"{where}"
            ),
            params,
        )).fetchone()
        return {
            "total": int(row.total), "in_progress": int(row.in_progress),
            "blocked": int(row.blocked), "paused": int(row.paused),
            "not_started": int(row.not_started), "overdue": int(row.overdue),
            "at_risk": int(row.at_risk), "critical": int(row.critical),
            "no_next_action": int(row.no_next_action),
            # Distinct from `blocked`: a project can be blocked on a supplier or
            # on ourselves. This is the subset the CUSTOMER is holding, which is
            # the one management chases differently.
            #
            # ⚠️ NARROWER than the `/ops/list?state=awaiting` view, which also
            # counts supplier and material. Two questions, two numbers, similar
            # names — so both say which they are in their `basis`, and the tile
            # is labelled "Awaiting client" rather than "Awaiting".
            "awaiting_client": int(row.awaiting_client),
            "basis": "Open work you can see — excludes delivered, cancelled and archived.",
        }


@router.get("/ops/attention")
async def ops_attention(
    limit: int = Query(10, ge=1, le=100),
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Projects needing attention, worst first, each saying WHY.

    The ranking is `operations.attention_score`, a tested pure function, and the
    signals travel with the row. A table that ranks without explaining is one
    people learn to scroll past.
    """
    at = now()
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "SELECT t.id, t.title, t.due_at, t.next_action, t.next_action_owner, "
                "       t.health, t.updated_at, s.category, s.name AS status_name, "
                "       p.name AS parent_name, "
                "       (SELECT count(*) FROM pm_task_assignees a WHERE a.task_id = t.id) AS assignees, "
                "       (SELECT min(b.created_at) FROM pm_blockers b "
                "          WHERE b.task_id = t.id AND b.resolved_at IS NULL) AS blocked_since, "
                "       (SELECT b.kind FROM pm_blockers b "
                "          WHERE b.task_id = t.id AND b.resolved_at IS NULL "
                "          ORDER BY b.created_at LIMIT 1) AS blocker_kind, "
                "       (SELECT b.waiting_on FROM pm_blockers b "
                "          WHERE b.task_id = t.id AND b.resolved_at IS NULL "
                "          ORDER BY b.created_at LIMIT 1) AS waiting_on "
                f"{where}"
            ),
            params,
        )).fetchall()

    scored = []
    for r in rows:
        signals = ops.attention_signals(
            ops.AttentionInput(
                category=r.category, due_at=r.due_at, blocked_since=r.blocked_since,
                last_activity_at=r.updated_at, next_action=r.next_action,
                assignees=int(r.assignees or 0), health=r.health,
            ),
            at,
        )
        if not signals:
            continue
        scored.append({
            "id": str(r.id), "title": r.title, "parent": r.parent_name,
            "status": r.status_name, "category": r.category, "health": r.health,
            "due_at": r.due_at, "next_action": r.next_action,
            "next_action_owner": r.next_action_owner,
            "blocker_kind": r.blocker_kind, "waiting_on": r.waiting_on,
            "blocked_since": r.blocked_since,
            "blocked_days": (
                (at - r.blocked_since).days if r.blocked_since else None
            ),
            "signals": signals,
            "score": sum(ops.ATTENTION_WEIGHTS.get(s, 0) for s in signals),
        })
    scored.sort(key=lambda x: (-x["score"], x["title"]))
    return {
        "rows": scored[:limit],
        "total": len(scored),
        "basis": "Open work with at least one attention signal, worst first.",
    }


@router.get("/ops/pipeline")
async def ops_pipeline(user: UserContext = Depends(get_current_user)) -> dict:
    """Open work per STAGE — the pipeline, not the status board.

    ⚠️ Stage, never status. They are the two axes migration 171 separated and
    drawing one with the other's vocabulary is how they get re-fused. A stage
    with nothing in it is returned with `count: 0` rather than omitted: "no
    project has reached Validation" is information, and a ring that silently
    drops the empty slices cannot say it.
    """
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "SELECT g.id, g.name, g.position, g.color, "
                "  (SELECT count(*) "
                f"   {where} AND t.stage_id = g.id) AS n "
                "FROM pm_stages g ORDER BY g.position, g.name"
            ),
            params,
        )).fetchall()
        unstaged = (await db.execute(
            text(f"SELECT count(*) AS n {where} AND t.stage_id IS NULL"), params,
        )).fetchone()
        return {
            "rows": [
                {"id": str(r.id), "name": r.name, "count": int(r.n), "color": r.color}
                for r in rows
            ],
            "unstaged": int(unstaged.n),
            "basis": "Open work by pipeline stage. `unstaged` has no stage set yet.",
        }


@router.get("/ops/blockers/breakdown")
async def ops_blocker_breakdown(user: UserContext = Depends(get_current_user)) -> dict:
    """Open blockers by kind.

    ⚠️ **This counts BLOCKERS, not projects, and the two differ** — a project
    can carry several. The plan (§14, D-OPEN-7) records that the mock's own
    breakdown summed to 19 against a Blocked tile of 7, which is exactly this
    confusion rendered as a bug. Both numbers are returned so the card can
    label itself rather than leaving the reader to guess.
    """
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "SELECT b.kind, count(*) AS n, "
                "       count(DISTINCT b.task_id) AS projects, "
                "       min(b.created_at) AS oldest "
                "FROM pm_blockers b "
                "WHERE b.resolved_at IS NULL AND b.task_id IN ("
                f"  SELECT t.id {where}"
                ") GROUP BY b.kind ORDER BY n DESC, b.kind"
            ),
            params,
        )).fetchall()
        at = now()
        out = [
            {
                "kind": r.kind, "blockers": int(r.n), "projects": int(r.projects),
                "oldest_days": (at - r.oldest).days if r.oldest else None,
            }
            for r in rows
        ]
        return {
            "rows": out,
            "blockers": sum(r["blockers"] for r in out),
            "projects": sum(r["projects"] for r in out),
            "basis": (
                "Open blockers by kind. `blockers` counts blockers; `projects` "
                "counts distinct projects — a project can carry several, so the "
                "two totals differ and neither is wrong."
            ),
        }


@router.get("/ops/workload")
async def ops_workload(
    period: str = Query("week", pattern="^(day|week)$"),
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Tracked time per person against capacity.

    ⚠️ **Capacity is a DEFAULT, not a measurement.** No column holds per-person
    hours (plan §26, owed to S14), so this divides by 8h/day or 40h/week and
    says so in `basis`. Presenting a percentage whose denominator is invented
    without labelling it is how a dashboard becomes something people quote in a
    meeting and cannot defend.

    Counts every actor with tracked time OR open assigned work, so somebody at
    0% who is carrying six projects still appears — they are the interesting
    case, and a query keyed only on time entries would hide them.
    """
    hours = ops.DEFAULT_DAILY_HOURS if period == "day" else ops.DEFAULT_WEEKLY_HOURS
    window = "1 day" if period == "day" else "7 days"
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "WITH visible AS ("
                f"  SELECT t.id {where}"
                "), tracked AS ("
                "  SELECT e.actor, COALESCE(SUM(e.duration_secs), 0) AS secs "
                "  FROM pm_time_entries e "
                "  WHERE e.task_id IN (SELECT id FROM visible) "
                f"    AND e.started_at >= now() - INTERVAL '{window}' "
                "  GROUP BY e.actor"
                "), capacity AS ("
                "  SELECT lower(u.email) AS actor, u.weekly_capacity_hours AS hours "
                "  FROM app_user u WHERE u.weekly_capacity_hours IS NOT NULL"
                "), assigned AS ("
                "  SELECT a.assignee AS actor, count(*) AS open_projects "
                "  FROM pm_task_assignees a "
                "  WHERE a.task_id IN (SELECT id FROM visible) "
                "  GROUP BY a.assignee"
                ") "
                "SELECT COALESCE(tr.actor, asg.actor) AS actor, "
                "       COALESCE(tr.secs, 0) AS secs, "
                "       COALESCE(asg.open_projects, 0) AS open_projects, "
                "       cap.hours AS stated_hours "
                "FROM tracked tr FULL OUTER JOIN assigned asg ON asg.actor = tr.actor "
                "LEFT JOIN capacity cap ON cap.actor = lower(COALESCE(tr.actor, asg.actor)) "
                "ORDER BY 2 DESC, 1"
            ),
            params,
        )).fetchall()

        people = []
        assumed = 0
        for r in rows:
            secs = int(r.secs or 0)
            # A stated weekly capacity (migration 173) beats the default. For a
            # daily period it is prorated over five working days rather than
            # seven: nobody's Monday capacity is their week divided by the
            # calendar.
            stated_week = float(r.stated_hours) if r.stated_hours is not None else None
            if stated_week is None:
                capacity, is_assumption = hours, True
                assumed += 1
            elif period == "day":
                capacity, is_assumption = stated_week / 5.0, False
            else:
                capacity, is_assumption = stated_week, False

            pct = ops.workload_percent(secs, capacity)
            band, hue = ops.workload_band(pct)
            people.append({
                "actor": r.actor,
                "seconds": secs,
                "tracked": ops.format_duration(secs),
                "capacity_hours": round(capacity, 2),
                # The reader must be able to tell a measurement from a guess —
                # a percentage against an invented denominator that does not
                # say so is the thing this column exists to end.
                "capacity_assumed": is_assumption,
                "percent": pct,
                "band": band,
                "hue": hue,
                "open_projects": int(r.open_projects or 0),
            })
        return {
            "rows": people,
            "period": period,
            "capacity_hours": hours,
            "assumed_count": assumed,
            "basis": (
                f"Tracked time over the last {window}, against each person's stated "
                f"weekly capacity where one is set"
                + (
                    f". {assumed} of {len(people)} have none, and fall back to "
                    f"{hours:g}h — an assumption, flagged per row as "
                    f"`capacity_assumed`."
                    if assumed else " — every person here has one stated."
                )
            ),
        }


#: The operations views, and what each one MEANS. `awaiting` is deliberately
#: not the same as `blocked`: it is work stalled on somebody OUTSIDE the team,
#: which is the distinction §26 of the brief asks for and which a status alone
#: cannot express — it lives in the blocker's kind.
_EXTERNAL_KINDS = ("client_input", "client_approval", "supplier", "material")

_STATES: dict[str, str] = {
    "blocked": "s.category = 'blocked'",
    "paused": "s.category = 'paused'",
    "active": "s.category = 'in_progress'",
    "awaiting": (
        "EXISTS (SELECT 1 FROM pm_blockers b WHERE b.task_id = t.id "
        "        AND b.resolved_at IS NULL "
        f"        AND b.kind IN {_EXTERNAL_KINDS})"
    ),
}


@router.get("/ops/activity")
async def ops_activity(
    limit: int = Query(20, ge=1, le=100),
    discussion: bool = Query(True, description="Include comments and mentions."),
    user: UserContext = Depends(get_current_user),
) -> dict:
    """The portfolio's recent history — the Control Center's live feed.

    Scoped through the same visibility clause as every other aggregate, so the
    feed cannot mention a task the caller has no grant on. An activity row is a
    disclosure: "jasim handed off the Z121 bumper" names work, a person and a
    programme in one sentence.

    ⚠️ **Bounded, never "all history"** (§28). The table grows forever — 222
    rows against 29 projects on day one — and a feed that pages through it is a
    feed that gets slower every week. `limit` is capped at 100 and the default
    is what fits on the card.

    `discussion=false` drops comments and mentions, which is the difference the
    brief §32 insists on: comments are talk, activities are the audit record. A
    busy project can bury its own state changes under a conversation.
    """
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "SELECT a.id, a.type, a.body, a.meta, a.created_by, a.created_at, "
                "       a.task_id, t.title, p.name AS parent_name "
                "FROM pm_activities a "
                "JOIN pm_tasks t ON t.id = a.task_id "
                "JOIN pm_projects p ON p.id = t.project_id "
                "WHERE a.deleted_at IS NULL "
                + ("" if discussion else "AND a.type NOT IN ('comment','mention') ")
                + "  AND a.task_id IN ("
                f"    SELECT t.id {where}"
                "  ) "
                "ORDER BY a.created_at DESC LIMIT :lim"
            ),
            {**params, "lim": limit},
        )).fetchall()
        return {
            "rows": [
                {
                    "id": str(r.id), "type": r.type, "body": r.body,
                    "meta": from_jsonb(r.meta) or {},
                    "created_by": r.created_by, "created_at": r.created_at,
                    "task_id": str(r.task_id), "title": r.title,
                    "parent": r.parent_name,
                }
                for r in rows
            ],
            "total": len(rows),
            "basis": (
                "The most recent history across work you can see"
                + ("." if discussion else ", excluding comments and mentions.")
            ),
        }


#: How each view is sorted. See the note at the ORDER BY below.
_ORDER: dict[str, str] = {
    "blocked": "blocked_since NULLS LAST, t.title",
    "awaiting": "blocked_since NULLS LAST, t.title",
    "paused": "t.due_at NULLS LAST, t.title",
    "active": "t.due_at NULLS LAST, t.title",
}


@router.get("/ops/list")
async def ops_list(
    state: str = Query("blocked", pattern="^(blocked|awaiting|paused|active)$"),
    limit: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
) -> dict:
    """One shape behind Blocked · Awaiting · Paused · Active.

    Four routes would be four nearly-identical queries that drift; one route
    with a named state keeps the columns — and therefore the four tables —
    identical, which is what makes them scannable as a set.
    """
    at = now()
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        where, params = _scope(vis)
        rows = (await db.execute(
            text(
                "SELECT t.id, t.title, t.due_at, t.next_action, t.next_action_owner, "
                "       t.health, s.name AS status_name, p.name AS parent_name, "
                "       (SELECT string_agg(a.assignee, ', ') FROM pm_task_assignees a "
                "          WHERE a.task_id = t.id) AS assignees, "
                "       (SELECT b.kind FROM pm_blockers b WHERE b.task_id = t.id "
                "          AND b.resolved_at IS NULL ORDER BY b.created_at LIMIT 1) AS blocker_kind, "
                "       (SELECT b.title FROM pm_blockers b WHERE b.task_id = t.id "
                "          AND b.resolved_at IS NULL ORDER BY b.created_at LIMIT 1) AS blocker_title, "
                "       (SELECT b.waiting_on FROM pm_blockers b WHERE b.task_id = t.id "
                "          AND b.resolved_at IS NULL ORDER BY b.created_at LIMIT 1) AS waiting_on, "
                "       (SELECT min(b.created_at) FROM pm_blockers b WHERE b.task_id = t.id "
                "          AND b.resolved_at IS NULL) AS blocked_since "
                f"{where} AND {_STATES[state]} "
                # State-aware order, because each view answers a different
                # question. Blocked and Awaiting are read oldest-first — "how
                # long have we been waiting" is the whole point of them, and a
                # due-date sort buries the 26-day-old row under something due
                # tomorrow. Paused and Active are read by due date, because
                # there is no wait to age.
                f"ORDER BY {_ORDER[state]} "
                "LIMIT :lim"
            ),
            {**params, "lim": limit},
        )).fetchall()
        return {
            "rows": [
                {
                    "id": str(r.id), "title": r.title, "parent": r.parent_name,
                    "status": r.status_name, "health": r.health, "due_at": r.due_at,
                    "assignees": (r.assignees or "").split(", ") if r.assignees else [],
                    "next_action": r.next_action,
                    "next_action_owner": r.next_action_owner,
                    "blocker_kind": r.blocker_kind, "blocker_title": r.blocker_title,
                    "waiting_on": r.waiting_on, "blocked_since": r.blocked_since,
                    "blocked_days": (at - r.blocked_since).days if r.blocked_since else None,
                }
                for r in rows
            ],
            "total": len(rows),
            "state": state,
            "basis": (
                "Work stalled on someone outside the team — an open blocker of kind "
                f"{', '.join(_EXTERNAL_KINDS)}. NOT the same as paused (that is our "
                "choice), and WIDER than the Control Center's 'Awaiting client' tile, "
                "which counts only the two client kinds."
                if state == "awaiting"
                else f"Open work whose lifecycle status is {state}."
            ),
        }

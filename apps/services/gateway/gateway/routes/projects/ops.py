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
                " count(*) FILTER (WHERE t.next_action IS NULL)      AS no_next_action "
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
                "), assigned AS ("
                "  SELECT a.assignee AS actor, count(*) AS open_projects "
                "  FROM pm_task_assignees a "
                "  WHERE a.task_id IN (SELECT id FROM visible) "
                "  GROUP BY a.assignee"
                ") "
                "SELECT COALESCE(tr.actor, asg.actor) AS actor, "
                "       COALESCE(tr.secs, 0) AS secs, "
                "       COALESCE(asg.open_projects, 0) AS open_projects "
                "FROM tracked tr FULL OUTER JOIN assigned asg ON asg.actor = tr.actor "
                "ORDER BY 2 DESC, 1"
            ),
            params,
        )).fetchall()

        people = []
        for r in rows:
            secs = int(r.secs or 0)
            pct = ops.workload_percent(secs, hours)
            band, hue = ops.workload_band(pct)
            people.append({
                "actor": r.actor,
                "seconds": secs,
                "tracked": ops.format_duration(secs),
                "capacity_hours": hours,
                "percent": pct,
                "band": band,
                "hue": hue,
                "open_projects": int(r.open_projects or 0),
            })
        return {
            "rows": people,
            "period": period,
            "capacity_hours": hours,
            "basis": (
                f"Tracked time over the last {window} against a DEFAULT capacity of "
                f"{hours:g}h — no per-person capacity is stored yet, so this is an "
                f"assumption, not a measurement."
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
                "ORDER BY t.due_at NULLS LAST, t.title "
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
                "Work stalled on someone outside the team (an open blocker of an "
                "external kind), which is NOT the same as paused."
                if state == "awaiting"
                else f"Open work whose lifecycle status is {state}."
            ),
        }

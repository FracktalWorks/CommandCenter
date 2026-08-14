"""Workload signals — behind · at risk · overloaded · idle · on track (WS-28j1).

Spec: ``project-docs/specs/people_center_app.md`` §5.7.1, §5.7.2 · **D-PC-14**.

**Pure, and outside both route packages** for the same reason
:mod:`gateway.work_schedule` is: the department rollup (j2), the rebalancing
suggester (j3) and the Center landing rollup (§5.9) all have to reach the same
answer, and a projection that recomputes a number the app already renders is how
two numbers start disagreeing where nobody can see them.

⚠️ **A pill is a statement about TASKS, not about a person** (§5.7.2, D-PC-14).
*"Three tasks are past their due date"* is a fact: actionable, checkable, and
arguable. *"Priya is underperforming"* is a conclusion this product does not get
to draw, and the difference is not cosmetic — the first names something you can
go and fix. Every pill here therefore carries its own :data:`reason`, written as
a sentence about work, and nothing in this module ranks one person against
another.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from gateway.work_schedule import working_hours_between

MINUTES_PER_HOUR = 60.0

#: The five words, in precedence order — the FIRST one that applies is the
#: row's pill.
#:
#: The order is the order of what a manager has to do something about today.
#: "Behind" outranks everything because a missed date is already true; "at risk"
#: outranks "overloaded" because a specific deadline is a specific conversation
#: and a full week is a general one; "idle" comes last of the real signals
#: because it is the only one that is not yet a problem.
#:
#: A row can satisfy several at once (behind AND overloaded is the common case),
#: so :func:`classify` also returns ``flags`` — every signal that applies. The
#: pill is what the row wears; the flags are what the row knows.
PILLS: tuple[str, ...] = ("behind", "at_risk", "overloaded", "idle", "on_track")

#: How far ahead "at risk" looks. Two weeks: far enough that there is still time
#: to act on what it finds, near enough that the estimate and the schedule are
#: still worth trusting. Beyond this the honest answer is "we do not know yet",
#: and a dashboard that raises alarms about a deadline five weeks out teaches
#: people to ignore it.
HORIZON_DAYS = 14

#: Below this share of the contracted week, a row reads as idle. A quarter
#: rather than zero, because "has one small thing due on Friday" is a planning
#: signal in exactly the same way as "has nothing" — and the owner's ask was
#: that nobody ends up with no work, not that nobody ends up with none at all.
IDLE_FRACTION = 0.25


def as_date(value: Any) -> date | None:
    """A ``date``, a ``datetime`` or an ISO string → a plain ``date``.

    The deadline arithmetic works in whole days because the schedule does: a
    working day is a unit the policy defines, and there is no half of one that
    ``hours_per_day`` can express. A ``due_at`` timestamp is therefore truncated
    to its date, and the row is treated as due at the END of that day — which is
    what "due Friday" means to everybody who is not a database.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def hours_of(estimate_mins: Any) -> float:
    """Minutes → hours. ``None`` is zero here and counted separately."""
    if estimate_mins is None:
        return 0.0
    try:
        return float(estimate_mins) / MINUTES_PER_HOUR
    except (TypeError, ValueError):
        return 0.0


def at_risk_tasks(
    schedule: dict[str, Any],
    tasks: list[dict[str, Any]],
    absences: list[dict[str, Any]] | None,
    today: date,
    *,
    horizon_days: int = HORIZON_DAYS,
) -> list[dict[str, Any]]:
    """Which dated tasks cannot fit in the working time before their due date.

    **The estimate is CUMULATIVE, and that is the whole point.** Three four-hour
    tasks all due Friday, with eight working hours before Friday, is a week that
    does not fit — and per-task arithmetic says all three are fine, because none
    of them individually exceeds eight. So the tasks are walked in due-date
    order and each one is measured against the sum of everything that has to
    happen before it, which is what §5.7.2's *"remaining estimate"* means once
    you write it down: the work remaining before that date, not the work of that
    row alone.

    **Overdue work is carried into the sum.** A task that missed Tuesday still
    has to be done, and pretending otherwise makes every deadline after it look
    reachable — the exact failure that turns a slipping week into a surprise.
    Those tasks are reported separately (they make the row *behind*, not *at
    risk*) but they are never dropped from the arithmetic.

    **Undated tasks are excluded.** They carry no deadline to be late for, so
    they cannot force a sequence; counting them here would put an at-risk pill
    on somebody whose backlog is simply large. They are visible on the row as
    committed hours instead.

    **Unestimated tasks contribute nothing** and are counted, not guessed. A
    guess would be a number nobody can check on a surface people plan against;
    :func:`classify` suppresses the hours-based pills instead.

    The available hours come from :func:`gateway.work_schedule.working_hours_between`
    — the person's effective schedule minus their absences — which is why
    WS-28p and WS-28k had to exist before this ticket did. A week of holiday is
    exactly the difference between "the deadline is far away" and "they have the
    hours before it".
    """
    horizon = today + timedelta(days=max(0, int(horizon_days)))
    dated: list[tuple[date, dict[str, Any]]] = []
    for task in tasks:
        due = as_date(task.get("due_at"))
        if due is None or due > horizon:
            continue
        dated.append((due, task))
    dated.sort(key=lambda pair: (pair[0], str(pair[1].get("title") or "")))

    out: list[dict[str, Any]] = []
    needed = 0.0
    for due, task in dated:
        own = hours_of(task.get("estimate_mins"))
        needed += own
        if due < today:
            # Already late: the row is *behind*, which is a stronger and simpler
            # statement than "at risk". Its hours stay in `needed` because the
            # work is still outstanding.
            continue
        # Inclusive of the due date itself — "due Friday" means Friday is a day
        # you can still work on it.
        available = working_hours_between(schedule, today, due, absences)
        if needed > available + 1e-9:
            out.append({
                "task_id": task.get("id"),
                "title": task.get("title"),
                "project_name": task.get("project_name"),
                "due_on": due.isoformat(),
                "own_hours": round(own, 2),
                #: Everything that has to happen on or before this date,
                #: including the earlier tasks and anything already overdue.
                "needed_hours": round(needed, 2),
                "available_hours": round(available, 2),
                "shortfall_hours": round(needed - available, 2),
            })
    return out


def classify(metrics: dict[str, Any]) -> dict[str, Any]:
    """The five pills, from numbers that are all on the row beside them.

    Every branch here is arithmetic over tasks and dates, and every one states
    its reason in a sentence a person can check against the expanded row. That
    is the constraint that makes this surface a *measurement* surface rather
    than a performance one (D-PC-14): if the reason cannot be written as a fact
    about work, the pill does not belong here.

    **The hours-based pills are suppressed where nothing is estimated.** A row
    holding thirty un-estimated tasks sums to zero hours, and a dashboard that
    reads that as "free" is not merely unhelpful — it hands somebody more work.
    Where no open task carries an estimate, ``hours_basis`` is False, *at risk*,
    *overloaded* and *idle-by-hours* are all off, and the row says so instead.
    The same suppression applies to a person with no contracted hours at all,
    because every hours comparison there divides against nothing.
    """
    open_tasks = int(metrics.get("open_tasks") or 0)
    unestimated = int(metrics.get("unestimated") or 0)
    overdue = int(metrics.get("overdue") or 0)
    contracted = float(metrics.get("contracted_hours") or 0.0)
    week = float(metrics.get("committed_this_week") or 0.0)
    risky = list(metrics.get("at_risk") or [])

    # Estimated on at least one open task, and a week to compare against.
    hours_basis = bool(
        contracted > 0 and (open_tasks == 0 or unestimated < open_tasks)
    )

    flags: list[str] = []
    reasons: dict[str, str] = {}

    if overdue:
        flags.append("behind")
        reasons["behind"] = (
            f"{overdue} open {_tasks(overdue)} past the due date."
        )
    if hours_basis and risky:
        flags.append("at_risk")
        first = risky[0]
        more = (f" (+{len(risky) - 1} more)" if len(risky) > 1 else "")
        reasons["at_risk"] = (
            f"{first.get('title') or 'A task'} is due {first.get('due_on')} and "
            f"needs {first.get('needed_hours')}h of work; there are "
            f"{first.get('available_hours')}h of working time before it{more}."
        )
    if hours_basis and week > contracted:
        flags.append("overloaded")
        reasons["overloaded"] = (
            f"{_h(week)} of estimated work due this week, against a "
            f"{_h(contracted)} week."
        )
    if open_tasks == 0:
        flags.append("idle")
        reasons["idle"] = "No open tasks assigned."
    elif hours_basis and week < contracted * IDLE_FRACTION:
        flags.append("idle")
        reasons["idle"] = (
            f"{_h(week)} of estimated work due this week, against a "
            f"{_h(contracted)} week."
        )

    pill = next((p for p in PILLS if p in flags), "on_track")
    if pill == "on_track":
        reasons["on_track"] = (
            f"{open_tasks} open {_tasks(open_tasks)}, nothing overdue"
            + (f", {_h(week)} due this week." if hours_basis else ".")
        )

    note = None
    if not hours_basis and open_tasks:
        note = (
            f"{open_tasks} open {_tasks(open_tasks)} with no estimate — "
            "hours-based signals are off for this row."
            if contracted > 0 else
            "No contracted hours recorded — hours-based signals are off for "
            "this row."
        )

    return {
        "pill": pill,
        "reason": reasons[pill],
        # Every signal that applies, in precedence order. "Behind AND
        # overloaded" is a different conversation from "behind", and a single
        # pill cannot say so.
        "flags": [p for p in PILLS if p in flags],
        "hours_basis": hours_basis,
        "note": note,
    }


def _tasks(n: int) -> str:
    return "task" if n == 1 else "tasks"


def _h(hours: float) -> str:
    """``40.0`` → ``40h``; ``37.5`` → ``37.5h``. A trailing ``.0`` on a figure
    people read at a glance is noise that makes the number look computed."""
    rounded = round(float(hours), 1)
    return f"{int(rounded)}h" if rounded == int(rounded) else f"{rounded}h"

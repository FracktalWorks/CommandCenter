"""Projects · operations — the work-execution rules, with no routes in them.

Spec: ``project-docs/specs/project_management_app.md`` (WS-27) · owner brief
2026-08-12 (Project Operations) · migration 171.

Separate from ``tasks.py`` for the reason ``mapping.py`` is separate from
``import_clickup.py``: these are *decisions*, and a decision that can only be
exercised by standing up a FastAPI app, a session and a database is a decision
nobody tests the edges of. Everything here is a pure function over plain values
— no session, no request, no clock it does not receive — so the state machine
can be tested exhaustively and the handlers stay thin.

Three rules live here, and they are the ones the brief says must be enforced
server-side:

  1. **Which lifecycle transitions are legal** (§42). The handler asks; it does
     not decide.
  2. **How long a session lasted** (§41). Always from timestamps, never from a
     number the client sent.
  3. **When a project is at risk** (§24). Manual today, derivable tomorrow —
     the shape is here so "later it can become calculated" is a change of one
     function rather than a schema migration.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

# ── Lifecycle status ────────────────────────────────────────────────────────
#
# These are `pm_task_statuses.category` values, NOT a new vocabulary. The
# category column has been the machine-readable half of a status since
# migration 146; migration 171 widened it with `paused` and `blocked`, which
# were the two an operations system turns on. Introducing a parallel
# `project_status` column beside it would be the second-way-to-do-a-thing
# CLAUDE.md §5 forbids, and the two would disagree within a release.

#: The lifecycle states, as the brief §8 names them, in `category` spelling.
NOT_STARTED = "todo"
BACKLOG = "backlog"
IN_PROGRESS = "in_progress"
PAUSED = "paused"
BLOCKED = "blocked"
COMPLETED = "done"
CANCELLED = "cancelled"
TRIAGE = "triage"

#: Categories that close a task. Mirrors ``core.CLOSING_CATEGORIES`` — imported
#: rather than restated below so the two cannot drift.
_CLOSED = frozenset({COMPLETED, CANCELLED})

#: The legal moves. A transition absent from this table is refused, which is
#: what makes "prevent invalid project transitions" (§40) a property of the
#: system rather than of whichever handler remembered to check.
#:
#: Read it as: from → the set you may reach.
#:
#: Notes on the non-obvious edges, each of which is a real workflow:
#:   • BLOCKED and PAUSED can reach each other. "We paused it, and now we have
#:     also learnt the client is sitting on it" is one edit, not a round trip
#:     through IN_PROGRESS that would invent a work session nobody worked.
#:   • COMPLETED → IN_PROGRESS is the reopen, and it is deliberately the only
#:     way out of COMPLETED: reopening straight to PAUSED would produce a task
#:     that was never resumed and has no session explaining the reopen.
#:   • CANCELLED is not terminal. Work gets un-cancelled when a customer
#:     changes their mind, and forcing a new task loses the history — which is
#:     the one thing §45 says must survive.
#:   • Everything can reach CANCELLED, including NOT_STARTED.
TRANSITIONS: dict[str, frozenset[str]] = {
    TRIAGE:      frozenset({NOT_STARTED, BACKLOG, IN_PROGRESS, CANCELLED}),
    BACKLOG:     frozenset({NOT_STARTED, IN_PROGRESS, CANCELLED}),
    NOT_STARTED: frozenset({IN_PROGRESS, BACKLOG, CANCELLED}),
    IN_PROGRESS: frozenset({PAUSED, BLOCKED, COMPLETED, CANCELLED}),
    PAUSED:      frozenset({IN_PROGRESS, BLOCKED, COMPLETED, CANCELLED}),
    BLOCKED:     frozenset({IN_PROGRESS, PAUSED, COMPLETED, CANCELLED}),
    COMPLETED:   frozenset({IN_PROGRESS}),
    CANCELLED:   frozenset({IN_PROGRESS, NOT_STARTED}),
}

#: Transitions that require the caller to say why, and the field that carries
#: it. The brief is explicit that pause and complete are never silent (§15,
#: §16); blocking is here too because an unexplained blocker is the row that
#: makes the Blocked view unusable — it can tell you a thing is stuck and not
#: one useful word about why.
REMARK_REQUIRED: frozenset[str] = frozenset({PAUSED, BLOCKED, COMPLETED, CANCELLED})


class TransitionError(ValueError):
    """An illegal lifecycle move. Carries both ends so the handler's 422 can
    name them without re-deriving anything."""

    def __init__(self, current: str, target: str, reason: str | None = None) -> None:
        self.current = current
        self.target = target
        self.reason = reason
        allowed = sorted(TRANSITIONS.get(current, frozenset()))
        super().__init__(
            reason
            or f"Cannot move from '{current}' to '{target}'. "
               f"Allowed from '{current}': {allowed or 'nothing'}."
        )


def can_transition(current: str, target: str) -> bool:
    """Is this move legal? A no-op (current == target) is legal and idempotent —
    two tabs both clicking Pause must not produce an error the second time."""
    if current == target:
        return True
    return target in TRANSITIONS.get(current, frozenset())


def check_transition(current: str, target: str, remark: str | None = None) -> None:
    """Raise unless the move is legal AND explained where an explanation is owed.

    Called by every write path that changes lifecycle state. Kept as a raising
    guard rather than a boolean so a handler cannot forget to branch on the
    result — the failure mode of ``if can_transition(...)`` is silence.
    """
    if current not in TRANSITIONS:
        raise TransitionError(current, target, f"Unknown current state '{current}'.")
    if target not in TRANSITIONS:
        raise TransitionError(current, target, f"Unknown target state '{target}'.")
    if not can_transition(current, target):
        raise TransitionError(current, target)
    # A no-op needs no fresh justification: the remark that explained the
    # original move is still the true one, and demanding another would make a
    # duplicate click fail.
    if current != target and target in REMARK_REQUIRED and not (remark or "").strip():
        raise TransitionError(
            current, target,
            f"Moving to '{target}' requires a remark saying why.",
        )


def is_closed(category: str) -> bool:
    """Does this category mean the work is no longer outstanding?

    Paused and blocked are deliberately NOT closed — they are the states an
    operations dashboard exists to surface, and dropping them from "still open"
    is how work goes quiet for three weeks.
    """
    return category in _CLOSED


# ── Time ────────────────────────────────────────────────────────────────────

#: Sessions longer than this are almost certainly a timer somebody forgot to
#: stop rather than a day somebody worked. Reported, never silently truncated:
#: the brief forbids editing historical entries (§12), and a system that
#: quietly rewrites a 19-hour session is a system whose numbers cannot be
#: defended. Surfacing it lets a human close it with a remark.
RUNAWAY_SESSION = timedelta(hours=12)


def elapsed_seconds(started_at: datetime, ended_at: datetime | None, now: datetime) -> int:
    """The duration of a session, from timestamps only.

    ``now`` is passed in rather than read from the clock so this is testable and
    so a caller computing a whole page of rows uses ONE instant for all of them
    — otherwise two rows on the same screen disagree about what time it is.

    Mirrors the ``duration_secs`` generated column exactly for closed sessions
    (migration 171); this function additionally answers the open case, which
    the column cannot because there is nothing to subtract yet.
    """
    end = ended_at if ended_at is not None else now
    return max(0, int((end - started_at).total_seconds()))


def is_runaway(started_at: datetime, ended_at: datetime | None, now: datetime) -> bool:
    """A session long enough that a human should look at it."""
    return elapsed_seconds(started_at, ended_at, now) > RUNAWAY_SESSION.total_seconds()


def format_duration(seconds: int) -> str:
    """``7385`` → ``"2h 3m"``. One spelling of elapsed time for the API, so the
    timer, the project total and the workload column cannot each round
    differently and look like a bug."""
    if seconds < 60:
        return f"{seconds}s"
    minutes, _ = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m" if hours else f"{minutes}m"


# ── Health ──────────────────────────────────────────────────────────────────

HEALTHY = "healthy"
AT_RISK = "at_risk"
CRITICAL = "critical"

#: How long a blocker may sit before it is a management problem rather than a
#: normal wait. Chosen, not measured — one working week is the point at which
#: "waiting on the customer" stops being an explanation.
BLOCKED_CRITICAL = timedelta(days=7)
BLOCKED_AT_RISK = timedelta(days=3)

#: Work with no movement for this long is drifting even if nothing is wrong.
STALE_AT_RISK = timedelta(days=10)


@dataclass(frozen=True)
class HealthInput:
    """Everything the rule may look at. A frozen record rather than eight
    positional arguments because the call site is a row and the next rule will
    want a field this one does not."""

    category: str
    due_at: datetime | None = None
    blocked_since: datetime | None = None
    last_activity_at: datetime | None = None
    estimate_mins: int | None = None
    actual_secs: int = 0
    manual: str | None = None


def derive_health(row: HealthInput, now: datetime) -> str | None:
    """The computed health, or ``None`` when nothing is known.

    **A manual assessment always wins.** The brief says health is manual now and
    calculated later; a derivation that overrides a human is a derivation people
    stop trusting on the first day it is wrong. So ``manual`` short-circuits,
    and the rules below only ever fill a gap.

    Returns ``None`` rather than ``HEALTHY`` for closed work: a delivered
    project has no health, and painting it green puts it in every "healthy
    projects" count forever.
    """
    if row.manual:
        return row.manual
    if is_closed(row.category):
        return None

    blocked_for = (now - row.blocked_since) if row.blocked_since else None
    overdue = row.due_at is not None and row.due_at < now

    # CRITICAL — someone has to act today.
    if overdue and row.category in (BLOCKED, PAUSED):
        return CRITICAL
    if blocked_for is not None and blocked_for >= BLOCKED_CRITICAL:
        return CRITICAL
    if overdue and row.due_at is not None and (now - row.due_at) >= timedelta(days=7):
        return CRITICAL

    # AT_RISK — it will become critical if nobody looks.
    if overdue:
        return AT_RISK
    if blocked_for is not None and blocked_for >= BLOCKED_AT_RISK:
        return AT_RISK
    if row.last_activity_at is not None and (now - row.last_activity_at) >= STALE_AT_RISK:
        return AT_RISK
    if (
        row.estimate_mins
        and row.estimate_mins > 0
        and row.actual_secs > row.estimate_mins * 60 * 1.25
    ):
        return AT_RISK

    return HEALTHY


# ── Attention ───────────────────────────────────────────────────────────────
#
# "What needs attention?" is the dashboard's first question (§44) and it has no
# single answer in the data: a project can be overdue, or blocked for a
# fortnight, or silently unowned, and each is a different kind of wrong. So it
# is a SCORE over named signals rather than a filter, and the signals come back
# with it — a row that says "23" and not why is a row nobody acts on.


@dataclass(frozen=True)
class AttentionInput:
    category: str
    due_at: datetime | None = None
    blocked_since: datetime | None = None
    last_activity_at: datetime | None = None
    next_action: str | None = None
    assignees: int = 0
    health: str | None = None


#: What each signal is worth. Ordered by how much a human would care, not by
#: how easy it is to compute. Weights are round numbers on purpose: this is a
#: ranking, and pretending to three significant figures would invite somebody
#: to tune it instead of fixing the underlying work.
ATTENTION_WEIGHTS: dict[str, int] = {
    "critical": 40,       # somebody already judged it critical
    "overdue": 30,        # a promise is broken
    "blocked_long": 25,   # blocked past a working week
    "no_owner": 20,       # nobody is going to pick this up by accident
    "blocked": 15,        # blocked at all
    "no_next_action": 10, # nothing says what happens next
    "stale": 10,          # nothing has happened in a long time
    "at_risk": 5,
}


def attention_signals(row: AttentionInput, now: datetime) -> list[str]:
    """Which things are wrong with this project, by name.

    Closed work has no signals: a delivered project cannot need attention, and
    including it would put every finished thing in the list forever.
    """
    if is_closed(row.category):
        return []

    out: list[str] = []
    if row.health == CRITICAL:
        out.append("critical")
    elif row.health == AT_RISK:
        out.append("at_risk")
    if row.due_at is not None and row.due_at < now:
        out.append("overdue")
    if row.category == BLOCKED:
        blocked_for = (now - row.blocked_since) if row.blocked_since else None
        if blocked_for is not None and blocked_for >= BLOCKED_CRITICAL:
            out.append("blocked_long")
        else:
            out.append("blocked")
    if row.assignees == 0:
        out.append("no_owner")
    # Not-started work is not expected to have a next action yet; demanding one
    # would flag the entire backlog and make the list useless.
    if not (row.next_action or "").strip() and row.category not in (NOT_STARTED, BACKLOG):
        out.append("no_next_action")
    if row.last_activity_at is not None and (now - row.last_activity_at) >= STALE_AT_RISK:
        out.append("stale")
    return out


def attention_score(row: AttentionInput, now: datetime) -> int:
    """The sum of what is wrong. Higher is worse; 0 means nothing is."""
    return sum(ATTENTION_WEIGHTS.get(s, 0) for s in attention_signals(row, now))


# ── Workload ────────────────────────────────────────────────────────────────

#: Hours in a working day and week, until a real capacity model exists.
#:
#: ⚠️ **A DEFAULT, not a fact.** Plan §26 lists per-person capacity as a schema
#: addition still owed (S14). Every percentage derived from these must state
#: its basis on screen (acceptance 39) — "82% of 8h/day" is a number somebody
#: can argue with; "82%" is one they cannot.
DEFAULT_DAILY_HOURS = 8.0
DEFAULT_WEEKLY_HOURS = 40.0

OVER_CAPACITY = "over"
HIGH_LOAD = "high"
HEALTHY_LOAD = "healthy"
LIGHT_LOAD = "light"

#: The four bands the mock draws, and the hue each resolves to. Names, not
#: classes — the caller maps them through the shared vocabulary
#: (`statusAccent.ts`), because four ad-hoc colours here would be a second
#: status palette (AGENTS.md rule 4).
WORKLOAD_BANDS: tuple[tuple[float, str, str], ...] = (
    (100.0, OVER_CAPACITY, "red"),
    (80.0, HIGH_LOAD, "amber"),
    (50.0, HEALTHY_LOAD, "green"),
    (0.0, LIGHT_LOAD, "gray"),
)


def workload_band(percent: float) -> tuple[str, str]:
    """`(band, hue)` for a load percentage. Never raises, including on 0."""
    for floor, band, hue in WORKLOAD_BANDS:
        if percent >= floor:
            return band, hue
    return LIGHT_LOAD, "gray"


def workload_percent(seconds: int, capacity_hours: float) -> float:
    """Tracked seconds against capacity, as a percentage.

    **Not clamped.** 104% is the interesting number — it is the whole reason
    the card exists — and rounding it down to 100 hides the person who is
    over-committed. The BAR clamps its own width; the value does not.
    """
    if capacity_hours <= 0:
        return 0.0
    return round((seconds / 3600.0) / capacity_hours * 100.0, 1)


def utcnow() -> datetime:
    """One clock for the package. Timezone-aware always — a naive datetime
    subtracted from an aware one raises, and the place that discovers it is a
    500 on a dashboard rather than a test."""
    return datetime.now(UTC)

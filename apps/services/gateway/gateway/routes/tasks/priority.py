"""Tasks · prioritization engine (server mirror of lib/priority.ts).

The single source of truth on the SERVER for how a task's three inputs
(important x urgent x leveraged) become a priority CELL, an action MODE and a
rank. Kept byte-for-byte behaviourally identical to the frontend
``lib/priority.ts`` so a task's cell is the same whether the client or the
gateway computes it (used for server-side Priority ordering + the AI's reasoning
about what to surface).

Design (agreed with the user):
  * urgent is DERIVED from due_at (overdue or due within a window), never
    stored — so it can't go stale.
  * important = downside (something stalls if skipped); leveraged = upside
    (asymmetric 100x). Separate axes on purpose.
  * The 8 cells are a projection of the three booleans (the user's Notion
    formula, verbatim). Never persisted.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

DEFAULT_URGENT_WINDOW_HOURS = 48


def is_urgent(
    due_at: datetime | None,
    window_hours: int = DEFAULT_URGENT_WINDOW_HOURS,
    now: datetime | None = None,
) -> bool:
    """Overdue OR due within ``window_hours``. No due date → never urgent."""
    if due_at is None:
        return False
    now = now or datetime.now(tz=UTC)
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=UTC)
    delta_hours = (due_at - now).total_seconds() / 3600.0
    return delta_hours <= window_hours  # overdue (<=0) included


# ── The 8 cells (the user's revised Notion formula, verbatim) ────────────────

# cell key → (order 1..8, emoji, label, mode). Order 1 = act first; the sequence
# INTERLEAVES leveraged and non-leveraged cells by true priority. `mode` is the
# SUGGESTION badge the cell nudges toward (delegate/schedule/drop) — never a
# status the task lives in; "do" carries no nudge. Byte-parity with
# lib/priority.ts CELL_META.
CELL_META: dict[str, tuple[int, str, str, str]] = {
    "founder-fire": (1, "🔥", "Founder Fire / Schedule", "do"),
    "delegate-important": (2, "🚨", "Delegate / Attend to ASAP", "delegate"),
    "deep-work": (3, "📈", "High-Leverage Deep Work", "do"),
    "schedule-important": (4, "🔁", "Important / Delegate / Schedule", "schedule"),
    "quick-leverage": (5, "📤", "Quick Leverage Win / Schedule", "do"),
    "delegate-urgent": (6, "🚨", "Eliminate / Ignore / Delegate ASAP", "drop"),
    "leverage-bet": (7, "🧪", "Leverage Bet / Optional", "do"),
    "eliminate": (8, "🗑", "Eliminate / Ignore", "drop"),
}

CELLS_IN_ORDER: list[str] = sorted(CELL_META, key=lambda c: CELL_META[c][0])


@dataclass(frozen=True)
class PriorityInputs:
    important: bool
    urgent: bool
    leveraged: bool


def cell_for_inputs(inp: PriorityInputs) -> str:
    """The user's Notion formula, verbatim, as a pure function of the 3 bools."""
    if inp.leveraged:
        if inp.important and inp.urgent:
            return "founder-fire"        # order 1
        if inp.important and not inp.urgent:
            return "deep-work"           # order 3
        if not inp.important and inp.urgent:
            return "quick-leverage"      # order 5
        return "leverage-bet"            # order 7
    if inp.important and inp.urgent:
        return "delegate-important"      # order 2
    if inp.important and not inp.urgent:
        return "schedule-important"      # order 4
    if not inp.important and inp.urgent:
        return "delegate-urgent"         # order 6
    return "eliminate"                   # order 8


def priority_inputs(
    *,
    important: bool,
    leveraged: bool,
    due_at: datetime | None,
    window_hours: int = DEFAULT_URGENT_WINDOW_HOURS,
    now: datetime | None = None,
) -> PriorityInputs:
    return PriorityInputs(
        important=bool(important),
        leveraged=bool(leveraged),
        urgent=is_urgent(due_at, window_hours, now),
    )


def priority_cell(
    *,
    important: bool,
    leveraged: bool,
    due_at: datetime | None,
    window_hours: int = DEFAULT_URGENT_WINDOW_HOURS,
    now: datetime | None = None,
) -> str:
    return cell_for_inputs(priority_inputs(
        important=important, leveraged=leveraged, due_at=due_at,
        window_hours=window_hours, now=now))


def priority_rank(**kwargs) -> int:
    """The matrix rank (1 = highest). Lower sorts first."""
    return CELL_META[priority_cell(**kwargs)][0]


def action_mode(**kwargs) -> str:
    """do / delegate / schedule / drop for a task."""
    return CELL_META[priority_cell(**kwargs)][3]

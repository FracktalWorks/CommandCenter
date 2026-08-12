"""The Project Operations rules — state machine, time, health.

Spec: ``project-docs/specs/project_management_app.md`` (WS-27) · owner brief
2026-08-12 · migration 171.

These test the module that DECIDES, not the handler that asks. That split is
the point: a state machine exercised only through HTTP gets its happy path
covered and its edges never, and the edges are where "engineers can pause work"
turns into "engineers can pause completed work".
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import pytest
from gateway.routes.projects import operations as ops

NOW = datetime(2026, 8, 12, 12, 0, tzinfo=UTC)
def ago(**kw) -> datetime:
    return NOW - timedelta(**kw)
def ahead(**kw) -> datetime:
    return NOW + timedelta(**kw)


# ── The mirrors ─────────────────────────────────────────────────────────────
#
# R7: a rule names its fence. These two are the fences for the two facts this
# module restates from somewhere else.

def test_closed_categories_match_core() -> None:
    """``operations._CLOSED`` must equal ``core.CLOSING_CATEGORIES``.

    Two modules holding the same fact is how `completed_at` and "is it still
    outstanding" come to disagree — one of them stamps a closing category the
    other does not recognise, and work vanishes from the open list while still
    counting as open. Restated for readability, fenced so it cannot drift.
    """
    from gateway.routes.projects.core import CLOSING_CATEGORIES

    assert ops._CLOSED == CLOSING_CATEGORIES


def test_the_category_vocabulary_mirror_is_exact() -> None:
    """``core.STATUS_CATEGORIES`` must equal the database's CHECK.

    ⚠️ This fence exists because the mirror broke the day it was widened.
    Migration 171 added `paused` and `blocked` to the CHECK; the Python tuple
    was not updated, and `validate_choice` refuses an unknown category BEFORE
    the insert — so creating a Paused lane answered 422 while the database
    would have accepted it happily. Exactly the failure `pm_activities.type`
    already had once (150's `attachment`), one column over.
    """
    from gateway.routes.projects.core import STATUS_CATEGORIES

    assert set(STATUS_CATEGORIES) == _check_values(
        "pm_task_statuses_category_check", "category",
    )


def _check_values(constraint: str, column: str) -> set[str]:
    """A CHECK's allowed values, as the DATABASE will enforce them.

    ⚠️ Keyed on the CONSTRAINT NAME, not the column. Matching `CHECK (kind IN
    (...))` by column alone finds five different tables' constraints — custom
    apps, copilot events, workflows, pm_notifications — and taking "the last
    file" then asserts against whichever table happens to sort last. Measured:
    the first version of this helper compared the notification kinds against a
    workflow's vocabulary and failed with a diff nobody could read.

    The same trap applies to `category`, which five migrations constrain. That
    fence passed only because 171 currently sorts last; a `category` CHECK
    added in 173 on any other table would have silently repointed it. Both are
    keyed by name now.
    """
    migrations = Path(__file__).resolve().parents[2] / "infra" / "postgres"
    latest: str | None = None
    pattern = re.compile(
        rf"{re.escape(constraint)}[\s\S]{{0,120}}?"
        rf"CHECK\s*\(\s*{column}\s+IN\s*\((.*?)\)\s*\)",
        re.I | re.S,
    )
    for path in sorted(migrations.glob("*.sql"), key=lambda p: p.name):
        if path.name == "schema.generated.sql":
            continue
        text = "\n".join(
            re.sub(r"--.*$", "", line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        for match in pattern.finditer(text):
            latest = match.group(1)
    assert latest is not None, f"no migration defines {constraint}"
    return set(re.findall(r"'([a-z_]+)'", latest))


def test_the_notification_kind_mirror_is_exact() -> None:
    """``notifications.NOTIFICATION_KINDS`` must equal the database's CHECK.

    The THIRD mirror in this workstream, after `pm_activities.type` (broke on
    migration 150) and `pm_task_statuses.category` (broke on 171). `notify()`
    refuses an unknown kind before the insert, so a widening the database
    accepted and this tuple did not would turn every work notification into a
    422 on an otherwise successful action.
    """
    from gateway.routes.projects.notifications import NOTIFICATION_KINDS

    assert set(NOTIFICATION_KINDS) == _check_values(
        "pm_notifications_kind_check", "kind",
    )


def test_every_lifecycle_state_is_a_real_category() -> None:
    """Every state in the machine must be a value the DATABASE will accept.

    Read out of the migration rather than restated, for the reason the activity
    vocabulary test exists: a state machine that can reach a category the CHECK
    refuses is a 500 on a button, discovered in production.
    """
    migrations = Path(__file__).resolve().parents[2] / "infra" / "postgres"
    latest: str | None = None
    for path in sorted(migrations.glob("*.sql"), key=lambda p: p.name):
        if path.name == "schema.generated.sql":
            continue
        text = "\n".join(
            re.sub(r"--.*$", "", line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        for match in re.finditer(
            r"CHECK\s*\(\s*category\s+IN\s*\((.*?)\)\s*\)", text, re.I | re.S,
        ):
            latest = match.group(1)
    assert latest is not None, "no migration constrains pm_task_statuses.category"
    allowed = set(re.findall(r"'([a-z_]+)'", latest))

    states = set(ops.TRANSITIONS) | {t for v in ops.TRANSITIONS.values() for t in v}
    assert states <= allowed, (
        f"the state machine can reach categories the database refuses: "
        f"{sorted(states - allowed)}"
    )


# ── The state machine ───────────────────────────────────────────────────────

def test_the_happy_path_the_brief_names() -> None:
    """§42's worked example, start to finish."""
    chain = [
        ops.NOT_STARTED, ops.IN_PROGRESS, ops.PAUSED,
        ops.IN_PROGRESS, ops.COMPLETED,
    ]
    for current, target in pairwise(chain):
        assert ops.can_transition(current, target), f"{current} → {target}"


def test_blocked_round_trip() -> None:
    assert ops.can_transition(ops.IN_PROGRESS, ops.BLOCKED)
    assert ops.can_transition(ops.BLOCKED, ops.IN_PROGRESS)


def test_reopen() -> None:
    assert ops.can_transition(ops.COMPLETED, ops.IN_PROGRESS)


@pytest.mark.parametrize(
    "current,target",
    [
        # The one that matters: you cannot pause work that is finished.
        (ops.COMPLETED, ops.PAUSED),
        (ops.COMPLETED, ops.BLOCKED),
        (ops.COMPLETED, ops.COMPLETED + "x"),
        # Nor start work by declaring it paused.
        (ops.NOT_STARTED, ops.PAUSED),
        (ops.NOT_STARTED, ops.BLOCKED),
        (ops.NOT_STARTED, ops.COMPLETED),
        # A backlog item is not in progress until somebody starts it.
        (ops.BACKLOG, ops.PAUSED),
        (ops.BACKLOG, ops.COMPLETED),
    ],
)
def test_illegal_moves_are_refused(current: str, target: str) -> None:
    assert not ops.can_transition(current, target)
    with pytest.raises(ops.TransitionError):
        ops.check_transition(current, target, remark="a reason")


def test_a_repeated_move_is_idempotent_not_an_error() -> None:
    """Two tabs both clicking Pause must not make the second one fail — and
    must not demand a second remark for a move that already happened."""
    ops.check_transition(ops.PAUSED, ops.PAUSED)
    assert ops.can_transition(ops.COMPLETED, ops.COMPLETED)


def test_the_set_of_states_that_owe_an_explanation_is_the_expected_one() -> None:
    """⚠️ This exists because the test below could not fail.

    Parametrising over ``REMARK_REQUIRED`` means emptying that set produces an
    empty parameter list, and pytest SKIPS an empty parametrisation rather than
    failing it. Measured: deleting the whole remark rule turned the fence below
    green-with-a-skip. So the membership is pinned here, where removing a state
    is a red test rather than a silent one.

    §15 and §16 are explicit that pause and complete are never silent; this is
    the assertion that keeps them that way.
    """
    assert frozenset({
        ops.PAUSED, ops.BLOCKED, ops.COMPLETED, ops.CANCELLED,
    }) == ops.REMARK_REQUIRED


@pytest.mark.parametrize("target", sorted(ops.REMARK_REQUIRED))
def test_the_states_that_owe_an_explanation_refuse_a_blank_one(target: str) -> None:
    source = ops.IN_PROGRESS if target != ops.IN_PROGRESS else ops.PAUSED
    for blank in ("", "   ", "\n\t"):
        with pytest.raises(ops.TransitionError, match="requires a remark"):
            ops.check_transition(source, target, remark=blank)
    with pytest.raises(ops.TransitionError, match="requires a remark"):
        ops.check_transition(source, target, remark=None)
    ops.check_transition(source, target, remark="waiting on M&M")


def test_resuming_needs_no_remark() -> None:
    """Starting and resuming are the cheap actions; §49 wants one click."""
    ops.check_transition(ops.PAUSED, ops.IN_PROGRESS)
    ops.check_transition(ops.NOT_STARTED, ops.IN_PROGRESS)


def test_an_unknown_state_is_refused_rather_than_assumed() -> None:
    with pytest.raises(ops.TransitionError, match="Unknown current state"):
        ops.check_transition("vibes", ops.IN_PROGRESS, remark="x")
    with pytest.raises(ops.TransitionError, match="Unknown target state"):
        ops.check_transition(ops.IN_PROGRESS, "shipped", remark="x")


def test_the_error_names_what_was_allowed() -> None:
    """A 422 that does not say what you could have done costs a support round
    trip."""
    with pytest.raises(ops.TransitionError) as caught:
        ops.check_transition(ops.COMPLETED, ops.PAUSED, remark="x")
    assert "in_progress" in str(caught.value)


def test_is_closed() -> None:
    assert ops.is_closed(ops.COMPLETED)
    assert ops.is_closed(ops.CANCELLED)
    # The two that an operations system must keep counting as open.
    assert not ops.is_closed(ops.PAUSED)
    assert not ops.is_closed(ops.BLOCKED)


# ── Time ────────────────────────────────────────────────────────────────────

def test_a_closed_session_measures_its_own_timestamps() -> None:
    assert ops.elapsed_seconds(ago(hours=2), ago(hours=1), NOW) == 3600


def test_an_open_session_measures_to_now() -> None:
    """The property that makes the timer survive a refresh: nothing is
    accumulated client-side, so reloading recomputes the same number."""
    assert ops.elapsed_seconds(ago(minutes=90), None, NOW) == 5400
    later = NOW + timedelta(minutes=30)
    assert ops.elapsed_seconds(ago(minutes=90), None, later) == 7200


def test_a_backwards_session_is_zero_not_negative() -> None:
    """The table's CHECK refuses this on write; if one ever exists the reader
    must not report negative engineering time."""
    assert ops.elapsed_seconds(NOW, ago(hours=1), NOW) == 0


def test_runaway_detection() -> None:
    assert not ops.is_runaway(ago(hours=8), None, NOW)
    assert ops.is_runaway(ago(hours=13), None, NOW)


@pytest.mark.parametrize(
    "secs,expected",
    [(0, "0s"), (45, "45s"), (60, "1m"), (5400, "1h 30m"), (7385, "2h 3m"), (3600, "1h 0m")],
)
def test_duration_formatting(secs: int, expected: str) -> None:
    assert ops.format_duration(secs) == expected


# ── Health ──────────────────────────────────────────────────────────────────

def test_a_human_assessment_beats_the_rule() -> None:
    row = ops.HealthInput(
        category=ops.BLOCKED, blocked_since=ago(days=30), manual=ops.HEALTHY,
    )
    assert ops.derive_health(row, NOW) == ops.HEALTHY


def test_closed_work_has_no_health() -> None:
    for category in (ops.COMPLETED, ops.CANCELLED):
        assert ops.derive_health(ops.HealthInput(category=category), NOW) is None


def test_long_blocked_is_critical() -> None:
    row = ops.HealthInput(category=ops.BLOCKED, blocked_since=ago(days=9))
    assert ops.derive_health(row, NOW) == ops.CRITICAL


def test_briefly_blocked_is_at_risk_not_critical() -> None:
    row = ops.HealthInput(category=ops.BLOCKED, blocked_since=ago(days=4))
    assert ops.derive_health(row, NOW) == ops.AT_RISK


def test_overdue_and_stalled_is_critical() -> None:
    row = ops.HealthInput(category=ops.PAUSED, due_at=ago(days=1))
    assert ops.derive_health(row, NOW) == ops.CRITICAL


def test_overdue_but_moving_is_only_at_risk() -> None:
    row = ops.HealthInput(category=ops.IN_PROGRESS, due_at=ago(days=1))
    assert ops.derive_health(row, NOW) == ops.AT_RISK


def test_no_movement_for_ten_days_is_at_risk() -> None:
    row = ops.HealthInput(category=ops.IN_PROGRESS, last_activity_at=ago(days=11))
    assert ops.derive_health(row, NOW) == ops.AT_RISK


def test_well_over_estimate_is_at_risk() -> None:
    row = ops.HealthInput(
        category=ops.IN_PROGRESS, estimate_mins=60, actual_secs=60 * 60 * 2,
    )
    assert ops.derive_health(row, NOW) == ops.AT_RISK


def test_a_little_over_estimate_is_still_healthy() -> None:
    """A 25% tolerance, or every project is permanently amber and the colour
    stops meaning anything."""
    row = ops.HealthInput(
        category=ops.IN_PROGRESS, estimate_mins=60, actual_secs=int(60 * 60 * 1.1),
    )
    assert ops.derive_health(row, NOW) == ops.HEALTHY


def test_a_zero_estimate_does_not_divide_by_anything() -> None:
    row = ops.HealthInput(category=ops.IN_PROGRESS, estimate_mins=0, actual_secs=999)
    assert ops.derive_health(row, NOW) == ops.HEALTHY


def test_ordinary_work_is_healthy() -> None:
    row = ops.HealthInput(
        category=ops.IN_PROGRESS, due_at=ahead(days=14), last_activity_at=ago(hours=2),
    )
    assert ops.derive_health(row, NOW) == ops.HEALTHY


# ── Attention (WS-27bn) ─────────────────────────────────────────────────────

def _att(**kw) -> ops.AttentionInput:
    return ops.AttentionInput(category=kw.pop("category", ops.IN_PROGRESS), **kw)


def test_closed_work_never_needs_attention() -> None:
    """A delivered project cannot be on the list, or the list grows forever."""
    for category in (ops.COMPLETED, ops.CANCELLED):
        row = _att(category=category, due_at=ago(days=30), assignees=0)
        assert ops.attention_signals(row, NOW) == []
        assert ops.attention_score(row, NOW) == 0


def test_healthy_moving_work_has_no_signals() -> None:
    row = _att(
        due_at=ahead(days=10), next_action="Chase M&M",
        assignees=1, last_activity_at=ago(hours=3),
    )
    assert ops.attention_signals(row, NOW) == []


def test_the_signals_are_named_not_just_scored() -> None:
    """A row that says 55 and not why is a row nobody acts on."""
    row = _att(
        category=ops.BLOCKED, blocked_since=ago(days=9),
        due_at=ago(days=2), next_action=None, assignees=1,
    )
    signals = ops.attention_signals(row, NOW)
    assert "blocked_long" in signals
    assert "overdue" in signals
    assert "no_next_action" in signals
    assert "blocked" not in signals, "long-blocked must not double-count as blocked"


def test_worse_work_scores_higher() -> None:
    mild = _att(due_at=ago(days=1), next_action="x", assignees=1)
    bad = _att(
        category=ops.BLOCKED, blocked_since=ago(days=20),
        due_at=ago(days=20), assignees=0, health=ops.CRITICAL,
    )
    assert ops.attention_score(bad, NOW) > ops.attention_score(mild, NOW)


def test_not_started_work_is_not_nagged_for_a_next_action() -> None:
    """Otherwise the whole backlog is on the attention list on day one."""
    for category in (ops.NOT_STARTED, ops.BACKLOG):
        row = _att(category=category, next_action=None, assignees=1)
        assert "no_next_action" not in ops.attention_signals(row, NOW)


def test_unassigned_open_work_is_flagged() -> None:
    row = _att(assignees=0, next_action="x")
    assert "no_owner" in ops.attention_signals(row, NOW)


def test_every_signal_carries_a_weight() -> None:
    """A signal with no weight scores zero and silently stops mattering."""
    produced = set()
    for row in (
        _att(category=ops.BLOCKED, blocked_since=ago(days=1), assignees=0),
        _att(category=ops.BLOCKED, blocked_since=ago(days=30), assignees=0),
        _att(due_at=ago(days=1), health=ops.CRITICAL, assignees=1, next_action="x"),
        _att(health=ops.AT_RISK, assignees=1, next_action="x"),
        _att(last_activity_at=ago(days=30), assignees=1, next_action="x"),
        _att(assignees=1),
    ):
        produced |= set(ops.attention_signals(row, NOW))
    assert produced, "no signals produced — the fixtures stopped exercising it"
    assert produced <= set(ops.ATTENTION_WEIGHTS)


# ── Workload ────────────────────────────────────────────────────────────────

def test_workload_percent_is_not_clamped() -> None:
    """104% is the interesting number — it is why the card exists."""
    assert ops.workload_percent(3600 * 42, 40.0) == 105.0


def test_workload_percent_survives_zero_capacity() -> None:
    assert ops.workload_percent(3600, 0) == 0.0


@pytest.mark.parametrize(
    "pct,band",
    [(140, ops.OVER_CAPACITY), (100, ops.OVER_CAPACITY), (99.9, ops.HIGH_LOAD),
     (80, ops.HIGH_LOAD), (79, ops.HEALTHY_LOAD), (50, ops.HEALTHY_LOAD),
     (49, ops.LIGHT_LOAD), (0, ops.LIGHT_LOAD)],
)
def test_workload_bands(pct: float, band: str) -> None:
    assert ops.workload_band(pct)[0] == band


def test_workload_bands_resolve_to_shared_vocabulary_hues() -> None:
    """Four ad-hoc colours here would be a second status palette (rule 4)."""
    for _, band, hue in ops.WORKLOAD_BANDS:
        assert hue in {"gray", "red", "amber", "green", "blue", "violet"}, band

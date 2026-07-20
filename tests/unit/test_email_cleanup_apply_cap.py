"""The per-cycle sweep budget bounds LABELS WRITTEN, not rows read.

Reported as "I pressed Categorize and the same number came back". The manual
button was fine — it pages the whole mailbox. The BACKGROUND sweep was stuck:
it capped the SCAN at 100, the query is ordered newest-first, and every cycle
restarts at offset 0. A block of no-evidence mail at the top was therefore
re-read every five minutes and nothing behind it was ever reached.

Production, before the fix:

    scanned: 100, applied: 0, no_evidence: 100     16:17
    scanned: 100, applied: 0, no_evidence: 100     16:22

with 575 older messages waiting behind the wall.

The two costs are not comparable — reading a page is one indexed query, writing
a label is a provider round-trip — so they must not share a budget.
"""
from __future__ import annotations

import inspect

from gateway.routes.email.automation import cleanup as c
from gateway.routes.email import scheduler_hooks as hooks


def test_the_sweep_accepts_an_apply_cap() -> None:
    assert "max_apply" in inspect.signature(c.sweep_uncategorized).parameters


def test_the_apply_cap_defaults_to_unbounded() -> None:
    """The manual "Categorize" button must keep covering the whole mailbox — a
    cleaner that silently handles the first N and reports success is worse than
    one that refuses."""
    assert inspect.signature(
        c.sweep_uncategorized).parameters["max_apply"].default is None


def test_the_scheduler_bounds_writes_and_not_reads() -> None:
    """The regression itself. A scan cap here re-reads the same newest page
    forever; an apply cap advances through the backlog every cycle."""
    src = inspect.getsource(hooks.process_new_mail)
    assert "max_apply=100" in src, (
        "the scheduler sweep no longer bounds by labels written — if it caps "
        "the scan instead, a wall of no-evidence mail at the top of the "
        "newest-first query blocks the backlog permanently"
    )
    assert "sweep_uncategorized(account_id, 5000" in src, (
        "the scheduler's scan budget shrank back to a page-sized cap"
    )


def test_hitting_the_cap_is_reported_and_not_confused_with_finishing() -> None:
    """`exhausted` means the mailbox ran dry; `apply_capped` means there is more
    to do next cycle. Collapsing them would let the UI say "done" when it means
    "stopped"."""
    src = inspect.getsource(c.sweep_uncategorized)
    assert '"apply_capped"' in src
    assert '"exhausted"' in src


def test_the_cap_is_checked_before_reading_another_page() -> None:
    """Checking it after the page would read (and pay for) one more page than
    the budget allows on every capped run."""
    src = inspect.getsource(c.sweep_uncategorized)
    loop = src.index('while summary["scanned"] < limit:')
    page = src.index("_uncategorized_inbox(", loop)
    assert "applied >= max_apply" in src[loop:page], (
        "the apply cap is no longer checked at the top of the loop"
    )

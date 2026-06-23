"""Guards the public import surface of ``gateway.routes.email``.

The email-ingestion scheduler and the gateway app import a number of names from
this module *by name*. If a refactor (e.g. splitting the big router into
submodules) moves, renames, or drops one, the app/scheduler break at RUNTIME —
which the other unit tests don't cover. This test fails fast in CI instead, so
the email router can be refactored safely.
"""
from __future__ import annotations

import pytest

from gateway.routes import email as m

# Imported by apps/email_ingestion/email_ingestion/scheduler.py and
# apps/gateway/gateway/main.py — these MUST stay importable from
# ``gateway.routes.email`` regardless of how the module is organised internally.
SCHEDULER_AND_APP_NAMES = [
    "router",
    "_get_db",
    "_run_rules_job",
    "_ensure_subscription",
    "_maybe_send_digest",
    "_categorize_senders_job",
    "_maybe_auto_archive",
    "_maybe_classify_threads",
    "_maybe_send_follow_up_reminders",
]


@pytest.mark.parametrize("name", SCHEDULER_AND_APP_NAMES)
def test_public_name_importable(name: str) -> None:
    assert hasattr(m, name), (
        f"gateway.routes.email is missing '{name}', which the scheduler/app "
        f"import by name — a refactor likely dropped or moved it."
    )


def test_router_is_apirouter() -> None:
    from fastapi import APIRouter

    assert isinstance(m.router, APIRouter)

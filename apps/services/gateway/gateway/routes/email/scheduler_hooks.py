"""Gateway side of the post-sync hook wiring (C2 layering inversion).

Registers the email rule / categorize / classify / digest / follow-up jobs into
the ingestion scheduler's registry at app startup, so the scheduler runs them
WITHOUT importing up into the gateway. Call :func:`register_email_post_sync_hooks`
once from the gateway lifespan, before background sync starts.
"""

from __future__ import annotations

from email_ingestion.post_sync import register_post_sync_hooks
from gateway.routes.email.core import _get_db, _log


async def auto_run_rules_for_account(account_id: str) -> None:
    """Auto-run Assistant rules on newly-synced mail (opt-in per account).

    The global switch (``email_assistant_settings.auto_run``) defaults ON: a
    missing settings row is treated as enabled so a fresh account auto-runs once
    it has rules; only an explicit OFF stops it. Moved here from
    ``email_ingestion.scheduler`` as part of the layering inversion — it is
    gateway-domain logic (it needs the gateway DB helper + the rules worker).
    """
    from gateway.routes.email.automation.runner import _run_rules_job
    from sqlalchemy import text

    db = await _get_db()
    try:
        settings = (
            await db.execute(
                text(
                    "SELECT auto_run FROM email_assistant_settings "
                    "WHERE account_id = :aid"
                ),
                {"aid": account_id},
            )
        ).fetchone()
        # Global switch: explicit OFF stops auto-run; missing row → ON.
        if settings is not None and not settings.auto_run:
            return
        has_rule = (
            await db.execute(
                text(
                    "SELECT 1 FROM email_rules "
                    "WHERE account_id = :aid AND enabled = true LIMIT 1"
                ),
                {"aid": account_id},
            )
        ).fetchone()
        if not has_rule:
            return
    finally:
        await db.close()
    await _run_rules_job(account_id, 50, False, "scheduler")


def register_email_post_sync_hooks() -> None:
    """Register every email post-sync callback into the scheduler registry.

    Imports the individual jobs from their own modules (not the package
    ``__init__``) so the wiring is explicit, and lazily (inside this function)
    so importing this module during app import can't create a cycle.
    """
    from gateway.routes.email.automation.replyzero import (
        _maybe_classify_threads,
        _maybe_send_follow_up_reminders,
    )
    from gateway.routes.email.automation.senders import (
        _categorize_senders_job,
        _maybe_auto_archive,
    )
    from gateway.routes.email.digest import _maybe_send_digest
    from gateway.routes.email.transport.sync import _ensure_subscription

    async def _categorize(account_id: str) -> None:
        # The scheduler always categorised newly-seen senders in batches of 25.
        await _categorize_senders_job(account_id, 25)

    async def _follow_up(account_id: str) -> None:
        # Follow-up reminders return a small stats dict; the scheduler runs it
        # fire-and-forget, so drop the return to match the hook's () -> None shape.
        await _maybe_send_follow_up_reminders(account_id)

    register_post_sync_hooks(
        auto_run_rules=auto_run_rules_for_account,
        categorize_senders=_categorize,
        classify_threads=_maybe_classify_threads,
        auto_archive=_maybe_auto_archive,
        send_digest=_maybe_send_digest,
        send_follow_up_reminders=_follow_up,
        ensure_subscription=_ensure_subscription,
    )
    _log.info("email.post_sync_hooks_registered")

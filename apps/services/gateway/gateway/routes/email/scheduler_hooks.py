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


async def process_new_mail(account_id: str) -> None:
    """The shared new-mail pipeline (H1): auto-run rules → sweep the leftovers →
    categorize senders → classify threads (Reply Zero) → auto-archive.

    Order matters. The rules run first and are the only thing that *classifies*.
    The sweep then projects that (plus learned patterns) onto inbox mail the
    rules never reached — the rule run is capped per cycle, and mail processed
    before a rule existed is stamped ``rules_processed_at`` and never revisited,
    so without this step a real backlog stays permanently uncategorized and
    invisible to the Email Cleaner. Sender rollup runs after both so it sees the
    complete label set.

    Each step is isolated so one failure never skips the rest (same guarantee the
    scheduler loop gave when these were separate steps). Registered as the
    ``on_new_mail`` hook AND called directly by the manual-sync route + webhook,
    so new mail is processed identically however it arrived.
    """
    from gateway.routes.email.automation.cleanup import sweep_uncategorized
    from gateway.routes.email.automation.replyzero import _maybe_classify_threads
    from gateway.routes.email.automation.senders import (
        _categorize_senders_job,
        _maybe_auto_archive,
    )

    try:
        await auto_run_rules_for_account(account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("sync.auto_run_failed", account_id=account_id, error=str(exc)[:200])
    try:
        # Bounded per cycle by LABELS WRITTEN, not rows read. Each label is a
        # provider round-trip; reading a page is one indexed query.
        #
        # This used to cap the SCAN at 100. The sweep is ordered newest-first
        # and restarts at offset 0 every cycle, so a block of no-evidence mail
        # at the top was re-read forever and nothing behind it was ever reached
        # — production logged "scanned: 100, applied: 0, no_evidence: 100" every
        # five minutes with 575 older messages waiting behind the wall.
        await sweep_uncategorized(account_id, 5000, dry_run=False,
                                  owner="scheduler", max_apply=100)
    except Exception as exc:  # noqa: BLE001
        _log.warning("sync.cleanup_sweep_failed", account_id=account_id,
                     error=str(exc)[:200])
    try:
        await _categorize_senders_job(account_id, 25)
    except Exception as exc:  # noqa: BLE001
        _log.warning("sync.categorize_failed", account_id=account_id, error=str(exc)[:200])
    try:
        await _maybe_classify_threads(account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("sync.classify_threads_failed", account_id=account_id,
                     error=str(exc)[:200])
    try:
        await _maybe_auto_archive(account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("sync.auto_archive_failed", account_id=account_id,
                     error=str(exc)[:200])


async def learn_label_changes(account_id: str, changes: list) -> None:
    """Post-sync hook: learn FROM-classification patterns from the manual label
    changes the scheduler captured during persist (``(message, old_categories)``
    pairs). Runs the SAME orchestration the manual-sync route uses, so the
    background sync path — which is what actually polls every ~300s — finally
    learns from label changes instead of dropping them.
    """
    from gateway.routes.email.transport.sync import (
        learn_from_label_change_events,
    )

    db = await _get_db()
    try:
        await learn_from_label_change_events(db, account_id, changes)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.label_learn_hook_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


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
    from gateway.routes.email.digest import _maybe_send_digest
    from gateway.routes.email.transport.sync import _ensure_subscription

    async def _classify_threads(account_id: str) -> None:
        # Registered separately from process_new_mail so it runs EVERY cycle.
        # It drains a backlog of unclassified threads, so gating it on new mail
        # arriving left a quiet mailbox permanently behind.
        await _maybe_classify_threads(account_id)

    async def _follow_up(account_id: str) -> None:
        # Follow-up reminders return a small stats dict; the scheduler runs it
        # fire-and-forget, so drop the return to match the hook's () -> None shape.
        await _maybe_send_follow_up_reminders(account_id)

    register_post_sync_hooks(
        on_new_mail=process_new_mail,
        classify_threads=_classify_threads,
        send_digest=_maybe_send_digest,
        send_follow_up_reminders=_follow_up,
        ensure_subscription=_ensure_subscription,
        learn_label_changes=learn_label_changes,
    )
    _log.info("email.post_sync_hooks_registered")

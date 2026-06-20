"""Background email sync scheduler.

Periodically syncs all enabled email accounts using their configured
sync_interval_secs (default 300s).  Runs as a set of asyncio tasks managed
by the gateway lifespan.

Architecture:
- On startup: query email_accounts WHERE sync_enabled = true
- For each account: launch an asyncio task that calls _sync_account() in a loop
- On shutdown: cancel all tasks, wait for in-flight syncs to finish
- Accounts added/removed at runtime via /email accounts endpoints also
  refresh the task set via the registry pattern.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

logger = logging.getLogger(__name__)

# -- Singleton state ----------------------------------------------------------

_scheduler_tasks: dict[str, asyncio.Task] = {}  # account_id -> running task
_scheduler_lock = asyncio.Lock()
_scheduler_running = False


def _get_db_url() -> str:
    """Get the asyncpg database URL from environment."""
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        # Convert sync psycopg URL to async asyncpg if needed
        if "postgresql+psycopg" in db_url:
            db_url = db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
        elif db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        return db_url
    try:
        from acb_common.settings import get_settings
        settings = get_settings()
        raw = settings.database_url
        if "postgresql+psycopg" in raw:
            return raw.replace("postgresql+psycopg", "postgresql+asyncpg")
        if raw.startswith("postgresql://"):
            return raw.replace("postgresql://", "postgresql+asyncpg://")
        return raw
    except Exception:
        raise RuntimeError(
            "DATABASE_URL env var or Postgres settings are required "
            "for email sync scheduler"
        )


# -- Core sync logic (shared with manual /email/sync endpoint) ---------------


async def _sync_account(account_id: str) -> dict[str, Any]:
    """Run a full sync cycle for a single account.  Returns sync summary.

    This is the same logic as POST /email/sync but usable from background tasks.
    """
    db_url = _get_db_url()
    engine = create_async_engine(db_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with session_factory() as db:
        try:
            result = await db.execute(
                text(
                    """SELECT id, provider, credentials_encrypted, last_history_id,
                              sync_interval_secs
                       FROM email_accounts
                       WHERE id = :id"""
                ),
                {"id": account_id},
            )
            row = result.fetchone()
            if not row:
                return {"error": "Account not found"}

            provider_name = row.provider

            # Update sync status
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'syncing', updated_at = now()
                       WHERE id = :id"""
                ),
                {"id": account_id},
            )
            await db.commit()

            # Create sync log
            sync_log_result = await db.execute(
                text(
                    """INSERT INTO email_sync_log (account_id, started_at, status)
                       VALUES (:id, now(), 'running')
                       RETURNING id"""
                ),
                {"id": account_id},
            )
            sync_log_id = sync_log_result.fetchone().id
            await db.commit()

            # Decrypt credentials
            from acb_llm.key_store import get_key_store
            store = get_key_store()
            creds = json.loads(store.decrypt(row.credentials_encrypted))

            # Instantiate provider
            if provider_name == "gmail":
                from email_ingestion.providers.gmail import GmailProvider
                provider = GmailProvider(creds)
            elif provider_name == "microsoft":
                from email_ingestion.providers.outlook import OutlookProvider
                provider = OutlookProvider(creds)
            elif provider_name == "imap":
                from email_ingestion.providers.imap import IMAPProvider
                provider = IMAPProvider(creds)
            else:
                raise ValueError(f"Sync not supported for provider: {provider_name}")

            if not await provider.authenticate():
                raise RuntimeError("Provider authentication failed")

            sync_result = await provider.sync_messages(
                history_id=row.last_history_id,
                max_results=100,
            )

            # Persist messages
            persisted_count = 0
            for msg in sync_result.messages:
                if msg.subject == "[DELETED]":
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET folder = 'TRASH', updated_at = now()
                               WHERE account_id = :account_id
                                 AND provider_message_id = :provider_id"""
                        ),
                        {"account_id": account_id, "provider_id": msg.provider_message_id},
                    )
                    persisted_count += 1
                else:
                    await db.execute(
                        text(
                            """INSERT INTO email_messages
                               (id, account_id, provider_message_id, thread_id,
                                folder, labels, categories, importance,
                                from_address, to_addresses,
                                cc_addresses, bcc_addresses, subject,
                                body_text, body_html, snippet,
                                has_attachments, is_read, is_starred, is_flagged,
                                received_at, synced_at)
                               VALUES
                               (:id, :account_id, :provider_id, :thread_id,
                                :folder, :labels, :categories, :importance,
                                :from_addr, :to_addrs,
                                :cc_addrs, :bcc_addrs, :subject,
                                :body_text, :body_html, :snippet,
                                :has_attachments, :is_read, :is_starred, :is_flagged,
                                :received_at, now())
                               ON CONFLICT (account_id, provider_message_id)
                               DO UPDATE SET
                                thread_id = EXCLUDED.thread_id,
                                folder = EXCLUDED.folder,
                                labels = EXCLUDED.labels,
                                categories = EXCLUDED.categories,
                                importance = EXCLUDED.importance,
                                from_address = EXCLUDED.from_address,
                                to_addresses = EXCLUDED.to_addresses,
                                cc_addresses = EXCLUDED.cc_addresses,
                                bcc_addresses = EXCLUDED.bcc_addresses,
                                subject = EXCLUDED.subject,
                                body_text = EXCLUDED.body_text,
                                body_html = EXCLUDED.body_html,
                                snippet = EXCLUDED.snippet,
                                has_attachments = EXCLUDED.has_attachments,
                                is_read = EXCLUDED.is_read,
                                is_starred = EXCLUDED.is_starred,
                                is_flagged = EXCLUDED.is_flagged,
                                received_at = EXCLUDED.received_at,
                                updated_at = now()"""
                        ),
                        {
                            "id": str(uuid4()),
                            "account_id": account_id,
                            "provider_id": msg.provider_message_id,
                            "thread_id": msg.thread_id,
                            "folder": msg.folder or "INBOX",
                            "labels": msg.labels,
                            "categories": getattr(msg, "categories", []) or [],
                            "importance": getattr(msg, "importance", "normal") or "normal",
                            "from_addr": json.dumps({
                                "name": msg.from_address.name if msg.from_address else "",
                                "email": msg.from_address.email if msg.from_address else "",
                            }),
                            "to_addrs": json.dumps(
                                [{"name": a.name, "email": a.email} for a in msg.to_addresses]
                            ),
                            "cc_addrs": json.dumps(
                                [{"name": a.name, "email": a.email} for a in msg.cc_addresses]
                            ),
                            "bcc_addrs": json.dumps(
                                [{"name": a.name, "email": a.email} for a in msg.bcc_addresses]
                            ),
                            "subject": msg.subject,
                            "body_text": msg.body_text,
                            "body_html": msg.body_html,
                            "snippet": msg.snippet[:200] if msg.snippet else "",
                            "has_attachments": msg.has_attachments,
                            "is_read": msg.is_read,
                            "is_starred": msg.is_starred,
                            "is_flagged": msg.is_flagged,
                            "received_at": msg.received_at,
                        },
                    )
                    persisted_count += 1

                    # Persist attachments
                    for att in msg.attachments:
                        await db.execute(
                            text(
                                """INSERT INTO email_attachments
                                   (message_id, filename, mime_type, size_bytes,
                                    provider_attachment_id)
                                   VALUES (
                                    (SELECT id FROM email_messages
                                     WHERE account_id = :account_id
                                       AND provider_message_id = :provider_id),
                                    :filename, :mime_type, :size_bytes,
                                    :provider_attachment_id
                                   )
                                   ON CONFLICT DO NOTHING"""
                            ),
                            {
                                "account_id": account_id,
                                "provider_id": msg.provider_message_id,
                                "filename": att.filename,
                                "mime_type": att.mime_type,
                                "size_bytes": att.size_bytes,
                                "provider_attachment_id": att.provider_attachment_id,
                            },
                        )

            await db.commit()

            # Persist refreshed OAuth tokens if the provider rotated them, so the
            # next sync cycle doesn't reuse a stale (and soon-invalid) token.
            if provider.credentials_dirty():
                await db.execute(
                    text(
                        """UPDATE email_accounts
                           SET credentials_encrypted = :creds, updated_at = now()
                           WHERE id = :id"""
                    ),
                    {
                        "id": account_id,
                        "creds": store.encrypt(
                            json.dumps(provider.export_credentials())
                        ),
                    },
                )
                await db.commit()

            # Update account sync state
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'idle', last_synced_at = now(),
                           last_history_id = :history_id, sync_error = NULL,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {"id": account_id, "history_id": sync_result.new_history_id},
            )

            # Mark sync log success
            await db.execute(
                text(
                    """UPDATE email_sync_log
                       SET status = 'success', completed_at = now(),
                           messages_synced = :synced, messages_skipped = :skipped,
                           provider_history_id = :history_id
                       WHERE id = :log_id"""
                ),
                {
                    "log_id": sync_log_id,
                    "synced": persisted_count,
                    "skipped": 0,
                    "history_id": sync_result.new_history_id,
                },
            )
            await db.commit()

            logger.info(
                "sync.account_done account_id=%s provider=%s synced=%s",
                account_id, provider_name, persisted_count,
            )
            return {"synced": persisted_count, "history_id": sync_result.new_history_id}

        except Exception as exc:
            logger.warning(
                "sync.account_failed account_id=%s error=%s",
                account_id, str(exc),
            )

            # Mark account as error
            try:
                await db.execute(
                    text(
                        """UPDATE email_accounts
                           SET sync_status = 'error', sync_error = :error,
                               updated_at = now()
                           WHERE id = :id"""
                    ),
                    {"id": account_id, "error": str(exc)},
                )
                await db.execute(
                    text(
                        """UPDATE email_sync_log
                           SET status = 'error', completed_at = now(),
                               error_message = :error
                           WHERE id = :log_id"""
                    ),
                    {"log_id": sync_log_id, "error": str(exc)},
                )
                await db.commit()
            except Exception:
                pass

            return {"error": str(exc)}

    await engine.dispose()


# -- Per-account sync loop ----------------------------------------------------


async def _account_sync_loop(account_id: str, interval_secs: int) -> None:
    """Run sync in a loop for a single account forever."""
    logger.info(
        "sync.loop_started account_id=%s interval=%s",
        account_id, interval_secs,
    )
    while True:
        try:
            await _sync_account(account_id)
        except Exception as exc:
            logger.warning(
                "sync.loop_iteration_failed account_id=%s error=%s",
                account_id, str(exc),
            )

        # Re-read interval in case it was changed via PATCH
        try:
            current_interval = await _get_account_sync_interval(account_id)
            if current_interval:
                interval_secs = current_interval
        except Exception:
            pass

        await asyncio.sleep(interval_secs)


async def _get_account_sync_interval(account_id: str) -> int | None:
    """Read the current sync_interval_secs for an account."""
    db_url = _get_db_url()
    engine = create_async_engine(db_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as db:
            result = await db.execute(
                text("SELECT sync_interval_secs FROM email_accounts WHERE id = :id"),
                {"id": account_id},
            )
            row = result.fetchone()
            return row.sync_interval_secs if row else None
    finally:
        await engine.dispose()


# -- Scheduler lifecycle ------------------------------------------------------


async def start_background_sync() -> dict[str, int]:
    """Start background sync for all enabled email accounts.

    Called from the gateway lifespan on startup.  Returns {account_id: interval_secs}
    for all launched sync loops.
    """
    global _scheduler_running

    async with _scheduler_lock:
        if _scheduler_running:
            logger.info("sync.scheduler_already_running")
            return {}

        db_url = _get_db_url()
        engine = create_async_engine(db_url, echo=False)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)

        try:
            async with session_factory() as db:
                result = await db.execute(
                    text(
                        """SELECT id, sync_interval_secs
                           FROM email_accounts
                           WHERE sync_enabled = true"""
                    )
                )
                accounts = [(row.id, row.sync_interval_secs) for row in result.fetchall()]
        finally:
            await engine.dispose()

        launched: dict[str, int] = {}
        for account_id, interval in accounts:
            interval = interval or 300
            task = asyncio.create_task(_account_sync_loop(account_id, interval))
            _scheduler_tasks[account_id] = task
            launched[account_id] = interval

        _scheduler_running = True
        logger.info("sync.scheduler_started accounts=%s", len(launched))
        return launched


async def stop_background_sync() -> None:
    """Stop all background sync tasks gracefully.

    Called from the gateway lifespan on shutdown.
    """
    global _scheduler_running

    async with _scheduler_lock:
        _scheduler_running = False
        tasks = list(_scheduler_tasks.values())
        _scheduler_tasks.clear()

        for task in tasks:
            task.cancel()

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        logger.info("sync.scheduler_stopped tasks_cancelled=%s", len(tasks))


async def refresh_account_sync(account_id: str) -> None:
    """Start or restart the sync loop for a single account.

    Call this after creating a new account or toggling sync_enabled on.
    """
    async with _scheduler_lock:
        # Cancel existing task if any
        existing = _scheduler_tasks.pop(account_id, None)
        if existing:
            existing.cancel()
            try:
                await existing
            except asyncio.CancelledError:
                pass

        # Read current config
        interval = await _get_account_sync_interval(account_id)
        if interval is None:
            logger.warning(
                "sync.refresh_account_not_found account_id=%s", account_id
            )
            return

        task = asyncio.create_task(_account_sync_loop(account_id, interval))
        _scheduler_tasks[account_id] = task
        logger.info(
            "sync.loop_refreshed account_id=%s interval=%s",
            account_id, interval,
        )


async def remove_account_sync(account_id: str) -> None:
    """Stop the sync loop for a single account.

    Call this after deleting an account or toggling sync_enabled off.
    """
    async with _scheduler_lock:
        task = _scheduler_tasks.pop(account_id, None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.info("sync.loop_removed account_id=%s", account_id)


def get_scheduler_status() -> dict[str, Any]:
    """Return current scheduler state (for health checks / debug)."""
    return {
        "running": _scheduler_running,
        "accounts": list(_scheduler_tasks.keys()),
        "count": len(_scheduler_tasks),
    }

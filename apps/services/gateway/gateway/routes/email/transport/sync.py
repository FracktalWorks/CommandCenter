"""Transport · sync — manual/initial sync, resync, and the Microsoft Graph
webhook + change-subscription lifecycle."""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from acb_common import get_settings
from fastapi import BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from gateway.routes.email.core import (
    MAX_BODY_HTML_BYTES,
    MAX_BODY_TEXT_BYTES,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    _truncate_body,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


# Deep initial-sync history window (days); keep in step with the scheduler.
INITIAL_SYNC_DAYS = 365


async def _build_label_rule_map(
    db: Any, account_id: str,
) -> tuple[dict[str, str], dict[str, str]]:
    """Returns ``(label_rule_map, conv_rule_keys)``.

    ``label_rule_map``: category-name (lower) → rule_id, from each enabled rule's
    name and its LABEL action labels — so a manually-applied category can be
    traced to a rule. ``conv_rule_keys``: rule_id → conversation-status key
    (REPLY / AWAITING_REPLY / FYI / DONE) for the reply-status rules, so
    the learner can treat those differently from sender-stable cleanup rules."""
    try:
        from gateway.routes.email.automation.engine import (  # noqa: PLC0415
            _conversation_rule_key,
        )
        from gateway.routes.email.automation.rules import (  # noqa: PLC0415
            _load_rules,
        )
        rules = await _load_rules(db, account_id)
    except Exception:  # noqa: BLE001
        return {}, {}
    out: dict[str, str] = {}
    conv: dict[str, str] = {}
    for r in rules:
        if not r.get("enabled"):
            continue
        rid = str(r.get("id"))
        ck = _conversation_rule_key(r)
        if ck:
            conv[rid] = ck
        nm = (r.get("name") or "").strip().lower()
        if nm:
            out.setdefault(nm, rid)
        for a in r.get("actions", []) or []:
            label = (a.get("label") or "").strip()
            if a.get("type") == "LABEL" and label:
                out.setdefault(label.lower(), rid)
    return out, conv


async def _learn_from_label_changes(
    db: Any, account_id: str, msg: Any,
    old_categories: list, new_categories: list, label_rule_map: dict[str, str],
    conv_rule_keys: dict[str, str], status_corrections: dict[str, str],
) -> None:
    """When the user adds/removes a label (category) in their email client, learn
    a FROM include/exclude classification pattern for the matching rule —
    inbox-zero's LABEL_ADDED / LABEL_REMOVED learning. Best-effort.

    Our own rule-applied labels are written to local categories synchronously, so
    a sync delta here reflects only changes the *user* made in their client.

    Conversation-status rules (Reply / Awaiting / FYI / Done) are NEVER
    sender-pinned: a person's mail flows between those states per-thread, so a
    learned FROM pattern would be both wrong ("always reply to X") and futile
    (status is re-derived from the full thread and overrides it). This mirrors the
    guard the Fix and auto-learn paths already apply. Instead, a manually-ADDED
    conversation label is recorded in ``status_corrections`` (thread → status) so
    the caller can set the thread status directly — the only correction that
    sticks — exactly as the Fix flow does. A removed conversation label carries no
    unambiguous target status, so it's simply ignored (never pins, never guesses)."""
    sender = ""
    if getattr(msg, "from_address", None):
        sender = (msg.from_address.email or "").strip()
    if not label_rule_map:
        return
    old_s = {str(c).strip().lower() for c in (old_categories or [])}
    new_s = {str(c).strip().lower() for c in (new_categories or [])}
    added, removed = new_s - old_s, old_s - new_s
    if not added and not removed:
        return
    try:
        from gateway.routes.email.automation.rules import (  # noqa: PLC0415
            _upsert_rule_pattern,
        )
    except Exception:  # noqa: BLE001
        return
    tid = getattr(msg, "thread_id", None)
    for cat, exclude, src, why in (
        *[(c, False, "LABEL_ADDED", "Label added in the mail client")
          for c in added],
        *[(c, True, "LABEL_REMOVED", "Label removed in the mail client")
          for c in removed],
    ):
        rid = label_rule_map.get(cat)
        if not rid:
            continue
        conv_key = conv_rule_keys.get(rid)
        if conv_key:
            # Reply-status rule: set the thread status directly on an ADD; never
            # learn a sender pattern (and skip an ambiguous removal entirely).
            if not exclude and tid:
                status_corrections[tid] = conv_key
            continue
        if not sender:
            continue
        try:
            await _upsert_rule_pattern(
                db, account_id, rid, sender, exclude, src, why, None, tid,
                pattern_type="FROM")
        except Exception:  # noqa: BLE001
            pass


async def _apply_label_status_corrections(
    account_id: str, corrections: dict[str, str],
) -> None:
    """Apply the reply-status corrections the label learner queued (a user who
    manually added a conversation label — Reply / Awaiting / FYI / Done —
    in their client). Each opens its own DB connection and swaps provider labels,
    so this runs AFTER the sync's persistence commit, deduped by thread.
    Best-effort — a failed correction never fails the sync."""
    if not corrections:
        return
    from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
        apply_thread_status_correction,
    )
    for tid, key in corrections.items():
        try:
            await apply_thread_status_correction(account_id, tid, key)
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.label_status_correction_failed",
                         account_id=account_id, error=str(exc)[:160])


class SyncRequest(BaseModel):
    account_id: str
    # Force a deep re-sync (≈1 year, all folders) even if the initial sync
    # already ran — e.g. a manual "resync everything" from the UI.
    full: bool = False


@router.post("/sync")
async def trigger_sync(
    req: SyncRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Trigger a manual email sync for an account.

    Calls the email provider's incremental sync and persists new/updated
    messages to the email_messages table.  Deleted messages are moved to
    TRASH folder locally.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT id, provider, credentials_encrypted, last_history_id,
                          initial_sync_done
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": req.account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Update sync status to 'syncing'
        await db.execute(
            text(
                """UPDATE email_accounts
                   SET sync_status = 'syncing', updated_at = now()
                   WHERE id = :id"""
            ),
            {"id": req.account_id},
        )
        await db.commit()

        # Create sync log entry
        sync_log_result = await db.execute(
            text(
                """INSERT INTO email_sync_log (account_id, started_at, status)
                   VALUES (:id, now(), 'running')
                   RETURNING id"""
            ),
            {"id": req.account_id},
        )
        sync_log_id = sync_log_result.fetchone().id
        await db.commit()

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        provider = _instantiate_provider(row.provider, creds)

        try:
            if not await provider.authenticate():
                raise HTTPException(status_code=401, detail="Auth failed")

            # Deep 1-year backfill on first sync (or when forced via ?full);
            # otherwise a cheap shallow/incremental sync.
            deep = req.full or not bool(getattr(row, "initial_sync_done", False))
            since = (
                datetime.now(timezone.utc) - timedelta(days=INITIAL_SYNC_DAYS)
                if deep else None
            )
            sync_result = await provider.sync_messages(
                history_id=row.last_history_id,
                max_results=100,
                deep=deep,
                since=since,
            )

            # Persist fetched messages to email_messages.
            # Learn classification patterns from manual label changes — only on
            # incremental syncs (a deep/full sync replays history and would
            # mislearn). Empty map (no rules) disables the per-message diff.
            label_rule_map, conv_rule_keys = (
                await _build_label_rule_map(db, req.account_id)
                if not deep else ({}, {})
            )
            # thread_id → conversation-status key for reply labels the user added
            # in their client this sync; applied after the loop (see below).
            status_corrections: dict[str, str] = {}
            persisted_count = 0
            skipped_count = 0
            for msg in sync_result.messages:
                if msg.subject == "[DELETED]":
                    # Message was deleted on provider — move to TRASH locally
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET folder = 'TRASH', updated_at = now()
                               WHERE account_id = :account_id
                                 AND provider_message_id = :provider_id"""
                        ),
                        {
                            "account_id": req.account_id,
                            "provider_id": msg.provider_message_id,
                        },
                    )
                    persisted_count += 1
                else:
                    # Capture categories before the upsert so we can learn from
                    # manual label changes made in the user's email client.
                    old_categories = None
                    if label_rule_map:
                        ocr = (await db.execute(text(
                            "SELECT categories FROM email_messages WHERE "
                            "account_id = :aid AND provider_message_id = :pid"
                        ), {"aid": req.account_id,
                            "pid": msg.provider_message_id})).fetchone()
                        old_categories = (
                            list(ocr.categories or []) if ocr else None)
                    # Upsert message
                    await db.execute(
                        text(
                            """INSERT INTO email_messages
                               (id, account_id, provider_message_id, thread_id,
                                folder, labels, categories, importance,
                                from_address, to_addresses,
                                cc_addresses, bcc_addresses, subject,
                                body_text, body_html, snippet,
                                has_attachments, is_read, is_starred, is_flagged,
                                unsubscribe_link, received_at, synced_at)
                               VALUES
                               (:id, :account_id, :provider_id, :thread_id,
                                :folder, :labels, :categories, :importance,
                                :from_addr, :to_addrs,
                                :cc_addrs, :bcc_addrs, :subject,
                                :body_text, :body_html, :snippet,
                                :has_attachments, :is_read, :is_starred, :is_flagged,
                                :unsubscribe_link, :received_at, now())
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
                                -- Never clobber a stored body/snippet with an
                                -- empty one. Providers that list headers-only
                                -- (Outlook) re-sync with an empty body_text; a
                                -- plain EXCLUDED overwrite wiped a body the user
                                -- had already lazily hydrated, so the reading
                                -- pane fell back to the snippet on every refresh.
                                -- Matches core._upsert_message + the scheduler.
                                body_text = COALESCE(
                                    NULLIF(EXCLUDED.body_text, ''),
                                    email_messages.body_text),
                                body_html = COALESCE(
                                    NULLIF(EXCLUDED.body_html, ''),
                                    email_messages.body_html),
                                snippet = COALESCE(
                                    NULLIF(EXCLUDED.snippet, ''),
                                    email_messages.snippet),
                                has_attachments = EXCLUDED.has_attachments,
                                is_read = EXCLUDED.is_read,
                                is_starred = EXCLUDED.is_starred,
                                is_flagged = EXCLUDED.is_flagged,
                                unsubscribe_link = COALESCE(
                                    EXCLUDED.unsubscribe_link,
                                    email_messages.unsubscribe_link),
                                received_at = EXCLUDED.received_at,
                                updated_at = now()"""
                        ),
                        {
                            "id": str(uuid4()),
                            "account_id": req.account_id,
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
                            "to_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.to_addresses
                            ]),
                            "cc_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.cc_addresses
                            ]),
                            "bcc_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.bcc_addresses
                            ]),
                            "subject": msg.subject,
                            "body_text": _truncate_body(msg.body_text, MAX_BODY_TEXT_BYTES),
                            "body_html": _truncate_body(
                                msg.body_html, MAX_BODY_HTML_BYTES
                            ) if msg.body_html else None,
                                            "snippet": msg.snippet[:200] if msg.snippet else "",
                            "has_attachments": msg.has_attachments,
                            "is_read": msg.is_read,
                            "is_starred": msg.is_starred,
                            "is_flagged": msg.is_flagged,
                            "unsubscribe_link": getattr(
                                msg, "unsubscribe_link", None),
                            "received_at": msg.received_at,
                        },
                    )
                    persisted_count += 1

                    # Learn from manual label add/remove (existing rows only —
                    # a new message has no prior categories to diff against).
                    if old_categories is not None:
                        await _learn_from_label_changes(
                            db, req.account_id, msg, old_categories,
                            getattr(msg, "categories", []) or [], label_rule_map,
                            conv_rule_keys, status_corrections)

                    # Persist attachment metadata
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
                                "account_id": req.account_id,
                                "provider_id": msg.provider_message_id,
                                "filename": att.filename,
                                "mime_type": att.mime_type,
                                "size_bytes": att.size_bytes,
                                "provider_attachment_id": att.provider_attachment_id,
                            },
                        )

            await db.commit()

            # Apply reply-status corrections the label learner queued (a user who
            # manually added "Reply"/"Awaiting"/… in their client) — after the
            # persistence commit, not nested in the per-message loop.
            await _apply_label_status_corrections(
                req.account_id, status_corrections)

            # Reconcile provider-side deletions on a full snapshot (Outlook).
            try:
                from email_ingestion.reconcile import reconcile_full_snapshot
                removed = await reconcile_full_snapshot(
                    db, req.account_id, sync_result
                )
                if removed:
                    await db.commit()
                    _log.info("email.sync_reconciled", account_id=req.account_id,
                              removed=removed)
            except Exception as exc:  # noqa: BLE001
                _log.warning("email.sync_reconcile_failed",
                             account_id=req.account_id, error=str(exc)[:160])

            # Persist refreshed OAuth tokens (access/refresh) if the provider
            # rotated them during this sync, so the next sync doesn't reuse a
            # stale token.
            if provider.credentials_dirty():
                await db.execute(
                    text(
                        """UPDATE email_accounts
                           SET credentials_encrypted = :creds, updated_at = now()
                           WHERE id = :id"""
                    ),
                    {
                        "id": req.account_id,
                        "creds": store.encrypt(
                            json.dumps(provider.export_credentials())
                        ),
                    },
                )

            # Update account sync state. Mark the one-time deep sync done so
            # subsequent polls stay shallow.
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'idle',
                           last_synced_at = now(),
                           last_history_id = :history_id,
                           sync_error = NULL,
                           initial_sync_done = initial_sync_done OR :deep,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {
                    "id": req.account_id,
                    "history_id": sync_result.new_history_id,
                    "deep": deep,
                },
            )

            # Mark sync log as success
            await db.execute(
                text(
                    """UPDATE email_sync_log
                       SET status = 'success',
                           completed_at = now(),
                           messages_synced = :synced,
                           messages_skipped = :skipped,
                           provider_history_id = :history_id
                       WHERE id = :log_id"""
                ),
                {
                    "log_id": sync_log_id,
                    "synced": persisted_count,
                    "skipped": skipped_count,
                    "history_id": sync_result.new_history_id,
                },
            )
            await db.commit()

            # Process newly-synced mail through the shared pipeline (auto-run
            # rules → categorize → classify threads → auto-archive) AFTER the
            # response is sent, so the manual sync stays fast but new mail still
            # gets rules/labels/archive applied and its Reply-Zero status
            # recomputed — the SAME pipeline the scheduler + Graph webhook run
            # (H1). Previously a UI-triggered sync only re-classified thread
            # status inline, so new mail showed up unlabeled/un-archived until the
            # next background poll (up to sync_interval_secs later) — that gap.
            if persisted_count:
                from gateway.routes.email.scheduler_hooks import process_new_mail
                background.add_task(process_new_mail, req.account_id)

            return {
                "ok": True,
                "messages_synced": persisted_count,
                "messages_skipped": skipped_count,
            }
        except Exception as e:
            # Update account to error state
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'error',
                           sync_error = :error,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {"id": req.account_id, "error": str(e)},
            )
            # Mark sync log as error
            await db.execute(
                text(
                    """UPDATE email_sync_log
                       SET status = 'error',
                           completed_at = now(),
                           error_message = :error
                       WHERE id = :log_id"""
                ),
                {"log_id": sync_log_id, "error": str(e)},
            )
            await db.commit()
            raise HTTPException(
                status_code=500,
                detail=f"Sync failed: {e}"
            )
    finally:
        await db.close()


@router.post("/accounts/{account_id}/resync")
async def resync_account(
    account_id: str,
    purge: bool = Query(False),
    user: UserContext = Depends(get_current_user),
):
    """Force a COMPLETE, DEEP re-sync from the provider (not just an incremental
    sync).

    Resets the sync cursor and re-fetches every folder with the one-year deep
    backfill (``full=True``), overwriting stale local fields. This is the only
    UI path that re-runs the deep backfill on an account whose
    ``initial_sync_done`` is already set (the recurring poll and a plain sync
    stay shallow), so it's how an account connected before deep-sync shipped
    pulls its full history. With ``purge=true`` it first DELETES the account's
    local messages (cascades attachments) before re-fetching — use this when
    local data is corrupt or badly out of sync. Returns the sync result."""
    db = await _get_db()
    try:
        own = (await db.execute(text(
            "SELECT id FROM email_accounts WHERE id = :id AND user_id = :uid"
        ), {"id": account_id, "uid": user.email or "anonymous"})).fetchone()
        if not own:
            raise HTTPException(status_code=404, detail="Account not found")
        if purge:
            await db.execute(text(
                "DELETE FROM email_messages WHERE account_id = :id"
            ), {"id": account_id})
        # Reset the cursor so the provider does a full sweep (defensive — sync is
        # full-sweep regardless, but this also clears any stale delta token).
        await db.execute(text(
            "UPDATE email_accounts SET last_history_id = NULL, updated_at = now() "
            "WHERE id = :id"
        ), {"id": account_id})
        await db.commit()
    finally:
        await db.close()
    # Re-fetch from the provider via the standard sync path, forcing the DEEP
    # (≈1-year, all-folder) backfill — ``full=True`` overrides the
    # ``initial_sync_done`` gate so an already-initialised account actually pulls
    # its older mail instead of just the newest shallow page.
    result = await trigger_sync(SyncRequest(account_id=account_id, full=True), user)
    synced = result.get("messages_synced") if isinstance(result, dict) else None
    return {"resynced": True, "purged": purge, "messages_synced": synced}


async def _webhook_sync(account_id: str) -> None:
    """Triggered by a Graph notification: incremental sync, then the shared
    new-mail pipeline (auto-run rules → categorize → classify → auto-archive) —
    the same pipeline the scheduler and manual sync use, so push-delivered mail
    is processed identically."""
    try:
        from email_ingestion.scheduler import _sync_account  # noqa: PLC0415
        from gateway.routes.email.scheduler_hooks import process_new_mail
        res = await _sync_account(account_id)
        if isinstance(res, dict) and res.get("synced", 0):
            await process_new_mail(account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.webhook_sync_failed", account_id=account_id,
                     error=str(exc)[:200])


@router.api_route("/webhook/microsoft", methods=["GET", "POST"])
async def microsoft_webhook(request: Request, background: BackgroundTasks):
    """Public Microsoft Graph change-notification endpoint (no auth).

    Handles the validation handshake (echo validationToken) and incoming
    notifications (validate clientState → background incremental sync)."""
    token = request.query_params.get("validationToken")
    if token:
        return PlainTextResponse(content=token, status_code=200)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return PlainTextResponse("", status_code=202)
    notifications = body.get("value", []) if isinstance(body, dict) else []
    affected: set[str] = set()
    for n in notifications:
        if not isinstance(n, dict):
            continue
        sub_id = n.get("subscriptionId")
        client_state = n.get("clientState")
        if not sub_id:
            continue
        db = await _get_db()
        try:
            row = (await db.execute(text(
                "SELECT id, webhook_client_state FROM email_accounts "
                "WHERE webhook_subscription_id = :sid"
            ), {"sid": sub_id})).fetchone()
        finally:
            await db.close()
        if not row:
            continue
        if row.webhook_client_state and client_state != row.webhook_client_state:
            _log.warning("email.webhook_bad_client_state", sub=str(sub_id)[:12])
            continue
        affected.add(str(row.id))
    for aid in affected:
        background.add_task(_webhook_sync, aid)
    return PlainTextResponse("", status_code=202)


async def _ensure_subscription(account_id: str) -> None:
    """Create or renew the account's Graph push subscription (Microsoft only)."""
    public = (
        os.environ.get("GATEWAY_PUBLIC_URL", "")
        or getattr(get_settings(), "gateway_public_url", "")
    ).rstrip("/")
    if not public:
        return
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT provider, credentials_encrypted, webhook_subscription_id,
                      webhook_client_state, webhook_expires_at
               FROM email_accounts WHERE id = :id"""
        ), {"id": account_id})).fetchone()
        if not row or row.provider != "microsoft":
            return
        now = datetime.now(timezone.utc)
        if (row.webhook_subscription_id and row.webhook_expires_at
                and row.webhook_expires_at > now + timedelta(hours=12)):
            return  # still valid, not expiring soon

        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider("microsoft", creds)
        if not await provider.authenticate():
            return
        notify_url = f"{public}/email/webhook/microsoft"
        client_state = row.webhook_client_state or secrets.token_urlsafe(24)

        data = None
        sub_id = row.webhook_subscription_id
        if sub_id:
            try:
                data = await provider.renew_subscription(sub_id)
            except Exception:  # noqa: BLE001
                data = None
        if data is None:
            data = await provider.create_subscription(notify_url, client_state)
            sub_id = data.get("id")
        # Graph returns expirationDateTime as an ISO string; asyncpg needs a
        # real datetime for the TIMESTAMPTZ column.
        exp_raw = data.get("expirationDateTime")
        exp_dt = None
        if exp_raw:
            try:
                exp_dt = datetime.fromisoformat(
                    str(exp_raw).replace("Z", "+00:00")
                )
            except Exception:  # noqa: BLE001
                exp_dt = None
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.execute(text(
            """UPDATE email_accounts
               SET webhook_subscription_id = :sid, webhook_client_state = :cs,
                   webhook_expires_at = :exp, updated_at = now()
               WHERE id = :id"""
        ), {"id": account_id, "sid": sub_id, "cs": client_state, "exp": exp_dt})
        await db.commit()
        _log.info("email.subscription_ready", account_id=account_id,
                  sub=str(sub_id)[:12], expires=exp_raw)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.subscription_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()

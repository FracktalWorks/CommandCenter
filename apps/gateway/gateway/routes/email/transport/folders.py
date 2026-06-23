"""Transport · folders & labels — folder/label listing and per-folder backfill."""

from __future__ import annotations

import json

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.email.core import (
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    _upsert_message,
    router,
)
from pydantic import BaseModel, Field
from sqlalchemy import text


class BackfillRequest(BaseModel):
    folder: str = "inbox"
    page_token: str | None = None
    max_pages: int = Field(default=3, ge=1, le=10)


class CreateFolderRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class EmailFolderModel(BaseModel):
    provider_folder_id: str
    name: str
    type: str = "system"  # 'system' | 'user'
    message_count: int = 0
    unread_count: int = 0


@router.get("/accounts/{account_id}/folders", response_model=list[EmailFolderModel])
async def list_folders(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """List folders/labels for a connected email account.

    Fetches live from the provider (Gmail labels, Outlook folders, IMAP mailboxes)
    so the UI always shows the current folder structure.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider: {row.provider}",
            )

        # Authenticate and fetch folders
        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — token may have expired",
            )

        folders = await provider.list_folders()

        # Persist rotated OAuth tokens so a later sync doesn't reuse a stale one.
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

        return [
            EmailFolderModel(
                provider_folder_id=f.provider_folder_id,
                name=f.name,
                type=f.type,
                message_count=f.message_count,
                unread_count=f.unread_count,
            )
            for f in folders
        ]
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("list_folders.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list folders: {str(exc)}",
        )
    finally:
        await db.close()


@router.post(
    "/accounts/{account_id}/folders", response_model=EmailFolderModel
)
async def create_folder(
    account_id: str,
    req: CreateFolderRequest,
    user: UserContext = Depends(get_current_user),
):
    """Create (or reuse) a folder/label on the connected account and persist it.

    Backs the rule editor's "Create new folder" affordance.  Idempotent — the
    provider returns the existing folder if one with the same name already
    exists (Outlook get-or-create, Gmail label create).
    """
    db = await _get_db()
    try:
        row = (await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — reconnect.",
            )

        try:
            folder = await provider.create_folder(req.name)
        except NotImplementedError:
            raise HTTPException(
                status_code=400,
                detail="This account type doesn't support creating folders.",
            )

        # Mirror into email_folders so the folder is queryable immediately.
        await db.execute(
            text(
                """INSERT INTO email_folders
                     (account_id, provider_folder_id, name, type)
                   VALUES (:aid, :pid, :name, :type)
                   ON CONFLICT (account_id, provider_folder_id)
                   DO UPDATE SET name = EXCLUDED.name"""
            ),
            {"aid": account_id, "pid": folder.provider_folder_id,
             "name": folder.name, "type": folder.type},
        )
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()

        return EmailFolderModel(
            provider_folder_id=folder.provider_folder_id,
            name=folder.name,
            type=folder.type,
            message_count=folder.message_count,
            unread_count=folder.unread_count,
        )
    except HTTPException:
        raise
    except Exception as exc:
        _log.error(
            "create_folder.failed", account_id=account_id, error=str(exc)[:200]
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to create folder: {str(exc)}"
        )
    finally:
        await db.close()


@router.get("/accounts/{account_id}/labels", response_model=list[str])
async def list_labels(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """List user-applicable label/category names for an account.

    Gmail = user labels, Outlook = master categories, IMAP = none.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            return []

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — reconnect.",
            )
        labels = await provider.list_labels()

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
        return labels
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("list_labels.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail=f"Failed to list labels: {exc}")
    finally:
        await db.close()


@router.post("/accounts/{account_id}/backfill")
async def backfill_folder(
    account_id: str,
    req: BackfillRequest,
    user: UserContext = Depends(get_current_user),
):
    """Fetch OLDER messages for a folder from the provider and persist them.

    The list view is DB-backed and the initial sync only grabs the newest
    ~100 per folder, so this pages further back through the provider's history
    on demand.  Returns the next page token so the client can keep loading
    older mail until ``exhausted`` is true.
    """
    from email_ingestion.providers.base import canonical_folder

    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400, detail=f"Unknown provider: {row.provider}"
            )

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — reconnect.",
            )

        canon_req = canonical_folder(req.folder)

        # Resolve the provider-native folder id/label for the canonical key so
        # both system and user folders page correctly (Gmail label id, Graph
        # folder id, IMAP mailbox name).
        provider_folder = req.folder
        try:
            for f in await provider.list_folders():
                if canonical_folder(f.name) == canon_req:
                    provider_folder = f.provider_folder_id
                    break
        except Exception:
            pass

        token = req.page_token
        synced = 0
        for _ in range(req.max_pages):
            msgs, token = await provider.list_messages(
                folder=provider_folder,
                max_results=100,
                page_token=token,
                canonical_override=canon_req,
            )
            for msg in msgs:
                await _upsert_message(db, account_id, msg)
                synced += 1
            if not token:
                break
        await db.commit()

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

        return {
            "synced": synced,
            "next_page_token": token,
            "exhausted": token is None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("backfill.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail=f"Backfill failed: {str(exc)}")
    finally:
        await db.close()

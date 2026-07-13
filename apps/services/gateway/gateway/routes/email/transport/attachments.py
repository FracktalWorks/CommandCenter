"""Transport · attachments — attachment download and the sandboxed image proxy."""

from __future__ import annotations

import asyncio
import io
import ipaddress
import json
import socket
from urllib.parse import urlparse

import httpx
from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from gateway.routes.email.core import ATTACHMENT_CACHE_TTL_SECS, _get_db, _get_redis, _log, router
from sqlalchemy import text

MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024  # 15 MB


def _resolve_is_public(host: str) -> bool:
    """True only if every A/AAAA record for host is a public, routable IP.

    Blocks SSRF to loopback/private/link-local/metadata endpoints.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return False
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        ):
            return False
    return True


@router.get("/image-proxy")
async def image_proxy(
    url: str = Query(..., max_length=4096),
    user: UserContext = Depends(get_current_user),
):
    """Fetch a remote email image server-side and stream it back.

    Lets the reading pane show images without the sender's tracking pixel
    seeing the *user's* IP — only the gateway's IP is exposed.  Guarded
    against SSRF (scheme + private-IP checks) and size-capped.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid image URL")
    if not await asyncio.to_thread(_resolve_is_public, parsed.hostname):
        raise HTTPException(status_code=400, detail="Blocked image host")

    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15.0, max_redirects=3
        ) as client:
            resp = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (CommandCenter image proxy)",
                    "Accept": "image/*",
                },
            )
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                raise HTTPException(status_code=415, detail="Not an image")
            content = resp.content
            if len(content) > MAX_PROXY_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image too large")
            return StreamingResponse(
                io.BytesIO(content),
                media_type=content_type,
                headers={
                    "Content-Length": str(len(content)),
                    "Cache-Control": "private, max-age=3600",
                },
            )
    except HTTPException:
        raise
    except Exception as exc:
        _log.warning("image_proxy.failed", error=str(exc)[:200])
        raise HTTPException(status_code=502, detail="Failed to fetch image")


@router.get("/attachments/{attachment_id}/download")
async def download_attachment(
    attachment_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Proxy download an email attachment, streaming from the provider.

    Checks Redis cache first (TTL 1 hour) to avoid redundant provider API
    calls for attachments downloaded multiple times.
    """
    # ── Check Redis cache first ──
    redis = await _get_redis()
    if redis:
        try:
            cache_key = f"email:att:cache:{attachment_id}"
            cached = await redis.get(cache_key)
            if cached:
                return StreamingResponse(
                    io.BytesIO(cached),
                    media_type="application/octet-stream",
                    headers={
                        "Content-Disposition": (
                            f'attachment; filename="cached"'
                        ),
                        "Content-Length": str(len(cached)),
                        "X-Cache": "HIT",
                    },
                )
        except Exception:
            redis = None  # fall through to provider fetch

    db = await _get_db()
    try:
        # Look up attachment and verify user owns the parent message
        result = await db.execute(
            text(
                """SELECT ea.id, ea.filename, ea.mime_type, ea.size_bytes,
                          ea.provider_attachment_id, ea.storage_path,
                          em.provider_message_id, p.provider, p.credentials_encrypted
                   FROM email_attachments ea
                   JOIN email_messages em ON ea.message_id = em.id
                   JOIN email_accounts p ON em.account_id = p.id
                   WHERE ea.id = :aid AND p.user_id = :user_id"""
            ),
            {"aid": attachment_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found")

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

        content = await provider.get_attachment(
            row.provider_message_id, row.provider_attachment_id
        )

        # ── Store in Redis cache ──
        if redis and content:
            try:
                cache_key = f"email:att:cache:{attachment_id}"
                await redis.setex(
                    cache_key, ATTACHMENT_CACHE_TTL_SECS, content
                )
            except Exception:
                pass

        return StreamingResponse(
            io.BytesIO(content),
            media_type=row.mime_type,
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{row.filename}"'
                ),
                "Content-Length": str(len(content)),
                "X-Cache": "MISS",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("download_attachment.failed", aid=attachment_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail="Failed to download attachment")
    finally:
        await db.close()

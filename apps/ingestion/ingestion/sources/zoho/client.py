"""Async Zoho CRM client. OAuth refresh-token flow with disk cache.

Auth env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN,
ZOHO_API_DOMAIN (default zohoapis.com), ZOHO_ACCOUNTS_URL (default accounts.zoho.com).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from acb_common import get_settings

_TOKEN_CACHE = Path(".zoho_token_cache.json")


def _read_cache() -> str | None:
    if not _TOKEN_CACHE.exists():
        return None
    try:
        data = json.loads(_TOKEN_CACHE.read_text(encoding="utf-8"))
        expires = datetime.fromisoformat(data["expires_at"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) < expires - timedelta(minutes=5):
            return str(data["access_token"])
    except Exception:
        return None
    return None


def _write_cache(token: str, expires_in: int) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in - 60)
    _TOKEN_CACHE.write_text(
        json.dumps(
            {
                "access_token": token,
                "expires_at": expires_at.isoformat(),
                "cached_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


async def get_access_token() -> str:
    cached = _read_cache()
    if cached:
        return cached
    s = get_settings()
    if not (s.zoho_client_id and s.zoho_client_secret and s.zoho_refresh_token):
        raise RuntimeError("Zoho credentials missing in env")
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.post(
            f"{s.zoho_accounts_url}/oauth/v2/token",
            params={
                "refresh_token": s.zoho_refresh_token,
                "client_id": s.zoho_client_id,
                "client_secret": s.zoho_client_secret,
                "grant_type": "refresh_token",
            },
        )
        r.raise_for_status()
        data = r.json()
    if "access_token" not in data:
        raise RuntimeError(f"Zoho token refresh failed: {data}")
    _write_cache(data["access_token"], int(data.get("expires_in", 3600)))
    return str(data["access_token"])


async def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Zoho-oauthtoken {await get_access_token()}",
        "Content-Type": "application/json",
    }


async def _list_module(
    module: str,
    *,
    per_page: int = 200,
    modified_since: "datetime | None" = None,
) -> list[dict[str, Any]]:
    """Paginated GET of a Zoho module.

    When ``modified_since`` is provided, sends the ``If-Modified-Since`` header
    Zoho honours on Accounts/Deals/Contacts to return only records changed
    after that timestamp — the basis of incremental sync (WBS 1.1).
    """
    s = get_settings()
    out: list[dict[str, Any]] = []
    page = 1
    headers = await _headers()
    if modified_since is not None:
        # Zoho expects RFC 1123, e.g. "Tue, 01 Jan 2026 00:00:00 +0000".
        if modified_since.tzinfo is None:
            modified_since = modified_since.replace(tzinfo=timezone.utc)
        headers = {
            **headers,
            "If-Modified-Since": modified_since.strftime("%a, %d %b %Y %H:%M:%S %z"),
        }
    async with httpx.AsyncClient(timeout=60.0) as http:
        while True:
            r = await http.get(
                f"{s.zoho_api_domain}/crm/v2/{module}",
                headers=headers,
                params={"page": page, "per_page": per_page},
            )
            if r.status_code == 204 or r.status_code == 304:
                break
            r.raise_for_status()
            body = r.json()
            rows = body.get("data") or []
            out.extend(rows)
            info = body.get("info") or {}
            if not info.get("more_records") or len(rows) == 0:
                break
            page += 1
    return out


async def list_accounts(*, modified_since: "datetime | None" = None) -> list[dict[str, Any]]:
    return await _list_module("Accounts", modified_since=modified_since)


async def list_deals(*, modified_since: "datetime | None" = None) -> list[dict[str, Any]]:
    return await _list_module("Deals", modified_since=modified_since)


async def list_contacts(*, modified_since: "datetime | None" = None) -> list[dict[str, Any]]:
    return await _list_module("Contacts", modified_since=modified_since)


async def list_notes(*, modified_since: "datetime | None" = None) -> list[dict[str, Any]]:
    """Notes are first-class activity rows in Zoho CRM (WBS 1.1)."""
    return await _list_module("Notes", modified_since=modified_since)


async def list_tasks(*, modified_since: "datetime | None" = None) -> list[dict[str, Any]]:
    """Zoho CRM Tasks (not to be confused with ClickUp tasks)."""
    return await _list_module("Tasks", modified_since=modified_since)


async def list_users() -> list[dict[str, Any]]:
    s = get_settings()
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.get(
            f"{s.zoho_api_domain}/crm/v2/users",
            headers=await _headers(),
            params={"type": "AllUsers"},
        )
        r.raise_for_status()
        return r.json().get("users", [])  # type: ignore[no-any-return]


__all__ = [
    "get_access_token",
    "list_accounts",
    "list_contacts",
    "list_deals",
    "list_notes",
    "list_tasks",
    "list_users",
]
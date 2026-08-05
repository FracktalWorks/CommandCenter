"""The **only** Zoho CRM write surface in this repository.

Spec: ``ai-company-brain/specs/crm_app.md`` §7.1 · D-CRM-7 · D-CRM-8 ·
ticket WS-26b done-when 1.

Until 2026-08-05 there was no Zoho write path anywhere in the tree — the
sibling ``client.py`` is six ``GET``s and an OAuth refresh. The owner then
directed that coexistence be a *faithful two-way sync* rather than a one-way
import (D-CRM-7), which needs one. The boundary that survives that decision is
this module's whole reason to exist and is not negotiable:

* **This file holds every Zoho write, and nothing else does.** No route
  handler, agent tool or skill calls Zoho directly. Agents write the native
  CRM; the sync propagates.
* **It has exactly ONE caller** — the sync engine,
  ``gateway/routes/crm/sync_zoho.py``. Grep-asserted by
  ``tests/unit/test_crm_zoho_sync.py``, in both directions (this module is
  imported there and nowhere else; the engine reaches Zoho only through here).
* **Every call arrives already broker-gated.** The Action-Broker chokepoint
  lives gateway-side (``routes/crm/broker_handlers.py``) because ingestion
  cannot import the gateway; this module is deliberately dumb about
  authority — it is HTTP, not policy. Do not add a bypass in the other
  direction by having anything else import it.
* **The whole path retires with WS-26e**, together with the client, the cron,
  the webhook and the credentials (§7.4).

Zoho's v2 write API answers every verb with the same envelope::

    {"data": [{"code": "SUCCESS", "status": "success",
               "details": {"id": "554023000000123001", ...}, "message": "..."}]}

so :func:`_first` unwraps it once and :func:`_require_success` turns a
per-record failure into an exception rather than a silently-dropped write —
Zoho returns HTTP 200 with ``status: "error"`` inside the envelope for a
validation failure, which is the shape that makes "the sync said it pushed"
untrue.
"""
from __future__ import annotations

from typing import Any

import httpx
from acb_common import get_settings

from ingestion.sources.zoho.client import _headers

#: Zoho module names this writer will address. The sync engine maps its four
#: record tables (plus Notes/Tasks for activities) onto these; anything else is
#: refused here rather than sent, so a typo'd module cannot become a request
#: against a tenant we did not mean to touch.
WRITABLE_MODULES: frozenset[str] = frozenset({
    "Accounts", "Contacts", "Leads", "Deals", "Notes", "Tasks",
})


class ZohoWriteError(RuntimeError):
    """A Zoho write did not succeed. Carries the upstream detail verbatim."""


def _check_module(module: str) -> str:
    if module not in WRITABLE_MODULES:
        raise ZohoWriteError(
            f"refusing to write unknown Zoho module {module!r}; "
            f"one of {sorted(WRITABLE_MODULES)}"
        )
    return module


def _first(body: Any) -> dict[str, Any]:
    """The single-record envelope Zoho wraps every write in."""
    rows = (body or {}).get("data") or []
    if not rows:
        raise ZohoWriteError(f"Zoho returned no record in its response: {body!r}")
    return dict(rows[0])


def _require_success(result: dict[str, Any], what: str) -> dict[str, Any]:
    """Zoho answers 200 with ``status: 'error'`` for a rejected record.

    Treating that as success is how a sync reports a push it never made, so it
    raises here — the engine counts the error and leaves the row dirty, which
    means the next cycle tries again instead of forgetting.
    """
    if str(result.get("status") or "").lower() != "success":
        raise ZohoWriteError(
            f"{what} failed: {result.get('code')} {result.get('message')} "
            f"{result.get('details')}"
        )
    return result


def record_id_of(result: dict[str, Any]) -> str | None:
    """The Zoho id a create/update result carries, if any."""
    details = result.get("details") or {}
    found = details.get("id")
    return str(found) if found else None


async def create_record(module: str, payload: dict[str, Any]) -> dict[str, Any]:
    """``POST /crm/v2/{module}`` — a native row that Zoho has never seen.

    The caller reads the new Zoho id off the result with :func:`record_id_of`
    and stamps it on the native row, which is what stops the next cycle
    creating a duplicate.
    """
    s = get_settings()
    async with httpx.AsyncClient(timeout=60.0) as http:
        r = await http.post(
            f"{s.zoho_api_domain}/crm/v2/{_check_module(module)}",
            headers=await _headers(),
            json={"data": [payload]},
        )
        r.raise_for_status()
        return _require_success(_first(r.json()), f"create {module}")


async def update_record(
    module: str, record_id: str, payload: dict[str, Any],
) -> dict[str, Any]:
    """``PUT /crm/v2/{module}/{id}`` — push a native edit onto its Zoho twin."""
    s = get_settings()
    async with httpx.AsyncClient(timeout=60.0) as http:
        r = await http.put(
            f"{s.zoho_api_domain}/crm/v2/{_check_module(module)}/{record_id}",
            headers=await _headers(),
            json={"data": [payload]},
        )
        r.raise_for_status()
        return _require_success(_first(r.json()), f"update {module}/{record_id}")


async def upsert_record(
    module: str, payload: dict[str, Any], *, record_id: str | None = None,
) -> dict[str, Any]:
    """Upsert **by id**: update when we hold a ``zoho_id``, else create.

    The one entry point the sync engine's push phase uses for records, so
    "create acquires an id, update writes onto it" is one decision in one
    place rather than a branch at every call site.
    """
    if record_id:
        return await update_record(module, record_id, payload)
    return await create_record(module, payload)


async def delete_record(module: str, record_id: str) -> dict[str, Any]:
    """``DELETE /crm/v2/{module}/{id}`` — propagate a native delete.

    Irreversible upstream (Zoho drops it into its own recycle bin), which is
    exactly why the caller must have taken it through the broker gate first.
    """
    s = get_settings()
    async with httpx.AsyncClient(timeout=60.0) as http:
        r = await http.delete(
            f"{s.zoho_api_domain}/crm/v2/{_check_module(module)}/{record_id}",
            headers=await _headers(),
        )
        r.raise_for_status()
        return _require_success(_first(r.json()), f"delete {module}/{record_id}")


__all__ = [
    "WRITABLE_MODULES",
    "ZohoWriteError",
    "create_record",
    "delete_record",
    "record_id_of",
    "update_record",
    "upsert_record",
]

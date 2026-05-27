"""Normalise Zoho CRM payloads into the graph mirror.

Mappings (Phase-0 shallow):
  Accounts -> Customer (zoho_id key)
  Contacts -> Person   (zoho_id key)
  Users    -> Person   (zoho_id = "zoho-user-<id>"; email-deduped)
  Deals    -> Deal     (zoho_id key)
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from acb_graph import repo


def _iso_to_dt(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        # Zoho returns "2024-01-15T12:34:56+05:30"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError):
        return None


# ---- deal_type heuristic (WBS 1.1) ---------------------------------------

_SOFTWARE_RX = ("software", "saas", "license", "licence", "subscription", "platform", "annual contract")
_SERVICE_RX = ("service", "consult", "amc", "support", "training", "implementation", "installation", "warranty")
_PRODUCT_RX = ("printer", "machine", "hardware", "kit", "spare", "filament", "device", "module", "component")


def infer_deal_type(deal: dict[str, Any]) -> str | None:
    """Best-effort guess at deal_type from Zoho fields.

    Order of precedence:
        1. An explicit custom field — ``Deal_Type``, ``Type``, ``Category``.
        2. Pipeline / Layout name (e.g. ``Software Pipeline``).
        3. Keyword match in the deal name.

    Returns one of ``product`` / ``service`` / ``software``, or ``None`` if
    we have no signal — the DB CHECK constraint accepts NULL.
    """
    # 1) Explicit custom field
    for key in ("Deal_Type", "Type", "Category"):
        val = deal.get(key)
        if isinstance(val, str):
            v = val.strip().lower()
            if v in {"product", "service", "software"}:
                return v
            if any(t in v for t in _SOFTWARE_RX):
                return "software"
            if any(t in v for t in _SERVICE_RX):
                return "service"
            if any(t in v for t in _PRODUCT_RX) or "hardware" in v:
                return "product"

    # 2) Pipeline / Layout name
    for key in ("Pipeline", "Layout"):
        v = deal.get(key)
        name = (v or {}).get("name") if isinstance(v, dict) else v
        if isinstance(name, str):
            blob = name.lower()
            if any(t in blob for t in _SOFTWARE_RX):
                return "software"
            if any(t in blob for t in _SERVICE_RX):
                return "service"
            if any(t in blob for t in _PRODUCT_RX):
                return "product"

    # 3) Free-text fall-back on the deal name itself.
    blob = (deal.get("Deal_Name") or "").lower()
    if any(t in blob for t in _SOFTWARE_RX):
        return "software"
    if any(t in blob for t in _SERVICE_RX):
        return "service"
    if any(t in blob for t in _PRODUCT_RX):
        return "product"
    return None



def normalise_accounts(session: Session, accounts: list[dict[str, Any]]) -> int:
    """Upsert Zoho Accounts as Customers. Returns count."""
    n = 0
    for a in accounts:
        zid = str(a.get("id") or "")
        if not zid:
            continue
        repo.upsert_customer(session, zoho_id=zid, name=a.get("Account_Name") or f"Account {zid}")
        n += 1
    return n


def normalise_contacts(session: Session, contacts: list[dict[str, Any]]) -> int:
    """Upsert Zoho Contacts as Persons. Returns count."""
    n = 0
    for c in contacts:
        zid = str(c.get("id") or "")
        if not zid:
            continue
        name = (c.get("Full_Name") or " ".join(
            filter(None, [c.get("First_Name"), c.get("Last_Name")])
        ) or f"Contact {zid}")
        repo.upsert_person(
            session,
            zoho_id=zid,
            canonical_name=name,
            email=c.get("Email"),
            role=c.get("Title"),
        )
        n += 1
    return n


def normalise_users(session: Session, users: list[dict[str, Any]]) -> int:
    """Upsert Zoho Users (internal sales team) as Persons."""
    n = 0
    for u in users:
        zid = f"zoho-user-{u.get('id')}"
        name = u.get("full_name") or " ".join(
            filter(None, [u.get("first_name"), u.get("last_name")])
        ) or f"User {u.get('id')}"
        repo.upsert_person(
            session,
            zoho_id=zid,
            canonical_name=name,
            email=u.get("email"),
            role=(u.get("role") or {}).get("name") if isinstance(u.get("role"), dict) else None,
        )
        n += 1
    return n


def _customer_id_for(session: Session, deal: dict[str, Any]) -> Any:
    acc = deal.get("Account_Name") or {}
    if isinstance(acc, dict) and acc.get("id"):
        cust = repo.upsert_customer(session, zoho_id=str(acc["id"]), name=acc.get("name") or "(unknown)")
        return cust.id
    return None


def _owner_id_for(session: Session, deal: dict[str, Any]) -> Any:
    owner = deal.get("Owner") or {}
    if isinstance(owner, dict) and owner.get("id"):
        zid = f"zoho-user-{owner['id']}"
        p = repo.upsert_person(
            session,
            zoho_id=zid,
            canonical_name=owner.get("name") or owner.get("email") or f"User {owner['id']}",
            email=owner.get("email"),
        )
        return p.id
    return None


def normalise_deals(session: Session, deals: list[dict[str, Any]]) -> int:
    """Upsert Zoho Deals. Returns count."""
    n = 0
    for d in deals:
        zid = str(d.get("id") or "")
        if not zid:
            continue
        repo.upsert_deal(
            session,
            zoho_id=zid,
            name=d.get("Deal_Name") or f"Deal {zid}",
            customer_id=_customer_id_for(session, d),
            owner_id=_owner_id_for(session, d),
            stage=d.get("Stage"),
            last_activity_at=_iso_to_dt(d.get("Last_Activity_Time") or d.get("Modified_Time")),
            value_inr=_decimal(d.get("Amount")),
            deal_type=infer_deal_type(d),
        )
        n += 1
    return n


__all__ = [
    "infer_deal_type",
    "normalise_accounts",
    "normalise_contacts",
    "normalise_deals",
    "normalise_users",
]
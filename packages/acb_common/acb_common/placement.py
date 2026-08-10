"""Tenant placement — which data plane serves an organization (MT-1a).

Spec: ``project-docs/specs/saas_multitenancy.md`` §1.5 · D15 · board WS-29.

Under D15 the tenant boundary is a **row** (`organization_id` + Postgres RLS) and
the *deployment* is demoted to a **placement**: a region and a tier, not an
isolation boundary. Three unrelated customer demands all resolve to this one
mechanism — the dedicated-data tier a compliance-sensitive buyer asks for
(§1.5), the "is my data in the same database as my competitor's" procurement
question (§1.8a), and genuine version pinning (§1.4b).

**On day one every tenant resolves to the same target.** That is not a reason to
skip the indirection — it *is* the indirection's value. Moving a customer to
their own database becomes a data move plus a row update, instead of an
architecture change made under pressure while that customer waits. §1.6 puts it
plainly: *a tenancy model you cannot reverse is the actual risk.*

⚠️ **This module resolves placement, not identity.** It does not decide which
tenant a request belongs to — that comes from the authenticated session or a
tenant-scoped API key and from nowhere else (`user_management_contract.md`
**R11**). Passing a tenant id in here that came from a header would launder
exactly the input this platform must never trust.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from acb_common import get_logger

_log = get_logger("placement")

#: The tiers, in ascending order of isolation and price (§1.5).
TIERS: tuple[str, ...] = ("pool", "bridge", "silo")

_PLACEMENT_SQL = """
SELECT organization_id::text AS organization_id, tier, target, region
  FROM tenant_placement
 WHERE organization_id = :org_id
"""

#: Resolution for a deployment that has not been split yet. Mirrors
#: ``key_store._resolve_org`` deliberately: "the sole organization" resolves
#: only while there IS exactly one, so an untenanted caller stops resolving the
#: moment a second tenant exists rather than silently picking the operator's.
_SOLE_PLACEMENT_SQL = """
SELECT p.organization_id::text AS organization_id, p.tier, p.target, p.region
  FROM tenant_placement p
 WHERE (SELECT count(*) FROM organization) = 1
"""


@dataclass(frozen=True)
class Placement:
    """Where one tenant's data lives."""

    organization_id: str
    tier: str
    target: str
    region: str

    @property
    def is_pooled(self) -> bool:
        return self.tier == "pool"

    @property
    def is_dedicated(self) -> bool:
        """Own database or own stack — the priced tiers (§1.5)."""
        return self.tier in ("bridge", "silo")


class PlacementUnresolved(RuntimeError):
    """No placement could be resolved. **Always fatal, never defaulted.**

    A caller that cannot establish which data plane serves a tenant must not
    guess: guessing means reading or writing another customer's data. Every
    failure here is a refusal.
    """


async def resolve_placement(organization_id: str | None = None) -> Placement:
    """Resolve the data plane serving *organization_id*.

    ``None`` resolves to the sole organization — which exists only while there
    is one. Once a second tenant is created, an untenanted call **raises**
    rather than falling back to the operator's org. That failure is the design:
    it surfaces at exactly the moment a real tenant must be threaded through,
    instead of quietly serving the wrong customer's data for however long it
    takes someone to notice.

    Raises:
        PlacementUnresolved: no row, more than one organization with no id
            given, or the catalog is unreachable.
    """
    from sqlalchemy import text

    from acb_common.db import get_db

    sql = _PLACEMENT_SQL if organization_id else _SOLE_PLACEMENT_SQL
    params: dict[str, Any] = {"org_id": organization_id} if organization_id else {}

    try:
        session = await get_db()
        try:
            row = (await session.execute(text(sql), params)).mappings().first()
        finally:
            await session.close()
    except Exception as exc:
        _log.warning("placement.lookup_failed", error=str(exc)[:200])
        raise PlacementUnresolved(
            "the tenant catalog is unreachable — refusing to guess a placement"
        ) from exc

    if row is None:
        raise PlacementUnresolved(
            f"no placement for organization_id={organization_id!r}"
            if organization_id
            else "no sole organization — pass an explicit organization_id "
                 "(saas_multitenancy.md §1.5)"
        )

    return Placement(
        organization_id=row["organization_id"],
        tier=row["tier"],
        target=row["target"],
        region=row["region"],
    )

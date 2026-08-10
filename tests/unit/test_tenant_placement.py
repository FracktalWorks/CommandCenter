"""MT-1a — tenant placement resolves, or refuses. It never guesses.

Spec: ``project-docs/specs/saas_multitenancy.md`` §1.5 / §1.6 / MT-1a ·
board WS-29 · D15.

Placement is the indirection that makes the tenancy decision **reversible**:
moving a customer to their own database becomes a data move plus a row update
instead of an architecture change made under pressure. §1.6 states the reason
plainly — *a tenancy model you cannot reverse is the actual risk.*

On day one every tenant resolves to ``(pool, primary)``. These tests exist
because that is exactly when the indirection is easiest to quietly skip, and
because its one dangerous failure mode is **defaulting instead of refusing**.
"""
from __future__ import annotations

import pytest
from acb_common.placement import (
    TIERS,
    Placement,
    PlacementUnresolved,
    resolve_placement,
)

_ORG_A = "11111111-1111-1111-1111-111111111111"


class _FakeSession:
    def __init__(self, row=None, raises: Exception | None = None):
        self._row, self._raises = row, raises
        self.sql = ""

    async def execute(self, stmt, params=None):
        if self._raises:
            raise self._raises
        self.sql = str(stmt)
        row = self._row

        class _R:
            def mappings(self):
                class _M:
                    def first(_self):
                        return row
                return _M()
        return _R()

    async def close(self):
        return None


def _patch_db(monkeypatch, session):
    async def _get_db():
        return session
    monkeypatch.setattr("acb_common.db.get_db", _get_db, raising=True)


@pytest.mark.asyncio
async def test_resolves_an_explicit_organization(monkeypatch) -> None:
    _patch_db(monkeypatch, _FakeSession(row={
        "organization_id": _ORG_A, "tier": "pool",
        "target": "primary", "region": "ap-south-1",
    }))

    p = await resolve_placement(_ORG_A)

    assert p == Placement(_ORG_A, "pool", "primary", "ap-south-1")
    assert p.is_pooled and not p.is_dedicated


@pytest.mark.asyncio
async def test_missing_placement_raises_rather_than_defaulting(monkeypatch) -> None:
    """A tenant with no placement row is unresolvable — and unresolvable must
    mean *stop*, not *use the usual one*. Defaulting here reads or writes
    another customer's data."""
    _patch_db(monkeypatch, _FakeSession(row=None))

    with pytest.raises(PlacementUnresolved):
        await resolve_placement(_ORG_A)


@pytest.mark.asyncio
async def test_untenanted_call_raises_once_there_is_no_sole_org(monkeypatch) -> None:
    """The untenanted query is guarded by ``count(*) = 1``, so it returns nothing
    the moment a second tenant exists.

    This mirrors ``key_store._resolve_org`` and ``mutation._self_mutation_permitted``
    on purpose: three independent places, one rule — *fail closed exactly when a
    second tenant appears*, which is when a real tenant id must be threaded
    through instead.
    """
    _patch_db(monkeypatch, _FakeSession(row=None))

    with pytest.raises(PlacementUnresolved, match="no sole organization"):
        await resolve_placement(None)


@pytest.mark.asyncio
async def test_catalog_unreachable_raises(monkeypatch) -> None:
    _patch_db(monkeypatch, _FakeSession(raises=RuntimeError("connection refused")))

    with pytest.raises(PlacementUnresolved, match="unreachable"):
        await resolve_placement(_ORG_A)


@pytest.mark.asyncio
async def test_dedicated_tiers_are_flagged(monkeypatch) -> None:
    """`bridge` and `silo` are the priced tiers (§1.5). Code that has to behave
    differently for them asks this, not a string comparison scattered around."""
    for tier in ("bridge", "silo"):
        _patch_db(monkeypatch, _FakeSession(row={
            "organization_id": _ORG_A, "tier": tier,
            "target": "acme-db", "region": "ap-south-1",
        }))
        p = await resolve_placement(_ORG_A)
        assert p.is_dedicated and not p.is_pooled


def test_tiers_match_the_migration_check_constraint() -> None:
    """The CHECK in 159_control_plane.sql and this tuple must not drift — a tier
    accepted by one and rejected by the other is an onboarding failure nobody
    can debug from either side alone."""
    from pathlib import Path
    sql = (Path(__file__).resolve().parents[2]
           / "infra/postgres/159_control_plane.sql").read_text(encoding="utf-8")
    for tier in TIERS:
        assert f"'{tier}'" in sql, f"tier {tier!r} missing from the migration CHECK"


def test_placement_row_seeded_for_every_existing_org() -> None:
    """A tenant with no placement row cannot be served. The migration must
    backfill every organization that already exists, not just new ones."""
    from pathlib import Path
    sql = (Path(__file__).resolve().parents[2]
           / "infra/postgres/159_control_plane.sql").read_text(encoding="utf-8")
    assert "INSERT INTO tenant_placement" in sql
    assert "SELECT id, 'pool', 'primary' FROM organization" in sql

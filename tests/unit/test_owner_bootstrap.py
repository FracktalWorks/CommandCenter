"""The ownership bootstrap always leaves a way back in.

Born from the 2026-07-30 production lockout: `app_user` was empty, so
migration 128's promote-an-existing-row bootstrap silently did nothing, and
the invite-only model had zero members, zero owners — **no inviter**. Every
authenticated sign-in resolved unprovisioned; the only fix was hand-run SQL.

`ensure_owner_bootstrap` closes that loop at gateway startup, the first
place the database AND the environment are both readable. The properties
that matter, asserted against a live database:

1. **Empty deployment → EXECUTIVE_EMAILS becomes the owner**, row created,
   active, owner role attached.
2. **Any existing owner makes it a no-op forever** — a stale or placeholder
   EXECUTIVE_EMAILS can never overwrite real membership.
3. **No candidate → warn, don't crash.** An ownerless deployment with a
   broken bootstrap must still boot and serve /health.
4. **Unprovisioned sign-ins are visible and cached** — the refusal is
   logged (once per TTL, not per request) and negative results stop
   re-querying the DB on every call.
"""
from __future__ import annotations

import pytest


def _db_ready() -> bool:
    try:
        from acb_graph import get_session
        from sqlalchemy import text
    except Exception:
        return False
    try:
        with get_session() as s:
            s.execute(text("SELECT 1 FROM org_role LIMIT 1"))
        return True
    except Exception:
        return False


_needs_db = pytest.mark.skipif(
    not _db_ready(),
    reason="no reachable Postgres with migration 128 — bootstrap tests skipped",
)

_OWNER = "pytest-bootstrap-owner@fracktal.in"
_PREEXISTING = "pytest-bootstrap-existing@fracktal.in"


def _exec(sql: str, **params):
    from acb_graph import get_session
    from sqlalchemy import text
    with get_session() as s:
        result = s.execute(text(sql), params)
        try:
            rows = result.fetchall()
        except Exception:
            rows = []
        s.commit()
        return rows


def _purge() -> None:
    _exec(
        "DELETE FROM app_user WHERE email LIKE 'pytest-bootstrap-%'",
    )


def _owner_emails() -> set[str]:
    return {
        r[0]
        for r in _exec(
            "SELECT u.email FROM user_role ur "
            "JOIN org_role r ON r.id = ur.role_id AND r.slug = 'owner' "
            "JOIN app_user u ON u.id = ur.user_id",
        )
    }


@pytest.fixture
def ownerless(monkeypatch):
    """A deployment with no owner at all, and a fresh engine per test (the
    module's async engine binds to the first test's event loop)."""
    import acb_auth.access as access_mod

    _purge()
    # Detach every owner-role assignment, remembering enough to restore.
    saved = _exec(
        "SELECT ur.user_id::text, ur.role_id::text, ur.assigned_by "
        "FROM user_role ur JOIN org_role r ON r.id = ur.role_id "
        "WHERE r.slug = 'owner'",
    )
    _exec(
        "DELETE FROM user_role ur USING org_role r "
        "WHERE r.id = ur.role_id AND r.slug = 'owner'",
    )
    access_mod.invalidate()
    monkeypatch.setattr(access_mod, "CACHE_TTL_SECONDS", 0.0)
    monkeypatch.setattr(access_mod, "_ENGINE", None)
    monkeypatch.setattr(access_mod, "_SESSION_FACTORY", None)
    yield
    _purge()
    for user_id, role_id, assigned_by in saved:
        _exec(
            "INSERT INTO user_role (user_id, role_id, assigned_by) "
            "VALUES (CAST(:u AS uuid), CAST(:r AS uuid), :b) "
            "ON CONFLICT DO NOTHING",
            u=user_id, r=role_id, b=assigned_by,
        )
    access_mod.invalidate()


@_needs_db
@pytest.mark.asyncio
async def test_empty_deployment_bootstraps_the_owner(
    ownerless, monkeypatch,
) -> None:
    from acb_auth import ensure_owner_bootstrap, resolve_access

    monkeypatch.setenv("EXECUTIVE_EMAILS", f"{_OWNER}, second@fracktal.in")

    assert await ensure_owner_bootstrap() == _OWNER
    assert _OWNER in _owner_emails()

    access = await resolve_access(_OWNER, use_cache=False)
    assert access.is_active
    assert access.has("admin:members:invite")  # the way back in: can invite


@_needs_db
@pytest.mark.asyncio
async def test_an_existing_owner_makes_it_a_noop(ownerless, monkeypatch) -> None:
    """A placeholder EXECUTIVE_EMAILS must never overwrite real membership."""
    from acb_auth import ensure_owner_bootstrap

    _exec(
        "INSERT INTO app_user (email, display_name, role, status, "
        "organization_id) "
        "SELECT :e, :e, 'executive', 'active', id FROM organization LIMIT 1 "
        "ON CONFLICT (email) DO NOTHING", e=_PREEXISTING,
    )
    _exec(
        "INSERT INTO user_role (user_id, role_id, assigned_by) "
        "SELECT u.id, r.id, 'pytest' FROM app_user u, org_role r "
        "WHERE u.email = :e AND r.slug = 'owner' ON CONFLICT DO NOTHING",
        e=_PREEXISTING,
    )

    monkeypatch.setenv("EXECUTIVE_EMAILS", "ceo@fracktal.in")
    assert await ensure_owner_bootstrap() is None
    assert "ceo@fracktal.in" not in _owner_emails()


@_needs_db
@pytest.mark.asyncio
async def test_no_candidate_warns_and_does_nothing(ownerless, monkeypatch) -> None:
    from acb_auth import ensure_owner_bootstrap

    monkeypatch.setenv("EXECUTIVE_EMAILS", "not-an-address")
    assert await ensure_owner_bootstrap() is None
    assert _owner_emails() == set()


@_needs_db
@pytest.mark.asyncio
async def test_rerunning_after_bootstrap_is_inert(ownerless, monkeypatch) -> None:
    """Startup runs this every boot — the second boot must change nothing."""
    from acb_auth import ensure_owner_bootstrap

    monkeypatch.setenv("EXECUTIVE_EMAILS", _OWNER)
    assert await ensure_owner_bootstrap() == _OWNER
    assert await ensure_owner_bootstrap() is None
    assert _owner_emails() == {_OWNER}


@_needs_db
@pytest.mark.asyncio
async def test_unprovisioned_signin_is_cached(ownerless) -> None:
    """The refusal caches like every other resolution, so the DB is not
    re-queried per request and the warning fires once per TTL."""
    import acb_auth.access as access_mod

    access_mod.CACHE_TTL_SECONDS = 60.0
    ghost = "pytest-bootstrap-ghost@fracktal.in"
    first = await access_mod.resolve_access(ghost)
    assert not first.is_active
    assert access_mod._cache_get(ghost) is not None

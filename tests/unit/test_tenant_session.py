"""MT-1c — the tenant binding seam. ``SET LOCAL``, in a transaction, or refuse.

Spec: ``project-docs/specs/saas_multitenancy.md`` §0.1 / §1.3 · WS-29 · D15.

RLS enforces isolation server-side, but only against a session that has told the
server which tenant it acts for. ``tenant_session`` is the one place that
happens — which is what makes a pooled data plane defensible across **ten**
connection paths (§0.1, an inventory that has itself been wrong twice).

Three properties, each with a specific way of going wrong:

1. **``SET LOCAL``, never ``SET``.** The engine pools connections. A
   session-scoped ``SET`` survives the connection's return to the pool, so the
   next borrower — different request, different customer — inherits it. This is
   the highest-consequence line in the migration and it is asserted as a string,
   because the difference is one word and the symptom is a cross-tenant read
   under concurrency that no unit test would reproduce by accident.
2. **Inside a real transaction.** ``SET LOCAL`` outside one is a *silent no-op*:
   Postgres warns, the policy sees an unset GUC, every query returns nothing.
   That reads as "the feature is broken", not "tenancy is broken".
3. **Unbound refuses.** Never "the usual tenant".
"""
from __future__ import annotations

import inspect

import pytest
from acb_common.db import (
    TenantUnbound,
    bind_tenant,
    current_tenant,
    release_tenant,
    tenant_session,
)

_ORG_A = "11111111-1111-1111-1111-111111111111"
_ORG_B = "22222222-2222-2222-2222-222222222222"


class _FakeSession:
    """Records the order of operations, which is what these tests are about."""

    def __init__(self, calls: list):
        self.calls = calls

    async def begin(self):
        self.calls.append(("begin", None))

    async def execute(self, stmt, params=None):
        self.calls.append(("execute", (str(stmt), params)))

    async def commit(self):
        self.calls.append(("commit", None))

    async def rollback(self):
        self.calls.append(("rollback", None))

    async def close(self):
        self.calls.append(("close", None))


@pytest.fixture
def calls(monkeypatch):
    seen: list = []
    monkeypatch.setattr("acb_common.db.get_session_factory",
                        lambda: (lambda: _FakeSession(seen)), raising=True)
    return seen


# ==========================================================================
# 1 — SET LOCAL, not SET.
# ==========================================================================
def test_the_seam_uses_transaction_local_set_config() -> None:
    """A string assertion, deliberately.

    Transaction-local vs session-scoped is a one-argument difference whose
    only symptom is a cross-tenant read under connection reuse. No behavioural
    unit test reproduces that reliably, so the source is pinned instead.

    ⚠️ The encoding is ``set_config('app.tenant_id', :tenant, true)`` and NOT
    the literal ``SET LOCAL app.tenant_id = :tenant`` — the latter is a
    Postgres SYNTAX ERROR through the extended protocol (``SET`` cannot take
    a bind parameter). Every hermetic run was green with the broken literal;
    the first live handler run failed on it (2026-08-10). ``set_config``'s
    third argument ``true`` is what makes it ``SET LOCAL`` semantics; ``false``
    (or omitting it) is the session-scoped poison this test exists to refuse.
    """
    src = inspect.getsource(tenant_session.__wrapped__)  # type: ignore[attr-defined]
    assert "set_config('app.tenant_id', :tenant, true)" in src
    # Pin the EXECUTED statement, not the prose around it: no text("SET ...")
    # may reappear (the literal form cannot bind a parameter — it only ever
    # worked against fakes), and no is_local=false variant may sneak in (a
    # session-scoped set survives the connection's return to the pool and the
    # next borrower reads the previous tenant).
    assert 'text("SET' not in src and "text('SET" not in src
    assert "set_config('app.tenant_id', :tenant, false" not in src


@pytest.mark.asyncio
async def test_binding_is_issued_as_a_bound_parameter(calls) -> None:
    async with tenant_session(_ORG_A):
        pass
    sets = [c for c in calls if c[0] == "execute"]
    assert len(sets) == 1
    sql, params = sets[0][1]
    assert "set_config('app.tenant_id'" in sql
    assert params == {"tenant": _ORG_A}
    assert _ORG_A not in sql, "the tenant id was interpolated into the statement"


# ==========================================================================
# 2 — inside a transaction, or the SET LOCAL is a silent no-op.
# ==========================================================================
@pytest.mark.asyncio
async def test_begin_precedes_the_set_local(calls) -> None:
    async with tenant_session(_ORG_A):
        pass
    names = [c[0] for c in calls]
    assert names.index("begin") < names.index("execute"), (
        "SET LOCAL outside a transaction is a silent no-op — every query then "
        "returns zero rows and it looks like a broken feature"
    )
    assert names == ["begin", "execute", "commit", "close"]


@pytest.mark.asyncio
async def test_failure_rolls_back_and_closes(calls) -> None:
    with pytest.raises(ValueError):
        async with tenant_session(_ORG_A):
            raise ValueError("boom")
    names = [c[0] for c in calls]
    assert "rollback" in names and names[-1] == "close"
    assert "commit" not in names


# ==========================================================================
# 3 — unbound refuses, and never defaults.
# ==========================================================================
@pytest.mark.asyncio
async def test_unbound_refuses(calls) -> None:
    with pytest.raises(TenantUnbound):
        async with tenant_session():
            pass
    assert calls == [], "a session was opened before the tenant check"


@pytest.mark.asyncio
async def test_context_binding_is_used_when_no_argument_given(calls) -> None:
    token = bind_tenant(_ORG_A)
    try:
        assert current_tenant() == _ORG_A
        async with tenant_session():
            pass
    finally:
        release_tenant(token)
    _, params = next(c for c in calls if c[0] == "execute")[1]
    assert params == {"tenant": _ORG_A}
    assert current_tenant() is None


@pytest.mark.asyncio
async def test_explicit_argument_overrides_the_context(calls) -> None:
    """A job binding its own org must win over whatever ambient context it
    inherited from the process that queued it."""
    token = bind_tenant(_ORG_A)
    try:
        async with tenant_session(_ORG_B):
            pass
    finally:
        release_tenant(token)
    _, params = next(c for c in calls if c[0] == "execute")[1]
    assert params == {"tenant": _ORG_B}


def test_release_is_null_safe_and_idempotent() -> None:
    release_tenant(None)
    tok = bind_tenant(_ORG_A)
    release_tenant(tok)
    release_tenant(tok)
    assert current_tenant() is None


def test_get_db_is_documented_as_not_tenant_bound() -> None:
    """~200 call sites still use it. The docstring is the only thing standing
    between a reader and the assumption that it is safe under RLS."""
    from acb_common.db import get_db

    doc = (get_db.__doc__ or "")
    assert "Not tenant-bound" in doc
    assert "tenant_session" in doc

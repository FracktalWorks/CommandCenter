"""MT-0d — provider credentials stop being deployment-wide.

``provider_keys`` was ``provider TEXT PRIMARY KEY`` (``08_provider_keys.sql:6-7``)
— one key per provider for the whole box — and ``mcp_servers``, ``plugins`` and
``model_config`` had no owner column at all.

``tenancy_and_visibility.md`` §1.1 called that "exactly the right shape", and it
**was**: under D11 one deployment served one tenant. **D15 re-took that
decision**, and under a pooled tenant boundary the same shape means tenant B's
agent resolves tenant A's OpenAI key. Migration 158 re-keys all four.

Two properties are pinned here, and the second is the one that would otherwise
be missed by a reviewer reading only the SQL:

1. **A read scoped to org B never returns org A's key** — the SQL half.
2. **The in-memory cache is keyed by (org, provider), not provider** — the half
   no amount of correct SQL protects. A provider-keyed cache serves the first
   tenant's *decrypted* key to the second without a query ever running.

And the resolution rule: an untenanted call resolves to "the sole organization",
which stops resolving the moment a second exists — so every one of the ~20
existing call sites keeps working today and **fails closed** rather than leaking
when MT-1 lands.

Spec: ``project-docs/specs/saas_multitenancy.md`` §6.3 / MT-0d · WS-29.
"""
from __future__ import annotations

import base64
from pathlib import Path

import pytest
from acb_llm.key_store import ProviderKeyStore

_ORG_A = "11111111-1111-1111-1111-111111111111"
_ORG_B = "22222222-2222-2222-2222-222222222222"


class _FakeStore(ProviderKeyStore):
    """A key store over an in-memory table, so these tests need no database.

    ``rows`` is the ``provider_keys`` table: {(org, provider): plaintext}.
    ``orgs`` is how many organization rows exist, which is what the untenanted
    resolution depends on.
    """

    def __init__(self, rows: dict[tuple[str, str], str], org_count: int = 1):
        super().__init__()
        self.rows = rows
        self.org_count = org_count
        self.queries: list[str] = []

    async def _execute(self, sql: str, **params):          # type: ignore[override]
        self.queries.append(sql)
        norm = " ".join(sql.split())

        if norm.startswith("SELECT id FROM organization"):
            # Mirrors the real `count(*) = 1` guard.
            return [{"id": _ORG_A}] if self.org_count == 1 else []

        if norm.startswith("SELECT encrypted FROM provider_keys"):
            plain = self.rows.get((params["org_id"], params["provider"]))
            return [{"encrypted": self._enc(plain)}] if plain is not None else []

        if norm.startswith("SELECT provider, encrypted FROM provider_keys"):
            return [
                {"provider": p, "encrypted": self._enc(v)}
                for (o, p), v in self.rows.items() if o == params["org_id"]
            ]

        if norm.startswith("DELETE FROM provider_keys"):
            self.rows.pop((params["org_id"], params["provider"]), None)
            return []

        if norm.startswith("INSERT INTO provider_keys"):
            self.rows[(params["org_id"], params["provider"])] = "written"
            return []

        raise AssertionError(f"unexpected SQL: {norm[:80]}")

    def _enc(self, plain: str) -> str:
        return base64.urlsafe_b64encode(self._f.encrypt(plain.encode())).decode("ascii")


@pytest.fixture
def master_key(monkeypatch):
    monkeypatch.setenv("ACB_MASTER_KEY", "test-master-key-for-mt0d")


# ==========================================================================
# 1 — the SQL half.
# ==========================================================================
@pytest.mark.asyncio
async def test_org_b_never_receives_org_a_key(master_key) -> None:
    store = _FakeStore({(_ORG_A, "openai"): "sk-org-a-secret"}, org_count=2)

    assert await store.get("openai", organization_id=_ORG_A) == "sk-org-a-secret"
    assert await store.get("openai", organization_id=_ORG_B) == ""


@pytest.mark.asyncio
async def test_get_all_is_scoped(master_key) -> None:
    store = _FakeStore(
        {(_ORG_A, "openai"): "sk-a", (_ORG_B, "openai"): "sk-b",
         (_ORG_B, "anthropic"): "sk-b2"},
        org_count=2,
    )

    assert await store.get_all(organization_id=_ORG_A) == {"openai": "sk-a"}
    assert await store.get_all(organization_id=_ORG_B) == {
        "openai": "sk-b", "anthropic": "sk-b2",
    }


@pytest.mark.asyncio
async def test_delete_does_not_reach_across_orgs(master_key) -> None:
    store = _FakeStore(
        {(_ORG_A, "openai"): "sk-a", (_ORG_B, "openai"): "sk-b"}, org_count=2,
    )

    await store.delete("openai", organization_id=_ORG_B)

    assert (_ORG_A, "openai") in store.rows
    assert (_ORG_B, "openai") not in store.rows


# ==========================================================================
# 2 — the cache half. This is the one correct SQL does NOT protect.
# ==========================================================================
@pytest.mark.asyncio
async def test_cache_is_keyed_by_org_not_provider(master_key) -> None:
    """Org A's read must not warm a cache entry org B then hits.

    Under a ``provider``-keyed cache the second assertion returned
    ``sk-org-a-secret`` **without issuing a query at all** — the leak lives in
    memory, not in the statement.
    """
    store = _FakeStore({(_ORG_A, "openai"): "sk-org-a-secret"}, org_count=2)

    assert await store.get("openai", organization_id=_ORG_A) == "sk-org-a-secret"
    before = len(store.queries)

    assert await store.get("openai", organization_id=_ORG_B) == ""
    assert len(store.queries) > before, (
        "org B was answered from cache without a query — the cache is not tenant-keyed"
    )
    assert (_ORG_A, "openai") in store._cache
    assert (_ORG_B, "openai") not in store._cache


# ==========================================================================
# 3 — untenanted resolution: works at one org, fails CLOSED at two.
# ==========================================================================
@pytest.mark.asyncio
async def test_untenanted_read_works_while_there_is_one_org(master_key) -> None:
    """The ~20 existing call sites keep working unchanged today."""
    store = _FakeStore({(_ORG_A, "openai"): "sk-a"}, org_count=1)

    assert await store.get("openai") == "sk-a"


@pytest.mark.asyncio
async def test_untenanted_read_returns_nothing_once_a_second_org_exists(master_key) -> None:
    """MT-0d done-when: a lookup without a tenant returns nothing, never
    another tenant's key.

    A "default org" fallback would keep answering here — serving the operator's
    keys to a customer — which is precisely the leak this ticket closes.
    """
    store = _FakeStore({(_ORG_A, "openai"): "sk-a"}, org_count=2)

    assert await store.get("openai") == ""


@pytest.mark.asyncio
async def test_untenanted_write_raises_once_a_second_org_exists(master_key) -> None:
    """A write with no owner is how a key ends up readable by the wrong tenant.
    Failing loudly on write beats failing quietly on read."""
    store = _FakeStore({}, org_count=2)

    with pytest.raises(RuntimeError, match="requires an organization_id"):
        await store.put("openai", "sk-new")


# ==========================================================================
# The migration is the source of truth for the shape.
# ==========================================================================
def test_migration_rekeys_all_four_tables() -> None:
    sql = (Path(__file__).resolve().parents[2]
           / "infra/postgres/158_per_org_credentials.sql").read_text(encoding="utf-8")

    for table in ("provider_keys", "model_config", "mcp_servers", "plugins"):
        assert f"ALTER TABLE {table}\n    ADD COLUMN IF NOT EXISTS organization_id" in sql, (
            f"{table} did not gain organization_id"
        )
    assert "PRIMARY KEY (organization_id, provider)" in sql
    assert "PRIMARY KEY (organization_id, key)" in sql
    assert "PRIMARY KEY (organization_id, name)" in sql
    # plugins keeps its UUID pk; what must become per-org is the name uniqueness
    assert "plugins_org_name_key" in sql
    assert "DROP CONSTRAINT IF EXISTS plugins_name_key" in sql

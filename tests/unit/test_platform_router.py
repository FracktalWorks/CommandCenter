"""CP-4 — the Router forwards, resolves tiers, and counts. It does not price.

Spec: ``project-docs/specs/platform_control_plane.md`` §6 CP-4 · D32.1 / D32.7.

Acceptance: *"Forwards to the same providers using today's machinery, writes
``usage_event``, no pricing and no gate. Done when: a completion through the
Router is byte-identical for the client; one ``usage_event`` row exists per
completion; a retried ``request_id`` writes one row, not two."*

The provider call is stubbed through :func:`platform_api.router.set_provider_call`.
That seam exists because the alternative is a test that spends money at DeepSeek
on every run, which means in practice nobody runs it.
"""
from __future__ import annotations

import os
import uuid
from decimal import Decimal

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from platform_api import router as router_mod
from sqlalchemy import create_engine, text

_URL = os.environ.get("CONTROL_PLANE_DATABASE_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not _URL,
    reason=(
        "CONTROL_PLANE_DATABASE_URL unset — R8 requires a REAL Postgres. "
        "A skip here is not a pass; CI must set it."
    ),
)

TOKEN = "test-operator-token"
OP = {"Authorization": f"Bearer {TOKEN}"}
ENC_KEY = "test-encryption-key-not-a-real-one"

_MIGRATIONS = ("infra/platform/001_control_plane.sql",
               "infra/platform/002_seed_catalog.sql",
               "infra/platform/003_metering_integrity.sql",
               "infra/platform/004_provider_keys.sql")

#: What the stub provider returns. Deliberately carries fields the Router has no
#: opinion about, so "byte-identical" is a real assertion rather than a
#: comparison of two things the Router built.
PROVIDER_RESPONSE = {
    "id": "chatcmpl-abc123",
    "object": "chat.completion",
    "created": 1_755_000_000,
    "model": "deepseek/deepseek-v4-pro",
    "choices": [{
        "index": 0,
        "message": {"role": "assistant", "content": "Sixteen pumps are overdue."},
        "finish_reason": "stop",
    }],
    "usage": {"prompt_tokens": 1200, "completion_tokens": 40,
              "prompt_tokens_details": {"cached_tokens": 900}},
    "system_fingerprint": "fp_deadbeef",
}


def _root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture(scope="module", autouse=True)
def _schema():
    eng = create_engine(_URL, future=True)
    with eng.begin() as conn:
        for rel in _MIGRATIONS:
            with open(os.path.join(_root(), rel), encoding="utf-8") as fh:
                conn.exec_driver_sql(fh.read())


@pytest.fixture
def calls():
    """Records what the Router asked the provider for."""
    seen: list[dict] = []

    async def _stub(**kwargs):
        seen.append(kwargs)
        return dict(PROVIDER_RESPONSE)

    router_mod.set_provider_call(_stub)
    yield seen


@pytest.fixture
def client(monkeypatch, calls):
    monkeypatch.setenv("CONTROL_PLANE_OPERATOR_TOKEN", TOKEN)
    monkeypatch.setenv("CONTROL_PLANE_INTERNAL_TOKEN", "internal")
    monkeypatch.setenv("CONTROL_PLANE_ENCRYPTION_KEY", ENC_KEY)
    from platform_api.main import app
    return TestClient(app)


@pytest.fixture
def db():
    return create_engine(_URL, future=True)


@pytest.fixture
def org_key(client, db, monkeypatch):
    """A provisioned org, a live key, and a platform DeepSeek credential."""
    monkeypatch.setenv("CONTROL_PLANE_ENCRYPTION_KEY", ENC_KEY)
    slug = f"router-{uuid.uuid4().hex[:8]}"
    client.post("/orgs/provision", headers=OP, json={
        "slug": slug, "name": "N", "owner_email": f"o@{slug}.com"})
    token = client.post("/keys", headers=OP, json={"org_slug": slug}).json()["token"]

    with db.begin() as c:
        c.execute(
            text("INSERT INTO provider_credential (provider, secret_enc, label) "
                 "VALUES ('deepseek', :s, 'platform') "
                 "ON CONFLICT DO NOTHING"),
            {"s": router_mod.encrypt_secret("sk-provider-secret")},
        )
    return slug, {"Authorization": f"Bearer {token}"}


# ── Tier resolution ─────────────────────────────────────────────────────────

class TestTierResolution:
    def test_a_tier_resolves_to_the_bound_model(self, db):
        with db.begin() as c:
            assert router_mod.resolve_tier(c, "tier-balanced").model \
                == "deepseek/deepseek-v4-pro"

    def test_the_newest_binding_in_effect_wins(self, db):
        with db.connect() as c:
            tx = c.begin()
            c.execute(text(
                "INSERT INTO tier_binding (tier, model, effective_from) "
                "VALUES ('tier-balanced', 'newprovider/next', now())"))
            assert router_mod.resolve_tier(c, "tier-balanced").model \
                == "newprovider/next"
            tx.rollback()

    def test_a_future_binding_is_staged_not_live(self, db):
        # Re-pointing a tier is "insert a row with a later date", never "edit
        # the live one", so a swap can be staged and history stays readable.
        with db.connect() as c:
            tx = c.begin()
            c.execute(text(
                "INSERT INTO tier_binding (tier, model, effective_from) "
                "VALUES ('tier-balanced', 'future/model', now() + interval '7 days')"))
            assert router_mod.resolve_tier(c, "tier-balanced").model \
                == "deepseek/deepseek-v4-pro"
            tx.rollback()

    def test_an_unknown_tier_raises_rather_than_defaulting(self, db):
        with db.begin() as c:
            with pytest.raises(router_mod.TierUnknown):
                router_mod.resolve_tier(c, "tier-imaginary")


# ── Pass-through ────────────────────────────────────────────────────────────

class TestPassThrough:
    def test_the_response_reaches_the_client_unchanged(self, client, org_key):
        _, key = org_key
        r = client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced",
            "messages": [{"role": "user", "content": "which pumps are overdue?"}]})

        assert r.status_code == 200, r.text
        # Byte-identical: every field the provider sent, including ones the
        # Router has no opinion about.
        assert r.json() == PROVIDER_RESPONSE

    def test_the_tier_is_translated_to_a_real_model_for_the_provider(
            self, client, org_key, calls):
        _, key = org_key
        client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-fast", "messages": [{"role": "user", "content": "hi"}]})

        assert calls[-1]["model"] == "deepseek/deepseek-chat"

    def test_the_customer_never_sees_the_provider_secret(self, client, org_key, calls):
        _, key = org_key
        r = client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced", "messages": [{"role": "user", "content": "hi"}]})

        # It reached the provider...
        assert calls[-1]["api_key"] == "sk-provider-secret"
        # ...and not the customer.
        assert "sk-provider-secret" not in r.text

    def test_unrecognised_parameters_are_forwarded_not_rejected(
            self, client, org_key, calls):
        # The Router is a pass-through; a provider parameter it does not know
        # about is not its business to reject.
        _, key = org_key
        client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced", "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.2, "top_p": 0.9, "some_future_param": True})

        assert calls[-1]["temperature"] == 0.2
        assert calls[-1]["some_future_param"] is True

    def test_naming_a_raw_model_is_a_400_not_a_silent_coercion(self, client, org_key):
        # D32.7: silent coercion hides a misconfigured agent behind a bill.
        _, key = org_key
        r = client.post("/v1/chat/completions", headers=key, json={
            "model": "deepseek/deepseek-chat",
            "messages": [{"role": "user", "content": "hi"}]})

        assert r.status_code == 400
        assert "tier" in r.json()["detail"]

    def test_an_anonymous_caller_cannot_spend_our_provider_account(self, client):
        r = client.post("/v1/chat/completions", json={
            "model": "tier-balanced", "messages": [{"role": "user", "content": "hi"}]})
        assert r.status_code == 401


# ── Metering ────────────────────────────────────────────────────────────────

class TestMetering:
    def test_one_completion_writes_one_usage_row_attributed_to_the_key(
            self, client, org_key, db):
        slug, key = org_key
        rid = f"r-{uuid.uuid4().hex}"
        client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced", "request_id": rid,
            "messages": [{"role": "user", "content": "hi"}]})

        with db.begin() as c:
            row = c.execute(text(
                "SELECT o.slug, u.tier, u.model, u.prompt_tokens, "
                "       u.completion_tokens, u.cached_tokens, u.billed_credits "
                "FROM usage_event u JOIN organization o "
                "ON o.id = u.organization_id WHERE u.request_id = :r"
            ), {"r": rid}).first()

        assert row is not None
        assert row[0] == slug
        assert row[1] == "tier-balanced"
        assert row[2] == "deepseek/deepseek-v4-pro"
        assert (row[3], row[4]) == (1200, 40)
        # OpenAI-style nested cached_tokens, normalised.
        assert row[5] == 900
        # CP-4 is UNPRICED on purpose — CP-6 sets the card against this data.
        assert row[6] == Decimal("0.0000")

    def test_a_retried_request_id_writes_one_row_not_two(self, client, org_key, db):
        _, key = org_key
        rid = f"r-{uuid.uuid4().hex}"
        body = {"model": "tier-balanced", "request_id": rid,
                "messages": [{"role": "user", "content": "hi"}]}

        client.post("/v1/chat/completions", headers=key, json=body)
        second = client.post("/v1/chat/completions", headers=key, json=body)

        # The retry still gets its completion — dropping the row must not drop
        # the answer.
        assert second.status_code == 200
        with db.begin() as c:
            n = c.execute(text(
                "SELECT count(*) FROM usage_event WHERE request_id = :r"),
                {"r": rid}).scalar_one()
        assert n == 1

    def test_attribution_headers_land_on_the_usage_row(self, client, org_key, db):
        _, key = org_key
        rid = f"r-{uuid.uuid4().hex}"
        client.post("/v1/chat/completions",
                    headers={**key, "X-CC-Member": "alice@corp.com",
                             "X-CC-Agent": "email-assistant",
                             "X-CC-Module": "email", "X-CC-Run": "run-42"},
                    json={"model": "tier-balanced", "request_id": rid,
                          "messages": [{"role": "user", "content": "hi"}]})

        with db.begin() as c:
            row = c.execute(text(
                "SELECT user_email, agent, module_slug, run_id FROM usage_event "
                "WHERE request_id = :r"), {"r": rid}).first()

        assert row == ("alice@corp.com", "email-assistant", "email", "run-42")

    def test_a_call_without_a_request_id_is_still_metered(self, client, org_key, db):
        slug, key = org_key
        before = self._count(db, slug)
        client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced", "messages": [{"role": "user", "content": "hi"}]})
        assert self._count(db, slug) == before + 1

    def test_a_metering_failure_does_not_fail_the_completion(
            self, client, org_key, monkeypatch):
        # An unmetered call is a revenue problem; a failed call is a product
        # problem, and the product problem is worse.
        _, key = org_key
        from platform_api import main as main_mod

        def _boom(*a, **k):
            raise RuntimeError("ledger unavailable")

        monkeypatch.setattr(main_mod.store, "record_usage", _boom)

        r = client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-balanced", "messages": [{"role": "user", "content": "hi"}]})

        assert r.status_code == 200
        assert r.json() == PROVIDER_RESPONSE

    @staticmethod
    def _count(db, slug: str) -> int:
        with db.begin() as c:
            return c.execute(text(
                "SELECT count(*) FROM usage_event u JOIN organization o "
                "ON o.id = u.organization_id WHERE o.slug = :s"), {"s": slug}
            ).scalar_one()


# ── Usage extraction, across provider shapes ────────────────────────────────

class TestUsageExtraction:
    def test_anthropic_style_top_level_cache_counter(self):
        u = router_mod.usage_from_response({"usage": {
            "prompt_tokens": 100, "completion_tokens": 10,
            "cache_read_input_tokens": 60}})
        assert (u.prompt_tokens, u.completion_tokens, u.cached_tokens) == (100, 10, 60)

    def test_openai_style_nested_cache_counter(self):
        u = router_mod.usage_from_response({"usage": {
            "prompt_tokens": 100, "completion_tokens": 10,
            "prompt_tokens_details": {"cached_tokens": 60}}})
        assert u.cached_tokens == 60

    def test_a_response_with_no_usage_block_yields_zeros_not_an_error(self):
        u = router_mod.usage_from_response({"choices": []})
        assert (u.prompt_tokens, u.completion_tokens, u.cached_tokens) == (0, 0, 0)

    def test_garbage_never_raises(self):
        for junk in (None, "nonsense", 42, {"usage": "not-a-dict"},
                     {"usage": {"prompt_tokens": "many"}}):
            assert router_mod.usage_from_response(junk).prompt_tokens == 0


# ── Provider credentials ────────────────────────────────────────────────────

class TestProviderCredentials:
    def test_secrets_round_trip_and_are_not_stored_in_the_clear(
            self, db, monkeypatch):
        monkeypatch.setenv("CONTROL_PLANE_ENCRYPTION_KEY", ENC_KEY)
        enc = router_mod.encrypt_secret("sk-very-secret")

        assert "sk-very-secret" not in enc
        assert router_mod.decrypt_secret(enc) == "sk-very-secret"

    def test_a_byok_organizations_own_key_wins_over_the_platforms(
            self, client, db, monkeypatch):
        # §3.4: BYOK is a tier, not an exception — such an org is metered but
        # not charged for tokens, which also caps our exposure on big accounts.
        monkeypatch.setenv("CONTROL_PLANE_ENCRYPTION_KEY", ENC_KEY)
        slug = f"byok-{uuid.uuid4().hex[:8]}"
        org_id = client.post("/orgs/provision", headers=OP, json={
            "slug": slug, "name": "N",
            "owner_email": f"o@{slug}.com"}).json()["organization_id"]

        with db.connect() as c:
            tx = c.begin()
            c.execute(text(
                "INSERT INTO provider_credential (provider, secret_enc) "
                "VALUES ('anthropic', :s)"),
                {"s": router_mod.encrypt_secret("platform-key")})
            c.execute(text(
                "INSERT INTO provider_credential "
                "(provider, organization_id, secret_enc) "
                "VALUES ('anthropic', CAST(:o AS uuid), :s)"),
                {"o": org_id, "s": router_mod.encrypt_secret("customer-own-key")})

            own = router_mod.provider_credential(c, provider="anthropic",
                                                 org_id=org_id)
            platform = router_mod.provider_credential(c, provider="anthropic")
            tx.rollback()

        assert own[0] == "customer-own-key"
        assert platform[0] == "platform-key"

    def test_a_missing_credential_is_a_503_not_a_crash(self, client, org_key, db):
        _, key = org_key
        with db.begin() as c:
            c.execute(text(
                "INSERT INTO tier_binding (tier, model, effective_from) "
                "VALUES ('tier-orphan', 'nosuchprovider/model', "
                "        now() - interval '1 day') ON CONFLICT DO NOTHING"))

        r = client.post("/v1/chat/completions", headers=key, json={
            "model": "tier-orphan", "messages": [{"role": "user", "content": "hi"}]})

        assert r.status_code == 503
        assert "nosuchprovider" in r.json()["detail"]

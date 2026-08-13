"""CP-3 — the key resolves the tenant, and nothing else may.

Spec: ``project-docs/specs/platform_control_plane.md`` §4.3 / CP-3 ·
``user_management_contract.md`` R11 · D32.3.

The acceptance criterion, verbatim from the spec: *"a request bearing org A's key
and a forged ``X-CC-Member``/``X-CC-Org`` header for org B writes its
``usage_event`` under **org A**; a revoked key 401s; the key secret is never
logged (assert over the log record, not by reading the code)."*

All three are below, plus the case the criterion does not name and which is the
actual defect CP-3 closed: ``/usage/record`` used to take ``org_slug`` **in the
request body**, which made the caller the authority on which customer they were.
"""
from __future__ import annotations

import logging
import os
import uuid
from decimal import Decimal

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from platform_api.keys import split_key  # noqa: E402

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


@pytest.fixture(scope="module", autouse=True)
def _schema():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    eng = create_engine(_URL, future=True)
    with eng.begin() as conn:
        for rel in ("infra/platform/001_control_plane.sql",
                    "infra/platform/002_seed_catalog.sql"):
            with open(os.path.join(root, rel), encoding="utf-8") as fh:
                conn.exec_driver_sql(fh.read())


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("CONTROL_PLANE_OPERATOR_TOKEN", TOKEN)
    from platform_api.main import app
    return TestClient(app)


def _new_org(client, prefix: str = "org") -> str:
    slug = f"{prefix}-{uuid.uuid4().hex[:8]}"
    r = client.post("/orgs/provision", headers=OP, json={
        "slug": slug, "name": "N", "owner_email": f"o@{slug}.com",
        "core_seats": 3,
    })
    assert r.status_code == 200, r.text
    return slug


def _prefix_of(token: str) -> str:
    """The stored prefix of a key.

    Via ``split_key`` rather than a hand-rolled ``rsplit``, because the secret
    contains underscores and an rsplit lands somewhere inside it. This helper
    was written with ``rsplit`` first and it failed immediately — the same trap
    ``split_key``'s docstring warns about, hit a second time while testing the
    fix for it. Worse, it made ``test_one_org_cannot_revoke_anothers_key`` pass
    for the wrong reason: revocation "failed" because the prefix was garbage,
    not because the org scoping worked.
    """
    parsed = split_key(token)
    assert parsed is not None, token
    return parsed[0]


def _key_for(client, slug: str) -> str:
    r = client.post("/keys", headers=OP, json={"org_slug": slug})
    assert r.status_code == 200, r.text
    return r.json()["token"]


class TestKeyIssuance:
    def test_the_token_is_returned_once_and_never_stored(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)

        # Nothing that lists keys may ever hand back a token or a hash.
        listed = client.get(f"/keys?org_slug={slug}", headers=OP).json()["keys"]
        assert len(listed) == 1
        assert set(listed[0]) == {"prefix", "label", "created_at", "revoked"}
        assert token not in str(listed)

    def test_the_stored_row_holds_a_hash_not_the_secret(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)
        secret = token.split("_", 3)[3]

        eng = create_engine(_URL, future=True)
        with eng.begin() as c:
            hashes = [r[0] for r in c.execute(text("SELECT key_hash FROM llm_api_key"))]

        assert secret not in hashes
        assert all(len(h) == 64 for h in hashes)  # sha256 hex


class TestTheKeyResolvesTheTenant:
    def test_usage_is_billed_to_the_KEYS_org_not_a_forged_header(self, client):
        """THE acceptance criterion."""
        victim = _new_org(client, "victim")
        attacker = _new_org(client, "attacker")
        attacker_key = _key_for(client, attacker)

        client.post("/credits/grant", headers=OP,
                    json={"org_slug": victim, "credits": "1000"})
        client.post("/credits/grant", headers=OP,
                    json={"org_slug": attacker, "credits": "1000"})

        rid = f"req-{uuid.uuid4().hex}"
        r = client.post(
            "/usage/record",
            headers={
                "Authorization": f"Bearer {attacker_key}",
                # Every lever a caller could pull to name a different tenant.
                "X-CC-Org": victim,
                "X-CC-Member": f"ceo@{victim}.com",
            },
            json={"request_id": rid, "billed_credits": "50", "model": "m"},
        )
        assert r.status_code == 200, r.text

        # The charge landed on the KEY's organization...
        eng = create_engine(_URL, future=True)
        with eng.begin() as c:
            billed_slug = c.execute(text(
                "SELECT o.slug FROM usage_event u JOIN organization o "
                "ON o.id = u.organization_id WHERE u.request_id = :r"
            ), {"r": rid}).scalar_one()
        assert billed_slug == attacker

        # ...and the victim's balance is untouched.
        victim_balance = client.get(
            f"/credits/balance?org_slug={victim}", headers=OP).json()["balance"]
        assert Decimal(victim_balance) == Decimal("1000")

    def test_the_body_cannot_name_an_organization_at_all(self, client):
        # The defect CP-3 closed: org_slug used to be a body field. Pydantic
        # ignores unknown fields, so this must NOT silently redirect the charge.
        victim = _new_org(client, "victim")
        attacker = _new_org(client, "attacker")
        key = _key_for(client, attacker)
        rid = f"req-{uuid.uuid4().hex}"

        client.post("/usage/record",
                    headers={"Authorization": f"Bearer {key}"},
                    json={"request_id": rid, "billed_credits": "5",
                          "org_slug": victim, "organization_id": victim})

        eng = create_engine(_URL, future=True)
        with eng.begin() as c:
            slug = c.execute(text(
                "SELECT o.slug FROM usage_event u JOIN organization o "
                "ON o.id = u.organization_id WHERE u.request_id = :r"
            ), {"r": rid}).scalar_one()
        assert slug == attacker

    def test_a_forged_member_header_still_attributes_INSIDE_the_org(self, client):
        # Refining within the org is allowed and expected — that is what the
        # header is for. It is only crossing orgs that must be impossible.
        slug = _new_org(client)
        key = _key_for(client, slug)
        rid = f"req-{uuid.uuid4().hex}"

        client.post("/usage/record",
                    headers={"Authorization": f"Bearer {key}",
                             "X-CC-Member": "alice@corp.com",
                             "X-CC-Agent": "email-assistant"},
                    json={"request_id": rid, "billed_credits": "1"})

        eng = create_engine(_URL, future=True)
        with eng.begin() as c:
            row = c.execute(text(
                "SELECT user_email, agent FROM usage_event WHERE request_id = :r"
            ), {"r": rid}).first()
        assert row[0] == "alice@corp.com"
        assert row[1] == "email-assistant"


class TestRejection:
    def test_a_revoked_key_401s(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)
        prefix = _prefix_of(token)

        assert client.post("/keys/revoke", headers=OP, json={
            "org_slug": slug, "prefix": prefix}).json()["revoked"] is True

        r = client.post("/usage/record",
                        headers={"Authorization": f"Bearer {token}"},
                        json={"request_id": f"r-{uuid.uuid4().hex}"})
        assert r.status_code == 401

    def test_one_org_cannot_revoke_anothers_key(self, client):
        owner = _new_org(client, "owner")
        other = _new_org(client, "other")
        token = _key_for(client, owner)
        prefix = _prefix_of(token)

        r = client.post("/keys/revoke", headers=OP,
                        json={"org_slug": other, "prefix": prefix})
        assert r.json()["revoked"] is False

        # And the key still works.
        assert client.post("/usage/record",
                           headers={"Authorization": f"Bearer {token}"},
                           json={"request_id": f"r-{uuid.uuid4().hex}"}
                           ).status_code == 200

    @pytest.mark.parametrize("bad", [
        None, "", "Bearer ", "Bearer nonsense", "Bearer cc_live_nope_secret",
        "cc_live_a_b",  # no Bearer scheme
    ])
    def test_malformed_and_unknown_keys_401(self, client, bad):
        headers = {"Authorization": bad} if bad is not None else {}
        r = client.post("/usage/record", headers=headers,
                        json={"request_id": f"r-{uuid.uuid4().hex}"})
        assert r.status_code == 401

    def test_a_wrong_secret_on_a_REAL_prefix_401s(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)
        prefix = _prefix_of(token)

        r = client.post("/usage/record",
                        headers={"Authorization": f"Bearer {prefix}_wrongsecret"},
                        json={"request_id": f"r-{uuid.uuid4().hex}"})
        assert r.status_code == 401

    def test_unknown_and_wrong_secret_are_indistinguishable(self, client):
        # Distinguishing them tells an attacker which half of a guess was right.
        slug = _new_org(client)
        token = _key_for(client, slug)
        prefix = _prefix_of(token)

        wrong_secret = client.post(
            "/usage/record", headers={"Authorization": f"Bearer {prefix}_bad"},
            json={"request_id": "x"})
        unknown = client.post(
            "/usage/record",
            headers={"Authorization": "Bearer cc_live_ffffffffffff_bad"},
            json={"request_id": "x"})

        assert wrong_secret.status_code == unknown.status_code == 401
        assert wrong_secret.json() == unknown.json()

    def test_the_operator_token_does_not_open_the_key_surface(self, client):
        # Two schemes, not one with two passwords. A leaked staff token must not
        # become a licence to bill an arbitrary customer.
        r = client.post("/usage/record", headers=OP,
                        json={"request_id": f"r-{uuid.uuid4().hex}"})
        assert r.status_code == 401

    def test_a_key_does_not_open_the_operator_surface(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)

        r = client.post("/credits/grant",
                        headers={"Authorization": f"Bearer {token}"},
                        json={"org_slug": slug, "credits": "999999"})
        assert r.status_code == 401


class TestTheSecretNeverReachesALog:
    def test_no_log_record_contains_the_secret(self, client, caplog):
        """Asserted over the emitted records, not by reading the source."""
        slug = _new_org(client)

        with caplog.at_level(logging.DEBUG):
            token = _key_for(client, slug)
            secret = token.split("_", 3)[3]
            client.post("/usage/record",
                        headers={"Authorization": f"Bearer {token}"},
                        json={"request_id": f"r-{uuid.uuid4().hex}"})
            # A rejected key is the likelier leak path — error handlers love to
            # echo the offending input back into the log.
            client.post("/usage/record",
                        headers={"Authorization": f"Bearer {token}_tampered"},
                        json={"request_id": f"r-{uuid.uuid4().hex}"})

        blob = "\n".join(r.getMessage() for r in caplog.records)
        assert secret not in blob
        assert token not in blob

    def test_the_audit_row_records_the_prefix_not_the_token(self, client):
        slug = _new_org(client)
        token = _key_for(client, slug)
        secret = token.split("_", 3)[3]

        eng = create_engine(_URL, future=True)
        with eng.begin() as c:
            details = "\n".join(
                str(r[0]) for r in c.execute(text(
                    "SELECT detail FROM control_audit WHERE action = 'key.issue'"))
            )
        assert secret not in details
        assert token not in details

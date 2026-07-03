"""Unit tests for B6 Phase-5 Tier 0 — per-run integration credential scoping.

The executor materialises resolved integration credentials into ``os.environ``
so subprocess skill scripts can ``os.getenv`` them.  Previously it wrote each
var once and NEVER cleared it, so every secret ever used accumulated in the
shared gateway process env for its lifetime — any later/concurrent-idle agent
(incl. a prompt-injected one) could read another integration's secret regardless
of its own ``config.json`` scope.

Tier 0 makes this scoped: ``_inject_integrations_to_env`` returns a restore
token (the prior value of every var it SET), and ``_restore_integration_env``
puts each var back at the run teardown.  These tests lock that contract:

- only the run's own integrations are exported (scope);
- an operator-provided (already-present) var is neither overwritten nor deleted;
- teardown restores unset→deleted and pre-existing→prior value (no accumulation,
  no clobbering);
- teardown is idempotent / null-token safe and never raises.

See ``ai-company-brain/specs/permissions_sandbox_b6.md`` (Phase 5, Tier 0).
"""
from __future__ import annotations

import os

import orchestrator.executor as ex


# --------------------------------------------------------------------------
# Sample resolved-integration dicts (shape produced by build_integrations).
# --------------------------------------------------------------------------
_CLICKUP = {"clickup": {"api_token": "clk-secret-123", "workspace_id": "ws-9"}}
_APIFY = {"apify": {"api_token": "apify-secret-xyz"}}


def _clean(monkeypatch, *env_vars: str) -> None:
    """Ensure the named vars start absent so we test the unset→set→delete path."""
    for v in env_vars:
        monkeypatch.delenv(v, raising=False)


# --------------------------------------------------------------------------
# Scope: only this run's integrations are exported.
# --------------------------------------------------------------------------
def test_injects_only_this_runs_integrations(monkeypatch) -> None:
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID", "APIFY_API_TOKEN")

    token = ex._inject_integrations_to_env(_CLICKUP)

    assert os.environ["CLICKUP_API_TOKEN"] == "clk-secret-123"
    assert os.environ["CLICKUP_WORKSPACE_ID"] == "ws-9"
    # An integration NOT in this run's dict is never exported.
    assert "APIFY_API_TOKEN" not in os.environ
    # Token records both vars we set, each with prior value None (were unset).
    assert token == {"CLICKUP_API_TOKEN": None, "CLICKUP_WORKSPACE_ID": None}

    ex._restore_integration_env(token)


def test_restore_deletes_vars_that_were_unset_before(monkeypatch) -> None:
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID")

    token = ex._inject_integrations_to_env(_CLICKUP)
    assert "CLICKUP_API_TOKEN" in os.environ  # set during the "run"

    ex._restore_integration_env(token)

    # Teardown removes them — no accumulation into the shared env.
    assert "CLICKUP_API_TOKEN" not in os.environ
    assert "CLICKUP_WORKSPACE_ID" not in os.environ


def test_no_accumulation_across_two_sequential_runs(monkeypatch) -> None:
    """Run A's secret must be gone before Run B (different integration) starts."""
    _clean(monkeypatch, "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID", "APIFY_API_TOKEN")

    # Run A: clickup.
    tok_a = ex._inject_integrations_to_env(_CLICKUP)
    assert os.environ.get("CLICKUP_API_TOKEN") == "clk-secret-123"
    ex._restore_integration_env(tok_a)

    # Run B: apify — must NOT be able to read run A's leftover clickup secret.
    tok_b = ex._inject_integrations_to_env(_APIFY)
    assert "CLICKUP_API_TOKEN" not in os.environ, "run A's secret leaked into run B"
    assert os.environ.get("APIFY_API_TOKEN") == "apify-secret-xyz"
    ex._restore_integration_env(tok_b)

    assert "APIFY_API_TOKEN" not in os.environ


# --------------------------------------------------------------------------
# Operator .env wins: a pre-existing var is never touched.
# --------------------------------------------------------------------------
def test_preexisting_env_var_not_overwritten_and_not_recorded(monkeypatch) -> None:
    # Operator provided the value via gateway .env.
    monkeypatch.setenv("CLICKUP_API_TOKEN", "operator-provided-value")
    _clean(monkeypatch, "CLICKUP_WORKSPACE_ID")

    token = ex._inject_integrations_to_env(_CLICKUP)

    # We did NOT overwrite the operator's value...
    assert os.environ["CLICKUP_API_TOKEN"] == "operator-provided-value"
    # ...and we did NOT record it in the token (so teardown won't delete it).
    assert "CLICKUP_API_TOKEN" not in token
    # We DID export the one it didn't provide.
    assert token == {"CLICKUP_WORKSPACE_ID": None}

    ex._restore_integration_env(token)

    # The operator's value survives teardown; ours is cleaned up.
    assert os.environ["CLICKUP_API_TOKEN"] == "operator-provided-value"
    assert "CLICKUP_WORKSPACE_ID" not in os.environ


def test_restore_puts_back_a_prior_value_never_deletes_operator_var(monkeypatch) -> None:
    # Simulate a var that WAS present with a prior value the injector left alone.
    monkeypatch.setenv("APIFY_API_TOKEN", "prior-operator-token")

    token = ex._inject_integrations_to_env(_APIFY)
    # Untouched (operator wins) and unrecorded.
    assert os.environ["APIFY_API_TOKEN"] == "prior-operator-token"
    assert token == {}

    ex._restore_integration_env(token)
    assert os.environ["APIFY_API_TOKEN"] == "prior-operator-token"


# --------------------------------------------------------------------------
# Robustness: empty / null tokens, malformed dicts, blank creds.
# --------------------------------------------------------------------------
def test_restore_none_and_empty_token_is_safe() -> None:
    ex._restore_integration_env(None)   # must not raise
    ex._restore_integration_env({})     # must not raise


def test_blank_credential_values_are_skipped(monkeypatch) -> None:
    _clean(monkeypatch, "APIFY_API_TOKEN")
    token = ex._inject_integrations_to_env({"apify": {"api_token": ""}})
    assert token == {}
    assert "APIFY_API_TOKEN" not in os.environ


def test_non_dict_integration_value_is_ignored(monkeypatch) -> None:
    _clean(monkeypatch, "APIFY_API_TOKEN")
    token = ex._inject_integrations_to_env({"apify": "not-a-dict"})  # type: ignore[dict-item]
    assert token == {}


def test_unknown_integration_name_exports_nothing(monkeypatch) -> None:
    token = ex._inject_integrations_to_env({"not-a-real-service": {"api_key": "x"}})
    assert token == {}

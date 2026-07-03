"""Golden trajectory: per-run integration-credential scoping (B6 Phase-5 Tier 0).

Locks the SECURITY invariant, not just the mechanics: a credential materialised
into the shared process ``os.environ`` for run A must NOT still be readable when
run B (a different agent / different integration) starts. This is the concrete
"any agent can read any other integration's secret" hole the isolation work
closes at Tier 0.

If a future edit reverts ``_inject_integrations_to_env`` to write-and-never-clear
(or drops the teardown at any of the three run sites), the accumulation assertion
here fails.

See specs/permissions_sandbox_b6.md (Phase 5, Tier 0).
"""
from __future__ import annotations

import os

import orchestrator.executor as ex


def test_credentials_do_not_accumulate_across_runs(monkeypatch):
    """Simulate a sequence of runs and assert no secret outlives its own run."""
    for v in (
        "CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID",
        "APIFY_API_TOKEN", "INSTANTLY_API_KEY",
    ):
        monkeypatch.delenv(v, raising=False)

    runs = [
        ({"clickup": {"api_token": "A-clk", "workspace_id": "A-ws"}},
         ["CLICKUP_API_TOKEN", "CLICKUP_WORKSPACE_ID"]),
        ({"apify": {"api_token": "B-apify"}}, ["APIFY_API_TOKEN"]),
        ({"instantly": {"api_key": "C-inst"}}, ["INSTANTLY_API_KEY"]),
    ]

    seen_before: set[str] = set()
    for integrations, expected_vars in runs:
        # No prior run's secret is visible as this run begins.
        for var in seen_before:
            assert var not in os.environ, (
                f"{var} from a prior run leaked into a later run's env"
            )

        token = ex._inject_integrations_to_env(integrations)
        # This run's own creds are present during the run.
        for var in expected_vars:
            assert var in os.environ
        seen_before.update(expected_vars)

        # Run teardown (the finally / AsyncExitStack callback in the executor).
        ex._restore_integration_env(token)

        # Immediately after teardown, none of this run's creds remain.
        for var in expected_vars:
            assert var not in os.environ


def test_operator_env_survives_the_run_lifecycle(monkeypatch):
    """A gateway-.env-provided secret is never clobbered nor deleted by scoping."""
    monkeypatch.setenv("CLICKUP_API_TOKEN", "operator-value")
    monkeypatch.delenv("CLICKUP_WORKSPACE_ID", raising=False)

    token = ex._inject_integrations_to_env(
        {"clickup": {"api_token": "run-value", "workspace_id": "ws"}}
    )
    # Operator's value wins throughout.
    assert os.environ["CLICKUP_API_TOKEN"] == "operator-value"

    ex._restore_integration_env(token)
    # ...and still stands after teardown; only the run-scoped var is cleaned.
    assert os.environ["CLICKUP_API_TOKEN"] == "operator-value"
    assert "CLICKUP_WORKSPACE_ID" not in os.environ

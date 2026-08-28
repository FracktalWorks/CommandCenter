"""`/health` must say WHICH commit is serving, not merely that something is.

**The fence.** On 2026-08-26 a different product (Metorite, a fork) was
deployed onto the CommandCenter VPS and answered on
`commandcenter.fracktal.in` for two days. Every verifier we own went green
through it, because every one of them asked a liveness question:

  * `.github/workflows/vps-health.yml` — "any HTTP response means the stack
    is serving" (its own comment), hourly, green throughout;
  * `.github/workflows/deploy.yml` `verify()` — `/health` returns 200 and the
    workbench returns 2xx/3xx, which the foreign stack also satisfied.

The owner's symptom was "none of my apps are there". Nothing was wrong with
the apps: liveness had been mistaken for identity.

This module fences the endpoint half — `/health` carries a commit id. The two
consumer halves are shell and are fenced in their own workflows:
`deploy.yml` compares the served sha to `GITHUB_SHA` (did MY commit ship?) and
`vps-health.yml` runs `git cat-file -e` on it against a full checkout (is that
OUR history at all?). A SHA is used rather than a product name on purpose — a
rebranded fork inherits our string constants but cannot inherit our commits.
"""
from __future__ import annotations


def _fresh_sha(monkeypatch, **env):
    """Call `_deployed_sha()` with the import-time cache cleared."""
    from gateway.main import _deployed_sha

    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    _deployed_sha.cache_clear()
    try:
        return _deployed_sha()
    finally:
        _deployed_sha.cache_clear()


def test_health_reports_a_commit_identity(monkeypatch):
    """The endpoint carries `sha` — the field the verifiers read."""
    from fastapi.testclient import TestClient
    from gateway import main

    main._deployed_sha.cache_clear()
    monkeypatch.setenv("ACB_GIT_SHA", "a" * 40)
    try:
        with TestClient(main.app) as client:
            body = client.get("/health").json()
    finally:
        main._deployed_sha.cache_clear()

    assert body["status"] == "ok"
    # The whole point: liveness AND identity, in the same answer.
    assert body["sha"] == "a" * 40


def test_pinned_sha_wins_over_the_checkout(monkeypatch):
    """`ACB_GIT_SHA` lets the deploy pin what it believes it shipped."""
    assert _fresh_sha(monkeypatch, ACB_GIT_SHA="b" * 40) == "b" * 40


def test_a_garbage_answer_is_no_identity_rather_than_a_wrong_one(monkeypatch):
    """A partial or non-hex answer must resolve to `None`.

    A truncated sha read as an identity is worse than an absent one: absent
    is a state the verifiers can refuse on, whereas a malformed value that
    happens not to match reads as "wrong commit" and sends whoever is holding
    the incident after a deploy that actually succeeded.
    """
    import subprocess

    class _Result:
        returncode = 0
        stdout = "not-a-sha\n"

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Result())
    assert _fresh_sha(monkeypatch, ACB_GIT_SHA=None) is None


def test_identity_is_never_fatal(monkeypatch):
    """`git` missing or exploding must not take the liveness probe down.

    `/health` is what the on-box watchdog restarts services from. An identity
    lookup that could raise would turn "I cannot tell you which commit" into
    "the box is dead", and the watchdog would act on it.
    """
    import subprocess

    def _boom(*a, **k):
        raise OSError("git not found")

    monkeypatch.setattr(subprocess, "run", _boom)
    assert _fresh_sha(monkeypatch, ACB_GIT_SHA=None) is None


def test_a_real_checkout_resolves_to_forty_hex(monkeypatch):
    """In this repo the git fallback answers, and answers well-formed.

    This is the case the box runs in — `/opt/acb/app` is a checkout — so if
    the fallback were broken, the deployed boxes would report `null` and the
    verifiers would have nothing to compare.
    """
    sha = _fresh_sha(monkeypatch, ACB_GIT_SHA=None)
    assert sha is not None, "git fallback resolved nothing in a real checkout"
    assert len(sha) == 40
    assert all(c in "0123456789abcdef" for c in sha)

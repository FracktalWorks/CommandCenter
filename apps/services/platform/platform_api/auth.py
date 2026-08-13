"""Two authentication schemes, deliberately separate.

Spec: ``project-docs/specs/platform_control_plane.md`` §4.3 (CP-3) ·
``user_management_contract.md`` R11 ("never trust a tenant from request input").

  * **Operator** — a shared staff token. Reaches cross-organization surfaces:
    provisioning, seat writes, credit grants, the console.
  * **Organization key** — ``cc_live_<prefix>_<secret>``, one per customer.
    Reaches only that customer's own metering surface.

**The load-bearing rule: the KEY resolves the organization, and nothing else
may.** Attribution headers (``X-CC-Member``, ``X-CC-Agent``, ``X-CC-Module``,
``X-CC-Run``) refine *within* the organization the key already pinned. A forged
header can therefore misattribute usage inside one customer — annoying, and
their own problem — but can never move a call, a charge or a read to a different
customer.

This is why :func:`organization_from_key` returns the org id and the caller must
use it, rather than accepting an ``org_slug`` in the request body. A body field
naming the tenant is the exact shape R11 forbids: it makes the caller the
authority on who they are.
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException
from typing import Annotated

from platform_api import store
from platform_api.db import get_engine
from platform_api.keys import split_key, verify_secret

__all__ = ["Caller", "require_operator", "organization_from_key",
           "Operator", "KeyCaller"]


@dataclass(frozen=True)
class Caller:
    """A verified organization key holder."""

    organization_id: str
    key_prefix: str
    #: Attribution only. Never used to select rows, never used to authorise.
    member: str | None = None
    agent: str | None = None
    module_slug: str | None = None
    run_id: str | None = None


def require_operator(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Refuse anything that is not the operator. Fails CLOSED when unconfigured."""
    expected = os.environ.get("CONTROL_PLANE_OPERATOR_TOKEN", "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="CONTROL_PLANE_OPERATOR_TOKEN is not configured",
        )
    presented = ""
    if authorization and authorization.startswith("Bearer "):
        presented = authorization.removeprefix("Bearer ").strip()
    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def organization_from_key(
    authorization: Annotated[str | None, Header()] = None,
    x_cc_member: Annotated[str | None, Header()] = None,
    x_cc_agent: Annotated[str | None, Header()] = None,
    x_cc_module: Annotated[str | None, Header()] = None,
    x_cc_run: Annotated[str | None, Header()] = None,
) -> Caller:
    """Resolve the calling organization from its API key.

    Note what is deliberately absent: there is no ``X-CC-Org`` parameter and no
    ``org_slug`` body field. The organization is a property of the credential,
    full stop. If a caller sends ``X-CC-Org``, FastAPI ignores it — it is not
    bound anywhere — which is the desired outcome and is pinned by a test rather
    than left to a reader's confidence.

    Raises 401 for a missing, malformed, unknown or revoked key. The four cases
    return the SAME message on purpose: distinguishing "no such key" from "wrong
    secret" tells an attacker which half of their guess was right.
    """
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()

    parsed = split_key(token) if token else None
    if parsed is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    prefix, secret = parsed

    with get_engine().begin() as conn:
        resolved = store.resolve_key(conn, prefix=prefix)

    # Verify even when the prefix is unknown, against a dummy hash, so a bad
    # prefix and a bad secret take the same time. Without this, response timing
    # distinguishes "this prefix exists" from "it does not", which turns key
    # enumeration into a two-step problem instead of an infeasible one.
    _dummy = "0" * 64
    if resolved is None:
        verify_secret(secret, _dummy)
        raise HTTPException(status_code=401, detail="Invalid API key")

    organization_id, key_hash = resolved
    if not verify_secret(secret, key_hash):
        raise HTTPException(status_code=401, detail="Invalid API key")

    return Caller(
        organization_id=organization_id,
        key_prefix=prefix,
        member=x_cc_member,
        agent=x_cc_agent,
        module_slug=x_cc_module,
        run_id=x_cc_run,
    )


Operator = Annotated[None, Depends(require_operator)]
KeyCaller = Annotated[Caller, Depends(organization_from_key)]

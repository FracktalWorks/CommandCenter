"""Transport · connect — the onboarding helpers behind the Connect wizard (W11).

Two seams that turn "paste a curl command" into a guided, verifiable UI:

* ``POST /whatsapp/accounts/verify`` — TEST credentials against Meta's Graph API
  before saving. A 200 from the phone-number profile proves the token can act for
  this number and returns its display name / number / quality rating; a failure
  returns Meta's own message, cleaned up. Never writes anything.
* ``GET  /whatsapp/connection/info`` — the webhook Callback URL + a Verify Token
  the founder pastes into Meta → WhatsApp → Configuration. The URL comes from
  ``WHATSAPP_PUBLIC_URL`` when set (else the UI asks for the domain); the token
  defaults to ``WHATSAPP_VERIFY_TOKEN`` or a fresh suggestion the wizard also
  saves onto the account so the webhook handshake matches.
"""

from __future__ import annotations

import os
import secrets

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends
from gateway.routes.whatsapp.core import _instantiate_provider, router
from pydantic import BaseModel

_log = get_logger("gateway.whatsapp.connect")


def friendly_meta_error(exc: Exception) -> str:
    """Extract Meta's Graph error message from an httpx failure, or a short
    fallback. Pure/testable — the wizard shows this verbatim."""
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            body = resp.json()
            err = body.get("error") if isinstance(body, dict) else None
            if isinstance(err, dict) and err.get("message"):
                code = err.get("code")
                msg = str(err["message"])
                return f"{msg} (Meta code {code})" if code else msg
        except Exception:  # non-JSON error body
            pass
        status = getattr(resp, "status_code", None)
        if status:
            return f"Meta returned HTTP {status}."
    return str(exc)[:200] or "Could not reach Meta."


class VerifyRequest(BaseModel):
    phone_number_id: str
    access_token: str
    graph_version: str | None = None


class VerifyResponse(BaseModel):
    ok: bool
    display_phone_number: str | None = None
    verified_name: str | None = None
    quality_rating: str | None = None
    error: str | None = None


@router.post("/accounts/verify", response_model=VerifyResponse)
async def verify_account(
    req: VerifyRequest, user: UserContext = Depends(get_current_user),
):
    """Live-test WhatsApp credentials against Meta before the founder saves them.
    Returns the number's public profile on success, or a clear error."""
    if not req.phone_number_id.strip() or not req.access_token.strip():
        return VerifyResponse(
            ok=False, error="Phone number ID and access token are required.")
    creds: dict[str, str] = {
        "phone_number_id": req.phone_number_id.strip(),
        "access_token": req.access_token.strip(),
    }
    if req.graph_version:
        creds["graph_version"] = req.graph_version.strip()
    try:
        provider = _instantiate_provider("cloud_api", creds)
        profile = await provider.get_phone_number_profile()
    except Exception as exc:
        _log.info("whatsapp.verify.failed", error=str(exc)[:200])
        return VerifyResponse(ok=False, error=friendly_meta_error(exc))
    return VerifyResponse(
        ok=True,
        display_phone_number=profile.get("display_phone_number"),
        verified_name=profile.get("verified_name"),
        quality_rating=profile.get("quality_rating"),
    )


class ConnectionInfo(BaseModel):
    webhook_url: str            # full Callback URL, or "" when the base is unknown
    webhook_path: str = "/whatsapp/webhook"
    verify_token: str
    base_configured: bool       # False → the UI asks for the public domain


@router.get("/connection/info", response_model=ConnectionInfo)
async def connection_info(user: UserContext = Depends(get_current_user)):
    """The webhook Callback URL + a Verify Token for the Meta → Configuration
    step. The wizard also submits this token as the account's webhook_verify_token
    so the ``GET /whatsapp/webhook`` handshake matches."""
    base = os.environ.get("WHATSAPP_PUBLIC_URL", "").strip().rstrip("/")
    verify = (
        os.environ.get("WHATSAPP_VERIFY_TOKEN", "").strip()
        or f"cc-{secrets.token_urlsafe(18)}"
    )
    return ConnectionInfo(
        webhook_url=(f"{base}/whatsapp/webhook" if base else ""),
        verify_token=verify,
        base_configured=bool(base),
    )

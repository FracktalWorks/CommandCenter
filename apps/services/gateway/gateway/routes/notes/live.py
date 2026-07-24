"""Live transcription — mint a short-lived Deepgram token for the browser.

Live captions during a recording use Deepgram's streaming WebSocket. To keep the
gateway out of the audio path (spec §7 D7: "gateway stays SSE-only; it mints
tokens, the WS terminates elsewhere"), the browser connects to Deepgram
directly — but with an EPHEMERAL, ~1-minute, usage-scoped key minted here from
the long-lived ``DEEPGRAM_API_KEY``, never the real key. The authoritative
transcript is still the batch re-pass on stop; live is a fast draft.

Everything is best-effort and gated: if Deepgram isn't configured (or the key
lacks key-management scope), this returns 503 and the recorder silently falls
back to the existing chunked-upload → batch path — live captions just don't
appear. Spec: note_taker_app.md §5.2 / §6 (live captions).
"""

from __future__ import annotations

import os

import httpx
from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.notes.core import _log, router
from pydantic import BaseModel

_DG_API = "https://api.deepgram.com/v1"
_TOKEN_TTL_S = 60  # short — the browser refreshes if a recording runs long


def _deepgram_key() -> str:
    """The long-lived Deepgram master key. Both the startup key-load
    (``key_store.configure_litellm``) and the Settings key-save
    (``_inject_env_into_litellm``) write it to ``os.environ``, so that's the
    single canonical source."""
    return os.environ.get("DEEPGRAM_API_KEY", "").strip()


def _live_model() -> str:
    """The Deepgram model for live captions — the configured tier-stt model when
    it's a Deepgram one, else nova-3 (whisper can't stream, so live always uses
    Deepgram regardless of the batch model)."""
    try:
        from acb_llm.context import resolve_underlying_model

        resolved = resolve_underlying_model("tier-stt") or ""
        if resolved.startswith("deepgram/"):
            return resolved.split("/", 1)[1]
    except Exception:
        pass
    return "nova-3"


class LiveToken(BaseModel):
    token: str          # ephemeral Deepgram key (used as the WS auth subprotocol)
    model: str          # Deepgram model id, e.g. "nova-3"
    expires_in: int     # seconds


async def _mint_ephemeral_key(api_key: str) -> str:
    """Create a ~1-minute usage-scoped Deepgram key from the master key.

    Deepgram keys are project-scoped, so we discover the project first (or use
    DEEPGRAM_PROJECT_ID). Requires the master key to have key-management scope;
    if it doesn't, Deepgram returns 401/403 and we surface a 503.
    """
    headers = {"Authorization": f"Token {api_key}"}
    async with httpx.AsyncClient(timeout=8.0, headers=headers) as client:
        project_id = os.environ.get("DEEPGRAM_PROJECT_ID", "").strip()
        if not project_id:
            r = await client.get(f"{_DG_API}/projects")
            r.raise_for_status()
            projects = r.json().get("projects", [])
            if not projects:
                raise RuntimeError("Deepgram account has no projects")
            project_id = projects[0]["project_id"]

        r = await client.post(
            f"{_DG_API}/projects/{project_id}/keys",
            json={
                "comment": "commandcenter-notes-live (ephemeral)",
                "scopes": ["usage:write"],
                "time_to_live_in_seconds": _TOKEN_TTL_S,
            },
        )
        r.raise_for_status()
        key = r.json().get("key")
        if not key:
            raise RuntimeError("Deepgram returned no key")
        return str(key)


@router.post("/stt/live-token", response_model=LiveToken)
async def live_token(_user: UserContext = Depends(get_current_user)) -> LiveToken:
    api_key = _deepgram_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Live captions need Deepgram — add a DEEPGRAM_API_KEY in "
            "Settings → Models. Recording still works without it.",
        )
    try:
        token = await _mint_ephemeral_key(api_key)
    except Exception as exc:
        _log.warning("notes.live_token_failed", error=str(exc)[:200])
        raise HTTPException(
            status_code=503,
            detail="Could not start live captions (the Deepgram key may lack "
            "key-management scope). Recording continues without them.",
        ) from exc
    _log.info("notes.live_token_minted", model=_live_model())
    return LiveToken(token=token, model=_live_model(), expires_in=_TOKEN_TTL_S)

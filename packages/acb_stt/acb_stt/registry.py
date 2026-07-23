"""Provider resolution — BYOK keys from the encrypted store, env fallback.

Resolution order (spec: note_taker_app.md §3.4 / D3):
  1. explicit ``provider`` argument (a user/setting choice),
  2. ``NOTES_STT_PROVIDER`` env,
  3. first provider with a configured key, in preference order
     groq → deepgram → openai (Q1 lean: Groq for speed/cost; Deepgram ranks
     above OpenAI because it brings diarization).

Keys come from the same encrypted ``provider_keys`` store the LLM tiers use
(``acb_llm.key_store``), falling back to ``<PROVIDER>_API_KEY`` env vars when
the store is unavailable (tests, minimal deploys).
"""
from __future__ import annotations

import os

from acb_common import get_logger

from acb_stt.base import SttProvider
from acb_stt.providers import DeepgramSTT, GroqSTT, OpenAISTT
from acb_stt.types import SttError

_log = get_logger("acb_stt.registry")

_PROVIDERS: dict[str, type[SttProvider]] = {
    "groq": GroqSTT,
    "deepgram": DeepgramSTT,
    "openai": OpenAISTT,
}
_PREFERENCE = ("groq", "deepgram", "openai")

_ENV_KEYS = {
    "groq": "GROQ_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
    "openai": "OPENAI_API_KEY",
}


async def _api_key(provider: str) -> str:
    try:
        from acb_llm.key_store import get_key_store

        key = await get_key_store().get(provider)
        if key:
            return key
    except Exception:  # store not configured (no DB / no master key) → env
        pass
    return os.environ.get(_ENV_KEYS.get(provider, ""), "")


async def resolve_stt_provider(provider: str | None = None) -> SttProvider:
    """Return a ready-to-call provider, or raise SttError if none is usable."""
    name = (provider or os.environ.get("NOTES_STT_PROVIDER") or "").strip().lower()
    if name:
        cls = _PROVIDERS.get(name)
        if cls is None:
            raise SttError(name, f"unknown STT provider (known: {sorted(_PROVIDERS)})")
        key = await _api_key(name)
        if not key:
            raise SttError(name, "no API key configured (key store or env)")
        return cls(api_key=key)  # type: ignore[call-arg]
    for candidate in _PREFERENCE:
        key = await _api_key(candidate)
        if key:
            _log.info("acb_stt.provider_resolved", provider=candidate)
            return _PROVIDERS[candidate](api_key=key)  # type: ignore[call-arg]
    raise SttError(
        "none",
        "no STT provider configured — add a groq/deepgram/openai key in "
        "Settings → Models or set NOTES_STT_PROVIDER + an API key env var",
    )

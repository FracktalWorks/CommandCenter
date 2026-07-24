"""STT provider resolution.

There is a single provider now — the LiteLLM-backed one — because model
selection and provider routing are the platform's job (the ``tier-stt`` model
config + litellm), not this package's. The optional argument is a model alias
override (a tier alias or a concrete ``provider/model``); it defaults to the
configured ``tier-stt``. Spec: note_taker_app.md §3.4 (D3).
"""

from __future__ import annotations

from acb_stt.base import SttProvider
from acb_stt.litellm_provider import LiteLLMSTT


async def resolve_stt_provider(model_alias: str | None = None) -> SttProvider:
    """Return the STT provider. ``model_alias`` overrides the configured
    ``tier-stt`` model (e.g. a concrete ``openai/whisper-1`` or another tier)."""
    return LiteLLMSTT(model_alias=model_alias)

"""STT provider resolution.

Most models are reached through LiteLLM, because model selection and provider
routing are the platform's job (the ``tier-stt`` model config + litellm) rather
than this package's. The exception is **AssemblyAI**, whose batch API is
submit-then-poll and so can't be expressed as a LiteLLM ``atranscription`` call —
it gets a native provider selected here by model prefix.

Resolution is therefore: resolve the alias to a concrete model (``tier-stt`` by
default), then pick the provider that speaks it. Callers keep talking to one
``SttProvider`` interface either way. Spec: note_taker_app.md §3.4 (D3).
"""

from __future__ import annotations

from acb_stt.assemblyai_provider import AssemblyAISTT, is_assemblyai_model
from acb_stt.base import SttProvider
from acb_stt.litellm_provider import DEFAULT_STT_ALIAS, LiteLLMSTT


def _resolve_model(alias: str) -> str:
    """Concrete ``provider/model`` behind a tier alias ('' if unresolvable)."""
    try:
        from acb_llm.context import resolve_underlying_model

        return resolve_underlying_model(alias) or ""
    except Exception:
        # Tier config unavailable (tests, misconfig) — treat the alias as literal
        # so an explicit "assemblyai/…" still routes correctly.
        return alias or ""


async def resolve_stt_provider(model_alias: str | None = None) -> SttProvider:
    """Return the STT provider for ``model_alias`` (defaults to ``tier-stt``).

    An AssemblyAI model — whether passed directly or sitting behind the
    configured tier — gets the native provider; everything else goes to LiteLLM.
    """
    alias = model_alias or DEFAULT_STT_ALIAS
    concrete = alias if is_assemblyai_model(alias) else _resolve_model(alias)
    if is_assemblyai_model(concrete):
        return AssemblyAISTT(model_alias=concrete)
    return LiteLLMSTT(model_alias=model_alias)

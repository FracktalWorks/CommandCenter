"""acb_stt — speech-to-text through the platform's LiteLLM plumbing.

The STT analog of ``acb_llm``: the model is a configured tier (``tier-stt``,
editable in Settings → Models), keys come from the encrypted store, and
transcription is routed through ``litellm.atranscription`` — no bespoke HTTP
client, no separate key resolution. Swap the ``tier-stt`` model (Groq/OpenAI
whisper, Deepgram, or the future self-host faster-whisper endpoint) without
touching app code.
Spec: ai-company-brain/specs/note_taker_app.md §3.4.
"""
from acb_stt.base import SttProvider
from acb_stt.litellm_provider import LiteLLMSTT, normalize_transcription
from acb_stt.registry import resolve_stt_provider
from acb_stt.types import (
    AudioInput,
    SttCaps,
    SttError,
    SttOptions,
    TranscriptResult,
    TranscriptSegmentData,
    TranscriptWord,
)

__all__ = [
    "AudioInput",
    "LiteLLMSTT",
    "SttCaps",
    "SttError",
    "SttOptions",
    "SttProvider",
    "TranscriptResult",
    "TranscriptSegmentData",
    "TranscriptWord",
    "normalize_transcription",
    "resolve_stt_provider",
]

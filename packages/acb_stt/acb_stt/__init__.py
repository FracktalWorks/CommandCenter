"""acb_stt — pluggable speech-to-text provider layer.

The STT analog of ``acb_llm``: BYOK cloud providers today (Groq, OpenAI,
Deepgram), the self-host transcription service as another provider later —
one interface, encrypted keys, no hardwired engine.
Spec: ai-company-brain/specs/note_taker_app.md §3.4.
"""
from acb_stt.base import SttProvider
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
    "SttCaps",
    "SttError",
    "SttOptions",
    "SttProvider",
    "TranscriptResult",
    "TranscriptSegmentData",
    "TranscriptWord",
    "resolve_stt_provider",
]

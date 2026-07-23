"""Wire types for the STT provider layer.

Every provider — cloud BYOK (Groq/OpenAI/Deepgram) or the future self-host
transcription service — normalizes its response into ``TranscriptResult`` so
the notes pipeline is provider-agnostic (spec: note_taker_app.md §3.4).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class TranscriptWord:
    """A single word with timing offsets (seconds from recording start)."""

    text: str
    start_s: float
    end_s: float


@dataclass
class TranscriptSegmentData:
    """One utterance/segment — the click-to-seek unit stored in Postgres."""

    idx: int
    start_s: float
    end_s: float
    text: str
    speaker_label: str | None = None      # diarization label ('S1', 'S2', …)
    channel: str | None = None            # capture channel prior ('mic'|'system')
    confidence: float | None = None
    words: list[TranscriptWord] | None = None


@dataclass
class TranscriptResult:
    text: str                             # flattened full transcript
    segments: list[TranscriptSegmentData]
    provider: str
    model: str
    language: str | None = None
    duration_s: float | None = None
    diarized: bool = False                # True → speaker_label is real diarization


@dataclass
class SttOptions:
    language: str | None = None           # BCP-47 hint; None = auto-detect
    diarize: bool = True                  # providers that can't, ignore
    prompt: str | None = None             # vocabulary/glossary boost where supported
    model: str | None = None              # override the provider default


@dataclass
class SttCaps:
    diarization: bool = False
    word_timestamps: bool = False
    streaming: bool = False
    languages: str = "multilingual"


@dataclass
class AudioInput:
    """Audio handed to a provider — bytes plus enough metadata to send it."""

    data: bytes
    filename: str = "audio.webm"
    mime: str = "audio/webm"

    @property
    def size(self) -> int:
        return len(self.data)


class SttError(RuntimeError):
    """Provider-level transcription failure (auth, quota, format, …)."""

    def __init__(self, provider: str, message: str, status: int | None = None):
        self.provider = provider
        self.status = status
        super().__init__(f"[{provider}] {message}")


def flatten_text(segments: list[TranscriptSegmentData]) -> str:
    return " ".join(s.text.strip() for s in segments if s.text.strip())

"""STT provider interface."""
from __future__ import annotations

from abc import ABC, abstractmethod

from acb_stt.types import AudioInput, SttCaps, SttOptions, TranscriptResult


class SttProvider(ABC):
    """One transcription backend. Implementations are stateless beyond config;
    the registry constructs them with a resolved API key/endpoint."""

    name: str = "abstract"

    @abstractmethod
    def capabilities(self) -> SttCaps: ...

    @abstractmethod
    async def transcribe(self, audio: AudioInput, opts: SttOptions) -> TranscriptResult: ...

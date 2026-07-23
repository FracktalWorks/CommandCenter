"""OpenAI-compatible ``/audio/transcriptions`` providers (OpenAI, Groq, and any
self-host server that speaks the same contract, e.g. Speaches).

Uses ``verbose_json`` to get segment timings. No diarization on this contract —
segments come back speaker-less; the pipeline falls back to the capture-channel
prior until a diarizing tier is configured (spec: note_taker_app.md §3.4).
"""
from __future__ import annotations

from typing import Any

import httpx
from acb_common import get_logger

from acb_stt.base import SttProvider
from acb_stt.types import (
    AudioInput,
    SttCaps,
    SttError,
    SttOptions,
    TranscriptResult,
    TranscriptSegmentData,
    flatten_text,
)

_log = get_logger("acb_stt.openai_compat")

_TIMEOUT = httpx.Timeout(600.0, connect=15.0)  # long files transcribe slowly


class OpenAICompatSTT(SttProvider):
    name = "openai-compat"
    base_url = ""
    default_model = "whisper-1"

    def __init__(self, api_key: str, base_url: str | None = None):
        self._key = api_key
        if base_url:
            self.base_url = base_url

    def capabilities(self) -> SttCaps:
        return SttCaps(diarization=False, word_timestamps=False, streaming=False)

    async def transcribe(self, audio: AudioInput, opts: SttOptions) -> TranscriptResult:
        model = opts.model or self.default_model
        data: dict[str, Any] = {"model": model, "response_format": "verbose_json"}
        if opts.language:
            data["language"] = opts.language
        if opts.prompt:
            data["prompt"] = opts.prompt
        files = {"file": (audio.filename, audio.data, audio.mime)}
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {self._key}"},
                data=data,
                files=files,
            )
        if resp.status_code >= 400:
            raise SttError(self.name, resp.text[:500], status=resp.status_code)
        return self.parse(resp.json(), model=model)

    def parse(self, payload: dict[str, Any], model: str) -> TranscriptResult:
        segments = [
            TranscriptSegmentData(
                idx=i,
                start_s=float(seg.get("start") or 0.0),
                end_s=float(seg.get("end") or 0.0),
                text=str(seg.get("text") or "").strip(),
                # verbose_json avg_logprob is a log-prob, not a 0..1 confidence;
                # left unmapped rather than pretending (honest-progress rule).
                confidence=None,
            )
            for i, seg in enumerate(payload.get("segments") or [])
        ]
        text = str(payload.get("text") or "").strip() or flatten_text(segments)
        if not segments and text:
            # json-only responses (no segment timing) still yield one segment so
            # the UI has something to render; timings are unknown.
            segments = [TranscriptSegmentData(idx=0, start_s=0.0, end_s=0.0, text=text)]
        return TranscriptResult(
            text=text,
            segments=segments,
            provider=self.name,
            model=model,
            language=payload.get("language"),
            duration_s=float(payload["duration"]) if payload.get("duration") else None,
            diarized=False,
        )


class OpenAISTT(OpenAICompatSTT):
    name = "openai"
    base_url = "https://api.openai.com/v1"
    default_model = "whisper-1"  # verbose_json (segment timings) requires whisper-1


class GroqSTT(OpenAICompatSTT):
    name = "groq"
    base_url = "https://api.groq.com/openai/v1"
    default_model = "whisper-large-v3-turbo"

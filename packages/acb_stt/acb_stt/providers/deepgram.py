"""Deepgram STT — the Tier-A provider with native speaker diarization.

POSTs raw audio bytes to ``/v1/listen`` with ``diarize=true&utterances=true``;
utterances map 1:1 onto transcript segments with per-utterance speaker ints
(normalized to 'S1', 'S2', … labels).
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
    TranscriptWord,
    flatten_text,
)

_log = get_logger("acb_stt.deepgram")

_TIMEOUT = httpx.Timeout(600.0, connect=15.0)


class DeepgramSTT(SttProvider):
    name = "deepgram"
    base_url = "https://api.deepgram.com"
    default_model = "nova-3"

    def __init__(self, api_key: str, base_url: str | None = None):
        self._key = api_key
        if base_url:
            self.base_url = base_url

    def capabilities(self) -> SttCaps:
        return SttCaps(diarization=True, word_timestamps=True, streaming=False)

    async def transcribe(self, audio: AudioInput, opts: SttOptions) -> TranscriptResult:
        model = opts.model or self.default_model
        params: dict[str, Any] = {
            "model": model,
            "smart_format": "true",
            "punctuate": "true",
            "utterances": "true",
            "diarize": "true" if opts.diarize else "false",
        }
        # Deepgram auto-detects language unless pinned; nova models take
        # 'language=multi' for code-switched audio when no pin is given.
        params["language"] = opts.language or "multi"
        if opts.prompt:
            # keyterm boosts recognition of org jargon (nova-3 feature).
            terms = [t.strip() for t in opts.prompt.split(",") if t.strip()]
            if terms:
                params["keyterm"] = terms[:100]
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/v1/listen",
                params=params,
                headers={
                    "Authorization": f"Token {self._key}",
                    "Content-Type": audio.mime,
                },
                content=audio.data,
            )
        if resp.status_code >= 400:
            raise SttError(self.name, resp.text[:500], status=resp.status_code)
        return self.parse(resp.json(), model=model, diarized=opts.diarize)

    def parse(self, payload: dict[str, Any], model: str, diarized: bool) -> TranscriptResult:
        results = payload.get("results") or {}
        segments: list[TranscriptSegmentData] = []
        for i, utt in enumerate(results.get("utterances") or []):
            speaker = utt.get("speaker")
            words = [
                TranscriptWord(
                    text=str(w.get("punctuated_word") or w.get("word") or ""),
                    start_s=float(w.get("start") or 0.0),
                    end_s=float(w.get("end") or 0.0),
                )
                for w in (utt.get("words") or [])
            ]
            segments.append(
                TranscriptSegmentData(
                    idx=i,
                    start_s=float(utt.get("start") or 0.0),
                    end_s=float(utt.get("end") or 0.0),
                    text=str(utt.get("transcript") or "").strip(),
                    speaker_label=f"S{int(speaker) + 1}" if speaker is not None else None,
                    confidence=float(utt["confidence"]) if utt.get("confidence") else None,
                    words=words or None,
                )
            )
        channels = results.get("channels") or []
        alt0 = (channels[0].get("alternatives") or [{}])[0] if channels else {}
        text = str(alt0.get("transcript") or "").strip() or flatten_text(segments)
        language = channels[0].get("detected_language") if channels else None
        meta = payload.get("metadata") or {}
        return TranscriptResult(
            text=text,
            segments=segments,
            provider=self.name,
            model=model,
            language=language,
            duration_s=float(meta["duration"]) if meta.get("duration") else None,
            diarized=diarized and any(s.speaker_label for s in segments),
        )

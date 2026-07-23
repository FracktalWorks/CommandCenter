"""LiteLLM-backed speech-to-text.

Routes transcription through the SAME plumbing chat uses (acb_llm): the model is
resolved from the tier config (``tier-stt`` by default → e.g.
``groq/whisper-large-v3-turbo``, editable in Settings → Models), keys are loaded
from the encrypted store via ``_ensure_keys_loaded``, provider routing is
litellm's job (``litellm.atranscription``), and usage is emitted for
observability via ``_emit_usage``. No bespoke HTTP client, no separate key
resolution — STT is a configured model like every other model on the platform.
Spec: note_taker_app.md §3.4 (D3).
"""

from __future__ import annotations

import contextlib
import io
import os
from typing import Any

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

_log = get_logger("acb_stt.litellm")

# The STT model alias resolved through the tier system. Overridable per-call
# (opts.model) or globally via NOTES_STT_MODEL (a tier alias or concrete
# provider/model). Default routes to the configured tier-stt.
DEFAULT_STT_ALIAS = "tier-stt"


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Attribute-or-dict access — litellm responses are pydantic-ish objects."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def normalize_transcription(resp: Any, model: str, diarize: bool) -> TranscriptResult:
    """Map a litellm ``TranscriptionResponse`` (OpenAI verbose_json shape) into
    our provider-agnostic ``TranscriptResult``."""
    segments: list[TranscriptSegmentData] = []
    for i, s in enumerate(_get(resp, "segments") or []):
        words = None
        wraw = _get(s, "words")
        if wraw:
            words = [
                TranscriptWord(
                    text=str(_get(w, "word") or _get(w, "text") or ""),
                    start_s=float(_get(w, "start") or 0.0),
                    end_s=float(_get(w, "end") or 0.0),
                )
                for w in wraw
            ]
        # Deepgram-via-litellm may surface a speaker int; whisper never does.
        speaker = _get(s, "speaker")
        segments.append(
            TranscriptSegmentData(
                idx=i,
                start_s=float(_get(s, "start") or 0.0),
                end_s=float(_get(s, "end") or 0.0),
                text=str(_get(s, "text") or "").strip(),
                speaker_label=f"S{int(speaker) + 1}" if speaker is not None else None,
                words=words,
            )
        )
    text = str(_get(resp, "text") or "").strip() or flatten_text(segments)
    if not segments and text:
        # Providers that don't return segment timings still yield a renderable
        # transcript; timings are unknown.
        segments = [TranscriptSegmentData(idx=0, start_s=0.0, end_s=0.0, text=text)]
    dur = _get(resp, "duration")
    lang = _get(resp, "language")
    return TranscriptResult(
        text=text,
        segments=segments,
        provider="litellm",
        model=model,
        language=str(lang) if lang else None,
        duration_s=float(dur) if dur else None,
        diarized=diarize and any(s.speaker_label for s in segments),
    )


class LiteLLMSTT(SttProvider):
    name = "litellm"

    def __init__(self, model_alias: str | None = None):
        self._alias = model_alias or os.environ.get("NOTES_STT_MODEL") or DEFAULT_STT_ALIAS

    def capabilities(self) -> SttCaps:
        # Diarization depends on the resolved model; whisper via litellm returns
        # none (the pipeline falls back to the capture-channel prior). Word
        # timestamps come through verbose_json where the provider supplies them.
        return SttCaps(diarization=False, word_timestamps=True, streaming=False)

    async def transcribe(self, audio: AudioInput, opts: SttOptions) -> TranscriptResult:
        import litellm
        from acb_llm.client import (
            _emit_usage,
            _ensure_keys_loaded,
            ensure_model_registered,
        )
        from acb_llm.context import resolve_underlying_model

        alias = opts.model or self._alias
        model = resolve_underlying_model(alias)
        if not model:
            raise SttError("litellm", f"no STT model configured for alias '{alias}'")

        await _ensure_keys_loaded()
        ensure_model_registered(model)

        buf = io.BytesIO(audio.data)
        buf.name = audio.filename  # litellm/OpenAI infer the format from the name

        extra: dict[str, Any] = {"response_format": "verbose_json"}
        if opts.language:
            extra["language"] = opts.language
        if opts.prompt:
            extra["prompt"] = opts.prompt
        litellm.drop_params = True  # ignore params a given provider doesn't take

        try:
            resp = await litellm.atranscription(model=model, file=buf, **extra)
        except Exception as exc:
            raise SttError("litellm", str(exc)[:500]) from exc

        with contextlib.suppress(Exception):  # observability is best-effort
            _emit_usage(model, "", resp, source="gateway.routes.notes")

        _log.info("acb_stt.transcribed", model=model, alias=alias)
        return normalize_transcription(resp, model, diarize=opts.diarize)

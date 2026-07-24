"""Automation · voice-note transcription — voice notes join the brain (W4.3).

Dealers live on WhatsApp voice notes; today they land as a bare ``[voice]`` with
empty ``body_text``, invisible to triage, intent, commitments, and search. This
downloads the audio (via the account's Cloud API provider), transcribes it
through the platform STT tier (``acb_stt`` → LiteLLM), writes the text onto
``wa_messages.transcript_text``, and — crucially — RESETS the classifier
watermarks so the transcript flows through the SAME deterministic brain as text:
a spoken "will send the AWB tomorrow" becomes a real waiting-on commitment.

Doctrines carried from the rest of the vertical:
* STT is a network call, so this runs on demand / on a schedule, NOT in the hot
  webhook path.
* sentinel-on-failure: a download or STT error marks the media 'failed' and
  returns None — never a fabricated transcript.
* idempotent + watermarked: ``wa_media.transcription_status`` gates the batch so
  a note is transcribed once; a redelivered webhook re-inserts 'pending' only if
  the row is new (``ON CONFLICT DO NOTHING``).
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.core import (
    _get_db,
    _provider_for_account,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text
from whatsapp_ingestion.persist import is_transcribable

_log = get_logger("gateway.whatsapp.transcription")

# Bound one scheduled pass — STT cost + latency guard, mirroring the group
# summarizer's per-pass cap.
_MAX_PER_PASS = 25
_MAX_AUDIO_BYTES = 16 * 1024 * 1024      # Meta caps voice at 16 MB; skip beyond.


def _filename_for(mime: str | None) -> str:
    """A filename with an extension the STT provider can sniff from the mime."""
    ext = "ogg"
    if mime and "/" in mime:
        ext = mime.split("/", 1)[1].split(";", 1)[0].strip() or "ogg"
        # WhatsApp voice is audio/ogg; codecs suffixes ('ogg; codecs=opus') are
        # stripped above. Normalize a couple of common aliases.
        ext = {"mpeg": "mp3", "x-wav": "wav", "wave": "wav"}.get(ext, ext)
    return f"voice.{ext}"


async def transcribe_message(
    db: Any, account_id: str, message_id: str, provider: Any,
) -> str | None:
    """Transcribe one voice/audio message and fold the text into the brain.

    Returns the transcript, or None when the message isn't transcribable, has no
    downloadable media, produced an empty transcript, or STT/download failed
    (sentinel — never fabricated). Writes ``transcript_text`` and resets the
    intent/commitment watermarks so the next classifier pass re-reads the note.
    Does NOT commit — the caller owns the transaction.
    """
    row = (await db.execute(
        text("""SELECT m.kind, md.id AS media_id, md.wa_media_id, md.mime_type
                FROM wa_messages m
                JOIN wa_media md ON md.message_id = m.id
                WHERE m.id = :mid AND m.account_id = :aid
                ORDER BY md.created_at ASC
                LIMIT 1"""),
        {"mid": message_id, "aid": account_id},
    )).fetchone()
    if row is None or not row.wa_media_id:
        return None

    if not is_transcribable(row.kind, row.mime_type):
        await db.execute(
            text("UPDATE wa_media SET transcription_status = 'skipped' "
                 "WHERE id = :id"),
            {"id": str(row.media_id)},
        )
        return None

    try:
        content, mime = await provider.download_media(row.wa_media_id)
        if not content or len(content) > _MAX_AUDIO_BYTES:
            raise ValueError(f"audio unusable ({len(content or b'')} bytes)")
        from acb_stt import AudioInput, SttOptions, resolve_stt_provider
        stt = await resolve_stt_provider()
        result = await stt.transcribe(
            AudioInput(
                data=content,
                filename=_filename_for(mime or row.mime_type),
                mime=mime or row.mime_type or "audio/ogg",
            ),
            # Diarization is meaningless for a one-speaker voice note.
            SttOptions(diarize=False),
        )
        transcript = (result.text or "").strip()
    except Exception as exc:
        _log.warning("whatsapp.transcribe.failed",
                     message_id=message_id, error=str(exc)[:200])
        await db.execute(
            text("UPDATE wa_media SET transcription_status = 'failed' "
                 "WHERE id = :id"),
            {"id": str(row.media_id)},
        )
        return None

    # A successful-but-empty result is 'done' (nothing to add), not a failure.
    await db.execute(
        text("UPDATE wa_media SET transcription_status = 'done' WHERE id = :id"),
        {"id": str(row.media_id)},
    )
    if not transcript:
        return None

    # Fold the transcript into the message AND reset the classifier watermarks so
    # intent + commitment extraction re-run over it (they read an effective-text
    # that falls back to transcript_text).
    await db.execute(
        text("""UPDATE wa_messages
                SET transcript_text = :t,
                    rules_processed_at = NULL,
                    commitment_checked_at = NULL,
                    intent = NULL,
                    updated_at = now()
                WHERE id = :mid"""),
        {"t": transcript, "mid": message_id},
    )
    return transcript


async def _reclassify(db: Any, account_id: str) -> None:
    """Re-run the deterministic classifiers so fresh transcripts join triage."""
    from gateway.routes.whatsapp.automation.commitments import apply_commitments
    from gateway.routes.whatsapp.automation.intent import apply_intents
    await apply_intents(db, account_id)
    await apply_commitments(db, account_id)


async def transcribe_pending(account_id: str) -> int:
    """Transcribe up to ``_MAX_PER_PASS`` pending voice notes for an account,
    then re-run the classifiers once. A schedule/digest trigger, NOT the hot
    webhook path. Returns how many produced a transcript. Owns its transaction.
    """
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("""SELECT m.id
                    FROM wa_media md
                    JOIN wa_messages m ON m.id = md.message_id
                    WHERE m.account_id = :aid
                      AND md.transcription_status = 'pending'
                    ORDER BY m.sent_at DESC NULLS LAST
                    LIMIT :lim"""),
            {"aid": account_id, "lim": _MAX_PER_PASS},
        )).fetchall()
        if not rows:
            return 0
        provider, _store, _acc = await _provider_for_account(db, account_id)
        n = 0
        for r in rows:
            if await transcribe_message(db, account_id, str(r.id), provider):
                n += 1
        if n:
            await _reclassify(db, account_id)
        await db.commit()
        _log.info("whatsapp.transcribe_pending.done",
                  account_id=account_id, transcribed=n, scanned=len(rows))
        return n
    finally:
        await db.close()


# ── route ─────────────────────────────────────────────────────────────────────

class TranscriptModel(BaseModel):
    message_id: str
    transcript_text: str


async def _assert_message_owned(db: Any, message_id: str, user_email: str) -> str:
    row = (await db.execute(
        text("""SELECT m.account_id FROM wa_messages m
                JOIN wa_accounts a ON a.id = m.account_id
                WHERE m.id = :mid AND a.user_id = :uid"""),
        {"mid": message_id, "uid": user_email},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    return str(row.account_id)


@router.post("/messages/{message_id}/transcribe", response_model=TranscriptModel)
async def transcribe_voice_note(
    message_id: str, user: UserContext = Depends(get_current_user),
):
    """Transcribe one voice note on demand and fold it into triage."""
    db = await _get_db()
    try:
        account_id = await _assert_message_owned(
            db, message_id, user.email or "anonymous")
        provider, _store, _acc = await _provider_for_account(db, account_id)
        transcript = await transcribe_message(db, account_id, message_id, provider)
        if transcript is None:
            raise HTTPException(
                status_code=422,
                detail="No transcript — not a voice note, or transcription failed")
        await _reclassify(db, account_id)
        await db.commit()
        return TranscriptModel(message_id=message_id, transcript_text=transcript)
    finally:
        await db.close()

"""Transcription pipeline — the background job behind an upload.

Runs in-process (asyncio task) against the pluggable ``acb_stt`` provider
layer; state lives in ``summary_run`` so the UI can render honest per-stage
progress and failures are inspectable, never silent
(spec: note_taker_app.md §3.4/§5.4).
"""

from __future__ import annotations

import json
from pathlib import Path

from gateway.routes.notes.core import _get_db, _log, media_dir
from sqlalchemy import text


async def _set_run(db, run_id: str, **fields) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    await db.execute(
        text(f"UPDATE summary_run SET {sets} WHERE id = :run_id"),
        {"run_id": run_id, **fields},
    )


async def run_transcription(meeting_id: str, recording_id: str, run_id: str) -> None:
    """Transcribe one recording and persist segments. Never raises."""
    try:
        async with await _get_db() as db:
            rec = (
                await db.execute(
                    text("SELECT * FROM meeting_recording WHERE id = :id"),
                    {"id": recording_id},
                )
            ).fetchone()
            if rec is None:
                raise RuntimeError("recording row vanished before transcription")
            owner = (
                await db.execute(
                    text("SELECT owner_email FROM meeting WHERE id = :id"),
                    {"id": meeting_id},
                )
            ).fetchone()
            await _set_run(db, run_id, status="running", stage="transcribe")
            await db.execute(
                text("UPDATE summary_run SET started_at = now() WHERE id = :id"),
                {"id": run_id},
            )
            await db.commit()

        path = media_dir() / rec.artifact_path
        audio_bytes = Path(path).read_bytes()

        # Bias transcription toward the owner's org vocabulary (glossary).
        from gateway.routes.notes.glossary import glossary_prompt

        prompt = await glossary_prompt(owner.owner_email if owner else "")

        from acb_stt import AudioInput, SttOptions, resolve_stt_provider

        provider = await resolve_stt_provider()
        result = await provider.transcribe(
            AudioInput(data=audio_bytes, filename=path.name, mime=rec.mime),
            SttOptions(diarize=True, prompt=prompt or None),
        )

        async with await _get_db() as db:
            # Replace this recording's segments (re-transcription safe).
            await db.execute(
                text("DELETE FROM transcript_segment WHERE recording_id = :rid"),
                {"rid": recording_id},
            )
            for seg in result.segments:
                await db.execute(
                    text(
                        """
                        INSERT INTO transcript_segment
                            (meeting_id, recording_id, idx, start_s, end_s, text,
                             speaker_label, channel, confidence, words)
                        VALUES (:meeting_id, :rid, :idx, :start_s, :end_s, :text,
                                :speaker, :channel, :confidence,
                                CAST(:words AS JSONB))
                        """
                    ),
                    {
                        "meeting_id": meeting_id,
                        "rid": recording_id,
                        "idx": seg.idx,
                        "start_s": seg.start_s,
                        "end_s": seg.end_s,
                        "text": seg.text,
                        # Without diarization the capture channel is the honest
                        # speaker prior (mic = you, system = them).
                        "speaker": seg.speaker_label,
                        "channel": seg.channel or rec.channel,
                        "confidence": seg.confidence,
                        "words": json.dumps(
                            [{"w": w.text, "s": w.start_s, "e": w.end_s} for w in seg.words]
                        )
                        if seg.words
                        else None,
                    },
                )
            await db.execute(
                text(
                    """
                    UPDATE meeting SET
                        transcript = :transcript,
                        transcript_source = :source,
                        language = COALESCE(:language, language),
                        duration_s = COALESCE(:duration, duration_s),
                        status = 'ready',
                        end_at = COALESCE(end_at, now())
                    WHERE id = :id
                    """
                ),
                {
                    "id": meeting_id,
                    # result.model is the resolved litellm id (e.g.
                    # "groq/whisper-large-v3-turbo") — already provider-prefixed.
                    "transcript": result.text,
                    "source": result.model,
                    "language": result.language,
                    "duration": result.duration_s,
                },
            )
            await db.execute(
                text(
                    "UPDATE meeting_recording SET duration_s = COALESCE(:d, duration_s) "
                    "WHERE id = :id"
                ),
                {"id": recording_id, "d": result.duration_s},
            )
            await _set_run(
                db, run_id, status="done", stage="done",
                model=result.model,
                result=json.dumps(
                    {
                        "segments": len(result.segments),
                        "diarized": result.diarized,
                        "language": result.language,
                    }
                ),
            )
            await db.execute(
                text("UPDATE summary_run SET finished_at = now() WHERE id = :id"),
                {"id": run_id},
            )
            await db.commit()
        _log.info(
            "notes.transcription_done",
            meeting_id=meeting_id, run_id=run_id,
            segments=len(result.segments), provider=result.provider,
        )
        # Chain straight into notes generation so a single upload yields
        # transcript → notes without a second user action.
        if result.segments:
            try:
                from gateway.routes.notes.summaries import enqueue_summary

                await enqueue_summary(meeting_id)
            except Exception as exc:
                _log.warning("notes.autosummary_enqueue_failed", error=str(exc)[:200])
    except Exception as exc:
        _log.error("notes.transcription_failed", meeting_id=meeting_id, error=str(exc))
        try:
            async with await _get_db() as db:
                await _set_run(db, run_id, status="failed", error=str(exc)[:2000])
                await db.execute(
                    text(
                        "UPDATE summary_run SET finished_at = now() WHERE id = :id"
                    ),
                    {"id": run_id},
                )
                await db.execute(
                    text("UPDATE meeting SET status = 'failed' WHERE id = :id"),
                    {"id": meeting_id},
                )
                await db.commit()
        except Exception as exc2:  # DB down — nothing left to record to
            _log.error("notes.transcription_failure_unrecorded", error=str(exc2))

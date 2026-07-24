"""Unit tests for WhatsApp voice-note transcription (W4.3).

No real STT / provider / Postgres: a fake provider yields audio bytes, a patched
``resolve_stt_provider`` yields a canned transcript, and a FakeDB records the
UPDATEs so the status lifecycle + watermark reset are pinned without a model.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from gateway.routes.whatsapp.automation.transcription import (
    _filename_for,
    transcribe_message,
)

# ── pure helpers ──────────────────────────────────────────────────────────────

def test_filename_extension_from_mime() -> None:
    assert _filename_for("audio/ogg") == "voice.ogg"
    assert _filename_for("audio/ogg; codecs=opus") == "voice.ogg"
    assert _filename_for("audio/mpeg") == "voice.mp3"        # aliased
    assert _filename_for(None) == "voice.ogg"                # default


# ── fakes ─────────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _MediaRow:
    def __init__(self, kind="voice", mime="audio/ogg", wa_media_id="V1"):
        self.kind = kind
        self.media_id = "media-uuid"
        self.wa_media_id = wa_media_id
        self.mime_type = mime


class _FakeDB:
    def __init__(self, media_row):
        self._media_row = media_row
        self.updates: list[tuple[str, dict]] = []

    async def execute(self, statement, params=None):
        sql = str(statement)
        if sql.lstrip().upper().startswith("SELECT"):
            return _Result(self._media_row)
        self.updates.append((sql, params or {}))
        return _Result(None)

    def status_writes(self) -> list[str]:
        out = []
        for sql, _ in self.updates:
            for st in ("pending", "done", "failed", "skipped"):
                if f"'{st}'" in sql:
                    out.append(st)
        return out

    def message_update(self) -> dict | None:
        for sql, params in self.updates:
            if "SET transcript_text" in sql:
                return params
        return None


class _FakeProvider:
    def __init__(self, content=b"audiobytes", mime="audio/ogg", fail=False):
        self._content = content
        self._mime = mime
        self._fail = fail

    async def download_media(self, wa_media_id):
        if self._fail:
            raise RuntimeError("download boom")
        return self._content, self._mime


def _patch_stt(text_val="", raises=False):
    class _STT:
        async def transcribe(self, audio, opts):
            if raises:
                raise RuntimeError("stt boom")
            return SimpleNamespace(text=text_val, segments=[], provider="fake",
                                   model="fake")

    async def _resolve(*a, **k):
        return _STT()

    return patch("acb_stt.resolve_stt_provider", _resolve)


# ── transcribe_message orchestration ──────────────────────────────────────────

async def test_success_writes_transcript_and_resets_watermarks() -> None:
    db = _FakeDB(_MediaRow())
    with _patch_stt("kal AWB bhej dunga"):
        out = await transcribe_message(db, "acc", "msg-1", _FakeProvider())
    assert out == "kal AWB bhej dunga"
    assert "done" in db.status_writes()
    upd = db.message_update()
    assert upd is not None and upd["t"] == "kal AWB bhej dunga"
    # the watermark reset is in the same UPDATE (SQL sets them to NULL)
    reset_sql = next(s for s, _ in db.updates if "SET transcript_text" in s)
    assert "rules_processed_at = NULL" in reset_sql
    assert "commitment_checked_at = NULL" in reset_sql


async def test_non_voice_media_is_skipped() -> None:
    db = _FakeDB(_MediaRow(kind="image", mime="image/jpeg"))
    out = await transcribe_message(db, "acc", "msg-1", _FakeProvider())
    assert out is None
    assert "skipped" in db.status_writes()
    assert db.message_update() is None            # nothing folded into the brain


async def test_download_failure_marks_failed_and_returns_none() -> None:
    db = _FakeDB(_MediaRow())
    with _patch_stt("unused"):
        out = await transcribe_message(db, "acc", "msg-1", _FakeProvider(fail=True))
    assert out is None
    assert "failed" in db.status_writes()
    assert db.message_update() is None            # sentinel — never fabricated


async def test_stt_failure_marks_failed_and_returns_none() -> None:
    db = _FakeDB(_MediaRow())
    with _patch_stt(raises=True):
        out = await transcribe_message(db, "acc", "msg-1", _FakeProvider())
    assert out is None
    assert "failed" in db.status_writes()


async def test_empty_transcript_is_done_not_written() -> None:
    db = _FakeDB(_MediaRow())
    with _patch_stt(""):                           # STT returned nothing usable
        out = await transcribe_message(db, "acc", "msg-1", _FakeProvider())
    assert out is None
    assert "done" in db.status_writes()
    assert db.message_update() is None             # no transcript_text write


async def test_no_media_row_returns_none() -> None:
    db = _FakeDB(None)
    out = await transcribe_message(db, "acc", "msg-1", _FakeProvider())
    assert out is None
    assert db.updates == []


def test_transcribe_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/messages/{message_id}/transcribe" in paths

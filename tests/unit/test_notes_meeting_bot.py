"""Tests for the meeting-bot pure logic (URL/platform, status mapping, media
extraction, config gating). The provider HTTP calls + poller are integration
concerns verified against a live Recall key; here we lock the deterministic
parts that must hold with no network and no key."""
from __future__ import annotations

from gateway.routes.notes import meeting_bot as mb

# ── platform detection ───────────────────────────────────────────────────────

def test_detect_platform_known_hosts() -> None:
    assert mb.detect_platform("https://meet.google.com/abc-defg-hij") == "meet"
    assert mb.detect_platform("https://us02web.zoom.us/j/123456789") == "zoom"
    assert mb.detect_platform("https://teams.microsoft.com/l/meetup-join/x") == "teams"
    assert mb.detect_platform("https://teams.live.com/meet/xyz") == "teams"


def test_detect_platform_unknown_is_other() -> None:
    assert mb.detect_platform("https://example.com/room/42") == "other"


def test_is_supported_url() -> None:
    assert mb.is_supported_url("https://meet.google.com/abc") is True
    assert mb.is_supported_url("http://zoom.us/j/1") is True
    assert mb.is_supported_url("not a url") is False
    assert mb.is_supported_url("ftp://host/x") is False
    assert mb.is_supported_url("") is False


# ── status mapping ───────────────────────────────────────────────────────────

def test_normalize_status_maps_recall_codes() -> None:
    assert mb.normalize_status("joining_call") == "joining"
    assert mb.normalize_status("in_waiting_room") == "waiting_room"
    assert mb.normalize_status("in_call_recording") == "in_call"
    assert mb.normalize_status("call_ended") == "processing"
    assert mb.normalize_status("done") == "done"
    assert mb.normalize_status("fatal") == "failed"
    assert mb.normalize_status("recording_permission_denied") == "not_admitted"


def test_normalize_status_unknown_is_none() -> None:
    # Unknown / missing codes leave the status untouched (None).
    assert mb.normalize_status("some_future_code") is None
    assert mb.normalize_status(None) is None
    assert mb.normalize_status("") is None


def test_latest_status_code_prefers_last_change() -> None:
    bot = {"status_changes": [{"code": "joining_call"}, {"code": "in_call_recording"}]}
    assert mb.latest_status_code(bot) == "in_call_recording"


def test_latest_status_code_falls_back_to_status_field() -> None:
    assert mb.latest_status_code({"status": {"code": "done"}}) == "done"
    assert mb.latest_status_code({"status": "joining_call"}) == "joining_call"
    assert mb.latest_status_code({}) is None


# ── media download extraction ────────────────────────────────────────────────

def test_extract_download_url_prefers_mixed_audio() -> None:
    bot = {
        "recordings": [
            {
                "media_shortcuts": {
                    "audio_mixed": {"data": {"download_url": "https://x/audio.m4a"}},
                    "video_mixed": {"data": {"download_url": "https://x/video.mp4"}},
                }
            }
        ]
    }
    assert mb.extract_download_url(bot) == "https://x/audio.m4a"


def test_extract_download_url_falls_back_to_video_then_legacy() -> None:
    video_only = {
        "recordings": [
            {"media_shortcuts": {"video_mixed": {"data": {"download_url": "https://x/v.mp4"}}}}
        ]
    }
    assert mb.extract_download_url(video_only) == "https://x/v.mp4"
    assert mb.extract_download_url({"video_url": "https://legacy/v.mp4"}) == "https://legacy/v.mp4"
    assert mb.extract_download_url({}) is None
    assert mb.extract_download_url({"recordings": []}) is None


# ── config gating (feature is inert without a key) ───────────────────────────

def test_bot_configured_requires_key(monkeypatch) -> None:
    monkeypatch.delenv("RECALL_API_KEY", raising=False)
    monkeypatch.setenv("NOTES_BOT_PROVIDER", "recall")
    assert mb.bot_configured() is False
    assert mb.resolve_bot_provider() is None
    monkeypatch.setenv("RECALL_API_KEY", "test-key")
    assert mb.bot_configured() is True
    assert mb.resolve_bot_provider() is not None


def test_recall_base_url_from_region(monkeypatch) -> None:
    monkeypatch.delenv("RECALL_BASE_URL", raising=False)
    monkeypatch.setenv("RECALL_REGION", "eu-central-1")
    assert mb._recall_base() == "https://eu-central-1.recall.ai/api/v1"
    monkeypatch.setenv("RECALL_BASE_URL", "https://custom.example/api/v1/")
    assert mb._recall_base() == "https://custom.example/api/v1"


# ── self-hosted provider (fully in-house, the default) ───────────────────────

def test_default_provider_is_selfhosted_and_inert(monkeypatch) -> None:
    monkeypatch.delenv("NOTES_BOT_PROVIDER", raising=False)
    monkeypatch.delenv("MEETING_BOT_URL", raising=False)
    # The default is the in-house worker; with no worker URL it stays inert.
    assert mb._provider_name() == "selfhosted"
    assert mb.bot_configured() is False
    assert mb.resolve_bot_provider() is None


def test_selfhosted_configured_requires_worker_url(monkeypatch) -> None:
    monkeypatch.setenv("NOTES_BOT_PROVIDER", "selfhosted")
    monkeypatch.delenv("MEETING_BOT_URL", raising=False)
    assert mb.bot_configured() is False
    assert mb.resolve_bot_provider() is None
    monkeypatch.setenv("MEETING_BOT_URL", "http://meeting-bot:8080/")
    assert mb.bot_configured() is True
    prov = mb.resolve_bot_provider()
    assert isinstance(prov, mb.SelfHostedProvider)
    # Trailing slash is trimmed so path joins are clean.
    assert prov._base == "http://meeting-bot:8080"


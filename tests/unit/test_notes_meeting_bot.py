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



# ── a failure has to stay visible ────────────────────────────────────────────

def test_active_query_keeps_recent_failures_visible() -> None:
    """A bot that fails leaves the active set instantly, so the surface the user
    was watching just empties — "it didn't work" becomes indistinguishable from
    "nothing happened", and the error text becomes unreachable. Recent failures
    stay in the query so there is somewhere for the explanation to appear."""
    sql = mb._ACTIVE_SQL
    assert "'failed'" in sql
    assert "'not_admitted'" in sql
    assert mb._RECENT_FAILURE_WINDOW in sql
    # Still bounded — a week-old failure must not haunt the live surface.
    assert "updated_at >" in sql


def test_terminal_failure_statuses_are_not_active() -> None:
    """The window above is a display concern only; polling must still stop."""
    assert "failed" not in mb.ACTIVE_STATUSES
    assert "not_admitted" not in mb.ACTIVE_STATUSES


# ── Platform support is enforced, not implied ────────────────────────────────
# The self-hosted worker's join flow is written against Google Meet's DOM. A
# Zoom or Teams link used to be ACCEPTED and dispatched, and the bot then
# reported "no join button on the meeting page" — a baffling answer to "why
# didn't it join my Teams call?". The honest refusal belongs at dispatch.

def test_only_meet_is_driveable_by_the_selfhosted_worker() -> None:
    from gateway.routes.notes.meeting_bot import SELFHOSTED_PLATFORMS

    assert SELFHOSTED_PLATFORMS == ("meet",)


def test_zoom_and_teams_links_are_still_recognised_as_their_platform() -> None:
    """Detection must keep working even though we can't join them — the tag is
    what tells the user WHICH platform we're declining."""
    from gateway.routes.notes.meeting_bot import detect_platform

    assert detect_platform("https://us02web.zoom.us/j/123456789") == "zoom"
    assert detect_platform(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc"
    ) == "teams"
    assert detect_platform("https://meet.google.com/abc-defg-hij") == "meet"


def test_unsupported_message_names_the_platform_and_an_alternative() -> None:
    """A refusal that doesn't say what to do instead is just a dead end."""
    from gateway.routes.notes.meeting_bot import unsupported_platform_message

    zoom = unsupported_platform_message("zoom")
    assert "Zoom" in zoom
    assert "upload" in zoom.lower(), "must point at the path that does work"

    teams = unsupported_platform_message("teams")
    assert "Teams" in teams

    # An unknown platform must still produce usable guidance, not a KeyError.
    other = unsupported_platform_message("wildly-unknown")
    assert "upload" in other.lower()

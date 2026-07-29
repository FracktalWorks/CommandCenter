"""Guards for the meeting-bot's deployment wiring.

The worker only ever runs on the VPS, so a mistake here (a port collision with
the gateway, a service that quietly joins the core profile, a missing shared
secret) wouldn't show up in any other test — it would show up as a broken
deploy. These pin the contract between the compose service and the deploy step.
"""
from __future__ import annotations

import pathlib

import yaml

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_COMPOSE = _ROOT / "infra/docker-compose.yml"
_DEPLOY = _ROOT / ".github/workflows/deploy.yml"

# The gateway's own port on the VPS (deploy/hostinger/acb-gateway.service).
_GATEWAY_PORT = "8080"


def _service() -> dict:
    return yaml.safe_load(_COMPOSE.read_text())["services"]["meeting-bot"]


def test_meeting_bot_is_not_in_the_core_profile() -> None:
    """Each in-call bot is a real Chrome (~1-3 GB). It must never start just
    because someone brought up the core stack."""
    profiles = _service()["profiles"]
    assert "meetingbot" in profiles
    assert "core" not in profiles


def test_host_port_does_not_collide_with_the_gateway() -> None:
    """The gateway owns 8080 on the VPS; publishing the bot there would break
    the whole app rather than just the bot."""
    ports = _service()["ports"]
    assert len(ports) == 1
    host_side = str(ports[0]).split(":")
    # "127.0.0.1:8095:8080" → bound to loopback, host 8095, container 8080
    assert host_side[0] == "127.0.0.1", "must not be reachable off-box"
    assert host_side[1] != _GATEWAY_PORT, "collides with the gateway"


def test_chrome_gets_enough_shared_memory() -> None:
    """Docker's default 64 MB /dev/shm makes Chrome crash on real pages."""
    assert _service()["shm_size"] == "1gb"


def test_worker_can_reach_the_gateway_for_live_callbacks() -> None:
    assert "host.docker.internal:host-gateway" in _service()["extra_hosts"]


def test_recordings_survive_a_container_restart() -> None:
    compose = yaml.safe_load(_COMPOSE.read_text())
    assert any("/data" in str(v) for v in _service()["volumes"])
    assert "acb-meeting-bot-data" in compose["volumes"]


# ── deploy step ──────────────────────────────────────────────────────────────

def test_deploy_wires_the_gateway_to_the_worker() -> None:
    """Without these the bot would run but the gateway couldn't dispatch to it."""
    deploy = _DEPLOY.read_text()
    assert 'upsert_env MEETING_BOT_URL "http://127.0.0.1:8095"' in deploy
    assert 'upsert_env NOTES_BOT_PROVIDER "selfhosted"' in deploy
    # The worker calls back from inside its container, so localhost won't do.
    assert 'NOTES_LIVE_CALLBACK_BASE "http://host.docker.internal:8080"' in deploy


def test_deploy_generates_the_shared_secret_once() -> None:
    deploy = _DEPLOY.read_text()
    assert "MEETING_BOT_TOKEN=$_mbtoken" in deploy
    # Only generated when absent — regenerating each deploy would break the
    # gateway/worker pair until both restarted.
    assert "grep -qE '^MEETING_BOT_TOKEN=.+' \"$ENV_FILE\"" in deploy


def test_deploy_passes_the_app_env_file_explicitly() -> None:
    """Compose resolves a bare .env against the project dir (infra/), not the
    app root — so the substitutions would silently come out empty."""
    deploy = _DEPLOY.read_text()
    assert 'docker compose --env-file "$ENV_FILE" -f infra/docker-compose.yml' in deploy


def test_meeting_bot_failure_cannot_fail_the_deploy() -> None:
    """A bot build hiccup must skip the bot, never take down a deploy."""
    deploy = _DEPLOY.read_text()
    assert "meeting bot build/start failed" in deploy


def test_live_caption_credentials_are_wired_by_default() -> None:
    """Without a token URL the bot joins, records, and emits no captions — a
    failure that looks like success until the meeting ends. The deploy sets it
    rather than leaving it opt-in, and compose has to pass it through."""
    env = _service()["environment"]
    assert "LIVE_TOKEN_URL" in env, "compose must pass the token URL to the worker"

    deploy = _DEPLOY.read_text()
    assert "NOTES_LIVE_TOKEN_URL" in deploy
    assert "/notes/stt/bot-live-token" in deploy
    # The worker calls the gateway from inside its container, so it can't use
    # 127.0.0.1 (that would be the container itself).
    assert "host.docker.internal:8080/notes/stt/bot-live-token" in deploy

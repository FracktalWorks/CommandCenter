"""Centralised env-driven settings. One source of truth for every service."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Loaded from environment + .env at process start."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Runtime
    acb_env: Literal["dev", "staging", "prod"] = "dev"
    log_level: str = "INFO"

    # Postgres
    database_url: str = Field(
        default="postgresql+psycopg://acb:acb_dev_change_me@localhost:5432/acb"
    )

    # Redis (event bus + GPTCache)
    redis_url: str = "redis://localhost:6379/0"

    # LiteLLM gateway
    litellm_base_url: str = "http://localhost:4000"
    litellm_master_key: str = "sk-local-dev-change-me"

    # Langfuse
    langfuse_host: str = "http://localhost:3000"
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    # Gateway
    gateway_host: str = "0.0.0.0"
    gateway_port: int = 8080
    gateway_session_secret: str = "change-me-dev-only"
    allowed_email_domain: str = "fracktal.in"

    # ClickUp (Phase 0)
    clickup_api_token: str = ""
    clickup_workspace_id: str = ""
    clickup_webhook_secret: str = ""

    # Zoho CRM (Phase 0)
    zoho_client_id: str = ""
    zoho_client_secret: str = ""
    zoho_refresh_token: str = ""
    zoho_api_domain: str = "https://www.zohoapis.com"
    zoho_accounts_url: str = "https://accounts.zoho.com"
    zoho_region: str = "in"
    zoho_webhook_secret: str = ""        # HMAC secret for /webhooks/zoho (WBS 1.1)

    # Gmail (Phase 1, WBS 1.3)
    gmail_sa_json_path: str = ""         # service-account key file
    gmail_workspace_domain: str = ""     # e.g. fracktal.in
    gmail_default_user: str = ""         # default mailbox to impersonate
    gmail_pubsub_token: str = ""         # bearer token expected on /webhooks/gmail

    # Dynamic Agent Loader (v2 — ADR-013)
    # Repos are cloned ONCE into agents_clone_dir/repos/ and refreshed with
    # git pull on each event (no full re-clone per run).

    # -- Auth: PAT (simple, use for dev / small teams) --
    github_token: str = ""                    # PAT with `repo` scope; used in clone URL + remote set-url

    # -- Auth: GitHub App (recommended for production) --
    # When set, _get_auth_token() should exchange app credentials for a
    # short-lived installation token.  Leave blank to fall back to github_token.
    github_app_id: str = ""                   # e.g. "123456"
    github_app_private_key_path: str = ""     # path to .pem file; never commit the key itself
    github_installation_id: str = ""          # org installation ID (visible in GitHub App settings)

    github_org: str = "FracktalWorks"         # org that owns agent-* and skill-* repos
    agents_clone_dir: str = "/tmp/acb_agents" # persistent clone root (survives between events)

    # -- Bot git identity (written into every local clone via git config) --
    # Commits and PRs opened by Self_Mutation_Node carry this identity.
    # Create a dedicated GitHub machine user (or use the GitHub App's identity).
    github_bot_name: str = "jannet-bot"
    github_bot_email: str = ""                # default: {github_bot_name}@users.noreply.github.com

    # OpenHands Self-Mutation Sandbox (v2 — ADR-021)
    openhands_api_url: str = ""   # e.g. http://openhands:3000; leave blank to disable mutation


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor; call from anywhere."""
    return Settings()  # type: ignore[call-arg]

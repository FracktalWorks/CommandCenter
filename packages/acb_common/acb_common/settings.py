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

    # Redis (event bus)
    redis_url: str = "redis://localhost:6379/0"

    # LiteLLM gateway
    litellm_base_url: str = "http://localhost:4000"
    litellm_master_key: str = "sk-local-dev-change-me"

    # LLM provider keys (used by LiteLLM config and settings UI)
    gemini_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""

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

    # -- OAuth App (used by Control Plane Device Flow UI only) --
    # Register at: github.com/settings/applications/new  (Callback URL: http://localhost)
    # The client_id is NOT sensitive — it is a public identifier.
    github_client_id: str = ""               # OAuth App Client ID; never the secret

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
    github_bot_name: str = "commandcenter-bot"
    github_bot_email: str = ""                # default: {github_bot_name}@users.noreply.github.com

    # OpenHands Self-Mutation Sandbox (v2 — ADR-021)
    openhands_api_url: str = ""   # e.g. http://openhands:3000; leave blank to disable mutation

    # Copilot SDK Self-Mutation Sandbox (acb-mutation-runner) — WBS 1.2/1.3
    mutation_model: str = "openai/tier3-opus"       # model the sandbox agent uses
    mutation_sandbox_image: str = "acb-mutation-runner:latest"
    mutation_timeout_seconds: int = 600              # hard cap on a single mutation run
    mutation_auto_pr: bool = True                    # open a GitHub PR after a successful fix

    # Copilot SDK chat (coworker sessions via /copilot/chat)
    # Auth order: LITELLM_MASTER_KEY → LiteLLM proxy  |  GITHUB_TOKEN → api.githubcopilot.com
    # Model must be available in whichever provider is active.
    # Also controls the model injected into GitHubCopilotAgent Tier-1.5 runs.
    # Valid values (Copilot API): gpt-4o, gpt-4o-mini, claude-sonnet-4-5, o3-mini, o1
    copilot_chat_model: str = "claude-sonnet-4-5"  # e.g. gpt-4o, claude-sonnet-4-5, o3-mini

    # ---------------------------------------------------------------------------
    # OAuth 2.0 authorization-code flow (M2.6) — Integration token exchange.
    # The Control Plane Integration page redirects to each provider's consent
    # screen; the callback exchanges the code for access + refresh tokens, which
    # are persisted to .env and injected into agents at run time.
    # ---------------------------------------------------------------------------
    # Public base URL the provider redirects back to (no trailing slash).
    oauth_redirect_base: str = "http://localhost:8000"

    # ClickUp OAuth app (app.clickup.com/settings/apps)
    clickup_client_id: str = ""
    clickup_client_secret: str = ""
    clickup_access_token: str = ""        # set by the OAuth callback

    # Google OAuth app (console.cloud.google.com — Gmail scopes)
    google_client_id: str = ""
    google_client_secret: str = ""
    google_access_token: str = ""         # set by the OAuth callback
    google_refresh_token: str = ""
    google_token_expiry: str = ""         # ISO-8601 expiry of the access token

    # Zoho access token cache (refresh_token already above)
    zoho_access_token: str = ""
    zoho_token_expiry: str = ""


    # Apollo.io (prospecting, contact enrichment)
    apollo_api_key: str = ""
    apollo_base_url: str = "https://api.apollo.io/v1"

    # Google Maps Platform (Places API — used by sales-prospector Step 1)
    google_maps_api_key: str = ""

    # Instantly.ai (email sequencing — used by sales-prospector Step 7)
    instantly_api_key: str = ""
    instantly_base_url: str = "https://api.instantly.ai/api/v1"

    # SMTP outbound (generic email send fallback)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor; call from anywhere."""
    return Settings()  # type: ignore[call-arg]

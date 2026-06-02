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

    # Outlook / Exchange Online (Phase 1, WBS 1.3)
    outlook_client_id: str = ""          # Azure app registration client ID
    outlook_client_secret: str = ""      # Azure app registration secret
    outlook_tenant_id: str = ""          # Entra ID / Azure AD tenant ID
    outlook_default_user: str = ""       # default mailbox UPN to watch
    outlook_webhook_secret: str = ""     # clientState secret for Graph change notifications


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor; call from anywhere."""
    return Settings()  # type: ignore[call-arg]

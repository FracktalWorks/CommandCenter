"""Centralised env-driven settings. One source of truth for every service."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
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
    # Seconds libpq waits to ESTABLISH a connection before giving up. Bounds the
    # worst case for every DB caller so a slow/firewalled DB host (or a
    # best-effort audit write) can never hang an agent indefinitely — it fails
    # fast and the caller's error handling takes over. Only the CONNECT phase is
    # capped, not query duration; a healthy local DB connects in <100ms so this
    # never trips in normal operation.
    db_connect_timeout: int = 10

    # Redis (event bus)
    redis_url: str = "redis://localhost:6379/0"

    # LiteLLM SDK routing — gateway /v1/chat/completions endpoint.
    # All LLM calls use the litellm Python SDK directly (no separate proxy).
    litellm_base_url: str = "http://127.0.0.1:8080"
    litellm_master_key: str = "sk-local"
    # Internal service token the gateway's /v1 + server-to-server endpoints
    # authenticate against (acb_auth.require_internal_auth). Reads
    # GATEWAY_INTERNAL_TOKEN; when unset the gateway falls back to
    # litellm_master_key. Every BYOK/internal caller MUST present this token
    # with the SAME precedence (gateway_internal_token → litellm_master_key),
    # else a divergence between the two values yields a 401 that surfaces on
    # Copilot BYOK agents as the misleading "Authorization error, run /login".
    gateway_internal_token: str = ""

    # Master encryption key for the provider key store (ADR-008).
    # Generate: python -c "import secrets; print(secrets.token_urlsafe(32))"
    # This is the ONLY secret that must be set — all provider keys are encrypted
    # in Postgres with this key.  Falls back to ACB_MASTER_KEY env var.
    acb_master_key: str = ""

    # LLM provider keys (DEPRECATED — use the key store via /settings/llm/key API).
    # Kept as fallback for bootstrap only; acb_llm prefers the key store.
    gemini_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""     # console.anthropic.com — Claude models
    openrouter_api_key: str = ""    # openrouter.ai — 200+ models via one key
    deepseek_api_key: str = ""      # platform.deepseek.com — DeepSeek V3 / R1
    groq_api_key: str = ""          # console.groq.com — free tier, very fast inference
    mistral_api_key: str = ""       # console.mistral.ai
    together_api_key: str = ""      # api.together.ai — 100+ open-source models

    # Gateway
    gateway_host: str = "0.0.0.0"
    gateway_port: int = 8000
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

    # Email OAuth (Gmail + Microsoft) — configured via Integrations → APIs UI
    gmail_oauth_client_id: str = ""
    gmail_oauth_client_secret: str = ""
    msft_oauth_client_id: str = ""
    msft_oauth_client_secret: str = ""

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
    # Persistent clone root for agent workspaces + generated artifacts.
    # MUST NOT live under /tmp: systemd-tmpfiles wipes /tmp on every reboot,
    # which destroys all agent clones AND their artifacts at once. Defaults to
    # a dir under $HOME so it survives reboots; override with AGENTS_CLONE_DIR.
    agents_clone_dir: str = Field(
        default_factory=lambda: str(Path.home() / ".acb" / "agents")
    )

    # -- Bot git identity (written into every local clone via git config) --
    # Commits and PRs opened by Self_Mutation_Node carry this identity.
    # Create a dedicated GitHub machine user (or use the GitHub App's identity).
    github_bot_name: str = "Command-Center"
    github_bot_email: str = ""                # default: {github_bot_name}@users.noreply.github.com

    # OpenHands Self-Mutation Sandbox (v2 — ADR-021)
    openhands_api_url: str = ""   # e.g. http://openhands:3000; leave blank to disable mutation

    # Copilot SDK Self-Mutation Sandbox (acb-mutation-runner) — WBS 1.2/1.3
    # A gateway tier alias (resolved dynamically to the configured model), NOT a
    # concrete provider/model. "openai/tier-powerful" was malformed — litellm
    # read it as provider=openai, model="tier-powerful" and 400'd.
    mutation_model: str = "tier-powerful"              # model the sandbox agent uses
    mutation_sandbox_image: str = "acb-mutation-runner:latest"
    mutation_timeout_seconds: int = 600              # hard cap on a single mutation run
    mutation_auto_pr: bool = True                    # open a GitHub PR after a successful fix

    # Native-MAF mutation → monorepo PR (Part 1).
    # A native MAF agent (local_path, no git remote) can't push its self-mutation
    # anywhere, so approving one opens a PR against the CommandCenter monorepo
    # that edits apps/agents/agent-<name>/ in place. These configure that flow.
    #
    # ⚠️ DEV-ONLY — REPLACE BEFORE PRODUCTION/MULTI-TENANCY. Keep
    # mutation_monorepo_repo pointed ONLY at our own first-party monorepo, and
    # only in first-party/dev environments: third-party/customer agents must
    # never push to the shared monorepo. See
    # docs/DESIGN_LIMITATION_native_maf_mutation.md.
    #
    # The monorepo "owner/name" the PR is opened against. Leave blank to disable
    # the monorepo-PR path (native-MAF approvals then fall back to keep-local).
    mutation_monorepo_repo: str = ""                 # e.g. "FracktalWorks/CommandCenter"
    mutation_monorepo_base: str = "main"             # PR base branch
    # Dedicated token with push + pull-request scope on the monorepo. Kept
    # separate from github_token (which only needs clone/read on agent repos) so
    # the broader monorepo-write credential is explicit. Falls back to
    # github_token when blank — see mutation_pr_token property below.
    mutation_pr_token: str = ""

    # Copilot SDK chat (coworker sessions via /copilot/chat)
    # Auth order: LITELLM_MASTER_KEY → gateway /v1  |  GITHUB_TOKEN → api.githubcopilot.com
    # Model must be available in whichever provider is active.
    # Also controls the model injected into GitHubCopilotAgent Tier-1.5 runs.
    # Valid values (Copilot API): gpt-4o, gpt-4o-mini, claude-sonnet-4-5, o3-mini, o1
    # Default ALL agents/chats to LiteLLM's balanced tier (routed BYOK through the
    # gateway /v1 → DeepSeek), instead of GitHub Copilot's auto model selection.
    # Override per-deployment in .env (COPILOT_CHAT_MODEL) if needed.
    copilot_chat_model: str = "tier-balanced"

    # BYOK-by-default: route EVERY Copilot SDK agent through the LiteLLM gateway
    # (/v1 BYOK) instead of api.githubcopilot.com.  When on (the default), any
    # resolved model is BYOK-routed; a bare model name the gateway doesn't
    # expose (e.g. an .agent.md ``claude-sonnet-4-5``) is normalized to
    # ``copilot_chat_model`` (tier-balanced) so it always resolves.  Set
    # COPILOT_BYOK_DEFAULT=false to allow bare names to hit GitHub Copilot direct.
    copilot_byok_default: bool = True

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

    # SerpAPI (Google search results — used by research/prospecting agents)
    serpapi_api_key: str = ""

    # Apify (web scraping actors)
    apify_api_token: str = ""

    # AnyMailFinder (email discovery)
    anymailfinder_api_key: str = ""

    # Google Sheets (service-account key path — can reuse gmail_sa_json_path)
    google_sheets_sa_json_path: str = ""

    # ---------------------------------------------------------------------------
    # Memory layer (WBS 2.5) — Mem0 episodic memory + Graphiti bi-temporal KG
    # ---------------------------------------------------------------------------

    # Mem0 — episodic memory per user (cross-session facts).
    # Backend: Postgres + pgvector (no new infra when mem0_enabled=true).
    # Set mem0_enabled=true once MEM0_ENABLED=true is in .env and the Postgres
    # schema migration (07_mem0_schema.sql) has run.
    mem0_enabled: bool = False

    # Graphiti — bi-temporal entity KG.
    # Requires Neo4j running (docker compose --profile memory up -d neo4j).
    graphiti_enabled: bool = False
    neo4j_url: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""   # required when graphiti_enabled=true

    # Email semantic search (Phase 2) — embed emails into email_embeddings
    # (pgvector) and blend cosine similarity with full-text rank on the
    # hybrid=true path of /email/search. OFF by default: lexical FTS (Phase 1)
    # is complete on its own, and embedding a mailbox costs tokens + a background
    # sweep. Turn on once migration 73 has run.
    email_semantic_search_enabled: bool = False
    # One model for all email embeddings. The vector column in migration 73 is
    # sized 1536 for this default; changing to a different-dimension model
    # (e.g. gemini text-embedding-004 = 768) requires recreating the column and
    # re-embedding — the model is stored per row so that migration is scriptable.
    email_embedding_model: str = "text-embedding-3-small"
    email_embedding_dim: int = 1536


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached accessor; call from anywhere."""
    return Settings()  # type: ignore[call-arg]

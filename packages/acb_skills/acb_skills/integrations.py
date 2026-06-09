"""Integration Registry — maps service names to credential dicts.

This is the *server-side* credential store for the agentic workflow.
When the executor calls ``build_integrations()``, it reads the agent's
declared ``config.json["integrations"]`` list, resolves each service name
to a credential dict, and injects the result into ``state["integrations"]``.

Agents and skills must only read credentials from ``state["integrations"]``.
They must never call ``os.getenv()`` for secrets or import ``Settings``
directly — see §5 of ``ai-company-brain/agent_repo_compatibility.md``.

----

**Adding a new integration:**

1. Add the env-var field(s) to ``acb_common.settings.Settings``.
2. Add an entry to ``_REGISTRY`` below.
3. Add the service name string to the agent's ``config.json["integrations"]``.
4. The executor picks it up automatically on the next run.

**Credential security model:**

- Credentials are resolved *at run time* from the server process environment
  (set via ``infra/docker-compose.yml`` / Hostinger secrets manager).
- They are injected into the LangGraph state dict, which is serialised to
  Postgres via the checkpointer.  **Do not store unencrypted secrets in the
  checkpointer in production** — encrypt the Postgres volume and restrict DB
  access to the gateway/orchestrator service account.
- OAuth refresh tokens: if a skill raises ``IntegrationAuthError``, the
  executor should refresh and retry once (not yet implemented — Phase 2).
"""
from __future__ import annotations

import os
from typing import Any

from acb_common import get_logger

_log = get_logger("acb_skills.integrations")


class IntegrationNotFoundError(Exception):
    """Raised when a required integration is declared but not registered."""


class IntegrationMisconfiguredError(Exception):
    """Raised when a registered integration is missing required env vars."""


# ---------------------------------------------------------------------------
# Registry — maps service-name → resolver callable
#
# Each resolver receives the acb_common Settings object and returns a dict
# of credentials to be stored at state["integrations"]["<service-name>"].
# Return an empty dict {} if the integration is optional and not configured.
# Raise IntegrationMisconfiguredError if the integration is declared but
# required env vars are missing.
# ---------------------------------------------------------------------------

def _zoho_crm(s: Any) -> dict[str, Any]:
    client_id = getattr(s, "zoho_client_id", "") or os.getenv("ZOHO_CLIENT_ID", "")
    client_secret = getattr(s, "zoho_client_secret", "") or os.getenv("ZOHO_CLIENT_SECRET", "")
    refresh_token = getattr(s, "zoho_refresh_token", "") or os.getenv("ZOHO_REFRESH_TOKEN", "")
    if not all([client_id, client_secret, refresh_token]):
        raise IntegrationMisconfiguredError(
            "zoho-crm: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN are all required."
        )
    return {
        "type": "oauth2",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "api_domain": getattr(s, "zoho_api_domain", "https://www.zohoapis.com"),
        "accounts_url": getattr(s, "zoho_accounts_url", "https://accounts.zoho.com"),
        "region": getattr(s, "zoho_region", "in"),
    }


def _apollo(s: Any) -> dict[str, Any]:
    api_key = getattr(s, "apollo_api_key", "") or os.getenv("APOLLO_API_KEY", "")
    if not api_key:
        raise IntegrationMisconfiguredError("apollo: APOLLO_API_KEY is required.")
    return {
        "type": "api_key",
        "api_key": api_key,
        "base_url": getattr(s, "apollo_base_url", "https://api.apollo.io/v1"),
    }


def _google_maps(s: Any) -> dict[str, Any]:
    api_key = getattr(s, "google_maps_api_key", "") or os.getenv("GOOGLE_MAPS_API_KEY", "")
    if not api_key:
        raise IntegrationMisconfiguredError("google-maps: GOOGLE_MAPS_API_KEY is required.")
    return {
        "type": "api_key",
        "api_key": api_key,
    }


def _instantly(s: Any) -> dict[str, Any]:
    api_key = getattr(s, "instantly_api_key", "") or os.getenv("INSTANTLY_API_KEY", "")
    if not api_key:
        raise IntegrationMisconfiguredError("instantly: INSTANTLY_API_KEY is required.")
    return {
        "type": "api_key",
        "api_key": api_key,
        "base_url": getattr(s, "instantly_base_url", "https://api.instantly.ai/api/v1"),
    }


def _gmail(s: Any) -> dict[str, Any]:
    sa_path = getattr(s, "gmail_sa_json_path", "") or os.getenv("GMAIL_SA_JSON_PATH", "")
    default_user = getattr(s, "gmail_default_user", "") or os.getenv("GMAIL_DEFAULT_USER", "")
    if not sa_path:
        raise IntegrationMisconfiguredError(
            "gmail: GMAIL_SA_JSON_PATH (service-account key) is required."
        )
    return {
        "type": "service_account",
        "sa_json_path": sa_path,
        "workspace_domain": getattr(s, "gmail_workspace_domain", ""),
        "default_user": default_user,
    }


def _gmail_send(s: Any) -> dict[str, Any]:
    """Alias for gmail — used by agents that only need outbound send."""
    return _gmail(s)


def _clickup(s: Any) -> dict[str, Any]:
    token = getattr(s, "clickup_api_token", "") or os.getenv("CLICKUP_API_TOKEN", "")
    workspace = getattr(s, "clickup_workspace_id", "") or os.getenv("CLICKUP_WORKSPACE_ID", "")
    if not token:
        raise IntegrationMisconfiguredError("clickup: CLICKUP_API_TOKEN is required.")
    return {
        "type": "api_key",
        "api_token": token,
        "workspace_id": workspace,
    }


def _smtp(s: Any) -> dict[str, Any]:
    host = getattr(s, "smtp_host", "") or os.getenv("SMTP_HOST", "")
    username = getattr(s, "smtp_username", "") or os.getenv("SMTP_USERNAME", "")
    password = getattr(s, "smtp_password", "") or os.getenv("SMTP_PASSWORD", "")
    if not host:
        raise IntegrationMisconfiguredError("smtp: SMTP_HOST is required.")
    return {
        "type": "smtp",
        "host": host,
        "port": int(getattr(s, "smtp_port", None) or os.getenv("SMTP_PORT", "587")),
        "username": username,
        "password": password,
        "use_tls": str(getattr(s, "smtp_use_tls", None) or os.getenv("SMTP_USE_TLS", "true")).lower() == "true",
    }


def _litellm(s: Any) -> dict[str, Any]:
    """LLM gateway — gives agents access to shared LLM routing via the gateway's /v1."""
    return {
        "type": "litellm",
        "base_url": getattr(s, "litellm_base_url", f"http://localhost:{getattr(s, 'gateway_port', 8000)}"),
        "api_key": getattr(s, "litellm_master_key", ""),
    }


def _serpapi(s: Any) -> dict[str, Any]:
    api_key = getattr(s, "serpapi_api_key", "") or os.getenv("SERPAPI_API_KEY", "")
    if not api_key:
        raise IntegrationMisconfiguredError("serpapi: SERPAPI_API_KEY is required.")
    return {"type": "api_key", "api_key": api_key}


def _apify(s: Any) -> dict[str, Any]:
    api_token = getattr(s, "apify_api_token", "") or os.getenv("APIFY_API_TOKEN", "")
    if not api_token:
        raise IntegrationMisconfiguredError("apify: APIFY_API_TOKEN is required.")
    return {
        "type": "api_key",
        "api_token": api_token,
        "base_url": "https://api.apify.com/v2",
    }


def _anymailfinder(s: Any) -> dict[str, Any]:
    api_key = getattr(s, "anymailfinder_api_key", "") or os.getenv("ANYMAILFINDER_API_KEY", "")
    if not api_key:
        raise IntegrationMisconfiguredError("anymailfinder: ANYMAILFINDER_API_KEY is required.")
    return {
        "type": "api_key",
        "api_key": api_key,
        "base_url": "https://api.anymailfinder.com/v5.0",
    }


def _google_sheets(s: Any) -> dict[str, Any]:
    # Reuse the Gmail service-account key if a dedicated one isn't set
    sa_path = (
        getattr(s, "google_sheets_sa_json_path", "")
        or os.getenv("GOOGLE_SHEETS_SA_JSON_PATH", "")
        or getattr(s, "gmail_sa_json_path", "")
        or os.getenv("GMAIL_SA_JSON_PATH", "")
    )
    if not sa_path:
        raise IntegrationMisconfiguredError(
            "google-sheets: GOOGLE_SHEETS_SA_JSON_PATH (service-account key) is required."
        )
    return {"type": "service_account", "sa_json_path": sa_path}


# Master registry: service-name → resolver
_REGISTRY: dict[str, Any] = {
    "zoho-crm":      _zoho_crm,
    "apollo":        _apollo,
    "google-maps":   _google_maps,
    "instantly":     _instantly,
    "gmail":         _gmail,
    "gmail-send":    _gmail_send,
    "clickup":       _clickup,
    "smtp":          _smtp,
    "litellm":       _litellm,
    "serpapi":       _serpapi,
    "apify":         _apify,
    "anymailfinder": _anymailfinder,
    "google-sheets": _google_sheets,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_integrations(
    mandatory: list[str],
    optional: list[str],
    settings: Any,
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """Resolve integration service names to their credential dicts.

    Never raises.  All failures are returned in the second element of the
    tuple so the executor can log them and inject them into agent state.

    Args:
        mandatory:  Service names from ``config.json["integrations"]``.
                    Resolution failures are logged as errors but do NOT abort
                    the run — the agent can still start and may handle missing
                    integrations gracefully at tool-call time.
        optional:   Service names from ``config.json["optional_integrations"]``.
                    Resolution failures are logged as warnings and silently
                    skipped.
        settings:   Loaded ``acb_common.Settings`` instance.

    Returns:
        A 2-tuple of:
        - ``resolved``: ``{service: credentials_dict}`` for every service that
          resolved successfully.
        - ``unavailable``: ``{service: reason}`` for every service that failed
          (not in registry, or missing env vars).  Agents can read this from
          ``state["integration_warnings"]`` to surface helpful messages.
    """
    resolved: dict[str, dict[str, Any]] = {}
    unavailable: dict[str, str] = {}

    for service_name, is_mandatory in (
        [(s, True) for s in mandatory] + [(s, False) for s in optional]
    ):
        resolver = _REGISTRY.get(service_name)
        if resolver is None:
            reason = (
                f"{service_name!r} is not in the IntegrationRegistry "
                f"(no resolver registered in acb_skills/integrations.py)."
            )
            unavailable[service_name] = reason
            _log.warning(
                "integrations.not_registered",
                service=service_name,
                mandatory=is_mandatory,
            )
            continue
        try:
            resolved[service_name] = resolver(settings)
            _log.debug("integrations.resolved", service=service_name)
        except IntegrationMisconfiguredError as exc:
            reason = str(exc)
            unavailable[service_name] = reason
            level = "error" if is_mandatory else "warning"
            getattr(_log, level)(
                "integrations.misconfigured",
                service=service_name,
                mandatory=is_mandatory,
                error=reason,
            )

    return resolved, unavailable


def list_registered() -> list[str]:
    """Return the list of service names known to the registry."""
    return sorted(_REGISTRY.keys())

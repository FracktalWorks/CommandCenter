"""Integration management endpoints.

Endpoints
---------
GET  /integrations/status?agent={name}
    Returns per-integration status (configured / missing) for a given agent.
    Also returns setup guides (links, required env vars) for unconfigured ones.

POST /integrations/configure
    Writes one or more credentials to the .env file and hot-reloads Settings.
    Restricted to admin/executive role.

GET  /integrations/test?service={name}
    Performs a lightweight connectivity check for a configured integration.
    Returns {service, ok, detail}.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

import httpx
from acb_auth import UserContext, UserRole, get_current_user, require_role
from acb_common import get_logger, get_settings
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

_log = get_logger("gateway.integrations")

router = APIRouter(prefix="/integrations", tags=["integrations"])

# ---------------------------------------------------------------------------
# Static setup guides — one entry per registered integration.
# Surfaced to the Control Plane wizard so users get direct links & instructions.
# ---------------------------------------------------------------------------

_SETUP_GUIDES: dict[str, dict[str, Any]] = {
    "zoho-crm": {
        "label": "Zoho CRM",
        "description": "Deal management, contacts, accounts, and pipeline.",
        "setup_url": "https://accounts.zoho.in/developerconsole",
        "docs_url": "https://www.zoho.com/crm/developer/docs/api/v5/oauth-overview.html",
        "instructions": (
            "1. Go to Zoho Developer Console → Add Client → Self Client.\n"
            "2. Generate a code with scope: ZohoCRM.modules.ALL,ZohoCRM.settings.ALL\n"
            "3. Exchange the code for tokens (one-time). Copy the refresh_token.\n"
            "4. Copy Client ID and Client Secret from the app settings."
        ),
        "env_vars": [
            {"key": "ZOHO_CLIENT_ID", "label": "Client ID", "sensitive": False},
            {"key": "ZOHO_CLIENT_SECRET", "label": "Client Secret", "sensitive": True},
            {"key": "ZOHO_REFRESH_TOKEN", "label": "Refresh Token", "sensitive": True},
            {"key": "ZOHO_API_DOMAIN", "label": "API Domain (default: zohoapis.com)", "sensitive": False},
            {"key": "ZOHO_ACCOUNTS_URL", "label": "Accounts URL (default: accounts.zoho.com)", "sensitive": False},
            {"key": "ZOHO_REGION", "label": "Region (in/eu/us, default: in)", "sensitive": False},
        ],
    },
    "apollo": {
        "label": "Apollo.io",
        "description": "Contact enrichment and prospecting database.",
        "setup_url": "https://developer.apollo.io/keys/",
        "docs_url": "https://apolloio.github.io/apollo-api-docs/",
        "instructions": (
            "1. Log in to Apollo.io.\n"
            "2. Navigate to Settings → Integrations → API Keys.\n"
            "3. Copy the Master API Key."
        ),
        "env_vars": [
            {"key": "APOLLO_API_KEY", "label": "Master API Key", "sensitive": True},
        ],
    },
    "google-maps": {
        "label": "Google Maps / Places API",
        "description": "Business discovery and location data for prospecting.",
        "setup_url": "https://console.cloud.google.com/apis/credentials",
        "docs_url": "https://developers.google.com/maps/documentation/places/web-service/overview",
        "instructions": (
            "1. Open Google Cloud Console → APIs & Services → Enable 'Places API (New)'.\n"
            "2. Go to Credentials → Create Credentials → API Key.\n"
            "3. Restrict the key to Places API for security."
        ),
        "env_vars": [
            {"key": "GOOGLE_MAPS_API_KEY", "label": "API Key", "sensitive": True},
        ],
    },
    "instantly": {
        "label": "Instantly.ai",
        "description": "Cold email sequencing and outbound campaign management.",
        "setup_url": "https://app.instantly.ai/app/settings/integrations",
        "docs_url": "https://developer.instantly.ai/",
        "instructions": (
            "1. Log in to Instantly.ai.\n"
            "2. Go to Settings → API Keys.\n"
            "3. Copy your API key (or create a new one)."
        ),
        "env_vars": [
            {"key": "INSTANTLY_API_KEY", "label": "API Key", "sensitive": True},
        ],
    },
    "gmail": {
        "label": "Gmail (Google Workspace)",
        "description": "Read and send email via service-account impersonation.",
        "setup_url": "https://console.cloud.google.com/iam-admin/serviceaccounts",
        "docs_url": "https://developers.google.com/gmail/api/guides/",
        "instructions": (
            "1. Create a service account in Google Cloud Console.\n"
            "2. Enable domain-wide delegation for the service account.\n"
            "3. In Google Workspace Admin, grant the service account access to Gmail scopes.\n"
            "4. Download the JSON key file and set its path below."
        ),
        "env_vars": [
            {"key": "GMAIL_SA_JSON_PATH", "label": "Service Account Key Path", "sensitive": False},
            {"key": "GMAIL_DEFAULT_USER", "label": "Default Mailbox (e.g. you@domain.com)", "sensitive": False},
        ],
    },
    "gmail-send": {
        "label": "Gmail (send only)",
        "description": "Outbound email send via Google Workspace.",
        "setup_url": "https://console.cloud.google.com/iam-admin/serviceaccounts",
        "docs_url": "https://developers.google.com/gmail/api/guides/",
        "instructions": "Same setup as Gmail — service account + domain-wide delegation.",
        "env_vars": [
            {"key": "GMAIL_SA_JSON_PATH", "label": "Service Account Key Path", "sensitive": False},
            {"key": "GMAIL_DEFAULT_USER", "label": "Default Mailbox", "sensitive": False},
        ],
    },
    "clickup": {
        "label": "ClickUp",
        "description": "Task and project management.",
        "setup_url": "https://app.clickup.com/settings/apps",
        "docs_url": "https://clickup.com/api/",
        "instructions": (
            "1. Go to ClickUp Settings → Apps.\n"
            "2. Click 'Generate' under Personal API Token.\n"
            "3. Copy the token and your Workspace ID from the URL bar."
        ),
        "env_vars": [
            {"key": "CLICKUP_API_TOKEN", "label": "Personal API Token", "sensitive": True},
            {"key": "CLICKUP_WORKSPACE_ID", "label": "Workspace ID", "sensitive": False},
        ],
    },
    "smtp": {
        "label": "SMTP (email relay)",
        "description": "Generic outbound email via SMTP.",
        "setup_url": "",
        "docs_url": "",
        "instructions": "Set your SMTP server host, port, username, and password.",
        "env_vars": [
            {"key": "SMTP_HOST", "label": "Host", "sensitive": False},
            {"key": "SMTP_PORT", "label": "Port (default 587)", "sensitive": False},
            {"key": "SMTP_USERNAME", "label": "Username", "sensitive": False},
            {"key": "SMTP_PASSWORD", "label": "Password", "sensitive": True},
        ],
    },
    "github": {
        "label": "GitHub",
        "description": "Private agent repo cloning and Copilot LLM models (GPT-4o, Claude Sonnet, o3-mini).",
        # Two ways to authenticate — device flow (OAuth) or a PAT.
        # A PAT with copilot+repo scopes covers both repo access AND the Copilot Models API.
        "uses": ["Repo access", "Models"],
        "setup_url": "https://github.com/settings/tokens/new?scopes=copilot,repo",
        "docs_url": "https://docs.github.com/en/copilot/using-github-copilot/ai-models",
        "instructions": (
            "One token covers both repo access and Copilot LLM models.\n\n"
            "Option A — Personal Access Token (recommended):\n"
            "1. Open the link above → GitHub → Settings → Developer Settings\n"
            "   → Personal Access Tokens → Tokens (classic).\n"
            "2. Select scopes: `copilot` (LLM model API) and `repo` (private repos).\n"
            "3. Click 'Generate token', paste the value (ghp_...) below.\n\n"
            "Option B — OAuth Device Flow (no token entry needed):\n"
            "1. Create a GitHub OAuth App (Settings → Developer Settings → OAuth Apps).\n"
            "   Name: 'CommandCenter', Callback URL: http://localhost.\n"
            "2. Paste the Client ID and click 'Connect GitHub Account'.\n"
            "   Note: device-flow tokens may not include the `copilot` scope —\n"
            "   use Option A if you want Copilot model access."
        ),
        "env_vars": [
            # GITHUB_CLIENT_ID is used for the OAuth device flow (Option B).
            {"key": "GITHUB_CLIENT_ID", "label": "OAuth App Client ID (Option B)", "sensitive": False},
            # GITHUB_TOKEN can be set directly as a PAT (Option A), or is written
            # automatically after a successful device-flow authentication.
            {"key": "GITHUB_TOKEN", "label": "Personal Access Token — copilot + repo scopes (Option A)", "sensitive": True},
        ],
    },
    "serpapi": {
        "label": "SerpAPI (Google Search)",
        "description": "Real-time Google search results for research and discovery.",
        "setup_url": "https://serpapi.com/dashboard",
        "docs_url": "https://serpapi.com/search-api",
        "instructions": (
            "1. Log in to SerpAPI.\n"
            "2. Go to Dashboard — your API key is shown at the top.\n"
            "3. Copy the key."
        ),
        "env_vars": [
            {"key": "SERPAPI_API_KEY", "label": "API Key", "sensitive": True},
        ],
    },
    "apify": {
        "label": "Apify (web scraping)",
        "description": "Web scraping and automation actors for data extraction.",
        "setup_url": "https://console.apify.com/account/integrations",
        "docs_url": "https://docs.apify.com/api/v2",
        "instructions": (
            "1. Log in to Apify Console.\n"
            "2. Navigate to Account → Integrations.\n"
            "3. Copy your Personal API Token."
        ),
        "env_vars": [
            {"key": "APIFY_API_TOKEN", "label": "Personal API Token", "sensitive": True},
        ],
    },
    "anymailfinder": {
        "label": "AnyMailFinder",
        "description": "Find and verify professional email addresses.",
        "setup_url": "https://anymailfinder.com/account",
        "docs_url": "https://anymailfinder.com/docs",
        "instructions": (
            "1. Log in to AnyMailFinder.\n"
            "2. Go to Account → API Key.\n"
            "3. Copy the API key."
        ),
        "env_vars": [
            {"key": "ANYMAILFINDER_API_KEY", "label": "API Key", "sensitive": True},
        ],
    },
    "google-sheets": {
        "label": "Google Sheets",
        "description": "Read and write Google Sheets for data export and reporting.",
        "setup_url": "https://console.cloud.google.com/iam-admin/serviceaccounts",
        "docs_url": "https://developers.google.com/sheets/api/guides/authorizing",
        "instructions": (
            "1. Create a service account in Google Cloud Console.\n"
            "2. Enable the Google Sheets API for your project.\n"
            "3. Share your target Sheets with the service account email.\n"
            "4. Download the JSON key file and set its path below.\n"
            "   (You can reuse the same service account key as Gmail if already set up.)"
        ),
        "env_vars": [
            {"key": "GOOGLE_SHEETS_SA_JSON_PATH", "label": "Service Account Key Path (JSON file)", "sensitive": False},
        ],
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_configured(service_name: str, settings: Any) -> bool:
    """Return True if all required env vars for *service_name* are non-empty."""
    checkers: dict[str, Any] = {
        "zoho-crm":      lambda s: bool(s.zoho_client_id and s.zoho_client_secret and s.zoho_refresh_token),
        "apollo":        lambda s: bool(s.apollo_api_key),
        "google-maps":   lambda s: bool(s.google_maps_api_key),
        "instantly":     lambda s: bool(s.instantly_api_key),
        "gmail":         lambda s: bool(s.gmail_sa_json_path),
        "gmail-send":    lambda s: bool(s.gmail_sa_json_path),
        "clickup":       lambda s: bool(s.clickup_api_token),
        "smtp":          lambda s: bool(s.smtp_host and s.smtp_username),
        "github":        lambda s: bool(s.github_token),
        "serpapi":       lambda s: bool(getattr(s, "serpapi_api_key", "") or os.getenv("SERPAPI_API_KEY", "")),
        "apify":         lambda s: bool(getattr(s, "apify_api_token", "") or os.getenv("APIFY_API_TOKEN", "")),
        "anymailfinder": lambda s: bool(getattr(s, "anymailfinder_api_key", "") or os.getenv("ANYMAILFINDER_API_KEY", "")),
        "google-sheets": lambda s: bool(
            getattr(s, "google_sheets_sa_json_path", "") or os.getenv("GOOGLE_SHEETS_SA_JSON_PATH", "")
            or getattr(s, "gmail_sa_json_path", "") or os.getenv("GMAIL_SA_JSON_PATH", "")
        ),
    }
    checker = checkers.get(service_name)
    if checker is None:
        return True  # Unknown service — assume configured (don't block)
    try:
        return checker(settings)
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# .env file writer (dev / bare-metal deployments)
# ---------------------------------------------------------------------------

# Allowed env var keys — only these may be written via the API.
# Derived from all env_vars in _SETUP_GUIDES (business integrations) PLUS
# the LLM provider keys used by Settings → Models.  This allows the
# /integrations/configure endpoint to serve as the fallback write path for
# LLM provider keys when the gateway is running code that predates the
# /settings/llm/key endpoint's knowledge of those providers.
_ALLOWED_ENV_KEYS: frozenset[str] = frozenset(
    var["key"]
    for guide in _SETUP_GUIDES.values()
    for var in guide["env_vars"]
) | frozenset({
    # LLM provider keys (Settings → Models page)
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "TOGETHER_API_KEY",
    "VLLM_BASE_URL",
    "LITELLM_MASTER_KEY",
    "COPILOT_CHAT_MODEL",
})


def _find_env_file() -> Path:
    """Locate the repo-root .env file (next to the workspace pyproject.toml)."""
    # Walk up from this file's location.  The WORKSPACE root pyproject.toml
    # contains [tool.uv.workspace], distinguishing it from package-level ones.
    candidate = Path(__file__).resolve()
    for _ in range(10):
        candidate = candidate.parent
        pyproject = candidate / "pyproject.toml"
        if pyproject.exists():
            try:
                content = pyproject.read_text(encoding="utf-8")
                if "[tool.uv.workspace]" in content:
                    return candidate / ".env"
            except OSError:
                pass
    # Fallback: cwd
    return Path.cwd() / ".env"


def _upsert_env_var(env_path: Path, key: str, value: str) -> None:
    """Add or update KEY=VALUE in the .env file.  Creates the file if absent."""
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    updated = False
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        # Match KEY= or KEY =  (with optional surrounding quotes / spaces)
        if re.match(rf"^{re.escape(key)}\s*=", stripped):
            new_lines.append(f"{key}={value}")
            updated = True
        else:
            new_lines.append(line)
    if not updated:
        new_lines.append(f"{key}={value}")
    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class IntegrationVar(BaseModel):
    key: str
    value: str


class ConfigureRequest(BaseModel):
    vars: list[IntegrationVar]


class DevicePollRequest(BaseModel):
    device_code: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status")
async def integration_status(
    agent: str | None = None,
    user: UserContext = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Return integration status for a named agent (or all integrations).

    Query params:
        agent: bare agent name (e.g. "sales-prospector").
               If omitted, returns status for all registered integrations.

    Response items:
        {service, label, configured, description, setup_url, docs_url,
         instructions, env_vars, missing_keys}
    """
    settings = get_settings()

    # Determine which services to check
    if agent:
        from gateway.routes.agent import (_AGENT_REGISTRY,  # noqa: PLC0415
                                          _load_dynamic_agents)

        # Search static registry first, then dynamic agents from agents.json
        entry = next((e for e in _AGENT_REGISTRY if e["name"] == agent), None)
        if entry is None:
            entry = next((e for e in _load_dynamic_agents() if e["name"] == agent), None)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail=f"Agent {agent!r} not in registry.",
            )
        agent_services = entry.get("integrations", [])
        optional_services: set[str] = set(entry.get("optional_integrations", []))
        # github is always a system-level prerequisite — every agent needs repo cloning.
        # Show it first so users set it up before other integrations.
        services = ["github"] + [s for s in agent_services if s != "github"]
        # Include optional integrations at the end
        for svc in entry.get("optional_integrations", []):
            if svc not in services:
                services.append(svc)
    else:
        services = list(_SETUP_GUIDES.keys())
        optional_services = set()

    result = []
    for svc in services:
        guide = _SETUP_GUIDES.get(svc, {})
        configured = _is_configured(svc, settings)
        # For GitHub, always compute missing_keys from actual env vars
        # because the service can be "configured" via PAT (GITHUB_TOKEN)
        # alone, but the OAuth device flow (Option B) needs
        # GITHUB_CLIENT_ID separately.  Without this, a configured PAT
        # hides the Client ID input and the device-flow start returns 422.
        if svc == "github":
            missing_keys = [
                v["key"]
                for v in guide.get("env_vars", [])
                if not os.getenv(v["key"], "").strip()
            ]
        else:
            missing_keys = (
                []
                if configured
                else [
                    v["key"]
                    for v in guide.get("env_vars", [])
                    if not os.getenv(v["key"], "").strip()
                ]
            )
        result.append(
            {
                "service": svc,
                "label": guide.get("label", svc),
                "configured": configured,
                "mandatory": svc not in optional_services,
                "description": guide.get("description", ""),
                "uses": guide.get("uses", []),
                "setup_url": guide.get("setup_url", ""),
                "docs_url": guide.get("docs_url", ""),
                "instructions": guide.get("instructions", ""),
                "env_vars": guide.get("env_vars", []),
                "missing_keys": missing_keys,
            }
        )

    return result


@router.post(
    "/configure",
    dependencies=[require_role(UserRole.EXECUTIVE, UserRole.AGENT)],
)
async def configure_integrations(
    req: ConfigureRequest,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Write credential env vars to .env and hot-reload Settings cache.

    Only keys present in the allowed list (derived from _SETUP_GUIDES) may
    be written — all others are rejected with 422.

    After writing, calls get_settings.cache_clear() so the running process
    picks up the new values immediately without restart (dev / bare-metal).

    For Docker deployments: add these vars to docker-compose.yml env section
    and restart the gateway container — file-based injection does not work
    inside containers that don't mount the .env file.
    """
    # Validate all keys before writing any
    illegal = [v.key for v in req.vars if v.key not in _ALLOWED_ENV_KEYS]
    if illegal:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Disallowed env var keys: {illegal}. Permitted: {sorted(_ALLOWED_ENV_KEYS)}",
        )

    env_path = _find_env_file()
    written: list[str] = []
    for var in req.vars:
        if not var.value.strip():
            continue  # skip empties — don't overwrite existing with blank
        _upsert_env_var(env_path, var.key, var.value)
        # Also set in the current process env so the settings reload picks it up
        os.environ[var.key] = var.value
        written.append(var.key)
        _log.info(
            "integrations.configure",
            key=var.key,
            actor=user.email,
        )

    # Bust the settings LRU cache so the live process reads new values
    from acb_common.settings import get_settings as _gs  # noqa: PLC0415
    _gs.cache_clear()

    return {
        "written": written,
        "env_file": str(env_path),
        "reload": "Settings cache cleared — new values active immediately.",
        "docker_note": (
            "If running in Docker, also add these vars to docker-compose.yml "
            "environment section and restart the gateway container."
        ),
    }


@router.get("/test")
async def test_integration(
    service: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Perform a lightweight connectivity test for a configured integration.

    Returns {service, ok, detail}.
    """
    settings = get_settings()

    if not _is_configured(service, settings):
        return {
            "service": service,
            "ok": False,
            "detail": "Integration is not configured — missing required env vars.",
        }

    try:
        result = await _run_test(service, settings)
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "detail": f"Test raised: {exc}"}

    _log.info("integrations.test", service=service, ok=result.get("ok"), actor=user.email)
    return {"service": service, **result}


async def _run_test(service: str, settings: Any) -> dict[str, Any]:
    """Run a real connectivity check per integration."""
    async with httpx.AsyncClient(timeout=10) as client:
        if service == "zoho-crm":
            # Exchange refresh token for access token
            resp = await client.post(
                f"{settings.zoho_accounts_url}/oauth/v2/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": settings.zoho_client_id,
                    "client_secret": settings.zoho_client_secret,
                    "refresh_token": settings.zoho_refresh_token,
                },
            )
            if resp.status_code == 200 and "access_token" in resp.json():
                return {"ok": True, "detail": "Token exchange succeeded."}
            return {"ok": False, "detail": f"Token exchange failed: {resp.text[:200]}"}

        if service == "apollo":
            resp = await client.get(
                f"{settings.apollo_base_url}/auth/health",
                headers={"Cache-Control": "no-cache", "X-Api-Key": settings.apollo_api_key},
            )
            if resp.status_code in (200, 204):
                return {"ok": True, "detail": "Apollo API reachable."}
            return {"ok": False, "detail": f"Status {resp.status_code}: {resp.text[:200]}"}

        if service == "google-maps":
            resp = await client.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"address": "1600+Amphitheatre+Parkway", "key": settings.google_maps_api_key},
            )
            data = resp.json()
            if data.get("status") in ("OK", "ZERO_RESULTS"):
                return {"ok": True, "detail": "Google Maps API reachable."}
            return {"ok": False, "detail": f"API error: {data.get('status')} — {data.get('error_message', '')}"}

        if service == "instantly":
            resp = await client.get(
                f"{settings.instantly_base_url}/campaign/list",
                params={"api_key": settings.instantly_api_key, "limit": 1, "skip": 0},
            )
            if resp.status_code == 200:
                return {"ok": True, "detail": "Instantly API reachable."}
            return {"ok": False, "detail": f"Status {resp.status_code}: {resp.text[:200]}"}

        if service in ("gmail", "gmail-send"):
            sa_path = Path(settings.gmail_sa_json_path)
            if sa_path.exists():
                return {"ok": True, "detail": "Service account key file found."}
            return {"ok": False, "detail": f"Key file not found: {sa_path}"}

        if service == "clickup":
            resp = await client.get(
                "https://api.clickup.com/api/v2/user",
                headers={"Authorization": settings.clickup_api_token},
            )
            if resp.status_code == 200:
                return {"ok": True, "detail": "ClickUp API reachable."}
            return {"ok": False, "detail": f"Status {resp.status_code}: {resp.text[:200]}"}

        if service == "github":
            resp = await client.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"token {settings.github_token}",
                    "Accept": "application/vnd.github.v3+json",
                },
            )
            if resp.status_code == 200:
                login = resp.json().get("login", "?")
                return {"ok": True, "detail": f"Authenticated as GitHub user '{login}'."}
            return {"ok": False, "detail": f"Status {resp.status_code}: {resp.text[:200]}"}

    return {"ok": False, "detail": f"No test defined for service '{service}'."}


# ---------------------------------------------------------------------------
# GitHub OAuth Device Flow
# ---------------------------------------------------------------------------

@router.post("/github/device/start")
async def github_device_start(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Initiate the GitHub OAuth Device Flow.

    Returns the user_code and verification_uri to show in the UI.
    The frontend polls /github/device/poll until the user approves.

    Requires GITHUB_CLIENT_ID to be configured (via /configure first).
    """
    settings = get_settings()
    client_id: str = getattr(settings, "github_client_id", "")
    if not client_id.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="GITHUB_CLIENT_ID is not configured. Save it via /integrations/configure first.",
        )

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://github.com/login/device/code",
            data={"client_id": client_id, "scope": "repo copilot"},
            headers={"Accept": "application/json"},
        )

    data = resp.json()
    if "error" in data:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub error: {data['error']} — {data.get('error_description', '')}",
        )

    _log.info("github.device.start", actor=user.email)
    return {
        "user_code": data["user_code"],
        "verification_uri": data["verification_uri"],
        "device_code": data["device_code"],
        "expires_in": data["expires_in"],
        "interval": data["interval"],
    }


@router.post("/github/device/poll")
async def github_device_poll(
    req: DevicePollRequest,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Poll GitHub to check if the user has approved the device flow.

    Returns:
        {status: "authorized", login: str}  — token saved to .env, Settings reloaded
        {status: "pending"}                 — user hasn't approved yet, keep polling
        {status: "slow_down", interval: int} — increase polling interval
        {status: "expired"}                 — code expired, restart flow
        {status: "denied"}                  — user denied access
    """
    settings = get_settings()
    client_id: str = getattr(settings, "github_client_id", "")
    if not client_id.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="GITHUB_CLIENT_ID is not configured.",
        )

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            data={
                "client_id": client_id,
                "device_code": req.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
        )

    data = resp.json()

    if "access_token" in data:
        token: str = data["access_token"]
        # Persist to .env and hot-reload
        env_path = _find_env_file()
        _upsert_env_var(env_path, "GITHUB_TOKEN", token)
        os.environ["GITHUB_TOKEN"] = token
        from acb_common.settings import get_settings as _gs  # noqa: PLC0415
        _gs.cache_clear()

        # Fetch the GitHub login name for a friendly confirmation message
        login = "unknown"
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                ur = await client.get(
                    "https://api.github.com/user",
                    headers={
                        "Authorization": f"token {token}",
                        "Accept": "application/vnd.github.v3+json",
                    },
                )
                if ur.status_code == 200:
                    login = ur.json().get("login", "unknown")
        except Exception:  # noqa: BLE001
            pass

        _log.info("github.device.authorized", login=login, actor=user.email)
        return {"status": "authorized", "login": login}

    error = data.get("error", "unknown")
    if error == "slow_down":
        return {"status": "slow_down", "interval": data.get("interval", 10)}
    if error in ("expired_token", "access_denied"):
        return {"status": error.replace("_", "-")}
    # authorization_pending and anything else
    return {"status": "pending"}


# ---------------------------------------------------------------------------
# GitHub account info & CLI import
# ---------------------------------------------------------------------------

def _parse_gh_status(output: str) -> dict[str, Any]:
    """Parse `gh auth status` output into structured fields."""
    result: dict[str, Any] = {
        "authenticated": False,
        "login": None,
        "scopes": [],
        "has_copilot": False,
    }
    if "Logged in to github.com" not in output:
        return result
    result["authenticated"] = True
    login_m = re.search(r"account\s+(\S+)\s+\(", output)
    if login_m:
        result["login"] = login_m.group(1)
    scope_line = next((ln for ln in output.splitlines() if "Token scopes:" in ln), "")
    result["scopes"] = re.findall(r"'([^']+)'", scope_line)
    result["has_copilot"] = "copilot" in result["scopes"]
    return result


@router.get("/github/account")
async def github_account(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Return current GitHub account info: connected token details + gh CLI status.

    Response fields:
        token_configured (bool)   — GITHUB_TOKEN is set in env
        token_login      (str?)   — GitHub login resolved from the token
        token_scopes     (list)   — OAuth scopes on the token (from X-OAuth-Scopes header)
        token_has_copilot(bool)   — whether 'copilot' scope is present
        gh_cli_available (bool)   — gh binary is on PATH
        gh_cli_authenticated(bool)— gh has a logged-in account
        gh_cli_login     (str?)   — account name from gh auth status
        gh_cli_scopes    (list)   — scopes on the CLI token
        gh_cli_has_copilot(bool)  — whether gh CLI token has 'copilot' scope
    """
    settings = get_settings()
    token: str = getattr(settings, "github_token", "") or ""

    info: dict[str, Any] = {
        "token_configured": bool(token.strip()),
        "token_login": None,
        "token_scopes": [],
        "token_has_copilot": False,
        "gh_cli_available": False,
        "gh_cli_authenticated": False,
        "gh_cli_login": None,
        "gh_cli_scopes": [],
        "gh_cli_has_copilot": False,
    }

    # Resolve info from current GITHUB_TOKEN via GitHub REST API
    if token.strip():
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                resp = await client.get(
                    "https://api.github.com/user",
                    headers={
                        "Authorization": f"token {token}",
                        "Accept": "application/vnd.github.v3+json",
                    },
                )
                if resp.status_code == 200:
                    info["token_login"] = resp.json().get("login")
                    scopes_header = resp.headers.get("X-OAuth-Scopes", "")
                    info["token_scopes"] = [s.strip() for s in scopes_header.split(",") if s.strip()]
                    info["token_has_copilot"] = "copilot" in info["token_scopes"]
        except Exception:  # noqa: BLE001
            pass

    # Check gh CLI availability + auth state (non-blocking; failure is graceful)
    try:
        proc = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        output = proc.stdout + proc.stderr
        parsed = _parse_gh_status(output)
        info["gh_cli_available"] = True
        info["gh_cli_authenticated"] = parsed["authenticated"]
        info["gh_cli_login"] = parsed["login"]
        info["gh_cli_scopes"] = parsed["scopes"]
        info["gh_cli_has_copilot"] = parsed["has_copilot"]
    except FileNotFoundError:
        pass  # gh not installed
    except Exception:  # noqa: BLE001
        info["gh_cli_available"] = True  # binary found but errored

    return info


@router.post(
    "/github/connect-cli",
    dependencies=[require_role(UserRole.EXECUTIVE, UserRole.AGENT)],
)
async def github_connect_cli(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Import the active GitHub CLI token into GITHUB_TOKEN in .env.

    Reads the token via `gh auth token`, checks its scopes, writes to .env,
    and returns the connected account details.

    If the token lacks the `copilot` scope, the import still succeeds (repo
    cloning will work) but `has_copilot` is False and `refresh_command` is
    returned so the user knows what to run to gain model access.
    """
    # 1. Read token from gh CLI
    try:
        proc = subprocess.run(
            ["gh", "auth", "token"],
            capture_output=True,
            text=True,
            timeout=8,
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=400,
            detail="GitHub CLI (gh) is not installed or not in PATH.",
        )

    if proc.returncode != 0 or not proc.stdout.strip():
        raise HTTPException(
            status_code=400,
            detail="gh CLI is not authenticated. Run: gh auth login",
        )

    token = proc.stdout.strip()

    # 2. Parse scopes + login from gh auth status
    login = "unknown"
    scopes: list[str] = []
    try:
        status_proc = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        parsed = _parse_gh_status(status_proc.stdout + status_proc.stderr)
        login = parsed["login"] or "unknown"
        scopes = parsed["scopes"]
    except Exception:  # noqa: BLE001
        pass

    # 3. Save to .env and hot-reload settings
    env_path = _find_env_file()
    _upsert_env_var(env_path, "GITHUB_TOKEN", token)
    os.environ["GITHUB_TOKEN"] = token
    from acb_common.settings import get_settings as _gs  # noqa: PLC0415
    _gs.cache_clear()

    has_copilot = "copilot" in scopes
    _log.info("github.connect_cli", login=login, has_copilot=has_copilot, actor=user.email)

    return {
        "ok": True,
        "login": login,
        "scopes": scopes,
        "has_copilot": has_copilot,
        "refresh_command": "gh auth refresh --scopes copilot,repo" if not has_copilot else None,
        "message": (
            f"Connected as @{login}."
            + (
                ""
                if has_copilot
                else " Token lacks 'copilot' scope — Copilot models unavailable until you refresh."
            )
        ),
    }

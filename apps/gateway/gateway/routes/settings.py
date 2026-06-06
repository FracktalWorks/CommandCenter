"""
GET  /settings/llm          — current tier→model mapping + provider status
POST /settings/llm/tier     — update one tier's model assignment
GET  /settings/llm/health   — proxy LiteLLM /health/readiness
POST /settings/llm/test     — send a test completion on a given tier
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings

_log = get_logger("settings")
router = APIRouter(prefix="/settings", tags=["settings"])

# ---------------------------------------------------------------------------
# Locate infra/litellm/config.yaml relative to the repo root
# ---------------------------------------------------------------------------

def _config_path() -> Path:
    here = Path(__file__).resolve()
    # Walk up until we find infra/litellm/config.yaml
    for parent in here.parents:
        candidate = parent / "infra" / "litellm" / "config.yaml"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("infra/litellm/config.yaml not found from %s" % here)


def _load_config() -> dict[str, Any]:
    path = _config_path()
    with path.open() as f:
        return yaml.safe_load(f) or {}


def _save_config(cfg: dict[str, Any]) -> None:
    path = _config_path()
    with path.open("w") as f:
        yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def _infra_dir() -> Path:
    """Locate the infra/ directory by walking up from this file."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "infra"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("infra/ directory not found from %s" % here)


def _write_env_key(var: str, value: str) -> None:
    """Upsert VAR=value in the repo-root .env (same file Settings and integrations use)."""
    # Walk up to the workspace root (has [tool.uv.workspace] in pyproject.toml)
    here = Path(__file__).resolve()
    env_file: Path | None = None
    for parent in here.parents:
        pyproject = parent / "pyproject.toml"
        if pyproject.exists():
            try:
                if "[tool.uv.workspace]" in pyproject.read_text(encoding="utf-8"):
                    env_file = parent / ".env"
                    break
            except OSError:
                pass
    if env_file is None:
        env_file = Path.cwd() / ".env"
    lines = env_file.read_text(encoding="utf-8").splitlines(keepends=True) if env_file.exists() else []
    pattern = re.compile(rf"^{re.escape(var)}\s*=")
    found = False
    new_lines: list[str] = []
    for line in lines:
        if pattern.match(line):
            new_lines.append(f"{var}={value}\n")
            found = True
        else:
            new_lines.append(line)
    if not found:
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines.append("\n")
        new_lines.append(f"{var}={value}\n")
    env_file.write_text("".join(new_lines), encoding="utf-8")


def _restart_litellm_bg() -> None:
    """Restart the acb-litellm container in a background thread (best-effort)."""
    import subprocess
    import threading

    def _do() -> None:
        try:
            compose = _infra_dir() / "docker-compose.yml"
            subprocess.run(
                ["docker", "compose", "-f", str(compose), "--profile", "core", "restart", "litellm"],
                check=False, timeout=60, capture_output=True,
            )
        except Exception:
            pass

    threading.Thread(target=_do, daemon=True).start()


# ---------------------------------------------------------------------------
# Provider detection helpers
# ---------------------------------------------------------------------------

_PROVIDER_ENV_MAP: dict[str, str] = {
    "gemini":    "GEMINI_API_KEY",
    "openai":    "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "github":    "GITHUB_TOKEN",    # GitHub Copilot subscription
    "ollama":    "",        # local — always "configured" if URL reachable
    "vllm":      "VLLM_BASE_URL",
}

_PROVIDER_LABELS: dict[str, str] = {
    "gemini":    "Google Gemini",
    "openai":    "OpenAI",
    "anthropic": "Anthropic",
    "github":    "GitHub Copilot",
    "ollama":    "Ollama (local)",
    "vllm":      "vLLM (local)",
}

# GitHub Copilot proxy constants
_COPILOT_API_BASE = "https://api.githubcopilot.com"
_COPILOT_EXTRA_HEADERS = {"Copilot-Integration-Id": "vscode-chat"}
# Maps the display model name (github/…) → actual upstream model string.
_GITHUB_MODEL_MAP: dict[str, str] = {
    "github/gpt-4o-mini":    "openai/gpt-4o-mini",
    "github/gpt-4o":         "openai/gpt-4o",
    "github/claude-sonnet":  "anthropic/claude-sonnet-4-5",
    "github/o3-mini":        "openai/o3-mini",
    "github/o1":             "openai/o1",
}
# Reverse: upstream model string → display name (for get_llm_config response)
_GITHUB_MODEL_MAP_REV: dict[str, str] = {v: k for k, v in _GITHUB_MODEL_MAP.items()}

_PROVIDER_MODELS: dict[str, list[str]] = {
    "gemini": [
        "gemini/gemini-2.5-flash-lite",
        "gemini/gemini-2.5-flash",
        "gemini/gemini-2.5-pro",
        "gemini/gemini-2.0-flash",
        "gemini/gemini-1.5-pro",
    ],
    "openai": [
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "openai/gpt-4.1",
        "openai/gpt-4.1-mini",
        "openai/o3-mini",
        "openai/o3",
    ],
    "anthropic": [
        "anthropic/claude-3-5-haiku-latest",
        "anthropic/claude-3-5-sonnet-latest",
        "anthropic/claude-3-7-sonnet-latest",
        "anthropic/claude-opus-4-5",
    ],
    # GitHub Copilot models — use the `github/` prefix so update_tier can detect
    # them and set the correct api_base + auth headers automatically.
    "github": [
        "github/gpt-4o-mini",
        "github/gpt-4o",
        "github/claude-sonnet",
        "github/o3-mini",
        "github/o1",
    ],
    "ollama": [
        "ollama/llama3.2",
        "ollama/llama3.1:8b",
        "ollama/qwen2.5:7b",
        "ollama/mistral:7b",
        "ollama/phi4",
        "ollama/gemma3:4b",
    ],
    "vllm": [
        "openai/Qwen/Qwen3-8B-Instruct",
        "openai/meta-llama/Llama-3.1-8B-Instruct",
        "openai/mistralai/Mistral-7B-Instruct-v0.3",
    ],
}

_TIER_LABELS: dict[str, dict[str, str]] = {
    "tier1-local-qwen3": {"id": "tier1", "label": "Tier 1 — Fast / Cheap", "description": "Triage, classification, quick routing"},
    "tier2-sonnet":      {"id": "tier2", "label": "Tier 2 — Balanced",     "description": "Structured extraction, drafting, summaries"},
    "tier3-opus":        {"id": "tier3", "label": "Tier 3 — Powerful",     "description": "Multi-hop reasoning, strategy, planning"},
}


def _provider_from_model(model: str) -> str:
    """Infer provider slug from litellm model string (model field only)."""
    if model.startswith("gemini/"):
        return "gemini"
    if model.startswith("anthropic/"):
        return "anthropic"
    if model.startswith("github/"):
        return "github"
    if model.startswith("openai/"):
        # check if it looks like a vLLM path (has an extra / after openai/)
        if "/" in model.removeprefix("openai/"):
            return "vllm"
        return "openai"
    if model.startswith("ollama/"):
        return "ollama"
    return "unknown"


def _provider_from_entry(entry: dict[str, Any]) -> str:
    """Infer provider slug from a full LiteLLM model_list entry.

    Checks both model string and api_base so GitHub Copilot entries
    (which use openai/* model strings routed through api.githubcopilot.com)
    are correctly identified as 'github' rather than 'openai'.
    """
    params = entry.get("litellm_params", {})
    model = params.get("model", "")
    api_base = params.get("api_base", "")
    if _COPILOT_API_BASE in str(api_base):
        return "github"
    return _provider_from_model(model)


def _is_provider_configured(provider: str) -> bool:
    env_var = _PROVIDER_ENV_MAP.get(provider, "")
    if not env_var:
        return provider == "ollama"  # local — assume available
    # Check os.environ first (Docker / CI), then Settings (pydantic-settings loads .env)
    val = os.environ.get(env_var, "").strip()
    if not val:
        try:
            val = (getattr(get_settings(), env_var.lower(), "") or "").strip()
        except Exception:  # noqa: BLE001
            pass
    return bool(val)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class TierInfo(BaseModel):
    tier_name: str          # e.g. "tier1-local-qwen3"
    tier_id: str            # "tier1" | "tier2" | "tier3"
    label: str
    description: str
    model: str              # current litellm model string
    provider: str           # "gemini" | "openai" | ...
    provider_configured: bool


class ProviderInfo(BaseModel):
    id: str
    label: str
    configured: bool
    env_var: str
    models: list[str]


class LLMConfig(BaseModel):
    tiers: list[TierInfo]
    providers: list[ProviderInfo]
    litellm_ui_url: str


class TierUpdateRequest(BaseModel):
    tier_name: str   # e.g. "tier1-local-qwen3"
    model: str       # new litellm model string
    api_base: str | None = None   # for Ollama / vLLM


class TestRequest(BaseModel):
    tier_name: str   # e.g. "tier1-local-qwen3"


# ---------------------------------------------------------------------------
# GET /settings/llm
# ---------------------------------------------------------------------------

@router.get("/llm", response_model=LLMConfig)
async def get_llm_config(_user: UserContext = Depends(get_current_user)) -> LLMConfig:
    try:
        cfg = _load_config()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    model_list: list[dict] = cfg.get("model_list", [])

    tiers: list[TierInfo] = []
    for entry in model_list:
        tier_name = entry.get("model_name", "")
        if tier_name not in _TIER_LABELS:
            continue  # skip embeddings etc.
        meta = _TIER_LABELS[tier_name]
        model = entry.get("litellm_params", {}).get("model", "")
        provider = _provider_from_entry(entry)  # use entry-aware detection (catches Copilot)
        # For GitHub Copilot entries, normalise the display model name to `github/…`
        # so the Settings UI shows the human-readable name that matches _PROVIDER_MODELS.
        if provider == "github":
            model = _GITHUB_MODEL_MAP_REV.get(model, f"github/{model.split('/')[-1]}")
        tiers.append(TierInfo(
            tier_name=tier_name,
            tier_id=meta["id"],
            label=meta["label"],
            description=meta["description"],
            model=model,
            provider=provider,
            provider_configured=_is_provider_configured(provider),
        ))

    providers: list[ProviderInfo] = []
    for pid, label in _PROVIDER_LABELS.items():
        providers.append(ProviderInfo(
            id=pid,
            label=label,
            configured=_is_provider_configured(pid),
            env_var=_PROVIDER_ENV_MAP.get(pid, ""),
            models=_PROVIDER_MODELS.get(pid, []),
        ))

    settings = get_settings()
    litellm_url = str(settings.litellm_base_url).rstrip("/")

    return LLMConfig(
        tiers=tiers,
        providers=providers,
        litellm_ui_url=f"{litellm_url}/ui",
    )


# ---------------------------------------------------------------------------
# POST /settings/llm/tier  — patch one tier in config.yaml
# ---------------------------------------------------------------------------

@router.post("/llm/tier", response_model=TierInfo)
async def update_tier(
    req: TierUpdateRequest,
    _user: UserContext = Depends(get_current_user),
) -> TierInfo:
    if req.tier_name not in _TIER_LABELS:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {req.tier_name}")

    try:
        cfg = _load_config()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    model_list: list[dict] = cfg.get("model_list", [])
    updated = False
    for entry in model_list:
        if entry.get("model_name") == req.tier_name:
            params = entry.setdefault("litellm_params", {})

            # Detect GitHub Copilot model (github/… prefix used in Settings UI)
            if req.model.startswith("github/"):
                # Translate display name → upstream model + inject Copilot routing
                upstream = _GITHUB_MODEL_MAP.get(req.model, req.model.replace("github/", "openai/"))
                params["model"] = upstream
                params["api_base"] = _COPILOT_API_BASE
                params["api_key"] = "os.environ/GITHUB_TOKEN"
                params["extra_headers"] = dict(_COPILOT_EXTRA_HEADERS)
            elif req.api_base:
                # Local model (Ollama / vLLM)
                params["model"] = req.model
                params["api_base"] = req.api_base
                params["api_key"] = "EMPTY"
                params.pop("extra_headers", None)  # clear any stale provider headers
            else:
                # Hosted provider (Gemini, OpenAI, Anthropic)
                params["model"] = req.model
                params.pop("api_base", None)       # Gemini/OpenAI don't need custom base
                params.pop("extra_headers", None)  # remove stale Copilot headers
                provider = _provider_from_model(req.model)
                env_var = _PROVIDER_ENV_MAP.get(provider, "")
                params["api_key"] = f"os.environ/{env_var}" if env_var else "EMPTY"
            updated = True
            break

    if not updated:
        raise HTTPException(status_code=404, detail=f"Tier {req.tier_name} not found in config")

    _save_config(cfg)
    _log.info("settings.llm.tier_updated", tier=req.tier_name, model=req.model, actor=_user.email)

    # Restart LiteLLM so the new config takes effect immediately
    _restart_litellm_bg()

    meta = _TIER_LABELS[req.tier_name]
    # For GitHub Copilot models, return the `github/…` display name the UI sent;
    # for all others, return the actual litellm model string.
    display_model = req.model
    provider = "github" if req.model.startswith("github/") else _provider_from_model(req.model)
    return TierInfo(
        tier_name=req.tier_name,
        tier_id=meta["id"],
        label=meta["label"],
        description=meta["description"],
        model=display_model,
        provider=provider,
        provider_configured=_is_provider_configured(provider),
    )


# ---------------------------------------------------------------------------
# GET /settings/llm/health  — proxy LiteLLM health
# ---------------------------------------------------------------------------

class LiteLLMHealth(BaseModel):
    healthy: bool
    detail: str
    ui_url: str


@router.get("/llm/health", response_model=LiteLLMHealth)
async def llm_health(_user: UserContext = Depends(get_current_user)) -> LiteLLMHealth:
    settings = get_settings()
    base = str(settings.litellm_base_url).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(f"{base}/health/readiness")
        healthy = r.status_code == 200
        detail = "Online" if healthy else f"HTTP {r.status_code}"
    except Exception as exc:
        healthy = False
        detail = f"Unreachable: {exc}"
    return LiteLLMHealth(healthy=healthy, detail=detail, ui_url=f"{base}/ui")


# ---------------------------------------------------------------------------
# POST /settings/llm/test  — quick completion test on a tier
# ---------------------------------------------------------------------------

class TestResult(BaseModel):
    success: bool
    response: str
    latency_ms: int


@router.post("/llm/test", response_model=TestResult)
async def test_tier(
    req: TestRequest,
    _user: UserContext = Depends(get_current_user),
) -> TestResult:
    import time
    from acb_llm.client import complete, LLMTier

    tier_map = {"tier1-local-qwen3": "tier1", "tier2-sonnet": "tier2", "tier3-opus": "tier3"}
    tier_id = tier_map.get(req.tier_name)
    if not tier_id:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {req.tier_name}")

    t0 = time.monotonic()
    try:
        text = await complete(
            tier=LLMTier(tier_id),
            messages=[{"role": "user", "content": "Reply with only: OK"}],
            max_tokens=10,
        )
        elapsed = int((time.monotonic() - t0) * 1000)
        return TestResult(success=True, response=(text or "").strip() or "(empty response)", latency_ms=elapsed)
    except Exception as exc:
        elapsed = int((time.monotonic() - t0) * 1000)
        return TestResult(success=False, response=str(exc), latency_ms=elapsed)


# ---------------------------------------------------------------------------
# POST /settings/llm/key  — write a provider API key to infra/.env + restart
# ---------------------------------------------------------------------------

class ProviderKeyRequest(BaseModel):
    provider: str   # "gemini" | "openai" | "anthropic"
    api_key: str


@router.post("/llm/key")
async def set_provider_key(
    req: ProviderKeyRequest,
    _user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    env_var = _PROVIDER_ENV_MAP.get(req.provider)
    if not env_var:
        raise HTTPException(status_code=400, detail=f"No env var for provider: {req.provider}")
    if not req.api_key.strip():
        raise HTTPException(status_code=400, detail="api_key cannot be empty")
    try:
        _write_env_key(env_var, req.api_key.strip())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write env: {exc}") from exc
    _log.info("settings.llm.key_updated", provider=req.provider, actor=_user.email)
    _restart_litellm_bg()
    return {"ok": "true", "env_var": env_var, "provider": req.provider}


# ---------------------------------------------------------------------------
# POST /settings/llm/copilot-model  — set copilot_chat_model in .env
# ---------------------------------------------------------------------------

class CopilotModelRequest(BaseModel):
    model: str   # e.g. "claude-sonnet-4-5", "gpt-4o", "o3-mini"


@router.post("/llm/copilot-model")
async def set_copilot_model(
    req: CopilotModelRequest,
    _user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Update the model used by GitHub Copilot SDK agents (Tier 1.5 path)."""
    if not req.model.strip():
        raise HTTPException(status_code=400, detail="model cannot be empty")
    try:
        _write_env_key("COPILOT_CHAT_MODEL", req.model.strip())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write env: {exc}") from exc
    _log.info("settings.llm.copilot_model_updated", model=req.model, actor=_user.email)
    return {"ok": "true", "model": req.model.strip()}

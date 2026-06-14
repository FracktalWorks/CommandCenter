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
from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

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


def _recreate_litellm_bg() -> None:
    """Update runtime tier config after settings change (no-op — SDK uses in-memory config).

    Previously restarted a LiteLLM Docker container.  Now that all LLM routing
    goes through the gateway's own /v1 endpoint backed by acb_llm SDK, tier
    changes take effect on the next request (acb_llm reads tiers dynamically).
    """
    # Tier changes are live immediately — acb_llm.client reads _TIER_MODEL at call time.
    pass


# Keep backward compat name used elsewhere in this file
_restart_litellm_bg = _recreate_litellm_bg


def _inject_env_into_litellm(env_var: str, value: str) -> None:
    """Update the live os.environ and encrypted key store with a new provider key.

    Since there's no separate LiteLLM proxy, keys are set in the current
    process environment AND the encrypted Postgres key store.  The gateway's
    /v1 endpoint reads from the key store on every request.
    """
    # Update os.environ immediately so _is_provider_configured() returns True.
    os.environ[env_var] = value
    # Also update the encrypted key store (best-effort).
    _sync_key_to_store(env_var, value)


def _sync_key_to_store(env_var: str, value: str) -> None:
    """Write a provider key to the encrypted Postgres key store.

    Maps env var name (e.g. GEMINI_API_KEY) → provider slug (e.g. gemini)
    using the reverse of _PROVIDER_ENV_MAP.
    """
    import asyncio as _asyncio
    # Reverse _PROVIDER_ENV_MAP: "GEMINI_API_KEY" → "gemini", etc.
    _env_to_provider: dict[str, str] = {
        v: k for k, v in _PROVIDER_ENV_MAP.items() if v
    }
    provider = _env_to_provider.get(env_var)
    if not provider:
        return
    try:
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        loop = _asyncio.get_event_loop()
        if loop.is_running():
            # We're in an async context — schedule and forget
            _asyncio.ensure_future(store.put(provider, value.strip()))
        else:
            loop.run_until_complete(store.put(provider, value.strip()))
    except Exception:
        pass  # best-effort — key will be re-seeded from .env on restart


# ---------------------------------------------------------------------------
# Provider detection helpers
# ---------------------------------------------------------------------------

_PROVIDER_ENV_MAP: dict[str, str] = {
    "gemini":      "GEMINI_API_KEY",
    "openai":      "OPENAI_API_KEY",
    "anthropic":   "ANTHROPIC_API_KEY",
    "deepseek":    "DEEPSEEK_API_KEY",
    "openrouter":  "OPENROUTER_API_KEY",
    "github":      "GITHUB_TOKEN",    # GitHub Copilot subscription (also routes Claude)
    "groq":        "GROQ_API_KEY",
    "mistral":     "MISTRAL_API_KEY",
    "together":    "TOGETHER_API_KEY",
    "ollama":      "",        # local — always "configured" if URL reachable
    "vllm":        "VLLM_BASE_URL",
}

_PROVIDER_LABELS: dict[str, str] = {
    "gemini":      "Google Gemini",
    "openai":      "OpenAI",
    "anthropic":   "Anthropic",
    "deepseek":    "DeepSeek",
    "openrouter":  "OpenRouter",
    "github":      "GitHub Copilot",
    "groq":        "Groq",
    "mistral":     "Mistral AI",
    "together":    "Together AI",
    "ollama":      "Ollama (local)",
    "vllm":        "vLLM (local)",
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
        "anthropic/claude-opus-4-5",
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-4",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-3-7-sonnet-latest",
    ],
    "deepseek": [
        "deepseek/deepseek-chat",
        "deepseek/deepseek-reasoner",
        "deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-flash",
    ],
    "openrouter": [
        "openrouter/anthropic/claude-opus-4-5",
        "openrouter/anthropic/claude-sonnet-4-5",
        "openrouter/openai/gpt-4o",
        "openrouter/openai/o3-mini",
        "openrouter/google/gemini-2.5-pro",
        "openrouter/google/gemini-2.5-flash",
        "openrouter/meta-llama/llama-4-maverick",
        "openrouter/deepseek/deepseek-r1",
        "openrouter/deepseek/deepseek-r1-0528",
        "openrouter/deepseek/deepseek-chat-v3-0324",
        "openrouter/deepseek/deepseek-chat",
        "openrouter/deepseek/deepseek-v4-pro",
        "openrouter/deepseek/deepseek-v4-flash",
        # Qwen
        "openrouter/qwen/qwen3.7-max",
        "openrouter/qwen/qwen3.7-plus",
        "openrouter/qwen/qwen3.6-plus",
        "openrouter/qwen/qwen3.5-flash-02-23",
        # Kimi
        "openrouter/moonshotai/kimi-k2.6",
        "openrouter/moonshotai/kimi-k2-thinking",
        "openrouter/moonshotai/kimi-k2.5",
        "openrouter/qwen/qwen3-235b-a22b",
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
    "groq": [
        "groq/llama-3.3-70b-versatile",
        "groq/llama-3.1-8b-instant",
        "groq/llama-3.1-70b-versatile",
        "groq/mixtral-8x7b-32768",
        "groq/gemma2-9b-it",
        "groq/moonshotai/kimi-k2-instruct",
    ],
    "mistral": [
        "mistral/mistral-small-latest",
        "mistral/mistral-medium-latest",
        "mistral/mistral-large-latest",
        "mistral/codestral-latest",
    ],
    "together": [
        "together_ai/meta-llama/Llama-3-70b-chat-hf",
        "together_ai/meta-llama/Llama-3-8b-chat-hf",
        "together_ai/Qwen/Qwen2.5-72B-Instruct-Turbo",
        "together_ai/mistralai/Mistral-7B-Instruct-v0.3",
        "together_ai/deepseek-ai/DeepSeek-R1",
    ],
    "vllm": [
        "openai/Qwen/Qwen3-8B-Instruct",
        "openai/meta-llama/Llama-3.1-8B-Instruct",
        "openai/mistralai/Mistral-7B-Instruct-v0.3",
    ],
}

# ── Model capability metadata ─────────────────────────────────────────────
# Provides human-readable labels and capability flags for known models.
# Used by the /provider-models endpoint to enrich the model list.
_MODEL_CAPABILITIES: dict[str, dict[str, Any]] = {
    # Google Gemini
    "gemini/gemini-2.5-flash-lite": {"label": "Gemini 2.5 Flash Lite", "vision": True, "audio": False, "reasoning": False, "context_window": 1_048_576, "max_output": 8192, "desc": "Fastest Gemini — lightweight tasks, classification, quick chat"},
    "gemini/gemini-2.5-flash":      {"label": "Gemini 2.5 Flash",      "vision": True, "audio": True,  "reasoning": False, "context_window": 1_048_576, "max_output": 8192, "desc": "Fast multimodal model — good for daily work, image understanding"},
    "gemini/gemini-2.5-pro":        {"label": "Gemini 2.5 Pro",        "vision": True, "audio": True,  "reasoning": True,  "context_window": 2_097_152, "max_output": 65536, "desc": "Most capable Gemini — complex reasoning, long context, multimodal"},
    "gemini/gemini-2.0-flash":      {"label": "Gemini 2.0 Flash",      "vision": True, "audio": True,  "reasoning": False, "context_window": 1_048_576, "max_output": 8192, "desc": "Previous-gen fast multimodal model"},
    "gemini/gemini-1.5-pro":        {"label": "Gemini 1.5 Pro",        "vision": True, "audio": True,  "reasoning": False, "context_window": 2_097_152, "max_output": 8192, "desc": "Previous-gen — very long context window"},

    # OpenAI
    "openai/gpt-4o-mini": {"label": "GPT-4o Mini",  "vision": True,  "audio": False, "reasoning": False, "context_window": 128_000, "max_output": 16384, "desc": "Fast, affordable — daily tasks, chat, light reasoning"},
    "openai/gpt-4o":      {"label": "GPT-4o",       "vision": True,  "audio": True,  "reasoning": False, "context_window": 128_000, "max_output": 16384, "desc": "Flagship multimodal — vision, audio, strong reasoning"},
    "openai/gpt-4.1":     {"label": "GPT-4.1",      "vision": True,  "audio": False, "reasoning": False, "context_window": 1_048_576, "max_output": 32768, "desc": "Latest GPT-4 — very long context, coding-optimised"},
    "openai/gpt-4.1-mini":{"label": "GPT-4.1 Mini", "vision": True,  "audio": False, "reasoning": False, "context_window": 1_048_576, "max_output": 16384, "desc": "Smaller GPT-4.1 — fast with long context"},
    "openai/o3-mini":     {"label": "o3-mini",      "vision": False, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 100_000, "desc": "Reasoning specialist — maths, code, logic, STEM"},
    "openai/o3":          {"label": "o3",           "vision": True,  "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 100_000, "desc": "Most capable reasoning model — vision + deep thought"},

    # Anthropic
    "anthropic/claude-opus-4-5":        {"label": "Claude Opus 4.5",      "vision": True, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 32768, "desc": "Most capable Claude — complex analysis, writing, code"},
    "anthropic/claude-sonnet-4-5":      {"label": "Claude Sonnet 4.5",    "vision": True, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 16384, "desc": "Best balance — strong reasoning, fast, cost-effective"},
    "anthropic/claude-haiku-4-5":       {"label": "Claude Haiku 4.5",     "vision": True, "audio": False, "reasoning": False, "context_window": 200_000, "max_output": 8192,  "desc": "Fastest Claude — quick tasks, chat, triage"},
    "anthropic/claude-opus-4":          {"label": "Claude Opus 4",        "vision": True, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 32768, "desc": "Previous-gen Opus — still very capable"},
    "anthropic/claude-sonnet-4":        {"label": "Claude Sonnet 4",      "vision": True, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 16384, "desc": "Previous-gen Sonnet — strong all-rounder"},
    "anthropic/claude-3-7-sonnet-latest":{"label": "Claude 3.7 Sonnet",   "vision": True, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 16384, "desc": "Previous-gen — extended thinking support"},

    # DeepSeek
    "deepseek/deepseek-chat":      {"label": "DeepSeek-V3",       "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192,  "desc": "General-purpose chat — strong coding and reasoning"},
    "deepseek/deepseek-reasoner":  {"label": "DeepSeek-R1",       "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192,  "desc": "Deep reasoning — chain-of-thought for complex problems"},
    "deepseek/deepseek-v4-pro":   {"label": "DeepSeek-V4 Pro",   "vision": True,  "audio": False, "reasoning": True,  "context_window": 262_144, "max_output": 32768, "desc": "Latest flagship — MoE architecture, vision, 256K context"},
    "deepseek/deepseek-v4-flash": {"label": "DeepSeek-V4 Flash", "vision": True,  "audio": False, "reasoning": False, "context_window": 262_144, "max_output": 16384, "desc": "Fast V4 variant — vision support, great for daily tasks"},

    # Groq
    "groq/llama-3.3-70b-versatile":    {"label": "Llama 3.3 70B",      "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Meta's latest 70B — strong general-purpose model"},
    "groq/llama-3.1-8b-instant":        {"label": "Llama 3.1 8B",       "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Ultra-fast 8B — simple tasks, classification"},
    "groq/llama-3.1-70b-versatile":     {"label": "Llama 3.1 70B",      "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Solid 70B — good balance of speed and quality"},
    "groq/mixtral-8x7b-32768":          {"label": "Mixtral 8x7B",       "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096, "desc": "Mistral MoE — efficient for its size"},
    "groq/gemma2-9b-it":                {"label": "Gemma 2 9B",         "vision": False, "audio": False, "reasoning": False, "context_window": 8192,   "max_output": 4096, "desc": "Google's lightweight model — fast and efficient"},
    "groq/moonshotai/kimi-k2-instruct": {"label": "Kimi K2",            "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Moonshot AI — strong reasoning, long context"},

    # Mistral
    "mistral/mistral-small-latest":  {"label": "Mistral Small",  "vision": False, "audio": False, "reasoning": False, "context_window": 32768, "max_output": 4096,  "desc": "Lightweight — fast, affordable, good for simple tasks"},
    "mistral/mistral-medium-latest": {"label": "Mistral Medium", "vision": False, "audio": False, "reasoning": False, "context_window": 32768, "max_output": 8192,  "desc": "Mid-tier — good balance for most tasks"},
    "mistral/mistral-large-latest":  {"label": "Mistral Large",  "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 32768, "desc": "Most capable Mistral — complex reasoning, long context"},
    "mistral/codestral-latest":      {"label": "Codestral",      "vision": False, "audio": False, "reasoning": False, "context_window": 32768, "max_output": 8192,  "desc": "Code-specialised — fill-in-the-middle, code generation"},

    # GitHub Copilot
    "github/gpt-4o-mini":   {"label": "GPT-4o Mini (Copilot)",   "vision": True,  "audio": False, "reasoning": False, "context_window": 128_000, "max_output": 16384, "desc": "Fast GPT-4o via Copilot — no extra cost with subscription"},
    "github/gpt-4o":        {"label": "GPT-4o (Copilot)",        "vision": True,  "audio": False, "reasoning": False, "context_window": 128_000, "max_output": 16384, "desc": "Full GPT-4o via Copilot — vision, strong reasoning"},
    "github/claude-sonnet":  {"label": "Claude Sonnet (Copilot)", "vision": True,  "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 16384, "desc": "Claude via Copilot — vision + extended thinking"},
    "github/o3-mini":        {"label": "o3-mini (Copilot)",      "vision": False, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 100_000, "desc": "Reasoning model via Copilot — STEM, logic, code"},
    "github/o1":             {"label": "o1 (Copilot)",           "vision": True,  "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 100_000, "desc": "Deep reasoning via Copilot — hardest problems"},

    # Ollama local
    "ollama/llama3.2":    {"label": "Llama 3.2",     "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 4096,  "desc": "Meta's latest small model — local inference"},
    "ollama/llama3.1:8b": {"label": "Llama 3.1 8B",  "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 4096,  "desc": "Efficient 8B — runs well on consumer hardware"},
    "ollama/qwen2.5:7b":  {"label": "Qwen 2.5 7B",   "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096,  "desc": "Alibaba's Qwen — strong multilingual, coding"},
    "ollama/mistral:7b":  {"label": "Mistral 7B",     "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096,  "desc": "Classic Mistral — efficient, good for local use"},
    "ollama/phi4":        {"label": "Phi-4",          "vision": False, "audio": False, "reasoning": True,  "context_window": 16384,  "max_output": 4096,  "desc": "Microsoft's small reasoning model — surprisingly capable"},
    "ollama/gemma3:4b":   {"label": "Gemma 3 4B",     "vision": False, "audio": False, "reasoning": False, "context_window": 8192,   "max_output": 4096,  "desc": "Google's tiny model — ultra-lightweight local inference"},

    # vLLM default models
    "openai/Qwen/Qwen3-8B-Instruct":             {"label": "Qwen 3 8B",       "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096,  "desc": "Self-hosted Qwen 3 — multilingual, strong coding"},
    "openai/meta-llama/Llama-3.1-8B-Instruct":   {"label": "Llama 3.1 8B",    "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 4096,  "desc": "Self-hosted Llama — reliable general-purpose model"},
    "openai/mistralai/Mistral-7B-Instruct-v0.3": {"label": "Mistral 7B v0.3",  "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096,  "desc": "Self-hosted Mistral — efficient, fast inference"},

    # ── OpenRouter models ─────────────────────────────────────────────────
    "openrouter/anthropic/claude-opus-4-5":    {"label": "Claude Opus 4.5 (OR)",   "vision": True,  "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 32768, "desc": "Most capable Claude via OpenRouter"},
    "openrouter/anthropic/claude-sonnet-4-5":  {"label": "Claude Sonnet 4.5 (OR)", "vision": True,  "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 16384, "desc": "Best balance Claude via OpenRouter"},
    "openrouter/openai/gpt-4o":                {"label": "GPT-4o (OR)",             "vision": True,  "audio": True,  "reasoning": False, "context_window": 128_000, "max_output": 16384, "desc": "Flagship OpenAI multimodal via OpenRouter"},
    "openrouter/openai/o3-mini":               {"label": "o3-mini (OR)",            "vision": False, "audio": False, "reasoning": True,  "context_window": 200_000, "max_output": 100_000, "desc": "Reasoning specialist via OpenRouter"},
    "openrouter/google/gemini-2.5-pro":        {"label": "Gemini 2.5 Pro (OR)",    "vision": True,  "audio": True,  "reasoning": True,  "context_window": 2_097_152, "max_output": 65536, "desc": "Most capable Gemini via OpenRouter"},
    "openrouter/google/gemini-2.5-flash":      {"label": "Gemini 2.5 Flash (OR)",  "vision": True,  "audio": True,  "reasoning": False, "context_window": 1_048_576, "max_output": 8192, "desc": "Fast multimodal Gemini via OpenRouter"},
    "openrouter/meta-llama/llama-4-maverick":  {"label": "Llama 4 Maverick (OR)",  "vision": False, "audio": False, "reasoning": False, "context_window": 1_048_576, "max_output": 8192, "desc": "Meta's latest open model via OpenRouter"},
    "openrouter/deepseek/deepseek-r1":         {"label": "DeepSeek-R1 (OR)",       "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Deep reasoning via OpenRouter"},
    "openrouter/deepseek/deepseek-r1-0528":    {"label": "DeepSeek-R1 0528 (OR)",  "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Latest R1 iteration via OpenRouter"},
    "openrouter/deepseek/deepseek-chat-v3-0324":{"label": "DeepSeek-V3 0324 (OR)", "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Latest V3 iteration via OpenRouter"},
    "openrouter/deepseek/deepseek-chat":       {"label": "DeepSeek-V3 (OR)",       "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "General purpose via OpenRouter"},
    "openrouter/deepseek/deepseek-v4-pro":    {"label": "DeepSeek-V4 Pro (OR)",   "vision": True,  "audio": False, "reasoning": True,  "context_window": 262_144, "max_output": 32768, "desc": "Latest V4 flagship via OpenRouter — MoE, vision, 256K ctx"},
    "openrouter/deepseek/deepseek-v4-flash":  {"label": "DeepSeek-V4 Flash (OR)", "vision": True,  "audio": False, "reasoning": False, "context_window": 262_144, "max_output": 16384, "desc": "Fast V4 variant via OpenRouter — vision support"},
    "openrouter/qwen/qwen3.7-max":            {"label": "Qwen 3.7 Max (OR)",      "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Alibaba's most capable — reasoning, multilingual"},
    "openrouter/qwen/qwen3.7-plus":           {"label": "Qwen 3.7 Plus (OR)",     "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Strong mid-tier Qwen via OpenRouter"},
    "openrouter/qwen/qwen3.6-plus":           {"label": "Qwen 3.6 Plus (OR)",     "vision": False, "audio": False, "reasoning": False, "context_window": 131_072, "max_output": 8192, "desc": "Previous-gen Qwen via OpenRouter"},
    "openrouter/qwen/qwen3.5-flash-02-23":    {"label": "Qwen 3.5 Flash (OR)",    "vision": False, "audio": False, "reasoning": False, "context_window": 32768,  "max_output": 4096, "desc": "Fast budget Qwen via OpenRouter"},
    "openrouter/moonshotai/kimi-k2.6":        {"label": "Kimi K2.6 (OR)",         "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Latest Kimi — strong reasoning, long context"},
    "openrouter/moonshotai/kimi-k2-thinking": {"label": "Kimi K2 Thinking (OR)",  "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 32768, "desc": "Kimi with extended thinking via OpenRouter"},
    "openrouter/moonshotai/kimi-k2.5":        {"label": "Kimi K2.5 (OR)",         "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "Previous-gen Kimi via OpenRouter"},
    "openrouter/qwen/qwen3-235b-a22b":        {"label": "Qwen 3 235B (OR)",       "vision": False, "audio": False, "reasoning": True,  "context_window": 32768,  "max_output": 8192, "desc": "Massive MoE Qwen via OpenRouter"},

    # ── Together AI models ────────────────────────────────────────────────
    "together_ai/meta-llama/Llama-3-70b-chat-hf":       {"label": "Llama 3 70B (Together)",    "vision": False, "audio": False, "reasoning": False, "context_window": 8192,  "max_output": 4096, "desc": "Meta Llama 3 70B via Together AI"},
    "together_ai/meta-llama/Llama-3-8b-chat-hf":        {"label": "Llama 3 8B (Together)",     "vision": False, "audio": False, "reasoning": False, "context_window": 8192,  "max_output": 4096, "desc": "Meta Llama 3 8B via Together AI"},
    "together_ai/Qwen/Qwen2.5-72B-Instruct-Turbo":      {"label": "Qwen 2.5 72B (Together)",   "vision": False, "audio": False, "reasoning": False, "context_window": 32768, "max_output": 4096, "desc": "Alibaba Qwen 72B via Together AI"},
    "together_ai/mistralai/Mistral-7B-Instruct-v0.3":   {"label": "Mistral 7B (Together)",     "vision": False, "audio": False, "reasoning": False, "context_window": 32768, "max_output": 4096, "desc": "Mistral 7B via Together AI"},
    "together_ai/deepseek-ai/DeepSeek-R1":              {"label": "DeepSeek-R1 (Together)",    "vision": False, "audio": False, "reasoning": True,  "context_window": 131_072, "max_output": 8192, "desc": "DeepSeek reasoning via Together AI"},
}

_TIER_LABELS: dict[str, dict[str, str]] = {
    "tier-fast":      {"id": "tier1", "label": "Tier 1 — Fast / Cheap", "description": "Triage, classification, quick routing"},
    "tier-balanced":  {"id": "tier2", "label": "Tier 2 — Balanced",     "description": "Structured extraction, drafting, summaries"},
    "tier-powerful":  {"id": "tier3", "label": "Tier 3 — Powerful",     "description": "Multi-hop reasoning, strategy, planning"},
}


def _provider_from_model(model: str) -> str:
    """Infer provider slug from litellm model string (model field only)."""
    if model.startswith("gemini/"):
        return "gemini"
    if model.startswith("anthropic/"):
        return "anthropic"
    if model.startswith("deepseek/"):
        return "deepseek"
    if model.startswith("openrouter/"):
        return "openrouter"
    if model.startswith("github/"):
        return "github"
    if model.startswith("groq/"):
        return "groq"
    if model.startswith("mistral/"):
        return "mistral"
    if model.startswith("together_ai/"):
        return "together"
    if model.startswith("ollama/"):
        return "ollama"
    if model.startswith("openai/"):
        # check if it looks like a vLLM path (has an extra / after openai/)
        if "/" in model.removeprefix("openai/"):
            return "vllm"
        return "openai"
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
    tier_name: str          # e.g. "tier-fast"
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


class ModelInfo(BaseModel):
    """A single model entry returned by the provider-models endpoint."""
    id: str
    label: str
    provider: str
    vision: bool = False
    audio: bool = False
    reasoning: bool = False
    context_window: int = 0
    max_output: int = 0
    desc: str = ""


class LLMConfig(BaseModel):
    tiers: list[TierInfo]
    providers: list[ProviderInfo]
    litellm_ui_url: str = ""  # no separate proxy — empty string


class TierUpdateRequest(BaseModel):
    tier_name: str   # e.g. "tier-fast"
    model: str       # new litellm model string
    api_base: str | None = None   # for Ollama / vLLM


class TestRequest(BaseModel):
    tier_name: str   # e.g. "tier-fast"


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

    return LLMConfig(
        tiers=tiers,
        providers=providers,
        litellm_ui_url="",  # no separate proxy
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
                # Hosted provider (Gemini, OpenAI, Groq, Mistral, Together)
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
# GET /settings/llm/health  — gateway LLM routing health
# ---------------------------------------------------------------------------

class LiteLLMHealth(BaseModel):
    healthy: bool
    detail: str
    ui_url: str = ""


@router.get("/llm/health", response_model=LiteLLMHealth)
async def llm_health(_user: UserContext = Depends(get_current_user)) -> LiteLLMHealth:
    """Check that the gateway's /v1/chat/completions endpoint is reachable.

    Since LLM routing is now handled by the gateway itself (acb_llm SDK),
    we test the gateway's own endpoint rather than a separate proxy.
    """
    settings = get_settings()
    base = str(settings.litellm_base_url).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.post(
                f"{base}/v1/chat/completions",
                json={"model": "tier-balanced",
                      "messages": [{"role": "user", "content": "ping"}],
                      "max_tokens": 5},
            )
        healthy = r.status_code == 200
        detail = "Online" if healthy else f"HTTP {r.status_code}"
    except Exception as exc:
        healthy = False
        detail = f"Unreachable: {exc}"
    return LiteLLMHealth(healthy=healthy, detail=detail, ui_url="")


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

    from acb_llm.client import LLMTier, complete

    tier_map = {"tier-fast": "tier1", "tier-balanced": "tier2", "tier-powerful": "tier3"}
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
    provider: str   # "gemini" | "openai" | "github" | "groq" | ...
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
        # Update the live process environment so _is_provider_configured()
        # returns True immediately without a gateway restart.
        os.environ[env_var] = req.api_key.strip()
        # Bust the settings LRU cache so get_settings() also picks up the new value.
        try:
            from acb_common.settings import \
                get_settings as _gs  # noqa: PLC0415
            _gs.cache_clear()
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write env: {exc}") from exc
    _log.info("settings.llm.key_updated", provider=req.provider, actor=_user.email)
    # Inject key into running LiteLLM container immediately (no restart needed).
    # Fallback: restart the container so it picks up the new .env value.
    _inject_env_into_litellm(env_var, req.api_key.strip())
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


# ---------------------------------------------------------------------------
# Custom model catalogue  — user-managed entries stored in infra/custom_models.json
# ---------------------------------------------------------------------------

def _custom_models_path() -> Path:
    """Locate infra/custom_models.json next to infra/litellm/config.yaml."""
    try:
        return _infra_dir() / "custom_models.json"
    except FileNotFoundError:
        return Path.cwd() / "custom_models.json"


def _load_custom_models() -> list[dict[str, str]]:
    p = _custom_models_path()
    if not p.exists():
        return []
    try:
        import json  # noqa: PLC0415
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


def _save_custom_models(models: list[dict[str, str]]) -> None:
    import json  # noqa: PLC0415
    p = _custom_models_path()
    p.write_text(json.dumps(models, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_catalogue() -> dict[str, object]:
    """Load custom_models.json as a dict with 'custom' and 'hidden' lists."""
    import json  # noqa: PLC0415
    p = _custom_models_path()
    if not p.exists():
        return {"custom": [], "hidden": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        # Support legacy format (plain list = custom models only)
        if isinstance(data, list):
            return {"custom": data, "hidden": []}
        return {
            "custom": data.get("custom", []) if isinstance(data, dict) else [],
            "hidden": data.get("hidden", []) if isinstance(data, dict) else [],
        }
    except Exception:  # noqa: BLE001
        return {"custom": [], "hidden": []}


def _save_catalogue(catalogue: dict[str, object]) -> None:
    import json  # noqa: PLC0415
    p = _custom_models_path()
    p.write_text(json.dumps(catalogue, indent=2, ensure_ascii=False), encoding="utf-8")


# Keep old helpers working for backward compat
def _load_custom_models() -> list[dict[str, str]]:
    cat = _load_catalogue()
    raw = cat.get("custom", [])
    return raw if isinstance(raw, list) else []  # type: ignore[return-value]


def _save_custom_models(models: list[dict[str, str]]) -> None:
    cat = _load_catalogue()
    cat["custom"] = models  # type: ignore[assignment]
    _save_catalogue(cat)


class CustomModelEntry(BaseModel):
    id: str        # LiteLLM model string, e.g. "openrouter/qwen/qwen3.8-preview"
    label: str     # display name in the picker
    provider: str  # "gemini" | "openrouter" | "anthropic" | ...
    group: str = ""  # optional group label override (defaults to "Custom — {provider}")


class CustomModelAddRequest(BaseModel):
    id: str
    label: str
    provider: str
    group: str = ""


@router.get("/llm/custom-models")
async def list_custom_models(
    _user: UserContext = Depends(get_current_user),
) -> dict[str, object]:
    """Return custom models and the hidden model list."""
    cat = _load_catalogue()
    return {
        "custom": [CustomModelEntry(**m) for m in (cat.get("custom") or [])],
        "hidden": cat.get("hidden") or [],
    }


@router.post("/llm/custom-models", status_code=201)
async def add_custom_model(
    req: CustomModelAddRequest,
    _user: UserContext = Depends(get_current_user),
) -> CustomModelEntry:
    """Add a custom model to the catalogue.

    The model ID must be a valid LiteLLM model string that the configured
    provider can route (e.g. ``openrouter/qwen/qwen3.8-preview``).
    No LiteLLM restart is required — the model is routed directly on the
    next request using the provider's API key already in os.environ.
    """
    model_id = req.id.strip()
    if not model_id:
        raise HTTPException(status_code=400, detail="id cannot be empty")
    if not req.label.strip():
        raise HTTPException(status_code=400, detail="label cannot be empty")

    models = _load_custom_models()
    # Prevent duplicates
    if any(m["id"] == model_id for m in models):
        raise HTTPException(status_code=409, detail=f"Model {model_id!r} already in custom list")

    provider = req.provider.strip() or _provider_from_model(model_id)
    group = req.group.strip() or f"Custom — {provider.title()}"
    entry: dict[str, str] = {
        "id": model_id,
        "label": req.label.strip(),
        "provider": provider,
        "group": group,
    }
    models.append(entry)
    _save_custom_models(models)
    _log.info("settings.llm.custom_model_added", id=model_id, actor=_user.email)
    return CustomModelEntry(**entry)


@router.delete("/llm/custom-models/{model_id:path}", status_code=200)
async def remove_custom_model(
    model_id: str,
    _user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Remove a custom model entry by its LiteLLM model ID."""
    models = _load_custom_models()
    new_models = [m for m in models if m["id"] != model_id]
    if len(new_models) == len(models):
        raise HTTPException(status_code=404, detail=f"Model {model_id!r} not found in custom list")
    _save_custom_models(new_models)
    _log.info("settings.llm.custom_model_removed", id=model_id, actor=_user.email)
    return {"deleted": model_id}


# ---------------------------------------------------------------------------
# Hidden model list  — models suppressed from the chat picker
# ---------------------------------------------------------------------------

@router.get("/llm/hidden-models")
async def list_hidden_models(
    _user: UserContext = Depends(get_current_user),
) -> list[str]:
    """Return the list of model IDs currently hidden from the chat picker."""
    cat = _load_catalogue()
    raw = cat.get("hidden", [])
    return raw if isinstance(raw, list) else []  # type: ignore[return-value]


@router.post("/llm/hidden-models", status_code=201)
async def hide_model(
    body: dict[str, str],
    _user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Add a model ID to the hidden list so it no longer appears in the chat picker."""
    model_id = (body.get("id") or "").strip()
    if not model_id:
        raise HTTPException(status_code=400, detail="id cannot be empty")
    cat = _load_catalogue()
    hidden: list[str] = cat.get("hidden", [])  # type: ignore[assignment]
    if not isinstance(hidden, list):
        hidden = []
    if model_id not in hidden:
        hidden.append(model_id)
        cat["hidden"] = hidden  # type: ignore[assignment]
        _save_catalogue(cat)
        _log.info("settings.llm.model_hidden", id=model_id, actor=_user.email)
    return {"hidden": model_id}


@router.delete("/llm/hidden-models/{model_id:path}", status_code=200)
async def unhide_model(
    model_id: str,
    _user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Remove a model ID from the hidden list so it reappears in the chat picker."""
    cat = _load_catalogue()
    hidden: list[str] = cat.get("hidden", [])  # type: ignore[assignment]
    if not isinstance(hidden, list):
        hidden = []
    if model_id not in hidden:
        raise HTTPException(status_code=404, detail=f"Model {model_id!r} is not hidden")
    hidden.remove(model_id)
    cat["hidden"] = hidden  # type: ignore[assignment]
    _save_catalogue(cat)
    _log.info("settings.llm.model_unhidden", id=model_id, actor=_user.email)
    return {"unhidden": model_id}


# ---------------------------------------------------------------------------
# Provider model cache
# Structure of infra/provider_models_cache.json:
#   {
#     "openrouter": {
#       "fetched_at": "2026-06-14T10:00:00Z",
#       "models": [{id, label, provider, vision, audio, reasoning,
#                   context_window, max_output, desc}, ...]
#     },
#     ...
#   }
# ---------------------------------------------------------------------------

_CACHE_TTL_SECONDS = 7 * 24 * 3600  # 7 days


def _models_cache_path() -> Path:
    try:
        return _infra_dir() / "provider_models_cache.json"
    except FileNotFoundError:
        return Path.cwd() / "provider_models_cache.json"


def _load_models_cache() -> dict[str, Any]:
    import json  # noqa: PLC0415
    p = _models_cache_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _save_models_cache(cache: dict[str, Any]) -> None:
    import json  # noqa: PLC0415
    p = _models_cache_path()
    p.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _cache_entry_fresh(entry: dict[str, Any]) -> bool:
    """True if the cache entry was fetched within _CACHE_TTL_SECONDS."""
    import datetime  # noqa: PLC0415
    fetched_at = entry.get("fetched_at", "")
    if not fetched_at:
        return False
    try:
        ts = datetime.datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        now = datetime.datetime.now(datetime.timezone.utc)
        return (now - ts).total_seconds() < _CACHE_TTL_SECONDS
    except Exception:  # noqa: BLE001
        return False


def _model_info_from_caps(model_id: str, provider: str) -> ModelInfo:
    """Build a ModelInfo from _MODEL_CAPABILITIES, falling back to bare defaults."""
    caps = _MODEL_CAPABILITIES.get(model_id, {})
    return ModelInfo(
        id=model_id,
        label=caps.get("label", model_id.split("/")[-1]),
        provider=provider,
        vision=caps.get("vision", False),
        audio=caps.get("audio", False),
        reasoning=caps.get("reasoning", False),
        context_window=caps.get("context_window", 0),
        max_output=caps.get("max_output", 0),
        desc=caps.get("desc", ""),
    )


# ── Per-provider live fetch functions ────────────────────────────────────────

async def _fetch_openrouter(key: str | None) -> list[ModelInfo]:
    """Fetch all models from OpenRouter — no auth required, key adds rate limits."""
    import datetime  # noqa: PLC0415
    headers: dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers=headers,
            )
            r.raise_for_status()
            data = r.json().get("data", [])
    except Exception as exc:  # noqa: BLE001
        _log.warning("openrouter.fetch_failed", error=str(exc))
        return []

    result: list[ModelInfo] = []
    for m in data:
        mid = f"openrouter/{m.get('id', '').lstrip('openrouter/')}"
        name: str = m.get("name", mid.split("/")[-1])
        # Strip common "Provider: " prefixes from display names
        for prefix in ("OpenRouter: ", "openrouter: "):
            name = name.removeprefix(prefix)
        ctx = int(m.get("context_length") or 0)
        arch = m.get("architecture") or {}
        inp_mod: list[str] = arch.get("input_modalities") or []
        vision = "image" in inp_mod
        audio = "audio" in inp_mod
        # Heuristic reasoning flag
        lid = mid.lower()
        reasoning = any(
            x in lid
            for x in ("r1", "reasoner", "thinking", "o3", "o1-", "deepseek-r")
        )
        # Check static caps first (more accurate)
        caps = _MODEL_CAPABILITIES.get(mid, {})
        result.append(ModelInfo(
            id=mid,
            label=caps.get("label", name),
            provider="openrouter",
            vision=caps.get("vision", vision),
            audio=caps.get("audio", audio),
            reasoning=caps.get("reasoning", reasoning),
            context_window=caps.get("context_window", ctx),
            max_output=caps.get("max_output", 0),
            desc=caps.get("desc", m.get("description", "")[:120]),
        ))
    return result


async def _fetch_openai_compat(
    provider: str,
    base_url: str,
    api_key: str,
    prefix: str,
    auth_header: str = "Authorization",
    auth_scheme: str = "Bearer",
    extra_headers: dict[str, str] | None = None,
) -> list[ModelInfo]:
    """Fetch models from any OpenAI-compatible endpoint."""
    hdrs: dict[str, str] = {auth_header: f"{auth_scheme} {api_key}"}
    if extra_headers:
        hdrs.update(extra_headers)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{base_url}/models", headers=hdrs)
            r.raise_for_status()
            data = r.json().get("data", [])
    except Exception as exc:  # noqa: BLE001
        _log.warning(f"{provider}.fetch_failed", error=str(exc))
        return []

    result: list[ModelInfo] = []
    for m in data:
        raw_id: str = m.get("id", "")
        # Skip empty or ownership-only entries
        if not raw_id or ":" in raw_id:
            continue
        mid = f"{prefix}{raw_id}"
        result.append(_model_info_from_caps(mid, provider))
    return result


async def _fetch_gemini(api_key: str) -> list[ModelInfo]:
    """Fetch models from Google Generative Language API."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 100},
            )
            r.raise_for_status()
            data = r.json().get("models", [])
    except Exception as exc:  # noqa: BLE001
        _log.warning("gemini.fetch_failed", error=str(exc))
        return []

    result: list[ModelInfo] = []
    for m in data:
        name: str = m.get("name", "")  # "models/gemini-2.0-flash"
        raw = name.removeprefix("models/")
        if not raw:
            continue
        # Only include generative models
        methods: list[str] = m.get("supportedGenerationMethods", [])
        if "generateContent" not in methods:
            continue
        mid = f"gemini/{raw}"
        ctx = int(m.get("inputTokenLimit") or 0)
        out = int(m.get("outputTokenLimit") or 0)
        caps = _MODEL_CAPABILITIES.get(mid, {})
        result.append(ModelInfo(
            id=mid,
            label=caps.get("label", m.get("displayName", raw)),
            provider="gemini",
            vision=caps.get("vision", False),
            audio=caps.get("audio", False),
            reasoning=caps.get("reasoning", False),
            context_window=caps.get("context_window", ctx),
            max_output=caps.get("max_output", out),
            desc=caps.get("desc", m.get("description", "")[:120]),
        ))
    return result


async def _fetch_anthropic(api_key: str) -> list[ModelInfo]:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                "https://api.anthropic.com/v1/models",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
            )
            r.raise_for_status()
            data = r.json().get("data", [])
    except Exception as exc:  # noqa: BLE001
        _log.warning("anthropic.fetch_failed", error=str(exc))
        return []

    result: list[ModelInfo] = []
    for m in data:
        raw = m.get("id", "")
        if not raw:
            continue
        mid = f"anthropic/{raw}"
        result.append(_model_info_from_caps(mid, "anthropic"))
    return result


async def _fetch_ollama(base_url: str) -> list[ModelInfo]:
    url = base_url.rstrip("/")
    # Try the /api/tags endpoint (Ollama native)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{url}/api/tags")
            r.raise_for_status()
            data = r.json().get("models", [])
    except Exception:  # noqa: BLE001
        return []

    result: list[ModelInfo] = []
    for m in data:
        raw = m.get("name", "")
        if not raw:
            continue
        mid = f"ollama/{raw}"
        result.append(_model_info_from_caps(mid, "ollama"))
    return result


async def _fetch_live_models(
    provider: str,
    api_key: str | None = None,
    api_base: str | None = None,
) -> list[ModelInfo]:
    """Dispatch to the right live-fetch function per provider."""
    if provider == "openrouter":
        return await _fetch_openrouter(api_key)

    if provider == "gemini" and api_key:
        return await _fetch_gemini(api_key)

    if provider == "anthropic" and api_key:
        return await _fetch_anthropic(api_key)

    if provider == "openai" and api_key:
        return await _fetch_openai_compat(
            "openai", "https://api.openai.com/v1", api_key, "openai/",
        )

    if provider == "deepseek" and api_key:
        return await _fetch_openai_compat(
            "deepseek", "https://api.deepseek.com/v1", api_key, "deepseek/",
        )

    if provider == "groq" and api_key:
        return await _fetch_openai_compat(
            "groq", "https://api.groq.com/openai/v1", api_key, "groq/",
        )

    if provider == "mistral" and api_key:
        return await _fetch_openai_compat(
            "mistral", "https://api.mistral.ai/v1", api_key, "mistral/",
        )

    if provider == "together" and api_key:
        return await _fetch_openai_compat(
            "together",
            "https://api.together.xyz/v1",
            api_key,
            "together_ai/",
        )

    if provider == "ollama":
        base = api_base or "http://localhost:11434"
        return await _fetch_ollama(base)

    # github / vllm / unknown — fall back to static list
    return []


def _static_models_for_provider(provider: str) -> list[ModelInfo]:
    """Return static ModelInfo list from _PROVIDER_MODELS."""
    return [
        _model_info_from_caps(mid, provider)
        for mid in _PROVIDER_MODELS.get(provider, [])
    ]


# ---------------------------------------------------------------------------
# GET /settings/llm/provider-models — return cached (or static fallback) models
# ---------------------------------------------------------------------------

@router.get("/llm/provider-models", response_model=list[ModelInfo])
async def list_provider_models(
    provider: str,
    _user: UserContext = Depends(get_current_user),
) -> list[ModelInfo]:
    """Return models for a provider.

    Checks the on-disk cache first.  If the cache entry is stale or missing,
    falls back to the static list so the UI is never empty.  Use the refresh
    endpoint to populate / update the cache.
    """
    cache = _load_models_cache()
    entry = cache.get(provider, {})
    if entry and _cache_entry_fresh(entry):
        raw = entry.get("models", [])
        return [ModelInfo(**m) for m in raw]

    # Cache miss / stale → serve static list (UI never empty)
    return _static_models_for_provider(provider)


class RefreshRequest(BaseModel):
    providers: list[str] | None = None  # None = all configured


class RefreshResult(BaseModel):
    provider: str
    count: int
    fetched_at: str
    error: str | None = None


# ---------------------------------------------------------------------------
# POST /settings/llm/provider-models/refresh — fetch live models from APIs
# ---------------------------------------------------------------------------

@router.post(
    "/llm/provider-models/refresh",
    response_model=list[RefreshResult],
)
async def refresh_provider_models(
    req: RefreshRequest,
    _user: UserContext = Depends(get_current_user),
) -> list[RefreshResult]:
    """Fetch the latest model list from each configured provider and cache it.

    Pass ``providers`` to refresh only specific providers, or omit / pass
    ``null`` to refresh all configured ones.  Results are written to
    infra/provider_models_cache.json and returned immediately.
    """
    import datetime  # noqa: PLC0415

    # Determine which providers to refresh
    to_refresh: list[str] = req.providers or list(_PROVIDER_ENV_MAP.keys())
    # Always include openrouter (no key required)
    if "openrouter" not in to_refresh:
        to_refresh.append("openrouter")

    cache = _load_models_cache()
    results: list[RefreshResult] = []

    for provider in to_refresh:
        # Resolve API key from env
        env_var = _PROVIDER_ENV_MAP.get(provider, "")
        api_key: str | None = None
        if env_var:
            api_key = os.environ.get(env_var, "").strip() or None
            if not api_key:
                try:
                    api_key = (
                        getattr(get_settings(), env_var.lower(), "") or ""
                    ).strip() or None
                except Exception:  # noqa: BLE001
                    pass

        # Skip providers that need a key but don't have one (except openrouter)
        if provider != "openrouter" and provider not in ("ollama", "vllm") and not api_key:
            results.append(RefreshResult(
                provider=provider,
                count=0,
                fetched_at=datetime.datetime.now(
                    datetime.timezone.utc
                ).isoformat(),
                error="No API key configured",
            ))
            continue

        fetched_at = datetime.datetime.now(
            datetime.timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            models = await _fetch_live_models(provider, api_key)
        except Exception as exc:  # noqa: BLE001
            models = []
            _log.warning(
                "provider_models.refresh_failed",
                provider=provider,
                error=str(exc),
            )
            results.append(RefreshResult(
                provider=provider,
                count=0,
                fetched_at=fetched_at,
                error=str(exc),
            ))
            continue

        if not models:
            # Live fetch returned nothing — keep previous cache entry if any
            prev = cache.get(provider, {})
            results.append(RefreshResult(
                provider=provider,
                count=len(prev.get("models", [])),
                fetched_at=fetched_at,
                error="No models returned from API",
            ))
            continue

        cache[provider] = {
            "fetched_at": fetched_at,
            "models": [m.model_dump() for m in models],
        }
        results.append(RefreshResult(
            provider=provider,
            count=len(models),
            fetched_at=fetched_at,
        ))
        _log.info(
            "provider_models.refreshed",
            provider=provider,
            count=len(models),
        )

    _save_models_cache(cache)
    return results


# ---------------------------------------------------------------------------
# GET /settings/llm/provider-models/cache-info — metadata about the cache
# ---------------------------------------------------------------------------

class CacheInfo(BaseModel):
    provider: str
    fetched_at: str | None
    count: int
    fresh: bool


@router.get(
    "/llm/provider-models/cache-info",
    response_model=list[CacheInfo],
)
async def get_cache_info(
    _user: UserContext = Depends(get_current_user),
) -> list[CacheInfo]:
    """Return cache metadata (last-fetched timestamp, model count, freshness)."""
    cache = _load_models_cache()
    result: list[CacheInfo] = []
    for provider in list(_PROVIDER_ENV_MAP.keys()) + ["openrouter"]:
        entry = cache.get(provider, {})
        result.append(CacheInfo(
            provider=provider,
            fetched_at=entry.get("fetched_at"),
            count=len(entry.get("models", [])),
            fresh=_cache_entry_fresh(entry),
        ))
    # Deduplicate (openrouter may appear twice)
    seen: set[str] = set()
    deduped: list[CacheInfo] = []
    for c in result:
        if c.provider not in seen:
            seen.add(c.provider)
            deduped.append(c)
    return deduped

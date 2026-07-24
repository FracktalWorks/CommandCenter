"""One source of truth for "how big is this model?".

Before this module the answer was scattered across five places that disagreed.
For ``deepseek/deepseek-v4-pro`` alone the codebase held five context-window
values (0 / 262144 / 840000 / 1000000) and four max-output values
(0 / 8192 / 32768 / 384000), and which one you got depended on which file
happened to ask:

  * ``gateway.routes.settings._MODEL_CAPABILITIES`` -- curated and accurate, but
    only ever read by the Settings UI, never by the runtime that budgets prompts.
  * ``provider_models_cache.json`` -- live from the provider APIs, also read only
    by the Settings UI.
  * litellm's ``model_cost`` registry -- read by the runtime, and **provably
    stale**: it claims ``deepseek/deepseek-v4-pro`` maxes at 8192 output tokens
    while the live model emits 10940 in a single completion.
  * ``acb_llm.client.ensure_model_registered`` -- invented ``max_input_tokens:
    262144`` for any model litellm didn't know, wrote it into ``model_cost``,
    and then ``context_window_for`` read it straight back as though litellm had
    said it. A guess, laundered into a fact.
  * ``_TIER_CONTEXT_WINDOWS`` -- duplicated verbatim in two packages.

Everything now resolves through :func:`get_limits`.

Direction of error
------------------
The two fields fail in opposite directions, so they resolve by opposite rules.
This is deliberate, not an inconsistency:

``context_window`` resolves **conservatively** -- the smallest positive value any
trusted source reports. Over-claiming a window is unrecoverable: the provider
hard-rejects the request, and ``acompletion_with_fallback`` answers that by
retrying on a *different model* rather than re-fitting, while agent runs never
touch that path at all. Under-claiming merely trims a little sooner.

The cost of that rule, stated plainly: a curated entry that is stale-LOW now
binds, where before litellm's larger number would have won. That is the
intended direction of error, and the remedy is cheap in a way it wasn't
before -- there is now exactly one table to correct, and
``ACB_LIMITS__<MODEL>__CONTEXT_WINDOW`` fixes it without a deploy. It also
retires a real over-claim: a model id litellm didn't know matched on its BARE
suffix, so ``openrouter/deepseek/deepseek-v4-pro`` inherited the *direct*
provider's 1M window when OpenRouter serves it at 262K -- a 4x over-claim that
the provider could only answer with a hard rejection.

``max_output`` resolves by **trust order**, curated first. Under-claiming it is
what truncated a tool call's JSON arguments mid-string and produced the "agent
produced no text output" failure; litellm's stale 8192 is exactly the wrong
answer for this fleet, so a value we maintain outranks it.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

# Marker written by ``acb_llm.client.ensure_model_registered`` onto the minimal
# entries it injects into litellm's ``model_cost`` so litellm can ROUTE a model
# it doesn't know. Those entries carry invented token numbers; this flag lets us
# keep the routing while refusing to believe the numbers.
STUB_MARKER = "_acb_stub"

# Fallback when nothing knows the model. 128K is today's floor for a current
# frontier model, not a safe universal minimum -- but it is the better bet: the
# old 32768 default silently starved every unknown model to a quarter of its
# real window, and a too-large guess is caught by the provider and retried,
# whereas a too-small one is invisible and permanent.
DEFAULT_CONTEXT_WINDOW = 128_000
DEFAULT_MAX_OUTPUT = 8_192

# Context windows for models litellm's registry does NOT know (self-hosted,
# private endpoints, legacy non-gateway aliases).
#
# Gateway tier aliases (tier-fast / tier-balanced / tier-powerful) are
# intentionally ABSENT: they resolve through ``_TIER_MODEL`` at call time so the
# window tracks whatever the Settings UI currently points the tier at. Pinning
# them here would go stale the moment a tier is re-assigned.
FALLBACK_CONTEXT_WINDOWS: dict[str, int] = {
    "tier1-local-qwen3": 32_768,   # local Qwen3 via vLLM (not in litellm)
    "tier2-sonnet": 200_000,       # legacy alias for Claude Sonnet tiers
    "tier3-opus": 200_000,         # legacy alias for Claude Opus tiers
}

# -- Model catalogue -------------------------------------------------------
# Curated facts about known models: UI presentation (label/desc/vision/audio/
# reasoning) AND the limits the runtime budgets against (context_window /
# max_output). One table, because two tables is how the numbers drifted apart
# in the first place. It lives in acb_llm -- the lowest layer that needs it --
# and the gateway's Settings UI imports it from here.
MODEL_CAPABILITIES: dict[str, dict[str, Any]] = {
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

    # DeepSeek — V4 models are 1M context / 384K max output per DeepSeek docs
    # (https://api-docs.deepseek.com).  The legacy deepseek-chat / deepseek-reasoner
    # names now map to deepseek-v4-flash (non-thinking / thinking) and deprecate
    # 2026-07-24, so they share the same 1M window.
    "deepseek/deepseek-chat":      {"label": "DeepSeek Chat (→V4 Flash)", "vision": False, "audio": False, "reasoning": False, "context_window": 1_000_000, "max_output": 65536,  "desc": "Non-thinking mode of DeepSeek-V4 Flash (legacy name, deprecates 2026-07-24)"},
    "deepseek/deepseek-reasoner":  {"label": "DeepSeek Reasoner (→V4 Flash)", "vision": False, "audio": False, "reasoning": True,  "context_window": 1_000_000, "max_output": 65536,  "desc": "Thinking mode of DeepSeek-V4 Flash (legacy name, deprecates 2026-07-24)"},
    "deepseek/deepseek-v4-pro":   {"label": "DeepSeek-V4 Pro",   "vision": True,  "audio": False, "reasoning": True,  "context_window": 1_000_000, "max_output": 384_000, "desc": "Flagship V4 — MoE, vision, 1M context, 384K max output"},
    "deepseek/deepseek-v4-flash": {"label": "DeepSeek-V4 Flash", "vision": True,  "audio": False, "reasoning": False, "context_window": 1_000_000, "max_output": 384_000, "desc": "Fast V4 variant — vision, 1M context, 384K max output"},

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

    # ── Speech-to-text (transcription) models ─────────────────────────────
    # Routed through litellm.atranscription, not chat completions.
    # ``transcription: True`` marks them so the Settings UI offers them for the
    # STT tier (Note Taker) and keeps them out of the chat-tier pickers;
    # ``audio: True`` = they consume audio input. context_window / max_output
    # do not apply to a transcription endpoint, so they stay 0.
    "groq/whisper-large-v3-turbo":   {"label": "Whisper Large v3 Turbo (Groq)", "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "Fast multilingual transcription on Groq — the default STT model. No named speakers."},
    "groq/whisper-large-v3":         {"label": "Whisper Large v3 (Groq)",       "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "Highest-accuracy Whisper on Groq — multilingual. No named speakers."},
    "openai/whisper-1":              {"label": "Whisper (OpenAI)",              "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "OpenAI's hosted Whisper — reliable multilingual transcription. No named speakers."},
    "openai/gpt-4o-transcribe":      {"label": "GPT-4o Transcribe",             "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "OpenAI's latest speech-to-text — higher accuracy than Whisper. No named speakers."},
    "openai/gpt-4o-mini-transcribe": {"label": "GPT-4o Mini Transcribe",        "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "Fast, affordable GPT-4o transcription. No named speakers."},
    "deepgram/nova-3":               {"label": "Deepgram Nova-3",               "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "Named speakers (diarization) + word timings — best for multi-speaker meetings."},
    "deepgram/nova-2":               {"label": "Deepgram Nova-2",               "vision": False, "audio": True, "transcription": True, "reasoning": False, "context_window": 0, "max_output": 0, "desc": "Named speakers (diarization) + word timings — proven meeting transcription."},
}


@dataclass(frozen=True)
class ModelLimits:
    """Resolved limits for a model, with provenance.

    ``context_source`` / ``max_output_source`` name the winning source
    ("curated" / "litellm" / "fallback" / "default" / "env"). They exist so a
    surprising budget can be traced to whatever claimed it, instead of being
    re-derived by hand across five files.
    """

    context_window: int
    max_output: int
    context_source: str = "default"
    max_output_source: str = "default"


def _candidates(model: str) -> list[str]:
    """``model`` and its bare suffix, de-duped, empties dropped."""
    bare = model.split("/")[-1] if "/" in model else None
    return list(dict.fromkeys([c for c in (model, bare) if c]))


def _curated_for(model: str) -> dict[str, Any] | None:
    """Curated entry for *model*, tried full-id first then bare suffix."""
    for candidate in _candidates(model):
        entry = MODEL_CAPABILITIES.get(candidate)
        if entry:
            return entry
    return None


def _litellm_info(model: str) -> dict[str, Any] | None:
    """litellm's registry entry for *model*, or ``None``.

    Entries we injected ourselves (see :data:`STUB_MARKER`) are skipped: their
    token numbers are placeholders we made up, and believing them is how a guess
    became a fact.
    """
    try:
        from litellm import model_cost
    except Exception:
        return None
    for candidate in _candidates(model):
        info = model_cost.get(candidate)
        if info and not info.get(STUB_MARKER):
            return info
    return None


def _env_override(model: str, field: str) -> int:
    """Per-model escape hatch: ``ACB_LIMITS__<MODEL>__<FIELD>``.

    Non-alphanumerics in the model id become underscores, e.g.
    ``ACB_LIMITS__DEEPSEEK_DEEPSEEK_V4_PRO__MAX_OUTPUT=64000``. Providers raise
    limits between releases; this turns "wait for a deploy" into an env var, so
    no number in the table above has to stay a guess for long.
    """
    slug = "".join(c if c.isalnum() else "_" for c in model).upper()
    try:
        return int(os.environ.get(f"ACB_LIMITS__{slug}__{field.upper()}", "0") or 0)
    except ValueError:
        return 0


def get_limits(model: str) -> ModelLimits:
    """Resolve ``model``'s context window and max output tokens.

    ``model`` may be a gateway tier alias (``tier-powerful``) or a concrete
    litellm id (``deepseek/deepseek-v4-pro``); aliases resolve through the live
    tier mapping first, so a Settings-UI tier change takes effect immediately.

    See the module docstring for why the two fields use opposite resolution
    rules. Always returns positive integers.
    """
    m = (model or "").strip()
    if not m:
        return ModelLimits(DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT)

    # Tier alias -> the model it currently routes to.
    try:
        from acb_llm.context import resolve_underlying_model
        resolved = resolve_underlying_model(m)
    except Exception:
        resolved = m

    curated = _curated_for(resolved) or _curated_for(m)
    info = _litellm_info(resolved)

    # -- context_window: smallest positive value any trusted source reports --
    ctx_candidates: list[tuple[int, str]] = []
    if curated:
        ctx_candidates.append((int(curated.get("context_window") or 0), "curated"))
    if info:
        ctx_candidates.append((
            int(info.get("max_input_tokens") or info.get("max_tokens") or 0),
            "litellm",
        ))
    for candidate in _candidates(resolved) + _candidates(m):
        if candidate in FALLBACK_CONTEXT_WINDOWS:
            ctx_candidates.append((FALLBACK_CONTEXT_WINDOWS[candidate], "fallback"))
            break
    positive = [(v, s) for v, s in ctx_candidates if v > 0]
    context_window, context_source = (
        min(positive, key=lambda p: p[0]) if positive
        else (DEFAULT_CONTEXT_WINDOW, "default")
    )

    # -- max_output: trust order, curated first (litellm is stale here) --
    max_output, max_output_source = DEFAULT_MAX_OUTPUT, "default"
    for value, source in (
        (int((curated or {}).get("max_output") or 0), "curated"),
        (int((info or {}).get("max_output_tokens") or 0), "litellm"),
    ):
        if value > 0:
            max_output, max_output_source = value, source
            break

    # -- env override wins outright (an operator knows better than any table) --
    ctx_override = _env_override(resolved, "context_window") or _env_override(
        m, "context_window")
    if ctx_override > 0:
        context_window, context_source = ctx_override, "env"
    out_override = _env_override(resolved, "max_output") or _env_override(
        m, "max_output")
    if out_override > 0:
        max_output, max_output_source = out_override, "env"

    return ModelLimits(context_window, max_output, context_source, max_output_source)

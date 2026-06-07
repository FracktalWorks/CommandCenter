/**
 * GET /api/models/all
 *
 * Unified model catalogue for the AgentChat model picker.
 *
 * Two runtime groups — each routes through a completely different execution path:
 *
 * 1. "GitHub Copilot SDK" group  (model.runtime = "copilot")
 *    What it is: The GitHub Copilot SDK (`github-copilot-sdk` Python package).
 *                NOT CopilotKit (the React UI library). NOT just an LLM call.
 *    What it does: Launches a `CopilotClient` subprocess running `gh copilot` CLI
 *                  in autopilot mode. Has native tool-calling (shell, file r/w,
 *                  Python scripts). Reads AGENTS.md from the agent workspace.
 *                  Tool events (tool_start/tool_end) stream back to the UI via SSE hooks.
 *    Route: /api/agent/chat?mode=copilot → gateway /copilot/chat → CopilotClient
 *    Auth:  GITHUB_TOKEN (api.githubcopilot.com) or BYOK via LiteLLM
 *    Models: claude-sonnet-4.5, gpt-5.5, gemini-3.1-pro-preview, etc.
 *            (live list from /copilot/models if GITHUB_TOKEN is set; fallback list otherwise)
 *
 * 2. "LiteLLM (tier routing)" group  (model.runtime = "litellm")
 *    What it is: A direct OpenAI-compatible streaming call to the LiteLLM proxy.
 *                No orchestration, no tool calling, no agent workspace.
 *    What it does: Raw /chat/completions call to LiteLLM; response streamed to UI.
 *    Route: /api/agent/chat?mode=litellm → LiteLLM /chat/completions
 *    Models: tier1/2/3 aliases (see infra/litellm/config.yaml for current backend routing)
 *    Current routing: all tiers → Gemini 2.5 Flash variants (GEMINI_API_KEY)
 *
 * Why no copilot/* aliases in the LiteLLM group?
 *    LiteLLM does have copilot/* entries (e.g. copilot/claude-sonnet-4.5) but these
 *    are not shown in the UI — the same models are accessible directly via the
 *    Copilot SDK group, and duplicating them would cause confusion about which
 *    execution path is active.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type ModelRuntime = "copilot" | "litellm";

export interface UnifiedModel {
  id: string;
  label: string;
  runtime: ModelRuntime;
  group: string;
}

export interface UnifiedModelsResponse {
  models: UnifiedModel[];
  source: string;
}

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

const COPILOT_FALLBACK: { id: string; label: string }[] = [
  { id: "auto", label: "auto (SDK picks)" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "gpt-5.5", label: "GPT 5.5" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
];

// LiteLLM aliases defined in infra/litellm/config.yaml (chat-capable only).
// Grouped by provider so the picker can show them in sections.
const LITELLM_MODELS: { id: string; label: string; group: string }[] = [
  // Tiers — always shown first
  { id: "tier1-local-qwen3", label: "Tier 1 — Gemini 2.5 Flash Lite (fast/triage)",  group: "LiteLLM — Tiers" },
  { id: "tier2-sonnet",      label: "Tier 2 — Gemini 2.5 Flash (drafting)",           group: "LiteLLM — Tiers" },
  { id: "tier3-opus",        label: "Tier 3 — Gemini 2.5 Pro (reasoning)",            group: "LiteLLM — Tiers" },
  // Google Gemini
  { id: "gemini/gemini-2.5-pro",        label: "Gemini 2.5 Pro",        group: "LiteLLM — Gemini" },
  { id: "gemini/gemini-2.5-flash",      label: "Gemini 2.5 Flash",      group: "LiteLLM — Gemini" },
  { id: "gemini/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", group: "LiteLLM — Gemini" },
  // Anthropic (direct — requires ANTHROPIC_API_KEY)
  { id: "anthropic/claude-opus-4-5",    label: "Claude Opus 4.5",    group: "LiteLLM — Anthropic" },
  { id: "anthropic/claude-sonnet-4-5",  label: "Claude Sonnet 4.5",  group: "LiteLLM — Anthropic" },
  { id: "anthropic/claude-haiku-4-5",   label: "Claude Haiku 4.5",   group: "LiteLLM — Anthropic" },
  // OpenRouter (requires OPENROUTER_API_KEY — 200+ models via one key)
  { id: "openrouter/anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (OR)", group: "LiteLLM — OpenRouter" },
  { id: "openrouter/openai/gpt-4o",               label: "GPT-4o (OR)",            group: "LiteLLM — OpenRouter" },
  { id: "openrouter/google/gemini-2.5-pro",        label: "Gemini 2.5 Pro (OR)",    group: "LiteLLM — OpenRouter" },
  { id: "openrouter/google/gemini-2.5-flash",      label: "Gemini 2.5 Flash (OR)",  group: "LiteLLM — OpenRouter" },
  { id: "openrouter/meta-llama/llama-4-maverick",  label: "Llama 4 Maverick (OR)",  group: "LiteLLM — OpenRouter" },
  { id: "openrouter/deepseek/deepseek-r1",         label: "DeepSeek R1 (OR)",       group: "LiteLLM — OpenRouter" },
  // OpenAI (direct — requires OPENAI_API_KEY)
  { id: "openai/gpt-4o",    label: "GPT-4o",      group: "LiteLLM — OpenAI" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", group: "LiteLLM — OpenAI" },
  { id: "openai/o3-mini",   label: "o3-mini",     group: "LiteLLM — OpenAI" },
  // GitHub Copilot via LiteLLM proxy
  { id: "copilot/gpt-4o",       label: "GPT-4o (Copilot)",       group: "LiteLLM — Copilot" },
  { id: "copilot/claude-sonnet", label: "Claude Sonnet (Copilot)", group: "LiteLLM — Copilot" },
  { id: "copilot/o3-mini",      label: "o3-mini (Copilot)",      group: "LiteLLM — Copilot" },
];

export async function GET(): Promise<NextResponse<UnifiedModelsResponse>> {
  let copilotModels: { id: string; label: string }[] = COPILOT_FALLBACK;
  let source = "fallback";

  try {
    const res = await fetch(`${GATEWAY_URL}/copilot/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        models?: { id: string; label: string }[];
        source?: string;
      };
      if (Array.isArray(data.models) && data.models.length > 0) {
        copilotModels = [
          { id: "auto", label: "auto (SDK picks)" },
          ...data.models.filter((m) => m.id !== "auto"),
        ];
        source = data.source ?? "live";
      }
    }
  } catch {
    // keep fallback
  }

  const models: UnifiedModel[] = [
    ...copilotModels.map((m) => ({
      id: m.id,
      label: m.label,
      runtime: "copilot" as ModelRuntime,
      group: "GitHub Copilot SDK",
    })),
    ...LITELLM_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      runtime: "litellm" as ModelRuntime,
      group: m.group,
    })),
  ];

  return NextResponse.json({ models, source });
}

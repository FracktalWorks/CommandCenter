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
  configured_providers: string[];
}

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

const COPILOT_FALLBACK: { id: string; label: string }[] = [
  { id: "auto", label: "auto (SDK picks)" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "gpt-5.5", label: "GPT 5.5" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
];

// LiteLLM model catalogue.
// `provider` maps to an env-var gate — the model is only shown when that provider key is set.
// `provider: null` = always shown (tier aliases route to whatever is configured).
const LITELLM_MODELS: { id: string; label: string; group: string; provider: string | null }[] = [
  // Tiers — always shown; they're routing aliases, not pinned to a single provider key
  { id: "tier1-local-qwen3", label: "Tier 1 (fast / cheap)",   group: "LiteLLM — Tiers",       provider: null },
  { id: "tier2-sonnet",      label: "Tier 2 (balanced)",        group: "LiteLLM — Tiers",       provider: null },
  { id: "tier3-opus",        label: "Tier 3 (powerful)",        group: "LiteLLM — Tiers",       provider: null },
  // Google Gemini — requires GEMINI_API_KEY
  { id: "gemini/gemini-2.5-pro",        label: "Gemini 2.5 Pro",        group: "LiteLLM — Gemini",     provider: "gemini" },
  { id: "gemini/gemini-2.5-flash",      label: "Gemini 2.5 Flash",      group: "LiteLLM — Gemini",     provider: "gemini" },
  { id: "gemini/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", group: "LiteLLM — Gemini",     provider: "gemini" },
  // Anthropic — requires ANTHROPIC_API_KEY
  { id: "anthropic/claude-opus-4-5",   label: "Claude Opus 4.5",   group: "LiteLLM — Anthropic", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "LiteLLM — Anthropic", provider: "anthropic" },
  { id: "anthropic/claude-haiku-4-5",  label: "Claude Haiku 4.5",  group: "LiteLLM — Anthropic", provider: "anthropic" },
  // OpenRouter — requires OPENROUTER_API_KEY
  { id: "openrouter/anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "LiteLLM — OpenRouter", provider: "openrouter" },
  { id: "openrouter/openai/gpt-4o",               label: "GPT-4o",            group: "LiteLLM — OpenRouter", provider: "openrouter" },
  { id: "openrouter/google/gemini-2.5-pro",        label: "Gemini 2.5 Pro",    group: "LiteLLM — OpenRouter", provider: "openrouter" },
  { id: "openrouter/google/gemini-2.5-flash",      label: "Gemini 2.5 Flash",  group: "LiteLLM — OpenRouter", provider: "openrouter" },
  { id: "openrouter/meta-llama/llama-4-maverick",  label: "Llama 4 Maverick",  group: "LiteLLM — OpenRouter", provider: "openrouter" },
  { id: "openrouter/deepseek/deepseek-r1",         label: "DeepSeek R1",       group: "LiteLLM — OpenRouter", provider: "openrouter" },
  // OpenAI — requires OPENAI_API_KEY
  { id: "openai/gpt-4o",     label: "GPT-4o",      group: "LiteLLM — OpenAI",  provider: "openai" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", group: "LiteLLM — OpenAI",  provider: "openai" },
  { id: "openai/o3-mini",    label: "o3-mini",     group: "LiteLLM — OpenAI",  provider: "openai" },
  // GitHub Copilot via LiteLLM proxy — requires GITHUB_TOKEN
  { id: "copilot/gpt-4o",        label: "GPT-4o (Copilot)",        group: "LiteLLM — Copilot", provider: "github" },
  { id: "copilot/claude-sonnet", label: "Claude Sonnet (Copilot)",  group: "LiteLLM — Copilot", provider: "github" },
  { id: "copilot/o3-mini",       label: "o3-mini (Copilot)",        group: "LiteLLM — Copilot", provider: "github" },
];

export async function GET(): Promise<NextResponse<UnifiedModelsResponse>> {
  // ── Detect configured providers from env vars ─────────────────────────────
  // These are read server-side in the Next.js API route so the check is free
  // (no extra gateway round-trip) and always reflects the current .env state.
  const configured = new Set<string>();
  if (process.env.GEMINI_API_KEY?.trim())      configured.add("gemini");
  if (process.env.ANTHROPIC_API_KEY?.trim())   configured.add("anthropic");
  if (process.env.OPENROUTER_API_KEY?.trim())  configured.add("openrouter");
  if (process.env.OPENAI_API_KEY?.trim())      configured.add("openai");
  if (process.env.GITHUB_TOKEN?.trim())        configured.add("github");
  if (process.env.GROQ_API_KEY?.trim())        configured.add("groq");
  if (process.env.MISTRAL_API_KEY?.trim())     configured.add("mistral");
  if (process.env.TOGETHER_API_KEY?.trim())    configured.add("together");
  if (process.env.VLLM_BASE_URL?.trim())       configured.add("vllm");

  // ── GitHub Copilot SDK model list ─────────────────────────────────────────
  // Fetched live from the gateway when GITHUB_TOKEN is set; fallback otherwise.
  let copilotModels: { id: string; label: string }[] = configured.has("github")
    ? COPILOT_FALLBACK
    : [{ id: "auto", label: "auto (SDK picks — needs GITHUB_TOKEN)" }];
  let source = configured.has("github") ? "fallback" : "no-token";

  if (configured.has("github")) {
    try {
      const res = await fetch(`${GATEWAY_URL}/copilot/models`, {
        signal: AbortSignal.timeout(4000),
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
      // keep fallback list
    }
  }

  // ── Build model list — only include provider-specific entries when the key is set ─
  const litellmModels = LITELLM_MODELS.filter(
    (m) => m.provider === null || configured.has(m.provider)
  );

  const models: UnifiedModel[] = [
    // GitHub Copilot SDK group — only shown when GITHUB_TOKEN is set
    ...(configured.has("github")
      ? copilotModels.map((m) => ({
          id: m.id,
          label: m.label,
          runtime: "copilot" as ModelRuntime,
          group: "GitHub Copilot SDK",
        }))
      : []),
    // LiteLLM group — tiers always shown, provider-specific models gated by key
    ...litellmModels.map((m) => ({
      id: m.id,
      label: m.label,
      runtime: "litellm" as ModelRuntime,
      group: m.group,
    })),
  ];

  // Always include at least the tiers so the picker is never empty
  if (models.length === 0) {
    LITELLM_MODELS.filter((m) => m.provider === null).forEach((m) =>
      models.push({ id: m.id, label: m.label, runtime: "litellm", group: m.group })
    );
  }

  return NextResponse.json({
    models,
    source,
    configured_providers: Array.from(configured),
  });
}

/**
 * GET /api/models
 *
 * Returns the current LLM model availability for the agents panel.
 * Derives status from env vars that the Next.js server process can see
 * (loaded from the repo root .env at startup).
 *
 * Response shape:
 *   { providers: ProviderInfo[], copilot_models: CopilotModel[] }
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface ProviderInfo {
  /** Internal key */
  id: string;
  /** Display name */
  label: string;
  /** "direct" = paid API key you own; "copilot" = via GitHub Copilot; "local" = self-hosted */
  type: "direct" | "copilot" | "local";
  available: boolean;
  /** Which LiteLLM tier aliases this provider currently backs */
  tiers: string[];
  /** The env var that gates availability */
  env_var: string;
  /** Short description of what you get */
  note: string;
}

export interface CopilotModel {
  /** LiteLLM alias — e.g. "copilot/gpt-4o" */
  alias: string;
  label: string;
  description: string;
  /** Displayed in the tier router section when Copilot is configured */
  suggested_tier?: string;
}

export interface ModelsStatus {
  providers: ProviderInfo[];
  copilot_models: CopilotModel[];
}

export async function GET(): Promise<NextResponse<ModelsStatus>> {
  const gemini      = !!process.env.GEMINI_API_KEY?.trim();
  const openai      = !!process.env.OPENAI_API_KEY?.trim();
  const anthropic   = !!process.env.ANTHROPIC_API_KEY?.trim();
  const openrouter  = !!process.env.OPENROUTER_API_KEY?.trim();
  const vllm        = !!process.env.VLLM_BASE_URL?.trim();
  const github      = !!process.env.GITHUB_TOKEN?.trim();

  const providers: ProviderInfo[] = [
    {
      id: "gemini",
      label: "Gemini",
      type: "direct",
      available: gemini,
      tiers: ["tier1", "tier2", "tier3"],
      env_var: "GEMINI_API_KEY",
      note: "Currently backing all three tiers (2.5-flash family).",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      type: "direct",
      available: anthropic,
      tiers: [],
      env_var: "ANTHROPIC_API_KEY",
      note: "Direct Claude access. Set ANTHROPIC_API_KEY to route a tier to Claude.",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      type: "direct",
      available: openrouter,
      tiers: [],
      env_var: "OPENROUTER_API_KEY",
      note: "200+ models via one key. Set OPENROUTER_API_KEY to use OpenRouter models.",
    },
    {
      id: "openai",
      label: "OpenAI",
      type: "direct",
      available: openai,
      tiers: ["tier2", "tier3"],
      env_var: "OPENAI_API_KEY",
      note: "Route via LiteLLM tier2/tier3 entries.",
    },
    {
      id: "vllm",
      label: "vLLM (local / Qwen3-8B)",
      type: "local",
      available: vllm,
      tiers: ["tier1"],
      env_var: "VLLM_BASE_URL",
      note: "Uncomment in config.yaml to use local inference for tier1.",
    },
    {
      id: "github-copilot",
      label: "GitHub Copilot",
      type: "copilot",
      available: github,
      tiers: ["copilot/*"],
      env_var: "GITHUB_TOKEN",
      note: "PAT with `copilot` scope unlocks GPT-4o, Claude Sonnet, o3-mini at no extra cost.",
    },
  ];

  const copilot_models: CopilotModel[] = [
    {
      alias: "copilot/gpt-4o",
      label: "GPT-4o",
      description: "Fast, general-purpose — good tier2 replacement",
      suggested_tier: "tier2",
    },
    {
      alias: "copilot/claude-sonnet",
      label: "Claude Sonnet 4.5",
      description: "Best for structured reasoning and code",
      suggested_tier: "tier3",
    },
    {
      alias: "copilot/o3-mini",
      label: "o3-mini",
      description: "Deep multi-step reasoning (slower)",
      suggested_tier: "tier3",
    },
  ];

  return NextResponse.json({ providers, copilot_models });
}

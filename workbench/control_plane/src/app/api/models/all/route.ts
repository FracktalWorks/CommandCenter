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
// These are tier alternatives selected based on cost/speed/reasoning tradeoff.
// To avoid confusion, we omit copilot/* from this list since those same models
// are available directly under "GitHub Copilot SDK" above.
const LITELLM_MODELS: { id: string; label: string }[] = [
  { id: "tier1-local-qwen3", label: "Tier 1 — Gemini 2.5 Flash Lite (fast/triage)" },
  { id: "tier2-sonnet", label: "Tier 2 — Gemini 2.5 Flash (drafting)" },
  { id: "tier3-opus", label: "Tier 3 — Gemini 2.5 Flash (reasoning)" },
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
      group: "LiteLLM (gateway)",
    })),
  ];

  return NextResponse.json({ models, source });
}

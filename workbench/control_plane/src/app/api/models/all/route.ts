/**
 * GET /api/models/all
 *
 * Unified model catalogue for the AgentChat model picker.
 * Models come from three sources — nothing is auto-populated from provider keys:
 *   1. Copilot SDK models — live list from the gateway's /copilot/models endpoint
 *   2. Tier aliases — always available routing targets
 *   3. Custom models — user-added entries via Settings → Models → Custom Models
 *
 * Provider API keys only gate the tier editor's dropdown, not this picker.
 * To add a provider model to the chat picker, use the Custom Models section.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type ModelRuntime = "copilot" | "litellm";

export interface UnifiedModel {
  id: string;
  label: string;
  runtime: ModelRuntime;
  group: string;
  model_picker_enabled?: boolean;
}

export interface UnifiedModelsResponse {
  models: UnifiedModel[];
  source: string;
  configured_providers: string[];
}

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

// Tier aliases — always shown as they route to whatever the user has configured.
const TIER_MODELS: { id: string; label: string }[] = [
  { id: "tier1-local-qwen3", label: "Tier 1 (fast / cheap)" },
  { id: "tier2-sonnet",      label: "Tier 2 (balanced)" },
  { id: "tier3-opus",        label: "Tier 3 (powerful)" },
];

export async function GET(): Promise<NextResponse<UnifiedModelsResponse>> {
  const INTERNAL_TOKEN =
    process.env.GATEWAY_INTERNAL_TOKEN ??
    process.env.LITELLM_MASTER_KEY ??
    "sk-local-dev-change-me";

  // ── Fetch provider status from the gateway (for Copilot gating) ─────────
  const configured = new Set<string>();
  let gatewayReachable = false;

  try {
    const provRes = await fetch(`${GATEWAY_URL}/settings/llm`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (provRes.ok) {
      const data = (await provRes.json()) as {
        providers?: { id: string; configured: boolean }[];
      };
      if (Array.isArray(data.providers)) {
        for (const p of data.providers) {
          if (p.configured) configured.add(p.id);
        }
        gatewayReachable = true;
      }
    }
  } catch (_e) {
    // Gateway unreachable — fall back to process.env
  }

  // Fallback: read process.env when gateway is unreachable (dev / cold start)
  if (!gatewayReachable) {
    if (process.env.GEMINI_API_KEY?.trim())      configured.add("gemini");
    if (process.env.ANTHROPIC_API_KEY?.trim())   configured.add("anthropic");
    if (process.env.OPENROUTER_API_KEY?.trim())  configured.add("openrouter");
    if (process.env.OPENAI_API_KEY?.trim())      configured.add("openai");
    if (process.env.GITHUB_TOKEN?.trim())        configured.add("github");
    if (process.env.DEEPSEEK_API_KEY?.trim())    configured.add("deepseek");
    if (process.env.GROQ_API_KEY?.trim())        configured.add("groq");
    if (process.env.MISTRAL_API_KEY?.trim())     configured.add("mistral");
    if (process.env.TOGETHER_API_KEY?.trim())    configured.add("together");
    if (process.env.VLLM_BASE_URL?.trim())       configured.add("vllm");
  }

  // ── Fetch custom models + hidden list from the gateway ───────────────────
  let customModels: { id: string; label: string; provider: string; group: string }[] = [];
  const hiddenSet = new Set<string>();
  try {
    const cr = await fetch(`${GATEWAY_URL}/settings/llm/custom-models`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (cr.ok) {
      const data = (await cr.json()) as
        | { custom?: { id: string; label: string; provider: string; group: string }[]; hidden?: string[] }
        | { id: string; label: string; provider: string; group: string }[];
      if (Array.isArray(data)) {
        customModels = data;
      } else {
        customModels = data.custom ?? [];
        for (const id of data.hidden ?? []) hiddenSet.add(id);
      }
    }
  } catch (_e) {
    // safe to ignore — custom_models.json may not exist yet
  }

  // ── Copilot SDK models — live from gateway, only when GITHUB_TOKEN is set ─
  let copilotModels: { id: string; label: string; model_picker_enabled?: boolean }[] = [];
  let source = configured.has("github") ? "live" : "no-token";

  if (configured.has("github")) {
    try {
      const res = await fetch(`${GATEWAY_URL}/copilot/models`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          models?: { id: string; label: string; model_picker_enabled?: boolean }[];
          source?: string;
        };
        if (Array.isArray(data.models) && data.models.length > 0) {
          copilotModels = [
            { id: "auto", label: "auto (SDK picks)", model_picker_enabled: false },
            ...data.models.filter((m) => m.id !== "auto"),
          ];
          source = data.source ?? "live";
        }
      }
    } catch (_e) {
      // Copilot endpoint unreachable — skip Copilot models
    }
  }

  // ── Build model list — only user-explicit sources ───────────────────────

  // 1. Tier aliases — always available
  const tierEntries: UnifiedModel[] = TIER_MODELS
    .filter((t) => !hiddenSet.has(t.id))
    .map((t) => ({
      id: t.id,
      label: t.label,
      runtime: "litellm" as ModelRuntime,
      group: "LiteLLM — Tiers",
    }));

  // 2. Copilot SDK models — only when GITHUB_TOKEN is configured
  const copilotEntries: UnifiedModel[] = configured.has("github")
    ? copilotModels
        .filter((m) => !hiddenSet.has(m.id))
        .map((m) => ({
          id: m.id,
          label: m.label,
          runtime: "copilot" as ModelRuntime,
          group: "GitHub Copilot SDK",
          model_picker_enabled: m.model_picker_enabled ?? false,
        }))
    : [];

  // 3. Custom models — user-added via Settings → Models → Custom Models
  const customEntries: UnifiedModel[] = customModels
    .filter((m) => !hiddenSet.has(m.id))
    .map((m) => ({
      id: m.id,
      label: m.label,
      runtime: "litellm" as ModelRuntime,
      group: m.group || `Custom — ${m.provider}`,
    }));

  const models: UnifiedModel[] = [
    ...copilotEntries,
    ...tierEntries,
    ...customEntries,
  ];

  return NextResponse.json({
    models,
    source,
    configured_providers: Array.from(configured),
  });
}
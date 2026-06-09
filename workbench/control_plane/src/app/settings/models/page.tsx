"use client";

/**
 * /settings/models — LLM Model Configuration
 *
 * Shows the three routing tiers (fast / balanced / powerful), current model
 * assignment, provider status, and lets you switch models per tier.
 * Links to the LiteLLM management UI for advanced config (virtual keys,
 * spend tracking, fallback rules).
 */

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types (mirrors gateway/routes/settings.py response models)
// ---------------------------------------------------------------------------

interface TierInfo {
  tier_name: string;
  tier_id: string;
  label: string;
  description: string;
  model: string;
  provider: string;
  provider_configured: boolean;
}

interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  env_var: string;
  models: string[];
}

interface LLMConfig {
  tiers: TierInfo[];
  providers: ProviderInfo[];
  litellm_ui_url: string;
}

interface LiteLLMHealth {
  healthy: boolean;
  detail: string;
  ui_url: string;
}

interface TestResult {
  success: boolean;
  response: string;
  latency_ms: number;
}

// ---------------------------------------------------------------------------
// Provider colour map
// ---------------------------------------------------------------------------

const PROVIDER_COLOURS: Record<string, string> = {
  gemini:     "bg-blue-500/15 text-blue-400 border-blue-800/40",
  openai:     "bg-green-500/15 text-green-400 border-green-800/40",
  anthropic:  "bg-orange-500/15 text-orange-300 border-orange-800/40",
  openrouter: "bg-rose-500/15 text-rose-300 border-rose-800/40",
  github:     "bg-sky-500/15 text-sky-300 border-sky-800/40",
  deepseek:   "bg-cyan-500/15 text-cyan-300 border-cyan-800/40",
  groq:       "bg-yellow-500/15 text-yellow-300 border-yellow-800/40",
  mistral:    "bg-indigo-500/15 text-indigo-300 border-indigo-800/40",
  together:   "bg-teal-500/15 text-teal-300 border-teal-800/40",
  ollama:     "bg-violet-500/15 text-violet-400 border-violet-800/40",
  vllm:       "bg-violet-500/15 text-violet-400 border-violet-800/40",
  unknown:    "bg-zinc-700 text-zinc-400 border-zinc-700",
};

const PROVIDER_ICONS: Record<string, string> = {
  gemini:     "G",
  openai:     "⬡",
  anthropic:  "◆",
  openrouter: "⊕",
  github:     "✦",
  deepseek:   "🐋",
  groq:       "⚡",
  mistral:    "🌪",
  together:   "🤝",
  ollama:     "🦙",
  vllm:       "⚡",
};

// ---------------------------------------------------------------------------
// Per-provider setup guides (mirrors the Integrations wizard pattern)
// ---------------------------------------------------------------------------

interface ProviderGuide {
  description: string;
  setup_url: string;
  docs_url: string;
  instructions: string[];
}

const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  gemini: {
    description: "Google's Gemini model family — powers all three tiers by default.",
    setup_url: "https://aistudio.google.com/apikey",
    docs_url: "https://ai.google.dev/gemini-api/docs/models",
    instructions: [
      "Go to Google AI Studio → Get API key.",
      "Create a new key (free tier available, no credit card required).",
      "Copy the key — it starts with 'AIza…'.",
    ],
  },
  anthropic: {
    description: "Direct access to Claude models (Sonnet, Haiku, Opus).",
    setup_url: "https://console.anthropic.com/settings/keys",
    docs_url: "https://docs.anthropic.com/en/api/getting-started",
    instructions: [
      "Log in to console.anthropic.com.",
      "Navigate to Settings → API Keys → Create Key.",
      "Copy the key — it starts with 'sk-ant-…'.",
    ],
  },
  openrouter: {
    description: "200+ models via one key — Claude, GPT, Gemini, Llama, DeepSeek and more.",
    setup_url: "https://openrouter.ai/settings/keys",
    docs_url: "https://openrouter.ai/docs",
    instructions: [
      "Create a free account at openrouter.ai.",
      "Go to Settings → Keys → Create Key.",
      "Copy the key — it starts with 'sk-or-…'.",
      "Add credits if you want to use paid models (free tier covers some).",
    ],
  },
  openai: {
    description: "OpenAI GPT-4o, o3-mini, and other models.",
    setup_url: "https://platform.openai.com/api-keys",
    docs_url: "https://platform.openai.com/docs/models",
    instructions: [
      "Log in to platform.openai.com.",
      "Navigate to API Keys → Create new secret key.",
      "Copy the key — it starts with 'sk-…'.",
      "Ensure billing is set up in Settings → Billing.",
    ],
  },
  github: {
    description: "GitHub Copilot models — GPT-4o, Claude Sonnet, o3-mini at no extra cost.",
    setup_url: "https://github.com/settings/tokens",
    docs_url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    instructions: [
      "Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens.",
      "Create a new token with no specific repository access.",
      "Under 'Permissions', enable 'Copilot' (read).",
      "Copy the token — it starts with 'github_pat_…'.",
      "Requires an active GitHub Copilot subscription.",
    ],
  },
  groq: {
    description: "Ultra-fast inference for Llama, Mixtral, and Gemma models.",
    setup_url: "https://console.groq.com/keys",
    docs_url: "https://console.groq.com/docs/openai",
    instructions: [
      "Create a free account at console.groq.com.",
      "Navigate to API Keys → Create API Key.",
      "Copy the key — it starts with 'gsk_…'.",
    ],
  },
  mistral: {
    description: "Mistral AI models — Mistral Small, Medium, Large, and Codestral.",
    setup_url: "https://console.mistral.ai/api-keys/",
    docs_url: "https://docs.mistral.ai/api/",
    instructions: [
      "Log in to console.mistral.ai.",
      "Go to API Keys → Create new key.",
      "Copy the key.",
    ],
  },
  deepseek: {
    description: "DeepSeek direct API — DeepSeek-V3 (chat) and DeepSeek-R1 (reasoner) at very competitive pricing.",
    setup_url: "https://platform.deepseek.com/api-keys",
    docs_url: "https://platform.deepseek.com/docs",
    instructions: [
      "Log in to platform.deepseek.com.",
      "Go to API Keys → Create new API key.",
      "Copy the key — it starts with 'sk-…'.",
      "Add balance in the Billing section to enable API access.",
    ],
  },
  together: {
    description: "Together AI — open models at scale (Llama, Qwen, DeepSeek).",
    setup_url: "https://api.together.ai/settings/api-keys",
    docs_url: "https://docs.together.ai/docs/introduction",
    instructions: [
      "Create an account at api.together.ai.",
      "Go to Settings → API Keys.",
      "Copy your key.",
    ],
  },
};

// ---------------------------------------------------------------------------
// Tier card
// ---------------------------------------------------------------------------

function TierCard({
  tier,
  providers,
  onSave,
}: {
  tier: TierInfo;
  providers: ProviderInfo[];
  onSave: (tierName: string, model: string, apiBase?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(tier.provider);
  const [selectedModel, setSelectedModel] = useState(tier.model);
  const [apiBase, setApiBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const isLocal = selectedProvider === "ollama" || selectedProvider === "vllm";

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(tier.tier_name, selectedModel, isLocal ? apiBase || undefined : undefined);
      setEditing(false);
      setTestResult(null);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_name: tier.tier_name }),
      });
      const data: TestResult = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, response: String(err), latency_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const colour = PROVIDER_COLOURS[tier.provider] ?? PROVIDER_COLOURS.unknown;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{tier.label}</span>
            {tier.provider_configured ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-800/40">
                ● Live
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-800/40">
                ● No key
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">{tier.description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleTest}
            disabled={testing || !tier.provider_configured}
            className="rounded px-2.5 py-1 text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 transition-colors"
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <button
            onClick={() => { setEditing((e) => !e); setTestResult(null); }}
            className="rounded px-2.5 py-1 text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
      </div>

      {/* Current assignment (read mode) */}
      {!editing && (
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${colour}`}>
            <span>{PROVIDER_ICONS[tier.provider] ?? "?"}</span>
            {tier.provider}
          </span>
          <span className="font-mono text-xs text-zinc-300 truncate">{tier.model}</span>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <div className="space-y-3 mt-1">
          {/* Provider selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">Provider</label>
            <div className="flex flex-wrap gap-2">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedProvider(p.id);
                    setSelectedModel(p.models[0] ?? "");
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    selectedProvider === p.id
                      ? "border-blue-600 bg-blue-600/20 text-blue-300"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  <span className="mr-1">{PROVIDER_ICONS[p.id] ?? "?"}</span>
                  {p.label}
                  {!p.configured && p.id !== "ollama" && (
                    <span className="ml-1 text-orange-400">!</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Model selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {(currentProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value={selectedModel}>{selectedModel} (custom)</option>
            </select>
            <input
              type="text"
              placeholder="Or type a custom model string…"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* api_base for local models */}
          {isLocal && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                API Base URL
              </label>
              <input
                type="text"
                placeholder={selectedProvider === "ollama" ? "http://host.docker.internal:11434" : "http://host.docker.internal:8001/v1"}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {/* Provider key hint — links to setup guide */}
          {currentProvider && !currentProvider.configured && !isLocal && (
            <div className="rounded-lg border border-orange-800/30 bg-orange-950/30 px-3 py-2 text-xs text-orange-300">
              <span className="font-medium">{currentProvider.label}</span> requires{" "}
              <code className="font-mono">{currentProvider.env_var}</code>.{" "}
              {PROVIDER_GUIDES[currentProvider.id] ? (
                <a
                  href={PROVIDER_GUIDES[currentProvider.id]!.setup_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-orange-200 transition-colors"
                >
                  Get your API key ↗
                </a>
              ) : (
                <span>Set it in the Providers panel below.</span>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !selectedModel}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            testResult.success
              ? "border-green-800/40 bg-green-950/30 text-green-300"
              : "border-red-800/40 bg-red-950/30 text-red-300"
          }`}
        >
          <span className="font-medium mr-2">{testResult.success ? "✓ OK" : "✗ Failed"}</span>
          <span className="font-mono">{testResult.response}</span>
          <span className="ml-2 text-zinc-500">{testResult.latency_ms}ms</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider status card
// ---------------------------------------------------------------------------

function ProviderCard({
  provider,
  onKeySet,
  onKeyDiscard,
}: {
  provider: ProviderInfo;
  onKeySet: (key: string) => Promise<void>;
  onKeyDiscard: (providerId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [keyVal, setKeyVal] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isLocal = provider.id === "ollama" || provider.id === "vllm";
  const colour = PROVIDER_COLOURS[provider.id] ?? PROVIDER_COLOURS.unknown;
  const guide = PROVIDER_GUIDES[provider.id];

  const handleSave = async () => {
    if (!keyVal.trim()) return;
    setSaving(true);
    setKeyError(null);
    try {
      await onKeySet(keyVal.trim());
      setEditing(false);
      setKeyVal("");
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await onKeyDiscard(provider.id);
      setConfirmDiscard(false);
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className={`rounded-xl border px-4 py-3 ${colour}`}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">{PROVIDER_ICONS[provider.id] ?? "?"}</span>
          <div>
            <div className="text-sm font-medium">{provider.label}</div>
            {provider.env_var && (
              <div className="text-[10px] font-mono opacity-70">{provider.env_var}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {provider.configured ? (
            <>
              <span className="text-xs font-medium text-green-400">● Configured</span>
              {!isLocal && (
                <>
                  <button
                    onClick={() => { setEditing((e) => !e); setConfirmDiscard(false); }}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
                  >
                    {editing ? "cancel" : "update key"}
                  </button>
                  {confirmDiscard ? (
                    <span className="flex items-center gap-1">
                      <button
                        onClick={handleDiscard}
                        disabled={discarding}
                        className="rounded border border-red-700/50 bg-red-950/40 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/40 transition-colors disabled:opacity-40"
                      >
                        {discarding ? "Discarding…" : "Confirm discard"}
                      </button>
                      <button
                        onClick={() => setConfirmDiscard(false)}
                        disabled={discarding}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
                      >
                        cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setConfirmDiscard(true); setEditing(false); }}
                      className="text-[10px] text-red-500/70 hover:text-red-400 underline underline-offset-2 transition-colors"
                      title="Remove key and disconnect this provider"
                    >
                      discard key
                    </button>
                  )}
                </>
              )}
            </>
          ) : provider.id === "ollama" ? (
            <span className="text-xs text-zinc-500">● Pull model to use</span>
          ) : provider.id === "vllm" ? (
            <span className="text-xs text-zinc-500">● Set base URL in tier</span>
          ) : (
            <button
              onClick={() => setEditing((e) => !e)}
              className="rounded border border-orange-700/50 bg-orange-950/40 px-2 py-0.5 text-xs text-orange-300 hover:bg-orange-900/40 transition-colors"
            >
              {editing ? "Cancel" : "Set key →"}
            </button>
          )}
        </div>
      </div>

      {/* Guide description (always shown for non-local providers) */}
      {guide && !isLocal && (
        <p className="mt-1.5 text-xs opacity-70 leading-relaxed">{guide.description}</p>
      )}

      {/* Setup panel — shown only when editing (user clicked "Set key →" or "update key") */}
      {editing && guide && (
        <div className="mt-3 rounded-lg border border-zinc-700/50 bg-zinc-900/60 p-3 space-y-3">
          {/* Quick-start links */}
          <div className="flex items-center gap-3">
            <a
              href={guide.setup_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-700/50 bg-blue-900/30 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-800/40 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Get API key
            </a>
            <a
              href={guide.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
            >
              View docs ↗
            </a>
          </div>

          {/* Step-by-step instructions */}
          <ol className="space-y-1">
            {guide.instructions.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                <span className="shrink-0 w-4 h-4 rounded-full bg-zinc-700 text-zinc-400 flex items-center justify-center text-[9px] font-semibold mt-0.5">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>

          {/* Key input */}
          <div className="relative">
            <input
              type={show ? "text" : "password"}
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder={`Paste ${provider.env_var}…`}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 pr-14 text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <button
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              {show ? "hide" : "show"}
            </button>
          </div>
          {keyError && <p className="text-xs text-red-400">{keyError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !keyVal.trim()}
              className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
            >
              {saving ? "Saving & restarting LiteLLM…" : "Save & apply"}
            </button>
            <button
              onClick={() => { setEditing(false); setKeyVal(""); setKeyError(null); }}
              disabled={saving}
              className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
          </div>
          {saving && (
            <p className="text-[10px] text-zinc-500">
              Writing key to <code className="font-mono">infra/.env</code> and restarting LiteLLM (~25s)…
            </p>
          )}
        </div>
      )}

      {/* Confirm discard panel */}
      {confirmDiscard && (
        <div className="mt-3 rounded-lg border border-red-800/30 bg-red-950/20 p-3 space-y-2">
          <p className="text-xs text-red-300">
            This will remove <code className="font-mono text-red-400">{provider.env_var}</code> from{" "}
            <code className="font-mono">infra/.env</code> and disconnect the provider.
            Any tier currently using this provider will fall back to the next available.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-40 transition-colors"
            >
              {discarding ? "Discarding & restarting LiteLLM…" : "Yes, discard key"}
            </button>
            <button
              onClick={() => { setConfirmDiscard(false); setKeyError(null); }}
              disabled={discarding}
              className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
          </div>
          {discarding && (
            <p className="text-[10px] text-zinc-500">
              Removing key from <code className="font-mono">infra/.env</code> and restarting LiteLLM (~25s)…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom model entry type (mirrors gateway CustomModelEntry)
// ---------------------------------------------------------------------------

interface CustomModel {
  id: string;
  label: string;
  provider: string;
  group: string;
}

// ---------------------------------------------------------------------------
// Visible / Hidden model manager
// ---------------------------------------------------------------------------

interface VisibleModel { id: string; label: string; group: string; }

function ModelVisibilityManager() {
  const [allModels, setAllModels] = useState<VisibleModel[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [modRes, hidRes] = await Promise.all([
        fetch("/api/models/all"),
        fetch("/api/settings/llm/hidden-models"),
      ]);
      if (modRes.ok) {
        const d = (await modRes.json()) as { models?: VisibleModel[] };
        setAllModels(d.models ?? []);
      }
      if (hidRes.ok) {
        const h = (await hidRes.json()) as string[];
        setHiddenIds(new Set(Array.isArray(h) ? h : []));
      }
    } catch { /* ok */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const hide = async (id: string) => {
    setBusy(id);
    try {
      await fetch("/api/settings/llm/hidden-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setHiddenIds((prev) => new Set([...prev, id]));
    } finally { setBusy(null); }
  };

  const unhide = async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/settings/llm/hidden-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      setHiddenIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } finally { setBusy(null); }
  };

  const query = search.trim().toLowerCase();
  // Models currently visible in the picker (from /api/models/all — already hid-filtered)
  // We show them all here + the hidden ones so users can manage the full set.
  const visibleModels = allModels.filter(
    (m) => !hiddenIds.has(m.id) && (!query || m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query))
  );
  const hiddenModels = [...hiddenIds].filter(
    (id) => !query || id.toLowerCase().includes(query)
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Visible Models</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Hide models you don&apos;t use — they disappear from the chat picker instantly.
          </p>
        </div>
        {hiddenIds.size > 0 && (
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
          >
            {showHidden ? "Hide hidden list" : `Show ${hiddenIds.size} hidden`}
          </button>
        )}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search models…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-3 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
      />

      {loading ? (
        <div className="text-xs text-zinc-600 py-2">Loading…</div>
      ) : (
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {/* Visible models */}
          {visibleModels.map((m) => (
            <div key={m.id} className="flex items-center justify-between rounded-md border border-zinc-700/40 bg-zinc-800/30 px-3 py-1.5 text-xs">
              <div className="min-w-0">
                <span className="text-zinc-200 truncate">{m.label}</span>
                <span className="ml-2 text-zinc-600 text-[10px] font-mono truncate">{m.group}</span>
              </div>
              <button
                onClick={() => hide(m.id)}
                disabled={busy === m.id}
                className="ml-2 shrink-0 text-zinc-600 hover:text-orange-400 transition-colors disabled:opacity-40 text-[10px]"
                title="Hide from picker"
              >
                {busy === m.id ? "…" : "Hide"}
              </button>
            </div>
          ))}
          {visibleModels.length === 0 && !showHidden && (
            <div className="text-xs text-zinc-600 italic py-1">No visible models match.</div>
          )}

          {/* Hidden models */}
          {showHidden && hiddenModels.length > 0 && (
            <>
              <div className="pt-2 pb-1 text-[10px] text-zinc-600 uppercase tracking-wide">Hidden</div>
              {hiddenModels.map((id) => (
                <div key={id} className="flex items-center justify-between rounded-md border border-zinc-700/30 bg-zinc-900/60 px-3 py-1.5 text-xs opacity-60">
                  <span className="font-mono text-zinc-500 truncate">{id}</span>
                  <button
                    onClick={() => unhide(id)}
                    disabled={busy === id}
                    className="ml-2 shrink-0 text-zinc-600 hover:text-emerald-400 transition-colors disabled:opacity-40 text-[10px]"
                    title="Restore to picker"
                  >
                    {busy === id ? "…" : "Unhide"}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom Models Manager
// ---------------------------------------------------------------------------

function CustomModelsManager() {
  const [models, setModels] = useState<CustomModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [formId, setFormId] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formProvider, setFormProvider] = useState("openrouter");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/settings/llm/custom-models");
      if (r.ok) {
        const d = await r.json() as
          | { custom?: CustomModel[]; hidden?: string[] }
          | CustomModel[];
        const list = Array.isArray(d) ? d : (d.custom ?? []);
        setModels(list);
      }
    } catch { /* ok */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-derive label from model ID when the user types an ID
  const handleIdChange = (v: string) => {
    setFormId(v);
    if (!formLabel || formLabel === deriveLabel(formId)) {
      setFormLabel(deriveLabel(v));
    }
    // Auto-detect provider from prefix
    const detected = v.startsWith("openrouter/") ? "openrouter"
      : v.startsWith("anthropic/") ? "anthropic"
      : v.startsWith("openai/") ? "openai"
      : v.startsWith("gemini/") ? "gemini"
      : v.startsWith("groq/") ? "groq"
      : v.startsWith("mistral/") ? "mistral"
      : "openrouter";
    setFormProvider(detected);
  };

  const deriveLabel = (id: string) => {
    const parts = id.split("/");
    return parts[parts.length - 1] ?? id;
  };

  const handleAdd = async () => {
    if (!formId.trim() || !formLabel.trim()) return;
    setAdding(true); setError(null); setSuccess(null);
    try {
      const r = await fetch("/api/settings/llm/custom-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: formId.trim(), label: formLabel.trim(), provider: formProvider }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(String((data as Record<string, unknown>)?.detail ?? "Failed to add model"));
      } else {
        setSuccess(`Added ${formLabel.trim()}`);
        setFormId(""); setFormLabel(""); setFormProvider("openrouter");
        setShowForm(false);
        setTimeout(() => setSuccess(null), 4000);
        await load();
      }
    } catch (e) { setError(String(e)); } finally { setAdding(false); }
  };

  const handleRemove = async (id: string) => {
    setRemoving(id); setError(null);
    try {
      const r = await fetch(`/api/settings/llm/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(String((d as Record<string, unknown>)?.detail ?? "Failed to remove"));
      } else {
        await load();
      }
    } catch (e) { setError(String(e)); } finally { setRemoving(null); }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Custom Models</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Add any model ID from your configured providers. No restart needed — models appear in
            the chat picker immediately.
          </p>
        </div>
        <button
          onClick={() => { setShowForm((v) => !v); setError(null); }}
          className="rounded-lg border border-blue-700/50 bg-blue-900/30 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-800/40 transition-colors"
        >
          {showForm ? "Cancel" : "+ Add model"}
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="mb-4 rounded-lg border border-zinc-700 bg-zinc-800/60 p-3 space-y-2">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Model ID</label>
            <input
              autoFocus
              type="text"
              placeholder="e.g. openrouter/qwen/qwen3.8-preview"
              value={formId}
              onChange={(e) => handleIdChange(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 font-mono placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              Full LiteLLM model string — prefix determines the provider (e.g. <code className="font-mono">openrouter/…</code>, <code className="font-mono">anthropic/…</code>, <code className="font-mono">gemini/…</code>)
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Display label</label>
            <input
              type="text"
              placeholder="e.g. Qwen 3.8 Preview"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleAdd}
            disabled={adding || !formId.trim() || !formLabel.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors"
          >
            {adding ? "Adding…" : "Add to picker"}
          </button>
        </div>
      )}

      {success && (
        <div className="mb-3 rounded-md border border-emerald-800/40 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-300">
          ✓ {success}
        </div>
      )}

      {/* Model list */}
      {loading ? (
        <div className="text-xs text-zinc-600 py-2">Loading…</div>
      ) : models.length === 0 ? (
        <div className="text-xs text-zinc-600 italic py-2">
          No custom models yet. Click "+ Add model" to add any model from OpenRouter, Anthropic, etc.
        </div>
      ) : (
        <div className="space-y-1.5">
          {models.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="font-medium text-zinc-200 truncate">{m.label}</div>
                <div className="font-mono text-zinc-500 text-[10px] truncate">{m.id}</div>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <span className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500">
                  {m.provider}
                </span>
                <button
                  onClick={() => handleRemove(m.id)}
                  disabled={removing === m.id}
                  className="text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-40"
                  title="Remove"
                >
                  {removing === m.id ? "…" : "✕"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub Copilot model picker (for GitHubCopilotAgent Tier-1.5 path)
// ---------------------------------------------------------------------------

const COPILOT_MODELS = [
  { value: "claude-sonnet-4-5",       label: "Claude Sonnet 4.5" },
  { value: "gpt-4o",                  label: "GPT-4o" },
  { value: "gpt-4o-mini",             label: "GPT-4o mini" },
  { value: "o3-mini",                 label: "o3-mini (reasoning)" },
  { value: "o1",                      label: "o1 (reasoning)" },
  { value: "claude-3.7-sonnet",       label: "Claude 3.7 Sonnet" },
];

function CopilotModelPicker() {
  const [current, setCurrent] = useState("claude-sonnet-4-5");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const res = await fetch("/api/settings/llm/copilot-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.detail ?? "Save failed"));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-sky-900/40 bg-sky-950/20 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-sky-200">Copilot SDK Agent Model</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Controls which model GitHub Copilot agents use when running via the Tier-1.5 path
            (Copilot SDK <code className="font-mono text-zinc-400">agent.run(stream=True)</code>).
            Overrides the model baked into each external agent repo.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-sky-800/50 bg-sky-900/30 px-2 py-0.5 text-[10px] font-medium text-sky-300">
          GitHub Copilot
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <select
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
        >
          {COPILOT_MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label} ({m.value})</option>
          ))}
        </select>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-sky-700 px-4 py-2 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {saved && <p className="mt-2 text-xs text-green-400">✓ Saved — takes effect on next agent run.</p>}
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ModelsPage() {
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [health, setHealth] = useState<LiteLLMHealth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cfgRes, healthRes] = await Promise.all([
        fetch("/api/settings/llm"),
        fetch("/api/settings/llm/health"),
      ]);
      if (cfgRes.ok) {
        setConfig(await cfgRes.json());
      } else {
        const err = await cfgRes.json().catch(() => ({}));
        setLoadError(String(err?.detail ?? err?.error ?? `Error ${cfgRes.status}`));
      }
      if (healthRes.ok) {
        setHealth(await healthRes.json());
      }
    } catch (err) {
      setLoadError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleKeySet = useCallback(async (provider: string, key: string) => {
    const res = await fetch("/api/settings/llm/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: key }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(String(err?.detail ?? "Save failed"));
    }
    // Poll until LiteLLM is healthy again (restart takes ~25s)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const h = await fetch("/api/settings/llm/health").catch(() => null);
      if (h?.ok) {
        const hdata: LiteLLMHealth = await h.json().catch(() => null);
        if (hdata?.healthy) break;
      }
    }
    await loadConfig();
  }, [loadConfig]);

  const handleKeyDiscard = useCallback(async (provider: string) => {
    const res = await fetch(`/api/settings/llm/key?provider=${encodeURIComponent(provider)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(String(err?.detail ?? "Discard failed"));
    }
    // Poll until LiteLLM is healthy again after restart
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const h = await fetch("/api/settings/llm/health").catch(() => null);
      if (h?.ok) {
        const hdata: LiteLLMHealth = await h.json().catch(() => null);
        if (hdata?.healthy) break;
      }
    }
    await loadConfig();
  }, [loadConfig]);

  const handleSaveTier = async (tierName: string, model: string, apiBase?: string) => {
    setSaveError(null);
    setSaveSuccess(null);
    const res = await fetch("/api/settings/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier_name: tierName, model, api_base: apiBase ?? null }),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaveError(String(data?.detail ?? data?.error ?? "Save failed"));
      return;
    }
    setSaveSuccess(`${tierName} → ${model}`);
    // Refresh config
    await loadConfig();
    setTimeout(() => setSaveSuccess(null), 4000);
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Page header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">LLM Models</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Configure which model handles each routing tier. Changes write to{" "}
            <code className="font-mono text-xs text-zinc-400">infra/litellm/config.yaml</code>.
          </p>
        </div>

        {/* LiteLLM status + UI link */}
        <div className="shrink-0 text-right">
          {health ? (
            <>
              <div className={`text-xs font-medium ${health.healthy ? "text-green-400" : "text-red-400"}`}>
                ● LiteLLM proxy {health.healthy ? "online" : "offline"}
              </div>
              <div className="text-xs text-zinc-600 mt-0.5">{health.detail}</div>
              {health.ui_url && (
                <a
                  href={health.ui_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs text-blue-500 hover:text-blue-400 underline"
                >
                  Open LiteLLM UI →
                </a>
              )}
            </>
          ) : (
            <div className="text-xs text-zinc-600">Checking LiteLLM…</div>
          )}
        </div>
      </div>

      {/* Save feedback */}
      {saveSuccess && (
        <div className="mb-4 rounded-lg border border-green-800/40 bg-green-950/30 px-4 py-2 text-xs text-green-300">
          ✓ Saved: {saveSuccess} — restart LiteLLM for changes to take effect if auto-reload fails.
        </div>
      )}
      {saveError && (
        <div className="mb-4 rounded-lg border border-red-800/40 bg-red-950/30 px-4 py-2 text-xs text-red-300">
          ✗ {saveError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-600 text-sm">
          Loading model config…
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
          <p className="text-sm text-red-400 mb-2">Failed to load config</p>
          <p className="text-xs text-zinc-500 mb-4">{loadError}</p>
          <p className="text-xs text-zinc-600">
            Make sure the gateway is running:{" "}
            <code className="font-mono">uv run uvicorn gateway.main:app --reload --port 8000</code>
          </p>
          <button
            onClick={loadConfig}
            className="mt-4 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : config ? (
        <>
          {/* Tier cards */}
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
              Routing Tiers
            </h2>
            <div className="flex flex-col gap-3">
              {config.tiers.map((tier) => (
                <TierCard
                  key={tier.tier_name}
                  tier={tier}
                  providers={config.providers}
                  onSave={handleSaveTier}
                />
              ))}
            </div>
          </section>

          {/* Provider status */}
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
              Provider Status
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(() => {
                // Merge the gateway's provider list with the static PROVIDER_GUIDES list
                // so that Anthropic, OpenRouter etc. always appear even if the gateway is
                // running old code that doesn't include them yet.
                const gatewayProviders = config.providers;
                const gatewayIds = new Set(gatewayProviders.map((p) => p.id));

                // Provider env-var map (mirrors settings.py — for the stub entries)
                const STATIC_ENV: Record<string, string> = {
                  gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY",
                  anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY",
                  github: "GITHUB_TOKEN", groq: "GROQ_API_KEY",
                  deepseek: "DEEPSEEK_API_KEY",
                  mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY",
                };

                // Add stub entries for any providers with a guide that aren't in the gateway response
                const extraProviders: ProviderInfo[] = Object.entries(PROVIDER_GUIDES)
                  .filter(([id]) => !gatewayIds.has(id))
                  .map(([id]) => ({
                    id,
                    label: {
                      gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic",
                      openrouter: "OpenRouter", github: "GitHub Copilot", groq: "Groq",
                      mistral: "Mistral AI", together: "Together AI",
                    }[id] ?? id,
                    configured: false,
                    env_var: STATIC_ENV[id] ?? "",
                    models: [],
                  }));

                return [...gatewayProviders, ...extraProviders].map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    onKeySet={(key) => handleKeySet(p.id, key)}
                    onKeyDiscard={(id) => handleKeyDiscard(id)}
                  />
                ));
              })()}
            </div>
            <p className="mt-3 text-xs text-zinc-600">
              Keys are written to <code className="font-mono">infra/.env</code> and LiteLLM
              restarts automatically. For Ollama, start it locally and pull models via{" "}
              <code className="font-mono">ollama pull &lt;model&gt;</code>.
            </p>
          </section>

          {/* GitHub Copilot model override */}
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
              GitHub Copilot Agent Model
            </h2>
            <CopilotModelPicker />
          </section>

          {/* Custom model catalogue */}
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
              Custom Models
            </h2>
            <CustomModelsManager />
          </section>

          {/* Model visibility */}
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-600">
              Model Visibility
            </h2>
            <ModelVisibilityManager />
          </section>

          {/* LiteLLM UI callout */}
          <section>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-zinc-200">LiteLLM Management UI</div>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Advanced routing rules, fallback chains, virtual API keys, spend tracking,
                  and model health checks. Available at{" "}
                  <code className="font-mono text-zinc-400">localhost:4000/ui</code> when LiteLLM
                  is running with a database connection.
                </p>
              </div>
              <a
                href={config.litellm_ui_url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
              >
                Open UI →
              </a>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

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
  gemini:    "bg-blue-500/15 text-blue-400 border-blue-800/40",
  openai:    "bg-green-500/15 text-green-400 border-green-800/40",
  anthropic: "bg-orange-500/15 text-orange-400 border-orange-800/40",
  github:    "bg-sky-500/15 text-sky-300 border-sky-800/40",
  ollama:    "bg-violet-500/15 text-violet-400 border-violet-800/40",
  vllm:      "bg-violet-500/15 text-violet-400 border-violet-800/40",
  unknown:   "bg-zinc-700 text-zinc-400 border-zinc-700",
};

const PROVIDER_ICONS: Record<string, string> = {
  gemini: "G",
  openai: "⬡",
  anthropic: "A",
  github: "✦",
  ollama: "🦙",
  vllm: "⚡",
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

          {/* Provider key hint */}
          {currentProvider && !currentProvider.configured && !isLocal && (
            <div className="rounded-lg border border-orange-800/30 bg-orange-950/30 px-3 py-2 text-xs text-orange-300">
              Set <code className="font-mono">{currentProvider.env_var}</code> in your{" "}
              <code className="font-mono">.env</code> file and restart the gateway.
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
}: {
  provider: ProviderInfo;
  onKeySet: (key: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [keyVal, setKeyVal] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const isLocal = provider.id === "ollama" || provider.id === "vllm";
  const colour = PROVIDER_COLOURS[provider.id] ?? PROVIDER_COLOURS.unknown;

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

  return (
    <div className={`rounded-xl border px-4 py-3 ${colour}`}>
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
                <button
                  onClick={() => setEditing((e) => !e)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2 transition-colors"
                >
                  {editing ? "cancel" : "update key"}
                </button>
              )}
            </>
          ) : provider.id === "ollama" ? (
            <span className="text-xs text-zinc-500">● Pull model to use</span>
          ) : provider.id === "vllm" ? (
            <span className="text-xs text-zinc-500">● Set base URL in tier</span>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="rounded border border-orange-700/50 bg-orange-950/40 px-2 py-0.5 text-xs text-orange-300 hover:bg-orange-900/40 transition-colors"
            >
              Set key →
            </button>
          )}
        </div>
      </div>

      {editing && !isLocal && (
        <div className="mt-3 space-y-2">
          <div className="relative">
            <input
              type={show ? "text" : "password"}
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder={`Paste ${provider.env_var}…`}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 pr-14 text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:border-blue-500 focus:outline-none"
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
              {config.providers.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  onKeySet={(key) => handleKeySet(p.id, key)}
                />
              ))}
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

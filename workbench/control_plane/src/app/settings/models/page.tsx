"use client";

/**
 * /settings/models — LLM Model Configuration
 *
 * Three-tab layout:
 *   1. Providers — searchable grid, set API keys (APIs-style)
 *   2. Models — all models from configured providers, filter by provider, toggle visibility
 *   3. Tiers — assign models to functions (chat tiers, embeddings, vision, TTS, STT)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import TierCard from "@/components/TierCard";
import ProviderCard from "@/components/ProviderCard";
import type { LLMConfig, ProviderInfo, CustomModel, VisibleModel } from "@/lib/model-types";
import { PROVIDER_GUIDES, PROVIDER_COLOURS, PROVIDER_ICONS } from "@/lib/model-types";

// ── Icons ───────────────────────────────────────────────────────────────────

function EyeOpen() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeClosed() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// ── Extended tier definitions ───────────────────────────────────────────────

interface TierDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  category: "chat" | "embeddings" | "vision" | "tts" | "stt";
}

const ALL_TIERS: TierDef[] = [
  { id: "fast",      label: "Fast Chat",      description: "Quick responses for simple queries and chat",           icon: "⚡", category: "chat" },
  { id: "balanced",  label: "Balanced Chat",   description: "Best balance of speed and capability for daily work",  icon: "⚖️", category: "chat" },
  { id: "powerful",  label: "Powerful Chat",   description: "Maximum capability for complex reasoning and analysis", icon: "🧠", category: "chat" },
  { id: "embeddings",label: "Embeddings",      description: "Text embeddings for semantic search and memory",       icon: "📝", category: "embeddings" },
  { id: "vision",    label: "Vision",          description: "Image understanding and multimodal inputs",             icon: "👁", category: "vision" },
  { id: "tts",       label: "Text-to-Speech",  description: "Voice output for audio responses",                     icon: "🎤", category: "tts" },
  { id: "stt",       label: "Speech-to-Text",  description: "Transcribe voice input to text",                       icon: "🎧", category: "stt" },
];

// ── Provider search/add (APIs-style discovery) ──────────────────────────────

const ALL_KNOWN_PROVIDERS = Object.entries(PROVIDER_GUIDES).map(([id, guide]) => ({
  id,
  label: ({
    gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic",
    openrouter: "OpenRouter", github: "GitHub Copilot", groq: "Groq",
    mistral: "Mistral AI", together: "Together AI", deepseek: "DeepSeek",
  } as Record<string, string>)[id] ?? id,
  description: guide.description,
  envVar: ({
    gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY", github: "GITHUB_TOKEN", groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY",
  } as Record<string, string>)[id] ?? "",
}));

// ── Page ────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const [tab, setTab] = useState<"providers" | "models" | "tiers">("providers");
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [copilotScopeOk, setCopilotScopeOk] = useState<boolean | null>(null);

  // ── Tab 2: Models state ──────────────────────────────────────────────────
  const [allModels, setAllModels] = useState<VisibleModel[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelSearch, setModelSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [busyModel, setBusyModel] = useState<string | null>(null);

  // ── Tab 2: Custom models ─────────────────────────────────────────────────
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formId, setFormId] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formProvider, setFormProvider] = useState("openrouter");
  const [availableProviderModels, setAvailableProviderModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingProviderModels, setLoadingProviderModels] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // ── Tab 1: Provider search ───────────────────────────────────────────────
  const [providerSearch, setProviderSearch] = useState("");

  // ── Load config ──────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cfgRes, modelsRes] = await Promise.all([
        fetch("/api/settings/llm"),
        fetch("/api/models"),
      ]);
      if (cfgRes.ok) setConfig(await cfgRes.json());
      else {
        const err = await cfgRes.json().catch(() => ({}));
        setLoadError(String(err?.detail ?? err?.error ?? `Error ${cfgRes.status}`));
      }
      if (modelsRes.ok) {
        const d = await modelsRes.json();
        setCopilotScopeOk(d.copilot_scope_ok ?? null);
      }
    } catch (err) { setLoadError(String(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // ── Load models for Tab 2 ────────────────────────────────────────────────
  const loadModelsTab = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [modRes, hidRes, custRes] = await Promise.all([
        fetch("/api/models/all"),
        fetch("/api/settings/llm/hidden-models"),
        fetch("/api/settings/llm/custom-models"),
      ]);
      if (modRes.ok) { const d = await modRes.json(); setAllModels((d as { models?: VisibleModel[] }).models ?? []); }
      if (hidRes.ok) { const h = await hidRes.json(); setHiddenIds(new Set(Array.isArray(h) ? h : [])); }
      if (custRes.ok) {
        const d = await custRes.json();
        setCustomModels(Array.isArray(d) ? d : ((d as { custom?: CustomModel[] }).custom ?? []));
      }
    } catch { /* ok */ } finally { setLoadingModels(false); }
  }, []);

  useEffect(() => { if (tab === "models") loadModelsTab(); }, [tab, loadModelsTab]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleKeySet = useCallback(async (provider: string, key: string) => {
    const res = await fetch("/api/settings/llm/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, api_key: key }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(String(err?.detail ?? "Save failed")); }
    await new Promise((r) => setTimeout(r, 2000));
    await loadConfig();
  }, [loadConfig]);

  const handleKeyDiscard = useCallback(async (provider: string) => {
    const res = await fetch(`/api/settings/llm/key?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(String(err?.detail ?? "Discard failed")); }
    await new Promise((r) => setTimeout(r, 2000));
    await loadConfig();
  }, [loadConfig]);

  const handleSaveTier = async (tierName: string, model: string, apiBase?: string) => {
    setSaveError(null); setSaveSuccess(null);
    const res = await fetch("/api/settings/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier_name: tierName, model, api_base: apiBase ?? null }) });
    const data = await res.json();
    if (!res.ok) { setSaveError(String(data?.detail ?? data?.error ?? "Save failed")); return; }
    setSaveSuccess(`${tierName} → ${model}`);
    await loadConfig();
    setTimeout(() => setSaveSuccess(null), 4000);
  };

  // ── Tab 2: Toggle model visibility ──────────────────────────────────────
  const toggleHidden = async (id: string) => {
    setBusyModel(id);
    try {
      if (hiddenIds.has(id)) {
        await fetch(`/api/settings/llm/hidden-models/${encodeURIComponent(id)}`, { method: "DELETE" });
        setHiddenIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      } else {
        await fetch("/api/settings/llm/hidden-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        setHiddenIds((prev) => new Set([...prev, id]));
      }
    } finally { setBusyModel(null); }
  };

  // ── Tab 2: Add custom model ─────────────────────────────────────────────
  const fetchProviderModels = useCallback(async (prov: string) => {
    if (!prov) { setAvailableProviderModels([]); return; }
    setLoadingProviderModels(true);
    try {
      const r = await fetch(`/api/settings/llm/provider-models?provider=${encodeURIComponent(prov)}`);
      if (r.ok) { const data = await r.json(); setAvailableProviderModels(Array.isArray(data) ? data : []); }
      else setAvailableProviderModels([]);
    } catch { setAvailableProviderModels([]); } finally { setLoadingProviderModels(false); }
  }, []);

  const handleAddModel = async () => {
    if (!formId.trim() || !formLabel.trim()) return;
    setAdding(true); setAddError(null); setAddSuccess(null);
    try {
      const r = await fetch("/api/settings/llm/custom-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: formId.trim(), label: formLabel.trim(), provider: formProvider }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setAddError(String((data as Record<string, unknown>)?.detail ?? "Failed")); }
      else {
        setAddSuccess(`Added ${formLabel.trim()}`);
        setFormId(""); setFormLabel(""); setFormProvider("openrouter"); setAvailableProviderModels([]); setShowAddForm(false);
        setTimeout(() => setAddSuccess(null), 4000);
        await loadModelsTab();
      }
    } catch (e) { setAddError(String(e)); } finally { setAdding(false); }
  };

  const handleRemoveModel = async (id: string) => {
    setRemoving(id); setAddError(null);
    try {
      const r = await fetch(`/api/settings/llm/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setAddError(String((d as Record<string, unknown>)?.detail ?? "Failed")); }
      else await loadModelsTab();
    } catch (e) { setAddError(String(e)); } finally { setRemoving(null); }
  };

  // ── Derived data ─────────────────────────────────────────────────────────
  const mergedProviders = useMemo(() => {
    if (!config) return [] as ProviderInfo[];
    const gatewayIds = new Set(config.providers.map((p) => p.id));
    const STATIC_ENV: Record<string, string> = {
      gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY", github: "GITHUB_TOKEN", groq: "GROQ_API_KEY",
      deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY",
    };
    const STATIC_LABELS: Record<string, string> = {
      gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic",
      openrouter: "OpenRouter", github: "GitHub Copilot", groq: "Groq",
      mistral: "Mistral AI", together: "Together AI", deepseek: "DeepSeek",
    };
    const extra: ProviderInfo[] = (Object.keys(PROVIDER_GUIDES) as Array<keyof typeof PROVIDER_GUIDES>)
      .filter((id) => !gatewayIds.has(id as string))
      .map((id) => ({ id: id as string, label: STATIC_LABELS[id as string] ?? (id as string), configured: false, env_var: STATIC_ENV[id as string] ?? "", models: [] }));
    return [...config.providers, ...extra];
  }, [config]);

  // Provider list for Tab 2 filter pills — only configured providers
  const configuredProviderIds = useMemo(() => mergedProviders.filter((p) => p.configured).map((p) => p.id), [mergedProviders]);

  // Tab 2: model groups for provider extraction
  const modelGroups = useMemo(() => {
    const groups = new Set<string>();
    allModels.forEach((m) => groups.add(m.group));
    return Array.from(groups).sort();
  }, [allModels]);

  const searchQ = modelSearch.trim().toLowerCase();
  const visibleModels = allModels.filter((m) =>
    !hiddenIds.has(m.id) &&
    (providerFilter === "all" || m.group === providerFilter) &&
    (!searchQ || m.label.toLowerCase().includes(searchQ) || m.id.toLowerCase().includes(searchQ))
  );
  const hiddenModelsList = allModels.filter((m) =>
    hiddenIds.has(m.id) &&
    (providerFilter === "all" || m.group === providerFilter) &&
    (!searchQ || m.label.toLowerCase().includes(searchQ) || m.id.toLowerCase().includes(searchQ))
  );

  // Tab 3: map current tiers to tier defs
  const tierDefsWithConfig = useMemo(() => {
    if (!config) return ALL_TIERS.map((td) => ({ ...td, tier: null }));
    return ALL_TIERS.map((td) => ({
      ...td,
      tier: config.tiers.find((t) => t.tier_name === td.id) ?? null,
    }));
  }, [config]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure providers, manage models, and assign tiers.
        </p>
      </div>

      {/* Save feedback */}
      {saveSuccess && (
        <div className="mb-4 rounded-lg border border-success/20 bg-success/5 px-4 py-2 text-xs text-success animate-fade-in">✓ Saved: {saveSuccess}</div>
      )}
      {saveError && (
        <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{saveError}</div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-6 p-0.5 rounded-lg bg-secondary/50 w-fit">
        {(["providers", "models", "tiers"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-xs font-medium tech-transition ${
              tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "providers" ? "Providers" : t === "models" ? "Models" : "Tiers"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <span className="w-5 h-5 rounded-full border-2 border-muted border-t-primary animate-spin mr-2.5" />
          <span className="text-sm text-muted-foreground">Loading…</span>
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-border bg-card/60 p-8 text-center">
          <p className="text-sm text-destructive mb-2">Failed to load config</p>
          <p className="text-xs text-muted-foreground mb-4">{loadError}</p>
          <button onClick={loadConfig} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tech-transition">Retry</button>
        </div>
      ) : (
        <>
          {/* ══════════════════════════════════════════════════════════════════
              TAB 1: PROVIDERS
              ══════════════════════════════════════════════════════════════ */}
          {tab === "providers" && (
            <div className="space-y-4">
              {/* Search */}
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />
                </svg>
                <input
                  type="text"
                  placeholder="Search providers…"
                  value={providerSearch}
                  onChange={(e) => setProviderSearch(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card pl-9 pr-4 py-2 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>

              {/* Provider grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {mergedProviders
                  .filter((p) => !providerSearch || p.label.toLowerCase().includes(providerSearch.toLowerCase()) || p.id.toLowerCase().includes(providerSearch.toLowerCase()))
                  .map((p) => (
                    <ProviderCard
                      key={p.id}
                      provider={p}
                      onKeySet={(key) => handleKeySet(p.id, key)}
                      onKeyDiscard={(id) => handleKeyDiscard(id)}
                      copilotScopeOk={copilotScopeOk}
                    />
                  ))}
              </div>

              {/* Add new provider — show unconfigured known providers */}
              {providerSearch && mergedProviders.filter((p) => p.label.toLowerCase().includes(providerSearch.toLowerCase())).length === 0 && (
                <div className="rounded-xl border border-border bg-card/60 p-6 text-center">
                  <p className="text-sm text-muted-foreground mb-1">No providers match your search</p>
                  <p className="text-xs text-muted-foreground">
                    Try a different name or check back — we add new providers regularly.
                  </p>
                </div>
              )}

              <p className="text-xs text-muted-foreground pt-2">
                Keys are stored encrypted in Postgres. Local providers (Ollama, vLLM) are auto-detected.
              </p>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 2: MODELS
              ══════════════════════════════════════════════════════════════ */}
          {tab === "models" && (
            <div className="space-y-4">
              {/* Provider filter pills */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setProviderFilter("all")}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium tech-transition ${
                    providerFilter === "all" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  All
                </button>
                {configuredProviderIds.map((pid) => (
                  <button
                    key={pid}
                    onClick={() => setProviderFilter(pid)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium tech-transition ${
                      providerFilter === pid ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {pid}
                  </button>
                ))}
              </div>

              {/* Search + Add */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search models…"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    className="w-full rounded-lg border border-border bg-card pl-9 pr-4 py-2 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => { setShowAddForm((v) => !v); setAddError(null); }}
                  className="shrink-0 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20 tech-transition"
                >
                  {showAddForm ? "Cancel" : "+ Add model"}
                </button>
              </div>

              {/* Add model form */}
              {showAddForm && (
                <div className="rounded-lg border border-border bg-secondary/60 p-3 space-y-2">
                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">Provider</label>
                    <select value={formProvider} onChange={(e) => { setFormProvider(e.target.value); setFormId(""); setFormLabel(""); fetchProviderModels(e.target.value); }}
                      className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none">
                      {configuredProviderIds.map((pid) => <option key={pid} value={pid}>{pid}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">Model ID</label>
                    <input type="text" placeholder="e.g. openai/gpt-4o" value={formId}
                      onChange={(e) => setFormId(e.target.value)}
                      className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground font-mono placeholder-muted-foreground focus:border-primary focus:outline-none" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">Display label</label>
                    <input type="text" placeholder="Auto-populated" value={formLabel}
                      onChange={(e) => setFormLabel(e.target.value)}
                      className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
                  </div>
                  {addError && <p className="text-xs text-destructive">{addError}</p>}
                  <button onClick={handleAddModel} disabled={adding || !formId.trim() || !formLabel.trim()}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition">
                    {adding ? "Adding…" : "Add to picker"}
                  </button>
                </div>
              )}

              {addSuccess && (
                <div className="rounded-md border border-success/20 bg-success/5 px-3 py-1.5 text-xs text-success">✓ {addSuccess}</div>
              )}

              {/* Custom models section */}
              {customModels.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-1">Added Models</div>
                  {customModels.map((m) => (
                    <div key={m.id} className="flex items-center justify-between rounded-md border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs group">
                      <div className="min-w-0">
                        <span className="text-foreground font-medium truncate">{m.label}</span>
                        <span className="ml-2 text-muted-foreground text-[10px] font-mono">{m.id}</span>
                      </div>
                      <button onClick={() => handleRemoveModel(m.id)} disabled={removing === m.id}
                        className="ml-2 shrink-0 text-muted-foreground hover:text-destructive tech-transition disabled:opacity-40 opacity-0 group-hover:opacity-100">
                        {removing === m.id ? "…" : "✕"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Model visibility list */}
              {loadingModels ? (
                <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
                  <span className="w-4 h-4 rounded-full border-2 border-muted border-t-primary animate-spin mr-2" />Loading models…
                </div>
              ) : (
                <div className="space-y-1 max-h-[60vh] overflow-y-auto">
                  {visibleModels.map((m) => (
                    <div key={m.id} className="flex items-center justify-between rounded-md border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs group">
                      <div className="min-w-0 flex-1">
                        <span className="text-foreground truncate">{m.label}</span>
                        <span className="ml-2 text-muted-foreground text-[10px] font-mono">{m.group}</span>
                      </div>
                      <button onClick={() => toggleHidden(m.id)} disabled={busyModel === m.id}
                        className="ml-2 shrink-0 text-muted-foreground hover:text-warning tech-transition disabled:opacity-30 opacity-0 group-hover:opacity-100"
                        title="Hide from picker">
                        {busyModel === m.id ? <span className="text-[10px]">…</span> : <EyeOpen />}
                      </button>
                    </div>
                  ))}

                  {hiddenModelsList.length > 0 && (
                    <>
                      <div className="pt-3 pb-1 flex items-center gap-2">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[9px] text-muted-foreground font-medium shrink-0">HIDDEN ({hiddenModelsList.length})</span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                      {hiddenModelsList.map((m) => (
                        <div key={m.id} className="flex items-center justify-between rounded-md border border-border/20 bg-secondary/15 px-3 py-1.5 text-xs group opacity-60 hover:opacity-100 tech-transition">
                          <div className="min-w-0 flex-1">
                            <span className="text-muted-foreground truncate">{m.label}</span>
                            <span className="ml-2 text-muted-foreground text-[10px] font-mono">{m.group}</span>
                          </div>
                          <button onClick={() => toggleHidden(m.id)} disabled={busyModel === m.id}
                            className="ml-2 shrink-0 text-muted-foreground hover:text-success tech-transition disabled:opacity-30 opacity-0 group-hover:opacity-100"
                            title="Show in picker">
                            {busyModel === m.id ? <span className="text-[10px]">…</span> : <EyeClosed />}
                          </button>
                        </div>
                      ))}
                    </>
                  )}

                  {visibleModels.length === 0 && hiddenModelsList.length === 0 && (
                    <div className="text-center py-12 text-xs text-muted-foreground">
                      {configuredProviderIds.length === 0
                        ? "Configure a provider in the Providers tab first."
                        : "No models found. Add a model or check your provider configuration."}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 3: TIERS
              ══════════════════════════════════════════════════════════════ */}
          {tab === "tiers" && config && (
            <div className="space-y-6">
              {/* Chat tiers */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Chat Tiers</h2>
                  <span className="text-[10px] text-muted-foreground">
                    {config.tiers.filter((t) => t.provider_configured).length}/{config.tiers.length} configured
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  {config.tiers.map((tier) => (
                    <TierCard key={tier.tier_name} tier={tier} providers={config.providers} onSave={handleSaveTier} />
                  ))}
                </div>
              </div>

              {/* Additional tiers (embeddings, vision, TTS, STT) — future */}
              <div>
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Additional Capabilities</h2>
                <div className="flex flex-col gap-3">
                  {ALL_TIERS.filter((td) => td.category !== "chat").map((td) => {
                    const tierConfig = config.tiers.find((t) => t.tier_name === td.id);
                    return tierConfig ? (
                      <TierCard key={td.id} tier={tierConfig} providers={config.providers} onSave={handleSaveTier} />
                    ) : (
                      <div key={td.id} className="rounded-xl border border-border/40 bg-card/40 p-5 opacity-70">
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="flex items-center gap-3">
                            <span className="text-lg shrink-0">{td.icon}</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-muted-foreground">{td.label}</span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">Coming soon</span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted-foreground">{td.description}</p>
                            </div>
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground italic pl-10">
                          Tier configuration will be available in a future update. Models using <code className="font-mono bg-secondary px-1 rounded">{td.id}</code> capability will auto-select from available providers.
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
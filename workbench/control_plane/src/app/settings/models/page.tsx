"use client";

/**
 * /settings/models — LLM Model Configuration
 *
 * Three-tab layout with compact card design (Agents/APIs style):
 *   1. Providers — compact tiles, click to expand key setup
 *   2. Models — compact grid, filter by provider, toggle visibility
 *   3. Tiers — compact rows, expand to edit model assignment
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LLMConfig, ProviderInfo, CustomModel, VisibleModel } from "@/lib/model-types";
import { PROVIDER_GUIDES, PROVIDER_COLOURS, PROVIDER_ICONS } from "@/lib/model-types";

// ── Icons ───────────────────────────────────────────────────────────────────

const EyeIcon = () => (<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>);
const EyeOffIcon = () => (<svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>);
const SearchIcon = () => (<svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>);
const ChevronRight = () => (<svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 3l5 5-5 5" /></svg>);
const PlusIcon = () => (<svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10" /></svg>);

// ── Tier definitions ────────────────────────────────────────────────────────

const ALL_TIERS = [
  { id: "fast",       label: "Fast",      desc: "Quick responses for simple queries",              icon: "⚡", cat: "chat" },
  { id: "balanced",   label: "Balanced",  desc: "Best speed/capability balance for daily work",     icon: "⚖️", cat: "chat" },
  { id: "powerful",   label: "Powerful",  desc: "Maximum capability for complex reasoning",         icon: "🧠", cat: "chat" },
  { id: "embeddings", label: "Embeddings",desc: "Text embeddings for semantic search",              icon: "📝", cat: "embed" },
  { id: "vision",     label: "Vision",    desc: "Image understanding and multimodal inputs",        icon: "👁", cat: "vision" },
  { id: "tts",        label: "TTS",       desc: "Voice output for audio responses",                 icon: "🎤", cat: "tts" },
  { id: "stt",        label: "STT",       desc: "Transcribe voice input to text",                   icon: "🎧", cat: "stt" },
];

// ── Known providers (for discoverability) ───────────────────────────────────

const STATIC_LABELS: Record<string, string> = {
  gemini: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic",
  openrouter: "OpenRouter", github: "GitHub Copilot", groq: "Groq",
  mistral: "Mistral AI", together: "Together AI", deepseek: "DeepSeek",
};
const STATIC_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY", github: "GITHUB_TOKEN", groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY",
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const [tab, setTab] = useState<"providers" | "models" | "tiers">("providers");
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copilotScopeOk, setCopilotScopeOk] = useState<boolean | null>(null);

  // ── Tab 1: Provider selection ────────────────────────────────────────────
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [providerFilter, setProvFilter] = useState<"all" | "connected" | "unset">("all");

  // ── Tab 2: Models ────────────────────────────────────────────────────────
  const [allModels, setAllModels] = useState<VisibleModel[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelSearch, setModelSearch] = useState("");
  const [modelProvFilter, setModelProvFilter] = useState<string>("all");
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formId, setFormId] = useState(""); const [formLabel, setFormLabel] = useState("");
  const [formProvider, setFormProvider] = useState("openrouter");
  const [adding, setAdding] = useState(false); const [addErr, setAddErr] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<string | null>(null);

  // ── Tab 3: Editing tier ──────────────────────────────────────────────────
  const [editingTier, setEditingTier] = useState<string | null>(null);
  const [editModel, setEditModel] = useState("");
  const [editApiBase, setEditApiBase] = useState("");
  const [editProvider, setEditProvider] = useState("");
  const [savingTier, setSavingTier] = useState(false);
  const [testingTier, setTestingTier] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; ms: number } | null>(null);

  // ── Load config ──────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const [cfgRes, modelsRes] = await Promise.all([fetch("/api/settings/llm"), fetch("/api/models")]);
      if (cfgRes.ok) setConfig(await cfgRes.json());
      else { const err = await cfgRes.json().catch(() => ({})); setLoadError(String(err?.detail ?? err?.error ?? `Error ${cfgRes.status}`)); }
      if (modelsRes.ok) { const d = await modelsRes.json(); setCopilotScopeOk(d.copilot_scope_ok ?? null); }
    } catch (err) { setLoadError(String(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  const loadModelsTab = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [modRes, hidRes, custRes] = await Promise.all([fetch("/api/models/all"), fetch("/api/settings/llm/hidden-models"), fetch("/api/settings/llm/custom-models")]);
      if (modRes.ok) { const d = await modRes.json(); setAllModels((d as { models?: VisibleModel[] }).models ?? []); }
      if (hidRes.ok) { const h = await hidRes.json(); setHiddenIds(new Set(Array.isArray(h) ? h : [])); }
      if (custRes.ok) { const d = await custRes.json(); setCustomModels(Array.isArray(d) ? d : ((d as { custom?: CustomModel[] }).custom ?? [])); }
    } catch { /* ok */ } finally { setLoadingModels(false); }
  }, []);
  useEffect(() => { if (tab === "models") loadModelsTab(); }, [tab, loadModelsTab]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleKeySet = async (prov: string, key: string) => {
    const res = await fetch("/api/settings/llm/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: prov, api_key: key }) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(String(err?.detail ?? "Save failed")); }
    await new Promise((r) => setTimeout(r, 2000));
    await loadConfig();
    setSelectedProvider(null);
  };
  const handleKeyDiscard = async (prov: string) => {
    const res = await fetch(`/api/settings/llm/key?provider=${encodeURIComponent(prov)}`, { method: "DELETE" });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(String(err?.detail ?? "Discard failed")); }
    await new Promise((r) => setTimeout(r, 2000));
    await loadConfig();
  };
  const handleSaveTier = async (tierName: string, model: string, apiBase?: string) => {
    setSavingTier(true);
    const res = await fetch("/api/settings/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier_name: tierName, model, api_base: apiBase ?? null }) });
    const data = await res.json();
    if (!res.ok) { setSaveMsg({ ok: false, text: String(data?.detail ?? data?.error ?? "Save failed") }); }
    else { setSaveMsg({ ok: true, text: `${tierName} → ${model}` }); setEditingTier(null); await loadConfig(); setTimeout(() => setSaveMsg(null), 4000); }
    setSavingTier(false);
  };
  const handleTestTier = async (tierName: string) => {
    setTestingTier(tierName); setTestResult(null);
    try {
      const res = await fetch("/api/settings/llm/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier_name: tierName }) });
      const data = await res.json();
      setTestResult({ ok: data.success, text: data.response, ms: data.latency_ms });
    } catch (err) { setTestResult({ ok: false, text: String(err), ms: 0 }); }
    finally { setTestingTier(null); }
  };
  const toggleHidden = async (id: string) => {
    setBusyModel(id);
    try {
      if (hiddenIds.has(id)) { await fetch(`/api/settings/llm/hidden-models/${encodeURIComponent(id)}`, { method: "DELETE" }); setHiddenIds((prev) => { const s = new Set(prev); s.delete(id); return s; }); }
      else { await fetch("/api/settings/llm/hidden-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); setHiddenIds((prev) => new Set([...prev, id])); }
    } finally { setBusyModel(null); }
  };
  const handleAddModel = async () => {
    if (!formId.trim() || !formLabel.trim()) return;
    setAdding(true); setAddErr(null); setAddOk(null);
    try {
      const r = await fetch("/api/settings/llm/custom-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: formId.trim(), label: formLabel.trim(), provider: formProvider }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) setAddErr(String((data as Record<string, unknown>)?.detail ?? "Failed"));
      else { setAddOk(`Added ${formLabel.trim()}`); setFormId(""); setFormLabel(""); setShowAddForm(false); setTimeout(() => setAddOk(null), 4000); await loadModelsTab(); }
    } catch (e) { setAddErr(String(e)); } finally { setAdding(false); }
  };

  // ── Derived data ─────────────────────────────────────────────────────────
  const mergedProviders = useMemo(() => {
    if (!config) return [] as ProviderInfo[];
    const gatewayIds = new Set(config.providers.map((p) => p.id));
    const extra: ProviderInfo[] = (Object.keys(PROVIDER_GUIDES) as Array<keyof typeof PROVIDER_GUIDES>)
      .filter((id) => !gatewayIds.has(id as string))
      .map((id) => ({ id: id as string, label: STATIC_LABELS[id as string] ?? (id as string), configured: false, env_var: STATIC_ENV[id as string] ?? "", models: [] }));
    return [...config.providers, ...extra];
  }, [config]);

  const filteredProviders = useMemo(() => mergedProviders.filter((p) => {
    if (providerFilter === "connected") return p.configured;
    if (providerFilter === "unset") return !p.configured;
    if (providerSearch) return p.label.toLowerCase().includes(providerSearch.toLowerCase()) || p.id.toLowerCase().includes(providerSearch.toLowerCase());
    return true;
  }), [mergedProviders, providerFilter, providerSearch]);

  const configuredProviderIds = useMemo(() => mergedProviders.filter((p) => p.configured).map((p) => p.id), [mergedProviders]);
  const connCount = mergedProviders.filter((p) => p.configured).length;

  // Tab 2: filtered models
  const mq = modelSearch.trim().toLowerCase();
  const visibleModels = allModels.filter((m) => !hiddenIds.has(m.id) && (modelProvFilter === "all" || m.group === modelProvFilter) && (!mq || m.label.toLowerCase().includes(mq) || m.id.toLowerCase().includes(mq)));
  const hiddenModelsList = allModels.filter((m) => hiddenIds.has(m.id) && (modelProvFilter === "all" || m.group === modelProvFilter) && (!mq || m.label.toLowerCase().includes(mq) || m.id.toLowerCase().includes(mq)));

  const selectedProvData = mergedProviders.find((p) => p.id === selectedProvider);
  const guide = selectedProvider ? (PROVIDER_GUIDES[selectedProvider] ?? undefined) : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base sm:text-lg font-bold text-foreground">Models</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {connCount} providers connected · {config?.tiers.filter((t) => t.provider_configured).length ?? 0}/{config?.tiers.length ?? 3} tiers configured
          </p>
        </div>
      </div>

      {/* Save feedback toast */}
      {saveMsg && (
        <div className={`shrink-0 mx-4 mt-2 rounded-lg border px-3 py-1.5 text-xs ${saveMsg.ok ? "border-success/20 bg-success/5 text-success" : "border-destructive/20 bg-destructive/5 text-destructive"}`}>
          {saveMsg.ok ? "✓ " : "✗ "}{saveMsg.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0.5 px-4 sm:px-6 pt-3 pb-0 shrink-0">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-secondary/50">
          {(["providers", "models", "tiers"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setSelectedProvider(null); setEditingTier(null); }}
              className={`px-4 py-1.5 rounded-md text-xs font-medium tech-transition ${tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {t === "providers" ? "Providers" : t === "models" ? "Models" : "Tiers"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><span className="w-5 h-5 rounded-full border-2 border-muted border-t-primary animate-spin mr-2.5" /><span className="text-sm text-muted-foreground">Loading…</span></div>
      ) : loadError ? (
        <div className="flex-1 flex items-center justify-center"><div className="text-center"><p className="text-sm text-destructive mb-2">Failed to load config</p><p className="text-xs text-muted-foreground mb-4">{loadError}</p><button onClick={loadConfig} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tech-transition">Retry</button></div></div>
      ) : (
        <div className="flex-1 overflow-hidden flex">
          {/* ══════════════════════════════════════════════════════════════════
              TAB 1: PROVIDERS (tile grid + slide-in detail)
              ══════════════════════════════════════════════════════════════ */}
          {tab === "providers" && (
            <div className="flex-1 overflow-y-auto">
              {/* Filter pills + search */}
              <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1">
                  {([["all","All"],["connected","Connected"],["unset","Not set up"]] as const).map(([id, label]) => (
                    <button key={id} onClick={() => setProvFilter(id)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-medium tech-transition ${providerFilter === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1 min-w-[140px] max-w-[220px] ml-auto">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><SearchIcon /></span>
                  <input type="text" placeholder="Search…" value={providerSearch} onChange={(e) => setProviderSearch(e.target.value)}
                    className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-[11px] text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
                </div>
              </div>

              {/* Provider tiles grid */}
              <div className="p-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filteredProviders.map((p) => {
                    const colour = PROVIDER_COLOURS[p.id] ?? PROVIDER_COLOURS.unknown;
                    return (
                      <button key={p.id} onClick={() => setSelectedProvider(selectedProvider === p.id ? null : p.id)}
                        className={`text-left w-full p-3 rounded-xl border tech-transition ${
                          selectedProvider === p.id ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"
                        }`}>
                        <div className="flex items-start justify-between mb-2">
                          <span className="text-lg shrink-0">{PROVIDER_ICONS[p.id] ?? "?"}</span>
                          <span className={`w-2 h-2 mt-1 rounded-full shrink-0 ${p.configured ? "bg-success" : "bg-muted"}`} />
                        </div>
                        <div className="font-medium text-xs text-foreground leading-tight truncate">{p.label}</div>
                        <div className={`text-[10px] mt-0.5 ${p.configured ? "text-success" : "text-muted-foreground"}`}>
                          {p.configured ? "● Connected" : p.id === "ollama" || p.id === "vllm" ? "○ Local" : "○ No key"}
                        </div>
                        {p.env_var && <div className="text-[9px] text-muted-foreground font-mono mt-1 truncate opacity-60">{p.env_var}</div>}
                      </button>
                    );
                  })}
                </div>
                {filteredProviders.length === 0 && (
                  <div className="text-center py-12 text-xs text-muted-foreground">No providers match your filter.</div>
                )}
              </div>

              {/* Provider detail panel (bottom sheet / inline expand) */}
              {selectedProvider && selectedProvData && (
                <div className="border-t border-border bg-card/80 px-4 py-4 space-y-3">
                  <ProviderDetail
                    provider={selectedProvData}
                    guide={guide}
                    copilotScopeOk={selectedProvData.id === "github" ? copilotScopeOk : undefined}
                    onKeySet={(key) => handleKeySet(selectedProvData.id, key)}
                    onKeyDiscard={() => handleKeyDiscard(selectedProvData.id)}
                    onClose={() => setSelectedProvider(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 2: MODELS (compact grid + filter pills)
              ══════════════════════════════════════════════════════════════ */}
          {tab === "models" && (
            <div className="flex-1 overflow-y-auto">
              {/* Provider filter pills */}
              <div className="px-4 pt-3 pb-2 flex items-center gap-1.5 flex-wrap">
                <button onClick={() => setModelProvFilter("all")}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium tech-transition ${modelProvFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>All</button>
                {configuredProviderIds.map((pid) => (
                  <button key={pid} onClick={() => setModelProvFilter(pid)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium tech-transition ${modelProvFilter === pid ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>{pid}</button>
                ))}
              </div>

              {/* Search + Add */}
              <div className="px-4 pb-2 flex items-center gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><SearchIcon /></span>
                  <input type="text" placeholder="Search models…" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)}
                    className="w-full rounded-md border border-border bg-card pl-8 pr-3 py-1.5 text-[11px] text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
                </div>
                <button onClick={() => { setShowAddForm((v) => !v); setAddErr(null); }}
                  className="shrink-0 flex items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20 tech-transition">
                  <PlusIcon /> Add
                </button>
              </div>

              {/* Add model form */}
              {showAddForm && (
                <div className="mx-4 mb-3 rounded-lg border border-border bg-secondary/40 p-3 space-y-2">
                  <div className="flex gap-2">
                    <select value={formProvider} onChange={(e) => setFormProvider(e.target.value)}
                      className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-foreground focus:border-primary focus:outline-none">
                      {configuredProviderIds.map((pid) => <option key={pid} value={pid}>{pid}</option>)}
                      {configuredProviderIds.length === 0 && <option value="">No providers</option>}
                    </select>
                    <input type="text" placeholder="Model ID (e.g. openai/gpt-4o)" value={formId} onChange={(e) => setFormId(e.target.value)}
                      className="flex-[2] rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-foreground font-mono placeholder-muted-foreground focus:border-primary focus:outline-none" />
                    <input type="text" placeholder="Label" value={formLabel} onChange={(e) => setFormLabel(e.target.value)}
                      className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none" />
                    <button onClick={handleAddModel} disabled={adding || !formId.trim() || !formLabel.trim()}
                      className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition">{adding ? "…" : "Add"}</button>
                  </div>
                  {addErr && <p className="text-[10px] text-destructive">{addErr}</p>}
                  {addOk && <p className="text-[10px] text-success">{addOk}</p>}
                </div>
              )}

              {/* Model grid */}
              <div className="p-4 pt-0">
                {loadingModels ? (
                  <div className="flex items-center justify-center py-12 text-xs text-muted-foreground"><span className="w-4 h-4 rounded-full border-2 border-muted border-t-primary animate-spin mr-2" />Loading models…</div>
                ) : (visibleModels.length === 0 && hiddenModelsList.length === 0) ? (
                  <div className="text-center py-12 text-xs text-muted-foreground">
                    {configuredProviderIds.length === 0 ? "Connect a provider in the Providers tab first." : "No models found."}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
                    {visibleModels.map((m) => (
                      <div key={m.id} className="group relative flex items-center justify-between rounded-lg border border-border/60 bg-card px-3 py-2 text-xs hover:border-primary/30 tech-transition">
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground font-medium truncate text-[11px]">{m.label}</div>
                          <div className="text-muted-foreground text-[9px] font-mono truncate">{m.group}</div>
                        </div>
                        <button onClick={() => toggleHidden(m.id)} disabled={busyModel === m.id}
                          className="ml-1.5 shrink-0 text-muted-foreground hover:text-warning tech-transition disabled:opacity-30 opacity-0 group-hover:opacity-100"
                          title="Hide">{busyModel === m.id ? <span className="text-[9px]">…</span> : <EyeIcon />}</button>
                      </div>
                    ))}
                    {/* Hidden section */}
                    {hiddenModelsList.length > 0 && (
                      <div className="col-span-full pt-2 pb-1 flex items-center gap-2">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[9px] text-muted-foreground font-medium shrink-0">HIDDEN ({hiddenModelsList.length})</span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                    )}
                    {hiddenModelsList.map((m) => (
                      <div key={m.id} className="group relative flex items-center justify-between rounded-lg border border-border/30 bg-secondary/20 px-3 py-2 text-xs opacity-60 hover:opacity-100 tech-transition">
                        <div className="min-w-0 flex-1">
                          <div className="text-muted-foreground font-medium truncate text-[11px]">{m.label}</div>
                          <div className="text-muted-foreground text-[9px] font-mono truncate">{m.group}</div>
                        </div>
                        <button onClick={() => toggleHidden(m.id)} disabled={busyModel === m.id}
                          className="ml-1.5 shrink-0 text-muted-foreground hover:text-success tech-transition disabled:opacity-30 opacity-0 group-hover:opacity-100"
                          title="Show">{busyModel === m.id ? <span className="text-[9px]">…</span> : <EyeOffIcon />}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              TAB 3: TIERS (compact rows, expand to edit)
              ══════════════════════════════════════════════════════════════ */}
          {tab === "tiers" && config && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Chat tiers */}
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-2">Chat Tiers</div>
                <div className="space-y-1.5">
                  {config.tiers.map((tier) => {
                    const td = ALL_TIERS.find((t) => t.id === tier.tier_name);
                    const isEditing = editingTier === tier.tier_name;
                    const colour = PROVIDER_COLOURS[tier.provider] ?? PROVIDER_COLOURS.unknown;
                    return (
                      <div key={tier.tier_name} className="rounded-lg border border-border bg-card/60 overflow-hidden tech-transition">
                        {/* Compact row */}
                        <button onClick={() => { if (!isEditing) { setEditingTier(tier.tier_name); setEditModel(tier.model); setEditProvider(tier.provider); setEditApiBase(""); setTestResult(null); } }}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/30 tech-transition">
                          <span className="text-base shrink-0">{td?.icon ?? "●"}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground">{td?.label ?? tier.tier_name}</span>
                              {tier.provider_configured ? (
                                <span className="text-[9px] px-1 py-0.5 rounded-full bg-success/10 text-success border border-success/20">Live</span>
                              ) : (
                                <span className="text-[9px] px-1 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">No key</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${colour}`}>
                                <span className="text-[10px]">{PROVIDER_ICONS[tier.provider] ?? "?"}</span>{tier.provider}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground truncate">{tier.model}</span>
                            </div>
                          </div>
                          <span className="text-muted-foreground/40"><ChevronRight /></span>
                        </button>

                        {/* Expanded edit */}
                        {isEditing && (
                          <div className="border-t border-border px-3 py-3 space-y-2 bg-secondary/20">
                            <div><label className="text-[10px] font-medium text-muted-foreground">Provider</label>
                              <div className="flex flex-wrap gap-1.5 mt-1">
                                {config.providers.map((p) => (
                                  <button key={p.id} onClick={() => { setEditProvider(p.id); setEditModel(p.models[0] ?? ""); }}
                                    className={`rounded-md border px-2 py-1 text-[10px] tech-transition ${editProvider === p.id ? "border-primary bg-primary/20 text-primary" : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"}`}>
                                    {PROVIDER_ICONS[p.id] ?? "?"} {p.label}
                                    {!p.configured && p.id !== "ollama" && <span className="ml-0.5 text-warning">!</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div><label className="text-[10px] font-medium text-muted-foreground">Model</label>
                              <div className="flex gap-2 mt-1">
                                <select value={editModel} onChange={(e) => setEditModel(e.target.value)}
                                  className="flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none">
                                  {config.providers.find((p) => p.id === editProvider)?.models.map((m) => <option key={m} value={m}>{m}</option>)}
                                  {(!config.providers.find((p) => p.id === editProvider) || config.providers.find((p) => p.id === editProvider)!.models.length === 0) && <option value={editModel}>{editModel}</option>}
                                </select>
                              </div>
                            </div>
                            {(editProvider === "ollama" || editProvider === "vllm") && (
                              <div><label className="text-[10px] font-medium text-muted-foreground">Base URL</label>
                                <input type="text" value={editApiBase} onChange={(e) => setEditApiBase(e.target.value)}
                                  placeholder={editProvider === "ollama" ? "http://localhost:11434/v1" : "http://localhost:8000/v1"}
                                  className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none mt-1" />
                              </div>
                            )}
                            <div className="flex items-center gap-2 pt-1">
                              <button onClick={() => handleSaveTier(tier.tier_name, editModel, (editProvider === "ollama" || editProvider === "vllm") ? editApiBase || undefined : undefined)}
                                disabled={savingTier || !editModel}
                                className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition">{savingTier ? "Saving…" : "Save"}</button>
                              <button onClick={() => handleTestTier(tier.tier_name)} disabled={testingTier === tier.tier_name || !tier.provider_configured}
                                className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 tech-transition">{testingTier === tier.tier_name ? "…" : "Test"}</button>
                              <button onClick={() => setEditingTier(null)}
                                className="rounded-lg text-[11px] text-muted-foreground hover:text-foreground tech-transition ml-auto">Cancel</button>
                            </div>
                            {testResult && (
                              <div className={`rounded-md border px-2 py-1 text-[10px] ${testResult.ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/20 bg-destructive/5 text-destructive"}`}>
                                {testResult.ok ? "✓" : "✗"} {testResult.text} · {testResult.ms}ms
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Future tiers */}
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-2">Additional Capabilities</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {ALL_TIERS.filter((td) => td.cat !== "chat").map((td) => (
                    <div key={td.id} className="rounded-lg border border-border/40 bg-card/30 p-3 opacity-60">
                      <div className="text-base mb-1">{td.icon}</div>
                      <div className="text-[11px] font-medium text-muted-foreground">{td.label}</div>
                      <div className="text-[9px] text-muted-foreground mt-0.5">Coming soon</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ProviderDetail — inline key setup panel (shown below provider tile grid)
// ═══════════════════════════════════════════════════════════════════════════════

function ProviderDetail({ provider, guide, copilotScopeOk, onKeySet, onKeyDiscard, onClose }: {
  provider: ProviderInfo;
  guide: { description: string; setup_url: string; docs_url: string; instructions: string[] } | undefined;
  copilotScopeOk?: boolean | null;
  onKeySet: (key: string) => Promise<void>;
  onKeyDiscard: () => Promise<void>;
  onClose: () => void;
}) {
  const [keyVal, setKeyVal] = useState(""); const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false); const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<{ deviceCode: string; userCode: string; verificationUri: string; interval: number } | null>(null);
  const [deviceStatus, setDeviceStatus] = useState("");
  const isLocal = provider.id === "ollama" || provider.id === "vllm";

  const handleSave = async () => { if (!keyVal.trim()) return; setSaving(true); setErr(null); try { await onKeySet(keyVal.trim()); setKeyVal(""); } catch (e) { setErr(String(e)); } finally { setSaving(false); } };
  const handleDiscard = async () => { setDiscarding(true); try { await onKeyDiscard(); setConfirmDiscard(false); onClose(); } catch (e) { setErr(String(e)); } finally { setDiscarding(false); } };

  const startDeviceFlow = async () => {
    setDeviceStatus("Starting…");
    try {
      const res = await fetch("/api/integrations/github/device/start", { method: "POST" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); setDeviceStatus(String(e.error ?? e.detail ?? "Failed")); return; }
      const data = await res.json();
      setDeviceFlow({ deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, interval: (data.interval ?? 5) * 1000 });
      setDeviceStatus("Waiting for authorization…");
      pollDeviceFlow(data.device_code, (data.interval ?? 5) * 1000);
    } catch (e) { setDeviceStatus(String(e)); }
  };
  const pollDeviceFlow = async (deviceCode: string, interval: number) => {
    try {
      const res = await fetch("/api/integrations/github/device/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: deviceCode }) });
      const data = await res.json();
      if (data.status === "authorized") { setDeviceStatus(`Connected as ${data.login ?? "GitHub user"}!`); setDeviceFlow(null); setTimeout(() => window.location.reload(), 1500); }
      else if (data.status === "pending") { setDeviceStatus("Waiting…"); setTimeout(() => pollDeviceFlow(deviceCode, interval), interval); }
      else if (data.status === "slow_down") { const next = (data.interval ?? 10) * 1000; setDeviceStatus("Please wait…"); setTimeout(() => pollDeviceFlow(deviceCode, next), next); }
      else { setDeviceStatus(`Failed: ${data.status}`); setDeviceFlow(null); }
    } catch (e) { setDeviceStatus(`Error: ${String(e)}`); setDeviceFlow(null); }
  };

  const colour = PROVIDER_COLOURS[provider.id] ?? PROVIDER_COLOURS.unknown;

  return (
    <div className={`rounded-xl border px-4 py-3 ${colour}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{PROVIDER_ICONS[provider.id] ?? "?"}</span>
          <div>
            <div className="text-sm font-medium">{provider.label}</div>
            {provider.env_var && <div className="text-[10px] font-mono opacity-60">{provider.env_var}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {provider.configured && !isLocal && (
            <>
              {!confirmDiscard ? (
                <button onClick={() => setConfirmDiscard(true)} className="text-[10px] text-destructive/70 hover:text-destructive underline underline-offset-2 tech-transition">discard key</button>
              ) : (
                <span className="flex items-center gap-1">
                  <button onClick={handleDiscard} disabled={discarding} className="rounded border border-destructive/20 bg-destructive/5 px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 tech-transition disabled:opacity-40">{discarding ? "…" : "Confirm discard"}</button>
                  <button onClick={() => setConfirmDiscard(false)} disabled={discarding} className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 tech-transition">cancel</button>
                </span>
              )}
            </>
          )}
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
        </div>
      </div>

      {provider.id === "github" && provider.configured && copilotScopeOk === false && (
        <div className="mb-2 rounded-lg border border-warning/25 bg-warning/5 p-2 text-[10px]">
          <span className="text-warning font-medium">⚠ Copilot scope missing</span> — your token may lack the <code className="font-mono bg-secondary px-1 rounded">copilot</code> permission.{" "}
          <details className="inline"><summary className="text-primary cursor-pointer hover:underline">Fix steps</summary>
            <ol className="mt-1 space-y-0.5 pl-3 text-muted-foreground">
              <li>Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline">github.com/settings/tokens</a></li>
              <li>Generate a fine-grained token with <strong>Copilot → Read-only</strong></li>
              <li>Paste the new token below</li>
            </ol>
          </details>
        </div>
      )}

      {guide && !isLocal && <p className="text-xs opacity-70 mb-2">{guide.description}</p>}

      {/* Key input */}
      {!provider.configured || !isLocal ? (
        <div className="space-y-2">
          {guide && (
            <a href={guide.setup_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 tech-transition">
              Get API key ↗
            </a>
          )}
          <div className="relative">
            <input type={show ? "text" : "password"} value={keyVal} onChange={(e) => setKeyVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder={`Paste ${provider.env_var}…`}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 pr-14 text-xs text-foreground placeholder-muted-foreground font-mono focus:border-primary focus:outline-none" />
            <button onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground">{show ? "hide" : "show"}</button>
          </div>
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={saving || !keyVal.trim()}
              className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition">{saving ? "Saving & restarting…" : "Save & apply"}</button>
          </div>
          {saving && <p className="text-[9px] text-muted-foreground">Writing key and restarting LiteLLM (~25s)…</p>}

          {/* GitHub device flow */}
          {provider.id === "github" && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-2 space-y-1.5">
              <div className="flex items-center gap-1.5"><span className="text-xs">✦</span><span className="text-[10px] font-medium text-primary/80">GitHub OAuth</span></div>
              {!deviceFlow ? (
                <button onClick={startDeviceFlow} disabled={!!deviceStatus && !deviceStatus.includes("Error")}
                  className="w-full rounded-lg border border-primary/30 bg-primary/10 px-2 py-1.5 text-[10px] font-medium text-primary/80 hover:bg-primary/20 tech-transition disabled:opacity-40">{deviceStatus || "Connect with GitHub →"}</button>
              ) : (
                <div className="text-center space-y-1">
                  <div className="text-xl font-bold tracking-[0.3em] text-primary/80 font-mono">{deviceFlow.userCode}</div>
                  <a href={deviceFlow.verificationUri} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary/80 underline">Open {deviceFlow.verificationUri} →</a>
                  <p className="text-[9px] text-muted-foreground">{deviceStatus}</p>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Confirm discard */}
      {confirmDiscard && (
        <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 p-2 space-y-1.5">
          <p className="text-[10px] text-destructive">This will remove the key and disconnect the provider. Tiers using it will fall back.</p>
        </div>
      )}
    </div>
  );
}
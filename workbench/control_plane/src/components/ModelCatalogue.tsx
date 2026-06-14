"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomModel, VisibleModel } from "@/lib/model-types";

// ── Inline SVG icons ────────────────────────────────────────────────────────

function EyeOpen() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeClosed() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ModelCatalogue — Add custom models + toggle visibility
// ---------------------------------------------------------------------------

export default function ModelCatalogue() {
  const [tab, setTab] = useState<"added" | "visibility">("added");

  // ── Shared state ──────────────────────────────────────────────────────────
  const [allModels, setAllModels] = useState<VisibleModel[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loadingVis, setLoadingVis] = useState(true);

  // Custom models state
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [loadingCust, setLoadingCust] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formId, setFormId] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formProvider, setFormProvider] = useState("openrouter");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Visibility state
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── Load visibility data ──────────────────────────────────────────────────
  const loadVisibility = useCallback(async () => {
    setLoadingVis(true);
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
    } catch { /* ok */ } finally { setLoadingVis(false); }
  }, []);

  // ── Load custom models ────────────────────────────────────────────────────
  const loadCustom = useCallback(async () => {
    setLoadingCust(true);
    try {
      const r = await fetch("/api/settings/llm/custom-models");
      if (r.ok) {
        const d = await r.json() as
          | { custom?: CustomModel[]; hidden?: string[] }
          | CustomModel[];
        const list = Array.isArray(d) ? d : (d.custom ?? []);
        setCustomModels(list);
      }
    } catch { /* ok */ } finally { setLoadingCust(false); }
  }, []);

  useEffect(() => { void loadVisibility(); void loadCustom(); }, [loadVisibility, loadCustom]);

  // ── Visibility toggle ─────────────────────────────────────────────────────
  const toggleHidden = async (id: string) => {
    setBusy(id);
    try {
      if (hiddenIds.has(id)) {
        await fetch(`/api/settings/llm/hidden-models/${encodeURIComponent(id)}`, { method: "DELETE" });
        setHiddenIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      } else {
        await fetch("/api/settings/llm/hidden-models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        setHiddenIds((prev) => new Set([...prev, id]));
      }
    } finally { setBusy(null); }
  };

  // ── Custom model actions ──────────────────────────────────────────────────
  const fetchProviderModels = useCallback(async (prov: string) => {
    if (!prov) { setAvailableModels([]); return; }
    setLoadingModels(true);
    setModelSearch("");
    try {
      const r = await fetch(`/api/settings/llm/provider-models?provider=${encodeURIComponent(prov)}`);
      if (r.ok) {
        const data = (await r.json()) as { id: string; label: string }[];
        setAvailableModels(Array.isArray(data) ? data : []);
      } else {
        setAvailableModels([]);
      }
    } catch {
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const handleProviderChange = (prov: string) => {
    setFormProvider(prov);
    setFormId("");
    setFormLabel("");
    void fetchProviderModels(prov);
  };

  const handleModelSelect = (id: string, label: string) => {
    setFormId(id);
    setFormLabel(label);
    setModelSearch("");
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
        setAvailableModels([]); setModelSearch("");
        setShowForm(false);
        setTimeout(() => setSuccess(null), 4000);
        await Promise.all([loadCustom(), loadVisibility()]);
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
        await Promise.all([loadCustom(), loadVisibility()]);
      }
    } catch (e) { setError(String(e)); } finally { setRemoving(null); }
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const query = search.trim().toLowerCase();
  const visibleModels = allModels.filter(
    (m) => !hiddenIds.has(m.id) && (!query || m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query))
  );
  const hiddenModels = allModels.filter(
    (m) => hiddenIds.has(m.id) && (!query || m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query))
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5">
      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-4 p-0.5 rounded-lg bg-secondary/50 w-fit">
        <button
          onClick={() => setTab("added")}
          className={`px-3 py-1 rounded-md text-xs font-medium tech-transition ${
            tab === "added"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Added Models
        </button>
        <button
          onClick={() => setTab("visibility")}
          className={`px-3 py-1 rounded-md text-xs font-medium tech-transition ${
            tab === "visibility"
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Model Visibility
        </button>
      </div>

      {/* ── Tab: Added Models ─────────────────────────────────────────── */}
      {tab === "added" && (
        <>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-muted-foreground">
              Add models from your configured providers to make them available in the chat picker.
            </p>
            <button
              onClick={() => { setShowForm((v) => !v); setError(null); }}
              className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 tech-transition shrink-0 ml-3"
            >
              {showForm ? "Cancel" : "+ Add model"}
            </button>
          </div>

          {/* Add form */}
          {showForm && (
            <div className="mb-4 rounded-lg border border-border bg-secondary/60 p-3 space-y-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Provider</label>
                <select
                  value={formProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="groq">Groq</option>
                  <option value="mistral">Mistral AI</option>
                  <option value="together">Together AI</option>
                  <option value="github">GitHub Copilot</option>
                  <option value="ollama">Ollama (local)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Model</label>
                {loadingModels ? (
                  <div className="text-xs text-muted-foreground py-1.5">Fetching models…</div>
                ) : formId ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground font-mono truncate">
                      {formId}
                    </span>
                    <button
                      onClick={() => { setFormId(""); setFormLabel(""); }}
                      className="text-muted-foreground hover:text-foreground text-xs shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      placeholder={availableModels.length > 0 ? "Search models…" : "No models loaded — select a provider first"}
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                    />
                    {availableModels.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full max-h-44 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
                        {(modelSearch
                          ? availableModels.filter((m) =>
                              m.label.toLowerCase().includes(modelSearch.toLowerCase()) ||
                              m.id.toLowerCase().includes(modelSearch.toLowerCase())
                            )
                          : availableModels
                        ).slice(0, 50).map((m) => (
                          <button
                            key={m.id}
                            onClick={() => handleModelSelect(m.id, m.label)}
                            className="w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-secondary tech-transition flex items-center justify-between"
                          >
                            <span className="truncate">{m.label}</span>
                            <span className="text-[10px] text-muted-foreground font-mono ml-2 shrink-0 truncate max-w-[40%]">
                              {m.id}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Display label</label>
                <input
                  type="text"
                  placeholder="Auto-populated from model name"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <button
                onClick={handleAdd}
                disabled={adding || !formId.trim() || !formLabel.trim()}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
              >
                {adding ? "Adding…" : "Add to picker"}
              </button>
            </div>
          )}

          {success && (
            <div className="mb-3 rounded-md border border-success/20 bg-success/5 px-3 py-1.5 text-xs text-success">
              ✓ {success}
            </div>
          )}

          {/* Custom model list */}
          {loadingCust ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <span className="w-4 h-4 rounded-full border-2 border-muted border-t-primary animate-spin mr-2" />
              Loading…
            </div>
          ) : customModels.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-4 text-center">
              No custom models yet. Click &quot;+ Add model&quot; to add one.
            </div>
          ) : (
            <div className="space-y-1.5">
              {customModels.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/40 px-3 py-2 text-xs group"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">{m.label}</div>
                    <div className="font-mono text-muted-foreground text-[10px] truncate">{m.id}</div>
                  </div>
                  <div className="flex items-center gap-2 ml-3 shrink-0">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                      {m.provider}
                    </span>
                    <button
                      onClick={() => handleRemove(m.id)}
                      disabled={removing === m.id}
                      className="text-muted-foreground hover:text-destructive tech-transition disabled:opacity-40 opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      {removing === m.id ? "…" : "✕"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Tab: Model Visibility ──────────────────────────────────────── */}
      {tab === "visibility" && (
        <>
          <p className="text-xs text-muted-foreground mb-3">
            Toggle visibility for each model. Hidden models won&apos;t appear in the chat picker.
          </p>

          <input
            type="text"
            placeholder="Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full mb-3 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
          />

          {loadingVis ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <span className="w-4 h-4 rounded-full border-2 border-muted border-t-primary animate-spin mr-2" />
              Loading models…
            </div>
          ) : (
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {/* Visible models */}
              {visibleModels.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-md border border-border/40 bg-secondary/30 px-3 py-1.5 text-xs group"
                >
                  <div className="min-w-0">
                    <span className="text-foreground truncate">{m.label}</span>
                    <span className="ml-2 text-muted-foreground text-[10px] font-mono truncate">{m.group}</span>
                  </div>
                  <button
                    onClick={() => toggleHidden(m.id)}
                    disabled={busy === m.id}
                    className="ml-2 shrink-0 text-muted-foreground hover:text-warning tech-transition disabled:opacity-30"
                    title="Hide from picker"
                  >
                    {busy === m.id ? (
                      <span className="text-[10px]">…</span>
                    ) : (
                      <EyeOpen />
                    )}
                  </button>
                </div>
              ))}

              {/* Hidden models section */}
              {hiddenModels.length > 0 && (
                <>
                  <div className="pt-2 pb-1 flex items-center gap-2">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[9px] text-muted-foreground font-medium shrink-0">
                      HIDDEN ({hiddenModels.length})
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  {hiddenModels.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-md border border-border/20 bg-secondary/15 px-3 py-1.5 text-xs group opacity-60 hover:opacity-100 tech-transition"
                    >
                      <div className="min-w-0">
                        <span className="text-muted-foreground truncate">{m.label}</span>
                        <span className="ml-2 text-muted-foreground text-[10px] font-mono truncate">{m.group}</span>
                      </div>
                      <button
                        onClick={() => toggleHidden(m.id)}
                        disabled={busy === m.id}
                        className="ml-2 shrink-0 text-muted-foreground hover:text-success tech-transition disabled:opacity-30"
                        title="Show in picker"
                      >
                        {busy === m.id ? (
                          <span className="text-[10px]">…</span>
                        ) : (
                          <EyeClosed />
                        )}
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

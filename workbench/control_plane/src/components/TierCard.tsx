"use client";

import { useState } from "react";
import {
  type TierInfo,
  type ProviderInfo,
  type TestResult,
  PROVIDER_COLOURS,
  PROVIDER_ICONS,
} from "@/lib/model-types";

// ---------------------------------------------------------------------------
// TierCard — Routing tier configuration card
// ---------------------------------------------------------------------------

export default function TierCard({
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
  const tierIcon: Record<string, string> = {
    fast: "⚡",
    balanced: "⚖️",
    powerful: "🧠",
  };

  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 hover:border-primary/20 tech-transition">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <span className="text-lg shrink-0">{tierIcon[tier.tier_name] ?? "●"}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{tier.label}</span>
              {tier.provider_configured ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                  Live
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/20">
                  No key
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{tier.description}</p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleTest}
            disabled={testing || !tier.provider_configured}
            className="rounded-lg px-3 py-1.5 text-xs border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 disabled:opacity-40 tech-transition"
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <button
            onClick={() => { setEditing((e) => !e); setTestResult(null); }}
            className="rounded-lg px-3 py-1.5 text-xs border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
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
          <span className="font-mono text-xs text-foreground truncate">{tier.model}</span>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <div className="space-y-3 mt-1">
          {/* Provider selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Provider</label>
            <div className="flex flex-wrap gap-2">
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedProvider(p.id);
                    setSelectedModel(p.models[0] ?? "");
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-xs tech-transition ${
                    selectedProvider === p.id
                      ? "border-primary bg-primary/20 text-primary"
                      : "border-border bg-secondary/40 text-muted-foreground hover:border-primary/30"
                  }`}
                >
                  <span className="mr-1">{PROVIDER_ICONS[p.id] ?? "?"}</span>
                  {p.label}
                  {!p.configured && p.id !== "ollama" && (
                    <span className="ml-1 text-warning">!</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Model selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {currentProvider?.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {(!currentProvider || currentProvider.models.length === 0) && (
                <option value={selectedModel}>{selectedModel}</option>
              )}
            </select>
            {isLocal && currentProvider && currentProvider.models.length === 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                No models detected. Pull a model first ({selectedProvider === "ollama" ? "ollama pull …" : "configure vLLM endpoint"}).
              </p>
            )}
          </div>

          {/* API base URL for local providers */}
          {isLocal && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {selectedProvider === "ollama" ? "Ollama URL" : "vLLM Base URL"}
              </label>
              <input
                type="text"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder={selectedProvider === "ollama" ? "http://localhost:11434/v1" : "http://localhost:8000/v1"}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground tech-transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !selectedModel}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
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
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/20 bg-destructive/5 text-destructive"
          }`}
        >
          <span className="font-medium mr-2">{testResult.success ? "✓ OK" : "✗ Failed"}</span>
          <span className="font-mono">{testResult.response}</span>
          <span className="ml-2 text-muted-foreground">{testResult.latency_ms}ms</span>
        </div>
      )}
    </div>
  );
}

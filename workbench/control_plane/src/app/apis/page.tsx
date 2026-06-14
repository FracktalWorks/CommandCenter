"use client";

/**
 * /apis — API Connections
 *
 * Tile-grid + slide-in side panel.
 * AI-powered multi-result discovery with logo support (Clearbit + initials fallback).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BarChart2,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Globe,
  HardDrive,
  Loader2,
  Lock,
  Mail,
  MessageSquare,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Target,
  Users,
  X,
} from "lucide-react";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { AgentEntry } from "@/app/api/agent/list/route";
import GitHubAccountBadge from "@/components/GitHubAccountBadge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiEntry = IntegrationStatus & {
  category: string;
  is_custom?: boolean;
  domain?: string;
};

interface DiscoveredDef {
  service_id: string;
  label: string;
  category: string;
  description: string;
  domain?: string;
  setup_url: string;
  docs_url: string;
  instructions: string;
  env_vars: { key: string; label: string; sensitive: boolean }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: "all",           label: "All" },
  { id: "core",          label: "Core" },
  { id: "crm",           label: "CRM" },
  { id: "email",         label: "Email" },
  { id: "prospecting",   label: "Prospecting" },
  { id: "productivity",  label: "Productivity" },
  { id: "search",        label: "Search" },
  { id: "analytics",     label: "Analytics" },
  { id: "payments",      label: "Payments" },
  { id: "communication", label: "Communication" },
  { id: "custom",        label: "Custom" },
] as const;
type CatId = (typeof CATEGORIES)[number]["id"];

const CAT_COLORS: Record<string, string> = {
  core:          "bg-violet-500/15 text-violet-400 border-violet-500/25",
  crm:           "bg-blue-500/15 text-blue-400 border-blue-500/25",
  email:         "bg-amber-500/15 text-amber-400 border-amber-500/25",
  prospecting:   "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  productivity:  "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  search:        "bg-orange-500/15 text-orange-400 border-orange-500/25",
  analytics:     "bg-rose-500/15 text-rose-400 border-rose-500/25",
  payments:      "bg-indigo-500/15 text-indigo-400 border-indigo-500/25",
  communication: "bg-teal-500/15 text-teal-400 border-teal-500/25",
  storage:       "bg-sky-500/15 text-sky-400 border-sky-500/25",
  custom:        "bg-secondary text-muted-foreground border-border",
};

/** Known logo domains for built-in services — used with Clearbit logo API */
const KNOWN_DOMAINS: Record<string, string> = {
  "zoho-crm":      "zoho.com",
  "apollo":        "apollo.io",
  "google-maps":   "google.com",
  "instantly":     "instantly.ai",
  "gmail":         "google.com",
  "gmail-send":    "google.com",
  "clickup":       "clickup.com",
  "github":        "github.com",
  "serpapi":       "serpapi.com",
  "apify":         "apify.com",
  "anymailfinder": "anymailfinder.com",
  "google-sheets": "google.com",
};

const DISCOVER_SUGGESTIONS = [
  "Microsoft", "Google", "Atlassian",
  "Notion", "Slack", "HubSpot",
  "Stripe", "Twilio", "Airtable", "Linear",
];

// ---------------------------------------------------------------------------
// ServiceLogo — bare logo image with Lucide icon fallback (no box/border)
// ---------------------------------------------------------------------------

function logoUrls(domain: string): string[] {
  if (!domain) return [];
  return [
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://logo.clearbit.com/${domain}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

/** Category → Lucide icon + color for when all logo sources fail */
const CATEGORY_FALLBACK: Record<string, { Icon: React.ElementType; color: string }> = {
  core:          { Icon: Settings2,    color: "text-violet-400" },
  crm:           { Icon: Users,        color: "text-blue-400" },
  email:         { Icon: Mail,         color: "text-amber-400" },
  prospecting:   { Icon: Target,       color: "text-emerald-400" },
  productivity:  { Icon: CheckSquare,  color: "text-cyan-400" },
  search:        { Icon: Globe,        color: "text-orange-400" },
  analytics:     { Icon: BarChart2,    color: "text-rose-400" },
  payments:      { Icon: CreditCard,   color: "text-indigo-400" },
  communication: { Icon: MessageSquare, color: "text-teal-400" },
  storage:       { Icon: HardDrive,   color: "text-sky-400" },
};

function ServiceLogo({
  service,
  label,
  domain,
  category,
  size = "md",
}: {
  service?: string;
  label: string;
  domain?: string;
  category: string;
  size?: "sm" | "md" | "lg";
}) {
  const resolvedDomain = KNOWN_DOMAINS[service ?? ""] ?? domain ?? "";
  const urls = logoUrls(resolvedDomain);
  const [urlIdx, setUrlIdx] = useState(0);

  const px = size === "sm" ? 24 : size === "lg" ? 40 : 32;
  const currentUrl = urls[urlIdx];

  if (currentUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={currentUrl}
        alt={label}
        onError={() => setUrlIdx((i) => i + 1)}
        width={px}
        height={px}
        className="object-contain rounded shrink-0"
      />
    );
  }

  const fb = CATEGORY_FALLBACK[category];
  const FbIcon = fb?.Icon ?? Puzzle;
  const fbColor = fb?.color ?? "text-muted-foreground";
  return <FbIcon size={px} className={`${fbColor} shrink-0`} />;
}

// ---------------------------------------------------------------------------
// ApiTile — compact grid card
// ---------------------------------------------------------------------------

function ApiTile({ api, selected, onClick }: { api: ApiEntry; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-left w-full p-4 rounded-xl border transition-all ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <ServiceLogo service={api.service} label={api.label} domain={api.domain} category={api.category} />
        <span className={`w-2 h-2 mt-1 rounded-full shrink-0 ${api.configured ? "bg-success" : "bg-muted"}`} />
      </div>
      <div className="font-medium text-sm text-foreground leading-tight line-clamp-1">{api.label}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5 capitalize">{api.category}</div>
      <div className={`mt-2 text-[10px] font-medium ${api.configured ? "text-success" : "text-muted-foreground"}`}>
        {api.configured ? "● Connected" : "○ Not set up"}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CredentialForm
// ---------------------------------------------------------------------------

function CredentialForm({
  api,
  onSaved,
}: {
  api: { env_vars: { key: string; label: string; sensitive: boolean }[] };
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(api.env_vars.map((v) => [v.key, ""]))
  );
  const [saving, setSaving] = useState(false);
  const [done, setDone]     = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  useEffect(() => {
    setValues(Object.fromEntries(api.env_vars.map((v) => [v.key, ""])));
    setErr(null);
    setDone(false);
  }, [api.env_vars]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/integrations/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vars: Object.entries(values).filter(([, v]) => v.trim()).map(([key, value]) => ({ key, value })),
        }),
      });
      if (r.ok) {
        setDone(true);
        setTimeout(() => { setDone(false); onSaved(); }, 900);
      } else {
        const d = await r.json().catch(() => ({}));
        setErr(String(d.error ?? `Save failed (${r.status})`));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {api.env_vars.map((v) => (
        <div key={v.key}>
          <label className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            {v.label}
            {v.sensitive && <Lock className="w-2.5 h-2.5 opacity-50" />}
          </label>
          <input
            type={v.sensitive ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[v.key] ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
            placeholder={`Enter ${v.label}…`}
            className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary transition-colors"
          />
          <div className="text-[9px] text-muted mt-0.5 font-mono">{v.key}</div>
        </div>
      ))}
      {err && <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{err}</p>}
      <button
        onClick={() => void save()}
        disabled={saving}
        className="w-full py-2.5 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground transition-colors flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : null}
        {saving ? "Saving…" : done ? "Saved!" : "Save credentials"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApiSidePanel
// ---------------------------------------------------------------------------

function ApiSidePanel({
  api, agents, onClose, onRefresh,
}: { api: ApiEntry; agents: AgentEntry[]; onClose: () => void; onRefresh: () => void }) {
  const [mode, setMode]           = useState<"info" | "edit">(api.configured ? "info" : "edit");
  const [testing, setTesting]     = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => { setMode(api.configured ? "info" : "edit"); setTestResult(null); }, [api.service, api.configured]);

  const usedBy = agents.filter(
    (a) => a.integrations?.includes(api.service) || a.optional_integrations?.includes(api.service)
  );

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch(`/api/integrations/test?service=${encodeURIComponent(api.service)}`);
      const d = await r.json();
      setTestResult({ ok: d.ok, detail: d.detail });
    } catch (e) {
      setTestResult({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    } finally { setTesting(false); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
        <div className="flex items-start gap-3">
          <ServiceLogo service={api.service} label={api.label} domain={api.domain} category={api.category} size="lg" />
          <div>
            <div className="font-semibold text-foreground">{api.label}</div>
            <div className="text-xs text-muted-foreground capitalize mt-0.5">{api.category}</div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className={`w-1.5 h-1.5 rounded-full ${api.configured ? "bg-success" : "bg-muted"}`} />
              <span className={`text-xs ${api.configured ? "text-success" : "text-muted-foreground"}`}>
                {api.configured ? "Connected" : "Not configured"}
              </span>
              {api.storage === "encrypted-db" && (
                <span className="text-[9px] flex items-center gap-0.5 text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full">
                  <Lock className="w-2 h-2" /> Encrypted
                </span>
              )}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors mt-0.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {api.description && <p className="text-sm text-muted-foreground leading-relaxed">{api.description}</p>}

        {usedBy.length > 0 && (
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Used by agents</div>
            <div className="flex flex-wrap gap-1">
              {usedBy.map((a) => (
                <span key={a.name} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-foreground border border-border">{a.name}</span>
              ))}
            </div>
          </div>
        )}

        {(api.setup_url || api.docs_url) && (
          <div className="flex gap-2 flex-wrap">
            {api.setup_url && (
              <a href={api.setup_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/5 transition-colors">
                Get credentials <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {api.docs_url && (
              <a href={api.docs_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition-colors">
                Docs <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {api.service === "github" ? (
          <GitHubAccountBadge integration={api} onRefresh={onRefresh} />
        ) : mode === "info" ? (
          <div className="space-y-4">
            {api.instructions && (
              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1">
                  <ChevronRight className="w-3 h-3 shrink-0" /> Setup instructions
                </summary>
                <pre className="mt-2 text-xs text-muted-foreground bg-secondary/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">{api.instructions}</pre>
              </details>
            )}
            <div className="flex gap-2">
              <button onClick={() => void runTest()} disabled={testing || !api.configured}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary disabled:opacity-40 transition-colors">
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {testing ? "Testing…" : "Test"}
              </button>
              <button onClick={() => setMode("edit")}
                className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground transition-colors">
                {api.configured ? "Update" : "Configure"}
              </button>
            </div>
            {testResult && (
              <div className={`text-xs rounded-lg px-3 py-2 flex items-start gap-2 ${testResult.ok ? "text-success bg-success/10 border border-success/20" : "text-destructive bg-destructive/10 border border-destructive/20"}`}>
                {testResult.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                {testResult.detail}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {api.instructions && (
              <details>
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1">
                  <ChevronDown className="w-3 h-3" /> Setup instructions
                </summary>
                <pre className="mt-2 text-xs text-muted-foreground bg-secondary/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">{api.instructions}</pre>
              </details>
            )}
            <CredentialForm api={api} onSaved={() => { setMode("info"); onRefresh(); }} />
            {api.configured && (
              <button onClick={() => setMode("info")} className="w-full py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors">Cancel</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiscoverModal — 3-step: Search → Multi-select → Configure queue
// ---------------------------------------------------------------------------

type DiscoverStep = "search" | "select" | "configure";

function DiscoverModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [q, setQ]               = useState("");
  const [step, setStep]         = useState<DiscoverStep>("search");
  const [discovering, setDisc]  = useState(false);
  const [results, setResults]   = useState<DiscoveredDef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savingDefs, setSavingDefs] = useState(false);
  const [configQueue, setConfigQueue] = useState<DiscoveredDef[]>([]);
  const [configIdx, setConfigIdx]     = useState(0);
  const [creds, setCreds]       = useState<Record<string, string>>({});
  const [savingCreds, setSavingCreds] = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  const inputRef                = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (configQueue[configIdx])
      setCreds(Object.fromEntries(configQueue[configIdx].env_vars.map((v) => [v.key, ""])));
  }, [configIdx, configQueue]);

  const discover = async () => {
    if (!q.trim()) return;
    setDisc(true); setErr(null);
    try {
      const r = await fetch("/api/integrations/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `Error ${r.status}`);
      const apiResults: DiscoveredDef[] = d.results ?? (d.definition ? [d.definition] : []);
      if (!apiResults.length) throw new Error("No APIs found for that query.");
      setResults(apiResults);
      setSelected(apiResults.length === 1 ? new Set([apiResults[0].service_id]) : new Set());
      setStep("select");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setDisc(false); }
  };

  const toggle = (id: string) =>
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const saveDefinitions = async () => {
    const toSave = results.filter((r) => selected.has(r.service_id));
    if (!toSave.length) return;
    setSavingDefs(true); setErr(null);
    try {
      await Promise.all(toSave.map((def) =>
        fetch("/api/integrations/custom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(def),
        })
      ));
      setConfigQueue(toSave); setConfigIdx(0); setStep("configure");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSavingDefs(false); }
  };

  const advanceOrFinish = async (skip: boolean) => {
    if (!skip) {
      const vars = Object.entries(creds).filter(([, v]) => v.trim()).map(([key, value]) => ({ key, value }));
      if (vars.length > 0) {
        setSavingCreds(true);
        try {
          const r = await fetch("/api/integrations/configure", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vars }),
          });
          if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error ?? `Error ${r.status}`); }
        } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSavingCreds(false); return; }
        setSavingCreds(false);
      }
    }
    if (configIdx < configQueue.length - 1) { setConfigIdx((i) => i + 1); setErr(null); }
    else { onSaved(); onClose(); }
  };

  const current = configQueue[configIdx];

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center sm:p-4 bg-background/80 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl bg-card border-t sm:border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="font-semibold text-foreground text-sm">
              {step === "search" && "Add API — AI Discovery"}
              {step === "select" && `${results.length} API${results.length !== 1 ? "s" : ""} found — select to add`}
              {step === "configure" && current && (
                <>Configure{configQueue.length > 1 ? ` (${configIdx + 1}/${configQueue.length})` : ""}: {current.label}</>
              )}
            </span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Step 1 — Search */}
          {step === "search" && (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Type any service or company name. Company names like{" "}
                <strong className="text-foreground">Google</strong> or{" "}
                <strong className="text-foreground">Microsoft</strong> return all their major APIs so you can pick the ones you need.
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input ref={inputRef} type="text" value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void discover()}
                    placeholder="e.g. Google, Microsoft, Stripe, Notion…"
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <button onClick={() => void discover()} disabled={!q.trim() || discovering}
                  className="px-4 py-2 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground flex items-center gap-2 shrink-0 transition-colors">
                  {discovering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {discovering ? "Searching…" : "Discover"}
                </button>
              </div>
              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Try these</div>
                <div className="flex flex-wrap gap-1.5">
                  {DISCOVER_SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => setQ(s)}
                      className="text-xs px-2.5 py-1 rounded-full bg-secondary border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Step 2 — Multi-select grid */}
          {step === "select" && (
            <>
              {results.length > 1 && (
                <p className="text-sm text-muted-foreground">
                  Select the APIs you want to add. You can pick multiple at once.
                </p>
              )}
              <div className={`grid gap-3 ${results.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
                {results.map((r) => {
                  const isSel = selected.has(r.service_id);
                  return (
                    <button key={r.service_id} onClick={() => toggle(r.service_id)}
                      className={`text-left p-3 rounded-xl border transition-all ${isSel ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border hover:border-primary/40 hover:bg-secondary/30"}`}>
                      <div className="flex items-start gap-2.5">
                        <ServiceLogo service={r.service_id} label={r.label} domain={r.domain} category={r.category} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-sm text-foreground">{r.label}</span>
                            {isSel && <Check className="w-3 h-3 text-primary shrink-0" />}
                          </div>
                          <div className="text-[10px] text-muted-foreground capitalize mb-1">{r.category}</div>
                          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{r.description}</p>
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {r.env_vars.slice(0, 3).map((v) => (
                              <span key={v.key} className="text-[9px] font-mono px-1 py-0.5 rounded bg-secondary border border-border text-muted">{v.key}</span>
                            ))}
                            {r.env_vars.length > 3 && <span className="text-[9px] text-muted">+{r.env_vars.length - 3}</span>}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setStep("search"); setResults([]); setSelected(new Set()); }}
                  className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors">
                  ← Back
                </button>
                <button onClick={() => void saveDefinitions()} disabled={selected.size === 0 || savingDefs}
                  className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground flex items-center justify-center gap-2 transition-colors">
                  {savingDefs ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                  {savingDefs ? "Adding…" : `Add ${selected.size} API${selected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </>
          )}

          {/* Step 3 — Configure queue */}
          {step === "configure" && current && (
            <>
              {configQueue.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Progress</span>
                  <div className="flex gap-1">
                    {configQueue.map((d, i) => (
                      <div key={d.service_id}
                        className={`w-2 h-2 rounded-full transition-colors ${i < configIdx ? "bg-success" : i === configIdx ? "bg-primary" : "bg-muted"}`}
                        title={d.label} />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">{configIdx + 1}/{configQueue.length}</span>
                </div>
              )}

              <div className="flex items-start gap-3">
                <ServiceLogo service={current.service_id} label={current.label} domain={current.domain} category={current.category} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-foreground">{current.label}</div>
                  <div className="text-xs text-muted-foreground capitalize">{current.category}</div>
                  {current.description && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{current.description}</p>}
                </div>
              </div>

              {current.instructions && (
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1">
                    <ChevronRight className="w-3 h-3" /> Setup instructions
                  </summary>
                  <pre className="mt-2 text-xs text-muted-foreground bg-secondary/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">{current.instructions}</pre>
                </details>
              )}

              {(current.setup_url || current.docs_url) && (
                <div className="flex gap-3 flex-wrap">
                  {current.setup_url && (
                    <a href={current.setup_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-colors">
                      Get credentials <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {current.docs_url && (
                    <a href={current.docs_url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                      API docs <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}

              {current.env_vars.map((v) => (
                <div key={v.key}>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                    {v.label} {v.sensitive && <Lock className="w-2.5 h-2.5 opacity-50" />}
                  </label>
                  <input type={v.sensitive ? "password" : "text"} autoComplete="off"
                    value={creds[v.key] ?? ""}
                    onChange={(e) => setCreds((p) => ({ ...p, [v.key]: e.target.value }))}
                    placeholder={`Enter ${v.label}…`}
                    className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
              ))}

              <div className="flex gap-2 pt-1">
                <button onClick={() => void advanceOrFinish(true)}
                  className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors">
                  {configIdx < configQueue.length - 1 ? "Skip →" : "Finish"}
                </button>
                <button onClick={() => void advanceOrFinish(false)} disabled={savingCreds}
                  className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground transition-colors">
                  {savingCreds ? "Saving…" : configIdx < configQueue.length - 1 ? "Save & next →" : "Save & finish"}
                </button>
              </div>
            </>
          )}

          {err && (
            <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {err}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ApisPage() {
  const [apis, setApis]       = useState<ApiEntry[]>([]);
  const [agents, setAgents]   = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [cat, setCat]         = useState<CatId>("all");
  const [search, setSearch]   = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showDiscover, setShowDiscover] = useState(false);
  const hasFetched = useRef(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, aRes] = await Promise.all([fetch("/api/integrations/status"), fetch("/api/agent/list")]);
      const [sData, aData] = await Promise.all([sRes.json(), aRes.json()]);
      setApis((Array.isArray(sData) ? sData : []).map((a: ApiEntry) => ({ ...a, category: a.category ?? "custom" })));
      setAgents(Array.isArray(aData) ? aData : []);
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!hasFetched.current) { hasFetched.current = true; void fetchAll(); }
  }, [fetchAll]);

  useEffect(() => {
    if (!loading && apis.length > 0 && !selected)
      setSelected((apis.find((a) => !a.configured) ?? apis[0]).service);
  }, [loading, apis, selected]);

  const filtered = apis.filter((a) => {
    if (cat !== "all" && a.category !== cat) return false;
    if (search && !a.label.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const selectedApi = selected ? (apis.find((a) => a.service === selected) ?? null) : null;
  const connectedCount = apis.filter((a) => a.configured).length;
  const catCounts: Record<string, number> = { all: apis.length };
  for (const a of apis) catCounts[a.category] = (catCounts[a.category] ?? 0) + 1;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-lg font-bold text-foreground">API Connections</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loading ? "Loading…" : `${connectedCount} of ${apis.length} connected · credentials encrypted at rest`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void fetchAll()} title="Refresh" className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowDiscover(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary hover:opacity-90 text-sm font-medium text-primary-foreground transition-colors">
            <Plus className="w-4 h-4" /><span className="hidden sm:inline">Add API</span>
          </button>
        </div>
      </div>

      {/* Category tabs + search */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
        <div className="flex gap-0.5 shrink-0">
          {CATEGORIES.filter((c) => c.id === "all" || (catCounts[c.id] ?? 0) > 0).map((c) => (
            <button key={c.id} onClick={() => setCat(c.id)}
              className={`text-xs px-2.5 py-1 rounded-full whitespace-nowrap transition-colors ${cat === c.id ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>
              {c.label}
              {c.id !== "all" && (catCounts[c.id] ?? 0) > 0 && <span className="ml-1 opacity-60">{catCounts[c.id]}</span>}
            </button>
          ))}
        </div>
        <div className="relative ml-auto shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="pl-8 pr-3 py-1.5 rounded-lg bg-secondary border border-border text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary transition-colors w-28 sm:w-36"
          />
        </div>
      </div>

      {/* Grid + Side panel */}
      <div className="flex flex-1 overflow-hidden relative">
        <div className={`flex-1 p-4 overflow-y-auto ${selectedApi ? "sm:min-w-0" : ""}`}>
          {loading ? (
            <div className="flex items-center justify-center h-48 gap-3 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading API connections…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground text-sm">
              <p>No APIs found{search ? ` for "${search}"` : ""}.</p>
              <button onClick={() => setShowDiscover(true)} className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80">
                <Plus className="w-3.5 h-3.5" /> Add a new API
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {filtered.map((api) => (
                <ApiTile key={api.service} api={api} selected={selected === api.service} onClick={() => setSelected(api.service)} />
              ))}
              <button onClick={() => setShowDiscover(true)}
                className="p-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-2 min-h-[120px]">
                <Plus className="w-5 h-5" /><span className="text-xs">Add API</span>
              </button>
            </div>
          )}
        </div>

        {selectedApi && (
          <>
            {/* Mobile: slide-in side panel from the right */}
            <div className="sm:hidden fixed inset-0 z-40 pointer-events-none">
              {/* Backdrop — tappable to dismiss */}
              <div className="absolute inset-0 bg-black/60 pointer-events-auto" onClick={() => setSelected(null)} />
              {/* Panel slides in from right — 85% width */}
              <aside className="absolute top-0 right-0 bottom-0 w-[85%] max-w-[360px] border-l border-border bg-card shadow-2xl flex flex-col pointer-events-auto chat-fade-in">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <ServiceLogo service={selectedApi.service} label={selectedApi.label ?? selectedApi.service} category={selectedApi.category} size="sm" />
                    <span className="text-sm font-semibold truncate">{selectedApi.label ?? selectedApi.service}</span>
                  </div>
                  <button onClick={() => setSelected(null)} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground shrink-0">
                    <X size={16} />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ApiSidePanel api={selectedApi} agents={agents} onClose={() => setSelected(null)} onRefresh={() => void fetchAll()} />
                </div>
              </aside>
            </div>
            {/* Desktop: side panel */}
            <div className="hidden sm:flex w-[380px] border-l border-border bg-card shrink-0 flex-col overflow-hidden">
              <ApiSidePanel api={selectedApi} agents={agents} onClose={() => setSelected(null)} onRefresh={() => void fetchAll()} />
            </div>
          </>
        )}
      </div>

      {showDiscover && <DiscoverModal onClose={() => setShowDiscover(false)} onSaved={() => void fetchAll()} />}
    </div>
  );
}

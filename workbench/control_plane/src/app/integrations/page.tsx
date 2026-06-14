"use client";

/**
 * /integrations — Integrations Hub
 *
 * Three tabs:
 *   APIs    — REST API connections + credentials (moved from /apis)
 *   MCPs    — Model Context Protocol server registry
 *   Plugins — Claude-style self-describing plugins
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BarChart2,
  Box,
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
  Server,
  Settings2,
  Sparkles,
  Target,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { AgentEntry } from "@/app/api/agent/list/route";
import GitHubAccountBadge from "@/components/GitHubAccountBadge";

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

type TabId = "apis" | "mcps" | "plugins";

const TABS: { id: TabId; label: string; icon: React.ElementType; note: string }[] = [
  { id: "apis",    label: "APIs",    icon: Zap,    note: "REST API credentials & discovery" },
  { id: "mcps",    label: "MCPs",    icon: Server, note: "Model Context Protocol servers" },
  { id: "plugins", label: "Plugins", icon: Puzzle, note: "Claude-style tool plugins" },
];

// ===========================================================================
// APIS TAB — full existing implementation
// ===========================================================================

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

const CATEGORY_FALLBACK: Record<string, { Icon: React.ElementType; color: string }> = {
  core:          { Icon: Settings2,     color: "text-violet-400" },
  crm:           { Icon: Users,         color: "text-blue-400" },
  email:         { Icon: Mail,          color: "text-amber-400" },
  prospecting:   { Icon: Target,        color: "text-emerald-400" },
  productivity:  { Icon: CheckSquare,   color: "text-cyan-400" },
  search:        { Icon: Globe,         color: "text-orange-400" },
  analytics:     { Icon: BarChart2,     color: "text-rose-400" },
  payments:      { Icon: CreditCard,    color: "text-indigo-400" },
  communication: { Icon: MessageSquare, color: "text-teal-400" },
  storage:       { Icon: HardDrive,     color: "text-sky-400" },
};

function logoUrls(domain: string): string[] {
  if (!domain) return [];
  return [
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://logo.clearbit.com/${domain}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

function ServiceLogo({
  service, label, domain, category, size = "md",
}: {
  service?: string; label: string; domain?: string; category: string; size?: "sm" | "md" | "lg";
}) {
  const resolvedDomain = KNOWN_DOMAINS[service ?? ""] ?? domain ?? "";
  const urls = logoUrls(resolvedDomain);
  const [urlIdx, setUrlIdx] = useState(0);
  const px = size === "sm" ? 24 : size === "lg" ? 40 : 32;
  const currentUrl = urls[urlIdx];

  if (currentUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={currentUrl} alt={label} onError={() => setUrlIdx((i) => i + 1)}
        width={px} height={px} className="object-contain rounded shrink-0" />
    );
  }
  const fb = CATEGORY_FALLBACK[category];
  const FbIcon = fb?.Icon ?? Puzzle;
  const fbColor = fb?.color ?? "text-muted-foreground";
  return <FbIcon size={px} className={`${fbColor} shrink-0`} />;
}

function ApiTile({ api, selected, onClick }: { api: ApiEntry; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`text-left w-full p-4 rounded-xl border transition-all ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"
      }`}>
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

function CredentialForm({ api, onSaved }: {
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
    setErr(null); setDone(false);
  }, [api.env_vars]);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const r = await fetch("/api/integrations/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vars: Object.entries(values).filter(([, v]) => v.trim()).map(([key, value]) => ({ key, value })),
        }),
      });
      if (r.ok) { setDone(true); setTimeout(() => { setDone(false); onSaved(); }, 900); }
      else { const d = await r.json().catch(() => ({})); setErr(String(d.error ?? `Save failed (${r.status})`)); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {api.env_vars.map((v) => (
        <div key={v.key}>
          <label className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            {v.label}
            {v.sensitive && <Lock className="w-2.5 h-2.5 opacity-50" />}
          </label>
          <input type={v.sensitive ? "password" : "text"} autoComplete="off" spellCheck={false}
            value={values[v.key] ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
            placeholder={`Enter ${v.label}…`}
            className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary transition-colors"
          />
          <div className="text-[9px] text-muted mt-0.5 font-mono">{v.key}</div>
        </div>
      ))}
      {err && <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{err}</p>}
      <button onClick={() => void save()} disabled={saving}
        className="w-full py-2.5 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground transition-colors flex items-center justify-center gap-2">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : null}
        {saving ? "Saving…" : done ? "Saved!" : "Save credentials"}
      </button>
    </div>
  );
}

function ApiSidePanel({ api, agents, onClose, onRefresh }: {
  api: ApiEntry; agents: AgentEntry[]; onClose: () => void; onRefresh: () => void;
}) {
  const [mode, setMode]         = useState<"info" | "edit">(api.configured ? "info" : "edit");
  const [testing, setTesting]   = useState(false);
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

type DiscoverStep = "search" | "select" | "configure";

function DiscoverModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [q, setQ]               = useState("");
  const [step, setStep]         = useState<DiscoverStep>("search");
  const [discovering, setDisc]  = useState(false);
  const [results, setResults]   = useState<DiscoveredDef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savingDefs, setSavingDefs]   = useState(false);
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
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setDisc(false); }
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
          {step === "search" && (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Type any service or company name. Company names like{" "}
                <strong className="text-foreground">Google</strong> or{" "}
                <strong className="text-foreground">Microsoft</strong> return all their major APIs.
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

          {step === "select" && (
            <>
              {results.length > 1 && (
                <p className="text-sm text-muted-foreground">Select the APIs you want to add.</p>
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

function ApisTab() {
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
    const isDesktop = typeof window !== "undefined" && window.innerWidth >= 640;
    if (!loading && apis.length > 0 && !selected && isDesktop)
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
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
        <p className="text-xs text-muted-foreground">
          {loading ? "Loading…" : `${connectedCount} of ${apis.length} connected · credentials encrypted at rest`}
        </p>
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={() => void fetchAll()} title="Refresh"
            className="p-1.5 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setShowDiscover(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground transition-colors">
            <Plus className="w-3.5 h-3.5" /><span className="hidden sm:inline">Add API</span>
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
            <div className="sm:hidden fixed inset-0 z-40 pointer-events-none">
              <div className="absolute inset-0 bg-black/50 pointer-events-auto" onClick={() => setSelected(null)} />
              <aside className="absolute inset-x-0 bottom-14 pointer-events-auto flex max-h-[45%] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl chat-fade-in">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
                  <div className="flex items-center gap-2">
                    <ServiceLogo service={selectedApi.service} label={selectedApi.label ?? selectedApi.service} category={selectedApi.category} size="sm" />
                    <span className="text-sm font-semibold">{selectedApi.label ?? selectedApi.service}</span>
                  </div>
                  <button onClick={() => setSelected(null)} className="p-1 rounded-md hover:bg-secondary text-muted-foreground">
                    <X size={16} />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ApiSidePanel api={selectedApi} agents={agents} onClose={() => setSelected(null)} onRefresh={() => void fetchAll()} />
                </div>
              </aside>
            </div>
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

// ===========================================================================
// MCPS TAB — MCP server registry (coming soon)
// ===========================================================================

const MCP_EXAMPLES = [
  { name: "filesystem",    desc: "Read & write local files — give agents persistent workspace storage",      color: "text-sky-400",     bg: "bg-sky-500/10",     border: "border-sky-500/20" },
  { name: "postgres",      desc: "Query your databases directly — agents can run SQL for reporting & ops",   color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
  { name: "brave-search",  desc: "Live web search — agents can research topics and fetch fresh information", color: "text-orange-400",   bg: "bg-orange-500/10",  border: "border-orange-500/20" },
  { name: "github",        desc: "Full GitHub API access — PRs, issues, code review, commit history",       color: "text-violet-400",  bg: "bg-violet-500/10",  border: "border-violet-500/20" },
  { name: "slack",         desc: "Read & post to Slack channels — agents can coordinate with your team",    color: "text-rose-400",    bg: "bg-rose-500/10",    border: "border-rose-500/20" },
  { name: "custom",        desc: "Any MCP-compliant server — point to a URL and register custom tools",     color: "text-muted-foreground", bg: "bg-secondary", border: "border-border" },
];

function McpsTab() {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const hasFetched = useRef(false);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/integrations/mcp");
      if (r.ok) setServers(await r.json());
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!hasFetched.current) { hasFetched.current = true; void fetchServers(); }
  }, [fetchServers]);

  const handleDelete = async (name: string) => {
    try {
      await fetch(`/api/integrations/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
      setServers((p) => p.filter((s) => s.name !== name));
    } catch { /* non-fatal */ }
  };

  const handleTest = async (s: any) => {
    setTesting(s.name);
    try {
      const r = await fetch("/api/integrations/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: s.name, transport: s.transport, url: s.url,
          command: s.command, headers: s.headers || {},
        }),
      });
      const d = await r.json();
      setTestResults((p) => ({ ...p, [s.name]: { ok: d.ok, detail: d.detail } }));
    } catch { /* non-fatal */ }
    finally { setTesting(null); }
  };

  const connectedCount = servers.filter((s) => s.enabled).length;

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-6">
      {/* Hero */}
      <div className="flex items-start gap-4 p-5 rounded-2xl border border-border bg-card">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Server className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">Model Context Protocol Servers</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {loading ? "Loading…" : `${connectedCount} server${connectedCount !== 1 ? "s" : ""} registered`}
              </p>
            </div>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground shrink-0 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Add MCP Server
            </button>
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed max-w-xl">
            MCP is an open standard (by Anthropic) that lets agents connect to external tools. Register any MCP
            server here and every agent in CommandCenter can automatically discover and use its tools at runtime.
          </p>
        </div>
      </div>

      {/* Registered servers */}
      {servers.length > 0 ? (
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider mb-3">Registered servers</div>
          <div className="space-y-2">
            {servers.map((s) => (
              <div key={s.name} className="p-4 rounded-xl border border-border bg-card hover:bg-secondary/10 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-foreground">{s.name}</span>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.enabled ? "bg-success" : "bg-muted"}`} />
                      <span className="text-[10px] text-muted uppercase">{s.transport}</span>
                      {s.agent_scope && !s.agent_scope.includes("*") && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted">
                          {s.agent_scope.length} agent{s.agent_scope.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {s.description && <p className="text-xs text-muted-foreground mt-1">{s.description}</p>}
                    {s.transport === "http-sse" && s.url && (
                      <div className="text-[10px] font-mono text-muted mt-1 truncate">{s.url}</div>
                    )}
                    {s.transport === "stdio" && s.command && (
                      <div className="text-[10px] font-mono text-muted mt-1 truncate">{s.command}</div>
                    )}
                    {testResults[s.name] && (
                      <div className={`text-xs mt-1.5 ${testResults[s.name].ok ? "text-success" : "text-destructive"}`}>
                        {testResults[s.name].ok ? "✓" : "✗"} {testResults[s.name].detail}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => handleTest(s)} disabled={testing === s.name}
                      className="px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:bg-secondary disabled:opacity-40 transition-colors">
                      {testing === s.name ? "…" : "Test"}
                    </button>
                    <button onClick={() => handleDelete(s.name)}
                      className="px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <div className="w-12 h-12 rounded-2xl bg-secondary border border-border flex items-center justify-center">
            <Server className="w-6 h-6 text-muted-foreground" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">No MCP servers registered</div>
            <div className="text-xs text-muted-foreground mt-0.5">Add your first MCP server to give agents new capabilities.</div>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add MCP Server
          </button>
        </div>
      ) : null}

      {/* How it works */}
      <div className="p-5 rounded-2xl border border-border bg-card space-y-4">
        <div className="text-[10px] text-muted uppercase tracking-wider">How it works in CommandCenter</div>
        <ol className="space-y-3">
          {[
            { n: "1", title: "Register a server", body: "Paste the MCP server URL (HTTP/SSE or stdio transport). Set a name and which agents may use it." },
            { n: "2", title: "Automatic tool injection", body: "The executor queries the MCP registry at run time and injects matching servers into GitHubCopilotAgent. Tools from the MCP server appear alongside the agent's own skills." },
            { n: "3", title: "Agent-driven invocation", body: "When the LLM decides to call an MCP tool, the Copilot SDK proxies the call, handles auth, and streams results back." },
            { n: "4", title: "Audit & observability", body: "Every MCP tool call is logged in the audit trail with inputs, outputs, and latency." },
          ].map((step) => (
            <li key={step.n} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{step.n}</span>
              <div>
                <div className="text-xs font-medium text-foreground">{step.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Add MCP Server modal */}
      {showAdd && <AddMcpModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void fetchServers(); }} />}
    </div>
  );
}

// ── Add MCP Server modal ──────────────────────────────────────────────────

function AddMcpModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: "", label: "", description: "", transport: "http-sse", url: "", command: "", headerKey: "", headerValue: "", agentScope: "*" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true); setErr(null);
    try {
      const headers: Record<string, string> = {};
      if (form.headerKey.trim() && form.headerValue.trim())
        headers[form.headerKey.trim()] = form.headerValue.trim();
      const body: any = {
        name: form.name.trim(),
        label: form.label.trim() || form.name.trim(),
        description: form.description.trim(),
        transport: form.transport,
        headers,
        agent_scope: form.agentScope.split(",").map((s) => s.trim()).filter(Boolean),
        enabled: true,
      };
      if (form.transport === "http-sse") body.url = form.url.trim();
      else body.command = form.command.trim();
      const r = await fetch("/api/integrations/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) onAdded();
      else { const d = await r.json().catch(() => ({})); setErr(d.detail || `Error ${r.status}`); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center sm:p-4 bg-background/80 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md bg-card border-t sm:border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="font-semibold text-sm">Add MCP Server</div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Name <span className="text-destructive">*</span></label>
              <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="brave-search" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Label</label>
              <input type="text" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="Brave Search" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Description</label>
            <input type="text" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What does this MCP server provide?" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Transport</label>
            <div className="flex gap-2">
              {(["http-sse", "stdio"] as const).map((t) => (
                <button key={t} onClick={() => setForm((f) => ({ ...f, transport: t }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${form.transport === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground border border-border"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          {form.transport === "http-sse" ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">URL <span className="text-destructive">*</span></label>
              <input type="text" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://mcp.example.com/sse" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono" />
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Command <span className="text-destructive">*</span></label>
              <input type="text" value={form.command} onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                placeholder="npx -y @modelcontextprotocol/server-postgres" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Header (key)</label>
              <input type="text" value={form.headerKey} onChange={(e) => setForm((f) => ({ ...f, headerKey: e.target.value }))}
                placeholder="Authorization" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Header (value)</label>
              <input type="text" value={form.headerValue} onChange={(e) => setForm((f) => ({ ...f, headerValue: e.target.value }))}
                placeholder="Bearer sk-..." className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Agent scope</label>
            <input type="text" value={form.agentScope} onChange={(e) => setForm((f) => ({ ...f, agentScope: e.target.value }))}
              placeholder="* (all agents) or agent-sales, agent-triage" className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary" />
            <p className="text-[10px] text-muted mt-0.5">Comma-separated agent names, or * for all</p>
          </div>
          {err && <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors">Cancel</button>
            <button onClick={save} disabled={!form.name.trim() || saving}
              className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground transition-colors">
              {saving ? "Saving…" : "Add Server"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// PLUGINS TAB — Claude-style plugin registry (coming soon)
// ===========================================================================

const PLUGIN_EXAMPLES = [
  { name: "Web Browsing",      icon: Globe,    desc: "Agents can open URLs, read pages, and extract structured data from the live web." },
  { name: "Code Interpreter",  icon: Box,      desc: "Run sandboxed Python/JS and return computed results, charts, or transformed data." },
  { name: "Document Analysis", icon: HardDrive, desc: "Upload PDFs, spreadsheets, or images and let agents extract and reason over content." },
  { name: "Email Actions",     icon: Mail,     desc: "Draft, send, and thread emails directly from agent workflows without extra API setup." },
  { name: "Calendar & Booking",icon: CheckSquare, desc: "Check availability, schedule meetings, and create calendar events autonomously." },
  { name: "Community Plugins", icon: Users,    desc: "Install third-party plugins published by the CommandCenter community or build your own." },
];

function PluginsTab() {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInstall, setShowInstall] = useState(false);
  const hasFetched = useRef(false);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/integrations/plugins");
      if (r.ok) setPlugins(await r.json());
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!hasFetched.current) { hasFetched.current = true; void fetchPlugins(); }
  }, [fetchPlugins]);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/integrations/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
      setPlugins((p) => p.filter((pl) => pl.id !== id));
    } catch { /* non-fatal */ }
  };

  return (
    <div className="flex flex-col flex-1 overflow-y-auto p-6 gap-6">
      {/* Hero */}
      <div className="flex items-start gap-4 p-5 rounded-2xl border border-border bg-card">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <Puzzle className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">Claude-style Plugins</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {loading ? "Loading…" : `${plugins.length} plugin${plugins.length !== 1 ? "s" : ""} installed`}
              </p>
            </div>
            <button onClick={() => setShowInstall(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground shrink-0 transition-colors">
              <Plus className="w-3.5 h-3.5" /> Install Plugin
            </button>
          </div>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed max-w-xl">
            Plugins are self-describing tool packages — each one ships a manifest, an OpenAPI spec, and auth config.
            Install from any URL and agents auto-discover what the plugin can do.
          </p>
        </div>
      </div>

      {/* Installed plugins */}
      {plugins.length > 0 ? (
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider mb-3">Installed plugins</div>
          <div className="space-y-2">
            {plugins.map((p) => (
              <div key={p.id} className="p-4 rounded-xl border border-border bg-card hover:bg-secondary/10 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground">{p.label || p.name}</span>
                      <span className="text-[10px] font-mono text-muted">{p.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted">v{p.version}</span>
                      {p.auth_type !== "none" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {p.auth_type}
                        </span>
                      )}
                      {(p.tools_generated || []).length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success border border-success/20">
                          {(p.tools_generated || []).length} tool{(p.tools_generated || []).length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    {p.description && <p className="text-xs text-muted-foreground mt-1">{p.description}</p>}
                    <div className="text-[10px] font-mono text-muted mt-1 truncate">{p.manifest_url}</div>
                  </div>
                  <button onClick={() => handleDelete(p.id)}
                    className="px-2 py-1 rounded text-[10px] border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <div className="w-12 h-12 rounded-2xl bg-secondary border border-border flex items-center justify-center">
            <Puzzle className="w-6 h-6 text-muted-foreground" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">No plugins installed</div>
            <div className="text-xs text-muted-foreground mt-0.5">Install a plugin from a manifest URL to give agents new SaaS capabilities.</div>
          </div>
          <button onClick={() => setShowInstall(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground transition-colors">
            <Plus className="w-3.5 h-3.5" /> Install Plugin
          </button>
        </div>
      ) : null}

      {/* Plugin capabilities grid */}
      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-3">Capabilities plugins unlock</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PLUGIN_EXAMPLES.map((p) => (
            <div key={p.name} className="p-4 rounded-xl border border-border bg-card hover:bg-secondary/30 transition-colors">
              <div className="flex items-center gap-2 mb-2">
                <p.icon className="w-4 h-4 text-primary shrink-0" />
                <span className="text-xs font-semibold text-foreground">{p.name}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Plugin vs MCP */}
      <div className="p-5 rounded-2xl border border-amber-500/20 bg-amber-500/5 space-y-2">
        <div className="text-[10px] text-amber-400 uppercase tracking-wider font-semibold">Plugins vs MCPs — when to use which</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-muted-foreground">
          <div>
            <div className="text-foreground font-medium mb-1">Use a Plugin when…</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>The tool has a REST API and an OpenAPI spec</li>
              <li>You want OAuth or per-user auth flows</li>
              <li>You want to share / distribute the integration</li>
            </ul>
          </div>
          <div>
            <div className="text-foreground font-medium mb-1">Use an MCP server when…</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>You control the server and prefer the MCP protocol</li>
              <li>The tool needs streaming or binary data transport</li>
              <li>You want tight integration with local infrastructure</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Install Plugin modal */}
      {showInstall && <InstallPluginModal onClose={() => setShowInstall(false)} onInstalled={() => { setShowInstall(false); void fetchPlugins(); }} />}
    </div>
  );
}

// ── Install Plugin modal ─────────────────────────────────────────────────

function InstallPluginModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const [manifestUrl, setManifestUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const install = async () => {
    if (!manifestUrl.trim()) return;
    setInstalling(true); setErr(null); setResult(null);
    try {
      const r = await fetch("/api/integrations/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest_url: manifestUrl.trim() }),
      });
      const d = await r.json();
      if (r.ok) { setResult(d); onInstalled(); }
      else { setErr(d.detail || d.error || `Error ${r.status}`); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setInstalling(false); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center sm:p-4 bg-background/80 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-md bg-card border-t sm:border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="font-semibold text-sm">Install Plugin</div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {result ? (
            <div className="p-4 rounded-xl border border-success/20 bg-success/5 space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-success" />
                <span className="text-sm font-medium text-foreground">Installed: {result.label}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Plugin <span className="font-mono">{result.name}</span> registered with {result.tools_count} tool{result.tools_count !== 1 ? "s" : ""}.
                {result.auth_type !== "none" && <> Auth type: {result.auth_type}.</>}
              </div>
              <button onClick={onClose} className="w-full py-2 rounded-lg bg-primary hover:opacity-90 text-sm font-medium text-primary-foreground transition-colors">Done</button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Paste the URL of a plugin manifest (ai-plugin.json). The OpenAPI spec will be auto-fetched and tools generated.</p>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Manifest URL <span className="text-destructive">*</span></label>
                <input ref={inputRef} type="text" value={manifestUrl}
                  onChange={(e) => setManifestUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void install()}
                  placeholder="https://my-plugin.example.com/.well-known/ai-plugin.json"
                  className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary font-mono" />
              </div>
              {err && <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 flex items-start gap-2"><AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {err}</p>}
              <div className="flex gap-2 pt-1">
                <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors">Cancel</button>
                <button onClick={install} disabled={!manifestUrl.trim() || installing}
                  className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 disabled:opacity-40 text-sm font-medium text-primary-foreground flex items-center justify-center gap-2 transition-colors">
                  {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  {installing ? "Installing…" : "Install"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Main Page
// ===========================================================================

export default function IntegrationsPage() {
  const [tab, setTab] = useState<TabId>("apis");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-lg font-bold text-foreground">Integrations</h1>
          <p className="text-xs text-muted-foreground mt-0.5">APIs · MCP servers · plugins</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border shrink-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                active
                  ? "border-primary text-foreground bg-primary/5"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {tab === "apis"    && <ApisTab />}
        {tab === "mcps"    && <McpsTab />}
        {tab === "plugins" && <PluginsTab />}
      </div>
    </div>
  );
}

"use client";

/**
 * /observability — Live Activity + 8-bit Agent Office
 *
 * Complete visibility into every agent and model across the whole platform —
 * chat AND every app (email, tasks, …). Three views over the same live feed:
 *
 *   • Office  — an 8-bit game-y room: each agent is a character at a desk that
 *               works (typing), sleeps (💤), or errors (⚠️) live; a server rack
 *               lights up per active model.
 *   • Feed    — the raw real-time stream of activations, with per-call cost.
 *   • Cost    — daily LLM spend (per-day bars, by-model, by-app).
 *
 * Click any agent to drill into its recent runs + errors. Data:
 *   backfill    GET /api/observability/activity/recent
 *   live tail   EventSource /api/observability/activity/stream
 *   presence    GET /api/observability/active
 *   roster      GET /api/observability/roster
 *   cost        GET /api/observability/cost
 *   drill-down  GET /api/observability/runs?agent=
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

interface ActivityEvent {
  _id?: string;
  ts?: string;
  kind?: "agent" | "model" | string;
  phase?: "start" | "end" | string;
  agent?: string;
  model?: string;
  tier?: string;
  user?: string;
  thread_id?: string;
  run_id?: string;
  source?: string;
  status?: string;
  duration_ms?: number;
  tokens?: number;
  cost_usd?: number | null;
}

interface AgentRow {
  name: string;
  description?: string;
  runtime?: string;
  status?: "working" | "idle" | string;
  active_runs?: number;
  last_ts?: string | null;
  source?: string | null;
}

interface RunRow {
  run_id?: string;
  agent?: string;
  model?: string;
  status?: string;
  started_at?: string;
  duration_ms?: number;
  total_tokens?: number;
  error_type?: string | null;
  error_message?: string | null;
  source?: string | null;
}

interface ModelBlade {
  model: string;
  tier?: string;
  tokens: number;
  cost: number;
  calls: number;
  lastTs: number;
}

interface CostData {
  days: Array<{
    date: string;
    cost: number;
    tokens: number;
    calls: number;
    by_model: Record<string, { cost: number; tokens: number; calls: number }>;
  }>;
  by_model: Record<string, { cost: number; tokens: number; calls: number }>;
  by_source: Record<string, { cost: number; calls: number }>;
  totals: { cost: number; tokens: number; calls: number };
}

const MAX_FEED = 300;
const MODEL_TTL_MS = 12_000; // a model counts as "active" for this long after a call
const AGENT_HOT_MS = 15_000; // an agent glows "working" this long after a start

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function relativeTime(iso?: string | number): string {
  if (iso == null) return "";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (isNaN(d.getTime())) return "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleTimeString();
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(n?: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n?: number): string {
  if (!n) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function shortModel(model?: string): string {
  if (!model) return "model";
  const noProv = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  return noProv.length > 22 ? noProv.slice(0, 21) + "…" : noProv;
}

const AGENT_EMOJI = ["🤖", "👩‍💻", "👨‍💻", "🧑‍🔬", "🕵️", "🧙", "👷", "🦾", "📊", "✉️", "🧑‍🚀", "🐧"];
function agentEmoji(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_EMOJI[h % AGENT_EMOJI.length];
}

function sourceClass(source?: string | null): string {
  switch ((source ?? "").toLowerCase()) {
    case "chat":
      return "bg-primary/10 text-primary border-primary/20";
    case "email":
      return "bg-blue-500/10 text-blue-500 border-blue-500/20";
    case "tasks":
      return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
    case "":
    case "unattributed":
      return "bg-secondary/40 text-muted-foreground border-border";
    default:
      return "bg-violet-500/10 text-violet-500 border-violet-500/20";
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 8-bit styling — injected once (keyframes + pixel utilities, `obs-` scoped)
// ───────────────────────────────────────────────────────────────────────────

const PIXEL_STYLE = `
.obs-pixel { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing: .02em; }
.obs-room {
  background-image:
    linear-gradient(0deg, rgba(120,120,160,0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,120,160,0.07) 1px, transparent 1px);
  background-size: 22px 22px;
}
.obs-desk { image-rendering: pixelated; transition: transform .12s steps(2), box-shadow .2s; }
.obs-desk:hover { transform: translateY(-2px); }
.obs-working .obs-char { animation: obs-bob .6s steps(2) infinite; }
.obs-idle .obs-char { animation: obs-breathe 3s ease-in-out infinite; filter: grayscale(.5) opacity(.65); }
.obs-error .obs-desk-inner { animation: obs-shake .35s steps(2) 2; }
.obs-monitor { position: relative; overflow: hidden; }
.obs-monitor::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(transparent 50%, rgba(255,255,255,0.06) 50%);
  background-size: 100% 4px; pointer-events: none;
}
.obs-working .obs-monitor { animation: obs-flicker 1.2s steps(3) infinite; }
.obs-zzz { animation: obs-zzz 2.4s ease-in-out infinite; }
.obs-led { animation: obs-blink 1s steps(2) infinite; }
.obs-scan { animation: obs-scanx 2.2s linear infinite; }
@keyframes obs-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes obs-breathe { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(1px) scale(0.99); } }
@keyframes obs-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
@keyframes obs-flicker { 0%,100% { opacity: 1; } 50% { opacity: .82; } }
@keyframes obs-zzz { 0% { opacity: 0; transform: translate(0,0) scale(.8);} 30% { opacity: 1; } 100% { opacity: 0; transform: translate(8px,-14px) scale(1.1); } }
@keyframes obs-blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes obs-scanx { 0% { transform: translateX(-100%);} 100% { transform: translateX(300%);} }
`;

// ───────────────────────────────────────────────────────────────────────────
// Office view
// ───────────────────────────────────────────────────────────────────────────

function Desk({
  agent,
  hot,
  onOpen,
}: {
  agent: AgentRow;
  hot: boolean;
  onOpen: (name: string) => void;
}) {
  const working = agent.status === "working" || hot;
  const state = working ? "obs-working" : "obs-idle";
  return (
    <button
      onClick={() => onOpen(agent.name)}
      className={`obs-desk ${state} group text-left rounded-xl border p-3 flex flex-col items-center gap-2 w-full ${
        working
          ? "border-amber-500/40 bg-amber-500/5 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
          : "border-border bg-card/60 hover:border-border"
      }`}
      title={agent.description || agent.name}
    >
      {/* Character + zzz */}
      <div className="relative">
        <div className="obs-char text-3xl leading-none select-none">{agentEmoji(agent.name)}</div>
        {!working && (
          <span className="obs-zzz absolute -right-2 -top-1 text-[10px] text-muted-foreground">z</span>
        )}
        {working && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 obs-led" />
        )}
      </div>

      {/* Monitor / desk */}
      <div
        className={`obs-monitor w-full h-8 rounded-md border ${
          agent.status === "error"
            ? "border-destructive/50 bg-destructive/10"
            : working
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-border bg-secondary/30"
        }`}
      >
        {working && (
          <span className="obs-scan block h-full w-6 bg-emerald-400/25" />
        )}
      </div>

      <div className="obs-pixel text-[11px] font-semibold text-foreground truncate max-w-full">
        {agent.name}
      </div>
      <div className="flex items-center gap-1">
        <span
          className={`obs-pixel text-[9px] uppercase px-1.5 py-0.5 rounded border ${
            working
              ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
              : "bg-secondary/50 text-muted-foreground border-border"
          }`}
        >
          {working ? "working" : "sleeping"}
        </span>
        {agent.source && working && (
          <span className={`obs-pixel text-[9px] px-1 py-0.5 rounded border ${sourceClass(agent.source)}`}>
            {agent.source}
          </span>
        )}
      </div>
    </button>
  );
}

function ServerRack({ blades }: { blades: ModelBlade[] }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="obs-pixel text-[10px] uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2">
        <span>Model servers</span>
        <span className="rounded bg-secondary/50 px-1.5 py-0.5">{blades.length} live</span>
      </div>
      {blades.length === 0 ? (
        <p className="obs-pixel text-[11px] text-muted-foreground/60 italic">All quiet — no models running.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {blades.map((b) => (
            <div
              key={b.model}
              className="flex items-center gap-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-2 py-1.5"
            >
              <span className="h-2 w-2 rounded-full bg-violet-500 obs-led shrink-0" />
              <span className="obs-pixel text-[11px] text-foreground truncate flex-1" title={b.model}>
                {shortModel(b.model)}
              </span>
              {b.tier && (
                <span className="obs-pixel text-[9px] text-muted-foreground/70">T{b.tier.replace(/[^0-9]/g, "") || "?"}</span>
              )}
              <span className="obs-pixel text-[10px] text-muted-foreground">{fmtTokens(b.tokens)}t</span>
              <span className="obs-pixel text-[10px] text-emerald-500">{fmtCost(b.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OfficeView({
  roster,
  hotAgents,
  blades,
  todayCost,
  onOpen,
}: {
  roster: AgentRow[];
  hotAgents: Set<string>;
  blades: ModelBlade[];
  todayCost: number;
  onOpen: (name: string) => void;
}) {
  const workingCount = roster.filter(
    (a) => a.status === "working" || hotAgents.has(a.name),
  ).length;
  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full min-h-0">
      <div className="obs-room flex-1 min-w-0 overflow-y-auto rounded-2xl border border-border bg-background/40 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="obs-pixel text-[11px] uppercase tracking-wide text-muted-foreground">
            🏢 The Office · {workingCount}/{roster.length} at work
          </div>
          <div className="obs-pixel text-[11px] text-emerald-500">Today {fmtCost(todayCost)}</div>
        </div>
        {roster.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
            <span className="text-3xl">🏗️</span>
            <p className="obs-pixel text-sm text-muted-foreground">No agents registered yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {roster.map((a) => (
              <Desk key={a.name} agent={a} hot={hotAgents.has(a.name)} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
      <div className="lg:w-72 shrink-0">
        <ServerRack blades={blades} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Feed view
// ───────────────────────────────────────────────────────────────────────────

function ActivityRow({ e, onOpen }: { e: ActivityEvent; onOpen: (name: string) => void }) {
  const isAgent = e.kind === "agent";
  const isEnd = e.phase === "end";
  const isError = e.status === "error";
  const dotClass = isAgent
    ? isEnd
      ? isError
        ? "bg-destructive"
        : "bg-success/70"
      : "bg-amber-500 obs-led"
    : "bg-violet-500";
  const label = isAgent ? e.agent ?? "agent" : shortModel(e.model);
  const verb = isAgent ? (isEnd ? (isError ? "failed" : "finished") : "started") : "called";

  return (
    <li className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-secondary/30 transition-colors">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${
          isAgent ? "bg-secondary/40 text-foreground border-border" : "bg-violet-500/10 text-violet-500 border-violet-500/20"
        }`}
      >
        {isAgent ? "Agent" : "Model"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {isAgent ? (
            <button
              onClick={() => e.agent && onOpen(e.agent)}
              className="font-mono text-sm text-foreground truncate hover:underline"
            >
              {label}
            </button>
          ) : (
            <span className="font-mono text-sm text-foreground truncate">{label}</span>
          )}
          <span className="text-xs text-muted-foreground shrink-0">{verb}</span>
          {isAgent && e.model && !isEnd && (
            <span className="font-mono text-[11px] text-muted-foreground/70 truncate">· {shortModel(e.model)}</span>
          )}
          {!isAgent && e.tier && (
            <span className="text-[11px] text-muted-foreground/70 shrink-0">· tier {e.tier}</span>
          )}
        </div>
        {(e.user || e.thread_id) && (
          <div className="text-[11px] text-muted-foreground/60 truncate">
            {e.user ? e.user : ""}
            {e.user && e.thread_id ? " · " : ""}
            {e.thread_id ? `thread ${e.thread_id.slice(0, 8)}` : ""}
          </div>
        )}
      </div>
      {e.source && (
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium border ${sourceClass(e.source)}`}>
          {e.source}
        </span>
      )}
      <div className="shrink-0 text-right w-[80px]">
        {isAgent && isEnd && e.duration_ms != null && (
          <div className="text-[11px] font-mono text-muted-foreground">{fmtDuration(e.duration_ms)}</div>
        )}
        {!isAgent && (
          <div className="text-[11px] font-mono text-muted-foreground">
            {e.tokens != null ? `${fmtTokens(e.tokens)}t` : ""}
            {e.cost_usd != null ? ` · ${fmtCost(e.cost_usd)}` : ""}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/60">{relativeTime(e.ts)}</div>
      </div>
    </li>
  );
}

function FeedView({ feed, onOpen }: { feed: ActivityEvent[]; onOpen: (name: string) => void }) {
  if (feed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Waiting for activity…</p>
        <p className="text-xs text-muted-foreground/60">Start a chat or trigger an app and it&apos;ll show up here instantly.</p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/40">
      {feed.map((e, i) => (
        <ActivityRow key={e._id ?? `${e.kind}:${e.run_id ?? e.model}:${e.ts ?? i}`} e={e} onOpen={onOpen} />
      ))}
    </ul>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Cost view
// ───────────────────────────────────────────────────────────────────────────

function CostView({ cost }: { cost: CostData | null }) {
  if (!cost) {
    return <p className="text-sm text-muted-foreground p-4">Loading cost…</p>;
  }
  const maxDay = Math.max(0.0001, ...cost.days.map((d) => d.cost));
  const models = Object.entries(cost.by_model).sort((a, b) => b[1].cost - a[1].cost);
  const sources = Object.entries(cost.by_source).sort((a, b) => b[1].cost - a[1].cost);
  const today = cost.days.length ? cost.days[cost.days.length - 1] : null;

  return (
    <div className="flex flex-col gap-5 p-1">
      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Today" value={fmtCost(today?.cost ?? 0)} accent="emerald" />
        <Stat label={`Last ${cost.days.length}d`} value={fmtCost(cost.totals.cost)} />
        <Stat label="Tokens" value={fmtTokens(cost.totals.tokens)} />
        <Stat label="Calls" value={`${cost.totals.calls}`} />
      </div>

      {/* Daily bars */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Daily spend</h3>
        <div className="flex items-end gap-1.5 h-40">
          {cost.days.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0 group">
              <div className="text-[9px] font-mono text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
                {fmtCost(d.cost)}
              </div>
              <div
                className="w-full rounded-t bg-gradient-to-t from-emerald-600/60 to-emerald-400/80 min-h-[2px] transition-all"
                style={{ height: `${Math.max(2, (d.cost / maxDay) * 130)}px` }}
                title={`${d.date}: ${fmtCost(d.cost)} · ${d.calls} calls`}
              />
              <div className="text-[9px] font-mono text-muted-foreground/60 truncate w-full text-center">
                {d.date.slice(5)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By model */}
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">By model</h3>
          {models.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">No spend recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {models.slice(0, 10).map(([m, v]) => (
                <li key={m} className="flex items-center gap-2 text-xs">
                  <span className="h-2 w-2 rounded-full bg-violet-500 shrink-0" />
                  <span className="font-mono text-foreground truncate flex-1" title={m}>{shortModel(m)}</span>
                  <span className="text-muted-foreground shrink-0">{fmtTokens(v.tokens)}t</span>
                  <span className="text-muted-foreground/60 shrink-0">{v.calls}×</span>
                  <span className="font-mono text-emerald-500 shrink-0 w-16 text-right">{fmtCost(v.cost)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* By app */}
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">By app</h3>
          {sources.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">No spend recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sources.map(([s, v]) => (
                <li key={s} className="flex items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium border ${sourceClass(s)}`}>{s}</span>
                  <span className="flex-1" />
                  <span className="text-muted-foreground/60 shrink-0">{v.calls}×</span>
                  <span className="font-mono text-emerald-500 shrink-0 w-16 text-right">{fmtCost(v.cost)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/50 px-1">
        Cost is estimated from LiteLLM&apos;s public price map per model. Unknown/self-hosted models show &quot;—&quot;.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${accent === "emerald" ? "text-emerald-500" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Agent drill-down drawer
// ───────────────────────────────────────────────────────────────────────────

function AgentDrawer({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [tab, setTab] = useState<"all" | "errors">("all");

  useEffect(() => {
    let cancelled = false;
    // Fresh mount per agent (keyed at the call site), so `runs` starts null —
    // no need to reset it here (which would trip set-state-in-effect).
    (async () => {
      try {
        const res = await fetch(`/api/observability/runs?agent=${encodeURIComponent(name)}&limit=40`);
        const data = await res.json();
        if (!cancelled) setRuns(Array.isArray(data.runs) ? data.runs : []);
      } catch {
        if (!cancelled) setRuns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  const shown = useMemo(() => {
    if (!runs) return [];
    return tab === "errors" ? runs.filter((r) => r.status === "error") : runs;
  }, [runs, tab]);
  const errorCount = (runs ?? []).filter((r) => r.status === "error").length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      <aside
        className="relative w-full max-w-md h-full bg-card border-l border-border shadow-2xl flex flex-col chat-fade-in"
        onClick={(ev) => ev.stopPropagation()}
      >
        <header className="flex items-center gap-3 p-4 border-b border-border">
          <span className="text-2xl">{agentEmoji(name)}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-foreground truncate">{name}</h2>
            <p className="text-xs text-muted-foreground">Recent runs &amp; errors</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg px-2" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="flex gap-1 p-2 border-b border-border">
          {(["all", "errors"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              {t === "all" ? "All runs" : `Errors${errorCount ? ` (${errorCount})` : ""}`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {runs === null ? (
            <p className="text-sm text-muted-foreground p-4 animate-pulse">Loading runs…</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 p-4 italic">
              {tab === "errors" ? "No errors 🎉" : "No runs recorded yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {shown.map((r, i) => (
                <li
                  key={r.run_id ?? i}
                  className={`rounded-lg border p-2.5 ${
                    r.status === "error"
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-border bg-secondary/20"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        r.status === "error"
                          ? "bg-destructive"
                          : r.status === "completed"
                            ? "bg-success/70"
                            : r.status === "running"
                              ? "bg-amber-500 obs-led"
                              : "bg-muted-foreground/50"
                      }`}
                    />
                    <span className="text-xs font-medium text-foreground">{r.status ?? "?"}</span>
                    {r.model && (
                      <span className="font-mono text-[11px] text-muted-foreground/70 truncate">{shortModel(r.model)}</span>
                    )}
                    <span className="flex-1" />
                    {r.duration_ms != null && (
                      <span className="text-[10px] font-mono text-muted-foreground">{fmtDuration(r.duration_ms)}</span>
                    )}
                  </div>
                  {r.error_message && (
                    <div className="mt-1 text-[11px] font-mono text-destructive/90 line-clamp-3 break-words">
                      {r.error_type ? `${r.error_type}: ` : ""}
                      {r.error_message}
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/60">
                    {r.source && (
                      <span className={`rounded px-1 py-0.5 border ${sourceClass(r.source)}`}>{r.source}</span>
                    )}
                    {r.total_tokens != null && <span>{fmtTokens(r.total_tokens)}t</span>}
                    <span className="flex-1" />
                    <span>{relativeTime(r.started_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

type Tab = "office" | "feed" | "cost";

export default function ObservabilityPage() {
  const [tab, setTab] = useState<Tab>("office");
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [roster, setRoster] = useState<AgentRow[]>([]);
  const [cost, setCost] = useState<CostData | null>(null);
  const [models, setModels] = useState<Record<string, ModelBlade>>({});
  const [hotAgents, setHotAgents] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const seen = useRef<Set<string>>(new Set());

  const pushEvents = useCallback((incoming: ActivityEvent[], prepend: boolean) => {
    if (!incoming.length) return;
    setFeed((prev) => {
      const fresh = incoming.filter((e) => {
        const k = e._id ?? `${e.kind}:${e.run_id ?? e.model}:${e.ts}`;
        if (seen.current.has(k)) return false;
        seen.current.add(k);
        return true;
      });
      if (!fresh.length) return prev;
      const next = prepend ? [...fresh.reverse(), ...prev] : [...prev, ...fresh];
      return next.slice(0, MAX_FEED);
    });
    // Side-effects: model blades + hot agents.
    for (const e of incoming) {
      if (e.kind === "model" && e.model) {
        const model = e.model;
        setModels((prev) => {
          const cur = prev[model];
          return {
            ...prev,
            [model]: {
              model,
              tier: e.tier ?? cur?.tier,
              tokens: (cur?.tokens ?? 0) + (e.tokens ?? 0),
              cost: (cur?.cost ?? 0) + (e.cost_usd ?? 0),
              calls: (cur?.calls ?? 0) + 1,
              lastTs: Date.now(),
            },
          };
        });
      }
      if (e.kind === "agent" && e.agent && e.phase === "start") {
        const name = e.agent;
        setHotAgents((prev) => ({ ...prev, [name]: Date.now() }));
      }
    }
  }, []);

  // Backfill
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/observability/activity/recent?limit=100");
        const data = await res.json();
        if (!cancelled && Array.isArray(data.events)) pushEvents([...data.events].reverse(), false);
      } catch {
        /* degrade */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushEvents]);

  // Live tail
  useEffect(() => {
    const es = new EventSource("/api/observability/activity/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as ActivityEvent;
        if (e && e.kind) pushEvents([e], true);
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [pushEvents]);

  // Roster + cost polling
  useEffect(() => {
    let cancelled = false;
    const loadRoster = async () => {
      try {
        const res = await fetch("/api/observability/roster");
        const data = await res.json();
        if (!cancelled && Array.isArray(data.agents)) setRoster(data.agents);
      } catch {
        /* degrade */
      }
    };
    const loadCost = async () => {
      try {
        const res = await fetch("/api/observability/cost?days=14");
        const data = await res.json();
        if (!cancelled && data && Array.isArray(data.days)) setCost(data);
      } catch {
        /* degrade */
      }
    };
    loadRoster();
    loadCost();
    const r = setInterval(loadRoster, 4000);
    const c = setInterval(loadCost, 30_000);
    return () => {
      cancelled = true;
      clearInterval(r);
      clearInterval(c);
    };
  }, []);

  // Prune stale model blades + hot agents; keep timestamps fresh.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setModels((prev) => {
        const next: Record<string, ModelBlade> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.lastTs < MODEL_TTL_MS) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
      setHotAgents((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (now - v < AGENT_HOT_MS) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
      forceTick((n) => n + 1);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  const blades = useMemo(
    () => Object.values(models).sort((a, b) => b.lastTs - a.lastTs),
    [models],
  );
  const hotSet = useMemo(() => new Set(Object.keys(hotAgents)), [hotAgents]);
  const todayCost = cost?.days.length ? cost.days[cost.days.length - 1].cost : 0;
  const workingNow = roster.filter((a) => a.status === "working" || hotSet.has(a.name)).length;

  const TABS: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "office", label: "Office", icon: "🏢" },
    { id: "feed", label: "Live feed", icon: "📡" },
    { id: "cost", label: "Cost", icon: "💰" },
  ];

  return (
    <div className="flex flex-col h-full max-h-full">
      <style>{PIXEL_STYLE}</style>

      {/* Header */}
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Observability</h1>
          <p className="text-xs text-muted-foreground">
            Live view of every agent &amp; model — across chat and all apps.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">🤖 {workingNow} working</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-violet-500">🧠 {blades.length} models</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-emerald-500">💰 {fmtCost(todayCost)} today</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-success/80 obs-led" : "bg-muted-foreground/40"}`} />
            <span className="text-muted-foreground">{connected ? "Live" : "Reconnecting…"}</span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 px-4 py-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
              tab === t.id ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:bg-secondary/50"
            }`}
          >
            <span className="mr-1">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden p-4">
        {tab === "office" && (
          <OfficeView
            roster={roster}
            hotAgents={hotSet}
            blades={blades}
            todayCost={todayCost}
            onOpen={setSelected}
          />
        )}
        {tab === "feed" && (
          <div className="h-full overflow-y-auto">
            <FeedView feed={feed} onOpen={setSelected} />
          </div>
        )}
        {tab === "cost" && (
          <div className="h-full overflow-y-auto">
            <CostView cost={cost} />
          </div>
        )}
      </div>

      {selected && <AgentDrawer key={selected} name={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

"use client";

/**
 * /observability — Live Activity
 *
 * A real-time feed of every agent run and model call across the whole platform
 * — chat AND every app (email, tasks, …). Backed by the global activity bus
 * (cc:activity) via the gateway's /observability API:
 *   • backfill on load  → GET /api/observability/activity/recent
 *   • live tail         → EventSource /api/observability/activity/stream
 *   • "running now"     → GET /api/observability/active (polled)
 *
 * This is the live face of E2 observability; /debug (agent_run) remains the
 * durable, post-hoc trace store for deep debugging.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

const MAX_FEED = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
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

function eventKey(e: ActivityEvent, i: number): string {
  return e._id ?? `${e.kind}:${e.run_id ?? e.model}:${e.ts ?? i}`;
}

// A short, stable colour per source so apps are visually distinguishable.
function sourceClass(source?: string): string {
  switch ((source ?? "").toLowerCase()) {
    case "chat":
      return "bg-primary/10 text-primary border-primary/20";
    case "email":
      return "bg-blue-500/10 text-blue-500 border-blue-500/20";
    case "tasks":
      return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
    default:
      return "bg-secondary/40 text-muted-foreground border-border";
  }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ActivityRow({ e }: { e: ActivityEvent }) {
  const isAgent = e.kind === "agent";
  const isEnd = e.phase === "end";
  const isError = e.status === "error";

  const dotClass = isAgent
    ? isEnd
      ? isError
        ? "bg-destructive"
        : "bg-success/70"
      : "bg-amber-500 animate-pulse"
    : "bg-violet-500";

  const label = isAgent
    ? `${e.agent ?? "agent"}`
    : `${e.model ?? "model"}`;

  const verb = isAgent
    ? isEnd
      ? isError
        ? "failed"
        : "finished"
      : "started"
    : "called";

  return (
    <li className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-secondary/30 transition-colors">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />

      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${
          isAgent
            ? "bg-secondary/40 text-foreground border-border"
            : "bg-violet-500/10 text-violet-500 border-violet-500/20"
        }`}
      >
        {isAgent ? "Agent" : "Model"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm text-foreground truncate">{label}</span>
          <span className="text-xs text-muted-foreground shrink-0">{verb}</span>
          {isAgent && e.model && !isEnd && (
            <span className="font-mono text-[11px] text-muted-foreground/70 truncate">
              · {e.model}
            </span>
          )}
          {!isAgent && e.tier && (
            <span className="text-[11px] text-muted-foreground/70 shrink-0">
              · tier {e.tier}
            </span>
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
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium border ${sourceClass(
            e.source,
          )}`}
        >
          {e.source}
        </span>
      )}

      <div className="shrink-0 text-right w-[72px]">
        {isAgent && isEnd && e.duration_ms != null && (
          <div className="text-[11px] font-mono text-muted-foreground">
            {fmtDuration(e.duration_ms)}
          </div>
        )}
        {!isAgent && e.tokens != null && (
          <div className="text-[11px] font-mono text-muted-foreground">
            {e.tokens.toLocaleString()} tok
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/60">{relativeTime(e.ts)}</div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ObservabilityPage() {
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [active, setActive] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
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
  }, []);

  // Backfill on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/observability/activity/recent?limit=100");
        const data = await res.json();
        if (!cancelled && Array.isArray(data.events)) {
          // recent is chronological; newest should sit on top of the feed.
          pushEvents([...data.events].reverse(), false);
        }
      } catch {
        /* degrade silently */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushEvents]);

  // Live tail via SSE.
  useEffect(() => {
    const es = new EventSource("/api/observability/activity/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as ActivityEvent;
        if (e && e.kind) pushEvents([e], true);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      setConnected(false); // browser auto-reconnects
    };
    return () => es.close();
  }, [pushEvents]);

  // Poll the "running now" panel (authoritative presence snapshot).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/observability/active");
        const data = await res.json();
        if (!cancelled && Array.isArray(data.runs)) setActive(data.runs);
      } catch {
        /* degrade silently */
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Re-render every 15s so relative timestamps stay fresh.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col h-full max-h-full">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Live Activity</h1>
          <p className="text-xs text-muted-foreground">
            Every agent run &amp; model call, across chat and all apps — in real time.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-success/80 animate-pulse" : "bg-muted-foreground/40"
            }`}
          />
          <span className="text-muted-foreground">
            {connected ? "Live" : "Reconnecting…"}
          </span>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Running now */}
        <aside className="w-72 shrink-0 border-r border-border overflow-y-auto p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Running now
            <span className="ml-2 rounded-full bg-secondary/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {active.length}
            </span>
          </h2>
          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">
              Nothing running right now.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {active.map((r, i) => (
                <li
                  key={r.run_id ?? i}
                  className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    <span className="font-mono text-sm text-foreground truncate">
                      {r.agent ?? "agent"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {r.source && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium border ${sourceClass(
                          r.source,
                        )}`}
                      >
                        {r.source}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/70">
                      {relativeTime(r.ts)}
                    </span>
                  </div>
                  {r.user && (
                    <div className="mt-1 text-[11px] text-muted-foreground/60 truncate">
                      {r.user}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Feed */}
        <main className="flex-1 min-w-0 overflow-y-auto p-3">
          {feed.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Waiting for activity…
              </p>
              <p className="text-xs text-muted-foreground/60">
                Start a chat or trigger an app and it&apos;ll show up here instantly.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border/40">
              {feed.map((e, i) => (
                <ActivityRow key={eventKey(e, i)} e={e} />
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}

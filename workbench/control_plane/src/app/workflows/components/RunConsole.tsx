"use client";

/**
 * The run console — streaming per-node events during a test run (RFC §5.1),
 * plus the run-history list. Events arrive over the SSE relay
 * (/api/workflows/runs/[runId]/stream).
 */

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  History,
  Loader2,
  XCircle,
} from "lucide-react";
import { listRuns } from "../lib/api";
import type { RunEvent, RunSummary } from "../lib/types";

const STATUS_ICON = (status?: string) => {
  if (status === "running")
    return <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />;
  if (status === "ok" || status === "succeeded")
    return <CheckCircle2 className="w-3.5 h-3.5 text-success" />;
  if (status === "error" || status === "failed")
    return <XCircle className="w-3.5 h-3.5 text-destructive" />;
  return <Circle className="w-3 h-3 text-muted-foreground" />;
};

export default function RunConsole({
  workflowId,
  events,
  running,
  collapsed,
  onToggle,
}: {
  workflowId: string;
  events: RunEvent[];
  running: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState<"console" | "history">("console");
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (tab !== "history" || collapsed) return;
    let cancelled = false;
    setHistoryLoading(true);
    listRuns(workflowId)
      .then((rows) => {
        if (!cancelled) setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, collapsed, workflowId, running]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div
      className={`border-t border-border shrink-0 flex flex-col bg-card/50 ${
        collapsed ? "h-9" : "h-48"
      } tech-transition`}
    >
      <div className="flex items-center gap-1 px-3 h-9 shrink-0">
        <button
          onClick={() => setTab("console")}
          className={`text-[11px] px-2 py-1 rounded-md tech-transition ${
            tab === "console"
              ? "bg-secondary text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Run console
        </button>
        <button
          onClick={() => setTab("history")}
          className={`text-[11px] px-2 py-1 rounded-md tech-transition flex items-center gap-1 ${
            tab === "history"
              ? "bg-secondary text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <History className="w-3 h-3" />
          History
        </button>
        {running && (
          <span className="flex items-center gap-1.5 text-[10px] text-primary ml-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            running
          </span>
        )}
        <button
          onClick={onToggle}
          className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
          title={collapsed ? "Expand console" : "Collapse console"}
        >
          {collapsed ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </button>
      </div>

      {!collapsed && tab === "console" && (
        <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-2 font-mono text-[11px] space-y-1">
          {events.length === 0 && (
            <p className="text-muted-foreground">
              Press <span className="text-foreground">Test ▸</span> to run the
              draft with sample trigger data — each node streams its status and
              output here.
            </p>
          )}
          {events.map((ev, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-px shrink-0">{STATUS_ICON(ev.status)}</span>
              {ev.event === "run" ? (
                <span className="text-foreground font-medium">
                  run {ev.status}
                  {ev.error ? ` — ${ev.error}` : ""}
                </span>
              ) : (
                <span className="min-w-0">
                  <span className="text-foreground">{ev.node_id}</span>{" "}
                  <span className="text-muted-foreground">{ev.status}</span>
                  {typeof ev.duration_ms === "number" && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {ev.duration_ms}ms
                    </span>
                  )}
                  {ev.error && (
                    <span className="text-destructive"> — {ev.error}</span>
                  )}
                  {ev.output !== undefined && ev.status === "ok" && (
                    <span className="text-muted-foreground break-all">
                      {" "}
                      → {JSON.stringify(ev.output).slice(0, 400)}
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {!collapsed && tab === "history" && (
        <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-2">
          {historyLoading && (
            <div className="flex justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!historyLoading && history.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No runs yet.</p>
          )}
          {!historyLoading &&
            history.map((run) => (
              <div
                key={run.id}
                className="flex items-center gap-2 py-1 text-[11px] border-b border-border/50 last:border-0"
              >
                {STATUS_ICON(run.status)}
                <span className="text-foreground">{run.trigger_kind}</span>
                <span className="text-muted-foreground">v{run.version}</span>
                <span className="text-muted-foreground truncate">
                  {run.error ?? ""}
                </span>
                <span className="ml-auto text-muted-foreground shrink-0">
                  {run.started_at
                    ? new Date(run.started_at).toLocaleString()
                    : ""}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

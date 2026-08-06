"use client";

/**
 * The run console — streaming per-node events during a test run (RFC §5.1),
 * plus the run-history list. Events arrive over the SSE relay
 * (/api/workflows/runs/[runId]/stream). Clicking a history row drills into
 * that run (spec F9): its recorded node_results replace the console feed and
 * are painted onto the canvas via onPaintRun.
 */

import Button from "@/components/ui/Button";
import Icon from "@/components/Icon";
import { useEffect, useRef, useState } from "react";
import { getRun, listRuns } from "../lib/api";
import type { NodeResult, RunDetail, RunEvent, RunSummary } from "../lib/types";

const STATUS_ICON = (status?: string) => {
  if (status === "running")
    return <Icon name="Loader2" className="w-3.5 h-3.5 text-primary animate-spin" />;
  if (status === "ok" || status === "succeeded")
    return <Icon name="CheckCircle2" className="w-3.5 h-3.5 text-success" />;
  if (status === "error" || status === "failed")
    return <Icon name="XCircle" className="w-3.5 h-3.5 text-destructive" />;
  if (status === "waiting" || status === "paused")
    return <Icon name="PauseCircle" className="w-3.5 h-3.5 text-warning" />;
  return <Icon name="Circle" className="w-3 h-3 text-muted-foreground" />;
};

/** A recorded run's node_results, replayed in console-event shape. */
function eventsFromDetail(detail: RunDetail): RunEvent[] {
  return [
    ...Object.entries(detail.node_results).map(([nodeId, r]) => ({
      event: "node" as const,
      node_id: nodeId,
      status: r.status,
      output: r.output,
      error: r.error,
      duration_ms: r.duration_ms,
    })),
    {
      event: "run" as const,
      status: detail.status,
      error: detail.error ?? undefined,
    },
  ];
}

export default function RunConsole({
  workflowId,
  events,
  running,
  collapsed,
  onToggle,
  onPaintRun,
}: {
  workflowId: string;
  events: RunEvent[];
  running: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onPaintRun?: (results: Record<string, NodeResult> | null) => void;
}) {
  const [tab, setTab] = useState<"console" | "history">("console");
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [inspected, setInspected] = useState<RunDetail | null>(null);
  const [inspectLoading, setInspectLoading] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  /* eslint-disable react-hooks/set-state-in-effect */
  // A new live run takes over the console + canvas — drop the drill-in.
  useEffect(() => {
    if (running) setInspected(null);
  }, [running]);

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

  const inspectRun = (run: RunSummary) => {
    if (running || inspectLoading) return;
    setInspectLoading(run.id);
    getRun(run.id)
      .then((detail) => {
        setInspected(detail);
        setTab("console");
        onPaintRun?.(detail.node_results);
      })
      .catch(() => {
        /* row stays as-is; the run may have been pruned */
      })
      .finally(() => setInspectLoading(null));
  };

  const clearInspection = () => {
    setInspected(null);
    onPaintRun?.(null);
  };

  const shownEvents = inspected ? eventsFromDetail(inspected) : events;

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
          <Icon name="History" className="w-3 h-3" />
          History
        </button>
        {running && (
          <span className="flex items-center gap-1.5 text-[10px] text-primary ml-2">
            <Icon name="Loader2" className="w-3 h-3 animate-spin" />
            running
          </span>
        )}
        <Button variant="ghost" size="icon-xs" radius="keep" layout="" onClick={onToggle} title={collapsed ? "Expand console" : "Collapse console"} className="ml-auto rounded-md">
          {collapsed ? (
            <Icon name="ChevronUp" className="w-4 h-4" />
          ) : (
            <Icon name="ChevronDown" className="w-4 h-4" />
          )}
        </Button>
      </div>

      {!collapsed && tab === "console" && (
        <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-2 font-mono text-[11px] space-y-1">
          {inspected && (
            <div className="flex items-center gap-2 sticky top-0 bg-card/95 py-1 border-b border-border/50 font-sans">
              <Icon name="History" className="w-3 h-3 text-muted-foreground" />
              <span className="text-muted-foreground">
                Recorded run · v{inspected.version} · {inspected.trigger_kind}
                {inspected.started_at
                  ? ` · ${new Date(inspected.started_at).toLocaleString()}`
                  : ""}
              </span>
              <Button variant="ghost" size="none" radius="keep" layout="flex items-center" onClick={clearInspection} className="ml-auto gap-1 text-[10px] px-1.5 py-0.5 rounded-md">
                <Icon name="X" className="w-3 h-3" />
                back to live
              </Button>
            </div>
          )}
          {shownEvents.length === 0 && (
            <p className="text-muted-foreground">
              Press <span className="text-foreground">Test ▸</span> to run the
              draft with sample trigger data — each node streams its status and
              output here. Click a run in{" "}
              <span className="text-foreground">History</span> to replay its
              recorded results onto the canvas.
            </p>
          )}
          {shownEvents.map((ev, i) => (
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
              <Icon name="Loader2" className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!historyLoading && history.length === 0 && (
            <p className="text-[11px] text-muted-foreground">No runs yet.</p>
          )}
          {!historyLoading &&
            history.map((run) => (
              <button
                key={run.id}
                onClick={() => inspectRun(run)}
                disabled={running || inspectLoading !== null}
                title="Inspect this run — paints its node results onto the canvas"
                className="w-full flex items-center gap-2 py-1 text-[11px] border-b border-border/50 last:border-0 text-left hover:bg-secondary/50 tech-transition disabled:opacity-60 rounded-sm px-1 -mx-1"
              >
                {inspectLoading === run.id ? (
                  <Icon name="Loader2" className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                ) : (
                  STATUS_ICON(run.status)
                )}
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
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

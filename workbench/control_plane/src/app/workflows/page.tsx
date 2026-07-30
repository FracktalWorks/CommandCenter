"use client";

/**
 * /workflows — the Workflows app home (spec: workflows_app.md F1, §5).
 * Two tabs: the workflow gallery and the Module Studio (org module library +
 * conversational generator).
 *
 * Data:  list    GET  /api/workflows
 *        create  POST /api/workflows
 *        modules /api/workflows/modules*
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import Tabs from "@/components/Tabs";
import FilterPills from "@/components/FilterPills";
import ModuleStudio from "./components/ModuleStudio";
import { createWorkflow, listWorkflows } from "./lib/api";
import type { WorkflowSummary } from "./lib/types";

const STATUS_BADGE: Record<string, string> = {
  published: "bg-success/10 text-success border-success/20",
  draft: "bg-warning/10 text-warning border-warning/20",
  disabled: "bg-muted text-muted-foreground border-border",
};

const RUN_DOT: Record<string, string> = {
  succeeded: "bg-success",
  failed: "bg-destructive",
  running: "bg-primary animate-pulse",
};

export default function WorkflowsPage() {
  const router = useRouter();
  const [tab, setTab] = useState("workflows");
  const [rows, setRows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);

  // Fetch-on-mount wiring: same pattern (and lint carve-out) as
  // build/apps/page.tsx.
  /* eslint-disable react-hooks/set-state-in-effect */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listWorkflows());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const filtered = useMemo(() => {
    if (filter === "published") return rows.filter((r) => r.status === "published");
    if (filter === "drafts") return rows.filter((r) => r.status === "draft");
    return rows;
  }, [rows, filter]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    try {
      const wf = await createWorkflow("Untitled workflow");
      router.push(`/workflows/${wf.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setCreating(false);
    }
  }, [router]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base sm:text-lg font-bold text-foreground">
            Workflows
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Automate across your agents, tools and integrations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            title="Refresh"
            className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          {tab === "workflows" && (
            <button
              onClick={onCreate}
              disabled={creating}
              className="rounded-lg bg-primary px-3 sm:px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center gap-1.5 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New workflow
            </button>
          )}
        </div>
      </div>

      <Tabs
        tabs={[
          { id: "workflows", label: "Workflows", icon: WorkflowIcon, count: rows.length },
          { id: "modules", label: "Module Studio", icon: Boxes },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      />

      {tab === "modules" ? (
        <ModuleStudio />
      ) : (
        <>
          <FilterPills
            items={[
              { id: "all", label: "All", count: rows.length },
              {
                id: "published",
                label: "Published",
                count: rows.filter((r) => r.status === "published").length,
              },
              {
                id: "drafts",
                label: "Drafts",
                count: rows.filter((r) => r.status === "draft").length,
              },
            ]}
            activeId={filter}
            onChange={setFilter}
          />

          <div className="flex-1 overflow-y-auto">
            <div className="p-4 sm:p-6">
              {loading && (
                <div className="flex flex-col items-center justify-center h-40 gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Loading workflows…</p>
                </div>
              )}
              {error && !loading && (
                <div className="flex flex-col items-center justify-center h-40 gap-3">
                  <p className="text-sm text-destructive">{error}</p>
                  <button
                    onClick={load}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Retry
                  </button>
                </div>
              )}
              {!loading && !error && filtered.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
                  <WorkflowIcon className="w-8 h-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    No workflows yet. Build your first automation — trigger →
                    agents → tools → done.
                  </p>
                  <button
                    onClick={onCreate}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
                  >
                    Create a workflow
                  </button>
                </div>
              )}
              {!loading && !error && filtered.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {filtered.map((wf) => (
                    <button
                      key={wf.id}
                      onClick={() => router.push(`/workflows/${wf.id}`)}
                      className="text-left rounded-xl border border-border bg-card p-4 hover:border-primary/40 tech-transition group"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary/20 to-accent/15 flex items-center justify-center shrink-0">
                          <WorkflowIcon className="w-5 h-5 text-primary" />
                        </div>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_BADGE[wf.status] ?? STATUS_BADGE.draft}`}
                        >
                          {wf.status}
                        </span>
                      </div>
                      <div className="mt-3 font-medium text-sm text-foreground group-hover:text-primary tech-transition truncate">
                        {wf.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2 min-h-[2rem]">
                        {wf.description || "No description"}
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Zap className="w-3 h-3" />
                          {wf.trigger_count ?? 0} trigger
                          {(wf.trigger_count ?? 0) === 1 ? "" : "s"}
                        </span>
                        {wf.last_run_status && (
                          <span className="flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${RUN_DOT[wf.last_run_status] ?? "bg-muted-foreground"}`}
                            />
                            {wf.last_run_status}
                          </span>
                        )}
                        {wf.updated_at && (
                          <span className="flex items-center gap-1 ml-auto">
                            <Clock className="w-3 h-3" />
                            {new Date(wf.updated_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

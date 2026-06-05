"use client";

/**
 * /inbox — HITL queue (WBS 1.5 / L2-17).
 *
 * Surfaces self-mutation events: auto-fix PRs opened by Self_Mutation_Node,
 * failed sandbox attempts, and in-progress mutations. Operators review and
 * merge PRs from GitHub (no auto-merge — max_mutation_attempts = 1).
 */

import { useEffect, useState, useCallback } from "react";
import type { MutationEntry } from "@/app/api/agent/mutations/route";

const STATUS_META: Record<
  MutationEntry["status"],
  { label: string; cls: string }
> = {
  pr_open: { label: "PR open", cls: "border-emerald-700/50 bg-emerald-900/30 text-emerald-300" },
  failed: { label: "Failed", cls: "border-red-700/50 bg-red-900/30 text-red-300" },
  started: { label: "Running", cls: "border-amber-700/50 bg-amber-900/30 text-amber-300" },
};

export default function InboxPage() {
  const [rows, setRows] = useState<MutationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch("/api/agent/mutations")
      .then((r) => r.json())
      .then((data: MutationEntry[]) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Agent Inbox</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Self-mutation PRs and pending reviews. Auto-fix PRs require a human
            merge — the live system never adopts a change autonomously.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          Refresh
        </button>
      </div>

      {loading && rows.length === 0 ? (
        <p className="text-sm text-zinc-600">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-600">
          No mutation events yet. When an agent fails and Self_Mutation_Node
          opens a fix PR, it appears here.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((m, i) => {
            const meta = STATUS_META[m.status];
            return (
              <div
                key={`${m.run_id}-${i}`}
                className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-100">
                        agent-{m.agent}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${meta.cls}`}
                      >
                        {meta.label}
                      </span>
                      {m.error_type && (
                        <span className="text-xs text-zinc-500">
                          {m.error_type}
                        </span>
                      )}
                    </div>
                    {m.branch && (
                      <div className="mt-1 font-mono text-xs text-zinc-500">
                        {m.branch}
                      </div>
                    )}
                    {m.test_summary && (
                      <div className="mt-1 text-xs text-zinc-400">
                        {m.test_summary}
                      </div>
                    )}
                    <div className="mt-1 text-[11px] text-zinc-600">
                      {new Date(m.at).toLocaleString("en-IN")}
                    </div>
                  </div>
                  {m.pr_url && (
                    <a
                      href={m.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-md bg-sky-800/60 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-700/60"
                    >
                      Review PR →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

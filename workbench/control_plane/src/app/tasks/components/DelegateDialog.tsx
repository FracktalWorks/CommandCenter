"use client";

import { useMemo, useState } from "react";
import {
  X,
  Cloud,
  FolderKanban,
  Search,
  Check,
  Loader2,
  UserPlus,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import type { GtdItem, Person } from "../lib/types";
import { initials } from "../lib/utils";

// Delegating a LOCAL task to a teammate can't stay local — the teammate lives
// in the PM tool. This dialog picks the destination (workspace + project) and
// (optionally) re-phrases the ask, then promotes the task to a ClickUp task
// assigned to that person (store.delegateLocalToClickUp → POST /items/{id}/
// delegate). Opened when a LOCAL task's assignee is set to someone.
export function DelegateDialog({
  item,
  assignee,
  onClose,
}: {
  item: GtdItem;
  assignee: Person;
  onClose: () => void;
}) {
  const accounts = useTaskStore((s) => s.accounts);
  const projects = useTaskStore((s) => s.projects);
  const delegate = useTaskStore((s) => s.delegateLocalToClickUp);

  const [accountId, setAccountId] = useState<string>(
    accounts[0]?.id ?? "",
  );
  const [projectId, setProjectId] = useState<string>("");
  const [nextAction, setNextAction] = useState<string>(
    item.nextAction || item.title,
  );
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId);
  const projectsForAccount = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.status === "ACTIVE" &&
          p.source === "SYNCED" &&
          p.accountId === accountId &&
          (!q.trim() || p.outcome.toLowerCase().includes(q.trim().toLowerCase())),
      ),
    [projects, accountId, q],
  );

  const canSubmit = !!accountId && !!projectId && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await delegate(item.id, {
        assignee,
        accountId,
        projectId,
        nextAction: nextAction.trim() || undefined,
        status: account?.statuses?.[0],
      });
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't delegate — try again.",
      );
      setBusy(false);
    }
  };

  return (
    <div
      className="chat-fade-in fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border-t border-border bg-card shadow-2xl sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <UserPlus className="h-4 w-4 text-primary" />
            Delegate to {assignee.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Cloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
            <span>
              A delegated task lives in the PM tool so {assignee.name.split(" ")[0]}{" "}
              can see it. Pick where it should go.
            </span>
          </p>

          {accounts.length === 0 ? (
            <p className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
              Connect a workspace first to delegate tasks.
            </p>
          ) : (
            <>
              {/* Workspace */}
              {accounts.length > 1 && (
                <div className="mb-3">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Workspace
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {accounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => {
                          setAccountId(a.id);
                          setProjectId("");
                        }}
                        className={[
                          "tech-transition inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                          accountId === a.id
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-secondary",
                        ].join(" ")}
                      >
                        <Cloud className="h-3.5 w-3.5" />
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Project */}
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Project
              </p>
              {projects.filter((p) => p.accountId === accountId).length > 5 && (
                <div className="relative mb-1.5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search projects…"
                    className="w-full rounded-md border border-border bg-background/60 py-1.5 pl-8 pr-3 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-[13px]"
                  />
                </div>
              )}
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
                {projectsForAccount.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">
                    No matching projects in this workspace.
                  </p>
                ) : (
                  projectsForAccount.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProjectId(p.id)}
                      className={[
                        "tech-transition flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px]",
                        projectId === p.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-foreground hover:bg-secondary",
                      ].join(" ")}
                    >
                      <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{p.outcome}</span>
                      {projectId === p.id && (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* The delegated ask */}
              <div className="mt-3">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  The ask
                </p>
                <input
                  value={nextAction}
                  onChange={(e) => setNextAction(e.target.value)}
                  placeholder="What you need them to do…"
                  className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
                />
              </div>

              {error && (
                <p className="mt-2 text-[11px] text-destructive">{error}</p>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="tech-transition rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary-foreground/20 text-[8px] font-bold">
                {initials(assignee.name)}
              </span>
            )}
            Delegate &amp; create in ClickUp
          </button>
        </div>
      </div>
    </div>
  );
}

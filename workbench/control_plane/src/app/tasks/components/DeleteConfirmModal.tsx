"use client";

import { useEffect } from "react";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";

/**
 * "Are you sure?" confirmation for deletes with real consequences.
 *
 * Store-driven: any delete site calls `requestDelete(ids)`, which opens this
 * dialog for ClickUp-synced or already-clarified tasks (fresh inbox captures
 * skip it). Confirming runs the soft-delete + undo flow; for a synced task the
 * copy warns that the ClickUp task will be deleted too (once the undo window
 * passes).
 */
export function DeleteConfirmModal() {
  const pendingDeleteIds = useTaskStore((s) => s.pendingDeleteIds);
  const items = useTaskStore((s) => s.items);
  const confirmPendingDelete = useTaskStore((s) => s.confirmPendingDelete);
  const cancelPendingDelete = useTaskStore((s) => s.cancelPendingDelete);

  useEffect(() => {
    if (!pendingDeleteIds) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPendingDelete();
      if (e.key === "Enter") confirmPendingDelete();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingDeleteIds, cancelPendingDelete, confirmPendingDelete]);

  if (!pendingDeleteIds?.length) return null;

  const targets = pendingDeleteIds
    .map((id) => items.find((i) => i.id === id))
    .filter((t): t is NonNullable<typeof t> => !!t);
  const count = targets.length;
  const syncedCount = targets.filter((t) => t.source !== "LOCAL").length;
  const onlyTitle = count === 1 ? targets[0]?.title : null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/40"
      onClick={cancelPendingDelete}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 px-4 py-4">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              {count === 1 ? "Delete this task?" : `Delete ${count} tasks?`}
            </h2>
            {onlyTitle && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                &ldquo;{onlyTitle}&rdquo;
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              You&rsquo;ll be able to undo this for a few seconds.
            </p>
            {syncedCount > 0 && (
              <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-500">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {syncedCount === count && count === 1
                    ? "This is a ClickUp task — it will be deleted in ClickUp too."
                    : `${syncedCount} of these ${syncedCount === 1 ? "is a ClickUp task" : "are ClickUp tasks"} — they'll be deleted in ClickUp too.`}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={cancelPendingDelete}
            aria-label="Cancel"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={cancelPendingDelete}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={confirmPendingDelete}
            autoFocus
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

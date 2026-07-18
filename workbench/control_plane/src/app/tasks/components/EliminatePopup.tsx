"use client";

import { Trash2, X, Archive, MoonStar } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";

// The "Eliminate" popup — opened from the Eliminate pill or a context menu (via
// store.openEliminate(id)). The matrix reads the task as better dropped than
// done; this offers the two honest ways to let it go: park it in Someday/Maybe
// (reversible, no guilt) or delete it (which routes through the EXISTING
// confirm — requestDelete → DeleteConfirmModal). Global, mounted in page.tsx.
export function EliminatePopup() {
  const eliminateItemId = useTaskStore((s) => s.eliminateItemId);
  const items = useTaskStore((s) => s.items);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const requestDelete = useTaskStore((s) => s.requestDelete);
  const closeEliminate = useTaskStore((s) => s.closeEliminate);

  const item = eliminateItemId
    ? items.find((i) => i.id === eliminateItemId)
    : undefined;
  if (!item) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4"
      onClick={closeEliminate}
    >
      <div
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              Let this go?
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {item.title}
            </p>
          </div>
          <button
            type="button"
            onClick={closeEliminate}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => {
              quickDispose(item.id, "SOMEDAY");
              closeEliminate();
            }}
            className="tech-transition flex items-start gap-2.5 rounded-lg border border-border bg-background/60 p-3 text-left hover:border-primary/50 active:bg-primary/5"
          >
            <MoonStar className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">
                Move to Someday / Maybe
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Park it out of your next actions — you can pull it back anytime.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              // Route through the existing confirm flow (DeleteConfirmModal).
              closeEliminate();
              requestDelete([item.id]);
            }}
            className="tech-transition flex items-start gap-2.5 rounded-lg border border-border bg-background/60 p-3 text-left hover:border-destructive/50 hover:bg-destructive/5"
          >
            <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">
                Delete
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Remove it for good{" "}
                {item.source === "SYNCED" ? "(archives it upstream)" : ""} — with a
                confirmation.
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

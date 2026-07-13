"use client";

import { useEffect } from "react";
import { Undo2, X } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";

/**
 * The global one-level undo toast for the task manager.
 *
 * Mounted once at the page level so it appears in EVERY view (Inbox, Next,
 * Done, …) — previously it lived inside InboxView and so was invisible when a
 * delete/archive happened from a task view. It owns the auto-dismiss timer:
 * when the window closes without an Undo, `dismissUndo` finalizes any pending
 * soft delete (purge + ClickUp propagation).
 */
export function UndoToast() {
  const undoSnapshot = useTaskStore((s) => s.undoSnapshot);
  const undoLastChange = useTaskStore((s) => s.undoLastChange);
  const dismissUndo = useTaskStore((s) => s.dismissUndo);

  // Auto-dismiss after a few seconds (async → effect-safe). Dismiss also
  // finalizes a pending soft delete, so this is the point deletion becomes
  // permanent / propagates upstream.
  useEffect(() => {
    if (!undoSnapshot) return;
    const t = setTimeout(() => dismissUndo(), 7000);
    return () => clearTimeout(t);
  }, [undoSnapshot, dismissUndo]);

  // Keyboard: `u` undoes, as long as the user isn't typing in a field.
  useEffect(() => {
    if (!undoSnapshot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      if (e.key === "u" || e.key === "U") {
        e.preventDefault();
        undoLastChange();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoSnapshot, undoLastChange]);

  if (!undoSnapshot) return null;

  return (
    <div className="chat-fade-in fixed bottom-20 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-popover px-4 py-2 shadow-2xl sm:bottom-6">
      <span className="whitespace-nowrap text-[13px] text-foreground">
        {undoSnapshot.label}
      </span>
      <button
        type="button"
        onClick={undoLastChange}
        className="tech-transition inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold text-primary hover:underline"
      >
        <Undo2 className="h-3.5 w-3.5" />
        Undo
        <kbd className="ml-0.5 hidden rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline">
          u
        </kbd>
      </button>
      <button
        type="button"
        onClick={dismissUndo}
        aria-label="Dismiss"
        className="tech-transition rounded-md p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

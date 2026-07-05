"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { TaskDetail } from "./ItemDetail";

// Full-page task view — a ClickUp/Linear-style focused overlay over the same
// editable TaskDetail. Opened via the expand button in the side-panel detail
// (or wherever openFocus is called). Escape / backdrop / × closes it.
export function TaskFocusModal() {
  const focusedItemId = useTaskStore((s) => s.focusedItemId);
  const items = useTaskStore((s) => s.items);
  const backend = useTaskStore((s) => s.backend);
  const pushItem = useTaskStore((s) => s.pushItem);
  const closeFocus = useTaskStore((s) => s.closeFocus);

  const item = focusedItemId
    ? items.find((i) => i.id === focusedItemId)
    : undefined;

  useEffect(() => {
    if (!focusedItemId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedItemId, closeFocus]);

  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-background/70 p-3 backdrop-blur-sm sm:p-8">
      {/* backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={closeFocus}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <button
          type="button"
          onClick={closeFocus}
          aria-label="Close"
          className="tech-transition absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskDetail
            key={item.id}
            item={item}
            backend={backend}
            pushItem={pushItem}
            focused
          />
        </div>
      </div>
    </div>
  );
}

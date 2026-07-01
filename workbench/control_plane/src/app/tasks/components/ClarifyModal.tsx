"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { ClarifyPanel } from "./ClarifyPanel";

// Focused overlay for processing an inbox item. Bound to the store's selected
// item: store.clarify advances the selection to the next inbox item, so the
// modal walks the inbox automatically and closes when it hits zero.
//
// Premium touch: single-key shortcuts blitz through the obvious items without
// touching the mouse — t trash · s someday · r reference · 2 do-now — each
// files the current item and jumps to the next. (Disabled while typing in a
// field so the next-action input still works.)
export function ClarifyModal() {
  const open = useTaskStore((s) => s.clarifyModalOpen);
  const close = useTaskStore((s) => s.closeClarify);
  const clarify = useTaskStore((s) => s.clarify);
  const selectedItemId = useTaskStore((s) => s.selectedItemId);
  const items = useTaskStore((s) => s.items);

  const item = selectedItemId
    ? items.find((i) => i.id === selectedItemId)
    : undefined;
  const inboxLeft = items.filter((i) => i.disposition === "INBOX").length;
  const active = open && !!item && item.disposition === "INBOX";

  // Close once there's nothing left to clarify.
  useEffect(() => {
    if (open && (!item || item.disposition !== "INBOX")) close();
  }, [open, item, close]);

  // Keyboard: Escape closes; t/s/r/2 file the current item and advance.
  useEffect(() => {
    if (!active || !item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "t":
          e.preventDefault();
          clarify(item.id, { kind: "trash" });
          break;
        case "s":
          e.preventDefault();
          clarify(item.id, { kind: "someday" });
          break;
        case "r":
          e.preventDefault();
          clarify(item.id, { kind: "reference" });
          break;
        case "2":
          e.preventDefault();
          clarify(item.id, { kind: "do-now" });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, item, clarify, close]);

  if (!active || !item) return null;

  return (
    <div
      className="chat-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[8vh]"
      onClick={close}
    >
      <div
        className="flex max-h-[84vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Processing inbox · {inboxLeft} left
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* keyed by id → the wizard resets as the modal advances to the next item */}
          <ClarifyPanel key={item.id} item={item} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">Shortcuts</span>
          <Kbd>t</Kbd> trash
          <Kbd>s</Kbd> someday
          <Kbd>r</Kbd> reference
          <Kbd>2</Kbd> do now
          <Kbd>esc</Kbd> close
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-foreground">
      {children}
    </kbd>
  );
}

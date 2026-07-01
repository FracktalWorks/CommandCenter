"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { ClarifyPanel } from "./ClarifyPanel";

// Focused overlay for processing an inbox item. Bound to the store's selected
// item: store.clarify advances the selection to the next inbox item, so the
// modal walks the inbox automatically and closes when it hits zero.
export function ClarifyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const selectedItemId = useTaskStore((s) => s.selectedItemId);
  const items = useTaskStore((s) => s.items);

  const item = selectedItemId
    ? items.find((i) => i.id === selectedItemId)
    : undefined;
  const inboxLeft = items.filter((i) => i.disposition === "INBOX").length;
  const active = open && !!item && item.disposition === "INBOX";

  // Close once there's nothing left to clarify.
  useEffect(() => {
    if (open && (!item || item.disposition !== "INBOX")) onClose();
  }, [open, item, onClose]);

  // Escape closes.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  if (!active || !item) return null;

  return (
    <div
      className="chat-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[8vh]"
      onClick={onClose}
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
            onClick={onClose}
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
      </div>
    </div>
  );
}

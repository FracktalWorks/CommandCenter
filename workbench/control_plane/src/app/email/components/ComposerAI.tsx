"use client";

import { useState } from "react";
import { Sparkles, MoreHorizontal } from "lucide-react";

/**
 * The quoted trailing email shown in a COMPOSE box — collapsed behind an
 * Outlook-style "•••" toggle and read-only. It lives outside the editable
 * textarea so the user (and the AI drafter) only ever touch the new text; the
 * quote is reattached verbatim on send.
 */
export function ComposerQuote({
  quote,
  className = "px-4 pb-2",
}: {
  quote: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!quote.trim()) return null;
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide quoted message" : "Show quoted message"}
        aria-expanded={open}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs transition-colors ${
          open
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-3">
          <div className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
            {quote}
          </div>
        </div>
      )}
    </div>
  );
}

/** The sparkles toggle that opens the AI draft bar (for a composer footer). */
export function AiButton({
  active,
  onClick,
  title = "Draft with AI",
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`px-2 py-1 text-xs rounded-md transition-colors flex items-center gap-1 ${
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <Sparkles size={13} />
    </button>
  );
}

"use client";

import { useState } from "react";
import { Sparkles, MoreHorizontal, Loader2, X, CornerDownLeft } from "lucide-react";

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

/**
 * The inline AI draft/improve bar. An optional one-line instruction — blank
 * drafts from scratch (or polishes existing text); filled steers it ("make it
 * shorter", "accept the meeting"). `hasText` flips the button label between
 * Draft and Improve so the user knows it works on what they've written.
 */
export function AiAssistBar({
  instruction,
  onInstruction,
  busy,
  hasText,
  onRun,
  onClose,
}: {
  instruction: string;
  onInstruction: (v: string) => void;
  busy: boolean;
  hasText: boolean;
  onRun: () => void;
  onClose: () => void;
}) {
  return (
    <div className="px-4 py-2 border-t border-border bg-primary/5 flex items-center gap-2">
      <Sparkles size={13} className="text-primary flex-shrink-0" />
      <input
        type="text"
        value={instruction}
        autoFocus
        disabled={busy}
        onChange={(e) => onInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!busy) onRun();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
        placeholder={
          hasText
            ? "How should AI improve this? (optional)"
            : "What should this email say? (optional)"
        }
        className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none min-w-0"
      />
      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1 flex-shrink-0"
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <CornerDownLeft size={12} />
        )}
        {hasText ? "Improve" : "Draft"}
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}

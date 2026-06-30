"use client";

import { useState } from "react";
import { X, ChevronDown } from "lucide-react";

/**
 * Shared chrome for an AG-UI tool card: a header row with a collapse toggle, an
 * optional icon + title, and a dismiss (X) control. Used to make chat tool cards
 * tidy-able — collapse the ones you've seen, close the ones you're done with —
 * across both the email assistant and the general chat agent.
 *
 * `onDismiss` is supplied by the caller (so a folded group can dismiss several
 * tool ids at once); omit it to render a non-dismissable shell.
 */
export function ToolCardShell({
  title,
  icon,
  defaultCollapsed = false,
  onDismiss,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  defaultCollapsed?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown
            size={12}
            className={`flex-shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          {icon}
          <span className="truncate">{title}</span>
        </button>
        {onDismiss && (
          <button
            onClick={onDismiss}
            title="Dismiss"
            aria-label="Dismiss"
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {!collapsed && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

/**
 * Thin wrapper that overlays a dismiss (X) on a card that brings its own chrome
 * (draft card, rule card, …), so it becomes closable without altering the card's
 * internals. The X stays visible (faint by default, solid on hover) — a
 * hover-only control read as "no close button" on these cards.
 */
export function DismissableCard({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative group/dismiss">
      <button
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded text-muted-foreground bg-card/80 opacity-60 hover:opacity-100 hover:text-foreground hover:bg-secondary transition-opacity"
      >
        <X size={12} />
      </button>
      {children}
    </div>
  );
}

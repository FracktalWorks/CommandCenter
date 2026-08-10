"use client";

/**
 * The empty state — one shape for every list surface (S4).
 *
 * A surface with nothing on it has to answer one question: *is this empty, or
 * did I hide it?* `/tasks` answers it with two distinct states — `NoMatchState`
 * ("No tasks match your filters", plus the way out) and `EmptyState` (an icon
 * and copy for the view). `/projects` answered it with one string that asked
 * the reader to guess: *"Nothing to show. Clear a filter, or this project has
 * no statuses yet."* Convergence runs both ways, and here Tasks was right.
 *
 * So this is the box, promoted so both apps can draw one. WHICH of the two
 * states a surface is in, and what each says, stays the app's own business —
 * `/projects` decides it in `app/projects/lib/emptyState.ts`, where the copy is
 * unit-tested rather than eyeballed.
 *
 * **The action is the whole point of the filtered variant.** A dead end that
 * says "nothing matches" and offers no way back reads as a broken screen; the
 * one control that undoes the cause belongs in the state that names it.
 *
 * ⚠️ `/tasks`' own `NoMatchState`/`EmptyState` are NOT yet retired onto this —
 * that edit lands in `app/tasks/components/ItemList.tsx`, which another slice
 * holds open. Until it does, this is a shared home with one consumer.
 */

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";

export interface EmptyStateAction {
  label: string;
  /** Lucide name; the active theme picks the pack. */
  icon?: string;
  onClick: () => void;
}

export function EmptyState({
  icon,
  message,
  hint,
  action,
  /**
   * `success` is the celebratory tick /tasks draws on "Inbox zero. Mind like
   * water." — an empty inbox is an achievement, an empty board is not. Kept as
   * a named tone rather than a class so the caller never writes a colour.
   */
  tone = "muted",
  className = "",
}: {
  /** Lucide name for the glyph above the copy. */
  icon: string;
  message: string;
  /** One line of what to do about it. Omitted when there is nothing to say. */
  hint?: string;
  action?: EmptyStateAction;
  tone?: "muted" | "success";
  className?: string;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center ${className}`}
    >
      <Icon
        name={icon}
        className={`h-8 w-8 ${tone === "success" ? "text-success/70" : "text-muted-foreground/60"}`}
        aria-hidden
      />
      <p className="text-sm text-muted-foreground">{message}</p>
      {hint ? (
        <p className="max-w-xs text-xs text-muted-foreground/80">{hint}</p>
      ) : null}
      {action ? (
        <Button
          variant="secondary"
          size="sm"
          icon={action.icon}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

"use client";

/**
 * The task card's box — one shell for /projects and /tasks (WS-27ad).
 *
 * WS-27s made the two apps agree about the chip ROW inside a card
 * (`lib/taskCard.ts` + `TaskMeta`). The box around it still disagreed:
 * /tasks drew `rounded-lg border bg-card p-3 shadow-sm` and /projects
 * `rounded-md border bg-background p-2`, with different title sizes, different
 * hover and different selected states. Two objects, one concept.
 *
 * /tasks' box wins, and the reason is not seniority: `bg-card` is the token
 * that means "a raised surface" (a board column is already `bg-secondary/30`
 * and `bg-background` is the page under it, so a /projects card was a card-
 * shaped hole rather than a card), and the shadow lift is what makes a
 * draggable object read as pick-up-able before anybody drags it.
 *
 * WHAT goes inside stays each app's business — /projects feeds it
 * `lib/card.ts` facts and honours its own `shown_fields`, /tasks feeds it GTD
 * badges. Only the shell and its visual grammar are shared.
 */

import type React from "react";

export function TaskCardShell({
  children,
  selected = false,
  atCursor = false,
  draggable = false,
  completed = false,
  className = "",
  innerRef,
  onActivate,
  onContextMenu,
  onDragStart,
  onDragEnd,
  ariaLabel,
}: {
  children: React.ReactNode;
  /** Multi-selected — a primary border plus a ring, so it reads at a glance. */
  selected?: boolean;
  /** The keyboard cursor stands here (`lib/cursor.ts`). */
  atCursor?: boolean;
  draggable?: boolean;
  /** Drawn quieter: a finished task is context, not work. */
  completed?: boolean;
  className?: string;
  innerRef?: (element: HTMLDivElement | null) => void;
  onActivate?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: (event: React.DragEvent) => void;
  ariaLabel?: string;
}) {
  return (
    // A div with role=button rather than a real <button>: both apps put their
    // own buttons and checkboxes inside a card, and nested interactive elements
    // in a <button> are invalid HTML that browsers resolve by swallowing the
    // inner click. Enter/Space are wired below so it stays keyboard-usable.
    <div
      ref={innerRef}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onActivate}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate?.();
        }
      }}
      className={[
        "group tech-transition relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left shadow-sm hover:shadow-md",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-primary/40",
        // The cursor ring is drawn OUTSIDE the selection ring deliberately: a
        // card can be both, and one overwriting the other is how "where am I"
        // and "what did I pick" become the same signal.
        atCursor ? "ring-2 ring-ring" : "",
        completed ? "opacity-70" : "",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * The card's title line.
 *
 * Shared because the size and weight are the loudest single difference between
 * the two cards: /projects drew a plain `text-sm`, /tasks a `text-[13px]
 * font-medium leading-snug`, and side by side that alone made them look like
 * different products.
 */
export function TaskCardTitle({
  children,
  completed = false,
  className = "",
}: {
  children: React.ReactNode;
  completed?: boolean;
  className?: string;
}) {
  return (
    <p
      className={[
        "min-w-0 text-[13px] font-medium leading-snug text-foreground",
        completed ? "line-through opacity-60" : "",
        className,
      ].join(" ")}
    >
      {children}
    </p>
  );
}

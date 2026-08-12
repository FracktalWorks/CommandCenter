"use client";

/**
 * Skeleton — the themed loading placeholder (WS-27bh · spec §9.4.2 item 5).
 *
 *     <Skeleton className="h-4 w-32" />
 *     <SkeletonText rows={3} />
 *     <SkeletonRows rows={6} height="h-12" />
 *
 * Replaces the improvised `animate-pulse` div, of which the tree carries 26.
 * Those are not wrong so much as unowned: each picks its own colour, its own
 * radius and its own row widths, so two loading states next to each other look
 * like two products.
 *
 * The arithmetic lives in `src/lib/skeleton.ts` and is unit-tested. What is
 * here is markup and one rule a `.ts` module cannot express:
 *
 * **`motion-safe:` is the whole reduced-motion story.** Tailwind compiles it to
 * `@media (prefers-reduced-motion: no-preference)`, so a reader who has asked
 * their OS to stop animations gets a still block rather than a pulsing one — and
 * they get it without JavaScript, without a hook, and before hydration. A
 * pulsing skeleton is exactly the animation that triggers people, and we already
 * hold this rule tree-wide where the upstream reference does not (§9.4's "where
 * we are AHEAD").
 */

import { rowWidths } from "@/lib/skeleton";

export type SkeletonProps = {
  /** Layout only — never colour or radius; those are the theme's. */
  className?: string;
};

/**
 * One placeholder block. Sized entirely by the caller, because a skeleton whose
 * height differs from the row it replaces causes a layout jump on arrival —
 * which is worse than a spinner (§9.4.2 item 5.4).
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`motion-safe:animate-pulse rounded bg-muted ${className}`}
    />
  );
}

export type SkeletonTextProps = {
  rows?: number;
  className?: string;
};

/**
 * A paragraph-shaped placeholder: irregular widths, short last line.
 *
 * Widths come from `rowWidths`, which hashes the row index — never
 * `Math.random()`, which re-rolls on every render and makes the placeholder
 * visibly change shape under the reader (§9.4.4 refuses it by name).
 */
export function SkeletonText({ rows = 3, className = "" }: SkeletonTextProps) {
  const widths = rowWidths(rows);
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {widths.map((width, i) => (
        <div
          key={i}
          style={{ width }}
          className="motion-safe:animate-pulse h-3 rounded bg-muted"
        />
      ))}
    </div>
  );
}

export type SkeletonRowsProps = {
  rows?: number;
  /** Tailwind height utility matching the real row — `h-12`, `h-16`, … */
  height?: string;
  className?: string;
};

/** A list/table-shaped placeholder: equal blocks, one per row. */
export function SkeletonRows({
  rows = 5,
  height = "h-12",
  className = "",
}: SkeletonRowsProps) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        <div key={i} className={`motion-safe:animate-pulse ${height} rounded-lg bg-muted`} />
      ))}
    </div>
  );
}

export default Skeleton;

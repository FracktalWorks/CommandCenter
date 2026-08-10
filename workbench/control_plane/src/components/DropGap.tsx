"use client";

/**
 * The drop target between two cards — shared by /projects and /tasks (WS-27ad).
 *
 * The visual half of the drop-gap reorder /tasks had and /projects did not (see
 * `@/lib/boardDrop` for the arithmetic and the reason it won). A thin strip
 * that grows while a drag is in flight, because an empty or short column is
 * otherwise a 2px target somebody has to aim at.
 *
 * `stopPropagation` on both handlers is load-bearing: the gap sits inside a
 * column that is itself a drop target, and without it the column's own handler
 * fires too and appends the card — turning every precise drop back into the
 * append this component exists to replace.
 */

export function DropGap({
  active,
  dragging = false,
  onOver,
  onDrop,
  className = "",
}: {
  /** This is the gap the card would land in. */
  active: boolean;
  /** A drag is in flight — grow, so short and empty groups stay hittable. */
  dragging?: boolean;
  onOver: () => void;
  onDrop: () => void;
  className?: string;
}) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop();
      }}
      className={[
        "-my-0.5 rounded transition-all",
        dragging ? "h-3" : "h-1.5",
        active ? "bg-primary/50" : "bg-transparent",
        className,
      ].join(" ")}
    />
  );
}

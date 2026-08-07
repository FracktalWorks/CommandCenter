"use client";

/**
 * The chip row and avatar stack a task card draws (WS-27s).
 *
 * The one place a `MetaTone` becomes a colour. `lib/taskCard.ts` decides WHICH
 * chips a task earns and what each one means; this decides what that looks
 * like, in tokens, so `DESIGN_SYSTEM.md`'s "never write a colour" rule has
 * exactly one file to hold rather than one per surface.
 *
 * Prop-driven and store-free on purpose: `/tasks` reads a Zustand store and
 * `/projects` reads a REST list, and a shared component that knew about either
 * would be shared in name only.
 */

import Icon from "@/components/Icon";
import { type MetaChip, type MetaTone, avatarStack, initials } from "@/lib/taskCard";

const TONE: Record<MetaTone, string> = {
  muted: "text-muted-foreground",
  // Weight as well as colour: the chip already carries a different icon, and
  // three signals is what makes "this is late" survive a colour-blind reader
  // and a low-contrast monitor.
  danger: "font-medium text-destructive",
  accent: "text-primary",
};

/** The wrapping row of chips. Renders nothing at all when there are none. */
export function TaskMeta({
  chips,
  className = "",
}: {
  chips: MetaChip[];
  className?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <span className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.title}
          className={`inline-flex items-center gap-1 text-[10px] ${TONE[chip.tone]}`}
        >
          <Icon name={chip.icon} className="h-3 w-3" aria-hidden />
          {chip.label}
        </span>
      ))}
    </span>
  );
}

/**
 * Overlapping initials, with a "+N" for whoever did not fit.
 *
 * The full list rides in `title` rather than being dropped: a shared task is
 * the case where knowing the fourth name actually matters, and hovering is
 * cheaper than opening the task to find out.
 */
export function AvatarStack({
  people,
  max = 3,
  label = (who) => who,
  className = "",
}: {
  people?: readonly string[] | null;
  max?: number;
  /**
   * How an identifier reads to a human. Projects hands over email addresses
   * and `agent:` handles; Tasks hands over display names, for which the
   * default identity is already right.
   */
  label?: (who: string) => string;
  className?: string;
}) {
  const { shown, extra } = avatarStack(people, max);
  if (shown.length === 0 && extra === 0) return null;
  return (
    <span
      className={`inline-flex items-center ${className}`}
      title={(people ?? []).join(", ")}
    >
      {shown.map((person) => (
        <span
          key={person}
          className="-ml-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary ring-1 ring-card first:ml-0"
        >
          {initials(label(person))}
        </span>
      ))}
      {extra > 0 ? (
        <span className="-ml-1 flex h-4 items-center justify-center rounded-full bg-secondary px-1 text-[8px] font-bold text-muted-foreground ring-1 ring-card">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

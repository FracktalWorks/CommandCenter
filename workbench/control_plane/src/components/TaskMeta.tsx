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
import { accentForHue } from "@/lib/statusAccent";
import { type MetaChip, type MetaTone, avatarStack, initials } from "@/lib/taskCard";

const TONE: Record<MetaTone, string> = {
  muted: "text-muted-foreground",
  // Weight as well as colour: the chip already carries a different icon, and
  // three signals is what makes "this is late" survive a colour-blind reader
  // and a low-contrast monitor.
  danger: "font-medium text-destructive",
  accent: "text-primary",
  // The step below `danger`. No extra weight — "High" and "Urgent" must not
  // both shout, or neither does.
  warning: "text-warning",
};

/**
 * The wrapping row of chips. Renders nothing at all when there are none.
 *
 * **Two shapes, one row.** A chip with a `hue` is an identity — a tag — and
 * draws as a filled pill in the hue the registry stored, byte-identical to the
 * chip the tag picker and the tag manager draw (`accentForHue(hue).chip` IS
 * `tags.chipClass(color)`). A chip without one is a measurement and stays
 * tinted text. Mixing the two is the /tasks card's existing grammar (a context
 * pill beside plain meta), not a new one.
 */
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
          className={
            chip.hue
              ? // `max-w-[12ch]` is a SIZE, not a colour — rule 3 forbids
                // arbitrary colour classes, and a tag named after a customer
                // would otherwise push the whole row off a 288px card.
                `inline-flex max-w-[12ch] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] ${
                  accentForHue(chip.hue).chip
                }`
              : `inline-flex items-center gap-1 text-[10px] ${TONE[chip.tone]}`
          }
        >
          {chip.icon ? (
            <Icon name={chip.icon} className="h-3 w-3 shrink-0" aria-hidden />
          ) : null}
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

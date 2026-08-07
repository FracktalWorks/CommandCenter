/**
 * The task card's vocabulary — shared by /tasks and /projects (WS-27s).
 *
 * Two apps in this workspace draw a task. `/tasks` is the GTD surface over
 * `gtd_items`; `/projects` is the project-management surface over `pm_tasks`.
 * They are different stores with different rules, and D-PM-6 has `/tasks`
 * retiring onto `pm_tasks` at WS-27h — so a member will use both, sometimes on
 * the same day, and a task should not look like a different KIND of thing
 * depending on which tab it is in.
 *
 * **What is shared is the vocabulary, not the component.** Porting
 * `/tasks`'s `TaskCard` wholesale was the obvious move and the wrong one: it is
 * bound to `useTaskStore` and to `GtdItem`'s fields — `energy`, `deepWork`,
 * `disposition` — none of which `pm_tasks` has or should grow. It would also
 * die with `gtd_items` at WS-27h, taking the Projects board with it. So what
 * moves here is the part that is genuinely the same on both sides: how a
 * duration reads, what counts as overdue, and which chips a task earns.
 *
 * `taskMeta` returns DESCRIPTORS, not JSX. Two reasons, and the second is the
 * one that matters:
 *
 * 1. it is testable without a DOM, so the rules below are pinned by assertions
 *    rather than by looking at a screenshot;
 * 2. the tone is a NAME (`"danger"`), not a class. `DESIGN_SYSTEM.md` forbids
 *    writing a colour, and a descriptor that carried `text-destructive` would
 *    quietly move that decision into a file with no theme.
 */

/** Which of the app's semantic tones a chip is painted in. */
export type MetaTone = "muted" | "danger" | "accent";

export interface MetaChip {
  /** Stable React key, and what a test asserts on. */
  key: string;
  /** A Lucide name for `<Icon name=… />`; the active theme picks the pack. */
  icon: string;
  label: string;
  tone: MetaTone;
  /** Long form, for `title=` — a chip reading "2/5" needs to say what of. */
  title: string;
}

/** Everything a card can draw, in terms neither app's row type owns. */
export interface TaskFacts {
  dueAt?: string | null;
  completedAt?: string | null;
  /** WS-27s — filled for every row of the list endpoint. */
  subtasks?: { done: number; total: number } | null;
  blockedByCount?: number | null;
  tagCount?: number | null;
  attachmentCount?: number | null;
  estimateMins?: number | null;
}

/** Relative "time ago" / "in X" label for a due or created date. */
export function relativeTime(iso: string | undefined | null, nowMs = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMin = Math.round((then - nowMs) / 60000);
  const past = diffMin < 0;
  const m = Math.abs(diffMin);
  const fmt = (n: number, unit: string) =>
    past ? `${n}${unit} ago` : `in ${n}${unit}`;
  if (m < 1) return "now";
  if (m < 60) return fmt(m, "m");
  const h = Math.round(m / 60);
  if (h < 24) return fmt(h, "h");
  const d = Math.round(h / 24);
  if (d < 7) return fmt(d, "d");
  const w = Math.round(d / 7);
  if (w < 5) return fmt(w, "w");
  const mo = Math.round(d / 30);
  return fmt(mo, "mo");
}

/** Minutes → "10m" / "1h 30m". */
export function durationLabel(mins?: number | null): string {
  if (!mins) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Initials for an avatar chip.
 *
 * Splits on dots and underscores as well as spaces, because half the people
 * this draws are identified by an email local part rather than a display name:
 * `priya.sharma` is two words wearing a separator, and "P" is a worse avatar
 * than "PS". Hyphens are deliberately NOT separators — "Jean-Luc Picard" is two
 * names, not three.
 */
export function initials(name: string): string {
  return name
    .split(/[\s._]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Past its due date AND still open.
 *
 * The second half is the whole point. A finished task with a last-Tuesday due
 * date is not overdue, and colouring it red forever is how a board teaches
 * people to ignore red — the same rule the `overdue` filter enforces in SQL, so
 * that a card and the filter that selected it cannot disagree.
 */
export function isOverdue(
  dueAt?: string | null,
  completedAt?: string | null,
  nowMs = Date.now(),
): boolean {
  if (!dueAt || completedAt) return false;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return false;
  return due < nowMs;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The chips a task has earned, in reading order.
 *
 * **Order is deliberate and fixed**, because a card is narrow and the tail
 * wraps or truncates: blocked first (it is the one fact that says do not start
 * this), then due (the one that says when), then progress, then the quieter
 * counts. A card whose chip order depends on the data is a card you have to
 * read rather than scan.
 *
 * **A zero earns no chip.** "0 subtasks", "0 tags" and "0 attachments" are the
 * normal state of most tasks; drawing them turns the meta row into noise and
 * pushes the chips that mean something off the edge.
 */
export function taskMeta(facts: TaskFacts, nowMs = Date.now()): MetaChip[] {
  const chips: MetaChip[] = [];

  const blocked = facts.blockedByCount ?? 0;
  if (blocked > 0) {
    chips.push({
      key: "blocked",
      icon: "Ban",
      label: String(blocked),
      tone: "danger",
      title: `Blocked by ${plural(blocked, "unfinished task")}`,
    });
  }

  const due = relativeTime(facts.dueAt, nowMs);
  if (due) {
    const late = isOverdue(facts.dueAt, facts.completedAt, nowMs);
    chips.push({
      key: "due",
      icon: late ? "AlertTriangle" : "Clock",
      label: due,
      tone: late ? "danger" : "muted",
      title: late ? `Overdue — was due ${due}` : `Due ${due}`,
    });
  }

  const subtasks = facts.subtasks;
  if (subtasks && subtasks.total > 0) {
    const complete = subtasks.done >= subtasks.total;
    chips.push({
      key: "subtasks",
      icon: "ListTree",
      label: `${subtasks.done}/${subtasks.total}`,
      // A finished checklist is worth noticing — it usually means the parent
      // is ready to close and nobody has closed it.
      tone: complete ? "accent" : "muted",
      title: `${subtasks.done} of ${plural(subtasks.total, "subtask")} done`,
    });
  }

  const tags = facts.tagCount ?? 0;
  if (tags > 0) {
    chips.push({
      key: "tags",
      icon: "Tag",
      label: String(tags),
      tone: "muted",
      title: plural(tags, "tag"),
    });
  }

  const attachments = facts.attachmentCount ?? 0;
  if (attachments > 0) {
    chips.push({
      key: "attachments",
      icon: "Paperclip",
      label: String(attachments),
      tone: "muted",
      title: plural(attachments, "attachment"),
    });
  }

  const estimate = durationLabel(facts.estimateMins);
  if (estimate) {
    chips.push({
      key: "estimate",
      icon: "Hourglass",
      label: estimate,
      tone: "muted",
      title: `Estimated ${estimate}`,
    });
  }

  return chips;
}

/**
 * The avatars to draw, and how many were left out.
 *
 * Capped rather than wrapped: a task with nine assignees would otherwise push
 * everything else off a 288px column, and the ninth name is not the thing the
 * reader is scanning for. `extra` carries the count so "+6" can say so.
 */
export function avatarStack(
  people: readonly string[] | undefined | null,
  max = 3,
): { shown: string[]; extra: number } {
  const all = people ?? [];
  // `max <= 0` is its own case: `slice(0, 0)` is right but `length - 0` is not
  // — the remainder would be counted from a cap that was never applied, and a
  // caller asking for no avatars would get "+0" instead of "+5".
  if (max <= 0) return { shown: [], extra: all.length };
  return { shown: all.slice(0, max), extra: Math.max(0, all.length - max) };
}

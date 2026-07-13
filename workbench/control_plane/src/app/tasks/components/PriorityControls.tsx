"use client";

import { AlertTriangle, Calendar, Gem, Hand, Trash2, X, Zap } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import {
  CELL_META,
  SUGGESTION_BADGE,
  isUrgent,
  modeSuggestion,
  priorityCell,
  type ActionMode,
  type PriorityCell,
} from "../lib/priority";

// Shared prioritization UI: the 3-flag Weight toggle (Important / Urgent-auto /
// Leveraged) and the single priority badge. Kept together so the visual
// language (which colour, which emoji) is defined once.
//
// One-badge-per-card rule: a card shows AT MOST ONE priority signal, chosen by
// the active lens (the caller decides which to render). PriorityBadge is the
// matrix-cell badge; the delegate/schedule hint and the energy chip live in
// their own views. Never stack them.

/** The Weight toggles. Important + Leveraged are manual (click to flip); Urgent
 *  is DERIVED from the due date and shown read-only (a lit, non-clickable chip
 *  when the task is urgent) so the user sees it without being able to lie about
 *  it. `onChange` fires with the new value of the flipped flag. */
export function WeightToggles({
  item,
  urgentWindowHours,
  onChange,
  size = "md",
}: {
  item: Pick<GtdItem, "important" | "leveraged" | "dueAt">;
  urgentWindowHours?: number;
  onChange: (patch: { important?: boolean; leveraged?: boolean }) => void;
  size?: "sm" | "md";
}) {
  const urgent = isUrgent(item, urgentWindowHours);
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <FlagToggle
        active={!!item.important}
        onClick={() => onChange({ important: !item.important })}
        icon={AlertTriangle}
        label="Important"
        title="Something stalls or breaks if this is skipped (downside)."
        tone="important"
        pad={pad}
      />
      <FlagToggle
        active={!!item.leveraged}
        onClick={() => onChange({ leveraged: !item.leveraged })}
        icon={Gem}
        label="Leveraged"
        title="Rare, asymmetric 100x upside — an investor, a grant, a key hire."
        tone="leveraged"
        pad={pad}
      />
      {/* Urgent is derived — read-only. Only shown when actually urgent. */}
      <span
        title={
          urgent
            ? "Urgent — overdue or due soon (set automatically from the due date)."
            : "Not urgent — set a due date to make it urgent automatically."
        }
        className={[
          "inline-flex items-center gap-1 rounded-full border font-medium",
          pad,
          urgent
            ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
            : "border-dashed border-border text-muted-foreground/50",
        ].join(" ")}
      >
        <Zap className="h-3 w-3" />
        Urgent
        <span className="text-[9px] opacity-60">(auto)</span>
      </span>
    </div>
  );
}

function FlagToggle({
  active,
  onClick,
  icon: Icon,
  label,
  title,
  tone,
  pad,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof AlertTriangle;
  label: string;
  title: string;
  tone: "important" | "leveraged";
  pad: string;
}) {
  const on =
    tone === "important"
      ? "border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={[
        "tech-transition inline-flex items-center gap-1 rounded-full border font-medium",
        pad,
        active
          ? on
          : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40",
      ].join(" ")}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

const CELL_TONE: Record<PriorityCell, string> = {
  "founder-fire": "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  "deep-work": "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "quick-leverage": "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "delegate-important": "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  "schedule-important": "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "delegate-urgent": "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  "leverage-bet": "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  eliminate: "border-border bg-secondary/40 text-muted-foreground",
};

/** The single matrix-cell badge (emoji + label). Render this ONLY in the
 *  Priority view / detail — never alongside the delegate/energy chips. */
export function PriorityBadge({
  item,
  urgentWindowHours,
  showLabel = true,
}: {
  item: Pick<GtdItem, "important" | "leveraged" | "dueAt">;
  urgentWindowHours?: number;
  showLabel?: boolean;
}) {
  const cell = priorityCell(item, urgentWindowHours);
  const meta = CELL_META[cell];
  return (
    <span
      title={meta.label}
      className={[
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        CELL_TONE[cell],
      ].join(" ")}
    >
      <span aria-hidden>{meta.emoji}</span>
      {showLabel && meta.label}
    </span>
  );
}

const SUGGESTION_TONE: Record<Exclude<ActionMode, "do">, string> = {
  delegate: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  schedule: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  drop: "border-border bg-secondary/60 text-muted-foreground",
};

const SUGGESTION_ICON: Record<Exclude<ActionMode, "do">, typeof Hand> = {
  delegate: Hand,
  schedule: Calendar,
  drop: Trash2,
};

/** The competing SUGGESTION badge on a task card. The matrix reads a task as
 *  better delegated / scheduled / eliminated than done by you — so it nudges,
 *  as a small badge that sits alongside the card, NEVER changing the task's
 *  status. Clicking opens the task (where the real delegate/schedule/trash
 *  controls live); the × dismisses the nudge ("keep mine" → keptMine). Renders
 *  nothing for "do" work or a dismissed task. Delegate is not a status. */
export function SuggestionBadge({
  item,
  urgentWindowHours,
  compact = false,
}: {
  item: GtdItem;
  urgentWindowHours?: number;
  compact?: boolean;
}) {
  const updateItem = useTaskStore((s) => s.updateItem);
  const openFocus = useTaskStore((s) => s.openFocus);
  const sug = modeSuggestion(item, urgentWindowHours);
  if (!sug || sug.mode === "do") return null;
  const mode = sug.mode as Exclude<ActionMode, "do">;
  const badge = SUGGESTION_BADGE[mode];
  const Icon = SUGGESTION_ICON[mode];
  // For a delegate nudge, name the AI's suggested owner when we have one.
  const who = mode === "delegate" ? item.assignee?.name?.split(/\s+/)[0] : undefined;
  const label = who ? `Delegate to ${who}?` : badge.label;
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full border font-medium",
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]",
        SUGGESTION_TONE[mode],
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => openFocus(item.id)}
        title={badge.prompt}
        className="tech-transition inline-flex items-center gap-1 hover:opacity-80"
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          updateItem(item.id, { keptMine: true });
        }}
        title="Keep this one mine — stop suggesting"
        aria-label="Dismiss suggestion — keep mine"
        className="tech-transition -mr-0.5 shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/15"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}

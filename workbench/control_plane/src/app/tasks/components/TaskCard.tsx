"use client";

import { useState } from "react";
import {
  Clock,
  AlertTriangle,
  FolderKanban,
  Zap,
  Mail,
  Paperclip,
  ListTree,
  GripVertical,
  Check,
  ChevronDown,
  CalendarClock,
  Trash2,
} from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { useCardActions } from "../lib/useCardActions";
import { durationLabel, initials, isOverdue, relativeTime } from "../lib/utils";
import { stageAccent } from "../lib/stageColors";
import { contextAccent } from "../lib/contextColors";
import { SourceBadge } from "./SourceBadge";
import { PriorityBadge, SuggestionBadge } from "./PriorityControls";
import { ContextMenu, type CtxItem } from "./ContextMenu";

const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

const ENERGY_DOT: Record<string, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};

// A rich, PM-tool-style task card (Jira/Linear-shaped) used by both the board
// columns and the list view. Clicking opens the full-page focus modal. On the
// board it's draggable (native HTML5 DnD wired by the parent column).
export function TaskCard({
  item,
  variant = "board",
  draggable = false,
  showPriority = false,
  showStage = true,
  selectMode = false,
  selected = false,
  onToggleSelected,
  onDragStart,
  onDragEnd,
}: {
  item: GtdItem;
  /** "board" = full card (default); "row" = denser one-line-ish list row. */
  variant?: "board" | "row";
  draggable?: boolean;
  /** Show the matrix-cell badge (the Priority view / ranked list). Off
   *  elsewhere so a card carries at most the one relevant priority signal. */
  showPriority?: boolean;
  /** Show the status/stage pill on the card. On surfaces that ALREADY convey
   *  the stage structurally — the Kanban columns, the status-grouped list
   *  headers — it's redundant, so those pass `false`. Everywhere the stage
   *  isn't otherwise visible (Engage, Priority, a lens-grouped list, the flat
   *  lists) it stays on so the status lives on the card itself. */
  showStage?: boolean;
  /** Multi-select mode (board): show a checkbox and toggle selection on click
   *  instead of opening the focus modal. Drag is suppressed by the parent. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelected?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const openFocus = useTaskStore((s) => s.openFocus);
  const projects = useTaskStore((s) => s.projects);
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);
  const project = item.projectId
    ? projects.find((p) => p.id === item.projectId)
    : undefined;
  const overdue = isOverdue(item, MOCK_NOW);
  const atts = item.attachments?.length ?? 0;

  // Shared actions (schedule / stage / done / eliminate) power both the inline
  // controls and the right-click menu, so they never drift.
  const actions = useCardActions(item);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuItems: CtxItem[] = [
    {
      kind: "item",
      label: "Schedule on calendar",
      icon: CalendarClock,
      onSelect: actions.schedule,
    },
    { kind: "sep" },
    { kind: "label", label: "Change stage" },
    ...actions.stages.map(
      (st): CtxItem => ({
        kind: "item",
        label: st,
        checked: st === actions.currentStage,
        onSelect: () => actions.setStage(st),
      }),
    ),
    { kind: "sep" },
    {
      kind: "item",
      label: actions.isDone ? "Mark as not done" : "Mark as Done",
      icon: Check,
      onSelect: actions.toggleDone,
    },
    {
      kind: "item",
      label: "Eliminate…",
      icon: Trash2,
      danger: true,
      onSelect: actions.eliminate,
    },
  ];
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const contextMenu = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menuItems}
      onClose={() => setMenu(null)}
    />
  ) : null;

  const meta = (
    <>
      {item.context && (
        <span
          className={[
            "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]",
            contextAccent(item.context).chip,
          ].join(" ")}
        >
          {item.context}
        </span>
      )}
      {item.energy && (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${ENERGY_DOT[item.energy]}`} />
          {item.energy}
        </span>
      )}
      {item.timeEstimateMins ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3" />
          {durationLabel(item.timeEstimateMins)}
        </span>
      ) : null}
      {item.dueAt && (
        <span
          className={[
            "inline-flex items-center gap-1 text-[10px]",
            overdue ? "font-medium text-destructive" : "text-muted-foreground",
          ].join(" ")}
        >
          {overdue ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {relativeTime(item.dueAt, MOCK_NOW)}
        </span>
      )}
      {atts > 0 && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <Paperclip className="h-3 w-3" />
          {atts}
        </span>
      )}
      {item.subtaskCount ? (
        <span
          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
          title={`${item.subtaskCount} subtask${item.subtaskCount === 1 ? "" : "s"}`}
        >
          <ListTree className="h-3 w-3" />
          {item.subtaskCount}
        </span>
      ) : null}
      {item.origin?.kind === "email" && (
        <span
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          title={`From email — ${item.origin.fromName || item.origin.fromEmail || ""}`}
        >
          <Mail className="h-3 w-3" />
        </span>
      )}
      {/* Priority signal. The matrix-cell PILL (🔥 Critical, 📈 High-Leverage,
          …) now rides on EVERY card so the priority is visible at a glance in
          the list and board — with its label except on the dense Priority view,
          which is already grouped by level (`showPriority` → icon-only there to
          avoid repeating the section header). The competing action NUDGE
          (delegate / schedule / eliminate) sits ALONGSIDE it — different meaning
          (what it IS vs what to DO about it) — dismissible via its × (keep mine),
          and hidden on the Priority view where the pill already carries it. */}
      <PriorityBadge
        item={item}
        urgentWindowHours={urgentWindowHours}
        showLabel={!showPriority}
        hideLowPriority={!showPriority}
      />
      {!showPriority && (
        <SuggestionBadge item={item} urgentWindowHours={urgentWindowHours} compact />
      )}
    </>
  );

  if (variant === "row") {
    // A div (not a <button>) so the SuggestionBadge's own buttons are valid
    // nested interactive elements; Enter/Space + role keep it keyboard-usable.
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          onClick={() => openFocus(item.id)}
          onContextMenu={openMenu}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFocus(item.id);
            }
          }}
          // Mobile: two-line row (full-width title, chips wrap underneath) so
          // titles aren't crushed to a few characters; sm:+ single line as before.
          className="tech-transition group flex w-full cursor-pointer flex-col items-stretch gap-1 border-b border-border px-3.5 py-2.5 text-left hover:bg-secondary/50 sm:flex-row sm:items-center sm:gap-2.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {showStage && <StagePill actions={actions} />}
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {meta}
            {project && (
              <span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:inline-flex">
                <FolderKanban className="h-3 w-3" />
                <span className="max-w-[120px] truncate">{project.outcome}</span>
              </span>
            )}
            <ScheduleButton onClick={actions.schedule} />
            {item.assignee && <Avatar name={item.assignee.name} />}
            <SourceBadge source={item.source} provider={item.provider} size="xs" />
          </div>
        </div>
        {contextMenu}
      </>
    );
  }

  // In select mode the card is a selection toggle, not a link: clicking checks
  // the box (drag is disabled by the parent) so a batch can be archived/deleted
  // right on the board. A selected card gets a primary ring.
  const activate = () => {
    if (selectMode) onToggleSelected?.();
    else openFocus(item.id);
  };
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={activate}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        className={[
          "group tech-transition relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm hover:shadow-md",
          selected
            ? "border-primary ring-1 ring-primary"
            : "border-border hover:border-primary/40",
        ].join(" ")}
      >
        {selectMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected?.()}
            onClick={(e) => e.stopPropagation()}
            aria-label={selected ? "Deselect task" : "Select task"}
            className="absolute right-1.5 top-1.5 h-4 w-4 accent-primary"
          />
        ) : (
          draggable && (
            <GripVertical className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />
          )
        )}
        <div className="flex items-start gap-2 pr-4">
          {!selectMode && showStage && <StagePill actions={actions} />}
          <p className="text-[13px] font-medium leading-snug text-foreground">
            {item.title}
          </p>
        </div>
        {item.nextAction && item.nextAction !== item.title && (
          <p className="line-clamp-2 text-[11px] text-muted-foreground">
            {item.nextAction}
          </p>
        )}
        {project && (
          <span className="inline-flex w-fit items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <FolderKanban className="h-3 w-3" />
            <span className="max-w-[160px] truncate">{project.outcome}</span>
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{meta}</div>
        <div className="mt-0.5 flex items-center justify-between">
          <SourceBadge source={item.source} provider={item.provider} size="xs" />
          <div className="flex items-center gap-1.5">
            <ScheduleButton onClick={actions.schedule} />
            {item.assignee && (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Avatar name={item.assignee.name} />
                <span className="max-w-[90px] truncate">
                  {item.assignee.name}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
      {contextMenu}
    </>
  );
}

// The card's STATUS INDICATOR — the single status control on a card (there is
// no separate Done button; the last stage is "Done" like any other stage). It
// shows the task's current Next-Actions stage in the SAME per-stage colour the
// board columns and list headers use (via stageAccent), so status reads the
// same everywhere. Click opens a small stage list to change it — picking the
// last stage marks the task done (see useCardActions). Works for local tasks
// and reflects synced tasks' mapped stage. stopPropagation so it never opens
// the card.
function StagePill({
  actions,
}: {
  actions: ReturnType<typeof useCardActions>;
}) {
  const { stages, currentStage, setStage } = actions;
  const [open, setOpen] = useState(false);
  // Colour the pill by the current stage, keyword-aware and consistent with the
  // board/list (Done → green, In-progress → blue, …).
  const accent = stageAccent(
    currentStage,
    Math.max(0, stages.indexOf(currentStage)),
    stages.length,
  );
  return (
    <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Change status"
        aria-label={`Status: ${currentStage}. Click to change.`}
        className={[
          "tech-transition inline-flex items-center gap-1 rounded-full border border-transparent px-1.5 py-0.5 text-[10px] font-medium hover:brightness-95",
          accent.soft,
          accent.text,
        ].join(" ")}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
        <span className="max-w-[84px] truncate">{currentStage}</span>
        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[150px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl">
            {stages.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStage(s);
                  setOpen(false);
                }}
                className="tech-transition flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-secondary"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${stageAccent(s, i, stages.length).dot}`}
                />
                <span className="min-w-0 flex-1 truncate">{s}</span>
                {s === currentStage && (
                  <Check className="h-3 w-3 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// A quiet, always-visible "Schedule on calendar" button (touch-friendly — the
// context menu is right-click only). Opens the shared SchedulePopup.
function ScheduleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="Schedule on calendar"
      aria-label="Schedule on calendar"
      className="tech-transition rounded p-1 text-muted-foreground/70 hover:bg-secondary hover:text-primary"
    >
      <CalendarClock className="h-3.5 w-3.5" />
    </button>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
      {initials(name)}
    </span>
  );
}

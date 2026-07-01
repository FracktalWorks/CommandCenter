"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  Pencil,
  Trash2,
  Lightbulb,
  FileText,
  Sparkles,
  Check,
  CalendarClock,
  Square,
  CheckSquare,
  StickyNote,
  ListChecks,
  FolderKanban,
  UserPlus,
  Zap,
  Cloud,
  type LucideIcon,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { proposeClarification, type ClarifyDisposition } from "../lib/clarify";
import { GtdItem, GtdProject, Person } from "../lib/types";
import { CONNECTED_PROVIDERS } from "../lib/mockData";
import { detectDateHint, relativeTime, snoozeOptions } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";

// The assistant's at-a-glance read of a capture — shown on the card so you see
// the *shape* of your inbox (what's yours, what to delegate, what's a project,
// where it goes) before opening anything. It's a hint; Clarify still decides.
const DISP_HINT: Record<ClarifyDisposition, { label: string; Icon: LucideIcon }> = {
  NEXT: { label: "Next", Icon: ListChecks },
  PROJECT: { label: "Project", Icon: FolderKanban },
  WAITING: { label: "Delegate", Icon: UserPlus },
  CALENDAR: { label: "Schedule", Icon: CalendarClock },
  DO_NOW: { label: "Do now", Icon: Zap },
  SOMEDAY: { label: "Someday", Icon: Lightbulb },
  REFERENCE: { label: "Reference", Icon: FileText },
  TRASH: { label: "Trash", Icon: Trash2 },
};
const shortText = (s: string, n = 22) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface InboxCardProps {
  item: GtdItem;
  cursor: boolean;
  selected: boolean;
  selectionMode: boolean;
  editing: boolean;
  onSelectToggle: () => void;
  onEditStart: () => void;
  onEditEnd: () => void;
}

export function InboxCard({
  item,
  cursor,
  selected,
  selectionMode,
  editing,
  onSelectToggle,
  onEditStart,
  onEditEnd,
}: InboxCardProps) {
  const openClarify = useTaskStore((s) => s.openClarify);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const deferItem = useTaskStore((s) => s.deferItem);
  const updateItem = useTaskStore((s) => s.updateItem);
  const people = useTaskStore((s) => s.people);
  const projects = useTaskStore((s) => s.projects);

  const hint = useMemo(
    () => buildHint(item, people, projects),
    [item, people, projects],
  );

  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftNote, setDraftNote] = useState(item.notes ?? "");
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard cursor row visible as you navigate with j/k.
  useEffect(() => {
    if (cursor) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const dateHint = detectDateHint(item.title);

  if (editing) {
    const save = () => {
      updateItem(item.id, { title: draftTitle, notes: draftNote });
      onEditEnd();
    };
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEditEnd();
              }
            }}
            className="flex-1 bg-transparent text-sm text-foreground focus:outline-none"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            aria-label="Save"
            className="tech-transition rounded-md p-1 text-primary hover:bg-primary/10"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
        <textarea
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          placeholder="Add a note (optional)…"
          rows={2}
          className="w-full resize-none rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-[13px] text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      data-cursor={cursor || undefined}
      onClick={() => openClarify(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openClarify(item.id);
        }
      }}
      className={[
        "group tech-transition relative flex items-start gap-3 rounded-xl border bg-card px-4 py-3.5",
        cursor
          ? "border-primary ring-1 ring-primary/40"
          : selected
            ? "border-primary/50 bg-primary/5"
            : "border-border hover:border-primary/40 hover:bg-secondary/30",
      ].join(" ")}
    >
      {/* selection checkbox */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelectToggle();
        }}
        aria-label={selected ? "Deselect" : "Select"}
        className={[
          "mt-0.5 shrink-0 tech-transition",
          selected || selectionMode
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100",
          selected ? "text-primary" : "text-muted-foreground hover:text-foreground",
        ].join(" ")}
      >
        {selected ? (
          <CheckSquare className="h-4 w-4" />
        ) : (
          <Square className="h-4 w-4" />
        )}
      </button>

      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/60" />

      <div className="min-w-0 flex-1 cursor-pointer">
        <p className="text-sm leading-snug text-foreground">{item.title}</p>
        <HintRow hint={hint} />
        {item.notes && (
          <p className="mt-1 flex items-start gap-1 text-[12px] leading-snug text-muted-foreground">
            <StickyNote className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="line-clamp-2">{item.notes}</span>
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            captured {relativeTime(item.createdAt)}
          </span>
          <SourceBadge source={item.source} provider={item.provider} size="xs" />
          {dateHint && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSnoozeOpen(true);
              }}
              title="Detected a date — snooze to it?"
              className="tech-transition inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
            >
              <CalendarClock className="h-3 w-3" />
              {dateHint}?
            </button>
          )}
        </div>
      </div>

      {/* hover quick-actions (desktop; on touch, tap the card → Clarify sheet) */}
      <div className="hidden shrink-0 items-center gap-0.5 opacity-0 tech-transition focus-within:opacity-100 group-hover:opacity-100 sm:flex">
        <CardAction label="Edit" icon={Pencil} onClick={onEditStart} />
        <div className="relative">
          <CardAction
            label="Snooze"
            icon={CalendarClock}
            onClick={() => setSnoozeOpen((v) => !v)}
          />
          {snoozeOpen && (
            <SnoozeMenu
              onPick={(iso) => {
                deferItem(item.id, iso);
                setSnoozeOpen(false);
              }}
              onClose={() => setSnoozeOpen(false)}
            />
          )}
        </div>
        <CardAction
          label="Someday"
          icon={Lightbulb}
          onClick={() => quickDispose(item.id, "SOMEDAY")}
        />
        <CardAction
          label="Reference"
          icon={FileText}
          onClick={() => quickDispose(item.id, "REFERENCE")}
        />
        <CardAction
          label="Trash"
          icon={Trash2}
          danger
          onClick={() => quickDispose(item.id, "TRASH")}
        />
        <CardAction
          label="Clarify"
          icon={Sparkles}
          primary
          onClick={() => openClarify(item.id)}
        />
      </div>
    </div>
  );
}

/** Build the compact "what this will become" hint for a capture. */
function buildHint(item: GtdItem, people: Person[], projects: GtdProject[]) {
  const p = proposeClarification(item, people, projects);
  const base = DISP_HINT[p.disposition];
  const parts: string[] = [];
  if (p.disposition === "WAITING" && p.suggestedAssignee) {
    parts.push(p.suggestedAssignee.name);
  }
  const proj = p.projectId ? projects.find((x) => x.id === p.projectId) : undefined;
  if (proj) parts.push(shortText(proj.outcome));
  else if ((p.disposition === "NEXT" || p.disposition === "CALENDAR") && p.context) {
    parts.push(p.context);
  }
  const provider =
    p.target && p.target.source === "SYNCED"
      ? CONNECTED_PROVIDERS.find((cp) => cp.provider === p.target!.provider)?.label
      : undefined;
  return { ...base, detail: parts.join(" · "), provider };
}

function HintRow({
  hint,
}: {
  hint: { label: string; Icon: LucideIcon; detail: string; provider?: string };
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
      <span className="inline-flex items-center gap-1">
        <Sparkles className="h-3 w-3 text-primary/60" />
        <hint.Icon className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium text-foreground/75">{hint.label}</span>
      </span>
      {hint.detail && (
        <span className="truncate text-muted-foreground/70">· {hint.detail}</span>
      )}
      {hint.provider && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-px text-[10px] text-muted-foreground">
          <Cloud className="h-2.5 w-2.5" />
          {hint.provider}
        </span>
      )}
    </div>
  );
}

function SnoozeMenu({
  onPick,
  onClose,
}: {
  onPick: (iso: string) => void;
  onClose: () => void;
}) {
  const opts = snoozeOptions();
  return (
    <>
      {/* click-away */}
      <div
        className="fixed inset-0 z-40"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-popover p-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Snooze until
        </p>
        {opts.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onPick(o.iso)}
            className="tech-transition flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-secondary"
          >
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            {o.label}
          </button>
        ))}
        <label className="mt-1 flex items-center gap-2 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          Pick date
          <input
            type="date"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value) onPick(new Date(e.target.value).toISOString());
            }}
            className="flex-1 rounded border border-border bg-background/60 px-1 py-0.5 text-[11px] text-foreground focus:outline-none"
          />
        </label>
      </div>
    </>
  );
}

function CardAction({
  label,
  icon: Icon,
  onClick,
  primary,
  danger,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={[
        "tech-transition rounded-md p-1.5",
        primary
          ? "text-muted-foreground hover:bg-primary/10 hover:text-primary"
          : danger
            ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

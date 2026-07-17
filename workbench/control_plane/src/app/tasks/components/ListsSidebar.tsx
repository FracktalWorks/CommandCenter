"use client";

import { useMemo } from "react";
import {
  Inbox,
  ListChecks,
  Clock,
  Calendar,
  FolderKanban,
  Users,
  Lightbulb,
  Mountain,
  Cloud,
  Plug,
  HardDrive,
  Layers,
  Sparkles,
  Archive,
  CheckCircle2,
  type LucideIcon,
  Settings2,
} from "lucide-react";
import { useTaskStore, viewCounts } from "../lib/taskStore";
import { ViewKey } from "../lib/types";

type NavRow = {
  view: ViewKey;
  label: string;
  icon: LucideIcon;
  /** show the count badge */
  showCount?: boolean;
  /** not yet built — rendered disabled with a "soon" tag */
  soon?: boolean;
};

// The single flat nav. "My Next Actions" is one destination — its slices
// (Priority / Suggestion / Context / Energy grouping, list vs board) are
// configured IN the view (toolbar group-by + column settings), not as separate
// sidebar entries. Priority and Engage were removed as standalone views for
// that reason.
const PRIMARY: NavRow[] = [
  { view: "inbox", label: "Inbox", icon: Inbox, showCount: true },
  { view: "next", label: "My Next Actions", icon: ListChecks, showCount: true },
  { view: "waiting", label: "Waiting For", icon: Clock, showCount: true },
  { view: "calendar", label: "Calendar", icon: Calendar, showCount: true },
  { view: "projects", label: "Projects", icon: FolderKanban },
  { view: "people", label: "People", icon: Users },
  { view: "someday", label: "Someday / Maybe", icon: Lightbulb, showCount: true },
  { view: "done", label: "Done", icon: CheckCircle2, showCount: true },
  { view: "archive", label: "Archive", icon: Archive },
];

const SECONDARY: NavRow[] = [
  { view: "horizons", label: "Horizons of Focus", icon: Mountain, soon: true },
];

export function ListsSidebar({
  onNavigate,
  onOpenAssistant,
  assistantActive,
}: {
  onNavigate?: () => void;
  /** Open the AI assistant as a scene (email-app pattern). */
  onOpenAssistant?: () => void;
  /** Highlight the Assistant entry while its scene is open. */
  assistantActive?: boolean;
} = {}) {
  const items = useTaskStore((s) => s.items);
  const projects = useTaskStore((s) => s.projects);
  const selectedView = useTaskStore((s) => s.selectedView);
  const selectedContext = useTaskStore((s) => s.selectedContext);
  const selectViewRaw = useTaskStore((s) => s.selectView);
  const accounts = useTaskStore((s) => s.accounts);
  const openWorkspaces = useTaskStore((s) => s.openWorkspaces);
  const openSettings = useTaskStore((s) => s.openSettings);
  const loadArchive = useTaskStore((s) => s.loadArchive);
  const loadDone = useTaskStore((s) => s.loadDone);
  const loadLocalHierarchy = useTaskStore((s) => s.loadLocalHierarchy);
  const loadPeople = useTaskStore((s) => s.loadPeople);
  const sourceFilter = useTaskStore((s) => s.sourceFilter);
  const setSourceFilter = useTaskStore((s) => s.setSourceFilter);
  const selectView: typeof selectViewRaw = (v) => {
    selectViewRaw(v);
    // Archived tasks aren't in the normal hydrate — pull them on demand.
    if (v === "archive") void loadArchive();
    // DONE tasks are excluded from the normal hydrate too — load on open.
    if (v === "done") void loadDone();
    // The Projects tree (local spaces/folders) is loaded lazily on open.
    if (v === "projects") void loadLocalHierarchy();
    // The People roster (full HR records) is loaded lazily on open.
    if (v === "people") void loadPeople();
    onNavigate?.();
  };
  const counts = useMemo(() => viewCounts(items), [items]);

  return (
    <nav className="flex h-full flex-col gap-1 overflow-y-auto p-3 text-sm">
      <div className="px-2 pb-2 pt-1">
        <h2 className="text-sm font-semibold text-foreground">Tasks</h2>
        <p className="text-[11px] text-muted-foreground">Getting Things Done</p>
      </div>

      {/* Source filter — persistent across every view, so wherever local and
          ClickUp tasks are mixed you can narrow to just your own or just the
          workspace's. Only shown once a workspace is connected. */}
      {accounts.length > 0 && (
        <div className="mb-1 px-1">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
            {(
              [
                { id: "all", label: "All", Icon: Layers },
                { id: "local", label: "Mine", Icon: HardDrive },
                { id: "synced", label: "ClickUp", Icon: Cloud },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSourceFilter(id)}
                aria-pressed={sourceFilter === id}
                title={
                  id === "local"
                    ? "Only tasks you captured here (local)"
                    : id === "synced"
                      ? "Only tasks mirrored from ClickUp"
                      : "All tasks (local + ClickUp)"
                }
                className={[
                  "tech-transition flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium",
                  sourceFilter === id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {PRIMARY.map((row) => {
        const count =
          row.view === "projects" ? projects.length : counts[row.view];
        // My Next Actions stays highlighted even when an in-view @context pill is
        // active (selectedContext set) — it's still the Next Actions view.
        const active =
          selectedView === row.view &&
          (row.view === "next" ? true : !selectedContext);
        return (
          <NavButton
            key={row.view}
            row={row}
            active={active}
            count={count}
            onClick={() => selectView(row.view)}
          />
        );
      })}

      <div className="mt-3 border-t border-border pt-3">
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Higher altitude
        </p>
        {SECONDARY.map((row) => (
          <NavButton key={row.view} row={row} active={false} onClick={() => {}} />
        ))}
      </div>

      {/* AI assistant — opens as a scene (mirrors the email app's left-rail
          Chat entry) instead of an always-on right rail. */}
      {onOpenAssistant && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => {
              onOpenAssistant();
              onNavigate?.();
            }}
            aria-pressed={assistantActive}
            className={[
              "tech-transition flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
              assistantActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            ].join(" ")}
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className="flex-1">Assistant</span>
          </button>
        </div>
      )}

      <div className="mt-3 border-t border-border pt-3">
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Workspaces
        </p>
        {accounts.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground"
          >
            <Cloud className="h-3.5 w-3.5 shrink-0 text-primary/70" />
            <span className="flex-1 truncate">{a.label}</span>
            <span className="text-[10px]">{a.projectCount}</span>
          </div>
        ))}
        <button
          type="button"
          onClick={() => {
            openWorkspaces();
            onNavigate?.();
          }}
          className="tech-transition flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Plug className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Connect workspace…</span>
        </button>
        <button
          type="button"
          onClick={() => {
            openSettings();
            onNavigate?.();
          }}
          className="tech-transition flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Settings</span>
        </button>
      </div>
    </nav>
  );
}

function NavButton({
  row,
  active,
  count,
  onClick,
}: {
  row: NavRow;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      disabled={row.soon}
      onClick={onClick}
      className={[
        "tech-transition flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
        row.soon
          ? "cursor-default text-muted-foreground/50"
          : active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{row.label}</span>
      {row.soon ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">
          soon
        </span>
      ) : row.showCount && count ? (
        <span
          className={[
            "min-w-[18px] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold",
            active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
          ].join(" ")}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}


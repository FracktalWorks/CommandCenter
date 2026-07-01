"use client";

import { useEffect, useMemo, useState, KeyboardEvent } from "react";
import {
  Inbox,
  Plus,
  CornerDownLeft,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Wind,
  Undo2,
  AlertCircle,
  Search,
  ArrowDownUp,
  SearchX,
  Lightbulb,
  FileText,
  Trash2,
  CalendarClock,
  X,
  RotateCcw,
  Keyboard,
} from "lucide-react";
import FilterPills from "@/components/FilterPills";
import { useTaskStore } from "../lib/taskStore";
import { Disposition, GtdItem } from "../lib/types";
import {
  DateBucketKey,
  dateBucket,
  isTickled,
  msSince,
  relativeTime,
} from "../lib/utils";
import { InboxCard } from "./InboxCard";
import { ClarifyModal } from "./ClarifyModal";

const AGING_MS = 3 * 24 * 3600 * 1000; // GTD: empty regularly — flag stale items

type DateFilter = "all" | DateBucketKey;
type SortOrder = "newest" | "oldest";

export function InboxView() {
  const items = useTaskStore((s) => s.items);
  const capture = useTaskStore((s) => s.capture);
  const openClarify = useTaskStore((s) => s.openClarify);
  const openQuickCapture = useTaskStore((s) => s.openQuickCapture);
  const lastCaptureIds = useTaskStore((s) => s.lastCaptureIds);
  const undoLastCapture = useTaskStore((s) => s.undoLastCapture);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const bulkDispose = useTaskStore((s) => s.bulkDispose);
  const undeferItem = useTaskStore((s) => s.undeferItem);
  const undoSnapshot = useTaskStore((s) => s.undoSnapshot);
  const undoLastChange = useTaskStore((s) => s.undoLastChange);
  const dismissUndo = useTaskStore((s) => s.dismissUndo);
  const processed = useTaskStore((s) => s.processedThisSession);
  const clarifyModalOpen = useTaskStore((s) => s.clarifyModalOpen);
  const quickCaptureOpen = useTaskStore((s) => s.quickCaptureOpen);

  // Active inbox = to-process (INBOX, not tickled). Tickler = deferred items.
  const activeInbox = useMemo(
    () => items.filter((i) => i.disposition === "INBOX" && !isTickled(i)),
    [items],
  );
  const tickler = useMemo(
    () =>
      items
        .filter((i) => i.disposition === "INBOX" && isTickled(i))
        .sort((a, b) => (a.deferUntil ?? "").localeCompare(b.deferUntil ?? "")),
    [items],
  );

  const oldest = useMemo(() => {
    if (!activeInbox.length) return null;
    return activeInbox.reduce((a, b) =>
      new Date(a.createdAt) < new Date(b.createdAt) ? a : b,
    );
  }, [activeInbox]);
  const isAging = !!oldest && msSince(oldest.createdAt) > AGING_MS;

  const undoCount = useMemo(
    () => lastCaptureIds.filter((id) => activeInbox.some((i) => i.id === id)).length,
    [lastCaptureIds, activeInbox],
  );

  // ── local UI state ──
  const [value, setValue] = useState("");
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [showTickler, setShowTickler] = useState(false);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showShortcuts, setShowShortcuts] = useState(false);

  const bucketCounts = useMemo(() => {
    const c = { today: 0, yesterday: 0, week: 0, older: 0 };
    for (const i of activeInbox) c[dateBucket(i.createdAt).key]++;
    return c;
  }, [activeInbox]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = activeInbox.filter((i) => {
      if (dateFilter !== "all" && dateBucket(i.createdAt).key !== dateFilter)
        return false;
      if (q && !i.title.toLowerCase().includes(q)) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === "newest" ? -d : d;
    });
  }, [activeInbox, search, dateFilter, sortOrder]);

  const pills = [
    { id: "all", label: "All", count: activeInbox.length },
    { id: "today", label: "Today", count: bucketCounts.today },
    { id: "yesterday", label: "Yesterday", count: bucketCounts.yesterday },
    { id: "week", label: "This week", count: bucketCounts.week },
    { id: "older", label: "Older", count: bucketCounts.older },
  ].filter((p) => p.id === "all" || p.count > 0);

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());
  const bulk = (d: Disposition) => {
    bulkDispose([...selectedIds], d);
    clearSelection();
  };

  // ── keyboard navigation + triage over the visible list ──
  useEffect(() => {
    if (showTickler) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (clarifyModalOpen || quickCaptureOpen || editingId) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!visible.length) return;

      const idx = visible.findIndex((i) => i.id === cursorId);
      const cur = idx >= 0 ? visible[idx] : visible[0];
      const disposeAdvance = (d: Disposition) => {
        const nextId =
          visible[idx + 1]?.id ?? visible[idx - 1]?.id ?? null;
        quickDispose(cur.id, d);
        setCursorId(nextId);
      };

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setCursorId(
            idx < 0 ? visible[0].id : visible[Math.min(visible.length - 1, idx + 1)].id,
          );
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursorId(idx < 0 ? visible[0].id : visible[Math.max(0, idx - 1)].id);
          break;
        case "Enter":
          e.preventDefault();
          openClarify(cur.id);
          break;
        case "e":
          e.preventDefault();
          setEditingId(cur.id);
          break;
        case "x":
          e.preventDefault();
          toggleSelect(cur.id);
          break;
        case "t":
          e.preventDefault();
          disposeAdvance("TRASH");
          break;
        case "s":
          e.preventDefault();
          disposeAdvance("SOMEDAY");
          break;
        case "r":
          e.preventDefault();
          disposeAdvance("REFERENCE");
          break;
        case "2":
          e.preventDefault();
          disposeAdvance("DONE");
          break;
        case "u":
          if (undoSnapshot) {
            e.preventDefault();
            undoLastChange();
          }
          break;
        case "Escape":
          clearSelection();
          setCursorId(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    visible,
    cursorId,
    editingId,
    showTickler,
    clarifyModalOpen,
    quickCaptureOpen,
    openClarify,
    quickDispose,
    undoSnapshot,
    undoLastChange,
  ]);

  // Auto-dismiss the undo affordance after a few seconds (async → effect-safe).
  useEffect(() => {
    if (!undoSnapshot) return;
    const t = setTimeout(() => dismissUndo(), 7000);
    return () => clearTimeout(t);
  }, [undoSnapshot, dismissUndo]);

  const submit = () => {
    const t = value.trim();
    if (!t) return;
    capture(t);
    setValue("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  const startClarify = (id: string) => openClarify(id);

  const selectionActive = selectedIds.size > 0;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Capture hero — desktop only. On mobile the dedicated Capture button
          (bottom nav / `C`) handles capture, so we give the list the space. */}
      <div className="hidden shrink-0 border-b border-border sm:block">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
          <div className="mb-1 flex items-center gap-2">
            <Inbox className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground">Inbox</h1>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Capture now, clarify later. Get it out of your head.
          </p>
          <div className="tech-transition flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 focus-within:border-primary/50">
            <Plus className="h-5 w-5 shrink-0 text-muted-foreground" />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What's on your mind?"
              aria-label="Capture a task"
              className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {value.trim() ? (
              <button
                type="button"
                onClick={submit}
                className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                Add <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
            ) : (
              <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                ↵
              </kbd>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => openQuickCapture("sweep")}
              className="tech-transition inline-flex items-center gap-1 hover:text-primary"
            >
              <Wind className="h-3.5 w-3.5" />
              Mind sweep
            </button>
            <span className="hidden text-muted-foreground/50 sm:inline">·</span>
            <span className="hidden sm:inline">
              Press{" "}
              <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">
                C
              </kbd>{" "}
              to capture from anywhere
            </span>
            <button
              type="button"
              onClick={() => setShowShortcuts((v) => !v)}
              className="tech-transition ml-auto hidden items-center gap-1 hover:text-foreground sm:inline-flex"
            >
              <Keyboard className="h-3.5 w-3.5" />
              Shortcuts
            </button>
          </div>

          {showShortcuts && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[10px] text-muted-foreground">
              <Sc k="j / k">move</Sc>
              <Sc k="↵">clarify</Sc>
              <Sc k="e">edit</Sc>
              <Sc k="x">select</Sc>
              <Sc k="t">trash</Sc>
              <Sc k="s">someday</Sc>
              <Sc k="r">reference</Sc>
              <Sc k="2">do now</Sc>
              <Sc k="u">undo</Sc>
              <Sc k="esc">clear</Sc>
            </div>
          )}

        </div>
      </div>

      {/* Capture undo — kept out of the hero so it shows on mobile too */}
      {undoCount > 0 && (
        <div className="shrink-0 border-b border-border bg-secondary/40">
          <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-2 sm:px-6">
            <span className="text-[11px] text-muted-foreground">
              Captured {undoCount} item{undoCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={undoLastCapture}
              className="tech-transition inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
          </div>
        </div>
      )}

      {/* Controls */}
      {(activeInbox.length > 0 || tickler.length > 0) && (
        <div className="shrink-0 border-b border-border bg-background/80 backdrop-blur">
          <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
            <div className="flex items-center justify-between gap-2 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
                  {activeInbox.length} to process
                </span>
                {processed > 0 && (
                  <span className="hidden items-center gap-1 whitespace-nowrap text-[11px] text-success sm:inline-flex">
                    <CheckCircle2 className="h-3 w-3" />
                    {processed} processed
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {tickler.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowTickler((v) => !v)}
                    className={[
                      "tech-transition inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium",
                      showTickler
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    ].join(" ")}
                  >
                    <CalendarClock className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Tickler&nbsp;</span>
                    {tickler.length}
                  </button>
                )}
                {!showTickler && (
                  <button
                    type="button"
                    disabled={!oldest}
                    onClick={() => oldest && startClarify(oldest.id)}
                    title="Process the oldest item first (GTD FIFO)"
                    className="tech-transition inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-40"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Clarify next
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            {isAging && oldest && !showTickler && (
              <div className="pb-2">
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                  <AlertCircle className="h-3 w-3" />
                  oldest {relativeTime(oldest.createdAt)} — time to process
                </span>
              </div>
            )}

            {!showTickler &&
              (selectionActive ? (
                <div className="flex items-center gap-2 pb-2">
                  <span className="text-xs font-medium text-primary">
                    {selectedIds.size} selected
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <BulkBtn icon={Lightbulb} onClick={() => bulk("SOMEDAY")}>
                      Someday
                    </BulkBtn>
                    <BulkBtn icon={FileText} onClick={() => bulk("REFERENCE")}>
                      Reference
                    </BulkBtn>
                    <BulkBtn icon={Trash2} danger onClick={() => bulk("TRASH")}>
                      Trash
                    </BulkBtn>
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="tech-transition rounded-md p-1 text-muted-foreground hover:text-foreground"
                      aria-label="Clear selection"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 pb-2">
                  <div className="tech-transition flex flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 focus-within:border-primary/50">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search captured tasks…"
                      aria-label="Search captured tasks"
                      className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSortOrder((o) => (o === "newest" ? "oldest" : "newest"))
                    }
                    className="tech-transition inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                    title="Toggle sort order"
                  >
                    <ArrowDownUp className="h-3.5 w-3.5" />
                    {sortOrder === "newest" ? "Newest" : "Oldest"}
                  </button>
                </div>
              ))}
          </div>
          {!showTickler && !selectionActive && (
            <FilterPills
              items={pills}
              activeId={dateFilter}
              onChange={(id) => setDateFilter(id as DateFilter)}
              className="mx-auto max-w-2xl !px-4 sm:!px-6"
            />
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-4 sm:px-6 sm:py-5">
          {showTickler ? (
            <TicklerList items={tickler} onUndefer={undeferItem} />
          ) : activeInbox.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <CheckCircle2 className="h-9 w-9 text-success/70" />
              <p className="text-sm font-medium text-foreground">
                Inbox zero. Mind like water.
              </p>
              <p className="text-xs text-muted-foreground">
                {processed > 0
                  ? `You processed ${processed} item${processed === 1 ? "" : "s"} this session. 🎉`
                  : "Nothing left to process. Capture the next thing above."}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <SearchX className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No captures match this filter.
              </p>
            </div>
          ) : (
            <>
              {(search || dateFilter !== "all") && (
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Showing {visible.length} of {activeInbox.length}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {visible.map((item) => (
                  <InboxCard
                    key={item.id}
                    item={item}
                    cursor={cursorId === item.id}
                    selected={selectedIds.has(item.id)}
                    selectionMode={selectionActive}
                    editing={editingId === item.id}
                    onSelectToggle={() => toggleSelect(item.id)}
                    onEditStart={() => setEditingId(item.id)}
                    onEditEnd={() => setEditingId(null)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Undo safety net — makes fast triage feel safe (one-level undo) */}
      {undoSnapshot && (
        <div className="chat-fade-in fixed bottom-20 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-popover px-4 py-2 shadow-2xl sm:bottom-6">
          <span className="whitespace-nowrap text-[13px] text-foreground">
            {undoSnapshot.label}
          </span>
          <button
            type="button"
            onClick={undoLastChange}
            className="tech-transition inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold text-primary hover:underline"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Undo
            <kbd className="ml-0.5 hidden rounded border border-border px-1 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline">
              u
            </kbd>
          </button>
          <button
            type="button"
            onClick={dismissUndo}
            aria-label="Dismiss"
            className="tech-transition rounded-md p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <ClarifyModal />
    </div>
  );
}

function TicklerList({
  items,
  onUndefer,
}: {
  items: GtdItem[];
  onUndefer: (id: string) => void;
}) {
  if (!items.length) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Nothing tickled.
      </p>
    );
  }
  return (
    <>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Deferred items — hidden from the inbox until they resurface.
      </p>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          >
            <CalendarClock className="h-4 w-4 shrink-0 text-primary/70" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{item.title}</p>
              <p className="text-[11px] text-muted-foreground">
                resurfaces {relativeTime(item.deferUntil)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onUndefer(item.id)}
              className="tech-transition inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              Un-snooze
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function BulkBtn({
  icon: Icon,
  onClick,
  danger,
  children,
}: {
  icon: typeof Lightbulb;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium",
        danger
          ? "border-destructive/30 text-destructive hover:bg-destructive/10"
          : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function Sc({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-foreground">
        {k}
      </kbd>
      {children}
    </span>
  );
}

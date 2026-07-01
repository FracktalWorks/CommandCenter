"use client";

import { useMemo, useState, KeyboardEvent } from "react";
import {
  Inbox,
  Plus,
  CornerDownLeft,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Clock,
  Wind,
  Undo2,
  AlertCircle,
  Search,
  ArrowDownUp,
  SearchX,
} from "lucide-react";
import FilterPills from "@/components/FilterPills";
import { useTaskStore } from "../lib/taskStore";
import { GtdItem } from "../lib/types";
import { DateBucketKey, dateBucket, msSince, relativeTime } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";
import { ClarifyModal } from "./ClarifyModal";

const AGING_MS = 3 * 24 * 3600 * 1000; // GTD: empty regularly — flag stale items

type DateFilter = "all" | DateBucketKey;
type SortOrder = "newest" | "oldest";

// A dedicated, capture-first Inbox surface (not the email-style list+detail).
// One job: capture fast, and see everything captured-but-unprocessed. Clarifying
// happens in a focused overlay (ClarifyModal), not a side column.
export function InboxView() {
  const items = useTaskStore((s) => s.items);
  const capture = useTaskStore((s) => s.capture);
  const selectItem = useTaskStore((s) => s.selectItem);
  const openQuickCapture = useTaskStore((s) => s.openQuickCapture);
  const lastCaptureIds = useTaskStore((s) => s.lastCaptureIds);
  const undoLastCapture = useTaskStore((s) => s.undoLastCapture);

  const inbox = useMemo(
    () => items.filter((i) => i.disposition === "INBOX"),
    [items],
  );

  // Oldest unprocessed item — GTD "empty regularly" signal.
  const oldest = useMemo(() => {
    if (!inbox.length) return null;
    const o = inbox.reduce((a, b) =>
      new Date(a.createdAt) < new Date(b.createdAt) ? a : b,
    );
    return o;
  }, [inbox]);
  const isAging = !!oldest && msSince(oldest.createdAt) > AGING_MS;

  // Undo bar: show while the last capture batch is still sitting in the inbox.
  const undoCount = useMemo(
    () =>
      lastCaptureIds.filter((id) =>
        inbox.some((i) => i.id === id),
      ).length,
    [lastCaptureIds, inbox],
  );

  const [value, setValue] = useState("");
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");

  // Per-bucket counts for the date filter pills.
  const bucketCounts = useMemo(() => {
    const c = { today: 0, yesterday: 0, week: 0, older: 0 };
    for (const i of inbox) c[dateBucket(i.createdAt).key]++;
    return c;
  }, [inbox]);

  // Filtered + sorted view of the inbox (scale + date filtering + search).
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = inbox.filter((i) => {
      if (dateFilter !== "all" && dateBucket(i.createdAt).key !== dateFilter)
        return false;
      if (q && !i.title.toLowerCase().includes(q)) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === "newest" ? -d : d;
    });
  }, [inbox, search, dateFilter, sortOrder]);

  const pills = [
    { id: "all", label: "All", count: inbox.length },
    { id: "today", label: "Today", count: bucketCounts.today },
    { id: "yesterday", label: "Yesterday", count: bucketCounts.yesterday },
    { id: "week", label: "This week", count: bucketCounts.week },
    { id: "older", label: "Older", count: bucketCounts.older },
  ].filter((p) => p.id === "all" || p.count > 0);

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

  const startClarify = (id: string) => {
    selectItem(id);
    setClarifyOpen(true);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Capture hero */}
      <div className="shrink-0 border-b border-border">
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
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
              autoFocus
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

          <div className="mt-2 flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => openQuickCapture("sweep")}
              className="tech-transition inline-flex items-center gap-1 hover:text-primary"
            >
              <Wind className="h-3.5 w-3.5" />
              Mind sweep
            </button>
            <span className="text-muted-foreground/50">·</span>
            <span>
              Press{" "}
              <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">
                C
              </kbd>{" "}
              to capture from anywhere
            </span>
          </div>

          {undoCount > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-3 py-2">
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
          )}
        </div>
      </div>

      {/* Sticky controls: count + aging + clarify-next, then search/sort, then date pills */}
      {inbox.length > 0 && (
        <div className="shrink-0 border-b border-border bg-background/80 backdrop-blur">
          <div className="mx-auto w-full max-w-2xl px-6">
            <div className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {inbox.length} to process
                </span>
                {isAging && oldest && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                    <AlertCircle className="h-3 w-3" />
                    oldest {relativeTime(oldest.createdAt)} — time to process
                  </span>
                )}
              </div>
              <button
                type="button"
                disabled={!visible.length}
                onClick={() => visible[0] && startClarify(visible[0].id)}
                className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Clarify next
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
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
                className="tech-transition inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                title="Toggle sort order"
              >
                <ArrowDownUp className="h-3.5 w-3.5" />
                {sortOrder === "newest" ? "Newest" : "Oldest"}
              </button>
            </div>
          </div>
          <FilterPills
            items={pills}
            activeId={dateFilter}
            onChange={(id) => setDateFilter(id as DateFilter)}
            className="mx-auto max-w-2xl !px-6"
          />
        </div>
      )}

      {/* Captured, unprocessed list */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-5">
          {inbox.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <CheckCircle2 className="h-9 w-9 text-success/70" />
              <p className="text-sm font-medium text-foreground">
                Inbox zero. Mind like water.
              </p>
              <p className="text-xs text-muted-foreground">
                Nothing left to process. Capture the next thing above.
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
                  Showing {visible.length} of {inbox.length}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {visible.map((item) => (
                  <InboxCard
                    key={item.id}
                    item={item}
                    onClarify={() => startClarify(item.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <ClarifyModal open={clarifyOpen} onClose={() => setClarifyOpen(false)} />
    </div>
  );
}

function InboxCard({ item, onClarify }: { item: GtdItem; onClarify: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClarify}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClarify();
        }
      }}
      className="group tech-transition flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 hover:border-primary/40 hover:bg-secondary/30"
    >
      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/60" />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-foreground">{item.title}</p>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            captured {relativeTime(item.createdAt)}
          </span>
          <SourceBadge source={item.source} provider={item.provider} size="xs" />
        </div>
      </div>
      <span className="tech-transition inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground opacity-0 group-hover:bg-primary/10 group-hover:text-primary group-hover:opacity-100">
        <Sparkles className="h-3.5 w-3.5" />
        Clarify
      </span>
    </div>
  );
}

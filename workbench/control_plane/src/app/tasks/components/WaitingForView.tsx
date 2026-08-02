"use client";

import { useMemo } from "react";
import { AlertTriangle, Clock, Hourglass, Mail, Send } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { initials, relativeTime } from "../lib/utils";
import {
  STALE_WAITING_DAYS,
  daysWaiting,
  groupByWaitingOn,
  isStaleWaiting,
  isWaitingOverdue,
} from "../lib/waiting";

// The GTD "Waiting For" list (spec: task_manager_app.md §1 line 46, §6).
//
// Every other processed-task view answers "what should I do?". This one answers
// "who owes me what, and since when?" — so it is grouped by PERSON, not by
// stage or priority: the human action is "chase Sai", once, about everything
// he has of mine. Each row carries the three facts §1 pins — who / what /
// since-when — plus the two flags §6 asks for:
//
//   overdue — past `expectedBy` (the date it was promised for)
//   stale   — nothing heard for STALE_WAITING_DAYS since `delegatedAt`
//
// The predicates live in lib/waiting.ts (pure, unit-tested, and the same
// 5-day rule the gateway's /tasks/insights uses). Drafting and sending the
// nudge itself is NOT here — that write is Action-Broker/owner-gated.

export function WaitingForView({ items }: { items: GtdItem[] }) {
  const openFocus = useTaskStore((s) => s.openFocus);
  const selectMode = useTaskStore((s) => s.selectMode);
  const selectedIds = useTaskStore((s) => s.selectedIds);
  const toggleSelected = useTaskStore((s) => s.toggleSelected);

  // ONE wall-clock read, threaded through every predicate below, so a single
  // list can never disagree with itself about what "now" is. Real time is the
  // point here (the frozen-demo-clock bug this view replaces); memoised so the
  // render stays idempotent — same shape as CalendarView's overdue scan.
  const { now, groups } = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    return { now: nowMs, groups: groupByWaitingOn(items, nowMs) };
  }, [items]);

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map((g) => (
        <section key={g.key}>
          {/* WHO — carried by the group header, since it's the same person for
              every row beneath it. */}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card/95 px-3 py-1.5 backdrop-blur">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary">
              {initials(g.label)}
            </span>
            <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-foreground">
              {g.label}
            </span>
            <span className="shrink-0 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {g.items.length}
            </span>
            {g.overdueCount > 0 && (
              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                {g.overdueCount} overdue
              </span>
            )}
          </div>
          {g.items.map((item) =>
            selectMode ? (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 border-b border-border/60 pl-3 hover:bg-secondary/40"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <div className="pointer-events-none min-w-0 flex-1">
                  <WaitingRow item={item} who={g.label} nowMs={now} />
                </div>
              </label>
            ) : (
              <button
                key={item.id}
                type="button"
                onClick={() => openFocus(item.id)}
                className="tech-transition block w-full border-b border-border/60 text-left hover:bg-secondary/40"
              >
                <WaitingRow item={item} who={g.label} nowMs={now} />
              </button>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

/** One waiting-for line: who · what · since-when, then the flags. `who` is
 *  repeated here (small, muted) so a row copied or read out of its group still
 *  carries all three facts §1 requires. */
function WaitingRow({
  item,
  who,
  nowMs,
}: {
  item: GtdItem;
  who: string;
  nowMs: number;
}) {
  const days = daysWaiting(item, nowMs);
  const overdue = isWaitingOverdue(item, nowMs);
  const stale = isStaleWaiting(item, nowMs);
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        {/* WHAT — the clarified next action if there is one, else the title. */}
        <p className="truncate text-[13px] text-foreground">
          {item.nextAction || item.title}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[10px] text-muted-foreground">{who}</span>
          {/* SINCE-WHEN — the age of the ask; the exact date on hover. */}
          {days === null ? (
            <span className="text-[10px] text-muted-foreground/70">
              no delegation date
            </span>
          ) : (
            <span
              title={`Delegated ${relativeTime(item.delegatedAt, nowMs)}`}
              className={[
                "inline-flex items-center gap-1 text-[10px]",
                stale ? "font-medium text-warning" : "text-muted-foreground",
              ].join(" ")}
            >
              <Hourglass className="h-3 w-3" />
              {days}d waiting
            </span>
          )}
          {item.expectedBy && (
            <span
              title={`Expected by ${new Date(item.expectedBy).toLocaleString()}`}
              className={[
                "inline-flex items-center gap-1 text-[10px]",
                overdue ? "font-medium text-destructive" : "text-muted-foreground",
              ].join(" ")}
            >
              {overdue ? (
                <AlertTriangle className="h-3 w-3" />
              ) : (
                <Clock className="h-3 w-3" />
              )}
              {relativeTime(item.expectedBy, nowMs)}
            </span>
          )}
          {item.origin?.kind === "email" && (
            <span
              title={`From email — ${item.origin.fromName || item.origin.fromEmail || ""}`}
              className="inline-flex items-center text-[10px] text-muted-foreground"
            >
              <Mail className="h-3 w-3" />
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {overdue && (
          <span className="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            Overdue
          </span>
        )}
        {stale && !overdue && (
          <span
            title={`No movement for over ${STALE_WAITING_DAYS} days`}
            className="rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
          >
            Stale
          </span>
        )}
        {/* Whether a nudge already went out — so the answer to an overdue row
            isn't "chase them again today". Written by the follow-up path,
            which is owner-gated and not built; NULL until then. */}
        {item.lastNudgedAt && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Send className="h-3 w-3" />
            nudged {relativeTime(item.lastNudgedAt, nowMs)}
          </span>
        )}
      </div>
    </div>
  );
}

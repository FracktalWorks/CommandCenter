"use client";

/**
 * Projects · the notification bell (WS-27j).
 *
 * §11.2's complaint is one sentence — *"assignment is silent"* — and this is
 * the surface that answers it. Unread count on the icon, a panel of rows, and
 * a click that opens the task.
 *
 * **Opening the panel does not mark anything read.** Marking on open is how a
 * tool loses a notification somebody glanced past on their way to something
 * else; the row clears when it is acted on, or when the whole list is
 * explicitly dismissed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import Button from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { domClickWalk, shouldDismiss } from "@/lib/outsideClick";

import { type NotificationRow, notificationsApi } from "../lib/api";
import {
  type UnreadSplit,
  afterRead,
  badge,
  describe,
  linkTo,
  order,
  unreadIds,
  unreadSplit,
} from "../lib/notifications";

/** How often the badge re-checks while the tab is open. */
const POLL_MS = 60_000;

export function NotificationBell({ onOpenTask }: {
  /** Opens a task in the page's own panel, so the bell never navigates away. */
  onOpenTask?: (taskId: string) => void;
}) {
  // WS-27ak(3) — `dismissAll` below was the only mutation in `/projects` that
  // reported NOTHING on either outcome. See its own note.
  const toast = useToast();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState<UnreadSplit>({ total: 0, mentions: 0 });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await notificationsApi.list();
      setRows(order(res.rows));
      setUnread(unreadSplit(res.unread));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (live) void load();
    };
    tick();
    // Polling, not a socket. A bell is a minute-scale surface, and a second
    // long-lived connection per tab is a cost this does not earn.
    const timer = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);

  // Click-away, so the panel behaves like every other popover in the app.
  //
  // WS-27al(2) — the containment test is now the shared walker, which also
  // honours `data-prevent-outside-click`. Nothing in /projects portals a
  // control out of this panel *yet*, so today the two behave identically; the
  // moment Wave 2's Combobox or date picker renders to `<body>`, containment
  // alone would say "outside" and close the panel under the thing you were
  // using. One answer, in `@/lib/outsideClick`, rather than one per popover.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (shouldDismiss(target, domClickWalk(box.current))) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const openRow = async (row: NotificationRow) => {
    setOpen(false);
    if (!row.read_at) {
      // Optimistic: the panel closes immediately, and a failed mark is a row
      // that reappears on the next poll rather than a click that did nothing.
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, read_at: new Date().toISOString() } : r,
        ),
      );
      setUnread((u) => afterRead(u, row.kind));
      try {
        await notificationsApi.markRead([row.id]);
      } catch {
        void load();
      }
    }
    if (onOpenTask) onOpenTask(row.task_id);
    else window.location.assign(linkTo(row));
  };

  /**
   * WS-27ak(3) — the third call site of the toast primitive, and the one that
   * reported **nothing at all**.
   *
   * The optimistic clear is what made it dangerous: the badge went to zero and
   * every dot cleared the instant it was clicked, so a refusal looked
   * *identical* to a success until the next sixty-second poll quietly put the
   * unread rows back. Neither outcome had a channel — the success wrote
   * nothing anywhere, and the failure was swallowed into a silent `load()`.
   *
   * The retry runs the SAME closure under the SAME key, which is what makes
   * this the honest demonstration of dedupe: the failed toast becomes the
   * retry's loading toast in place rather than a second toast beside it.
   * `markAllRead` is idempotent, so a retry is always safe.
   */
  const dismissAll = async () => {
    const ids = unreadIds(rows);
    if (!ids.length) return;
    setUnread({ total: 0, mentions: 0 });
    setRows((prev) =>
      prev.map((r) => (r.read_at ? r : { ...r, read_at: new Date().toISOString() })),
    );
    const run = async (): Promise<void> => {
      try {
        await toast.promise(notificationsApi.markAllRead(), {
          key: "projects:notifications-mark-all-read",
          loading: "Marking everything read…",
          // The server's count, not `ids.length`: another tab may have read
          // some of them already, and a number the reader can disprove is
          // worse than no number.
          success: ({ marked }) =>
            marked === 1 ? "1 notification marked read" : `${marked} notifications marked read`,
          error: "Couldn't mark your notifications read",
          errorAction: { label: "Retry", onClick: () => void run() },
        });
      } catch {
        // The optimistic clear is now a lie, so put the truth back. The toast
        // has already said what happened and stays up until dismissed.
        void load();
      }
    };
    await run();
  };

  const count = badge(unread.total);
  const mentionCount = badge(unread.mentions);

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        icon="Bell"
        aria-label={
          count
            ? `Notifications (${count} unread${
                mentionCount ? `, ${mentionCount} mentions` : ""
              })`
            : "Notifications"
        }
        onClick={() => setOpen((v) => !v)}
      />
      {count ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 text-[9px] font-medium leading-4 text-primary-foreground"
        >
          {count}
        </span>
      ) : null}
      {/* WS-27v: mentions get their own marker, below the total so the two
          never overlap. `@` rather than a second number at this size — the
          count itself is in the aria-label and the panel header. */}
      {mentionCount ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-0.5 -right-0.5 rounded-full bg-destructive px-1 text-[9px] font-semibold leading-4 text-destructive-foreground"
        >
          @
        </span>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-1 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">
              Notifications
              {unread.mentions > 0 ? (
                <span className="ml-1.5 rounded-full bg-destructive px-1.5 text-[10px] font-medium text-destructive-foreground">
                  {badge(unread.mentions)} @
                </span>
              ) : null}
            </span>
            {unread.total > 0 ? (
              <Button variant="text" size="sm" onClick={dismissAll}>
                Mark all read
              </Button>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="px-3 py-3 text-xs text-destructive">{error}</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                Nothing yet. You will hear about work assigned to you and
                comments that name you.
              </p>
            ) : (
              rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => openRow(row)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted"
                >
                  <span className="flex w-full items-start gap-1.5">
                    {/* The unread marker is a dot, not a bold row: bold text at
                        this size is hard to distinguish from a longer title. */}
                    <span
                      aria-hidden
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        row.read_at ? "bg-transparent" : "bg-primary"
                      }`}
                    />
                    <span className="min-w-0 flex-1 text-xs text-foreground">
                      {describe(row)}
                    </span>
                  </span>
                  {row.excerpt ? (
                    <span className="line-clamp-2 pl-3 text-[11px] text-muted-foreground">
                      {row.excerpt}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

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

import { type NotificationRow, notificationsApi } from "../lib/api";
import {
  badge,
  describe,
  linkTo,
  order,
  unreadIds,
} from "../lib/notifications";

/** How often the badge re-checks while the tab is open. */
const POLL_MS = 60_000;

export function NotificationBell({ onOpenTask }: {
  /** Opens a task in the page's own panel, so the bell never navigates away. */
  onOpenTask?: (taskId: string) => void;
}) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await notificationsApi.list();
      setRows(order(res.rows));
      setUnread(res.unread);
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
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
      }
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
      setUnread((n) => Math.max(0, n - 1));
      try {
        await notificationsApi.markRead([row.id]);
      } catch {
        void load();
      }
    }
    if (onOpenTask) onOpenTask(row.task_id);
    else window.location.assign(linkTo(row));
  };

  const dismissAll = async () => {
    const ids = unreadIds(rows);
    if (!ids.length) return;
    setUnread(0);
    setRows((prev) =>
      prev.map((r) => (r.read_at ? r : { ...r, read_at: new Date().toISOString() })),
    );
    try {
      await notificationsApi.markAllRead();
    } catch {
      void load();
    }
  };

  const count = badge(unread);

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        icon="Bell"
        aria-label={count ? `Notifications (${count} unread)` : "Notifications"}
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

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-1 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">
              Notifications
            </span>
            {unread > 0 ? (
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

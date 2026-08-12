"use client";

/**
 * WorkTimerDock — the running work session, visible from every screen.
 *
 * Spec: `ProjectApp_Plan.md` S5 / acceptance 38 ("a running timer is visible
 * from every screen") · API `GET /projects/work/current` (WS-27bg).
 *
 * Mounted in `AppShell` beside `FocusSession`, `RecordingDock` and `LiveDock`,
 * and shaped like them deliberately: a fourth floating dock with its own
 * geometry would be a fourth answer to "where does ambient session state
 * live". Same `z-[60]`, same bottom offsets, same card-on-blur treatment.
 *
 * ## The clock
 *
 * **The elapsed time is recomputed from `started_at`, never accumulated.** The
 * server returns the session's start; this ticks a local `now` once a second
 * and subtracts. That is what makes the timer survive a refresh, a navigation,
 * a sleeping laptop and a tab that was throttled in the background — all of
 * which break a counter that increments a number every second. `setInterval`
 * is a repaint trigger here, not the source of truth (plan §41, acceptance 22).
 *
 * ## Polling
 *
 * Every 30s, plus on focus and on `cc-work-session-changed`. The event is what
 * makes Start feel instant — the surface that started the session announces it
 * rather than making the dock wait out its interval. Polling remains as the
 * backstop for the case the brief calls out: somebody started work in another
 * tab, or on their phone, and this window must not keep claiming they are idle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";

/** Fired by any surface that starts, pauses or completes work. */
export const WORK_SESSION_CHANGED = "cc-work-session-changed";

/** Announce a session change so the dock updates without waiting for its poll. */
export function notifyWorkSessionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WORK_SESSION_CHANGED));
  }
}

interface CurrentSession {
  session: { id: string; started_at: string; running: boolean } | null;
  task: { id: string; title: string; task_number: number | null; project_name: string } | null;
}

/** `01:42:17` — hours only when there are any, seconds always, because a timer
 *  that does not visibly move looks broken. */
export function clockFace(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function WorkTimerDock() {
  const [state, setState] = useState<CurrentSession>({ session: null, task: null });
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();
  const pathname = usePathname();
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await fetch("/api/projects/work/current", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) return; // Signed out, or projects not granted — stay quiet.
      setState(await res.json());
    } catch {
      // Aborted or offline. The dock keeps showing the last known session
      // rather than blinking out — a timer that vanishes on a dropped packet
      // reads as lost work.
    }
  }, []);

  useEffect(() => {
    // Wrapped rather than called directly: the effect must not reach a
    // setState synchronously (react-hooks/set-state-in-effect), and `load` is
    // also invoked from the poll, focus and the change event, so it stays a
    // useCallback. Same shape as `settings/roles/page.tsx:56`.
    const run = async () => {
      await load();
    };
    void run();
    const poll = setInterval(load, 30_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(WORK_SESSION_CHANGED, load);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(WORK_SESSION_CHANGED, load);
      abort.current?.abort();
    };
  }, [load]);

  // The repaint tick. Only runs while something is actually running, so an
  // idle tab is not woken once a second forever.
  useEffect(() => {
    if (!state.session?.running) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [state.session?.running]);

  if (!state.session?.running || !state.task) return null;

  // Recomputed, not accumulated — see the header.
  const elapsed = Math.max(
    0,
    Math.floor((now - new Date(state.session.started_at).getTime()) / 1000),
  );

  // Defer to any surface that already shows this session. On the task's own
  // page the header carries the controls, and My Work draws a 3xl timer three
  // inches away — a floating copy is not redundancy, it is two clocks that can
  // disagree by a tick and make the reader check which one is right.
  const ownsTheTimer =
    pathname === "/projects/my-work" ||
    Boolean(pathname?.startsWith("/projects") && pathname.includes(state.task.id));
  if (ownsTheTimer) return null;

  return (
    <div
      className="chat-fade-in fixed inset-x-0 bottom-0 z-[60] pb-safe sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 sm:pb-0"
      role="status"
      aria-live="off"
    >
      <div className="flex items-center gap-2.5 border-t border-border bg-card/95 px-3 py-2 shadow-2xl backdrop-blur sm:rounded-xl sm:border">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
        </span>

        <button
          type="button"
          onClick={() => router.push(`/projects?task=${state.task!.id}`)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-xs font-medium text-foreground">
            {state.task.title}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {state.task.project_name}
          </p>
        </button>

        {/* `tabular-nums` so the width does not jitter as the digits change —
            a timer that shifts its neighbours every second is worse than none. */}
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {clockFace(elapsed)}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open this task"
          onClick={() => router.push(`/projects?task=${state.task!.id}`)}
        >
          <Icon name="ArrowUpRight" size={14} />
        </Button>
      </div>
    </div>
  );
}

export default WorkTimerDock;

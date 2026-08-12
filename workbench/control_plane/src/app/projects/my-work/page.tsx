"use client";

/**
 * My Work — the engineer's home.
 *
 * Spec: `ProjectApp_Plan.md` §15 (SCREEN 2) · API: WS-27bg's work routes.
 *
 * The plan's clearest instruction: **starting work must be one click from
 * here, with no navigation.** Everything below is arranged around that.
 *
 * ⚠️ **Naming collision, recorded rather than papered over.** `/projects` already
 * has a "My work" node in its tree — `app/projects/components/MyWork.tsx`, the
 * WS-27e GTD *triage* lens (disposition, context, defer). This is a different
 * surface: work *execution* (start, pause, complete, what is waiting on me).
 * Two things called "My Work" is a product defect, not a design; the plan
 * assigns this route (`/projects/my-work`) so it is built here, and the
 * reconciliation — rename one, or fold the triage lens in as a tab — is an
 * owner call recorded in `ProjectApp_Plan.md` §36 as D-OPEN-12.
 *
 * Reads three endpoints and no more: `/work/current` (the running session),
 * `/work/today` (tiles + schedule, one query so they cannot disagree), and
 * `/assigned-to-me` (up next + waiting on me, ranked client-side by a tested
 * pure function).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { clockFace, notifyWorkSessionChanged } from "@/components/WorkTimerDock";
import { useToast } from "@/components/ui/Toast";
import { accentForHue, type AccentHue } from "@/lib/statusAccent";

import {
  BlockerDialog,
  CompleteDialog,
  HandoffDialog,
  PauseDialog,
} from "../components/WorkDialogs";
import {
  type TaskLike,
  type TodaySession,
  rankUpNext,
  sessionHue,
  sessionState,
  timeRange,
  waitingOnMe,
} from "./lib/today";

interface CurrentPayload {
  session: { id: string; started_at: string; running: boolean } | null;
  task: { id: string; title: string; task_number: number | null; project_name: string } | null;
}

interface TodayPayload {
  sessions: TodaySession[];
  totals: {
    active: number;
    completed: number;
    paused: number;
    seconds: number;
    elapsed: string;
    runaway: number;
  };
}

const EMPTY_TODAY: TodayPayload = {
  sessions: [],
  totals: { active: 0, completed: 0, paused: 0, seconds: 0, elapsed: "0s", runaway: 0 },
};

export default function MyWorkPage() {
  const [current, setCurrent] = useState<CurrentPayload>({ session: null, task: null });
  const [today, setToday] = useState<TodayPayload>(EMPTY_TODAY);
  const [mine, setMine] = useState<TaskLike[]>([]);
  const [me, setMe] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Which dialog is up. One value, so two cannot open at once. */
  const [dialog, setDialog] = useState<"pause" | "complete" | "handoff" | "blocker" | null>(null);
  const router = useRouter();
  const toast = useToast();

  const load = useCallback(async () => {
    const [c, t, a, who] = await Promise.all([
      fetch("/api/projects/work/current", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/projects/work/today", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/projects/assigned-to-me?limit=100", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/auth/session", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (c) setCurrent(c);
    if (t) setToday(t);
    if (a?.rows) setMine(a.rows);
    // Signed out locally (no SSO configured) — the BFF still acts as the dev
    // identity, so fall back to it rather than rendering "waiting on me" empty.
    setMe(who?.user?.email ?? "dev@fracktal.in");
    setLoading(false);
  }, []);

  useEffect(() => {
    const run = async () => {
      await load();
    };
    void run();
    const onChange = () => load();
    window.addEventListener("cc-work-session-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener("cc-work-session-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [load]);

  useEffect(() => {
    if (!current.session?.running) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [current.session?.running]);

  const upNext = useMemo(
    () => rankUpNext(mine).filter((t) => t.id !== current.task?.id),
    [mine, current.task?.id],
  );
  const waiting = useMemo(() => waitingOnMe(mine, me), [mine, me]);

  const elapsed = current.session?.running
    ? Math.max(0, Math.floor((now - new Date(current.session.started_at).getTime()) / 1000))
    : 0;

  /** One click, no navigation — the whole point of the screen. */
  const start = async (task: TaskLike) => {
    setBusy(task.id);
    try {
      const res = await fetch(`/api/projects/tasks/${task.id}/work/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const detail = await res.text();
        toast.show({
          variant: "error",
          title: "Could not start work",
          description: detail.slice(0, 200),
        });
        return;
      }
      const body = await res.json();
      // `switched_from` is the server telling us it auto-paused something. Say
      // so — a stray click must not silently end a session the engineer was
      // counting on (plan §15).
      if (body.switched_from) {
        toast.show({
          variant: "success",
          title: "Switched task",
          description: "The session you had running was paused.",
        });
      }
      notifyWorkSessionChanged();
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <h1 className="shrink-0 text-xs font-medium text-muted-foreground">My Work</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Start, pause and finish the work assigned to you
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" icon="LayoutGrid" onClick={() => router.push("/projects")}>
            All projects
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-3 lg:grid-cols-3">
          {/* ── Currently working ─────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3 lg:col-span-1">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Currently working
            </h2>
            {loading ? (
              <SkeletonRows rows={1} height="h-24" />
            ) : current.session?.running && current.task ? (
              <div>
                <p className="truncate text-sm font-medium text-foreground">
                  {current.task.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {current.task.project_name}
                </p>
                <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                  {clockFace(elapsed)}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Started{" "}
                  {new Date(current.session.started_at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {/* Both need a remark the SERVER enforces, so they open
                      dialogs rather than posting from here. */}
                  <Button variant="secondary" size="sm" icon="Pause" onClick={() => setDialog("pause")}>
                    Pause
                  </Button>
                  {/* NOT destructive — the mock draws this red and red is the
                      danger colour. A success path must not wear it (D-OPEN-4). */}
                  <Button variant="primary" size="sm" icon="Check" onClick={() => setDialog("complete")}>
                    Complete
                  </Button>
                  <Button variant="ghost" size="sm" icon="ArrowRightLeft" onClick={() => setDialog("handoff")}>
                    Hand off
                  </Button>
                  <Button variant="ghost" size="sm" icon="OctagonAlert" onClick={() => setDialog("blocker")}>
                    Blocked
                  </Button>
                </div>
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                You have no active work. Pick something from Up next.
              </p>
            )}
          </section>

          {/* ── Up next ───────────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Up next
            </h2>
            {loading ? (
              <SkeletonRows rows={3} height="h-14" />
            ) : upNext.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nothing assigned to you is outstanding.
              </p>
            ) : (
              <ul className="space-y-2">
                {upNext.slice(0, 4).map((task) => (
                  <li key={task.id} className="rounded-md border border-border p-2">
                    <p className="truncate text-xs font-medium text-foreground">{task.title}</p>
                    {task.next_action ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {task.next_action}
                      </p>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="Play"
                      className="mt-2 w-full"
                      loading={busy === task.id}
                      onClick={() => start(task)}
                    >
                      Start
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Waiting on me ─────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Waiting on me
              {waiting.length > 0 ? (
                <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                  {waiting.length}
                </span>
              ) : null}
            </h2>
            {loading ? (
              <SkeletonRows rows={3} height="h-10" />
            ) : waiting.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nothing is waiting on you.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {waiting.slice(0, 5).map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/projects?task=${task.id}`)}
                      className="w-full rounded-md p-1.5 text-left hover:bg-muted tech-transition"
                    >
                      <p className="truncate text-xs text-foreground">{task.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {task.next_action}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* ── My today ─────────────────────────────────────────────────────── */}
        <h2 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          My today
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Active", value: today.totals.active },
            { label: "Completed", value: today.totals.completed },
            { label: "Paused", value: today.totals.paused },
            { label: "Total time", value: today.totals.elapsed },
          ].map((tile) => (
            <div key={tile.label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">{tile.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {tile.value}
              </p>
            </div>
          ))}
        </div>

        {today.totals.runaway > 0 ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-warning">
            <Icon name="TriangleAlert" size={13} />
            {today.totals.runaway} session{today.totals.runaway === 1 ? "" : "s"} ran over 12
            hours — the totals above include them.
          </p>
        ) : null}

        {/* ── Today's schedule ─────────────────────────────────────────────── */}
        <h2 className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Today&apos;s schedule
        </h2>
        <div className="rounded-lg border border-border bg-card">
          {loading ? (
            <div className="p-3">
              <SkeletonRows rows={3} height="h-9" />
            </div>
          ) : today.sessions.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No work recorded today yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {today.sessions.map((s) => {
                const accent = accentForHue(sessionHue(s) as AccentHue);
                return (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-foreground">{s.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {s.project_name}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${accent.soft} ${accent.text}`}>
                      {sessionState(s)}
                    </span>
                    <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                      {timeRange(s)}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-foreground">
                      {s.elapsed}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Mounted once, driven by one state value. `Modal` is controlled and
          holds no open state of its own, so the page stays the single source
          of truth for whether an overlay is up. */}
      {current.task ? (
        <>
          <PauseDialog
            open={dialog === "pause"}
            onClose={() => setDialog(null)}
            taskId={current.task.id}
            taskTitle={current.task.title}
            onDone={load}
          />
          <CompleteDialog
            open={dialog === "complete"}
            onClose={() => setDialog(null)}
            taskId={current.task.id}
            taskTitle={current.task.title}
            onDone={load}
          />
          <HandoffDialog
            open={dialog === "handoff"}
            onClose={() => setDialog(null)}
            taskId={current.task.id}
            taskTitle={current.task.title}
            onDone={load}
          />
          <BlockerDialog
            open={dialog === "blocker"}
            onClose={() => setDialog(null)}
            taskId={current.task.id}
            taskTitle={current.task.title}
            onDone={load}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * My Work's arithmetic — the parts that are decisions rather than markup.
 *
 * Spec: `ProjectApp_Plan.md` §15. Pure and colocated-tested, per that document's
 * own testing rule: "every `lib/` module pure and colocated-tested".
 */

export interface TodaySession {
  id: string;
  task_id: string;
  title: string;
  project_name: string;
  started_at: string;
  ended_at: string | null;
  seconds: number;
  elapsed: string;
  running: boolean;
  runaway: boolean;
  end_reason: string | null;
}

export interface TaskLike {
  id: string;
  title: string;
  due_at?: string | null;
  next_action?: string | null;
  next_action_owner?: string | null;
  importance?: number | null;
  health?: string | null;
  completed_at?: string | null;
}

/**
 * What a session row is called on screen.
 *
 * Derived from `end_reason`, which the work API already writes, rather than
 * from a second field nobody sets. `switched` is its own word on purpose — "you
 * paused this" and "this stopped because you started something else" are
 * different facts, and conflating them makes the schedule look like the
 * engineer pauses constantly.
 */
export function sessionState(s: Pick<TodaySession, "running" | "end_reason">): string {
  if (s.running) return "Working";
  switch (s.end_reason) {
    case "completed": return "Completed";
    case "handoff": return "Handed off";
    case "blocked": return "Blocked";
    case "switched": return "Switched";
    case "break": return "Break";
    default: return "Paused";
  }
}

/** The accent hue for that state, through the shared vocabulary's names. */
export function sessionHue(s: Pick<TodaySession, "running" | "end_reason">): string {
  if (s.running) return "green";
  switch (s.end_reason) {
    case "completed": return "green";
    case "blocked": return "red";
    case "handoff": return "violet";
    default: return "gray";
  }
}

/**
 * `10:12 AM – Now`, or `10:12 AM – 11:48 AM`.
 *
 * A running session reads "Now" rather than the current clock time, which would
 * tick inside a static row and draw the eye to the wrong thing — the big timer
 * is where the moving number belongs.
 */
export function timeRange(
  s: Pick<TodaySession, "started_at" | "ended_at">,
  locale?: string,
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `${fmt(s.started_at)} – ${s.ended_at ? fmt(s.ended_at) : "Now"}`;
}

/**
 * What to work on next, best first.
 *
 * Ranking, not filtering — the engineer sees the whole list and this only
 * decides the order. Four signals, in the order a person would actually weigh
 * them:
 *
 *   1. **overdue** beats everything;
 *   2. then a **due date**, soonest first — a thing due today outranks an
 *      urgent thing with no date, because the date is a promise to somebody;
 *   3. then **importance**, high first;
 *   4. then title, so the order is stable across reloads rather than shuffling
 *      on every fetch.
 *
 * Completed work is excluded outright: it is not "next".
 */
export function rankUpNext<T extends TaskLike>(tasks: T[], now: number = Date.now()): T[] {
  const score = (t: T) => {
    const due = t.due_at ? new Date(t.due_at).getTime() : null;
    return {
      overdue: due !== null && due < now ? 0 : 1,
      due: due ?? Number.MAX_SAFE_INTEGER,
      importance: -(t.importance ?? -1),
      title: t.title ?? "",
    };
  };
  return tasks
    .filter((t) => !t.completed_at)
    .map((t) => ({ t, s: score(t) }))
    .sort(
      (a, b) =>
        a.s.overdue - b.s.overdue ||
        a.s.due - b.s.due ||
        a.s.importance - b.s.importance ||
        a.s.title.localeCompare(b.s.title),
    )
    .map((x) => x.t);
}

/**
 * The work whose next move is MINE.
 *
 * Not "everything assigned to me" — that is the whole list and would make the
 * panel useless. A row qualifies when a next action exists and names me, which
 * is the only machine-readable statement in the model that somebody is waiting
 * on this person specifically.
 *
 * Case-insensitive on both sides: house rule R10, and `next_action_owner` is a
 * bare address string with whatever casing the writer used.
 */
export function waitingOnMe<T extends TaskLike>(tasks: T[], me: string): T[] {
  const mine = me.trim().toLowerCase();
  return tasks.filter(
    (t) =>
      !t.completed_at &&
      !!t.next_action &&
      (t.next_action_owner ?? "").trim().toLowerCase() === mine,
  );
}

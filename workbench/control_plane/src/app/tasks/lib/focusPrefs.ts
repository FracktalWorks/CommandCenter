// Focus-OS client prefs (calendar_focus_os.md F0/F1) — the per-day One Thing,
// tomorrow's plan seeds, ritual state (startup done / day closed / streak) and
// the Focus Mode timer preference. Deliberately localStorage-backed for the
// UI-first build: none of this blocks on a backend migration, and losing it
// costs at most one day's ceremony state. Server persistence can follow the
// same shape (see spec §5 settings deltas).

const KEY = "cc-tasks-focus-prefs";

export type FocusTimerMode = "pomo25" | "pomo50" | "flow";

export interface FocusPrefs {
  /** the ★ One Thing committed for a given local day. */
  oneThing?: { date: string; itemId: string };
  /** shutdown's "seed tomorrow" picks, keyed by the day they are FOR. */
  seeds?: { date: string; ids: string[] };
  /** last local day the startup ritual was completed/dismissed. */
  startupDoneOn?: string;
  /** consecutive-day startup streak (counted on completion, not dismissal). */
  startupStreak?: number;
  /** the day the streak was last incremented (guards double counting). */
  streakStampedOn?: string;
  /** last local day the shutdown "Close the day" was pressed. */
  dayClosedOn?: string;
  /** Focus Mode timer preference. */
  timerMode?: FocusTimerMode;
  /** Show/schedule across the full 24h day (vs the working-hours window) — for
   *  people who work whenever, not just 9-to-5. */
  fullDayGrid?: boolean;
}

/** Local-day key, e.g. "2026-07-22" (local time, matching the grid's days). */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function loadFocusPrefs(): FocusPrefs {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}") as FocusPrefs;
  } catch {
    return {};
  }
}

export function saveFocusPrefs(patch: Partial<FocusPrefs>): FocusPrefs {
  const next = { ...loadFocusPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode etc. — prefs just don't persist */
  }
  return next;
}

/** Today's One Thing id, or null if unset / set for another day. */
export function oneThingIdFor(day: Date, prefs = loadFocusPrefs()): string | null {
  return prefs.oneThing?.date === dayKey(day) ? prefs.oneThing.itemId : null;
}

/** Toggle the One Thing for `day` (setting the same id clears it). */
export function toggleOneThing(day: Date, itemId: string): FocusPrefs {
  const cur = loadFocusPrefs();
  const key = dayKey(day);
  const same = cur.oneThing?.date === key && cur.oneThing.itemId === itemId;
  return saveFocusPrefs({ oneThing: same ? undefined : { date: key, itemId } });
}

/** Seeds picked (during shutdown) FOR `day` — tomorrow's head start. */
export function seedsFor(day: Date, prefs = loadFocusPrefs()): string[] {
  return prefs.seeds?.date === dayKey(day) ? prefs.seeds.ids : [];
}

/** Complete the startup ritual for today: stamp the day + bump the streak
 *  (consecutive-day; a gap resets to 1). */
export function completeStartup(): FocusPrefs {
  const cur = loadFocusPrefs();
  const today = dayKey();
  if (cur.streakStampedOn === today)
    return saveFocusPrefs({ startupDoneOn: today });
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const streak =
    cur.streakStampedOn === yesterday ? (cur.startupStreak ?? 0) + 1 : 1;
  return saveFocusPrefs({
    startupDoneOn: today,
    startupStreak: streak,
    streakStampedOn: today,
  });
}

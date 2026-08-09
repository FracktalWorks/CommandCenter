/**
 * WS-27q — the calendar grid, as arithmetic.
 *
 * A calendar bug is almost never a crash. It is a task on the wrong Tuesday,
 * which looks completely normal, so every claim here is one that a plausible
 * implementation gets wrong silently:
 *
 * * **`new Date("2026-08-07")` is midnight UTC**, which is the 6th anywhere
 *   west of Greenwich. Routing a `start_date` through it is the single most
 *   common way a calendar loses a day, and nothing about the result looks
 *   broken.
 * * **a bar occupies every day it covers.** A task running Monday to Friday
 *   that appears only on Friday is exactly how somebody looks at Wednesday and
 *   concludes they are free.
 * * **dragging a bar moves the whole bar.** Writing only the dropped date
 *   leaves the other end behind, and inverts the interval the moment you drag
 *   left — a data corruption that reads as a rendering glitch.
 * * **the requested window carries a day of slack.** Without it a viewer in
 *   UTC+5:30 loses every task due in the first 5½ hours of the grid.
 *
 * These run with the process timezone as configured for vitest; the assertions
 * are written so they hold in any of them — day keys are compared to day keys,
 * never to a formatted instant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TaskRow } from "./api";
import {
  calendarWindow,
  dayKey,
  fromDayKey,
  isOutsideMonth,
  monthGrid,
  monthLabel,
  placeTasks,
  rescheduleTo,
  shiftDay,
  shiftMonth,
  taskDays,
} from "./calendar";

const AUGUST = monthGrid(new Date(2026, 7, 1));

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  project_id: "p1",
  root_project_id: "p1",
  status_id: "s1",
  title: "Ship it",
  ...over,
});

/** A local-midnight instant for a day key, so `due_at` fixtures are timezone
 *  independent — the same trap the module itself avoids. */
const localNoon = (key: string) => {
  const d = fromDayKey(key);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

// ── day keys ────────────────────────────────────────────────────────────────

describe("dayKey / fromDayKey", () => {
  it("round-trips a date through its key", () => {
    expect(dayKey(fromDayKey("2026-08-07"))).toBe("2026-08-07");
  });

  it("reads the LOCAL day, not the UTC one", () => {
    // ⚠️ `toISOString().slice(0,10)` is the wrong implementation and passes in
    // UTC. A local-midnight Date must key as its own day in every timezone.
    const midnight = new Date(2026, 7, 7, 0, 0, 0);
    expect(dayKey(midnight)).toBe("2026-08-07");
    const almostMidnight = new Date(2026, 7, 7, 23, 59, 0);
    expect(dayKey(almostMidnight)).toBe("2026-08-07");
  });

  it("pads single-digit months and days", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("shiftDay", () => {
  it("rolls over a month boundary", () => {
    expect(shiftDay("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftDay("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("rolls over a year boundary", () => {
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
  });
});

// ── the grid ────────────────────────────────────────────────────────────────

describe("monthGrid", () => {
  it("covers the whole month", () => {
    expect(AUGUST.days).toContain("2026-08-01");
    expect(AUGUST.days).toContain("2026-08-31");
    expect(AUGUST.month).toBe("2026-08");
  });

  it("starts on a Monday and ends on a Sunday", () => {
    // ⚠️ A grid whose weekend is split across two rows makes "what is left
    // this week" something you count instead of see.
    expect(fromDayKey(AUGUST.days[0]).getDay()).toBe(1);
    expect(fromDayKey(AUGUST.days[AUGUST.days.length - 1]).getDay()).toBe(0);
  });

  it("is always whole weeks of seven", () => {
    expect(AUGUST.days.length % 7).toBe(0);
    expect(AUGUST.weeks.every((w) => w.length === 7)).toBe(true);
    expect(AUGUST.weeks.flat()).toEqual(AUGUST.days);
  });

  it("pads to the week boundary rather than to a fixed six rows", () => {
    // ⚠️ A fixed six rows shows an entire extra week of March for a February
    // that starts on a Monday. February 2027 starts on a Monday and has 28
    // days: exactly four weeks, and no padding at all is correct.
    const february = monthGrid(new Date(2027, 1, 1));
    expect(february.weeks).toHaveLength(4);
    expect(february.days[0]).toBe("2027-02-01");
    expect(february.days[february.days.length - 1]).toBe("2027-02-28");
  });

  it("pads a month that starts on a Sunday from the Monday before", () => {
    // The worst case for a Monday week: one leading day short of a full week.
    const november = monthGrid(new Date(2026, 10, 1));
    expect(november.days[0]).toBe("2026-10-26");
    expect(november.days).toContain("2026-11-01");
  });

  it("labels itself in words", () => {
    expect(monthLabel(AUGUST)).toBe("August 2026");
    expect(monthLabel(monthGrid(new Date(2026, 0, 1)))).toBe("January 2026");
    expect(monthLabel(monthGrid(new Date(2026, 11, 1)))).toBe("December 2026");
  });

  it("knows which of its days belong to a neighbour", () => {
    expect(isOutsideMonth("2026-07-31", AUGUST)).toBe(true);
    expect(isOutsideMonth("2026-08-01", AUGUST)).toBe(false);
  });
});

describe("shiftMonth", () => {
  it("steps a month at a time without landing on the 31st of February", () => {
    // ⚠️ `setMonth(+1)` on the 31st gives March 3rd. Anchoring on the 1st is
    // what keeps "next month" from skipping one.
    const january31 = monthGrid(new Date(2026, 0, 31));
    expect(monthGrid(shiftMonth(january31, 1)).month).toBe("2026-02");
  });

  it("steps across a year in both directions", () => {
    expect(monthGrid(shiftMonth(monthGrid(new Date(2026, 11, 1)), 1)).month)
      .toBe("2027-01");
    expect(monthGrid(shiftMonth(monthGrid(new Date(2026, 0, 1)), -1)).month)
      .toBe("2025-12");
  });
});

// ── the requested window ────────────────────────────────────────────────────

describe("calendarWindow", () => {
  it("asks for a day of slack on each side", () => {
    // ⚠️ The contract with the server, not defensive padding: the endpoint
    // reads the window in UTC and over-selects, and the browser places. Drop
    // the slack and a viewer at UTC+5:30 loses the grid's first morning.
    const { from, to } = calendarWindow(AUGUST);
    expect(from).toBe(shiftDay(AUGUST.days[0], -1));
    expect(to).toBe(shiftDay(AUGUST.days[AUGUST.days.length - 1], 2));
  });

  it("names an exclusive end past the last drawn day", () => {
    // Half-open, matching the endpoint: the last grid day must be strictly
    // inside the window, or its tasks never arrive.
    const { to } = calendarWindow(AUGUST);
    expect(to > AUGUST.days[AUGUST.days.length - 1]).toBe(true);
  });
});

// ── placement ───────────────────────────────────────────────────────────────

describe("taskDays", () => {
  it("puts a due-date-only task on its own day", () => {
    expect(taskDays(task({ due_at: localNoon("2026-08-14") }), AUGUST))
      .toEqual(["2026-08-14"]);
  });

  it("takes a start_date as written rather than through a Date", () => {
    // ⚠️ THE timezone trap. `new Date("2026-08-03")` is midnight UTC, which is
    // August 2nd in every timezone west of Greenwich.
    expect(taskDays(task({ start_date: "2026-08-03" }), AUGUST))
      .toEqual(["2026-08-03"]);
  });

  it("never routes a start_date through the Date constructor", () => {
    // ⚠️ Structural, because the behavioural version of this claim only fails
    // WEST of Greenwich: in UTC — and everywhere east of it — `new Date(
    // "2026-08-03")` happens to key as the 3rd anyway, so the test above
    // passes with the bug in place. CI runs in one timezone, so without this
    // the mutation that reintroduces the trap survives forever.
    const source = readFileSync(
      fileURLToPath(new URL("./calendar.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/new Date\(\s*(task\.)?start_?[Dd]ate/);
    expect(source).not.toMatch(/new Date\(\s*startKey/);
  });

  it("spans every day between start and due", () => {
    // ⚠️ The reason the endpoint filters on overlap. A Monday-to-Friday task
    // that shows only on Friday is how somebody looks at Wednesday and
    // concludes they are free.
    expect(
      taskDays(
        task({ start_date: "2026-08-10", due_at: localNoon("2026-08-14") }),
        AUGUST,
      ),
    ).toEqual([
      "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
    ]);
  });

  it("clamps a bar that runs past both edges of the grid", () => {
    const days = taskDays(
      task({ start_date: "2026-06-01", due_at: localNoon("2026-12-01") }),
      AUGUST,
    );
    expect(days).toEqual(AUGUST.days);
  });

  it("places nothing for a task with no dates", () => {
    // ⚠️ Falling back to today would put a task on a day nobody scheduled it
    // for, which is worse than its absence — the view counts those separately.
    expect(taskDays(task(), AUGUST)).toEqual([]);
  });

  it("places nothing for a bar entirely outside the grid", () => {
    expect(
      taskDays(
        task({ start_date: "2026-01-01", due_at: localNoon("2026-01-05") }),
        AUGUST,
      ),
    ).toEqual([]);
  });

  it("shows a backwards interval rather than swallowing the task", () => {
    // Bad data — due before start. Rendering nothing would hide a task from
    // the only view that would have shown the problem.
    const days = taskDays(
      task({ start_date: "2026-08-20", due_at: localNoon("2026-08-18") }),
      AUGUST,
    );
    expect(days[0]).toBe("2026-08-18");
    expect(days[days.length - 1]).toBe("2026-08-20");
  });
});

describe("placeTasks", () => {
  it("gives every grid day a bucket, empty or not", () => {
    const byDay = placeTasks([], AUGUST);
    expect([...byDay.keys()]).toEqual(AUGUST.days);
    expect([...byDay.values()].every((v) => v.length === 0)).toBe(true);
  });

  it("puts a bar in every cell it covers, not only the first", () => {
    const bar = task({
      id: "bar", start_date: "2026-08-10", due_at: localNoon("2026-08-12"),
    });
    const byDay = placeTasks([bar], AUGUST);
    expect(byDay.get("2026-08-10")).toHaveLength(1);
    expect(byDay.get("2026-08-11")).toHaveLength(1);
    expect(byDay.get("2026-08-12")).toHaveLength(1);
    expect(byDay.get("2026-08-13")).toHaveLength(0);
  });

  it("drops a task the grid does not reach without losing the others", () => {
    const near = task({ id: "near", due_at: localNoon("2026-08-05") });
    const far = task({ id: "far", due_at: localNoon("2027-01-05") });
    const byDay = placeTasks([near, far], AUGUST);
    expect(byDay.get("2026-08-05")?.map((t) => t.id)).toEqual(["near"]);
    expect([...byDay.values()].flat().map((t) => t.id)).toEqual(["near"]);
  });
});

// ── rescheduling ────────────────────────────────────────────────────────────

describe("rescheduleTo", () => {
  it("moves a due-date-only task and keeps its time of day", () => {
    // "Due Friday at 5" dragged to Monday is due Monday at 5.
    const at5 = fromDayKey("2026-08-14");
    at5.setHours(17, 30, 0, 0);
    const patch = rescheduleTo(task({ due_at: at5.toISOString() }), "2026-08-10");
    expect(patch).not.toBeNull();
    expect(patch?.start_date).toBeUndefined();
    const moved = new Date(patch?.due_at as string);
    expect(dayKey(moved)).toBe("2026-08-10");
    expect([moved.getHours(), moved.getMinutes()]).toEqual([17, 30]);
  });

  it("moves a start-date-only task", () => {
    expect(rescheduleTo(task({ start_date: "2026-08-03" }), "2026-08-06"))
      .toEqual({ start_date: "2026-08-06" });
  });

  it("moves the WHOLE bar and preserves its length", () => {
    // ⚠️ The rule every calendar-drag gets wrong first. Writing only the
    // dropped date leaves the other end behind and inverts the interval the
    // moment you drag left.
    const patch = rescheduleTo(
      task({ start_date: "2026-08-10", due_at: localNoon("2026-08-14") }),
      "2026-08-12",
    );
    expect(patch?.start_date).toBe("2026-08-12");
    expect(dayKey(new Date(patch?.due_at as string))).toBe("2026-08-16");
  });

  it("keeps the span when dragged backwards", () => {
    const patch = rescheduleTo(
      task({ start_date: "2026-08-10", due_at: localNoon("2026-08-14") }),
      "2026-08-05",
    );
    expect(patch?.start_date).toBe("2026-08-05");
    expect(dayKey(new Date(patch?.due_at as string))).toBe("2026-08-09");
  });

  it("anchors on the START of a bar, so dropping on its own start is a no-op", () => {
    expect(
      rescheduleTo(
        task({ start_date: "2026-08-10", due_at: localNoon("2026-08-14") }),
        "2026-08-10",
      ),
    ).toBeNull();
  });

  it("writes nothing when the task is already on that day", () => {
    // ⚠️ An activity row saying a task moved from Tuesday to Tuesday is noise
    // in the one place people go to find out what changed.
    expect(rescheduleTo(task({ due_at: localNoon("2026-08-14") }), "2026-08-14"))
      .toBeNull();
  });

  it("refuses to schedule a task that has no dates at all", () => {
    // Dropping an undated task on a day is a reasonable feature and a
    // different one: it must decide which of the two dates it is setting, and
    // guessing here would set whichever the implementation happened to prefer.
    expect(rescheduleTo(task(), "2026-08-14")).toBeNull();
  });

  it("crosses a month boundary in both directions", () => {
    expect(rescheduleTo(task({ start_date: "2026-08-31" }), "2026-09-02"))
      .toEqual({ start_date: "2026-09-02" });
    expect(rescheduleTo(task({ start_date: "2026-09-01" }), "2026-08-30"))
      .toEqual({ start_date: "2026-08-30" });
  });
});

/**
 * WS-27t — the timeline's arithmetic and its two decided rules.
 *
 * The claims that matter here are not "does the bar render". They are the ones
 * where a plausible implementation is wrong in a way that looks fine:
 *
 * * **a bar covers its last day.** Stopping at the last day's left edge makes a
 *   one-day task a zero-width line and every span one day short — a chart that
 *   is subtly, consistently lying about durations.
 * * **equal dates are not a conflict** (D-PM-12). A blocker due the 10th and a
 *   task starting the 10th is the normal way people schedule a handover.
 *   Flagging it fires the warning on half a healthy plan, after which nobody
 *   reads it.
 * * **a subtask whose parent is off-window is promoted, not hidden.** Hiding it
 *   makes a filtered timeline silently drop work.
 * * **a parent with no dates borrows its children's span**, and says it did.
 *   Without that the depth-grouped default view looks empty for exactly the
 *   projects that use subtasks properly.
 * * **the cycle check is NOT reimplemented here.** `assert_no_block_cycle` owns
 *   it; a browser copy is the one that drifts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TaskRow } from "./api";
import { fromDayKey } from "./calendar";
import {
  MIN_BAR_PX,
  PAD_DAYS,
  PX_PER_DAY,
  ROW_H,
  bar,
  canLink,
  conflictLabel,
  conflicts,
  dayPx,
  edgePath,
  interval,
  monthCells,
  rowInterval,
  timelineRange,
  timelineRows,
} from "./timeline";

/** The module's own source, with comments stripped.
 *
 *  Stripped because these assertions are about what the CODE does, and this
 *  module's prose is dense enough that "stays readable while it is wrong"
 *  matched a search for a `while` loop. A structural test that trips on its own
 *  documentation is a test people delete. */
const SOURCE = readFileSync(
  fileURLToPath(new URL("./timeline.ts", import.meta.url)),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  project_id: "p1",
  root_project_id: "p1",
  status_id: "s1",
  title: "Ship it",
  ...over,
});

/** A local-noon instant for a day key, so `due_at` fixtures are timezone-proof. */
const at = (key: string) => {
  const d = fromDayKey(key);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
};

const RANGE = timelineRange(
  [{ task: task({ start_date: "2026-08-01", due_at: at("2026-08-31") }), depth: 0, children: [] }],
  "2026-08-15",
);

// ── interval ────────────────────────────────────────────────────────────────

describe("interval", () => {
  it("spans start to due", () => {
    expect(interval(task({ start_date: "2026-08-03", due_at: at("2026-08-07") })))
      .toEqual({ from: "2026-08-03", to: "2026-08-07" });
  });

  it("is a point when only one date is known", () => {
    expect(interval(task({ start_date: "2026-08-03" })))
      .toEqual({ from: "2026-08-03", to: "2026-08-03" });
    expect(interval(task({ due_at: at("2026-08-07") })))
      .toEqual({ from: "2026-08-07", to: "2026-08-07" });
  });

  it("is null when the task has no dates", () => {
    expect(interval(task())).toBeNull();
  });

  it("normalises a backwards interval rather than dropping the task", () => {
    // The timeline is the one view that makes bad data obvious. Returning null
    // would hide exactly the task somebody needs to see.
    expect(interval(task({ start_date: "2026-08-20", due_at: at("2026-08-18") })))
      .toEqual({ from: "2026-08-18", to: "2026-08-20" });
  });

  it("never routes a start_date through the Date constructor", () => {
    // ⚠️ Structural, because the behavioural version only fails WEST of
    // Greenwich and CI runs one timezone — the lesson from WS-27q.
    expect(SOURCE).not.toMatch(/new Date\(\s*(task\.)?start_?[Dd]ate/);
  });
});

// ── rowInterval — D-PM-11's roll-up ─────────────────────────────────────────

describe("rowInterval", () => {
  it("prefers the task's own dates over its children's", () => {
    expect(
      rowInterval(task({ start_date: "2026-08-01", due_at: at("2026-08-02") }), [
        task({ id: "c", start_date: "2026-01-01", due_at: at("2026-12-31") }),
      ]),
    ).toEqual({ from: "2026-08-01", to: "2026-08-02", derived: false });
  });

  it("borrows the children's span when the parent has no dates", () => {
    // ⚠️ Without this a depth-grouped timeline looks EMPTY for exactly the
    // projects that use subtasks properly.
    expect(
      rowInterval(task(), [
        task({ id: "a", start_date: "2026-08-04", due_at: at("2026-08-06") }),
        task({ id: "b", start_date: "2026-08-02", due_at: at("2026-08-09") }),
      ]),
    ).toEqual({ from: "2026-08-02", to: "2026-08-09", derived: true });
  });

  it("marks a borrowed span as derived so the UI can say so", () => {
    const derived = rowInterval(task(), [task({ id: "a", start_date: "2026-08-04" })]);
    expect(derived?.derived).toBe(true);
  });

  it("ignores children that have no dates of their own", () => {
    expect(
      rowInterval(task(), [
        task({ id: "a" }),
        task({ id: "b", start_date: "2026-08-04" }),
      ]),
    ).toEqual({ from: "2026-08-04", to: "2026-08-04", derived: true });
  });

  it("is null when neither the parent nor any child has a date", () => {
    expect(rowInterval(task(), [task({ id: "a" })])).toBeNull();
  });
});

// ── timelineRows — D-PM-11's scoping ────────────────────────────────────────

describe("timelineRows", () => {
  it("gives every top-level task a row", () => {
    const rows = timelineRows([task({ id: "a" }), task({ id: "b" })]);
    expect(rows.map((r) => r.task.id)).toEqual(["a", "b"]);
  });

  it("folds a subtask under its parent instead of giving it a row", () => {
    const rows = timelineRows([
      task({ id: "parent" }),
      task({ id: "kid", parent_task_id: "parent" }),
    ]);
    expect(rows.map((r) => r.task.id)).toEqual(["parent"]);
    expect(rows[0].children.map((c) => c.id)).toEqual(["kid"]);
  });

  it("promotes a subtask whose parent is not in the window", () => {
    // ⚠️ Hidden, a filtered timeline silently drops work — the `undated`
    // failure one level down.
    const rows = timelineRows([task({ id: "orphan", parent_task_id: "elsewhere" })]);
    expect(rows.map((r) => r.task.id)).toEqual(["orphan"]);
    expect(rows[0].children).toEqual([]);
  });

  it("keeps the order it was given, which is the server's", () => {
    const rows = timelineRows([
      task({ id: "c" }), task({ id: "a" }), task({ id: "b" }),
    ]);
    expect(rows.map((r) => r.task.id)).toEqual(["c", "a", "b"]);
  });

  it("handles a task that claims itself as its parent", () => {
    // The gateway refuses this (assert_no_task_cycle), so it can only arrive
    // from corrupt data — and an infinite loop in the renderer is a worse
    // outcome than a row.
    const rows = timelineRows([task({ id: "a", parent_task_id: "a" })]);
    expect(rows.map((r) => r.task.id)).toEqual([]);
  });
});

// ── the range and the axis ──────────────────────────────────────────────────

describe("timelineRange", () => {
  it("pads the data's own span on both sides", () => {
    const range = timelineRange(
      [{ task: task({ start_date: "2026-08-10", due_at: at("2026-08-20") }), depth: 0, children: [] }],
      "2026-08-15",
    );
    expect(range.from).toBe("2026-08-03");
    expect(range.to).toBe("2026-08-27");
    expect(range.days).toBe(10 + 1 + PAD_DAYS * 2);
  });

  it("falls back to a fortnight around today when nothing is dated", () => {
    // An empty chart still needs an axis to read, and a zero-width one cannot
    // render at all.
    const range = timelineRange(
      [{ task: task(), depth: 0, children: [] }],
      "2026-08-15",
    );
    expect(range.from).toBe("2026-08-01");
    expect(range.to).toBe("2026-08-29");
    expect(range.widthPx).toBeGreaterThan(0);
  });

  it("covers a child's dates when only the child has them", () => {
    const range = timelineRange(
      [{ task: task(), depth: 0, children: [task({ id: "c", start_date: "2026-09-10" })] }],
      "2026-08-15",
    );
    expect(range.from <= "2026-09-10").toBe(true);
    expect(range.to >= "2026-09-10").toBe(true);
  });

  it("measures its width from its own day count", () => {
    expect(RANGE.widthPx).toBe(RANGE.days * PX_PER_DAY);
  });
});

describe("dayPx", () => {
  it("puts the first day at zero", () => {
    expect(dayPx(RANGE.from, RANGE)).toBe(0);
  });

  it("advances one day at a time", () => {
    expect(dayPx("2026-07-26", RANGE) - dayPx("2026-07-25", RANGE)).toBe(PX_PER_DAY);
  });

  it("survives a DST boundary without drifting a day", () => {
    // ⚠️ Millisecond arithmetic across a DST change is 23 or 25 hours, so an
    // unrounded division lands a fraction of a day off for every day after the
    // transition — and stays wrong for the rest of the chart.
    //
    // The range must STRADDLE a transition for this to bite: February to
    // August crosses the spring-forward in every northern DST zone, whereas
    // two days either side of midsummer are in the same regime and would pass
    // with the rounding removed. That was the first version of this test.
    const range = timelineRange(
      [{ task: task({ start_date: "2026-02-01", due_at: at("2026-08-31") }), depth: 0, children: [] }],
      "2026-05-01",
    );
    expect(dayPx("2026-08-02", range) - dayPx("2026-08-01", range)).toBe(PX_PER_DAY);
    expect(dayPx(range.to, range) + PX_PER_DAY).toBe(range.widthPx);
    expect(dayPx("2026-08-01", range) % PX_PER_DAY).toBe(0);
  });

  it("rounds the day count rather than trusting the millisecond division", () => {
    // ⚠️ Structural, and needed for the same reason as the `start_date` trap:
    // the behavioural test above can only fail in a timezone that HAS daylight
    // saving. In UTC — which is what CI runs — the drift is exactly zero and
    // the bug is invisible.
    const body = SOURCE.slice(SOURCE.indexOf("export function dayPx"));
    expect(body.slice(0, 300)).toContain("Math.round(");
  });
});

describe("monthCells", () => {
  it("labels each month once, in order", () => {
    const cells = monthCells(RANGE);
    expect(cells.map((c) => c.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(cells[1].label).toBe("Aug 2026");
  });

  it("tiles the whole width with no gaps or overlaps", () => {
    // ⚠️ A clipped first cell is the easy bug: the range starts mid-July, so
    // that cell is short and every later cell shifts if it is not.
    const cells = monthCells(RANGE);
    expect(cells[0].px).toBe(0);
    for (let i = 1; i < cells.length; i += 1) {
      expect(cells[i].px).toBe(cells[i - 1].px + cells[i - 1].widthPx);
    }
    const last = cells[cells.length - 1];
    expect(last.px + last.widthPx).toBe(RANGE.widthPx);
  });

  it("handles a range inside a single month", () => {
    const range = timelineRange(
      [{ task: task({ start_date: "2026-08-10", due_at: at("2026-08-12") }), depth: 0, children: [] }],
      "2026-08-11",
    );
    const cells = monthCells(range);
    expect(cells.map((c) => c.key)).toEqual(["2026-08"]);
    expect(cells[0].widthPx).toBe(range.widthPx);
  });

  it("crosses a year boundary", () => {
    const range = timelineRange(
      [{ task: task({ start_date: "2026-12-20", due_at: at("2027-01-10") }), depth: 0, children: [] }],
      "2026-12-25",
    );
    expect(monthCells(range).map((c) => c.key)).toEqual(["2026-12", "2027-01"]);
  });
});

// ── bars ────────────────────────────────────────────────────────────────────

describe("bar", () => {
  it("covers the LAST day, not up to its left edge", () => {
    // ⚠️ The off-by-one that makes every span one day short and a one-day task
    // a zero-width line. Aug 10–12 is three days of chart.
    const drawn = bar(
      task({ start_date: "2026-08-10", due_at: at("2026-08-12") }), [], RANGE,
    );
    expect(drawn?.widthPx).toBe(3 * PX_PER_DAY);
  });

  it("draws a single-date task at least wide enough to click", () => {
    const drawn = bar(task({ due_at: at("2026-08-12") }), [], RANGE);
    expect(drawn?.singleDate).toBe(true);
    expect(drawn?.widthPx).toBeGreaterThanOrEqual(MIN_BAR_PX);
  });

  it("starts where the range says its first day starts", () => {
    const drawn = bar(task({ start_date: "2026-08-10" }), [], RANGE);
    expect(drawn?.leftPx).toBe(dayPx("2026-08-10", RANGE));
  });

  it("is null for a task with no dates and no dated children", () => {
    expect(bar(task(), [], RANGE)).toBeNull();
  });

  it("marks a bar borrowed from children as derived", () => {
    const drawn = bar(task(), [task({ id: "c", start_date: "2026-08-11" })], RANGE);
    expect(drawn?.derived).toBe(true);
  });
});

// ── D-PM-12 — the conflict rule ─────────────────────────────────────────────

describe("conflicts", () => {
  const blocker = (over: Partial<TaskRow> = {}) => task({ id: "blocker", ...over });
  const blocked = (over: Partial<TaskRow> = {}) => task({ id: "blocked", ...over });

  it("fires when the blocker finishes after the blocked task starts", () => {
    expect(
      conflicts(
        blocker({ start_date: "2026-08-01", due_at: at("2026-08-12") }),
        blocked({ start_date: "2026-08-10", due_at: at("2026-08-20") }),
      ),
    ).toBe(true);
  });

  it("does NOT fire when they merely touch", () => {
    // ⚠️ The decision that keeps the warning worth reading. A blocker due the
    // 10th and a task starting the 10th is a normal handover; flagging it
    // fires on half a healthy plan.
    expect(
      conflicts(
        blocker({ due_at: at("2026-08-10") }),
        blocked({ start_date: "2026-08-10" }),
      ),
    ).toBe(false);
  });

  it("does not fire on a well-ordered pair", () => {
    expect(
      conflicts(
        blocker({ due_at: at("2026-08-05") }),
        blocked({ start_date: "2026-08-10" }),
      ),
    ).toBe(false);
  });

  it("does not fire when either end has no dates", () => {
    // ⚠️ A warning that fires on absent data teaches people it means nothing.
    expect(conflicts(blocker(), blocked({ start_date: "2026-08-01" }))).toBe(false);
    expect(conflicts(blocker({ due_at: at("2026-08-20") }), blocked())).toBe(false);
  });

  it("never fires for a finished blocker", () => {
    // WS-27p: a resolved blocker blocks nothing. The same rule, applied to the
    // warning rather than to the badge.
    expect(
      conflicts(
        blocker({ due_at: at("2026-08-20"), completed_at: at("2026-08-01") }),
        blocked({ start_date: "2026-08-10" }),
      ),
    ).toBe(false);
  });

  it("uses the blocker's END, not its start", () => {
    // A blocker STARTING after the blocked task is fine as long as it finishes
    // first — unusual, but not a contradiction the chart should shout about.
    expect(
      conflicts(
        blocker({ start_date: "2026-08-12", due_at: at("2026-08-12") }),
        blocked({ start_date: "2026-08-14" }),
      ),
    ).toBe(false);
  });

  it("says what happened and that nothing was moved", () => {
    // ⚠️ D-PM-12 chose warn-over-push. The sentence has to say so, or users
    // assume the tool fixed it.
    const label = conflictLabel("Design sign-off");
    expect(label).toContain("Design sign-off");
    expect(label.toLowerCase()).toContain("nothing has been rescheduled");
  });

  it("writes nothing — the module holds no PATCH or reschedule", () => {
    // ⚠️ The structural half of D-PM-12. A later "helpful" auto-push would be
    // a decision reversal, not a refactor, and this is what makes it visible.
    expect(SOURCE).not.toMatch(/patchTask|projectsApi|fetch\(/);
  });
});

// ── arrows ──────────────────────────────────────────────────────────────────

describe("edgePath", () => {
  const barAt = (leftPx: number, widthPx: number) =>
    ({ leftPx, widthPx, singleDate: false, derived: false });

  it("routes forwards when there is room", () => {
    const d = edgePath(
      { bar: barAt(0, 50), row: 0 },
      { bar: barAt(200, 50), row: 2 },
    );
    expect(d).toBe(`M 50 ${ROW_H / 2} H 125 V ${2 * ROW_H + ROW_H / 2} H 200`);
  });

  it("routes around when the target starts before the source ends", () => {
    // The conflict geometry: a straight path would run backwards through both
    // bars. It stays readable while it is wrong.
    const d = edgePath(
      { bar: barAt(100, 100), row: 0 },
      { bar: barAt(120, 60), row: 1 },
    ) as string;
    expect(d.split("V").length).toBe(3);
    expect(d.startsWith("M 200")).toBe(true);
    expect(d.endsWith("H 120")).toBe(true);
  });

  it("is null when either end has no bar", () => {
    // ⚠️ An arrow to an undated task has nowhere to land, and drawing it to the
    // row's margin invents a date the task does not have.
    expect(edgePath({ bar: null, row: 0 }, { bar: barAt(0, 10), row: 1 })).toBeNull();
    expect(edgePath({ bar: barAt(0, 10), row: 0 }, { bar: null, row: 1 })).toBeNull();
  });

  it("centres on the row, so the arrow meets the middle of a bar", () => {
    const d = edgePath(
      { bar: barAt(0, 10), row: 3 },
      { bar: barAt(500, 10), row: 3 },
    ) as string;
    expect(d).toContain(`M 10 ${3 * ROW_H + ROW_H / 2}`);
  });
});

// ── canLink ─────────────────────────────────────────────────────────────────

describe("canLink", () => {
  it("allows a fresh dependency", () => {
    expect(canLink("a", "b", [])).toEqual({ ok: true });
  });

  it("refuses a task blocking itself", () => {
    expect(canLink("a", "a", [])).toEqual({
      ok: false,
      reason: "A task cannot block itself.",
    });
  });

  it("refuses a duplicate rather than creating a second identical edge", () => {
    expect(
      canLink("a", "b", [{ id: "l1", blocker_id: "a", blocked_id: "b" }]),
    ).toMatchObject({ ok: false });
  });

  it("allows the REVERSE of an existing edge through, for the gateway to refuse", () => {
    // ⚠️ a→b then b→a is a two-node cycle. It is refused, but by
    // `assert_no_block_cycle` — bounded, tested and shared with every other
    // caller. A second implementation here is the one that would drift.
    expect(
      canLink("b", "a", [{ id: "l1", blocker_id: "a", blocked_id: "b" }]),
    ).toEqual({ ok: true });
  });

  it("does not reimplement the cycle walk", () => {
    // The cycle walk's own vocabulary, not "does this file contain a loop" —
    // `monthCells` legitimately walks months with a `while`, and a structural
    // test that cannot tell the two apart is one that gets deleted the first
    // time it is wrong.
    expect(SOURCE).not.toMatch(/MAX_DEPTH|frontier|\bvisited\b/);
    const body = SOURCE.slice(SOURCE.indexOf("export function canLink"));
    expect(body).not.toMatch(/\bwhile\b|\bfor\s*\(/);
  });
});

import { describe, expect, it } from "vitest";

import {
  DISPOSITION_LANES,
  OTHER_LANE,
  actionLine,
  groupByDisposition,
  isOverdue,
  sortMyTasks,
  twoMinuteTasks,
  untriagedCount,
  type MyTaskRow,
} from "./mywork";

function task(over: Partial<MyTaskRow> & { id: string }): MyTaskRow {
  return {
    project_id: "p",
    root_project_id: "p",
    status_id: "s",
    title: `task ${over.id}`,
    disposition: "NEXT",
    is_triaged: true,
    ...over,
  };
}

describe("isOverdue", () => {
  const now = new Date("2026-08-06T12:00:00Z");

  it("is false for a task with no due date", () => {
    expect(isOverdue(task({ id: "a" }), now)).toBe(false);
  });

  it("is true only once the date has passed", () => {
    expect(isOverdue({ due_at: "2026-08-06T11:59:00Z" }, now)).toBe(true);
    expect(isOverdue({ due_at: "2026-08-06T12:01:00Z" }, now)).toBe(false);
  });

  it("is not overdue at the exact instant it falls due", () => {
    // Pins `<` rather than `<=`: a task is late once the moment has passed,
    // not at the moment itself.
    expect(isOverdue({ due_at: "2026-08-06T12:00:00Z" }, now)).toBe(false);
  });

  it("is NOT overdue once the task has been completed", () => {
    // WS-27al(3). This predicate had no completion check at all, while the
    // board and the `overdue` filter both excluded finished work.
    // ⚠️ It had no in-app caller either, so nothing rendered wrong — an earlier
    // version of this comment claimed a ticked-off task "kept rendering overdue
    // in My Work", and that was never true (spec §11.28). This test is the
    // fence that keeps the divergence closed now that the body delegates.
    expect(
      isOverdue(
        { due_at: "2026-08-06T11:59:00Z", completed_at: "2026-08-06T11:00:00Z" },
        now,
      ),
    ).toBe(false);
    // The paired half: the SAME row, still open, is overdue — so a predicate
    // hard-wired to `false` cannot pass this pair.
    expect(isOverdue({ due_at: "2026-08-06T11:59:00Z", completed_at: null }, now)).toBe(
      true,
    );
  });

  it("treats an unparseable date as not overdue", () => {
    // Better to under-alarm than to paint every task red because one row
    // carried a malformed date.
    expect(isOverdue({ due_at: "not a date" }, now)).toBe(false);
  });
});

describe("sortMyTasks", () => {
  it("orders dated work soonest-first", () => {
    const rows = [
      task({ id: "late", due_at: "2026-09-01T00:00:00Z" }),
      task({ id: "soon", due_at: "2026-08-07T00:00:00Z" }),
    ];
    expect(sortMyTasks(rows).map((t) => t.id)).toEqual(["soon", "late"]);
  });

  it("puts undated work BELOW dated work, not above it", () => {
    // The load-bearing half: a task nobody dated is not more urgent than one
    // due tomorrow, and the opposite order is how the list stops being read.
    const rows = [
      task({ id: "undated", created_at: "2020-01-01T00:00:00Z" }),
      task({ id: "dated", due_at: "2030-01-01T00:00:00Z" }),
    ];
    expect(sortMyTasks(rows).map((t) => t.id)).toEqual(["dated", "undated"]);
  });

  it("falls back to creation order for undated ties", () => {
    const rows = [
      task({ id: "newer", created_at: "2026-08-06T00:00:00Z" }),
      task({ id: "older", created_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(sortMyTasks(rows).map((t) => t.id)).toEqual(["older", "newer"]);
  });

  it("does not mutate its input", () => {
    const rows = [task({ id: "b", due_at: "2030-01-01T00:00:00Z" }), task({ id: "a" })];
    const before = rows.map((t) => t.id);
    sortMyTasks(rows);
    expect(rows.map((t) => t.id)).toEqual(before);
  });
});

describe("groupByDisposition", () => {
  it("shows every work lane even when empty", () => {
    // An empty Next list means "you have triaged nothing into today" — a lane
    // that vanishes when empty cannot say that.
    const lanes = groupByDisposition([]);
    expect(lanes.map((l) => l.lane)).toEqual([...DISPOSITION_LANES]);
  });

  it("routes each disposition to its own lane", () => {
    const lanes = groupByDisposition([
      task({ id: "i", disposition: "INBOX" }),
      task({ id: "n", disposition: "NEXT" }),
      task({ id: "w", disposition: "WAITING" }),
      task({ id: "s", disposition: "SOMEDAY" }),
    ]);
    const byLane = Object.fromEntries(
      lanes.map((l) => [l.lane, l.tasks.map((t) => t.id)])
    );
    expect(byLane).toMatchObject({
      INBOX: ["i"],
      NEXT: ["n"],
      WAITING: ["w"],
      SOMEDAY: ["s"],
    });
  });

  it("files a non-lane disposition rather than dropping it", () => {
    // REFERENCE is not a work lane, but a task that disappears from the only
    // view a member has is worse than one shown in the wrong place.
    const lanes = groupByDisposition([task({ id: "r", disposition: "REFERENCE" })]);
    const other = lanes.find((l) => l.lane === OTHER_LANE);
    expect(other?.tasks.map((t) => t.id)).toEqual(["r"]);
  });

  it("hides the filed lane when it is empty", () => {
    expect(groupByDisposition([task({ id: "n" })]).some((l) => l.lane === OTHER_LANE)).toBe(
      false
    );
  });

  it("orders within each lane", () => {
    const lanes = groupByDisposition([
      task({ id: "late", disposition: "NEXT", due_at: "2030-01-01T00:00:00Z" }),
      task({ id: "soon", disposition: "NEXT", due_at: "2026-08-07T00:00:00Z" }),
    ]);
    expect(lanes.find((l) => l.lane === "NEXT")?.tasks.map((t) => t.id)).toEqual([
      "soon",
      "late",
    ]);
  });
});

describe("untriagedCount", () => {
  it("counts only the rows the member has never stated a disposition for", () => {
    // The distinction the server preserves by deriving instead of storing: an
    // assigned task reads as NEXT while still being untriaged.
    // Deliberately lopsided — one untriaged against two triaged. A balanced
    // fixture gives the same answer whichever side is counted, and lets an
    // inverted predicate pass.
    const rows = [
      task({ id: "derived", disposition: "NEXT", is_triaged: false }),
      task({ id: "stated", disposition: "NEXT", is_triaged: true }),
      task({ id: "filed", disposition: "SOMEDAY", is_triaged: true }),
    ];
    expect(untriagedCount(rows)).toBe(1);
  });
});

describe("twoMinuteTasks", () => {
  it("selects only tasks explicitly marked two-minute", () => {
    const rows = [
      task({ id: "quick", is_two_minute: true }),
      task({ id: "unset" }),
      task({ id: "no", is_two_minute: false }),
    ];
    expect(twoMinuteTasks(rows).map((t) => t.id)).toEqual(["quick"]);
  });
});

describe("actionLine", () => {
  it("prefers the next action over the title", () => {
    expect(actionLine(task({ id: "a", title: "Q3 pricing", next_action: "Email Priya" })))
      .toBe("Email Priya");
  });

  it("falls back to the title when the next action is blank", () => {
    expect(actionLine(task({ id: "a", title: "Q3 pricing", next_action: "   " }))).toBe(
      "Q3 pricing"
    );
    expect(actionLine(task({ id: "a", title: "Q3 pricing", next_action: null }))).toBe(
      "Q3 pricing"
    );
  });
});

/**
 * Projects · swimlanes (WS-27y).
 *
 * The silent failures a lane grid invites: a multi-assignee task missing from
 * one of its people's lanes, a lane count that disagrees with its cards, a
 * status sub-axis losing its configured order, cells drifting out of column
 * alignment.
 */

import { describe, expect, it } from "vitest";

import type { StatusRow, TaskRow } from "./api";
import { UNSET, groupTasks } from "./grouping";
import {
  buildSwimlanes,
  hiddenLaneCount,
  toggleLane,
  visibleLanes,
} from "./swimlanes";

const status = (id: string, name: string, position: number): StatusRow => ({
  id,
  project_id: "p1",
  name,
  color: "#888888",
  position,
  category: "todo",
  is_default: false,
});

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  project_id: "p1",
  root_project_id: "p1",
  status_id: "s-todo",
  title: "Fix the extruder",
  ...over,
});

const STATUSES = [status("s-doing", "In progress", 2), status("s-todo", "To do", 1)];
const ctx = { statuses: STATUSES };

/** Status columns × assignee lanes — the flagship combination. */
const board = (tasks: TaskRow[]) => {
  const columns = groupTasks(tasks, "status", ctx);
  return { columns, lanes: buildSwimlanes(columns, "assignee", ctx) };
};

describe("buildSwimlanes", () => {
  it("puts each task in the cell where its column and lane cross", () => {
    const { columns, lanes } = board([
      task({ id: "a", status_id: "s-todo", assignees: ["priya@x.co"] }),
      task({ id: "b", status_id: "s-doing", assignees: ["priya@x.co"] }),
      task({ id: "c", status_id: "s-todo", assignees: ["ravi@x.co"] }),
    ]);
    expect(columns.map((c) => c.key)).toEqual(["s-todo", "s-doing"]);
    expect(lanes.map((l) => l.label)).toEqual(["priya", "ravi"]);
    // priya's lane: [todo cell, doing cell]
    expect(lanes[0].cells.map((cell) => cell.map((t) => t.id))).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(lanes[1].cells.map((cell) => cell.map((t) => t.id))).toEqual([
      ["c"],
      [],
    ]);
  });

  it("keeps cells aligned with the columns, index for index", () => {
    const { columns, lanes } = board([task({ assignees: ["zoe@x.co"] })]);
    for (const lane of lanes) expect(lane.cells).toHaveLength(columns.length);
  });

  it("draws a two-owner task in BOTH owners' lanes", () => {
    // Same honesty rule as assignee columns: it IS both people's work.
    const { lanes } = board([
      task({ assignees: ["priya@x.co", "ravi@x.co"] }),
    ]);
    expect(lanes.map((l) => l.label)).toEqual(["priya", "ravi"]);
    expect(lanes.every((l) => l.cells[0].length === 1)).toBe(true);
  });

  it("counts a task once per lane, not once per column it appears in", () => {
    // Columns from a multi-valued FIRST axis can repeat a task; the lane
    // total must still speak in distinct tasks or the header lies.
    const columns = groupTasks(
      [task({ id: "a", tags: ["bug", "ops"], assignees: ["zoe@x.co"] })],
      "tag",
      ctx
    );
    const lanes = buildSwimlanes(columns, "assignee", ctx);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].total).toBe(1);
    // ...while still drawing it in both columns' cells.
    expect(lanes[0].cells.map((cell) => cell.length)).toEqual([1, 1]);
  });

  it("collects ownerless tasks in an Unassigned lane, last", () => {
    const { lanes } = board([
      task({ id: "a" }),
      task({ id: "b", assignees: ["zoe@x.co"] }),
    ]);
    expect(lanes.map((l) => l.key)).toEqual(["zoe@x.co", UNSET]);
  });

  it("keeps a status sub-axis in configured order, empty lanes included", () => {
    const columns = groupTasks(
      [task({ assignees: ["zoe@x.co"], status_id: "s-doing" })],
      "assignee",
      ctx
    );
    const lanes = buildSwimlanes(columns, "status", ctx);
    // "To do" is empty but present — position order, not activity order.
    expect(lanes.map((l) => l.label)).toEqual(["To do", "In progress"]);
    expect(lanes.map((l) => l.total)).toEqual([0, 1]);
  });

  it("preserves each column's own task order inside a cell", () => {
    const columns = [
      {
        key: "s-todo",
        label: "To do",
        tasks: [
          task({ id: "second", assignees: ["zoe@x.co"] }),
          task({ id: "first", assignees: ["zoe@x.co"] }),
        ],
      },
    ];
    const lanes = buildSwimlanes(columns, "assignee", ctx);
    // Whatever order the column held (per-view positions), the cell keeps.
    expect(lanes[0].cells[0].map((t) => t.id)).toEqual(["second", "first"]);
  });

  it("is empty for an empty board", () => {
    expect(buildSwimlanes([], "assignee", ctx)).toEqual([]);
  });
});

describe("visibleLanes and the show-empty toggle", () => {
  const lanes = [
    { key: "a", label: "A", total: 2, cells: [[]] },
    { key: "b", label: "B", total: 0, cells: [[]] },
  ];

  it("hides empty lanes by default", () => {
    expect(visibleLanes(lanes, false).map((l) => l.key)).toEqual(["a"]);
  });

  it("shows them all when asked", () => {
    expect(visibleLanes(lanes, true).map((l) => l.key)).toEqual(["a", "b"]);
  });

  it("says how many are hidden, so the toggle is honest about what it hides", () => {
    expect(hiddenLaneCount(lanes)).toBe(1);
  });
});

describe("toggleLane", () => {
  it("folds a lane shut and back open", () => {
    expect(toggleLane([], "a")).toEqual(["a"]);
    expect(toggleLane(["a", "b"], "a")).toEqual(["b"]);
  });

  it("does not mutate the list it was given", () => {
    const collapsed = ["a"];
    toggleLane(collapsed, "b");
    expect(collapsed).toEqual(["a"]);
  });
});

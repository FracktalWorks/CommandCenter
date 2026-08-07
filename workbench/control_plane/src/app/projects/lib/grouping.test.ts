/**
 * Projects · grouping and the filter query (WS-27k).
 *
 * The cases that decide whether a board is trustworthy are the awkward ones: a
 * task with two owners, a task with none, a lane with nothing in it, and a
 * saved view written by a client that no longer exists.
 */

import { describe, expect, it } from "vitest";

import type { StatusRow, TaskRow } from "./api";
import {
  EMPTY_FILTERS,
  GROUP_OPTIONS,
  UNSET,
  fromConfig,
  groupTasks,
  isFiltered,
  personLabel,
  toConfig,
  toQuery,
} from "./grouping";

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

describe("groupTasks by status", () => {
  it("orders lanes by position, not by insertion", () => {
    expect(groupTasks([], "status", ctx).map((g) => g.label)).toEqual([
      "To do",
      "In progress",
    ]);
  });

  it("keeps an empty lane", () => {
    // A board missing its "In progress" column reads as "this project has no
    // in-progress state", not "nothing is in progress".
    const groups = groupTasks([task()], "status", ctx);
    expect(groups.map((g) => g.tasks.length)).toEqual([1, 0]);
  });
});

describe("groupTasks by assignee", () => {
  it("puts a task with two owners in both columns", () => {
    // It IS both people's work. Picking one arbitrarily hides it from the other.
    const groups = groupTasks(
      [task({ assignees: ["priya@x.co", "ravi@x.co"] })],
      "assignee",
      ctx,
    );
    expect(groups.map((g) => g.label)).toEqual(["priya", "ravi"]);
    expect(groups.every((g) => g.tasks.length === 1)).toBe(true);
  });

  it("collects tasks with nobody on them under Unassigned", () => {
    const groups = groupTasks(
      [task({ id: "a", assignees: [] }), task({ id: "b" })],
      "assignee",
      ctx,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(UNSET);
    expect(groups[0].tasks).toHaveLength(2);
  });

  it("puts Unassigned last, because it is a residue not a peer", () => {
    const groups = groupTasks(
      [task({ id: "a" }), task({ id: "b", assignees: ["zoe@x.co"] })],
      "assignee",
      ctx,
    );
    expect(groups.map((g) => g.key)).toEqual(["zoe@x.co", UNSET]);
  });

  it("drops empty buckets — there is no 'people with nothing assigned' column", () => {
    expect(groupTasks([], "assignee", ctx)).toEqual([]);
  });

  it("labels an agent by its handle, not as 'agent'", () => {
    expect(personLabel("agent:builder")).toBe("builder");
    expect(personLabel("priya@fracktal.in")).toBe("priya");
  });
});

describe("groupTasks by project and importance", () => {
  it("names projects through the supplied lookup", () => {
    const groups = groupTasks([task({ project_id: "p2" })], "project", {
      statuses: STATUSES,
      projectName: (id) => (id === "p2" ? "Firmware" : "?"),
    });
    expect(groups[0].label).toBe("Firmware");
  });

  it("falls back to a word when the project is not in the tree", () => {
    // The tree is filtered by Center; a task can belong to a project the
    // sidebar is not currently showing. A blank heading reads as a bug.
    expect(groupTasks([task()], "project", ctx)[0].label).toBe("Project");
  });

  it("separates priorities and keeps the unset ones last", () => {
    const groups = groupTasks(
      [task({ id: "a", importance: 3 }), task({ id: "b" })],
      "importance",
      ctx,
    );
    expect(groups.map((g) => g.label)).toEqual(["Urgent", "No priority"]);
  });

  it("treats importance 0 as a real value, not as absent", () => {
    // `0` is falsy — the bug this guards is a Low-priority task silently
    // landing in "No priority".
    const groups = groupTasks([task({ importance: 0 })], "importance", ctx);
    expect(groups[0].key).toBe("0");
    expect(groups[0].label).toBe("Low");
  });
});

describe("groupTasks none", () => {
  it("is one group carrying the count", () => {
    const groups = groupTasks([task(), task({ id: "t2" })], "none", ctx);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("2 tasks");
  });
});

describe("toQuery", () => {
  it("sends nothing when nothing is filtered", () => {
    expect(toQuery(EMPTY_FILTERS)).toEqual({});
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  });

  it("omits a false toggle rather than sending false", () => {
    // `?overdue=false` is indistinguishable from "the client forgot to send it".
    expect(toQuery({ ...EMPTY_FILTERS, overdue: false })).toEqual({});
    expect(toQuery({ ...EMPTY_FILTERS, overdue: true })).toEqual({ overdue: "true" });
  });

  it("does not send a whitespace-only search", () => {
    expect(toQuery({ ...EMPTY_FILTERS, q: "   " })).toEqual({});
  });

  it("trims what it does send", () => {
    expect(toQuery({ ...EMPTY_FILTERS, q: "  jam " })).toEqual({ q: "jam" });
  });
});

describe("saved view config", () => {
  it("round-trips", () => {
    const filters = { ...EMPTY_FILTERS, overdue: true, statusCategory: "todo" };
    expect(fromConfig(toConfig(filters, "assignee"))).toEqual({
      filters,
      groupBy: "assignee",
    });
  });

  it("stores a toggle as a boolean, not as the string a URL would carry", () => {
    // `toQuery` writes "true" because a query string has only text. A config is
    // JSON, and `fromConfig` refuses a string where a toggle belongs — so a
    // view built from query shape would come back with its toggles cleared.
    const config = toConfig({ ...EMPTY_FILTERS, overdue: true }, "status");
    expect((config.filters as Record<string, unknown>).overdue).toBe(true);
  });

  it("stores only what is set, so an unfiltered view is an empty object", () => {
    expect(toConfig(EMPTY_FILTERS, "status")).toEqual({
      filters: {},
      group_by: "status",
    });
  });

  it("uses the gateway's key names, not the form's", () => {
    // `normalise_view_config` drops keys it does not know, so `statusCategory`
    // would be silently discarded and the saved view would show everything.
    const config = toConfig({ ...EMPTY_FILTERS, statusCategory: "todo" }, "status");
    expect(config.filters).toEqual({ status_category: "todo" });
  });

  it("survives a config from a client that no longer exists", () => {
    // A saved view is a preference, not a contract. Refusing to open one
    // because it carries an unknown shape would strand people's views.
    for (const junk of [null, undefined, [], "board", 7, { filters: "nope" }]) {
      const got = fromConfig(junk);
      expect(got.filters).toEqual(EMPTY_FILTERS);
      expect(got.groupBy).toBe("status");
    }
  });

  it("falls back to the board's own axis for an unknown grouping", () => {
    expect(fromConfig({ group_by: "phase" }).groupBy).toBe("status");
  });

  it("ignores a non-boolean where a toggle belongs", () => {
    // `"true"` from a hand-edited config must not read as true — a string is
    // not a decision somebody made in the UI.
    expect(fromConfig({ filters: { overdue: "true" } }).filters.overdue).toBe(false);
  });

  it("accepts every grouping the board advertises", () => {
    for (const option of GROUP_OPTIONS) {
      expect(fromConfig({ group_by: option }).groupBy).toBe(option);
    }
  });
});

/**
 * Projects · board maths — the arithmetic a drag depends on.
 *
 * Spec: `ai-company-brain/specs/project_management_app.md` §3.10 · D-PM-5 ·
 * ticket WS-27d done-when 2.
 */
import { describe, expect, it } from "vitest";

import {
  POSITION_MAX,
  buildColumnDropUpdate,
  planDrop,
  positionBetween,
  sortForView,
} from "./board";

describe("positionBetween", () => {
  it("halves the gap between two neighbours", () => {
    expect(positionBetween(100, 200)).toBe(150);
  });

  it("appends above the last card without reaching the ceiling", () => {
    const appended = positionBetween(100, null);
    expect(appended).toBeGreaterThan(100);
    expect(appended).toBeLessThan(POSITION_MAX);
  });

  it("prepends below the first card without reaching zero", () => {
    const prepended = positionBetween(null, 100);
    expect(prepended).toBeGreaterThan(0);
    expect(prepended).toBeLessThan(100);
  });

  it("never produces a negative position", () => {
    // The property that makes the bounds structural rather than validated.
    let position = positionBetween(null, 100);
    for (let i = 0; i < 40; i += 1) position = positionBetween(null, position);
    expect(position).toBeGreaterThan(0);
  });

  it("puts a lone card in the middle so both directions stay open", () => {
    expect(positionBetween(null, null)).toBe(POSITION_MAX / 2);
  });
});

describe("sortForView", () => {
  it("orders positioned cards by position", () => {
    const sorted = sortForView([
      { id: "b", view_position: 200 },
      { id: "a", view_position: 100 },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("sorts unpositioned cards to the BOTTOM, by age", () => {
    // Not the top: a new task appearing above a hand-arranged column would
    // look like the board reordered itself.
    const sorted = sortForView([
      { id: "new", created_at: "2026-08-06T10:00:00Z" },
      { id: "older", created_at: "2026-08-01T10:00:00Z" },
      { id: "placed", view_position: 500 },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["placed", "older", "new"]);
  });
});

describe("planDrop", () => {
  const ordered = [
    { id: "a", view_position: 100 },
    { id: "b", view_position: 200 },
    { id: "c", view_position: 300 },
  ];

  it("writes exactly ONE row for a normal drop", () => {
    const writes = planDrop(ordered, "c", 1);
    expect(writes).toHaveLength(1);
    expect(writes[0].task_id).toBe("c");
    expect(writes[0].position).toBe(150);
  });

  it("carries the destination group so a cross-column drag is still one write", () => {
    const writes = planDrop(ordered, "c", 0, "status-2");
    expect(writes).toHaveLength(1);
    expect(writes[0].group_key).toBe("status-2");
  });

  it("materialises the whole group on the first drag into an unordered one", () => {
    // As N requests this would leave the order half-applied if one failed —
    // which is why the bulk endpoint is the preferred shape, not a convenience.
    const unordered = [{ id: "x" }, { id: "y" }, { id: "z" }];
    const writes = planDrop(unordered, "z", 0);

    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.task_id)).toEqual(["z", "x", "y"]);
    const positions = writes.map((w) => w.position);
    expect([...positions].sort((p, q) => p - q)).toEqual(positions);
    expect(positions.every((p) => p > 0 && p < POSITION_MAX)).toBe(true);
  });

  it("clamps an out-of-range index instead of producing NaN", () => {
    expect(planDrop(ordered, "a", 99)[0].position).toBeGreaterThan(300);
    expect(planDrop(ordered, "c", -5)[0].position).toBeLessThan(100);
  });
});

describe("buildColumnDropUpdate", () => {
  it("patches whatever field the view groups by", () => {
    // Hard-coding status is what makes a board that can only group by status.
    expect(buildColumnDropUpdate("status", "s-1")).toEqual({ status_id: "s-1" });
    expect(buildColumnDropUpdate("type", "t-1")).toEqual({ type_id: "t-1" });
    expect(buildColumnDropUpdate("project", "p-1")).toEqual({ project_id: "p-1" });
  });

  it("patches nothing for an unknown grouping, and does not throw", () => {
    // The drop still reorders within the column; it simply moves no field.
    expect(buildColumnDropUpdate("assignee", "someone")).toBeNull();
    expect(buildColumnDropUpdate(undefined, null)).toBeNull();
  });
});

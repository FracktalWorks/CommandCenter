import { describe, expect, it } from "vitest";

import {
  acceptTargets,
  describeSource,
  duplicateTargets,
  snoozeInstant,
  sortQueue,
  type IntakeItem,
} from "./intake";

function item(
  over: Partial<IntakeItem> & { id: string; captured?: string | null }
): IntakeItem {
  const { captured, ...rest } = over;
  return {
    project_id: "p",
    root_project_id: "p",
    status_id: "s",
    title: `capture ${over.id}`,
    intake: {
      id: `i-${over.id}`,
      task_id: over.id,
      status: "pending",
      created_at: captured ?? null,
    },
    ...rest,
  };
}

describe("describeSource", () => {
  it("joins source and reference when both are present", () => {
    expect(describeSource({ source: "email", source_ref: "msg-9" })).toBe(
      "email · msg-9"
    );
  });

  it("shows whichever half exists alone", () => {
    expect(describeSource({ source: "slack", source_ref: null })).toBe("slack");
    expect(describeSource({ source: null, source_ref: "thread-1" })).toBe(
      "thread-1"
    );
  });

  it("is null when nobody said where it came from", () => {
    // Null, not "": the rail omits the line entirely rather than rendering a
    // blank "from:" row that implies provenance was lost.
    expect(describeSource({ source: null, source_ref: null })).toBeNull();
    expect(describeSource({ source: "  ", source_ref: "" })).toBeNull();
  });
});

describe("sortQueue", () => {
  it("puts the longest-waiting capture first", () => {
    const rows = [
      item({ id: "b", captured: "2026-08-08T10:00:00Z" }),
      item({ id: "a", captured: "2026-08-01T10:00:00Z" }),
    ];
    expect(sortQueue(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("breaks ties on id so a reload never reshuffles", () => {
    const rows = [
      item({ id: "z", captured: "2026-08-01T10:00:00Z" }),
      item({ id: "a", captured: "2026-08-01T10:00:00Z" }),
    ];
    expect(sortQueue(rows).map((r) => r.id)).toEqual(["a", "z"]);
    expect(sortQueue([...rows].reverse()).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      item({ id: "b", captured: "2026-08-08T10:00:00Z" }),
      item({ id: "a", captured: "2026-08-01T10:00:00Z" }),
    ];
    sortQueue(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("acceptTargets", () => {
  it("offers every lane except triage ones", () => {
    // The picker-exclusion rule: the gateway 422s a triage destination, so
    // the picker must not offer it.
    const statuses = [
      { id: "1", category: "triage" },
      { id: "2", category: "todo" },
      { id: "3", category: "done" },
    ];
    expect(acceptTargets(statuses).map((s) => s.id)).toEqual(["2", "3"]);
  });
});

describe("duplicateTargets", () => {
  it("never offers the capture itself", () => {
    const hits = [{ id: "self" }, { id: "other" }];
    expect(duplicateTargets(hits, "self").map((h) => h.id)).toEqual(["other"]);
  });
});

describe("snoozeInstant", () => {
  it("lands on 9am LOCAL of the chosen day", () => {
    // The WS-27q lesson: `new Date("YYYY-MM-DD")` is midnight UTC, which is
    // the previous evening west of Greenwich. Pinned by parsing the result
    // back and asserting the LOCAL hour, which holds in every timezone the
    // suite runs in.
    const iso = snoozeInstant("2026-08-15");
    expect(iso).not.toBeNull();
    const parsed = new Date(iso as string);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(15);
    expect(parsed.getHours()).toBe(9);
  });

  it("refuses anything that is not a calendar day", () => {
    expect(snoozeInstant("")).toBeNull();
    expect(snoozeInstant("tomorrow")).toBeNull();
    expect(snoozeInstant("2026-13-45")).toBeNull();
    expect(snoozeInstant("2026-08-15T10:00:00Z")).toBeNull();
  });
});

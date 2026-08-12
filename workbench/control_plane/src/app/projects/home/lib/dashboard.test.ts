import { describe, expect, it } from "vitest";

import { SIGNAL_LABELS, ringSegments, shortName, personLabel } from "./dashboard";

const stage = (id: string, name: string, count: number) => ({ id, name, count });

describe("ringSegments", () => {
  it("is empty when nothing is staged — no divide by zero", () => {
    expect(ringSegments([])).toEqual([]);
    expect(ringSegments([stage("a", "Concept", 0)])).toEqual([]);
  });

  it("drops empty stages from the ring but keeps the rest", () => {
    const segs = ringSegments([
      stage("a", "Concept", 5), stage("b", "Design", 0), stage("c", "CAD", 5),
    ]);
    expect(segs.map((s) => s.name)).toEqual(["Concept", "CAD"]);
  });

  it("percentages sum to 100", () => {
    const segs = ringSegments([stage("a", "A", 7), stage("b", "B", 11), stage("c", "C", 1)]);
    expect(segs.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 6);
  });

  it("offsets are the running total, so arcs abut rather than overlap", () => {
    const segs = ringSegments([stage("a", "A", 1), stage("b", "B", 1), stage("c", "C", 2)]);
    expect(segs[0].offset).toBe(0);
    expect(segs[1].offset).toBeCloseTo(segs[0].pct, 6);
    expect(segs[2].offset).toBeCloseTo(segs[0].pct + segs[1].pct, 6);
  });

  it("keeps counts as the truth alongside the percentage", () => {
    const [only] = ringSegments([stage("a", "A", 3)]);
    expect(only.count).toBe(3);
    expect(only.pct).toBe(100);
  });

  it("slots by pipeline POSITION and wraps at eight", () => {
    // Adjacent stages should read as adjacent hues; a hash would scatter them.
    const many = Array.from({ length: 10 }, (_, i) => stage(`s${i}`, `S${i}`, 1));
    const segs = ringSegments(many);
    expect(segs.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1, 2]);
  });

  it("keeps position slots stable when an EARLIER stage is empty", () => {
    // The slot follows the stage's index in the pipeline, not its index among
    // the non-empty ones — otherwise emptying Concept repaints everything.
    const segs = ringSegments([stage("a", "A", 0), stage("b", "B", 1), stage("c", "C", 1)]);
    expect(segs.map((s) => s.slot)).toEqual([2, 3]);
  });
});

describe("shortName", () => {
  it("drops the domain", () => {
    expect(shortName("jasim@fracktal.in")).toBe("jasim");
  });

  it("unwraps an agent, keeping its name", () => {
    expect(shortName("agent:task-manager")).toBe("task-manager");
  });

  it("passes anything else through rather than returning empty", () => {
    expect(shortName("kiruba")).toBe("kiruba");
    expect(shortName("@weird")).toBe("@weird");
  });
});

describe("SIGNAL_LABELS", () => {
  it("uses shared-vocabulary hue names, never class strings", () => {
    for (const [key, v] of Object.entries(SIGNAL_LABELS)) {
      expect(v.hue, key).toMatch(/^(gray|red|amber|green|blue|violet)$/);
      expect(v.label.length, key).toBeGreaterThan(0);
    }
  });

  it("covers every blocker kind the API can return", () => {
    // Mirrors work.py's BLOCKER_KINDS. A kind with no label renders as a raw
    // snake_case string in the breakdown.
    for (const kind of [
      "client_input", "client_approval", "supplier", "material", "prototype",
      "engineering", "information", "internal_review", "capacity",
      "dependency", "other",
    ]) {
      expect(SIGNAL_LABELS[kind], kind).toBeDefined();
    }
  });

  it("covers every attention signal operations.py can emit", () => {
    for (const s of [
      "critical", "at_risk", "overdue", "blocked_long", "blocked",
      "no_owner", "no_next_action", "stale",
    ]) {
      expect(SIGNAL_LABELS[s], s).toBeDefined();
    }
  });
});

describe("personLabel", () => {
  // The defect: every workload row read "kiruba" because the only name the UI
  // had was the email's local part. The endpoint carries `display_name` now.
  it("prefers the person's real name", () => {
    expect(personLabel({ actor: "kiruba@fracktal.in", name: "Kirubakaran S" }))
      .toBe("Kirubakaran S");
  });

  it("falls back to the actor when there is no member behind it", () => {
    // An assignee is free text (D-PM-4) — it need not be an app_user at all.
    expect(personLabel({ actor: "jasim@fracktal.in" })).toBe("jasim");
    expect(personLabel({ actor: "agent:delivery", name: null })).toBe("delivery");
  });

  it("treats a blank display name as absent rather than printing nothing", () => {
    // `display_name` is nullable AND free text, so "" and "  " both reach here.
    expect(personLabel({ actor: "shahul@fracktal.in", name: "   " })).toBe("shahul");
  });
});

import { describe, expect, it } from "vitest";

import { describeActivity, isAutomated, isDiscussion } from "./activity";

describe("describeActivity", () => {
  it("prefers the server's body over anything reconstructed", () => {
    // The server wrote that sentence with the names as they were AT THE TIME.
    // A stage renamed next month must not rewrite history.
    const a = describeActivity({ type: "stage_change", body: "CAD → Prototype", meta: { to: "Renamed" } });
    expect(a.text).toBe("CAD → Prototype");
  });

  it("refines the icon by meta.action, not just by type", () => {
    const started = describeActivity({ type: "work_session", body: "Started work", meta: { action: "started" } });
    const paused = describeActivity({ type: "work_session", body: "Paused: x", meta: { action: "paused" } });
    expect(started.icon).toBe("Play");
    expect(paused.icon).toBe("Pause");
    expect(started.hue).not.toBe(paused.hue);
  });

  it("gives every gateway verb a look — an unmapped one renders as a bare circle", () => {
    // Mirrors core.ACTIVITY_TYPES. A verb with no entry still renders, but
    // indistinguishably from every other, which is the failure to catch.
    for (const type of [
      "comment", "status_change", "field_change", "link", "assignment",
      "agent_run", "sync", "system", "attachment", "mention",
      "work_session", "stage_change", "blocker", "next_action", "handoff",
    ]) {
      expect(describeActivity({ type }).icon, type).not.toBe("Circle");
    }
  });

  it("uses shared-vocabulary hue NAMES, never class strings", () => {
    for (const type of ["work_session", "blocker", "handoff", "next_action", "stage_change"]) {
      expect(describeActivity({ type }).hue).toMatch(/^(gray|red|amber|green|blue|violet)$/);
    }
  });

  it("falls back readably when the server wrote no body", () => {
    expect(describeActivity({ type: "work_session", meta: { action: "resumed" } }).text)
      .toBe("work session: resumed");
    expect(describeActivity({ type: "handoff" }).text).toBe("handoff");
  });

  it("treats a blank body as absent rather than rendering an empty row", () => {
    expect(describeActivity({ type: "handoff", body: "   " }).text).toBe("handoff");
  });

  it("survives an unknown verb instead of throwing", () => {
    // A verb added to the gateway and not here must degrade, not crash.
    expect(describeActivity({ type: "teleported" }).text).toBe("teleported");
  });
});

describe("isDiscussion", () => {
  it("separates talk from history (§32)", () => {
    expect(isDiscussion({ type: "comment" })).toBe(true);
    expect(isDiscussion({ type: "mention" })).toBe(true);
    expect(isDiscussion({ type: "work_session" })).toBe(false);
    expect(isDiscussion({ type: "blocker" })).toBe(false);
  });
});

describe("isAutomated", () => {
  it("reads the flag and the actor shape", () => {
    expect(isAutomated({ type: "system", meta: { automation: true } })).toBe(true);
    expect(isAutomated({ type: "status_change", created_by: "system:workflow:7" })).toBe(true);
    expect(isAutomated({ type: "comment", created_by: "jasim@fracktal.in" })).toBe(false);
  });
});

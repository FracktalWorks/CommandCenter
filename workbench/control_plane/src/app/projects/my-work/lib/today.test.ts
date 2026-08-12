import { describe, expect, it } from "vitest";

import {
  type TaskLike,
  rankUpNext,
  sessionHue,
  sessionState,
  timeRange,
  waitingOnMe,
} from "./today";

const session = (over: Record<string, unknown> = {}) => ({
  running: false,
  end_reason: null as string | null,
  started_at: "2026-08-12T10:12:00Z",
  ended_at: "2026-08-12T11:48:00Z",
  ...over,
});

describe("sessionState", () => {
  it("names a running session Working", () => {
    expect(sessionState(session({ running: true }))).toBe("Working");
  });

  it("distinguishes a switch from a pause", () => {
    // The two are different facts. Collapsing them makes the schedule look
    // like the engineer pauses constantly.
    expect(sessionState(session({ end_reason: "switched" }))).toBe("Switched");
    expect(sessionState(session({ end_reason: "paused" }))).toBe("Paused");
  });

  it("covers every end_reason the work API writes", () => {
    expect(sessionState(session({ end_reason: "completed" }))).toBe("Completed");
    expect(sessionState(session({ end_reason: "handoff" }))).toBe("Handed off");
    expect(sessionState(session({ end_reason: "blocked" }))).toBe("Blocked");
    expect(sessionState(session({ end_reason: "break" }))).toBe("Break");
  });

  it("falls back to Paused for an unknown reason rather than rendering blank", () => {
    expect(sessionState(session({ end_reason: "something-new" }))).toBe("Paused");
    expect(sessionState(session({ end_reason: null }))).toBe("Paused");
  });
});

describe("sessionHue", () => {
  it("uses shared-vocabulary hue names, never classes", () => {
    for (const s of [
      session({ running: true }),
      session({ end_reason: "completed" }),
      session({ end_reason: "blocked" }),
      session({ end_reason: "handoff" }),
      session({}),
    ]) {
      expect(sessionHue(s)).toMatch(/^(gray|red|amber|green|blue|violet)$/);
    }
  });
});

describe("timeRange", () => {
  it("reads 'Now' for a running session rather than a ticking clock", () => {
    expect(timeRange(session({ ended_at: null }), "en-US")).toMatch(/– Now$/);
  });

  it("shows both ends once closed", () => {
    expect(timeRange(session(), "en-US")).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM) – \d{1,2}:\d{2}\s?(AM|PM)$/);
  });
});

describe("rankUpNext", () => {
  const NOW = Date.parse("2026-08-12T12:00:00Z");
  const t = (over: Partial<TaskLike>): TaskLike => ({ id: "x", title: "t", ...over });

  it("puts overdue work first", () => {
    const rows = rankUpNext(
      [
        t({ id: "future", title: "future", due_at: "2026-08-20T00:00:00Z" }),
        t({ id: "late", title: "late", due_at: "2026-08-01T00:00:00Z" }),
      ],
      NOW,
    );
    expect(rows[0].id).toBe("late");
  });

  it("prefers a dated task over an urgent undated one", () => {
    // A date is a promise to somebody; importance is an opinion.
    const rows = rankUpNext(
      [
        t({ id: "urgent", title: "urgent", importance: 3 }),
        t({ id: "dated", title: "dated", due_at: "2026-08-13T00:00:00Z", importance: 0 }),
      ],
      NOW,
    );
    expect(rows[0].id).toBe("dated");
  });

  it("falls back to importance when neither is dated", () => {
    const rows = rankUpNext(
      [t({ id: "low", title: "low", importance: 0 }), t({ id: "high", title: "high", importance: 3 })],
      NOW,
    );
    expect(rows[0].id).toBe("high");
  });

  it("is stable — equal rows keep a deterministic order across reloads", () => {
    const rows = [t({ id: "b", title: "b" }), t({ id: "a", title: "a" })];
    expect(rankUpNext(rows, NOW).map((r) => r.title)).toEqual(["a", "b"]);
    expect(rankUpNext([...rows].reverse(), NOW).map((r) => r.title)).toEqual(["a", "b"]);
  });

  it("excludes completed work — it is not 'next'", () => {
    const rows = rankUpNext([t({ id: "done", completed_at: "2026-08-11T00:00:00Z" })], NOW);
    expect(rows).toHaveLength(0);
  });

  it("does not mutate its input", () => {
    const input = [t({ id: "b", title: "b" }), t({ id: "a", title: "a" })];
    const copy = [...input];
    rankUpNext(input, NOW);
    expect(input).toEqual(copy);
  });
});

describe("waitingOnMe", () => {
  const t = (over: Partial<TaskLike>): TaskLike => ({ id: "x", title: "t", ...over });

  it("matches only work whose NEXT ACTION names me", () => {
    const rows = waitingOnMe(
      [
        t({ id: "mine", next_action: "Chase M&M", next_action_owner: "dev@fracktal.in" }),
        t({ id: "theirs", next_action: "Chase M&M", next_action_owner: "jasim@fracktal.in" }),
        t({ id: "none", next_action: null, next_action_owner: "dev@fracktal.in" }),
      ],
      "dev@fracktal.in",
    );
    expect(rows.map((r) => r.id)).toEqual(["mine"]);
  });

  it("compares case-insensitively on both sides (R10)", () => {
    const rows = waitingOnMe(
      [t({ id: "mine", next_action: "x", next_action_owner: "Dev@Fracktal.IN" })],
      "  dev@fracktal.in ",
    );
    expect(rows).toHaveLength(1);
  });

  it("excludes completed work", () => {
    const rows = waitingOnMe(
      [t({ next_action: "x", next_action_owner: "dev@fracktal.in", completed_at: "2026-08-11T00:00:00Z" })],
      "dev@fracktal.in",
    );
    expect(rows).toHaveLength(0);
  });
});

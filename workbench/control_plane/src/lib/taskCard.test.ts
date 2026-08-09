/**
 * WS-27s — the shared card vocabulary.
 *
 * These are the rules that make a Projects card readable at a glance, and every
 * one of them has a plausible wrong version:
 *
 * * **overdue means past due AND still open.** The wrong version is a `<` on
 *   the date alone, which paints every finished task red forever — after which
 *   red stops meaning anything and the whole signal is spent.
 * * **a zero earns no chip.** The wrong version renders "0" for subtasks, tags
 *   and attachments on every task that has none, which is most of them.
 * * **order is fixed.** The wrong version builds chips in whatever order the
 *   object's keys arrive, so the same task reorders itself between renders and
 *   the reader has to read rather than scan.
 *
 * Pure functions, no DOM. The component that paints these is a `switch` over
 * `tone` and has nothing left to get wrong.
 */

import { describe, expect, it } from "vitest";

import {
  avatarStack,
  durationLabel,
  initials,
  isOverdue,
  relativeTime,
  taskMeta,
} from "./taskCard";

const NOW = Date.parse("2026-08-07T12:00:00Z");
const hours = (n: number) => new Date(NOW + n * 3_600_000).toISOString();

// ── isOverdue ───────────────────────────────────────────────────────────────

describe("isOverdue", () => {
  it("is true for a past due date on open work", () => {
    expect(isOverdue(hours(-3), null, NOW)).toBe(true);
  });

  it("is false once the task is finished", () => {
    // ⚠️ The rule the whole signal rests on. Without it every closed task with
    // a past due date is permanently red.
    expect(isOverdue(hours(-3), hours(-1), NOW)).toBe(false);
  });

  it("is false for a future due date", () => {
    expect(isOverdue(hours(3), null, NOW)).toBe(false);
  });

  it("is false when there is no due date at all", () => {
    expect(isOverdue(null, null, NOW)).toBe(false);
    expect(isOverdue(undefined, undefined, NOW)).toBe(false);
  });

  it("is false rather than true for an unparseable date", () => {
    // A card that cannot read the date must not claim the task is late.
    expect(isOverdue("not a date", null, NOW)).toBe(false);
  });
});

// ── the small helpers ───────────────────────────────────────────────────────

describe("relativeTime", () => {
  it("reads backwards for the past and forwards for the future", () => {
    expect(relativeTime(hours(-2), NOW)).toBe("2h ago");
    expect(relativeTime(hours(2), NOW)).toBe("in 2h");
  });

  it("returns nothing for a missing or unreadable date", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime("tomorrow-ish", NOW)).toBe("");
  });

  it("climbs units rather than printing 4000m", () => {
    expect(relativeTime(hours(-24 * 3), NOW)).toBe("3d ago");
    expect(relativeTime(hours(-24 * 14), NOW)).toBe("2w ago");
    expect(relativeTime(hours(-24 * 90), NOW)).toBe("3mo ago");
  });
});

describe("durationLabel", () => {
  it("stays in minutes under an hour", () => {
    expect(durationLabel(45)).toBe("45m");
  });

  it("drops a zero minute part", () => {
    expect(durationLabel(120)).toBe("2h");
    expect(durationLabel(90)).toBe("1h 30m");
  });

  it("is empty for nothing, so the caller can test the string", () => {
    expect(durationLabel(0)).toBe("");
    expect(durationLabel(null)).toBe("");
    expect(durationLabel(undefined)).toBe("");
  });
});

describe("initials", () => {
  it("takes at most two words", () => {
    expect(initials("Priya Sharma")).toBe("PS");
    expect(initials("Jean Luc Picard")).toBe("JL");
  });

  it("survives a one-word name and an empty one", () => {
    expect(initials("priya")).toBe("P");
    expect(initials("")).toBe("");
  });

  it("reads an email local part as the two words it is", () => {
    // ⚠️ Half the people this draws have no display name — Projects identifies
    // an assignee by address. "P" is a worse avatar than "PS".
    expect(initials("priya.sharma")).toBe("PS");
    expect(initials("arjun_rao")).toBe("AR");
  });

  it("does not treat a hyphen as a separator", () => {
    // "Jean-Luc Picard" is two names, not three; splitting it gives "JL".
    expect(initials("Jean-Luc Picard")).toBe("JP");
  });
});

// ── taskMeta ────────────────────────────────────────────────────────────────

const keys = (facts: Parameters<typeof taskMeta>[0]) =>
  taskMeta(facts, NOW).map((c) => c.key);

describe("taskMeta", () => {
  it("gives a bare task no chips at all", () => {
    expect(taskMeta({}, NOW)).toEqual([]);
  });

  it("draws nothing for a zero count", () => {
    // ⚠️ Most tasks have no subtasks, no tags and no attachments. Chips for
    // those would be the majority of every meta row.
    expect(
      keys({
        subtasks: { done: 0, total: 0 },
        blockedByCount: 0,
        tagCount: 0,
        attachmentCount: 0,
        estimateMins: 0,
      }),
    ).toEqual([]);
  });

  it("orders the chips blocked → due → progress → the quiet counts", () => {
    // ⚠️ Fixed order is what makes the row scannable. Built from an object
    // whose keys are in a DIFFERENT order, so a key-order-dependent
    // implementation cannot pass by coincidence.
    expect(
      keys({
        estimateMins: 30,
        attachmentCount: 2,
        tagCount: 1,
        subtasks: { done: 1, total: 2 },
        dueAt: hours(4),
        blockedByCount: 1,
      }),
    ).toEqual(["blocked", "due", "subtasks", "tags", "attachments", "estimate"]);
  });

  it("marks an overdue task with a different icon, not only a colour", () => {
    // A tone alone excludes anyone who cannot see the difference between
    // muted and destructive.
    const late = taskMeta({ dueAt: hours(-4) }, NOW)[0];
    const soon = taskMeta({ dueAt: hours(4) }, NOW)[0];
    expect([late.icon, late.tone]).toEqual(["AlertTriangle", "danger"]);
    expect([soon.icon, soon.tone]).toEqual(["Clock", "muted"]);
  });

  it("stops calling a finished task overdue", () => {
    const chip = taskMeta(
      { dueAt: hours(-4), completedAt: hours(-1) },
      NOW,
    )[0];
    expect(chip.tone).toBe("muted");
    expect(chip.icon).toBe("Clock");
  });

  it("counts only OPEN blockers, which is the number it was handed", () => {
    const chip = taskMeta({ blockedByCount: 2 }, NOW)[0];
    expect(chip.label).toBe("2");
    expect(chip.tone).toBe("danger");
    expect(chip.title).toBe("Blocked by 2 unfinished tasks");
  });

  it("says 'task' rather than 'tasks' for one blocker", () => {
    expect(taskMeta({ blockedByCount: 1 }, NOW)[0].title).toBe(
      "Blocked by 1 unfinished task",
    );
  });

  it("reads subtask progress as done-over-total", () => {
    const chip = taskMeta({ subtasks: { done: 2, total: 5 } }, NOW)[0];
    expect(chip.label).toBe("2/5");
    expect(chip.title).toBe("2 of 5 subtasks done");
    expect(chip.tone).toBe("muted");
  });

  it("lifts the tone once every subtask is done", () => {
    // A parent whose checklist is complete is almost always a task somebody
    // forgot to close.
    expect(taskMeta({ subtasks: { done: 3, total: 3 } }, NOW)[0].tone).toBe(
      "accent",
    );
  });

  it("never invents a chip tone the component cannot paint", () => {
    const every = taskMeta(
      {
        dueAt: hours(-1),
        blockedByCount: 1,
        subtasks: { done: 4, total: 4 },
        tagCount: 3,
        attachmentCount: 1,
        estimateMins: 90,
      },
      NOW,
    );
    expect(every).toHaveLength(6);
    for (const chip of every) {
      expect(["muted", "danger", "accent"]).toContain(chip.tone);
      expect(chip.title.length).toBeGreaterThan(chip.label.length);
      expect(chip.icon).toMatch(/^[A-Z]/);
    }
  });

  it("gives every chip a distinct key", () => {
    const all = taskMeta(
      {
        dueAt: hours(1),
        blockedByCount: 1,
        subtasks: { done: 1, total: 2 },
        tagCount: 1,
        attachmentCount: 1,
        estimateMins: 5,
      },
      NOW,
    );
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
  });
});

// ── avatarStack ─────────────────────────────────────────────────────────────

describe("avatarStack", () => {
  it("shows everyone when the list is short", () => {
    expect(avatarStack(["a@x.io", "b@x.io"])).toEqual({
      shown: ["a@x.io", "b@x.io"],
      extra: 0,
    });
  });

  it("caps the row and counts the remainder", () => {
    // ⚠️ Uncapped, nine assignees push every other chip off a 288px column.
    expect(avatarStack(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      extra: 2,
    });
  });

  it("handles nobody without a crash or a phantom +0", () => {
    expect(avatarStack(undefined)).toEqual({ shown: [], extra: 0 });
    expect(avatarStack([])).toEqual({ shown: [], extra: 0 });
  });

  it("adds no +N when the list is exactly the cap", () => {
    // The off-by-one that shows "+0" on a full row.
    expect(avatarStack(["a", "b", "c"], 3)).toEqual({
      shown: ["a", "b", "c"],
      extra: 0,
    });
  });

  it("counts everyone as extra when the cap is zero", () => {
    // ⚠️ `length - max` with `max` of 0 is the whole list, which is right by
    // accident; a caller that passed a negative cap would get more than there
    // are people. Both take the explicit branch.
    expect(avatarStack(["a", "b"], 0)).toEqual({ shown: [], extra: 2 });
    expect(avatarStack(["a", "b"], -1)).toEqual({ shown: [], extra: 2 });
  });
});

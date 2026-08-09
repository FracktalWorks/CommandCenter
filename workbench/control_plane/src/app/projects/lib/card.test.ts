/**
 * WS-27s — the seam between a `TaskRow` and the shared card.
 *
 * The translation is small, which is exactly why it is worth pinning: the
 * failure mode is not a crash, it is a card that quietly draws nothing because
 * a snake_case field was read by its camelCase name and came back `undefined`.
 * A board full of tasks with no badges looks like a board full of simple tasks.
 */

import { describe, expect, it } from "vitest";

import type { TaskRow } from "./api";
import { cardChips, taskFacts } from "./card";

const NOW = Date.parse("2026-08-07T12:00:00Z");
const hours = (n: number) => new Date(NOW + n * 3_600_000).toISOString();

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  project_id: "p1",
  root_project_id: "p1",
  status_id: "s1",
  title: "Ship it",
  ...over,
});

describe("taskFacts", () => {
  it("reads every field off the snake_case row", () => {
    // ⚠️ The whole point of this test. A camelCase typo here is `undefined`,
    // and `undefined` draws no chip — a silent blank, not an error.
    expect(
      taskFacts(
        row({
          due_at: hours(-2),
          completed_at: hours(-1),
          subtasks: { done: 1, total: 3 },
          blocked_by_count: 2,
          tags: ["ops", "urgent"],
        }),
      ),
    ).toEqual({
      dueAt: hours(-2),
      completedAt: hours(-1),
      subtasks: { done: 1, total: 3 },
      blockedByCount: 2,
      tagCount: 2,
    });
  });

  it("defaults the counts a card must not guess at", () => {
    expect(taskFacts(row())).toEqual({
      dueAt: undefined,
      completedAt: undefined,
      subtasks: null,
      blockedByCount: 0,
      tagCount: 0,
    });
  });

  it("claims no attachments or estimate, because the list returns neither", () => {
    // Honest absence. A plausible zero would have the card assert something
    // the endpoint never told it.
    const facts = taskFacts(row()) as Record<string, unknown>;
    expect(facts.attachmentCount).toBeUndefined();
    expect(facts.estimateMins).toBeUndefined();
  });
});

describe("cardChips", () => {
  it("turns a loaded row into the strip the board draws", () => {
    expect(
      cardChips(
        row({
          due_at: hours(-2),
          subtasks: { done: 1, total: 3 },
          blocked_by_count: 1,
          tags: ["ops"],
        }),
        NOW,
      ).map((c) => [c.key, c.label]),
    ).toEqual([
      ["blocked", "1"],
      ["due", "2h ago"],
      ["subtasks", "1/3"],
      ["tags", "1"],
    ]);
  });

  it("leaves a plain task with a bare card", () => {
    expect(cardChips(row(), NOW)).toEqual([]);
  });

  it("stops calling a finished task overdue", () => {
    const chips = cardChips(
      row({ due_at: hours(-48), completed_at: hours(-1) }),
      NOW,
    );
    expect(chips.map((c) => c.tone)).toEqual(["muted"]);
  });
});

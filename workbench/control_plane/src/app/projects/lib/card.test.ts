/**
 * WS-27s — the seam between a `TaskRow` and the shared card.
 *
 * The translation is small, which is exactly why it is worth pinning: the
 * failure mode is not a crash, it is a card that quietly draws nothing because
 * a snake_case field was read by its camelCase name and came back `undefined`.
 * A board full of tasks with no badges looks like a board full of simple tasks.
 */

import { describe, expect, it } from "vitest";

import { taskMeta } from "@/lib/taskCard";

import type { TaskRow } from "./api";
import {
  CHIP_FIELD,
  cardChips,
  taskDeepLink,
  taskFacts,
  taskRef,
  visibleChips,
} from "./card";
import { DEFAULT_SHOWN } from "./shownFields";

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

describe("visibleChips — the shown-fields gate (WS-27x)", () => {
  // A row that earns every chip the list endpoint can produce.
  const loaded = row({
    due_at: hours(-2),
    subtasks: { done: 1, total: 3 },
    blocked_by_count: 1,
    tags: ["ops"],
  });

  it("draws every earned chip under the default shown set", () => {
    // The gate is a VISIBILITY layer: with the defaults it must change
    // nothing about what a card drew before shown-fields existed.
    expect(visibleChips(loaded, DEFAULT_SHOWN, NOW)).toEqual(
      cardChips(loaded, NOW),
    );
  });

  it("silences exactly the chip whose field was hidden", () => {
    const shown = DEFAULT_SHOWN.filter((key) => key !== "due_at");
    expect(visibleChips(loaded, shown, NOW).map((c) => c.key)).toEqual([
      "blocked",
      "subtasks",
      "tags",
    ]);
  });

  it("produces no chips at all when every field is hidden", () => {
    // "This view surfaces nothing" and "this task earned nothing" must read
    // identically — no placeholder, no dimmed chip.
    expect(visibleChips(loaded, [], NOW)).toEqual([]);
  });

  it("keeps the fact layer intact — gating filters, never re-derives", () => {
    const [chip] = visibleChips(loaded, ["blocked"], NOW);
    expect(chip).toEqual(cardChips(loaded, NOW)[0]);
  });

  it("maps every chip kind taskMeta can emit onto a field key", () => {
    // An unmapped chip kind would bypass the gate silently. Derived from
    // `taskMeta` itself over fully-loaded facts, so a chip added there
    // without a mapping here fails loudly.
    const everyChip = taskMeta(
      {
        dueAt: hours(-2),
        subtasks: { done: 1, total: 2 },
        blockedByCount: 1,
        tagCount: 1,
        attachmentCount: 1,
        estimateMins: 30,
      },
      NOW,
    ).map((c) => c.key);
    expect(everyChip.length).toBeGreaterThanOrEqual(6);
    for (const key of everyChip) {
      expect(CHIP_FIELD[key], `chip '${key}' has no shown-field mapping`).toBeDefined();
    }
  });
});

describe("taskRef", () => {
  // WS-27w item 6 — one formatter, three surfaces (board, list, panel).
  it("formats the per-root number as the id people quote", () => {
    expect(taskRef(row({ task_number: 42 }))).toBe("#42");
  });

  it("is null — never '#undefined' — when the number is absent", () => {
    // Each surface keeps its own honest fallback; the formatter must not
    // invent one, or an imported task without a number renders as a lie.
    expect(taskRef(row())).toBeNull();
    expect(taskRef(row({ task_number: null }))).toBeNull();
  });
});

describe("taskDeepLink", () => {
  it("builds the ?task= link the board already reads", () => {
    // The same shape NotificationBell emits (WS-28b): a third spelling would
    // be a copied link that opens nothing.
    expect(taskDeepLink(row(), "https://cc.example")).toBe(
      "https://cc.example/projects?task=t1",
    );
  });

  it("is origin-relative when no origin is given, and encodes the id", () => {
    expect(taskDeepLink({ id: "a b" })).toBe("/projects?task=a%20b");
  });
});

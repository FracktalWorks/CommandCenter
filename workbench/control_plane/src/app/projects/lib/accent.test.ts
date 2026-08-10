/**
 * Projects · the facts this app feeds the shared colour vocabulary (WS-27ad).
 *
 * The palette and its precedence are pinned in `src/lib/statusAccent.test.ts`.
 * What is pinned here is the translation — and specifically the two ways it
 * could quietly go wrong: a stored colour being ignored (which is the bug this
 * ticket exists to fix — `pm_task_statuses.color` had been stored and never
 * drawn since migration 146), and a non-status axis being read for meaning it
 * does not have.
 */

import { describe, expect, it } from "vitest";

import { statusAccent } from "@/lib/statusAccent";

import { accentForDisposition, accentForGroup, accentForStatus } from "./accent";
import type { StatusRow } from "./api";
import { DISPOSITION_LANES, LANE_LABELS, OTHER_LANE } from "./mywork";

const status = (over: Partial<StatusRow>): StatusRow => ({
  id: "s1",
  project_id: "p1",
  name: "To do",
  color: "gray",
  position: 10,
  category: "todo",
  is_default: false,
  ...over,
});

describe("accentForStatus", () => {
  it("draws the colour the owner stored", () => {
    // The whole point of the ticket: this column used to be `bg-muted` like
    // every other, whatever the row said.
    expect(accentForStatus(status({ color: "green", category: "todo" }))).toEqual(
      statusAccent({ color: "green" }),
    );
  });

  it("falls back to the category when no colour is stored", () => {
    expect(accentForStatus(status({ color: "", category: "in_progress" }))).toEqual(
      statusAccent({ category: "in_progress" }),
    );
  });

  it("never reads the status NAME", () => {
    // A Projects lane called "Waiting on legal" in the `todo` category is a
    // todo lane. /tasks guesses from names because it has nothing better;
    // Projects has a category and must not second-guess it.
    const named = accentForStatus(status({ name: "Waiting on legal", color: "", category: "todo" }));
    expect(named).toEqual(statusAccent({ category: "todo" }));
    expect(named).not.toEqual(statusAccent({ name: "Waiting on legal" }));
  });

  it("is positional when there is no status at all", () => {
    expect(accentForStatus(undefined, 1, 4)).toEqual(statusAccent({ index: 1, total: 4 }));
  });
});

describe("accentForGroup", () => {
  const statuses = [
    status({ id: "todo", color: "blue", category: "todo" }),
    status({ id: "done", color: "green", category: "done" }),
  ];

  it("resolves a status column through its row", () => {
    expect(accentForGroup("status", "done", 1, 2, statuses)).toEqual(
      statusAccent({ color: "green" }),
    );
  });

  it("is positional for the unset lane, which has no row", () => {
    expect(accentForGroup("status", "__unset__", 1, 3, statuses)).toEqual(
      statusAccent({ index: 1, total: 3 }),
    );
  });

  it("never reads a person's or a tag's name for meaning", () => {
    // "Mark Green" is a colleague, not a done lane.
    expect(accentForGroup("assignee", "Mark Green", 1, 3, statuses)).toEqual(
      statusAccent({ index: 1, total: 3 }),
    );
    expect(accentForGroup("tag", "blocked", 0, 3, statuses)).toEqual(
      statusAccent({ index: 0, total: 3 }),
    );
  });

  it("gives neighbouring lanes different hues off the status axis", () => {
    const hues = [0, 1, 2, 3].map(
      (index) => accentForGroup("assignee", `p${index}`, index, 4, statuses).dot,
    );
    expect(new Set(hues).size).toBe(4);
  });
});

describe("accentForDisposition", () => {
  /**
   * True when the shared vocabulary can read a hue out of the label itself.
   *
   * `keywordHue` is private to `statusAccent.ts`, so this asks the question the
   * only way a caller can: if the answer does not move when the positional
   * index moves, a keyword decided it.
   */
  const keywordDecides = (label: string) =>
    JSON.stringify(statusAccent({ name: label, index: 0 })) ===
    JSON.stringify(statusAccent({ name: label, index: 1 }));

  it("agrees with the keyword route wherever that route has an opinion", () => {
    // AGENTS.md rule 5: a category and a name must resolve to the same colour,
    // or "Waiting on" is amber in one app and something else in the other.
    const pinned = [...DISPOSITION_LANES, OTHER_LANE].filter((lane) =>
      keywordDecides(LANE_LABELS[lane] ?? lane),
    );
    expect(pinned, "no lane label carries a keyword — check LANE_LABELS").not.toEqual([]);
    for (const lane of pinned) {
      expect(accentForDisposition(lane), `${lane} disagrees with its own name`).toEqual(
        statusAccent({ name: LANE_LABELS[lane] ?? lane }),
      );
    }
  });

  it("gives the four work lanes four different hues", () => {
    // They are read side by side in one scrolling pane; two lanes wearing one
    // colour is the /projects-board-in-grey failure at a smaller scale.
    const dots = DISPOSITION_LANES.map((lane) => accentForDisposition(lane).dot);
    expect(new Set(dots).size).toBe(DISPOSITION_LANES.length);
  });

  it("renders an unmapped disposition rather than failing", () => {
    // `REFERENCE`, `PROJECT`, and whatever the server grows next.
    expect(accentForDisposition("REFERENCE").dot).toBeTruthy();
    expect(accentForDisposition("")).toEqual(statusAccent({ name: "" }));
  });
});

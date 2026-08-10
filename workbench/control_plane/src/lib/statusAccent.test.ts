/**
 * The shared status colour vocabulary (WS-27ad).
 *
 * The property worth pinning is the PRECEDENCE, not the class strings: this
 * module exists because two apps knew different things about a lane and each
 * needs the most authoritative fact it has to win. So most of these assert on
 * `resolveHue`, and only the shape test touches classes.
 *
 * The regression it also guards: /tasks was rendering from `stageColors.ts`
 * before this merge, and its behaviour had to survive byte-for-byte. Every
 * keyword and the positional fallback are asserted here for that reason.
 */

import { describe, expect, it } from "vitest";

import {
  ACCENT_HUES,
  type AccentHue,
  accentForHue,
  resolveHue,
  statusAccent,
} from "./statusAccent";

describe("precedence", () => {
  it("a stored colour beats everything else", () => {
    // The owner picked it. A category or a keyword overruling a human choice is
    // the UI editing somebody's decision behind their back.
    expect(
      resolveHue({
        color: "red",
        category: "done",
        name: "Done",
        index: 3,
        total: 4,
        lastIsDone: true,
      }),
    ).toBe("red");
  });

  it("a category beats a name that disagrees with it", () => {
    // A lane named "Shipped" whose category is `in_progress` is in progress —
    // the name would have said green, and the category is the better fact.
    expect(resolveHue({ category: "in_progress", name: "Shipped" })).toBe("blue");
  });

  it("a name keyword beats position", () => {
    expect(resolveHue({ name: "Blocked on legal", index: 1, total: 4 })).toBe("amber");
  });

  it("falls through to position when nothing is known", () => {
    expect(resolveHue({ index: 1, total: 4 })).toBe("blue");
  });
});

describe("stored colour names", () => {
  it.each([
    ["gray", "gray"],
    ["grey", "gray"],
    ["red", "red"],
    ["amber", "amber"],
    ["green", "green"],
    ["blue", "blue"],
    ["violet", "violet"],
    ["purple", "violet"],
    ["orange", "amber"],
    ["yellow", "amber"],
  ])("resolves %s → %s", (stored, hue) => {
    expect(resolveHue({ color: stored })).toBe(hue);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveHue({ color: "  GREEN " })).toBe("green");
  });

  it("falls THROUGH an unknown colour rather than throwing or blanking", () => {
    // A board that renders no columns because somebody typed "chartreuse" is a
    // worse failure than a column that comes out the category's colour.
    expect(resolveHue({ color: "chartreuse", category: "done" })).toBe("green");
    expect(resolveHue({ color: "chartreuse" })).toBe("gray");
  });
});

describe("the six status categories all resolve", () => {
  // Mirrors `STATUS_CATEGORIES` in routes/projects/core.py. A category the
  // gateway can store and this cannot colour is a lane that silently goes grey.
  it.each([
    ["backlog", "gray"],
    ["todo", "gray"],
    ["in_progress", "blue"],
    ["done", "green"],
    ["cancelled", "red"],
    ["triage", "violet"],
  ])("%s → %s", (category, hue) => {
    expect(resolveHue({ category })).toBe(hue);
  });

  it("falls through an unknown category", () => {
    expect(resolveHue({ category: "parked", name: "Done" })).toBe("green");
  });

  // THE fence for this module's whole reason to exist.
  //
  // /projects learns what a lane means from its `category`; /tasks can only
  // read the words in its name. If those two routes disagreed, the same lane
  // would draw one colour in one app and another colour next door — which is
  // the divergence this module was built to end, reintroduced one layer down.
  //
  // It happened: the category map originally mirrored the seeded colours
  // (`todo` blue, `in_progress` amber) while the keyword rules said gray and
  // blue, so a default board still mismatched in two of its four lanes.
  //
  // Each pair below is a category and a lane name a person would plausibly type
  // for it. `backlog`/`todo` share a hue on purpose (see CATEGORY_HUES).
  it.each([
    ["backlog", "Backlog"],
    ["todo", "To do"],
    ["in_progress", "In progress"],
    ["done", "Done"],
  ])("category %s and the name %j resolve to the same hue", (category, name) => {
    expect(resolveHue({ category })).toBe(resolveHue({ name }));
  });
});

describe("name keywords — /tasks' stages, ported unchanged", () => {
  it.each([
    ["Done", "green"],
    ["Complete", "green"],
    ["Closed", "green"],
    ["Finished", "green"],
    ["Shipped", "green"],
    ["Waiting", "amber"],
    ["Blocked", "amber"],
    ["On hold", "amber"],
    ["Paused", "amber"],
    ["Stuck", "amber"],
    ["In progress", "blue"],
    ["Doing", "blue"],
    ["Active", "blue"],
    ["Working", "blue"],
    ["In review", "blue"],
    ["In-process", "blue"],
    ["To do", "gray"],
    ["Todo", "gray"],
    ["Backlog", "gray"],
    ["New", "gray"],
    ["Open", "gray"],
    ["Inbox", "gray"],
  ])("%s → %s", (name, hue) => {
    expect(resolveHue({ name })).toBe(hue);
  });

  it("has no `cancel` rule — adding one would repaint a /tasks stage", () => {
    // Recorded as a test rather than a comment: the omission is deliberate and
    // the next author's instinct will be to "fix" it.
    expect(resolveHue({ name: "Cancelled", index: 1, total: 4 })).toBe("blue");
  });
});

describe("positional fallback", () => {
  it("gives neighbouring lanes different hues", () => {
    const hues = [0, 1, 2, 3].map((index) =>
      resolveHue({ name: "Lane", index, total: 8 }),
    );
    expect(hues).toEqual(["gray", "blue", "violet", "amber"]);
  });

  it("wraps past the end of the palette instead of failing", () => {
    expect(resolveHue({ name: "Lane", index: 4, total: 8 })).toBe("gray");
  });

  it("paints the last lane green only when the caller asked", () => {
    // /tasks: the final stage IS the done stage (dropping there completes).
    expect(resolveHue({ name: "Later", index: 3, total: 4, lastIsDone: true })).toBe("green");
    // Projects: a lane's meaning comes from its category, never its position.
    expect(resolveHue({ name: "Later", index: 3, total: 4 })).toBe("amber");
  });

  it("survives being asked about nothing at all", () => {
    expect(resolveHue({})).toBe("gray");
  });
});

describe("the accent shape", () => {
  it("gives every hue all five slots, from tokens only", () => {
    for (const hue of ACCENT_HUES) {
      const accent = accentForHue(hue as AccentHue);
      for (const slot of ["dot", "soft", "text", "bar", "chip"] as const) {
        expect(accent[slot], `${hue}.${slot}`).toBeTruthy();
        // DESIGN_SYSTEM.md rule 1, asserted where the palette actually lives.
        expect(accent[slot], `${hue}.${slot} must not name a raw colour`).not.toMatch(
          /#[0-9a-f]{3,6}\b|rgba?\(|hsla?\(/i,
        );
      }
    }
  });

  it("keeps /tasks' stage classes byte-identical", () => {
    // The five strings `stageColors.ts` returned for a green stage. /tasks
    // renders from these on its board, its list headers and its status pill,
    // so a change here is a change to a shipped surface.
    expect(statusAccent({ name: "Done" })).toMatchObject({
      dot: "bg-success",
      soft: "bg-success/10",
      text: "text-success",
      bar: "border-l-success",
    });
    expect(statusAccent({ name: "Backlog" })).toMatchObject({
      dot: "bg-muted-foreground/60",
      soft: "bg-muted/40",
      text: "text-muted-foreground",
      bar: "border-l-muted-foreground/40",
    });
    expect(statusAccent({ name: "Lane", index: 2, total: 8 })).toMatchObject({
      dot: "bg-primary/60",
      soft: "bg-primary/5",
      text: "text-primary/80",
      bar: "border-l-primary/50",
    });
  });

  it("keeps the tag chip classes byte-identical", () => {
    // `chipClass` in app/projects/lib/tags.ts returned exactly these.
    expect(statusAccent({ color: "gray" }).chip).toBe("bg-secondary text-muted-foreground");
    expect(statusAccent({ color: "red" }).chip).toBe("bg-destructive/10 text-destructive");
    expect(statusAccent({ color: "amber" }).chip).toBe("bg-warning/10 text-warning");
    expect(statusAccent({ color: "green" }).chip).toBe("bg-success/10 text-success");
    expect(statusAccent({ color: "blue" }).chip).toBe("bg-primary/10 text-primary");
    expect(statusAccent({ color: "violet" }).chip).toBe("bg-accent text-accent-foreground");
  });
});

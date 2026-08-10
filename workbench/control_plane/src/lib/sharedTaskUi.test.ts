/**
 * The /projects ↔ /tasks shared seam, made mechanical (WS-27ad, done-when 4).
 *
 * Round 1 of the continuity backport promoted the chip vocabulary, the keyboard
 * cursor, the group-context quick-add and the post-drop flash into `src/lib/`
 * and `src/components/`, leaving app-local re-export shims behind. Round 2 added
 * the colour vocabulary and the card shell. All of it works exactly as long as
 * nobody re-declares their own copy — and a second copy is invisible in review,
 * because both apps keep passing their own tests while slowly diverging. That
 * is how the two boards got two palettes in the first place.
 *
 * So the rule is a test: **the shared module is the only declaration, and both
 * apps reach it.** Re-export shims are fine and expected (they keep app-local
 * import paths working); a shim that grows a body is not.
 *
 * Rooted at `src/` via `import.meta.url`, never at the process cwd — a checkout
 * with agent worktrees under `.claude/worktrees/` would otherwise be scanned as
 * part of itself and report every shared module as duplicated.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        out.push(relative(SRC, full).split(sep).join("/"));
    }
  };
  walk(SRC);
  return out.sort();
}

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const FILES = sourceFiles();

/**
 * One shared thing: where it is declared, and how a re-declaration would read.
 *
 * The pattern deliberately matches a DECLARATION (`export function foo`,
 * `const FOO: Record<…> =`) rather than a mention, so a file that imports the
 * symbol, re-exports it, or names it in a comment is not an offender.
 */
const SEAM: { what: string; home: string; declaration: RegExp }[] = [
  {
    what: "the keyboard cursor",
    home: "lib/cursor.ts",
    declaration: /export\s+function\s+(stepCursor|clampCursor)\b/,
  },
  {
    what: "the group-context quick-add control",
    home: "components/QuickAdd.tsx",
    declaration: /export\s+function\s+QuickAdd\b/,
  },
  {
    what: "the post-drop flash",
    home: "components/useFlash.ts",
    declaration: /export\s+function\s+useFlash\b/,
  },
  {
    what: "the selection grammar",
    home: "lib/selection.ts",
    declaration: /export\s+function\s+(clickSelect|range|toggle|prune)\b/,
  },
  {
    what: "the drop-gap target",
    home: "components/DropGap.tsx",
    declaration: /export\s+function\s+DropGap\b/,
  },
  {
    what: "the drop-index arithmetic",
    home: "lib/boardDrop.ts",
    declaration: /export\s+function\s+(dropIndexFor|gapKey)\b/,
  },
  {
    what: "the chip vocabulary",
    home: "lib/taskCard.ts",
    declaration: /export\s+type\s+MetaTone\b/,
  },
  {
    what: "the chip renderer",
    home: "components/TaskMeta.tsx",
    declaration: /export\s+function\s+TaskMeta\b/,
  },
  {
    what: "the status colour vocabulary",
    home: "lib/statusAccent.ts",
    declaration: /export\s+function\s+(statusAccent|resolveHue)\b/,
  },
  {
    what: "the status pill",
    home: "components/StatusChip.tsx",
    declaration: /export\s+function\s+StatusChip\b/,
  },
  {
    what: "the task card shell",
    home: "components/TaskCardShell.tsx",
    declaration: /export\s+function\s+TaskCardShell\b/,
  },
  {
    what: "the empty state",
    home: "components/EmptyState.tsx",
    declaration: /export\s+function\s+EmptyState\b/,
  },
];

describe("one implementation, consumed twice", () => {
  it.each(SEAM)("$what is declared only in $home", ({ home, declaration }) => {
    const offenders = FILES.filter((f) => f !== home && declaration.test(read(f)));
    expect(
      offenders,
      `A second copy of what ${home} owns. Import it (or re-export it); ` +
        "two implementations of one interaction is how /projects and /tasks " +
        "stopped looking like one product.",
    ).toEqual([]);
  });

  it.each(SEAM)("$home exists and still declares it", ({ home, declaration }) => {
    expect(FILES, `${home} is missing — update SEAM in this file`).toContain(home);
    expect(read(home)).toMatch(declaration);
  });
});

describe("both apps reach the shared modules", () => {
  /** Files under an app that import from a shared path, directly or via a shim. */
  const importsFrom = (app: string, module: string) =>
    FILES.filter(
      (f) =>
        f.startsWith(`app/${app}/`) &&
        new RegExp(`from ["']@/${module}["']`).test(read(f)),
    );

  /** A shim: an app-local file whose whole body re-exports the shared one. */
  const shims = (app: string, module: string) =>
    importsFrom(app, module).filter((f) => /export\s*(\{|\*)/.test(read(f)));

  const reaches = (app: string, module: string) =>
    importsFrom(app, module).length > 0;

  it.each([
    ["projects", "lib/cursor"],
    ["projects", "lib/selection"],
    ["projects", "components/QuickAdd"],
    ["projects", "components/useFlash"],
    ["projects", "lib/statusAccent"],
    ["projects", "components/StatusChip"],
    ["projects", "components/TaskCardShell"],
    ["projects", "components/DropGap"],
    ["projects", "lib/boardDrop"],
    // S4 — /tasks is deliberately absent: `ItemList.tsx` still holds the
    // original local `NoMatchState`/`EmptyState` pair this was promoted FROM,
    // and retiring them onto the shared box is a `/tasks` edit that another
    // slice holds open. Add the row in the change that does it.
    ["projects", "components/EmptyState"],
    ["tasks", "lib/cursor"],
    ["tasks", "lib/selection"],
    ["tasks", "components/QuickAdd"],
    ["tasks", "components/useFlash"],
    ["tasks", "lib/statusAccent"],
    ["tasks", "components/StatusChip"],
    ["tasks", "components/TaskCardShell"],
    ["tasks", "components/DropGap"],
    ["tasks", "lib/boardDrop"],
  ])("/%s consumes @/%s", (app, module) => {
    expect(
      reaches(app, module),
      `/${app} no longer imports @/${module} — either it grew its own copy ` +
        "(the failure this test exists for) or it genuinely stopped needing " +
        "it, in which case drop the row.",
    ).toBe(true);
  });

  it("the shims stay shims", () => {
    // A re-export shim that acquires logic is a third implementation wearing a
    // forwarding file's name. Body = anything that is not an import, an export
    // statement, a comment or blank.
    const suspects = [
      ...shims("projects", "lib/cursor"),
      ...shims("projects", "components/QuickAdd"),
      ...shims("projects", "components/useFlash"),
      ...shims("tasks", "lib/statusAccent"),
    ];
    expect(suspects.length, "no shims found — the seam moved").toBeGreaterThan(0);

    const fat = suspects.filter((f) => {
      const body = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/^\s*(import|export)\b[\s\S]*?(;|\n)/gm, "")
        .trim();
      return body.length > 0;
    });
    expect(
      fat,
      "A re-export shim grew a body. Put the logic in the shared module.",
    ).toEqual([]);
  });
});

describe("neither task app re-declares the colour palette", () => {
  /**
   * Scoped to the two task apps and the shared layer, which is what WS-27ad
   * reconciled.
   *
   * `app/crm/lib/board.ts` holds a THIRD name→class map (gray/blue/green/
   * amber/violet, for pipeline stages). It is out of this ticket's scope and
   * recorded rather than silently swept in: the CRM's stages are a different
   * axis, its map has only a `dot`, and folding it in is a CRM decision, not a
   * side effect of a Projects↔Tasks continuity pass. When somebody takes it,
   * delete this exemption rather than widening the regex.
   */
  const SCOPE = /^(app\/(projects|tasks)\/|lib\/|components\/)/;

  it("only the shared module maps a hue name to classes", () => {
    // The specific regression: `app/tasks/lib/stageColors.ts` and
    // `app/projects/lib/tags.ts` each held their own `Record` of tailwind
    // classes per colour name, and they disagreed about gray and violet.
    const offenders = FILES.filter(
      (f) =>
        f !== "lib/statusAccent.ts" &&
        SCOPE.test(f) &&
        /\b(?:gray|grey|amber|violet)\s*:\s*["'`][^"'`]*\b(?:bg|text|border)-/.test(
          read(f),
        ),
    );
    expect(
      offenders,
      "A second palette keyed by colour name. Use `statusAccent()` — a tag " +
        "and a status lane that both say 'green' have to BE the same green.",
    ).toEqual([]);
  });
});

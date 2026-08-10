/**
 * Source files must be readable by the tools that police them.
 *
 * `src/app/projects/components/TaskBoard.tsx` carried a literal NUL byte at
 * offset 10623 — a composite-key separator written as a raw NUL byte inside a
 * template literal rather than the two-character escape `\0`. Both produce the
 * same runtime string. Only one of them keeps the file plain text.
 *
 * The consequence was not cosmetic. **ripgrep stops at the first NUL**, so every
 * directory-wide scan silently saw only the first third of that file — and it
 * stayed silent when the file was named explicitly too. This repo's guard rails
 * are overwhelmingly source scans (`sharedTaskUi.test.ts`, the theme conformance
 * suite, the Python-side structural tests, and every `grep` a human or an agent
 * runs while deciding what is true). A file that reads as binary is a file those
 * scans quietly exempt, and an exemption nobody declared is the worst kind: the
 * fences all pass, and they pass because they never looked.
 *
 * A NUL is the only byte that does this, which is why this test checks for that
 * and not for "unusual characters" generally — the tree is full of legitimate
 * em-dashes, arrows and emoji, and a broad rule would be noise that gets muted.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

/** Every source file under `src/`, excluding build output and dependencies. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.(ts|tsx|js|jsx|css|json|md)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("source files stay greppable", () => {
  it("no source file contains a NUL byte", () => {
    const offenders = sourceFiles(SRC)
      .map((path) => ({ path, at: readFileSync(path).indexOf(0) }))
      .filter(({ at }) => at !== -1)
      .map(({ path, at }) => `${path.slice(SRC.length + 1)} (offset ${at})`);

    expect(
      offenders,
      "A NUL byte makes ripgrep treat the file as binary and stop reading at " +
        "that offset — so every source-scanning fence in this repo silently " +
        "skips the rest of the file while still reporting green. If you need a " +
        "NUL in a string, write the escape `\\0`: same runtime value, plain-text " +
        "file.",
    ).toEqual([]);
  });

  it("finds files at all", () => {
    // Guards the guard: a walker that silently matched nothing would make the
    // test above pass while checking an empty list.
    expect(sourceFiles(SRC).length).toBeGreaterThan(200);
  });
});

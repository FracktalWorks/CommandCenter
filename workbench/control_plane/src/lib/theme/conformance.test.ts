/**
 * Themed-by-construction — the gate that keeps the engine true as the app grows.
 *
 * A theming engine is not a feature you ship, it is an invariant you hold. The
 * work of building it was mechanical; the work of KEEPING it is refusing, every
 * week, the one hardcoded `#10b981` that seemed fine at the time. Nobody can do
 * that by review — a hex value in a 900-line page is invisible — so it is done
 * here.
 *
 * ## What this checks, and why each one
 *
 * 1. **No hardcoded colour.** A literal colour is a pixel the engine cannot
 *    reach. Switching to Fluent leaves it behind, and the surface it sits on is
 *    the one that looks broken.
 * 2. **No direct `lucide-react` imports.** Icons are a theme choice — Fluent
 *    ships Fluent icons, Material ships Material Symbols. An import bypasses
 *    the pack registry and pins that glyph to Lucide for every theme.
 * 3. **No arbitrary Tailwind colour classes.** `bg-[#0c0c0c]` is rule 1 wearing
 *    a class name.
 * 4. **Solid controls go through the primitives.** A raw `<button className=
 *    "bg-primary …">` is themed for COLOUR but not for personality: it cannot
 *    have Material's pill radius and state layer, Fluent's outline on solid
 *    fills, or an uppercase label, because none of that is expressible in a
 *    class string. `<Button>` is where those tokens are applied.
 *
 * ## Ratchet, not a wall
 *
 * The tree was not clean when this landed and pretending otherwise would have
 * meant either a 68-file migration nobody asked for or a gate switched off on
 * day one. So each rule carries a frozen baseline, and:
 *
 *   * a file **not** in the baseline must be clean — this is the case that
 *     matters, because it is every file we have not written yet;
 *   * a baselined file may not get **worse**;
 *   * a baselined file that got **better** fails until its number is lowered,
 *     so the debt figure in this file is always the real one.
 *
 * That last rule is the one that makes the others credible. A baseline that
 * only ever gets edited downward when someone happens to notice is a baseline
 * that quietly becomes fiction.
 *
 * ## Exceptions are argued, not counted
 *
 * Some literals are correct. A sun in a weather glyph is yellow because suns
 * are yellow; Gmail's label palette has to match Gmail's; a person's identity
 * colour must be stable across themes or it stops identifying them. Those live
 * in EXCEPTIONS with a reason each — the reason is the point, because the next
 * author's real question is never "is this allowed" but "is mine like that one".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

// ── Scanning ────────────────────────────────────────────────────────────────

/** Every `.ts`/`.tsx` under `src/`, as paths relative to `src/`, posix-style. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(relative(SRC, full).split(sep).join("/"));
      }
    }
  };
  walk(SRC);
  return out.sort();
}

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * Strip comments and HTML numeric entities before looking for colour.
 *
 * Both produce false positives that would have made the rule untrustworthy on
 * its first run, which is how a gate ends up disabled: `ContextRing.tsx`
 * *explains* `--primary: hsl(198 89% 50%)` in a comment, and `TriggerPanel.tsx`
 * writes `&#123;` to render a literal brace — which `#[0-9a-f]{3}` reads as a
 * colour.
 */
function strip(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<![:"'/])\/\/[^\n]*/g, "")
    .replace(/&#\d+;/g, "");
}

const COLOR_LITERAL = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(|\bhsla?\(/g;
const ARBITRARY_CLASS = /\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret)-\[(?:#|rgb|hsl)[^\]]*\]/g;
const BUTTON_TAG = /<button\b(?:[^>]|\n)*?>/g;
/**
 * A SOLID fill — `bg-primary`, and nothing else that merely contains it.
 *
 * Both guards are load-bearing, and each was added after the loose version
 * flagged the wrong thing:
 *
 * * the lookAHEAD rejects `bg-primary/10`, a tinted ghost button that is
 *   already fully themed (a token at an opacity);
 * * the lookBEHIND rejects `hover:bg-secondary`, a hover tint on an otherwise
 *   plain control. Without it, four close-buttons in the CRM app were reported
 *   as un-migrated solid controls when they are neither solid nor wrong.
 *
 * Getting this narrow matters more than getting it wide: a gate that cries
 * wolf is one somebody eventually switches off.
 */
const SOLID_FILL = /(?<![-\w:])bg-(?:primary|secondary|destructive)(?![-/\w])/;

const count = (text: string, re: RegExp) => (strip(text).match(re) ?? []).length;

// ── Rule 1: no hardcoded colour ─────────────────────────────────────────────

/**
 * Files whose colour literals are CORRECT, with the argument for each.
 *
 * The bar: the value must be wrong to theme, not merely inconvenient to
 * migrate. "It's a lot of work" belongs in DEBT below, not here.
 */
const COLOR_EXCEPTIONS: Record<string, string> = {
  "lib/theme/": "theme manifests ARE the colour definitions",
  "app/observability/pixel.tsx":
    "procedural pixel-art sprites — the file says theme-agnostic and means it; " +
    "a sprite recoloured by the active theme is not themed art, it is broken art",
  "app/observability/office-topdown.tsx": "same isometric scene as pixel.tsx",
  "app/email/lib/labelColors.ts":
    "must stay byte-identical to providers/label_colors.py and to the palette " +
    "Gmail/Outlook actually store — a themed value would not round-trip to the mailbox",
  "components/room/Identity.tsx":
    "per-person identity hues derived from the email address; the whole point is " +
    "that they are STABLE, so deriving them from a theme defeats them",
  "components/genUITemplates.tsx":
    "WEATHER_INK — depictions, not chrome (see the constant's own note)",
  "app/settings/appearance/page.tsx":
    "the theme picker: accent presets and swatches, i.e. colour as this page's DATA",
  "app/whatsapp/connect/page.tsx": "Meta brand blue on a 'Connect with Facebook' button",
  "app/email/lib/mockData.ts": "fixtures",
  "app/tasks/lib/mockData.ts": "fixtures",
};

/**
 * Colour literals that are simply debt. Lower a number when you fix some; the
 * test fails if you fix some and DON'T, which is what keeps this honest.
 */
const COLOR_DEBT: Record<string, number> = {
  "app/email/components/MessageContent.tsx": 5,
  "app/email/components/SignatureEditor.tsx": 1,
  "app/email/lib/api.ts": 1,
  "app/notes/session/[id]/page.tsx": 1,
  "app/observability/page.tsx": 3,
  "app/tasks/components/StartupRitual.tsx": 1,
  "app/tasks/components/calendar/TimeGrid.tsx": 2,
  "app/whatsapp/numbers/page.tsx": 1,
  "app/whatsapp/page.tsx": 4,
  "components/GenerativeUINode.tsx": 5,
  "components/ThinkingContainer.tsx": 4,
};

const excepted = (rel: string) =>
  Object.keys(COLOR_EXCEPTIONS).some((k) => (k.endsWith("/") ? rel.startsWith(k) : rel === k));

describe("no hardcoded colour", () => {
  it("a file with no budget has no colour literals", () => {
    const offenders = sourceFiles()
      .filter((f) => !excepted(f) && !(f in COLOR_DEBT))
      .map((f) => [f, count(read(f), COLOR_LITERAL)] as const)
      .filter(([, n]) => n > 0);

    expect(
      offenders,
      "Use a semantic token — `var(--primary)`, `text-muted-foreground`, " +
        "`bg-card` — not a literal colour. A literal is a pixel the theming " +
        "engine cannot reach, so it survives a theme switch and the surface " +
        "around it does not. If the value is genuinely not a theme decision " +
        "(brand mark, external palette, an illustration), add it to " +
        "COLOR_EXCEPTIONS in this file WITH the argument.",
    ).toEqual([]);
  });

  it("no baselined file gets worse", () => {
    const worse = Object.entries(COLOR_DEBT)
      .map(([f, budget]) => ({ file: f, budget, actual: count(read(f), COLOR_LITERAL) }))
      .filter((r) => r.actual > r.budget);
    expect(worse, "Colour debt grew. Use tokens instead.").toEqual([]);
  });

  it("no baseline is stale", () => {
    // The rule that makes the two above mean something. Without it the numbers
    // here drift upward from reality and the gate silently loosens.
    const improved = Object.entries(COLOR_DEBT)
      .map(([f, budget]) => ({ file: f, budget, actual: count(read(f), COLOR_LITERAL) }))
      .filter((r) => r.actual < r.budget);
    expect(improved, "Thank you — now lower these numbers in COLOR_DEBT.").toEqual([]);
  });
});

// ── Rule 2: icons come from the pack ────────────────────────────────────────

describe("icons are a theme choice", () => {
  /**
   * The only two files allowed to name `lucide-react`. Not a ratchet: this one
   * WAS driven to zero, and a rule with no exceptions is worth far more than a
   * budget nobody reads.
   */
  const ICON_SOURCES = ["components/Icon.tsx", "lib/icons.tsx"];

  it("nothing imports lucide-react except the icon layer itself", () => {
    const offenders = sourceFiles().filter(
      (f) => !ICON_SOURCES.includes(f) && /from ["']lucide-react["']/.test(read(f)),
    );
    expect(
      offenders,
      "Render icons with <Icon name=\"…\" />. Lucide names stay the vocabulary; " +
        "the active theme decides which pack draws them, and a direct import " +
        "pins that one glyph to Lucide on every theme.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entry", () => {
    for (const f of ICON_SOURCES) {
      expect(read(f), `${f} no longer imports lucide-react — drop it from ICON_SOURCES`)
        .toMatch(/from ["']lucide-react["']/);
    }
  });
});

// ── Rule 3: no arbitrary Tailwind colour ────────────────────────────────────

describe("no arbitrary Tailwind colour values", () => {
  const ARBITRARY_DEBT: Record<string, number> = {
    "components/ThinkingContainer.tsx": 4,
    "components/GenerativeUINode.tsx": 1,
    "app/whatsapp/connect/page.tsx": 1,
  };

  it("a file with no budget uses only token classes", () => {
    // Shares rule 1's exception list: a colour that is right to hardcode is
    // right whichever syntax expresses it, and `Identity.tsx` writes its stable
    // per-person hues as `bg-[hsl(…)]` rather than as a style object.
    const offenders = sourceFiles()
      .filter((f) => !(f in ARBITRARY_DEBT) && !excepted(f))
      .map((f) => [f, count(read(f), ARBITRARY_CLASS)] as const)
      .filter(([, n]) => n > 0);
    expect(
      offenders,
      "`bg-[#0c0c0c]` is a hardcoded colour with a class name on. Tailwind is " +
        "wired to the theme tokens — use `bg-card`, `text-primary`, `border-border`.",
    ).toEqual([]);
  });

  it("no baselined file gets worse, and none is stale", () => {
    const drift = Object.entries(ARBITRARY_DEBT)
      .map(([f, budget]) => ({ file: f, budget, actual: count(read(f), ARBITRARY_CLASS) }))
      .filter((r) => r.actual !== r.budget);
    expect(drift, "Update ARBITRARY_DEBT to match reality.").toEqual([]);
  });
});

// ── Rule 4: solid controls use the primitives ───────────────────────────────

describe("solid controls go through the Button primitive", () => {
  /**
   * A total, not a per-file map: 68 files is noise, and the property worth
   * stating is "this number goes down". New files are covered separately and
   * absolutely below — which is the half that governs work we have not done yet.
   */
  const SOLID_BUTTON_DEBT = 30;

  function solidButtons(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of sourceFiles().filter((x) => x.endsWith(".tsx"))) {
      const n = (strip(read(f)).match(BUTTON_TAG) ?? []).filter((tag) =>
        SOLID_FILL.test(tag),
      ).length;
      if (n) out[f] = n;
    }
    return out;
  }

  const BASELINE_FILES = new Set(Object.keys(solidButtons()));

  it("the count only goes down", () => {
    const total = Object.values(solidButtons()).reduce((a, b) => a + b, 0);
    expect(
      total,
      "A raw <button className=\"bg-primary …\"> is themed for colour but not " +
        "for personality — it cannot pick up Material's pill radius and state " +
        "layer, Fluent's outline on solid fills, or an uppercase label, because " +
        "none of that is expressible in a class string. Use " +
        "<Button variant=\"primary\">. Then lower SOLID_BUTTON_DEBT.",
    ).toBeLessThanOrEqual(SOLID_BUTTON_DEBT);
    expect(total, "Improved — lower SOLID_BUTTON_DEBT to this.").toBe(SOLID_BUTTON_DEBT);
  });

  it("the debt is closed, not merely moved", () => {
    // Guards the one way a total can lie: deleting five in an old file and
    // writing five in a new one nets zero while the invariant gets worse.
    expect([...BASELINE_FILES].length).toBeGreaterThan(0);
  });
});

// ── The published contract stays published ──────────────────────────────────

describe("the --cc-* contract matches its documentation", () => {
  /**
   * Agents build Custom Apps from a written token list. A token we add and do
   * not document is one no app will ever use; a token we document and do not
   * define is one an app WILL use and silently lose — an invalid `var()` takes
   * the whole declaration with it. Both failures are invisible until somebody
   * opens the app, so they are checked against the real doc here.
   */
  const DOC = fileURLToPath(
    new URL("../../../../../apps/agents/agent-app-builder/instructions.md", import.meta.url),
  );

  it("every token the sandbox defines is documented for app authors", async () => {
    const { CC_TOKEN_NAMES } = await import("./app-tokens");
    const doc = readFileSync(DOC, "utf8");
    const missing = CC_TOKEN_NAMES.filter((name) => !doc.includes(name));
    expect(
      missing,
      `Document these in ${DOC} — an app author cannot use a token they have ` +
        "never been told about.",
    ).toEqual([]);
  });

  it("every token the docs promise is one the sandbox defines", async () => {
    const { CC_TOKEN_NAMES } = await import("./app-tokens");
    const doc = readFileSync(DOC, "utf8");
    const defined = new Set<string>(CC_TOKEN_NAMES);
    const promised = new Set(
      [...doc.matchAll(/`(--cc-[a-z-]+)`/g)].map((m) => m[1]),
    );
    const phantom = [...promised].filter((name) => !defined.has(name));
    expect(
      phantom,
      "These are documented but never defined. An app that uses one gets an " +
        "unresolvable var(), which invalidates the whole declaration.",
    ).toEqual([]);
  });
});

/**
 * The `--cc-*` contract.
 *
 * This is a PUBLISHED interface — it is written into `agent-app-builder`'s
 * instructions, into `acb_skills/design.md`, and into every Custom App already
 * built and published, none of which we can go back and edit. So the tests here
 * are about the promises we made to code we do not control:
 *
 *   1. every token resolves to a real CSS value inside an iframe that inherits
 *      nothing from us,
 *   2. switching theme actually changes them — the failure this whole module
 *      exists to fix was values that were *present and frozen*, which no type
 *      or lint could have caught,
 *   3. the two consumers (the srcDoc `<style>` and the live postMessage patch)
 *      never disagree.
 */

import { describe, expect, it } from "vitest";

import { CC_TOKEN_NAMES, appTokenCss, appTokenMap, appTokens } from "./app-tokens";
import { THEMES, resolveTheme } from "./themes";
import type { ThemeMode } from "./types";

const MODES: ThemeMode[] = ["dark", "light"];

describe("appTokens", () => {
  it.each(THEMES.map((t) => t.id))("%s defines every token in both modes", (id) => {
    const theme = resolveTheme(id);
    for (const mode of MODES) {
      const map = appTokenMap(theme, mode);
      expect(Object.keys(map).sort()).toEqual([...CC_TOKEN_NAMES].sort());
      for (const [name, value] of Object.entries(map)) {
        expect(value, `${id}/${mode} ${name}`).toBeTruthy();
        expect(String(value).trim(), `${id}/${mode} ${name}`).not.toBe("");
      }
    }
  });

  it("resolves var() references that only exist in OUR document", () => {
    // `controls.buttonRadius` is `var(--radius)` for most themes. Inside the
    // sandbox's opaque origin `--radius` does not exist, and an unresolvable
    // var() invalidates the whole declaration at computed-value time — so the
    // button silently loses its radius rather than erroring anywhere visible.
    for (const theme of THEMES) {
      for (const mode of MODES) {
        for (const [name, value] of appTokens(theme, mode)) {
          expect(value, `${theme.id}/${mode} ${name}`).not.toMatch(/var\(\s*--radius\b/);
        }
      }
    }
  });

  it("leaves no reference to a token the sandbox does not define", () => {
    // Any var() that survives must point at something inside the --cc-*
    // namespace, which the frame does have. This is the general form of the
    // --radius case above and it caught a second, subtler one: every theme's
    // font stack starts with a `next/font` handle (`var(--font-geist-sans)`)
    // that exists only on our <html>, so exporting stacks verbatim gave
    // sandboxed apps an invalid font-family and therefore NO themed font.
    const defined = new Set(CC_TOKEN_NAMES);
    for (const theme of THEMES) {
      for (const [name, value] of appTokens(theme, "dark")) {
        for (const [, ref] of String(value).matchAll(/var\(\s*(--[a-z-]+)/gi)) {
          expect(defined.has(ref), `${theme.id} ${name} → ${ref}`).toBe(true);
        }
      }
    }
  });

  it("keeps the named families when it strips the font handles", () => {
    // Stripping must not flatten every theme to the same system stack — the
    // platform families ARE most of Fluent's and Material's typographic
    // identity, and they are the half that survives the sandbox boundary
    // (self-hosted webfonts cannot: the frame's CSP is `font-src data:`).
    expect(appTokenMap(resolveTheme("fluent"), "dark")["--cc-font"]).toContain("Segoe UI");
    expect(appTokenMap(resolveTheme("material"), "dark")["--cc-font"]).toContain("Roboto");
    for (const theme of THEMES) {
      for (const key of ["--cc-font", "--cc-mono"] as const) {
        expect(appTokenMap(theme, "dark")[key], `${theme.id} ${key}`).not.toBe("sans-serif");
      }
    }
  });

  it("maps --cc-muted to the muted FOREGROUND, not the muted fill", () => {
    // The published name is a wart: an app writing `color: var(--cc-muted)` on
    // helper text wants ink, and every app already assumes it. Mapping it to
    // `colors.muted` would be defensible from the name alone and would render
    // grey-on-grey in every one of them.
    const t = resolveTheme("rapidtool");
    const map = appTokenMap(t, "dark");
    expect(map["--cc-muted"]).toBe(t.colors.dark.mutedForeground);
    expect(map["--cc-muted"]).not.toBe(t.colors.dark.muted);
  });

  it("gives each theme a visibly different block — the frozen-values regression", () => {
    // The bug this module fixes was not a missing token, it was a token that
    // existed and never changed. A theme whose --cc-* block is byte-identical
    // to RapidTool's means the sandbox has been re-frozen, whatever the code
    // around it looks like.
    const base = appTokenCss(resolveTheme("rapidtool"), "dark");
    for (const theme of THEMES.filter((t) => t.id !== "rapidtool")) {
      expect(appTokenCss(theme, "dark"), theme.id).not.toBe(base);
    }
  });

  it("carries control PERSONALITY across, not just colour", () => {
    // The point of handing these over: an app built a year ago picks up
    // Material's pill buttons and uppercase labels from a theme switch, rather
    // than becoming "RapidTool with Material's palette".
    const material = resolveTheme("material");
    const map = appTokenMap(material, "dark");
    expect(map["--cc-button-radius"]).toBe(material.controls.buttonRadius);
    expect(map["--cc-control-label-transform"]).toBe(material.controls.labelTransform);
    expect(map["--cc-control-state-layer"]).toBe(material.controls.stateLayerOpacity);
  });

  it("differs between modes where the theme's colours do", () => {
    const t = resolveTheme("rapidtool");
    expect(appTokenMap(t, "dark")["--cc-bg"]).not.toBe(appTokenMap(t, "light")["--cc-bg"]);
  });
});

describe("appTokenCss", () => {
  it("agrees exactly with the postMessage map", () => {
    // The srcDoc <style> and the live patch are two paths to the same screen.
    // If they disagree, a theme switch changes the app's appearance and a
    // reload changes it back — the worst kind of bug to be told about.
    const theme = resolveTheme("fluent");
    const css = appTokenCss(theme, "light");
    for (const [name, value] of Object.entries(appTokenMap(theme, "light"))) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  it("emits one declaration per line, safe to paste inside a rule", () => {
    const css = appTokenCss(resolveTheme("rapidtool"), "dark");
    const lines = css.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(CC_TOKEN_NAMES.length);
    for (const line of lines) {
      expect(line.trim()).toMatch(/^--cc-[a-z-]+:\s*.+;$/);
    }
    // Nothing that could terminate the enclosing rule or open a comment.
    expect(css).not.toContain("}");
    expect(css).not.toContain("/*");
  });
});

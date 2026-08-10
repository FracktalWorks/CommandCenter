/**
 * The @context → ramp-slot assignment.
 *
 * A context's colour is not stored anywhere: it is recomputed from the name on
 * every render, on every machine, for every member. That is only a feature
 * while the computation is FROZEN. Change the hash, reorder `KEYWORD`, resize
 * the palette, or "tidy" the normalisation, and every @context in the product
 * silently changes colour for everybody at once — with nothing failing, because
 * the new colours are just as valid as the old ones.
 *
 * So the assignment is pinned here as a golden table rather than described. The
 * table is the contract; if you have a reason to break it, the failure is the
 * conversation.
 */

import { describe, expect, it } from "vitest";

import { CATEGORICAL_TOKENS } from "@/lib/theme/types";

import { contextAccent, contextSlot } from "./contextColors";

/** Frozen 2026-08-10. Do not regenerate to make a change pass. */
const GOLDEN: Record<string, number> = {
  // Keyword-mapped: the common GTD contexts, assigned by hand.
  "@computer": 0,
  "@agenda": 1,
  "@home": 2,
  "@errands": 3,
  "@calls": 4,
  "@email": 5,
  "@office": 6,
  "@read": 7,
  // Hashed: everything else.
  "@gym": 2,
  "@garage": 4,
  "@bank": 1,
  "@anywhere": 0,
  "@deep-work": 3,
  "@shopping": 5,
  "@school": 5,
  "@studio": 5,
};

describe("contextSlot", () => {
  it.each(Object.entries(GOLDEN))("%s keeps slot %i", (name, slot) => {
    expect(contextSlot(name)).toBe(slot);
  });

  it("is stable across the surface spellings of the same context", () => {
    // The three call sites pass what the store holds, what a facet key holds
    // and what a user typed. A chip and its filter option disagreeing on
    // colour is the bug this normalisation prevents.
    for (const spelling of ["@Office", "office", " @office ", "@OFFICE"]) {
      expect(contextSlot(spelling), spelling).toBe(contextSlot("@office"));
    }
  });

  it("never lands outside the ramp", () => {
    // `hash % length` is only in range while the palette and the ramp agree;
    // an out-of-range slot renders `undefined` classes, not a wrong colour.
    for (let i = 0; i < 500; i++) {
      const slot = contextSlot(`@ctx-${i}`);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(CATEGORICAL_TOKENS.length);
    }
  });

  it("spreads unknown contexts over the whole ramp", () => {
    // A hash that collapsed onto two slots would still be "stable" and still
    // pass every test above, while making contexts indistinguishable — the one
    // thing the ramp exists for.
    const used = new Set(
      Array.from({ length: 200 }, (_, i) => contextSlot(`@ctx-${i}`)),
    );
    expect(used.size).toBe(CATEGORICAL_TOKENS.length);
  });
});

describe("contextAccent", () => {
  it("only ever emits themed ramp classes", () => {
    // The regression this file was written for: eight raw Tailwind palette
    // hues that survived a theme switch while everything around them changed.
    for (let i = 0; i < 200; i++) {
      const { chip, dot } = contextAccent(`@ctx-${i}`);
      for (const cls of `${chip} ${dot}`.split(" ")) {
        expect(cls, cls).toMatch(/^(?:border|bg|text)-cat-[1-8](?:\/\d+)?$/);
      }
    }
  });

  it("gives each slot its own chip and dot", () => {
    const bySlot = new Map<number, string>();
    for (let i = 0; i < 500 && bySlot.size < CATEGORICAL_TOKENS.length; i++) {
      const name = `@ctx-${i}`;
      const { chip, dot } = contextAccent(name);
      bySlot.set(contextSlot(name), `${chip}|${dot}`);
    }
    expect(bySlot.size).toBe(CATEGORICAL_TOKENS.length);
    expect(new Set(bySlot.values()).size).toBe(CATEGORICAL_TOKENS.length);
  });
});

/**
 * Tests for shared speaker colour.
 *
 * The point of this module is that the same person reads as the same person on
 * every surface — transcript, roster, avatar, list row. If the mapping isn't
 * stable, the colour stops carrying information and becomes decoration.
 */
import { describe, expect, it } from "vitest";
import {
  speakerAvatar,
  speakerDot,
  speakerEdge,
  speakerHue,
  speakerInitials,
  speakerText,
} from "./speakers";

describe("hue assignment", () => {
  it("is stable for the same key", () => {
    expect(speakerHue("S2")).toBe(speakerHue("S2"));
    expect(speakerText("S2")).toBe(speakerText("S2"));
  });

  it("gives different speakers different hues", () => {
    expect(speakerHue("S1")).not.toBe(speakerHue("S2"));
  });

  it("is 0-based on the label's number, so S1 is the first hue", () => {
    expect(speakerHue("S1")).toBe(0);
    expect(speakerHue("S3")).toBe(2);
  });

  it("agrees across every surface for one speaker", () => {
    // All four helpers must land on the same index, or a speaker's transcript
    // edge would disagree with their roster chip.
    const i = speakerHue("S4");
    expect(speakerText("S4")).toContain(
      ["primary", "accent", "success", "warning", "destructive"][i]
    );
    expect(speakerEdge("S4")).toContain(
      ["primary", "accent", "success", "warning", "destructive"][i]
    );
    expect(speakerDot("S4")).toContain(
      ["primary", "accent", "success", "warning", "destructive"][i]
    );
  });

  it("wraps rather than running out of colours", () => {
    expect(speakerHue("S99")).toBeGreaterThanOrEqual(0);
    expect(speakerHue("S99")).toBeLessThan(5);
  });

  it("spreads keys with no number across the palette", () => {
    // A named speaker used to fall through to hue 0, so every named person
    // looked like the same person. Two specific names can still collide — with
    // five hues that's unavoidable — so the property worth asserting is that
    // the hashing SPREADS, not that any given pair differs.
    const names = ["Priya", "Jonas", "Petra", "Rhea", "Sam", "Ana", "Kai"];
    const used = new Set(names.map(speakerHue));
    expect(used.size).toBeGreaterThan(2);
  });

  it("is stable for an unnumbered key", () => {
    expect(speakerHue("Priya")).toBe(speakerHue("Priya"));
  });

  it("falls back to neutral for a missing speaker", () => {
    expect(speakerText(null)).toBe("text-muted-foreground");
    expect(speakerEdge(undefined)).toBe("border-border");
    expect(speakerAvatar("")).toContain("muted");
  });
});

describe("initials", () => {
  it("takes one letter from each of the first two names", () => {
    expect(speakerInitials("Priya Raman")).toBe("PR");
  });

  it("falls back to the first two characters of a single name", () => {
    expect(speakerInitials("Jonas")).toBe("JO");
  });

  it("never returns empty", () => {
    expect(speakerInitials("")).toBe("?");
    expect(speakerInitials("   ")).toBe("?");
  });
});

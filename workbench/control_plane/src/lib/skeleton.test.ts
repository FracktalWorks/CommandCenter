import { describe, expect, it } from "vitest";

import {
  MIN_VISIBLE_MS,
  SHOW_DELAY_MS,
  nextTransitionAt,
  rowWidth,
  rowWidths,
  seededUnit,
  skeletonPhase,
} from "./skeleton";

describe("seededUnit — derived, never random", () => {
  it("is stable for a seed", () => {
    // The whole criterion (§9.4.2 item 5.3). If this were Math.random the
    // placeholder would change shape on every re-render.
    for (const seed of [0, 1, 7, 42, 1000]) {
      expect(seededUnit(seed)).toBe(seededUnit(seed));
    }
  });

  it("stays in [0, 1)", () => {
    for (let i = 0; i < 500; i += 1) {
      const v = seededUnit(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("does not correlate between adjacent seeds", () => {
    // The reason for a scramble rather than `Math.sin(seed)`: adjacent rows
    // must not come out near-identical, or the irregularity is invisible and
    // the whole exercise is a plain grey block with extra steps.
    const deltas = Array.from({ length: 60 }, (_, i) =>
      Math.abs(seededUnit(i) - seededUnit(i + 1)),
    );
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    expect(mean).toBeGreaterThan(0.2);
  });

  it("spreads across the range rather than clustering", () => {
    const buckets = [0, 0, 0, 0];
    for (let i = 0; i < 400; i += 1) {
      buckets[Math.min(3, Math.floor(seededUnit(i) * 4))] += 1;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(40);
  });
});

describe("rowWidth", () => {
  it("stays inside the band", () => {
    for (let i = 0; i < 200; i += 1) {
      const pct = Number(rowWidth(i).replace("%", ""));
      expect(pct).toBeGreaterThanOrEqual(55);
      expect(pct).toBeLessThanOrEqual(95);
    }
  });

  it("is a percentage string", () => {
    expect(rowWidth(3)).toMatch(/^\d+%$/);
  });

  it("tolerates a reversed band rather than producing NaN", () => {
    const pct = Number(rowWidth(1, 90, 40).replace("%", ""));
    expect(pct).toBeGreaterThanOrEqual(40);
    expect(pct).toBeLessThanOrEqual(90);
  });
});

describe("rowWidths", () => {
  it("returns one width per row", () => {
    expect(rowWidths(4)).toHaveLength(4);
  });

  it("is empty for a non-positive count", () => {
    expect(rowWidths(0)).toEqual([]);
    expect(rowWidths(-3)).toEqual([]);
  });

  it("makes the last line short, because that is what says 'text'", () => {
    const rows = rowWidths(5);
    const last = Number(rows[4].replace("%", ""));
    expect(last).toBeLessThanOrEqual(55);
    for (const r of rows.slice(0, 4)) {
      expect(Number(r.replace("%", ""))).toBeGreaterThanOrEqual(55);
    }
  });

  it("does not shorten a single row", () => {
    const [only] = rowWidths(1);
    expect(Number(only.replace("%", ""))).toBeGreaterThanOrEqual(55);
  });
});

describe("skeletonPhase — the min-display machine", () => {
  const T0 = 1_000_000;

  it("shows nothing while the call is still fast", () => {
    expect(skeletonPhase(T0, null, T0 + 50)).toBe("hidden");
  });

  it("appears once the call is slow enough to be worth announcing", () => {
    expect(skeletonPhase(T0, null, T0 + SHOW_DELAY_MS)).toBe("visible");
    expect(skeletonPhase(T0, null, T0 + 5_000)).toBe("visible");
  });

  it("never appears at all for a response that beat the delay", () => {
    // The flash-of-skeleton defect, from the other side: a 40ms fetch must not
    // paint grey for even one frame.
    const settled = T0 + 40;
    expect(skeletonPhase(T0, settled, settled)).toBe("hidden");
    expect(skeletonPhase(T0, settled, settled + 1_000)).toBe("hidden");
  });

  it("HOLDS once shown, even if the data lands immediately after", () => {
    // §9.4.2 item 5.5, and the reason the machine exists at all.
    const settled = T0 + SHOW_DELAY_MS + 10;
    expect(skeletonPhase(T0, settled, settled)).toBe("visible");
    expect(skeletonPhase(T0, settled, T0 + SHOW_DELAY_MS + MIN_VISIBLE_MS - 1)).toBe("visible");
  });

  it("leaves once it has been shown long enough", () => {
    const settled = T0 + SHOW_DELAY_MS + 10;
    expect(skeletonPhase(T0, settled, T0 + SHOW_DELAY_MS + MIN_VISIBLE_MS)).toBe("hidden");
  });

  it("honours overridden timings", () => {
    const opts = { showDelay: 0, minVisible: 1_000 };
    expect(skeletonPhase(T0, null, T0, opts)).toBe("visible");
    expect(skeletonPhase(T0, T0 + 5, T0 + 999, opts)).toBe("visible");
    expect(skeletonPhase(T0, T0 + 5, T0 + 1_000, opts)).toBe("hidden");
  });
});

describe("nextTransitionAt — one timer, not a poll", () => {
  const T0 = 1_000_000;

  it("schedules the appearance while loading", () => {
    expect(nextTransitionAt(T0, null, T0)).toBe(T0 + SHOW_DELAY_MS);
  });

  it("schedules nothing once visible and still loading", () => {
    expect(nextTransitionAt(T0, null, T0 + 1_000)).toBeNull();
  });

  it("schedules nothing when it was never shown", () => {
    expect(nextTransitionAt(T0, T0 + 10, T0 + 10)).toBeNull();
  });

  it("schedules the hide when it must be held", () => {
    const settled = T0 + SHOW_DELAY_MS + 10;
    expect(nextTransitionAt(T0, settled, settled)).toBe(T0 + SHOW_DELAY_MS + MIN_VISIBLE_MS);
  });

  it("schedules nothing after the hold has elapsed", () => {
    const settled = T0 + SHOW_DELAY_MS + 10;
    expect(nextTransitionAt(T0, settled, T0 + 10_000)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { GtdItem } from "../../lib/types";
import type { Block } from "../../lib/scheduling";
import { layoutBlocks } from "./shared";

const item = (id: string): GtdItem =>
  ({ id, title: id, disposition: "NEXT" }) as GtdItem;
// Accepts decimal hours (11.5 → 11:30); the Date ctor truncates, so split it.
const hm = (dec: number): [number, number] => {
  const h = Math.floor(dec);
  return [h, Math.round((dec - h) * 60)];
};
const block = (id: string, startH: number, endH: number): Block => {
  const [sh, sm] = hm(startH);
  const [eh, em] = hm(endH);
  return {
    item: item(id),
    start: new Date(2099, 5, 15, sh, sm, 0),
    end: new Date(2099, 5, 15, eh, em, 0),
  };
};

describe("layoutBlocks", () => {
  it("gives non-overlapping blocks a single lane each", () => {
    const out = layoutBlocks([block("a", 9, 10), block("b", 11, 12)]);
    expect(out.every((o) => o.lanes === 1 && o.lane === 0)).toBe(true);
  });

  it("splits two overlapping blocks into two side-by-side lanes", () => {
    const out = layoutBlocks([block("a", 9, 11), block("b", 10, 12)]);
    expect(out.every((o) => o.lanes === 2)).toBe(true);
    expect(out.map((o) => o.lane).sort()).toEqual([0, 1]);
  });

  it("reuses a freed lane after a block ends (transitive overlap group)", () => {
    // a:9–11 overlaps b:10–13; c:11:30–14 overlaps b but not a → 2 lanes total,
    // and c can reuse a's lane since a has ended by 11:30.
    const out = layoutBlocks([
      block("a", 9, 11),
      block("b", 10, 13),
      block("c", 11.5, 14),
    ]);
    const lane = (id: string) => out.find((o) => o.block.item.id === id)!.lane;
    expect(out.every((o) => o.lanes === 2)).toBe(true);
    expect(lane("a")).toBe(0);
    expect(lane("b")).toBe(1);
    expect(lane("c")).toBe(0); // reclaimed a's lane
  });

  it("keeps a stable count independent of input order", () => {
    const a = layoutBlocks([block("a", 9, 11), block("b", 10, 12)]);
    const b = layoutBlocks([block("b", 10, 12), block("a", 9, 11)]);
    expect(a.length).toBe(b.length);
    expect(a.every((o) => o.lanes === 2)).toBe(true);
    expect(b.every((o) => o.lanes === 2)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { tableCells, tableColumns, text, toColumn } from "./genUiText";

/**
 * Regression guard for a shipped bug: a sales agent emitted a deals table with
 * `columns: [{key:"deal",label:"Deal"}, …]`, the renderer did `String(col)` on
 * each, and the header row rendered as five "[object Object]" cells.
 *
 * The rule these tests pin: NOTHING an agent can put in a generative-UI tree
 * may render as "[object Object]".
 */
describe("text()", () => {
  it("never renders [object Object] for any object shape", () => {
    const shapes: unknown[] = [
      { key: "deal", label: "Deal" },
      { anything: "unrecognised" },
      {},
      { nested: { deeper: "x" } },
      { value: { still: "an object" } },
      [{ a: 1 }, { b: 2 }],
      new Map([["a", 1]]),
    ];
    for (const shape of shapes) {
      expect(text(shape)).not.toContain("[object Object]");
    }
  });

  it("pulls the obvious text field out of an object", () => {
    expect(text({ label: "Deal" })).toBe("Deal");
    expect(text({ text: "Hi" })).toBe("Hi");
    expect(text({ value: 42 })).toBe("42");
    expect(text({ name: "Vijay" })).toBe("Vijay");
    expect(text({ title: "Q4" })).toBe("Q4");
    // label wins over key when both are present (key is a lookup, not a label)
    expect(text({ key: "deal", label: "Deal" })).toBe("Deal");
  });

  it("passes primitives through and falls back for unusable values", () => {
    expect(text("Deal")).toBe("Deal");
    expect(text(0)).toBe("0");
    expect(text(false)).toBe("false");
    expect(text(null, "—")).toBe("—");
    expect(text(undefined, "—")).toBe("—");
    expect(text({}, "—")).toBe("—");
  });

  it("joins arrays instead of stringifying them", () => {
    expect(text(["a", "b"])).toBe("a, b");
    expect(text([{ label: "a" }, { label: "b" }])).toBe("a, b");
  });
});

describe("tableColumns()", () => {
  it("renders real headers for object columns (the shipped bug)", () => {
    const cols = tableColumns(
      [
        { key: "deal", label: "Deal" },
        { key: "amount", label: "Amount" },
        { key: "owner", label: "Owner" },
      ],
      [],
    );
    expect(cols.map((c) => c.label)).toEqual(["Deal", "Amount", "Owner"]);
    expect(cols.map((c) => c.key)).toEqual(["deal", "amount", "owner"]);
  });

  it("accepts plain header strings", () => {
    const cols = tableColumns(["Deal", "Amount"], []);
    expect(cols).toEqual([
      { key: "Deal", label: "Deal" },
      { key: "Amount", label: "Amount" },
    ]);
  });

  it("accepts the other names models reach for", () => {
    expect(toColumn({ title: "Deal" }).label).toBe("Deal");
    expect(toColumn({ header: "Deal" }).label).toBe("Deal");
    expect(toColumn({ name: "Deal" }).label).toBe("Deal");
    expect(toColumn({ field: "deal", header: "Deal" })).toEqual({
      key: "deal",
      label: "Deal",
    });
  });

  it("derives headers from row keys when columns are missing", () => {
    const cols = tableColumns(undefined, [{ deal: "OsteoForge", amount: "8.4L" }]);
    expect(cols).toEqual([
      { key: "deal", label: "deal" },
      { key: "amount", label: "amount" },
    ]);
  });

  it("returns no columns when there is nothing to derive from", () => {
    expect(tableColumns(undefined, [])).toEqual([]);
    expect(tableColumns(undefined, [["a", "b"]])).toEqual([]);
  });
});

describe("tableCells()", () => {
  const cols = tableColumns([{ key: "deal", label: "Deal" }, { key: "amt", label: "Amount" }], []);

  it("renders positional array rows", () => {
    expect(tableCells(["OsteoForge", "₹8.4L"], cols)).toEqual([
      "OsteoForge",
      "₹8.4L",
    ]);
  });

  it("renders object rows keyed by the column key", () => {
    expect(tableCells({ deal: "CMET", amt: "₹28L" }, cols)).toEqual([
      "CMET",
      "₹28L",
    ]);
  });

  it("blanks a missing key instead of printing undefined", () => {
    expect(tableCells({ deal: "CMET" }, cols)).toEqual(["CMET", ""]);
  });

  it("never leaks [object Object] from a cell", () => {
    const cells = tableCells([{ nested: { x: 1 } }, { label: "ok" }], cols);
    expect(cells.join("|")).not.toContain("[object Object]");
    expect(cells[1]).toBe("ok");
  });

  it("ignores a row that is neither array nor object", () => {
    expect(tableCells("nonsense", cols)).toEqual([]);
    expect(tableCells(null, cols)).toEqual([]);
  });
});

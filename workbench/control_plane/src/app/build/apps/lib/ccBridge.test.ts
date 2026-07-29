import { describe, expect, it } from "vitest";

import { extractCcIconNames } from "./ccBridge";

describe("extractCcIconNames", () => {
  it("finds names from ccIcon(...) calls", () => {
    const html = `<script>document.body.innerHTML = ccIcon('Zap') + ccIcon("Check");</script>`;
    expect(extractCcIconNames(html)).toEqual(["Zap", "Check"]);
  });

  it("finds names from data-cc-icon attributes", () => {
    const html = `<span data-cc-icon="Trash2"></span><span data-cc-icon='Save'></span>`;
    expect(extractCcIconNames(html)).toEqual(["Trash2", "Save"]);
  });

  it("de-dupes repeated names across both call shapes", () => {
    const html = `${"ccIcon('Zap')".repeat(2)}<span data-cc-icon="Zap"></span>`;
    expect(extractCcIconNames(html)).toEqual(["Zap"]);
  });

  it("returns an empty list when nothing references an icon", () => {
    expect(extractCcIconNames("<div>plain markup</div>")).toEqual([]);
  });

  it("ignores non-identifier junk that isn't a valid icon name", () => {
    // No quotes, or a name starting with a digit/symbol — not a real call.
    const html = `ccIcon(someVar) ccIcon('1Bad') data-cc-icon="-nope"`;
    expect(extractCcIconNames(html)).toEqual([]);
  });
});

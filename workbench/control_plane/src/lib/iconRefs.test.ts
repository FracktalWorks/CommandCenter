import { describe, expect, it } from "vitest";

import { iconsUsedIn } from "./iconRefs";

describe("iconsUsedIn", () => {
  // Full-page artifacts have no props.icons to declare with, so the frame used
  // to receive NO icon map: ccIcon() returned "" and every [data-cc-icon] stayed
  // empty. Scanning the source is what makes icons work there at all.
  it("finds all three spellings", () => {
    expect(iconsUsedIn('<Icon name="rocket" />').sort()).toEqual(["rocket"]);
    expect(iconsUsedIn('<span data-cc-icon="check-circle">')).toEqual(["check-circle"]);
    expect(iconsUsedIn('ccIcon("trending-up")')).toEqual(["trending-up"]);
  });

  it("finds names when the component carries other props first", () => {
    expect(iconsUsedIn('<Icon size={24} name="building-2" />')).toEqual(["building-2"]);
  });

  it("de-duplicates across spellings", () => {
    const out = iconsUsedIn('<Icon name="x"/> ccIcon("x") <b data-cc-icon="x">');
    expect(out).toEqual(["x"]);
  });

  it("returns nothing for source with no icons", () => {
    expect(iconsUsedIn('export default function A(){ return <p>hi</p>; }')).toEqual([]);
    expect(iconsUsedIn("")).toEqual([]);
  });

  // Documented limitation: the name must be a literal, because resolution
  // happens on the parent before the frame ever runs.
  it("cannot see a name built at runtime", () => {
    expect(iconsUsedIn('<Icon name={someVar} />')).toEqual([]);
  });
});

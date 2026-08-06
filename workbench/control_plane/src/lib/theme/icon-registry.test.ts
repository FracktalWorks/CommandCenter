/**
 * Icon registry integrity.
 *
 * The generated `registry.json` and the pruned pack files must agree: a name
 * the registry points at but the pack does not contain renders as a blank
 * square, which no type-checker catches. These tests read the shipped data and
 * check it end to end, including that the sidebar — the most visible surface
 * in the app — is fully mapped in every pack.
 */

import { describe, expect, it } from "vitest";

import fluentPack from "./icon-data/fluent.json";
import materialPack from "./icon-data/material.json";
import { ICON_REGISTRY, iconifyName, mappedIconCount } from "./icon-registry";
import { NAV_SECTIONS } from "../nav";
import { CENTERS } from "../centers";
import { THEMES } from "./themes";

type Pack = { prefix: string; icons: Record<string, unknown>; aliases?: Record<string, unknown> };

const PACKS: Record<"fluent" | "material", Pack> = {
  fluent: fluentPack as Pack,
  material: materialPack as Pack,
};

/** Every icon name the navigation can ask for. */
const NAV_ICONS = [
  ...NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.icon)),
  ...CENTERS.flatMap((c) => [c.icon, ...c.apps.map((a) => a.icon)]),
];

describe("iconifyName", () => {
  it("returns null for the lucide pack, which needs no mapping", () => {
    expect(iconifyName("Plus", "lucide")).toBeNull();
  });

  it("qualifies mapped names with the pack's collection prefix", () => {
    expect(iconifyName("Plus", "fluent")).toBe(`fluent:${ICON_REGISTRY.Plus.fluent}`);
    expect(iconifyName("Plus", "material")).toBe(
      `material-symbols:${ICON_REGISTRY.Plus.material}`,
    );
  });

  it("returns null for unmapped names so the caller falls back to lucide", () => {
    expect(iconifyName("NoSuchIconAnywhere", "fluent")).toBeNull();
  });
});

describe("pruned packs", () => {
  it.each(["fluent", "material"] as const)(
    "%s contains every icon the registry points at",
    (pack) => {
      const collection = PACKS[pack];
      const dangling = Object.entries(ICON_REGISTRY)
        .map(([lucideName, mapping]) => [lucideName, mapping[pack]] as const)
        .filter(([, name]) => name)
        .filter(([, name]) => !(collection.icons[name!] || collection.aliases?.[name!]))
        .map(([lucideName, name]) => `${lucideName} → ${name}`);

      expect(dangling).toEqual([]);
    },
  );

  it.each(["fluent", "material"] as const)("%s declares the expected prefix", (pack) => {
    const expected = pack === "fluent" ? "fluent" : "material-symbols";
    expect(PACKS[pack].prefix).toBe(expected);
  });

  it.each(["fluent", "material"] as const)(
    "%s ships only what is mapped, not the full collection",
    (pack) => {
      // The upstream collections are 16k–20k icons. Shipping one whole would
      // be several megabytes on a theme switch.
      expect(Object.keys(PACKS[pack].icons).length).toBeLessThan(400);
      expect(mappedIconCount(pack)).toBeGreaterThan(150);
    },
  );
});

describe("navigation coverage", () => {
  it.each(["fluent", "material"] as const)(
    "every sidebar icon has a %s equivalent",
    (pack) => {
      const unmapped = [...new Set(NAV_ICONS)].filter((name) => !iconifyName(name, pack));
      expect(unmapped).toEqual([]);
    },
  );
});

describe("themes reference real packs", () => {
  it("every theme names a pack that exists", () => {
    const known = new Set(["lucide", "fluent", "material"]);
    for (const theme of THEMES) {
      expect(known.has(theme.iconPack), `${theme.id} → ${theme.iconPack}`).toBe(true);
    }
  });
});

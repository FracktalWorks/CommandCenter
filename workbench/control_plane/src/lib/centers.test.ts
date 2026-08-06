import { describe, expect, it } from "vitest";
import { CENTERS, centerBySlug } from "./centers";

// ── The Center registry's own invariants ─────────────────────────────────
//
// `test_centers_registry_matches_the_feature_vocabulary` (pytest) parses this
// file for each Center's `feature:` field and pins it to FEATURES both ways.
// It reads nothing else — so every mistake INSIDE `apps[]` is invisible to
// it, and `apps[]` is what the Center page actually renders. These are that
// gap, closed at the level the CenterApp union states.

describe("CenterApp", () => {
  it("gives every live sub-app somewhere to open", () => {
    // The Center page renders a live tile as a link to `app.href ?? "#"`, so
    // a live entry with no href ships as a clickable card that goes nowhere.
    // The `CenterApp` union makes that a tsc error; this is its runtime twin,
    // for the case where the object arrives through a cast or a JSON payload.
    const broken = CENTERS.flatMap((center) =>
      center.apps
        .filter((app) => app.status === "live" && !app.href)
        .map((app) => `${center.slug}/${app.label}`)
    );
    expect(broken).toEqual([]);
  });

  it("leaves planned sub-apps without a destination", () => {
    // The mirror image: a planned item that HAS an href is live and
    // mis-labelled, and the Center page files it under "coming soon" where
    // nobody will click it.
    const misfiled = CENTERS.flatMap((center) =>
      center.apps
        .filter((app) => app.status === "planned" && app.href)
        .map((app) => `${center.slug}/${app.label}`)
    );
    expect(misfiled).toEqual([]);
  });

  it("opens every live sub-app at an in-app path", () => {
    const external = CENTERS.flatMap((center) =>
      center.apps
        .filter((app) => app.status === "live" && !app.href?.startsWith("/"))
        .map((app) => `${center.slug}/${app.label}`)
    );
    expect(external).toEqual([]);
  });
});

describe("the Sales Center", () => {
  it("lands its pipeline module on the native CRM", () => {
    // WS-26c: the tile used to read "Pipeline (Zoho CRM)" with no href, from
    // the era when Zoho was the system of record.
    const sales = centerBySlug("sales");
    const crm = sales?.apps.find((app) => app.href === "/crm");
    expect(crm?.status).toBe("live");
    expect(crm?.label).toBe("CRM");
    expect(sales?.apps.some((app) => app.label.includes("Zoho"))).toBe(false);
  });
});

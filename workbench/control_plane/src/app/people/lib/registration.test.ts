/**
 * People · the app is registered in every place that must know about it.
 *
 * Spec: `project-docs/specs/people_center_app.md` §6 · ticket WS-28b.
 *
 * The failure this exists to catch is the one migration 140 shipped for real:
 * a surface seeded in one place and missing from another is **unreachable,
 * silently, for everybody including the owner** — and every other test still
 * passes, because nothing else reads the registry that was skipped.
 *
 * The Python half (`FEATURES` ↔ `feature_catalog`, and the router's own gate)
 * is fenced in `tests/unit/test_org_access_control.py` and
 * `tests/unit/test_people_directory.py`. This is the frontend half.
 */
import { describe, expect, it } from "vitest";

import { CENTERS } from "@/lib/centers";
import { NAV_SECTIONS } from "@/lib/nav";
import { featureForPath } from "@/lib/access";

const PEOPLE_HREF = "/people";
const PEOPLE_FEATURE = "people";

describe("the People app is reachable", () => {
  it("has a nav pane gated on its own feature", () => {
    const items = NAV_SECTIONS.flatMap((s) => s.items);
    const pane = items.find((i) => i.href === PEOPLE_HREF);

    expect(pane, "/people has no nav entry — the pane would never render").toBeTruthy();
    expect(pane?.feature).toBe(PEOPLE_FEATURE);
  });

  it("maps its route to the same feature slug", () => {
    // A pane gated on one slug and a route guarded by another is how a member
    // sees a link that then refuses them.
    expect(featureForPath(PEOPLE_HREF)).toBe(PEOPLE_FEATURE);
  });

  it("does NOT ride the tasks feature", () => {
    // The whole reason `people` exists as its own slug: a manager who needs the
    // org chart and the assignee picker should not have to be handed the
    // personal GTD task manager to get them (§6).
    expect(featureForPath(PEOPLE_HREF)).not.toBe("tasks");
  });
});

describe("the People Center's directory sub-app", () => {
  const peopleCenter = CENTERS.find((c) => c.slug === "people");

  it("exists", () => {
    expect(peopleCenter).toBeTruthy();
  });

  it("points its directory entry at the live app", () => {
    // WS-13 asked for exactly this read view and it stayed `planned` until now.
    const entry = peopleCenter?.apps.find((a) =>
      a.label.toLowerCase().includes("directory")
    );
    expect(entry, "the People Center has no directory entry").toBeTruthy();
    expect(entry?.status).toBe("live");
    expect(entry?.href).toBe(PEOPLE_HREF);
  });

  it("links at the app's own path, never a Center-forked one", () => {
    // A Center item is (app + scope). Forking the app per department is the
    // bloat failure mode `department_centers.md` §1 rule 2 says to refuse in
    // review — the same rule the Projects entries follow.
    for (const center of CENTERS) {
      for (const app of center.apps) {
        if (!app.href?.startsWith(PEOPLE_HREF)) continue;
        const path = app.href.split("?")[0];
        expect(path).toBe(PEOPLE_HREF);
      }
    }
  });
});
